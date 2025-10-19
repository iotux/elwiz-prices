#!/usr/bin/env node

/**
 * ElWiz Prices - Main Module Export
 *
 * A comprehensive module for fetching, processing, and managing energy prices
 */

const PriceService = require("./src/priceService");
const PriceFetcher = require("./src/priceFetcher");
const PriceManager = require("./src/priceManager");
const RestServer = require("./src/restServer");
const MQTTClient = require("./utils/mqttClient");
const ConfigLoader = require("./utils/configLoader");
const CurrencyFetcher = require("./src/currencyFetcher");
const { fetchCurrencies } = require("energy-price-fetcher");

module.exports = {
  PriceService,
  PriceFetcher,
  PriceManager,
  MQTTClient,
  RestServer,
  ConfigLoader,
  CurrencyFetcher,
  fetchCurrencies,
  // For backward compatibility, also export directly
  default: {
    PriceService,
    PriceFetcher,
    PriceManager,
    MQTTClient,
    RestServer,
    ConfigLoader,
    CurrencyFetcher,
    fetchCurrencies,
  },
};
