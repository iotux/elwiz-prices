const axios = require("axios");

class NordPoolClient {
  constructor({ region, currency, baseUrl }) {
    this.region = region;
    this.currency = currency;
    this.baseUrl =
      baseUrl ||
      "https://dataportal-api.nordpoolgroup.com/api/DayAheadPrices?market=DayAhead";
  }

  async fetch(dayOffset, dateString) {
    const url = `${this.baseUrl}&deliveryArea=${this.region}&currency=${this.currency}&date=${dateString}`;
    const response = await axios.get(url, {
      headers: {
        accept: "application/json",
        "Content-Type": "text/json",
      },
    });

    if (response.status !== 200 || !response.data) {
      throw new Error(
        `Nord Pool: Day ahead prices are not ready for ${dateString}`,
      );
    }

    const priceObjects = response.data.multiAreaEntries || [];
    const points = priceObjects
      .map((entry) => {
        const rawValue = entry.entryPerArea?.[this.region];
        if (rawValue === undefined) {
          return null;
        }
        return {
          start: entry.deliveryStart,
          end: entry.deliveryEnd,
          value: Number(rawValue) / 1000,
          currency: this.currency,
        };
      })
      .filter(Boolean);

    return {
      provider: "Nord Pool",
      providerUrl: url,
      resolution: points.length === 96 ? "PT15M" : "PT60M",
      points,
    };
  }
}

module.exports = NordPoolClient;
