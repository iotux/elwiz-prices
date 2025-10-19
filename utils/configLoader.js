const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const DEFAULT_PRICE_CONFIG_CANDIDATES = ["price-config.yaml"];

const DEFAULT_APP_CONFIG_CANDIDATES = ["config.yaml"];

function resolveConfigPath(inputPath, candidates, description) {
  if (inputPath) {
    const resolved = path.isAbsolute(inputPath)
      ? inputPath
      : path.resolve(process.cwd(), inputPath);
    return resolved;
  }

  for (const candidate of candidates) {
    const resolvedCandidate = path.resolve(process.cwd(), candidate);
    if (fs.existsSync(resolvedCandidate)) {
      return resolvedCandidate;
    }
  }

  // Fall back to first candidate even if it doesn't exist so we have a deterministic path.
  const fallback = path.resolve(process.cwd(), candidates[0]);
  console.info(
    `ConfigLoader: no ${description} file found. Expecting configuration at ${fallback}`,
  );
  return fallback;
}

class ConfigLoader {
  constructor(priceConfigPath, appConfigPath) {
    if (
      priceConfigPath &&
      typeof priceConfigPath === "object" &&
      !Array.isArray(priceConfigPath)
    ) {
      const options = priceConfigPath;
      this.priceConfigPath = resolveConfigPath(
        options.priceConfigPath,
        DEFAULT_PRICE_CONFIG_CANDIDATES,
        "price",
      );
      this.appConfigPath = resolveConfigPath(
        options.appConfigPath || options.configPath,
        DEFAULT_APP_CONFIG_CANDIDATES,
        "app",
      );
    } else {
      this.priceConfigPath = resolveConfigPath(
        priceConfigPath,
        DEFAULT_PRICE_CONFIG_CANDIDATES,
        "price",
      );
      this.appConfigPath = resolveConfigPath(
        appConfigPath,
        DEFAULT_APP_CONFIG_CANDIDATES,
        "app",
      );
    }

    this.reload();
  }

  loadYaml(filePath, { missingLevel = "warn" } = {}) {
    try {
      if (fs.existsSync(filePath)) {
        const fileContents = fs.readFileSync(filePath, "utf8");
        const data = yaml.load(fileContents);
        return data || {};
      }

      if (missingLevel === "warn") {
        console.warn(`Config file ${filePath} not found, using defaults`);
      } else if (missingLevel === "info") {
        console.info(`Config file ${filePath} not found, using defaults`);
      }
      return {};
    } catch (error) {
      console.error(
        `Error reading or parsing the YAML config file ${filePath}: ${error.message}`,
      );
      return {};
    }
  }

  loadAllConfigs() {
    const appConfig = this.loadYaml(this.appConfigPath, {
      missingLevel: "info",
    });
    const priceConfig = this.loadYaml(this.priceConfigPath, {
      missingLevel: "warn",
    });
    return {
      appConfig,
      priceConfig,
      mergedConfig: { ...appConfig, ...priceConfig },
    };
  }

  get(key, defaultValue = undefined) {
    // Support nested keys using dot notation (e.g. 'database.host')
    const keys = key.split(".");
    let value = this.config;

    for (const k of keys) {
      if (value && typeof value === "object" && value.hasOwnProperty(k)) {
        value = value[k];
      } else {
        return defaultValue;
      }
    }

    return value !== undefined ? value : defaultValue;
  }

  set(key, value) {
    // Support nested keys using dot notation
    const keys = key.split(".");
    let current = this.config;

    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!current[k] || typeof current[k] !== "object") {
        current[k] = {};
      }
      current = current[k];
    }

    current[keys[keys.length - 1]] = value;
  }

  getAll() {
    return { ...this.config };
  }

  reload() {
    const { appConfig, priceConfig, mergedConfig } = this.loadAllConfigs();
    this.appConfig = appConfig;
    this.priceConfig = priceConfig;
    this.config = mergedConfig;
    return this.config;
  }

  // Method to validate configuration structure
  validate() {
    const errors = [];

    // Validate required fields if needed
    // Add validation rules as needed

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  // Get configuration specific to price management
  getPriceConfig() {
    return {
      // Enable/disable methods
      enableMqtt: this.get("enableMqtt", true),
      enableRest: this.get("enableRest", false),
      cacheType: this.get("cacheType"),
      priceCacheType: this.get("priceCacheType"),
      currencyCacheType: this.get("currencyCacheType"),
      syncOnWrite: this.get("syncOnWrite"),
      priceSyncOnWrite: this.get("priceSyncOnWrite"),
      currencySyncOnWrite: this.get("currencySyncOnWrite"),
      backend: this.get("backend", {}),
      priceBackend: this.get("priceBackend", {}),
      currencyBackend: this.get("currencyBackend", {}),

      // MQTT configuration
      mqttUrl: this.get("mqttUrl", "mqtt://localhost:1883"),
      mqttOptions: this.get("mqttOptions", {}),
      priceTopic: this.get("priceTopic", "elwiz/prices"),

      // REST configuration
      restPort: this.get("restPort", 3000),

      // Price settings
      regionCode: this.get("regionCode", "NO1"),
      priceCurrency: this.get("priceCurrency", "NOK"),
      priceInterval: this.get("priceInterval", "1h"), // '1h' or '15m'
      dayHoursStart: this.get("dayHoursStart", 6),
      dayHoursEnd: this.get("dayHoursEnd", 22),
      savePath: this.get("savePath", "./data"),
      priceFilePath: this.get("priceFilePath", "./data/prices"),
      currencyFilePath: this.get("currencyFilePath", "./data/currencies"),

      // API settings
      entsoeBaseUrl: this.get(
        "entsoeBaseUrl",
        "https://web-api.tp.entsoe.eu/api",
      ),
      priceAccessToken: this.get("priceAccessToken"),
      priceFetchPriority: this.get("priceFetchPriority", "nordpool"),
      keepDays: this.get("keepDays", 7),
      currencyUrl: this.get(
        "currencyUrl",
        "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
      ),
      currencyKeepDays: this.get("currencyKeepDays", this.get("keepDays", 7)),
      scheduleHours: this.get("scheduleHours", [13, 14]),
      scheduleMinutes: this.get("scheduleMinutes", [6, 11, 16, 21]),
      scheduleEuMinutes: this.get("scheduleEuMinutes", [5]),
      nextDayFetchHour: this.get("nextDayFetchHour", 13),
      nextDayFetchMinute: this.get("nextDayFetchMinute", 0),
      // Debug
      debug: this.get("schedulerDebug", false),
    };
  }

  // Load the priceregions.yaml file
  loadPriceRegions() {
    try {
      const priceregionsPath = "./priceregions.yaml";
      if (fs.existsSync(priceregionsPath)) {
        const fileContents = fs.readFileSync(priceregionsPath, "utf8");
        const data = yaml.load(fileContents);
        return data || {};
      } else {
        console.warn(
          `Price regions file ${priceregionsPath} not found, using empty map`,
        );
        return {};
      }
    } catch (error) {
      console.error(
        `Error reading or parsing the price regions YAML file: ${error.message}`,
      );
      return {};
    }
  }
}

module.exports = ConfigLoader;
