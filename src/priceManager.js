/**
 * ElWiz Prices - Price Manager Module
 *
 * A comprehensive module for fetching, processing, managing, and publishing energy prices
 * with configurable methods (MQTT, REST API, File storage, etc.)
 */

const EventEmitter = require("events");

let UniCache;
try {
  // Prefer the local Uni-Cache copy when running in this workspace.
  // This makes it easy to exercise the refactored backends without republishing the package.
  // eslint-disable-next-line global-require, import/no-dynamic-require
  UniCache = require("../../uni-cache/src/UniCache");
} catch (error) {
  UniCache = require("@iotux/uni-cache");
}
const PriceFetcher = require("./priceFetcher");
const PriceService = require("./priceService");
const RestServer = require("./restServer");
const CurrencyFetcher = require("./currencyFetcher");
const ConfigLoader = require("../utils/configLoader");
const MQTTClient = require("../utils/mqttClient");

const PRICE_KEY_PREFIX = "prices-";
const DEFAULT_PRICE_PATH = "./data/prices";
const CURRENCY_KEY_PREFIX = "currencies-";
const DEFAULT_CURRENCY_PATH = "./data/currencies";

class PriceManager {
  constructor(config = {}, configPath = null, providedConfigLoader = null) {
    // Initialize configuration - either from provided config object or from YAML file
    if (typeof config === "string") {
      // If config is a string, treat it as configPath
      this.configLoader = new ConfigLoader(config);
      this.config = this.configLoader.getPriceConfig();
    } else if (config && config.constructor === String) {
      this.configLoader = new ConfigLoader(config);
      this.config = this.configLoader.getPriceConfig();
    } else {
      // If config is an object
      if (providedConfigLoader) {
        // Use the provided config loader (e.g., from bin)
        this.configLoader = providedConfigLoader;
        // Use the provided config, potentially merged with file config if configPath also provided
        if (configPath) {
          const fileConfig = this.configLoader.getPriceConfig();
          this.config = { ...fileConfig, ...config };
        } else {
          this.config = config;
        }
      } else if (configPath) {
        // If configPath is provided, create ConfigLoader and merge
        this.configLoader = new ConfigLoader(configPath);
        const fileConfig = this.configLoader.getPriceConfig();
        this.config = { ...fileConfig, ...config };
      } else {
        // If no configPath provided and no loader, just use the config object
        // Create a minimal configLoader for internal use
        this.configLoader = new ConfigLoader(); // Default path
        this.config = config;
      }
    }

    // Determine enabled methods from config
    this.enableMqtt = this.config.enableMqtt !== false; // Default to true if not specified
    this.enableRest = this.config.enableRest || false;
    this.mqttUrl = this.config.mqttUrl || "mqtt://localhost:1883";
    this.restPort = this.config.restPort || 3000;
    this.priceTopic = this.config.priceTopic || "elwiz/prices";

    // Initialize components
    this.priceFetcher = new PriceFetcher(this.config, this.configLoader, {
      getCurrencyRate: (currencyCode) => this.getCurrencyRate(currencyCode),
    });
    this.priceService = null;
    this.mqttClient = null;
    this.restServer = null;
    this.eventEmitter = new EventEmitter(); // Create event emitter for the manager

    // Initialize caches using UniCache so backends can be swapped via config
    const defaultCacheType =
      this.config.cacheType ||
      (this.config.backend && this.config.backend.type) || "file";
    const priceBackendConfig = this.config.priceBackend || {};
    const currencyBackendConfig = this.config.currencyBackend || {};

    const explicitPriceType =
      this.config.priceCacheType || priceBackendConfig.type;
    const explicitCurrencyType =
      this.config.currencyCacheType || currencyBackendConfig.type;
    const configuredTypes = [explicitPriceType, explicitCurrencyType].filter(
      Boolean,
    );
    const cacheType = configuredTypes[0] || defaultCacheType;
    if (configuredTypes.some((type) => type !== cacheType)) {
      throw new Error(
        `Price and currency caches must share the same cacheType (received ${configuredTypes.join(
          ", ",
        )}).`,
      );
    }

    const pricePath =
      priceBackendConfig.savePath ||
      this.config.priceFilePath ||
      this.config.savePath ||
      DEFAULT_PRICE_PATH;
    const priceSyncOnWrite =
      this.config.priceSyncOnWrite ?? this.config.syncOnWrite ?? true;
    this.priceCache = new UniCache("prices", {
      cacheType,
      savePath: pricePath,
      syncOnWrite: priceSyncOnWrite, // default: immediate persistence for compatibility
      debug: this.config.debug,
      ...(priceBackendConfig.options || {}),
    });

    this.cacheReady =
      typeof this.priceCache.init === "function"
        ? this.priceCache.init().catch((error) => {
            console.error("Failed to initialise price cache:", error.message);
            throw error;
          })
        : Promise.resolve();

    const currencyPath =
      currencyBackendConfig.savePath ||
      this.config.currencyFilePath ||
      this.config.savePath ||
      DEFAULT_CURRENCY_PATH;
    const currencySyncOnWrite =
      this.config.currencySyncOnWrite ?? this.config.syncOnWrite ?? true;
    this.currencyCache = new UniCache("currencies", {
      cacheType,
      savePath: currencyPath,
      syncOnWrite: currencySyncOnWrite,
      debug: this.config.debug,
      ...(currencyBackendConfig.options || {}),
    });

    this.currencyCacheReady =
      typeof this.currencyCache.init === "function"
        ? this.currencyCache.init().catch((error) => {
            console.error(
              "Failed to initialise currency cache:",
              error.message,
            );
            throw error;
          })
        : Promise.resolve();

    this.currencyFetcher = new CurrencyFetcher(this.config);
    this.currencyRateCache = new Map();
    this.currencyKeepDays =
      this.config.currencyKeepDays || this.config.keepDays || 7;

    // Initialize synchronously first (non-async parts)
    this.initializeSync();

    // Initialize async parts in a separate method that should be awaited
    // by calling code or handled internally
    this.initialized = false; // Add a flag to track initialization
  }

  async initialize() {
    // Initialize MQTT if enabled
    if (this.enableMqtt) {
      this.mqttClient = new MQTTClient(
        this.mqttUrl,
        this.config.mqttOptions,
        "PriceManager",
      );
      await this.mqttClient.waitForConnect();
      console.log("MQTT client connected");
    }

    // Initialize price service with MQTT client and event emitter if enabled
    if (this.enableMqtt) {
      this.priceService = new PriceService(
        this.mqttClient,
        this.config,
        console,
        this.eventEmitter,
      );
    } else {
      // Create a minimal price service without MQTT for internal use
      this.priceService = new PriceService(
        null,
        this.config,
        console,
        this.eventEmitter,
      );
    }

    // Initialize REST server if enabled, ensuring priceService is available
    if (this.enableRest) {
      this.restServer = new RestServer(this.restPort);
      // Set the price service after it's been initialized
      this.restServer.setPriceService(this.priceService);
      // Set the cache access methods
      this.restServer.setCacheAccess(this.getCacheAccess());
    }
  }

  // Synchronous initialization (non-async operations only)
  initializeSync() {
    // For now, this is empty since all initialization in original initialize() was async
    // We'll handle the async initialization in the start method
  }

  async ensureInitialized() {
    // Only run initialization once
    if (!this.initialized) {
      // Initialize MQTT if enabled
      if (this.enableMqtt) {
        this.mqttClient = new MQTTClient(
          this.mqttUrl,
          this.config.mqttOptions,
          "PriceManager",
        );
        await this.mqttClient.waitForConnect();
        console.log("MQTT client connected");
      }

      // Initialize price service with MQTT client and event emitter if enabled
      if (this.enableMqtt) {
        this.priceService = new PriceService(
          this.mqttClient,
          this.config,
          console,
          this.eventEmitter,
        );
      } else {
        // Create a minimal price service without MQTT for internal use
        this.priceService = new PriceService(
          null,
          this.config,
          console,
          this.eventEmitter,
        );
      }

      // Initialize REST server if enabled, ensuring priceService is available
      if (this.enableRest) {
        this.restServer = new RestServer(this.restPort);
        // Set the price service after it's been initialized
        this.restServer.setPriceService(this.priceService);
      }

      this.initialized = true;
    }
  }

  async start() {
    // Ensure async initialization is complete before starting
    await this.ensureInitialized();

    // Set the price service in the REST server if both exist (before starting)
    if (this.restServer && this.priceService) {
      this.restServer.setPriceService(this.priceService);
    }
    // Set the cache access methods as well
    if (this.restServer) {
      this.restServer.setCacheAccess(this.getCacheAccess());
    }

    // Start REST server if enabled
    if (this.restServer) {
      try {
        await this.restServer.start();
        console.log(`REST API server started on port ${this.restPort}`);
      } catch (error) {
        console.error(
          `Failed to start REST API server on port ${this.restPort}:`,
          error.message,
        );
        throw error; // Re-throw to be caught by calling code
      }
    }

    await this.ensureCurrencyRates();
  }

  async stop() {
    // Stop REST server if running
    if (this.restServer) {
      await this.restServer.stop();
    }

    // Disconnect MQTT if connected
    if (this.mqttClient) {
      this.mqttClient.end(false);
    }

    // Close the cache if it exists
    if (this.priceCache && typeof this.priceCache.close === "function") {
      await this.ensureCacheReady();
      await this.priceCache.close();
    }

    if (this.currencyCache && typeof this.currencyCache.close === "function") {
      await this.currencyCacheReady;
      await this.currencyCache.close();
    }
  }

  /**
   * Fetch prices from APIs and cache them to file if not already cached, but don't publish to MQTT
   */
  async fetchPricesOnly(dayOffset = 0, preferSource = "nordpool") {
    try {
      await this.ensureCacheReady();
      await this.ensureCurrencyRates();
      // First check if data already exists in cache
      const dateStr = this.getDateForOffset(dayOffset); // Get the date string for the offset

      const exists = await this.priceDataExists(dateStr);
      if (exists) {
        // Data already exists, return it from cache instead of fetching
        return await this.priceCache.retrieveObject(this.getPriceKey(dateStr));
      }

      // Data doesn't exist, fetch it
      const prices = await this.priceFetcher.fetchPrices(
        dayOffset,
        preferSource,
      );

      // Store in file cache
      await this.priceCache.createObject(
        this.getPriceKey(dateStr),
        prices,
        true,
      );

      return prices;
    } catch (error) {
      console.error("Error in fetchPricesOnly:", error.message);
      throw error;
    }
  }

  /**
   * Get date string for a given day offset
   */
  getDateForOffset(dayOffset) {
    const date = new Date();
    date.setDate(date.getDate() + dayOffset);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  /**
   * Get price data from file cache by date
   */
  async getPriceDataByDate(dateStr) {
    await this.ensureCacheReady();
    return await this.priceCache.retrieveObject(this.getPriceKey(dateStr));
  }

  /**
   * Check if price data exists for a date
   */
  async priceDataExists(dateStr) {
    await this.ensureCacheReady();
    const key = this.getPriceKey(dateStr);
    if (
      this.priceCache.backend &&
      typeof this.priceCache.backend.has === "function"
    ) {
      try {
        const exists = await this.priceCache.backend.has(key);
        if (exists) return true;
      } catch (error) {
        console.warn(
          `[PriceManager] Backend existence check failed for ${key}: ${error.message}`,
        );
      }
    }
    return await this.priceCache.has(key);
  }

  /**
   * Get all cached price dates
   */
  async getAllCachedDates() {
    await this.ensureCacheReady();
    const keys = await this.listPriceKeys();
    return keys
      .filter((key) => key.startsWith(PRICE_KEY_PREFIX))
      .map((key) => key.slice(PRICE_KEY_PREFIX.length));
  }

  /**
   * Get latest N cached dates
   */
  async getLatestDates(count = 2) {
    const allDates = await this.getAllCachedDates();
    // Sort dates in descending order (newest first)
    allDates.sort((a, b) => {
      // Compare date strings properly
      return new Date(b) - new Date(a);
    });
    return allDates.slice(0, count);
  }

  /**
   * Remove old cached data based on keepDays setting
   */
  async cleanupOldCache() {
    const keepDays = this.config.keepDays || 7;
    await this.ensureCacheReady();
    const keys = await this.listPriceKeys();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - keepDays);

    for (const key of keys) {
      if (!key.startsWith(PRICE_KEY_PREFIX)) continue;
      const dateStr = key.slice(PRICE_KEY_PREFIX.length);
      // Try to parse the date from the key (assuming format is YYYY-MM-DD)
      const fileDate = new Date(dateStr);

      if (fileDate < cutoffDate) {
        await this.priceCache.deleteObject(key, true); // true forces sync to file
        console.log(`Cleaned up old cache entry: ${dateStr}`);
      }
    }

    await this.cleanupCurrencyCache();
  }

  /**
   * Fetch prices from APIs and optionally publish based on configuration
   */
  async fetchAndProcessPrices(dayOffset = 0, preferSource = "nordpool") {
    try {
      // Fetch prices
      const prices = await this.priceFetcher.fetchPrices(
        dayOffset,
        preferSource,
      );

      // Publish to MQTT if enabled
      if (this.mqttClient && this.enableMqtt) {
        await this.publishToMqtt(prices, dayOffset);
      }

      return prices;
    } catch (error) {
      console.error("Error in fetchAndProcessPrices:", error.message);
      throw error;
    }
  }

  /**
   * Publish price data to MQTT
   */
  async publishToMqtt(priceData, dayOffset = 0) {
    if (!this.mqttClient || !this.enableMqtt) {
      throw new Error("MQTT is not enabled or client not available");
    }

    try {
      await this.mqttClient.waitForConnect();
      const topic = `${this.priceTopic}/${priceData.priceDate}`;

      // Publish the price data
      await this.mqttClient.publish(topic, JSON.stringify(priceData, null, 2), {
        retain: true,
        qos: 1,
      });

      console.log(
        `MQTT message published: ${this.priceTopic}/${priceData.priceDate}`,
      );
    } catch (error) {
      console.error("Error publishing to MQTT:", error.message);
      throw error;
    }
  }

  /**
   * Get available dates for price data
   */
  getAvailableDates() {
    return {
      today: this.priceService.getCurrentPriceDate(),
      tomorrow: this.priceService.isNextDayAvailable()
        ? this.priceService.getNextPriceDate()
        : null,
      yesterday: this.priceService.getPreviousPriceDate(),
    };
  }

  /**
   * Get current day's hourly prices
   */
  getCurrentDayHourly() {
    return this.priceService.getCurrentDayHourlyArray();
  }

  /**
   * Get current day's summary
   */
  getCurrentDaySummary() {
    return this.priceService.getCurrentDaySummary();
  }

  /**
   * Get next day's hourly prices (if available)
   */
  getNextDayHourly() {
    return this.priceService.isNextDayAvailable()
      ? this.priceService.getNextDayHourlyArray()
      : [];
  }

  /**
   * Get next day's summary (if available)
   */
  getNextDaySummary() {
    return this.priceService.isNextDayAvailable()
      ? this.priceService.getNextDaySummary()
      : null;
  }

  /**
   * Get specific hour's data
   */
  getHourData(hourIndex, targetDay = "current") {
    return this.priceService.getHourlyData(hourIndex, targetDay);
  }

  /**
   * Get the configured price service instance
   */
  getPriceService() {
    return this.priceService;
  }

  /**
   * Get the configured price fetcher instance
   */
  getPriceFetcher() {
    return this.priceFetcher;
  }

  /**
   * Get the configured MQTT client instance
   */
  getMqttClient() {
    return this.mqttClient;
  }

  /**
   * Get the configured REST server instance
   */
  getRestServer() {
    return this.restServer;
  }

  /**
   * Get the event emitter instance
   */
  getEventEmitter() {
    return this.eventEmitter;
  }

  /**
   * Get the MQTT topic
   */
  getMqttTopic() {
    return this.priceTopic;
  }

  /**
   * Check if next day prices are available
   */
  isNextDayAvailable() {
    return this.priceService.isNextDayAvailable();
  }

  /**
   * Check if new data has arrived
   */
  hasNewData() {
    return this.priceService.hasNewData();
  }

  /**
   * Clear new data flag
   */
  clearNewData() {
    this.priceService.clearNewDataFlag();
  }

  async ensureCurrencyRates() {
    if (!this.currencyFetcher) return;
    try {
      await this.currencyCacheReady;
      const latest = await this.currencyCache.retrieveObject(
        `${CURRENCY_KEY_PREFIX}latest`,
      );
      const today = new Date().toISOString().split("T")[0];
      if (!latest || latest.date !== today) {
        await this.fetchAndStoreCurrencyRates();
      }
    } catch (error) {
      console.warn(
        `[PriceManager] Unable to ensure currency rates: ${error.message}`,
      );
    }
  }

  async fetchAndStoreCurrencyRates() {
    if (!this.currencyFetcher) return null;
    try {
      await this.currencyCacheReady;
      const data = await this.currencyFetcher.fetchCurrencies();
      const dateKey = `${CURRENCY_KEY_PREFIX}${data.date}`;
      const latestKey = `${CURRENCY_KEY_PREFIX}latest`;

      const existing = await this.currencyCache.retrieveObject(dateKey);

      const stripFetchedAt = (payload) => {
        if (!payload || typeof payload !== "object") return payload;
        const { fetchedAt, ...rest } = payload;
        return rest;
      };

      const stableStringify = (value) =>
        JSON.stringify(value, (key, val) => {
          if (val && typeof val === "object" && !Array.isArray(val)) {
            return Object.keys(val)
              .sort()
              .reduce((acc, prop) => {
                acc[prop] = val[prop];
                return acc;
              }, {});
          }
          return val;
        });

      const incomingSignature = stableStringify(stripFetchedAt(data));
      const existingSignature = existing
        ? stableStringify(stripFetchedAt(existing))
        : null;

      const hasChanges = !existing || existingSignature !== incomingSignature;

      if (hasChanges) {
        await this.currencyCache.createObject(dateKey, data, true);
        await this.currencyCache.createObject(latestKey, data, true);
        this.currencyRateCache.clear();
      } else {
        const latestExists = await this.currencyCache.has(latestKey);
        if (!latestExists && existing) {
          await this.currencyCache.createObject(latestKey, existing, true);
        }
      }

      return data;
    } catch (error) {
      console.error(
        `[PriceManager] Failed to fetch currency rates: ${error.message}`,
      );
      throw error;
    }
  }

  async getCurrencyRate(currencyCode) {
    const code = (
      currencyCode ||
      this.config.priceCurrency ||
      "EUR"
    ).toUpperCase();
    if (code === "EUR") return 1;

    if (this.currencyRateCache.has(code)) {
      return this.currencyRateCache.get(code);
    }

    await this.currencyCacheReady;
    let latest = await this.currencyCache.retrieveObject(
      `${CURRENCY_KEY_PREFIX}latest`,
    );

    if (!latest || !latest.rates || latest.rates[code] === undefined) {
      latest = await this.fetchAndStoreCurrencyRates();
    }

    if (!latest || !latest.rates || latest.rates[code] === undefined) {
      throw new Error(`Currency rate for ${code} not available`);
    }

    const rate = Number(latest.rates[code]);
    this.currencyRateCache.set(code, rate);
    return rate;
  }

  async cleanupCurrencyCache() {
    if (!this.currencyCache) return;
    await this.currencyCacheReady;
    const keys = await this.currencyCache.keys();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.currencyKeepDays);

    for (const key of keys) {
      if (!key.startsWith(CURRENCY_KEY_PREFIX)) continue;
      const dateStr = key.slice(CURRENCY_KEY_PREFIX.length);
      if (dateStr === "latest") continue;
      const fileDate = new Date(dateStr);
      if (Number.isNaN(fileDate.getTime())) continue;
      if (fileDate < cutoffDate) {
        await this.currencyCache.deleteObject(key, true);
        console.log(`Cleaned up old currency entry: ${dateStr}`);
      }
    }
  }

  /**
   * Get the cache methods for accessing stored price data
   */
  getCacheAccess() {
    return {
      getPriceDataByDate: this.getPriceDataByDate.bind(this),
      priceDataExists: this.priceDataExists.bind(this),
    };
  }

  async ensureCacheReady() {
    if (this.cacheReady) {
      await this.cacheReady;
    }
  }

  getPriceKey(dateStr) {
    return `${PRICE_KEY_PREFIX}${dateStr}`;
  }

  async listPriceKeys() {
    await this.ensureCacheReady();
    if (
      this.priceCache.backend &&
      typeof this.priceCache.backend.keys === "function"
    ) {
      try {
        return await this.priceCache.backend.keys();
      } catch (error) {
        console.warn(
          `[PriceManager] Backend key listing failed: ${error.message}`,
        );
      }
    }
    return await this.priceCache.keys();
  }
}
module.exports = PriceManager;
