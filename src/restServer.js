const express = require("express");

class RestServer {
  constructor(port = 3000, priceService = null, cacheAccess = null) {
    this.port = port;
    this.priceService = priceService;
    this.cacheAccess = cacheAccess;
    this.app = express();
    this.basePath = "/api/prices";
    this.server = null;

    // Middleware
    this.app.use(express.json());
    this.app.use(express.urlencoded({ extended: true }));

    // CORS
    this.app.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
      );
      res.header(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept, Authorization",
      );
      if (req.method === "OPTIONS") return res.sendStatus(200);
      next();
    });

    // Routes
    this.setupRoutes();
  }

  // ------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------

  _ensurePriceService(res) {
    if (!this.priceService) {
      this._sendError(res, 500, "Price service not initialized");
      return false;
    }
    return true;
  }

  _isValidDate(date) {
    return /^\d{4}-\d{2}-\d{2}$/.test(date);
  }

  _sendError(res, status, message) {
    res.status(status).json({
      status,
      error: message,
      info: "See REST API usage at https://github.com/iotux/elwiz-prices#rest-api-prices",
    });
  }

  /**
   * Strict object fetcher for a given date.
   * Priority:
   *   1) priceService.getDayObject(date)               -> return AS-IS
   *   2) priceService.get{Current|Next|Previous}DayObject() (if date matches) -> AS-IS
   *   3) cacheAccess.getPriceDataByDate(date)          -> AS-IS
   * No object assembly performed here.
   */
  async _fetchPriceObject(date) {
    if (!this._isValidDate(date)) return null;

    const ps = this.priceService;

    // 1) Direct date-based getter, if provided by priceService
    try {
      if (ps?.getDayObject) {
        const obj = await Promise.resolve(ps.getDayObject(date));
        if (obj) return obj;
      }
    } catch {
      // fall through to other strategies
    }

    // 2) Current/Next/Previous getters, if the priceService supports them
    try {
      const currentDate = ps?.getCurrentPriceDate?.();
      const nextDate = ps?.isNextDayAvailable?.()
        ? ps?.getNextPriceDate?.()
        : null;
      const previousDate = ps?.getPreviousPriceDate?.();

      if (date === currentDate && ps?.getCurrentDayObject) {
        const obj = await Promise.resolve(ps.getCurrentDayObject());
        if (obj) return obj;
      }
      if (nextDate && date === nextDate && ps?.getNextDayObject) {
        const obj = await Promise.resolve(ps.getNextDayObject());
        if (obj) return obj;
      }
      if (date === previousDate && ps?.getPreviousDayObject) {
        const obj = await Promise.resolve(ps.getPreviousDayObject());
        if (obj) return obj;
      }
    } catch {
      // fall through to cache
    }

    // 3) Fallback to cache: return AS-IS
    try {
      if (
        !this.cacheAccess?.getPriceDataByDate ||
        !this.cacheAccess?.priceDataExists
      )
        return null;
      const exists = await this.cacheAccess.priceDataExists(date);
      if (!exists) return null;

      const cached = await this.cacheAccess.getPriceDataByDate(date);
      return cached || null;
    } catch {
      return null;
    }
  }

  /**
   * Walk an object using a slash-separated path. Numeric segments index arrays.
   * Returns undefined when a segment is missing.
   */
  _getByPath(root, pathString) {
    if (!pathString || pathString === "/") return root;
    const parts = pathString
      .replace(/^\/+/, "")
      .split("/")
      .map(decodeURIComponent);

    let cur = root;
    for (const part of parts) {
      if (cur == null) return undefined;

      if (Array.isArray(cur) && /^[0-9]+$/.test(part)) {
        cur = cur[Number(part)];
      } else if (Object.prototype.hasOwnProperty.call(cur, part)) {
        cur = cur[part];
      } else {
        return undefined;
      }
    }
    return cur;
  }

  // ------------------------------------------------------------------------
  // Routes
  // ------------------------------------------------------------------------

  setupRoutes() {
    // Health route
    this.app.get("/health", (_req, res) => res.json({ status: "ok" }));

    // API docs
    this.app.get("/api", (_req, res) => {
      const base = this.basePath;
      res.json({
        status: 501,
        error: "Endpoint not implemented. See documentation for available routes.",
        info: "See REST API usage at https://github.com/iotux/elwiz-prices#rest-api-prices",
        documentation: "https://github.com/iotux/elwiz-prices#rest-api-prices",
        basePath: base,
      });
    });

    const basePath = this.basePath;
    const registerRoutesForBase = () => {
      // Daily object
      this.app.get(`${basePath}/:date/daily`, async (req, res) => {
        if (!this._ensurePriceService(res)) return;
        const date = req.params.date;
        if (!this._isValidDate(date)) {
          return this._sendError(res, 400, "Invalid date format. Expected YYYY-MM-DD.");
        }
        try {
          const obj = await this._fetchPriceObject(date);
          if (!obj)
            return this._sendError(
              res,
              404,
              `Price data not available for date: ${date}`,
            );

          const value = this._getByPath(obj, "daily");
          if (typeof value === "undefined") {
            return this._sendError(res, 404, "Path not found: /daily");
          }
          return res.json(value);
        } catch (err) {
          return this._sendError(res, 500, err.message);
        }
      });

      // Daily element
      this.app.get(`${basePath}/:date/daily/:element`, async (req, res) => {
        if (!this._ensurePriceService(res)) return;
        const { date, element } = req.params;
        if (!this._isValidDate(date)) {
          return this._sendError(res, 400, "Invalid date format. Expected YYYY-MM-DD.");
        }
        try {
          const obj = await this._fetchPriceObject(date);
          if (!obj)
            return this._sendError(
              res,
              404,
              `Price data not available for date: ${date}`,
            );

          const value = this._getByPath(obj, `daily/${element}`);
          if (typeof value === "undefined") {
            return this._sendError(
              res,
              404,
              `Path not found: /daily/${element}`,
            );
          }
          return res.json(value);
        } catch (err) {
          return this._sendError(res, 500, err.message);
        }
      });

      // Hour shorthand: base/:date/:hour(0-23) -> hourly[hour]
      this.app.get(`${basePath}/:date/:hour(\\d+)`, async (req, res) => {
        if (!this._ensurePriceService(res)) return;
        const date = req.params.date;
        const hour = parseInt(req.params.hour, 10);

        if (!this._isValidDate(date)) {
          return this._sendError(res, 400, "Invalid date format. Expected YYYY-MM-DD.");
        }
        if (Number.isNaN(hour) || hour < 0 || hour > 23) {
          return this._sendError(res, 400, "Invalid hour. Must be 0-23.");
        }

        try {
          const obj = await this._fetchPriceObject(date);
          if (!obj)
            return this._sendError(
              res,
              404,
              `Price data not available for date: ${date}`,
            );

          const value = this._getByPath(obj, `hourly/${hour}`);
          if (typeof value === "undefined") {
            return this._sendError(
              res,
              404,
              `Path not found: /hourly/${hour}`,
            );
          }
          return res.json(value);
        } catch (err) {
          return this._sendError(res, 500, err.message);
        }
      });

      // Hour element shorthand: base/:date/:hour/:element
      this.app.get(`${basePath}/:date/:hour(\\d+)/:element`, async (req, res) => {
        if (!this._ensurePriceService(res)) return;
        const { date, hour: hourStr, element } = req.params;
        const hour = parseInt(hourStr, 10);

        if (!this._isValidDate(date)) {
          return this._sendError(res, 400, "Invalid date format. Expected YYYY-MM-DD.");
        }
        if (Number.isNaN(hour) || hour < 0 || hour > 23) {
          return this._sendError(res, 400, "Invalid hour. Must be 0-23.");
        }

        try {
          const obj = await this._fetchPriceObject(date);
          if (!obj)
            return this._sendError(
              res,
              404,
              `Price data not available for date: ${date}`,
            );

          const value = this._getByPath(obj, `hourly/${hour}/${element}`);
          if (typeof value === "undefined") {
            return this._sendError(
              res,
              404,
              `Path not found: /hourly/${hour}/${element}`,
            );
          }
          return res.json(value);
        } catch (err) {
          return this._sendError(res, 500, err.message);
        }
      });

      // Generic path resolver (place BEFORE whole-day route)
      this.app.get(`${basePath}/:date/*`, async (req, res) => {
        if (!this._ensurePriceService(res)) return;
        const date = req.params.date;

        if (!this._isValidDate(date)) {
          return this._sendError(res, 400, "Invalid date format. Expected YYYY-MM-DD.");
        }

        try {
          const obj = await this._fetchPriceObject(date);
          if (!obj) {
            return this._sendError(
              res,
              404,
              `Price data not available for date: ${date}`,
            );
          }

          const path = req.params[0] || "";
          const value = this._getByPath(obj, path);

          if (typeof value === "undefined") {
            const normalized = path.startsWith("/") ? path : `/${path}`;
            return this._sendError(res, 404, `Path not found: ${normalized}`);
          }
          return res.json(value);
        } catch (err) {
          return this._sendError(res, 500, err.message);
        }
      });

      // Whole day object (after more specific routes)
      this.app.get(`${basePath}/:date`, async (req, res) => {
        if (!this._ensurePriceService(res)) return;
        const date = req.params.date;

        if (!this._isValidDate(date)) {
          return this._sendError(res, 400, "Invalid date format. Expected YYYY-MM-DD.");
        }

        try {
          const obj = await this._fetchPriceObject(date);
          if (!obj) {
            return this._sendError(
              res,
              404,
              `Price data not available for date: ${date}`,
            );
          }
          return res.json(obj);
        } catch (err) {
          return this._sendError(res, 500, err.message);
        }
      });
    };

    registerRoutesForBase();

    // Fallback 404 handler (JSON)
    this.app.use((req, res, next) => {
      if (res.headersSent) return next();
      this._sendError(res, 404, `Route not found: ${req.originalUrl}`);
    });

    // Error handler (JSON)
    this.app.use((err, req, res, next) => {
      // eslint-disable-next-line no-console
      console.error("REST API error:", err);
      if (res.headersSent) return next(err);
      const status = err.status || 500;
      this._sendError(res, status, err.message || "Internal Server Error");
    });
  }

  // ------------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------------

  setPriceService(priceService) {
    this.priceService = priceService;
  }

  setCacheAccess(cacheAccess) {
    this.cacheAccess = cacheAccess;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = this.app
        .listen(this.port, () => {
          console.log(`REST API server running on port ${this.port}`);
          resolve();
        })
        .on("error", (err) => reject(err));
    });
  }

  stop() {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server.close(() => {
        console.log("REST API server stopped");
        resolve();
      });
    });
  }
}

module.exports = RestServer;
