const { format } = require("date-fns");
const { fetchDayAheadPrices } = require("energy-price-fetcher");
const ConfigLoader = require("../utils/configLoader");

class PriceFetcher {
  constructor(config = {}, configLoader = null, services = {}) {
    this.config = config;
    this.configLoader = configLoader || new ConfigLoader();

    this.region = config.regionCode || "NO1";
    this.priceCurrency = config.priceCurrency || "NOK";
    this.priceInterval = config.priceInterval || "1h";
    this.dayHoursStart =
      config.dayHoursStart !== undefined ? Number(config.dayHoursStart) : 6;
    this.dayHoursEnd =
      config.dayHoursEnd !== undefined ? Number(config.dayHoursEnd) : 22;
    this.preferredSource = config.priceFetchPriority || "nordpool";
    this.entsoeToken = config.priceAccessToken || null;

    this.baseUrls = {
      nordpool:
        config.nordPoolUrl ||
        "https://dataportal-api.nordpoolgroup.com/api/DayAheadPrices?market=DayAhead",
      entsoe: config.entsoeBaseUrl || "https://web-api.tp.entsoe.eu/api",
    };

    this.currencyRateProvider =
      services && typeof services.getCurrencyRate === "function"
        ? services.getCurrencyRate
        : null;
  }

  async fetchPrices(dayOffset = 0, preferSource = null) {
    const isoDate = this.dateWithOffset(dayOffset);
    return fetchDayAheadPrices({
      region: this.region,
      currency: this.priceCurrency,
      date: isoDate,
      interval: this.priceInterval,
      prefer: preferSource || this.preferredSource,
      entsoeToken: this.entsoeToken,
      getCurrencyRate: this.currencyRateProvider,
      baseUrls: this.baseUrls,
      dayHoursStart: this.dayHoursStart,
      dayHoursEnd: this.dayHoursEnd,
    });
  }

  async fetchNordPoolPrices(dayOffset = 0) {
    return this.fetchPrices(dayOffset, "nordpool");
  }

  async fetchEntsoePrices(dayOffset = 0) {
    return this.fetchPrices(dayOffset, "entsoe");
  }

  dateWithOffset(offset) {
    const oneDay = 24 * 60 * 60 * 1000;
    const now = new Date();
    const target = new Date(now.getTime() + oneDay * offset);
    return format(target, "yyyy-MM-dd");
  }
}

module.exports = PriceFetcher;
