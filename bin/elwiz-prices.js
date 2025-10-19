#!/usr/bin/env node

/**
 * ElWiz Prices - CLI Entry Point
 *
 * This is the main executable for the elwiz-prices module
 */

const { PriceManager, ConfigLoader } = require("..");
const TaskScheduler = require("easy-tasker");

// Handle command line arguments
const args = process.argv.slice(2);
const priceConfigPath = args[0];
const appConfigPath = args[1];
const activeSchedulers = [];

function shouldFetchNextDay(config, referenceDate = new Date()) {
  const hours =
    Array.isArray(config.scheduleHours) && config.scheduleHours.length
      ? config.scheduleHours.map(Number)
      : [config.nextDayFetchHour ?? 13];
  const minutes =
    Array.isArray(config.scheduleMinutes) && config.scheduleMinutes.length
      ? config.scheduleMinutes.map(Number)
      : [config.nextDayFetchMinute ?? 0];

  const currentHour = referenceDate.getHours();
  const currentMinute = referenceDate.getMinutes();
  const latestHour = Math.max(...hours);

  if (hours.includes(currentHour) && minutes.includes(currentMinute)) {
    return true;
  }

  if (currentHour > latestHour) {
    return true;
  }

  return false;
}

function nextDayWindowDescription(config) {
  const hours =
    Array.isArray(config.scheduleHours) && config.scheduleHours.length
      ? config.scheduleHours.map(Number)
      : [config.nextDayFetchHour ?? 13];
  const minutes =
    Array.isArray(config.scheduleMinutes) && config.scheduleMinutes.length
      ? config.scheduleMinutes.map(Number)
      : [config.nextDayFetchMinute ?? 0];
  const earliestHour = Math.min(...hours);
  const earliestMinute = Math.min(...minutes);
  return `${earliestHour.toString().padStart(2, "0")}:${earliestMinute
    .toString()
    .padStart(2, "0")}`;
}

function stopAllSchedules() {
  while (activeSchedulers.length) {
    const scheduler = activeSchedulers.pop();
    try {
      scheduler.stopScheduling();
    } catch (error) {
      console.error("Error stopping scheduler:", error.message);
    }
  }
}

async function main() {
  console.log("Starting ElWiz Prices Service...");

  try {
    // Create configuration loader
    const configLoader = new ConfigLoader(priceConfigPath, appConfigPath);
    const config = configLoader.getPriceConfig();

    console.log(`Price configuration: ${configLoader.priceConfigPath}`);
    console.log(`General configuration: ${configLoader.appConfigPath}`);
    console.log(`Price service for region: ${config.regionCode}`);
    console.log(`Fetching prices from: ${config.priceFetchPriority}`);
    console.log(`MQTT enabled: ${config.enableMqtt}`);
    console.log(`Days to keep cache files: ${config.keepDays}`);
    console.log(
      `REST API enabled: ${config.enableRest}${config.enableRest ? ` on port ${config.restPort}` : ""}`,
    );

    // Create the price manager with configuration and config loader
    const priceManager = new PriceManager(config, null, configLoader);

    // Start the price manager (this will start REST API if enabled)
    await priceManager.start();
    console.log("Price Manager started successfully!");

    // Start the scheduled fetching job
    await startScheduledFetching(priceManager, config);

    console.log("ElWiz Prices Service is running...");
    console.log("Press Ctrl+C to stop.");

    // Handle graceful shutdown
    const shutdown = async () => {
      console.log("\nShutting down ElWiz Prices Service...");
      stopAllSchedules();
      await priceManager.stop();
      console.log("Shutdown complete.");
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error("Error starting ElWiz Prices Service:", error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

async function startScheduledFetching(priceManager, config) {
  // Run initial fetch of all required days
  await runFetchCycle(priceManager, config);

  scheduleCronJobs(priceManager, config);
}

async function runFetchCycle(priceManager, config) {
  const keepDays = config.keepDays || 7;
  const priceFetchPriority = config.priceFetchPriority || "nordpool";
  const allowNextDayFetch = shouldFetchNextDay(config);
  // Fetch prices for the last keepDays, only if not already cached
  for (let i = (keepDays - 1) * -1; i <= 1; i++) {
    try {
      const dateStr = getDateForOffset(i);
      if (i === 1 && !allowNextDayFetch) {
        console.log(
          `Skipping next-day fetch before window (${nextDayWindowDescription(config)}): ${dateStr}`,
        );
        continue;
      }

      const exists = await priceManager.priceDataExists(dateStr);

      if (!exists) {
        console.log(`Fetching prices for ${dateStr} (not in cache)`);
        await safeFetchAndProcess(priceManager, i, priceFetchPriority, config);
      } else {
        console.log(`Prices for ${dateStr} already in cache, skipping fetch`);
      }
    } catch (error) {
      console.warn(
        `Failed to check/cache prices for offset ${i}:`,
        error.message,
      );
    }
  }

  // Clean up old cache files
  await priceManager.cleanupOldCache();

  // Handle MQTT publishing of the latest 2 days
  await handleMqttPublishing(priceManager);
}

function scheduleCronJobs(priceManager, config) {
  stopAllSchedules();

  const hours = uniqueNumbers(
    Array.isArray(config.scheduleHours) && config.scheduleHours.length
      ? config.scheduleHours
      : [config.nextDayFetchHour ?? 13],
  );
  const minutes = uniqueNumbers(
    Array.isArray(config.scheduleMinutes) && config.scheduleMinutes.length
      ? config.scheduleMinutes
      : [config.nextDayFetchMinute ?? 0],
  );

  for (const hour of hours) {
    for (const minute of minutes) {
      const cron = `${minute} ${hour} * * *`;
      const scheduler = new TaskScheduler(
        async () => {
          try {
            if (config.debug)
              console.log(
                `[${new Date().toISOString()}] Scheduled fetch (${pad(hour)}:${pad(minute)})`,
              );
            await runFetchCycle(priceManager, config);
          } catch (error) {
            console.error(
              `[${new Date().toISOString()}] Scheduled fetch error:`,
              error.message,
            );
          }
        },
        {
          taskId: `price-fetch-${hour}-${minute}`,
          logging: Boolean(config.debug),
        },
      );
      scheduler.timeAlignedSchedule(cron);
      activeSchedulers.push(scheduler);
      //console.log(
      //  `Scheduled price fetch at ${pad(hour)}:${pad(minute)} (cron: ${cron}).`,
      //);
    }
  }

  if (
    Array.isArray(config.scheduleEuMinutes) &&
    config.scheduleEuMinutes.length > 0
  ) {
    const euMinutes = uniqueNumbers(config.scheduleEuMinutes);
    for (const hour of hours) {
      for (const minute of euMinutes) {
        const cron = `${minute} ${hour} * * *`;
        const scheduler = new TaskScheduler(
          async () => {
            try {
              if (!shouldFetchNextDay(config)) {
                console.log(
                  `Skipping ENTSO-E retry before window ${nextDayWindowDescription(config)}`,
                );
                return;
              }
              if (config.debug)
                console.log(
                  `[${new Date().toISOString()}] Scheduled ENTSO-E fallback (${pad(hour)}:${pad(minute)})`,
                );
              await safeFetchAndProcess(priceManager, 1, "entsoe", config);
            } catch (error) {
              console.error(
                `[${new Date().toISOString()}] Scheduled ENTSO-E fetch error:`,
                error.message,
              );
            }
          },
          {
            taskId: `price-entsoe-${hour}-${minute}`,
            logging: Boolean(config.debug),
          },
        );
        scheduler.timeAlignedSchedule(cron);
        activeSchedulers.push(scheduler);
        //console.log(
        //  `Scheduled ENTSO-E retry at ${pad(hour)}:${pad(minute)} (cron: ${cron}).`,
        //);
      }
    }
  }
}

function uniqueNumbers(values) {
  return [
    ...new Set(values.map((v) => Number(v)).filter((v) => !Number.isNaN(v))),
  ].sort((a, b) => a - b);
}

function pad(value) {
  return value.toString().padStart(2, "0");
}

// Helper function to get date string for offset
function getDateForOffset(dayOffset) {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function safeFetchAndProcess(
  priceManager,
  dayOffset,
  priceFetchPriority,
  config,
) {
  try {
    if (dayOffset === 1 && !shouldFetchNextDay(config)) {
      console.log(
        `Skipping next-day fetch before window ${nextDayWindowDescription(config)}`,
      );
      return null;
    }
    const targetDate = getDateForOffset(dayOffset);
    if (await priceManager.priceDataExists(targetDate)) {
      console.log(
        `Skipping fetch for ${targetDate}; cached price file already present.`,
      );
      return await priceManager.getPriceDataByDate(targetDate);
    }

    // Use the fetch-only method to avoid MQTT publishing during fetch cycle
    const prices = await priceManager.fetchPricesOnly(
      dayOffset,
      priceFetchPriority,
    );
    console.log(
      `Successfully fetched prices for day offset ${dayOffset}: ${prices.priceDate}`,
    );
    return prices;
  } catch (error) {
    // Log as warning since it's common for future dates to not be available
    console.warn(
      `Could not fetch prices for day offset ${dayOffset}: ${error.message}`,
    );
    return null;
  }
}

async function handleMqttPublishing(priceManager) {
  if (!priceManager.mqttClient || !priceManager.enableMqtt) {
    return; // Nothing to do if MQTT is not enabled
  }

  const mqttClient = priceManager.mqttClient;
  const priceTopic = priceManager.priceTopic;

  try {
    // Get cached price data from price manager
    const cachedDates = await priceManager.getAllCachedDates();
    const latestDates = await priceManager.getLatestDates(2); // Get latest 2 dates

    // Determine if we have tomorrow's data available by checking if tomorrow's date exists in cache
    const today = new Date().toISOString().split("T")[0];
    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrow = tomorrowDate.toISOString().split("T")[0];

    // Check if tomorrow's data exists in cache
    const tomorrowAvailable = await priceManager.priceDataExists(tomorrow);

    if (tomorrowAvailable) {
      // Tomorrow's prices are available: publish today & tomorrow, unpublish yesterday
      console.log("NextDayAvailable");

      // Publish today's prices (if we have it in cache)
      const todayData = await priceManager.getPriceDataByDate(today);
      if (todayData) {
        const todayTopic = `${priceTopic}/${today}`;
        await mqttClient.publish(
          todayTopic,
          JSON.stringify(todayData, null, 2),
          { retain: true, qos: 1 },
        );
        console.log(`MQTT: Published today's prices to ${todayTopic}`);
      }

      // Publish tomorrow's prices (if we have it in cache)
      const tomorrowData = await priceManager.getPriceDataByDate(tomorrow);
      if (tomorrowData) {
        const tomorrowTopic = `${priceTopic}/${tomorrow}`;
        await mqttClient.publish(
          tomorrowTopic,
          JSON.stringify(tomorrowData, null, 2),
          { retain: true, qos: 1 },
        );
        console.log(`MQTT: Published tomorrow's prices to ${tomorrowTopic}`);
      }

      // Unpublish yesterday's prices (if we have it in cache) - AFTER publishing new data
      const yesterdayDate = new Date();
      yesterdayDate.setDate(yesterdayDate.getDate() - 1);
      const yesterday = yesterdayDate.toISOString().split("T")[0];

      const yesterdayData = await priceManager.getPriceDataByDate(yesterday);
      if (yesterdayData) {
        const yesterdayTopic = `${priceTopic}/${yesterday}`;
        await mqttClient.publish(yesterdayTopic, "", { retain: true, qos: 1 });
        console.log(
          `MQTT: Unpublished yesterday's prices from ${yesterdayTopic}`,
        );
      }
    } else {
      // Tomorrow's prices are NOT available: publish today & yesterday, unpublish 2 days ago

      // Publish yesterday's prices
      const yesterdayDate = new Date();
      yesterdayDate.setDate(yesterdayDate.getDate() - 1);
      const yesterday = yesterdayDate.toISOString().split("T")[0];

      const yesterdayData = await priceManager.getPriceDataByDate(yesterday);
      if (yesterdayData) {
        const yesterdayTopic = `${priceTopic}/${yesterday}`;
        await mqttClient.publish(
          yesterdayTopic,
          JSON.stringify(yesterdayData, null, 2),
          { retain: true, qos: 1 },
        );
        console.log(`MQTT: Published yesterday's prices to ${yesterdayTopic}`);
      }

      // Publish today's prices (if we have it in cache)
      const todayData = await priceManager.getPriceDataByDate(today);
      if (todayData) {
        const todayTopic = `${priceTopic}/${today}`;
        await mqttClient.publish(
          todayTopic,
          JSON.stringify(todayData, null, 2),
          { retain: true, qos: 1 },
        );
        console.log(`MQTT: Published today's prices to ${todayTopic}`);
      }

      // Unpublish 2 days ago - AFTER publishing new data
      const twoDaysAgoDate = new Date();
      twoDaysAgoDate.setDate(twoDaysAgoDate.getDate() - 2);
      const twoDaysAgo = twoDaysAgoDate.toISOString().split("T")[0];

      const twoDaysAgoData = await priceManager.getPriceDataByDate(twoDaysAgo);
      if (twoDaysAgoData) {
        const twoDaysAgoTopic = `${priceTopic}/${twoDaysAgo}`;
        await mqttClient.publish(twoDaysAgoTopic, "", { retain: true, qos: 1 });
        console.log(
          `MQTT: Unpublished 2 days ago's prices from ${twoDaysAgoTopic}`,
        );
      }
    }
  } catch (error) {
    console.error("Error handling MQTT publishing:", error.message);
  }
}

// Run the main function
main();
