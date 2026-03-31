"use strict";

const { randomUUID } = require("node:crypto");
const { getNextCronOccurrence, parseCronExpression } = require("./metadata-sync");

const DEFAULT_QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";
const DEFAULT_QUOTA_CRON = "*/10 * * * *";
const DEFAULT_QUOTA_TIMEOUT_MS = 30000;
const DEFAULT_ACCEPT_LANGUAGE = "en-US,en";

function readFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function readInt(value) {
  const number = readFiniteNumber(value);
  if (number === null) {
    return null;
  }
  return Math.trunc(number);
}

function readString(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function toIsoTimestamp(value) {
  const timestampMs = readInt(value);
  if (!Number.isInteger(timestampMs) || timestampMs <= 0) {
    return null;
  }

  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

function normalizeUsageDetail(detail) {
  return {
    modelCode: readString(detail && detail.modelCode),
    usage: readInt(detail && detail.usage),
  };
}

function normalizeLimit(limit) {
  const usageDetailsSource = Array.isArray(limit && limit.usageDetails)
    ? limit.usageDetails
    : [];

  return {
    type: readString(limit && limit.type),
    unit: readInt(limit && limit.unit),
    number: readInt(limit && limit.number),
    usage: readInt(limit && limit.usage),
    currentValue: readInt(limit && limit.currentValue),
    remaining: readInt(limit && limit.remaining),
    percentage: readFiniteNumber(limit && limit.percentage),
    nextResetAt: toIsoTimestamp(limit && limit.nextResetTime),
    usageJson: JSON.stringify(limit || {}),
    usageDetails: usageDetailsSource.map(normalizeUsageDetail),
  };
}

function normalizeQuotaPayload(payload, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Quota payload must be an object");
  }

  const data =
    payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? payload.data
      : {};
  const limitsSource = Array.isArray(data.limits) ? data.limits : [];
  const limits = limitsSource.map(normalizeLimit).filter((limit) => limit.type);
  const code = readInt(payload.code);
  const success = typeof payload.success === "boolean" ? payload.success : null;
  const statusParts = [];

  if (Number.isInteger(code)) {
    statusParts.push(String(code));
  }
  if (success !== null) {
    statusParts.push(success ? "success" : "failure");
  }

  return {
    syncId: readString(options.syncId) || randomUUID(),
    timestamp: Number.isInteger(options.timestamp)
      ? options.timestamp
      : Date.now(),
    source: readString(options.source) || DEFAULT_QUOTA_URL,
    status: statusParts.length > 0 ? statusParts.join("_") : "unknown",
    level: readString(data.level),
    limits,
  };
}

class QuotaSyncService {
  constructor(options = {}) {
    const quota = options.quota || {};

    this.enabled = quota.enabled === true;
    this.url = quota.url || DEFAULT_QUOTA_URL;
    this.cronExpression = quota.cron || DEFAULT_QUOTA_CRON;
    this.parsedCron = parseCronExpression(this.cronExpression);
    this.timeoutMs =
      Number.isInteger(quota.timeoutMs) && quota.timeoutMs > 0
        ? quota.timeoutMs
        : DEFAULT_QUOTA_TIMEOUT_MS;
    this.authToken = quota.authToken || "";
    this.acceptLanguage = quota.acceptLanguage || DEFAULT_ACCEPT_LANGUAGE;
    this.writer = options.writer || null;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.now = options.now || (() => new Date());
    this.setTimeoutImpl = options.setTimeoutImpl || setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;

    this.timer = null;
    this.runningPromise = null;
    this.currentAbortController = null;
    this.started = false;
    this.stopped = false;
  }

  start() {
    if (!this.enabled || !this.writer || this.started) {
      return;
    }

    this.started = true;
    this.stopped = false;
    console.log("[quota-sync] running startup sync");
    this.runningPromise = this.runScheduledSync();
  }

  async stop() {
    this.stopped = true;
    this.started = false;

    if (this.timer) {
      this.clearTimeoutImpl(this.timer);
      this.timer = null;
    }

    if (this.currentAbortController) {
      this.currentAbortController.abort();
    }

    if (this.runningPromise) {
      await this.runningPromise.catch(() => {});
    }
  }

  scheduleNext() {
    if (this.stopped) {
      return;
    }

    const nextRun = getNextCronOccurrence(this.parsedCron, this.now());
    const delayMs = Math.max(nextRun.getTime() - this.now().getTime(), 0);
    console.log(
      `[quota-sync] next run at ${nextRun.toISOString()} (${this.cronExpression})`,
    );

    this.timer = this.setTimeoutImpl(() => {
      this.timer = null;
      this.runningPromise = this.runScheduledSync();
    }, delayMs);
  }

  async runScheduledSync() {
    try {
      await this.syncNow();
    } catch (error) {
      console.error("[quota-sync] sync failed:", error);
    } finally {
      this.runningPromise = null;
      this.currentAbortController = null;
      if (!this.stopped) {
        this.scheduleNext();
      }
    }
  }

  async syncNow() {
    if (!this.enabled || !this.writer) {
      return { limits: 0, details: 0 };
    }

    if (!this.fetchImpl) {
      throw new Error("Global fetch is not available");
    }

    if (!this.authToken) {
      throw new Error(
        "Missing quota auth token. Set ZAI_QUOTA_SYNC_AUTH_TOKEN or ANTHROPIC_AUTH_TOKEN.",
      );
    }

    console.log(`[quota-sync] fetching ${this.url}`);
    this.currentAbortController = new AbortController();
    const timeoutId = this.setTimeoutImpl(() => {
      if (this.currentAbortController) {
        this.currentAbortController.abort();
      }
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.authToken}`,
          "accept-language": this.acceptLanguage,
          "content-type": "application/json",
          accept: "application/json",
        },
        signal: this.currentAbortController.signal,
      });

      if (!response.ok) {
        throw new Error(
          `Quota fetch failed: ${response.status} ${await response.text()}`,
        );
      }

      const payload = await response.json();
      const snapshot = normalizeQuotaPayload(payload, {
        syncId: randomUUID(),
        timestamp: this.now().getTime(),
        source: this.url,
      });

      await this.writer.writeQuotaSnapshot(snapshot);
      const details = snapshot.limits.reduce(
        (count, limit) => count + limit.usageDetails.length,
        0,
      );
      console.log(
        `[quota-sync] wrote ${snapshot.limits.length} limits and ${details} detail rows`,
      );

      return {
        limits: snapshot.limits.length,
        details,
      };
    } finally {
      this.clearTimeoutImpl(timeoutId);
    }
  }
}

module.exports = {
  DEFAULT_ACCEPT_LANGUAGE,
  DEFAULT_QUOTA_CRON,
  DEFAULT_QUOTA_TIMEOUT_MS,
  DEFAULT_QUOTA_URL,
  QuotaSyncService,
  normalizeQuotaPayload,
};
