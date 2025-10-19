const axios = require("axios");
const convert = require("xml-js");
const fs = require("fs");
const path = require("path");

class EntsoeClient {
  constructor({ baseUrl, token, regionCodeMap, region }) {
    this.baseUrl = baseUrl || "https://web-api.tp.entsoe.eu/api";
    this.token = token;
    this.regionCodeMap = regionCodeMap || {};
    this.region = region;
  }

  _resolveRegionCode() {
    const regionCode = this.regionCodeMap[this.region];
    if (!regionCode) {
      throw new Error(`ENTSO-E region mapping missing for ${this.region}`);
    }
    return regionCode;
  }

  _buildUrl(periodStart, periodEnd) {
    return `${this.baseUrl}?documentType=A44&securityToken=${this.token}&in_Domain=${this._resolveRegionCode()}&out_Domain=${this._resolveRegionCode()}&periodStart=${periodStart}&periodEnd=${periodEnd}`;
  }

  async fetch(periodStart, periodEnd) {
    if (!this.token) {
      throw new Error("ENTSO-E API requires an access token");
    }

    const url = this._buildUrl(periodStart, periodEnd);
    const response = await axios.get(url, {
      headers: {
        accept: "application/xml",
        "Content-Type": "application/xml",
      },
    });

    const xml = convert.xml2js(response.data, { compact: true, spaces: 4 });
    this._dumpRaw(periodStart, periodEnd, xml);
    const document = xml.Publication_MarketDocument;
    if (!document) {
      throw new Error("ENTSO-E: Unexpected document structure");
    }

    const timeSeries = Array.isArray(document.TimeSeries)
      ? document.TimeSeries
      : [document.TimeSeries];
    const withPeriods = timeSeries.filter((series) => Boolean(series?.Period));
    if (!withPeriods.length) {
      throw new Error("ENTSO-E: Prices are not available in the response");
    }

    // Flatten all periods to support multiple segments (e.g., DST days)
    const points = [];
    let resolution = "PT60M";
    for (const series of withPeriods) {
      const period = series.Period;
      const periodResolution =
        period?.resolution?._text || period?.resolution || "PT60M";
      const periodPoints = this._extractPoints(period, periodResolution);
      points.push(...periodPoints);
      if (period?.resolution?._text) {
        resolution = period.resolution._text;
      }
    }

    return {
      provider: "ENTSO-E",
      providerUrl: this._buildUrl("*****", "*****"),
      resolution,
      points,
    };
  }

  _extractPoints(period, resolution) {
    const startTime =
      period.timeInterval?.start?._text || period.timeInterval?.start;
    if (!startTime) {
      throw new Error("ENTSO-E: Missing time interval start value");
    }

    const points = Array.isArray(period.Point) ? period.Point : [period.Point];
    const sortedPoints = points
      .map((point) => {
        const position = Number(point.position?._text || point.position);
        const valueRaw = point["price.amount"]?._text || point["price.amount"];
        if (valueRaw === undefined) {
          return null;
        }
        const minutesStep = resolutionToMinutes(resolution);
        const start = this._calculateTimestamp(
          startTime,
          position - 1,
          minutesStep,
        );
        const end = this._calculateTimestamp(startTime, position, minutesStep);
        return {
          start,
          end,
          value: Number(valueRaw) / 1000,
          currency: point["price.currency"]?._text || "EUR",
        };
      })
      .filter(Boolean);

    sortedPoints.sort(
      (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
    );

    return sortedPoints;
  }

  _calculateTimestamp(startIso, index, minutesStep) {
    const step = Number.isFinite(minutesStep) && minutesStep > 0 ? minutesStep : 15;
    const base = new Date(startIso);
    base.setMinutes(base.getMinutes() + index * step);
    return base.toISOString();
  }
}

function resolutionToMinutes(resolution) {
  if (typeof resolution !== "string") {
    return 15;
  }

  if (resolution === "PT60M") {
    return 60;
  }

  if (resolution === "PT15M") {
    return 15;
  }

  if (resolution.startsWith("PT") && resolution.endsWith("M")) {
    const minutes = Number(resolution.slice(2, -1));
    if (!Number.isNaN(minutes) && minutes > 0) {
      return minutes;
    }
  }

  return 15;
}

EntsoeClient.prototype._dumpRaw = function (periodStart, periodEnd, xml) {
  try {
    const dir = path.resolve(process.cwd(), "data", "ENTSOEPRICES");
    const safeStart = periodStart.replace(/[^0-9A-Za-z]/g, "_");
    const safeEnd = periodEnd.replace(/[^0-9A-Za-z]/g, "_");
    const priceDate = safeStart.slice(0, 8);
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(
      dir,
      `raw-entsoe-${this.region}-${priceDate}-${timestamp}.json`,
    );
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          fetchedAt: new Date().toISOString(),
          region: this.region,
          periodStart,
          periodEnd,
          xml,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.warn("[EntsoeClient] Unable to dump raw response:", error.message);
  }
};

module.exports = EntsoeClient;
