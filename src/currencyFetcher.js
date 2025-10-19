const { fetchCurrencies } = require("energy-price-fetcher");

class CurrencyFetcher {
  constructor(config = {}) {
    this.currencyUrl =
      config.currencyUrl ||
      "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
  }

  async fetchCurrencies() {
    return fetchCurrencies({ currencyUrl: this.currencyUrl });
  }
}

CurrencyFetcher.fetchCurrencies = fetchCurrencies;

module.exports = CurrencyFetcher;
