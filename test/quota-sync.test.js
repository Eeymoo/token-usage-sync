"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { QuotaSyncService, normalizeQuotaPayload } = require("../src/quota-sync");

const SAMPLE_PAYLOAD = {
  code: 200,
  msg: "Operation successful",
  data: {
    limits: [
      {
        type: "TOKENS_LIMIT",
        unit: 3,
        number: 5,
        percentage: 1,
        nextResetTime: 1774960162388,
      },
      {
        type: "TIME_LIMIT",
        unit: 5,
        number: 1,
        usage: 4000,
        currentValue: 4,
        remaining: 3996,
        percentage: 1,
        nextResetTime: 1776406384997,
        usageDetails: [
          { modelCode: "search-prime", usage: 1 },
          { modelCode: "web-reader", usage: 3 },
          { modelCode: "zread", usage: 0 },
        ],
      },
    ],
    level: "max",
  },
  success: true,
};

test("normalizeQuotaPayload extracts limits and detail rows", () => {
  const normalized = normalizeQuotaPayload(SAMPLE_PAYLOAD, {
    syncId: "sync-1",
    timestamp: 1710000000000,
    source: "https://api.z.ai/api/monitor/usage/quota/limit",
  });

  assert.equal(normalized.syncId, "sync-1");
  assert.equal(normalized.status, "200_success");
  assert.equal(normalized.level, "max");
  assert.equal(normalized.limits.length, 2);
  assert.equal(normalized.limits[1].type, "TIME_LIMIT");
  assert.equal(normalized.limits[1].usageDetails.length, 3);
  assert.match(normalized.limits[1].nextResetAt, /T/);
});

test("QuotaSyncService fetches quota and writes snapshot", async () => {
  const calls = [];
  const snapshots = [];

  const service = new QuotaSyncService({
    quota: {
      enabled: true,
      authToken: "token-1",
      url: "https://api.z.ai/api/monitor/usage/quota/limit",
      timeoutMs: 1000,
      cron: "*/10 * * * *",
    },
    writer: {
      async writeQuotaSnapshot(snapshot) {
        snapshots.push(snapshot);
      },
    },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return {
        ok: true,
        async json() {
          return SAMPLE_PAYLOAD;
        },
      };
    },
    now: () => new Date(2026, 2, 31, 12, 0, 0),
  });

  const result = await service.syncNow();

  assert.deepEqual(result, { limits: 2, details: 3 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.headers.authorization, "Bearer token-1");
  assert.equal(calls[0].options.headers["accept-language"], "en-US,en");
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].limits[1].usageDetails[0].modelCode, "search-prime");
});

test("QuotaSyncService requires auth token when enabled", async () => {
  const service = new QuotaSyncService({
    quota: { enabled: true },
    writer: { writeQuotaSnapshot: async () => {} },
    fetchImpl: async () => {
      throw new Error("should not call fetch");
    },
  });

  await assert.rejects(
    async () => service.syncNow(),
    /Missing quota auth token/,
  );
});

test("QuotaSyncService start runs once and schedules next cron run", async () => {
  const timers = [];
  let syncCalls = 0;

  const service = new QuotaSyncService({
    quota: {
      enabled: true,
      authToken: "token-1",
      cron: "*/10 * * * *",
    },
    writer: { async writeQuotaSnapshot() {} },
    fetchImpl: async () => {
      syncCalls += 1;
      return {
        ok: true,
        async json() {
          return SAMPLE_PAYLOAD;
        },
      };
    },
    setTimeoutImpl(callback, delay) {
      timers.push({ callback, delay });
      return { callback, delay };
    },
    clearTimeoutImpl() {},
    now: () => new Date(2026, 2, 31, 12, 0, 0),
  });

  service.start();
  await service.runningPromise;

  assert.equal(syncCalls, 1);
  assert.equal(timers.some((timer) => timer.delay === 600000), true);
});
