# elwiz-prices

A comprehensive Node.js module for fetching, processing, managing, and publishing energy prices from Nord Pool and ENTSO-E APIs with configurable methods.

## Features

- Fetch energy prices from Nord Pool or ENTSO-E APIs
- Support for both 1-hour and 15-minute price intervals
- Automatic fallback between available providers
- Price data management with daily rollover support
- Dual publishing capabilities: MQTT and REST API
- YAML configuration for method selection
- Configurable price calculations with VAT, grid fees, and supplier costs
- Complete integration with other ElWiz programs

> ⚠️ **Heads-up about ENTSO-E data quality:** Several bidding zones (including NO1 and NO3) currently miss random 15-minute positions in the ENTSO-E day-ahead payload, even though Nord Pool delivers the full 96 quarter-hours. The fetcher keeps ENTSO-E available as a fallback, but you should treat Nord Pool as the canonical source and watch your logs for warnings about incomplete ENTSO-E series if you depend on that provider.

## Installation

```bash
npm install elwiz-prices
```

## Usage

### Quick Start with PriceManager (Recommended)
```javascript
const { PriceManager } = require('elwiz-prices');

// Use YAML configuration file
const priceManager = new PriceManager('./price-config.yaml');

// Or use inline configuration
const config = {
  enableMqtt: true,
  enableRest: true,
  mqttUrl: 'mqtt://localhost:1883',
  restPort: 3000,
  regionCode: 'NO1',
  priceInterval: '1h',
  // ... other settings
};

const priceManager = new PriceManager(config);

// Start the manager
await priceManager.start();

// Fetch and publish prices
const todayPrices = await priceManager.fetchAndProcessPrices(0);

// Access price data
const currentDayData = priceManager.getCurrentDayHourly();
```

### Using specific components

#### Price Fetcher
```javascript
const { PriceFetcher } = require('elwiz-prices');

const config = {
  regionCode: 'NO1',           // Nord Pool region code
  priceCurrency: 'NOK',        // Currency code
  priceInterval: '1h',         // '1h' for hourly, '15m' for 15-minutes
  dayHoursStart: 6,            // Daytime hours start
  dayHoursEnd: 22,             // Daytime hours end
  // ... other price calculation parameters
};

const fetcher = new PriceFetcher(config);

// Fetch prices for today (dayOffset = 0)
try {
  const prices = await fetcher.fetchPrices(0, 'nordpool');
  console.log(prices);
} catch (error) {
  console.error('Error fetching prices:', error.message);
}
```

#### Price Service
```javascript
const mqtt = require('mqtt');
const { PriceService } = require('elwiz-prices');

const mqttClient = mqtt.connect('mqtt://localhost:1883');
const config = {
  priceTopic: 'elwiz/prices',
  debug: true
};

const priceService = new PriceService(mqttClient, config);

// Wait for price data to load
priceService.event.on('newPrices', () => {
  console.log('New price data received!');

  // Get current day's hourly data
  const hourlyData = priceService.getCurrentDayHourlyArray();
  console.log('Current day hourly data:', hourlyData);

  // Get specific hour data
  const hourData = priceService.getHourlyData(12); // 12th hour
  console.log('Hour 12 data:', hourData);

  // Get daily summary
  const dailySummary = priceService.getCurrentDaySummary();
  console.log('Daily summary:', dailySummary);
});
```

#### REST API Server
```javascript
const { RestServer, PriceService } = require('elwiz-prices');

const restServer = new RestServer(3000, priceService);
await restServer.start();
// API available at http://localhost:3000/api/
```

## Configuration

The service reads two YAML files by default:

- `config.yaml` for general service behaviour (MQTT, REST, storage paths, scheduling)
- `price-config.yaml` for price-specific settings and adjustments

Examples are provided as `config-example.yaml` and `price-config-example.yaml`. Copy them to `config.yaml` / `price-config.yaml` and tailor them to your installation.

### config.yaml

```yaml
# General ElWiz configuration
enableMqtt: true
enableRest: false
mqttUrl: 'mqtt://localhost:1883'
mqttOptions: {}
priceTopic: 'elwiz/prices'
restPort: 3000
savePath: './data'
priceFilePath: './data/prices'
currencyFilePath: './data/currencies'
keepDays: 7
currencyKeepDays: 7
scheduleHours: [13, 14]
scheduleMinutes: [6, 11, 16, 21]
scheduleEuMinutes: [5]
nextDayFetchHour: 13
nextDayFetchMinute: 0
currencyUrl: 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'
DEBUG: false
```

### price-config.yaml

```yaml
# Price-specific settings
cacheType: 'file'
regionCode: 'NO1'
priceCurrency: 'NOK'
priceInterval: '1h'
dayHoursStart: 6
dayHoursEnd: 22

# API settings
priceAccessToken: 'your-token-here'
priceFetchPriority: 'nordpool'
```

When running the CLI you can override the default paths with:

```bash
node ./bin/elwiz-prices.js ./custom-price-config.yaml ./custom-config.yaml
```

## REST API (prices)

When `enableRest` is true, the service exposes a JSON-first navigation API at `GET /api/prices/...`.
Build URLs by appending segments after this base path:

| Purpose | Example | Result |
|---------|---------|--------|
| Whole-day object | `/api/prices/2025-10-15` | Complete stored JSON for the date |
| Daily block | `/api/prices/2025-10-15/daily` | Daily summary section |
| Field inside daily block | `/api/prices/2025-10-15/daily/avgPrice` | Numeric value for the average price |
| Hourly price array | `/api/prices/2025-10-15/hourly` | Array of hourly entries |
| Specific hour (shorthand) | `/api/prices/2025-10-15/10` | Hour starting at 10:00 |
| Specific hour element | `/api/prices/2025-10-15/hourly/10/spotPrice` | The `spotPrice` field for hour 10 |

Rules:
- Segments are separated by `/`.  
- Numeric segments (e.g. `10`) index into arrays; all other segments select object properties.
- Invalid dates return HTTP 400 with `{ "status": 400, "error": "..." }`.
- Missing data or unknown paths return HTTP 404 with `{ "status": 404, "error": "..." }` (for example `{"status":404,"error":"Path not found: /hourly/99"}`).
- Unknown routes (including typos in the base path) also return HTTP 404 with a JSON body (`{"status":404,"error":"Route not found: /api/..."}`).
- Server-side issues (for example, a backend that cannot be reached) respond with 5xx status codes and the JSON body mirrors that status (`{"status":503,"error":"..."}`).

Health check endpoint: `GET /health` → `{ "status": "ok" }`.

## Components

### PriceManager (Main orchestrator)
- Combines all functionality with configurable methods
- Handles MQTT publishing and REST API based on config
- Manages configuration loading from YAML

### PriceFetcher
- Fetches prices from Nord Pool or ENTSO-E APIs
- Handles both 1h and 15m intervals
- Implements API fallback logic

### PriceService
- Manages and provides access to price data
- Handles daily rollovers and data persistence
- Emits events for new price data

### MQTTClient
- Handles MQTT connections and publishing
- Built-in error handling and reconnection

### RestServer
- Provides REST API endpoints for price access
- Express.js based with CORS support

### ConfigLoader
- Loads configuration from YAML files
- Provides validation and default values

## Nord Pool API Changes

Effective October 1st, 2025, Nord Pool changed their price interval from 1-hour to 15-minute intervals. This module handles both formats automatically:

- When `priceInterval` is '1h' and 96 price objects are received, they are averaged into 24 hourly prices
- When `priceInterval` is '1h' and 24 price objects are received, they are used as hourly prices
- When `priceInterval` is '15m' and 96 price objects are received, they are used as 15-minute prices
- When `priceInterval` is '15m' and 24 price objects are received, they are divided by 4 to create 15-minute prices

## License

MIT
