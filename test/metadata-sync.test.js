"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MetadataSyncService,
  buildCsvTables,
  getNextCronOccurrence,
  parseQuestDbConfig,
} = require("../src/metadata-sync");

const SAMPLE_PAYLOAD = {
  vendor_b: {
    id: "vendor_b",
    name: "Vendor B",
    api: "https://vendor-b.example/v1",
    doc: "https://vendor-b.example/docs",
    iconURL: "https://vendor-b.example/icon.svg",
    models: {
      "model-b": {
        attachment: false,
        cost: { input: 0.2, output: 0.4 },
        description: "Model B",
        family: "family-b",
        id: "model-b",
        last_updated: "2025-03-01",
        limit: { context: 64000, output: 4000 },
        modalities: { input: ["text"], output: ["text"] },
        name: "Model B",
        open_weights: false,
        reasoning: true,
        release_date: "2025-01-15",
        temperature: true,
        tool_call: true,
      },
    },
  },
  vendor_a: {
    id: "vendor_a",
    name: "Vendor A",
    api: "https://vendor-a.example/v1",
    doc: "https://vendor-a.example/docs",
    iconURL: "https://vendor-a.example/icon.svg",
    models: {
      "model-a": {
        attachment: true,
        cost: { input: 1.5, output: 3.25 },
        description: "Model A",
        family: "family-a",
        id: "model-a",
        last_updated: "2025-02-10",
        limit: { context: 128000, output: 8192 },
        modalities: { input: ["text", "image"], output: ["text"] },
        name: "Model A",
        open_weights: true,
        reasoning: false,
        release_date: "2025-02-01",
        temperature: false,
        tool_call: true,
      },
    },
  },
};

const MULTILINE_PAYLOAD = {
  vendor_x: {
    id: "vendor_x",
    name: "Vendor X",
    models: {
      "model-x": {
        attachment: false,
        cost: { input: 0.1, output: 0.2 },
        description: "line one\n\nline two",
        family: "family-x",
        id: "model-x",
        last_updated: "2025-02-10",
        limit: { context: 1024, output: 256 },
        modalities: { input: ["text"], output: ["text"] },
        name: "Model X",
        open_weights: false,
        reasoning: false,
        release_date: "2025-02-01",
        temperature: true,
        tool_call: false,
      },
    },
  },
};

const INVALID_DATE_PAYLOAD = {
  vendor_y: {
    id: "vendor_y",
    name: "Vendor Y",
    models: {
      "model-y": {
        attachment: false,
        cost: { input: 0.1, output: 0.2 },
        description: "invalid date test",
        family: "family-y",
        id: "model-y",
        last_updated: "2025-25-11",
        limit: { context: 1024, output: 256 },
        modalities: { input: ["text"], output: ["text"] },
        name: "Model Y",
        open_weights: false,
        reasoning: false,
        release_date: "2025-02-31",
        temperature: true,
        tool_call: false,
      },
    },
  },
};

test("buildCsvTables normalizes vendors and models into deterministic CSV output", () => {
  const tables = buildCsvTables(SAMPLE_PAYLOAD);

  assert.equal(tables.vendors.rows.length, 2);
  assert.equal(tables.models.rows.length, 2);
  assert.deepEqual(tables.vendors.rows[0], {
    id: "vendor_a",
    name: "Vendor A",
    api: "https://vendor-a.example/v1",
    doc: "https://vendor-a.example/docs",
    iconURL: "https://vendor-a.example/icon.svg",
    modelCount: 1,
  });
  assert.equal(
    tables.models.rows[0].modalities_input,
    JSON.stringify(["text", "image"]),
  );
  assert.equal(
    tables.models.rows[0].last_updated,
    "2025-02-10T00:00:00.000000Z",
  );
  assert.equal(
    tables.models.rows[0].release_date,
    "2025-02-01T00:00:00.000000Z",
  );
  assert.match(
    tables.vendors.csv,
    /id,name,api,doc,iconURL,modelCount\nvendor_a,Vendor A,https:\/\/vendor-a\.example\/v1/
  );
  assert.match(
    tables.models.csv,
    /attachment,cost_input,cost_output,description,family,id,last_updated,limit_context/
  );
  assert.match(tables.models.csv, /""image""/);
});

test("buildCsvTables flattens multiline string fields so each model stays on one CSV row", () => {
  const tables = buildCsvTables(MULTILINE_PAYLOAD);

  assert.equal(tables.models.rows[0].description, "line one line two");
  assert.equal(tables.models.csv.split(/\n/).length, 2);
  assert.match(tables.models.csv, /line one line two/);
});

test("buildCsvTables drops invalid calendar dates instead of emitting broken timestamps", () => {
  const tables = buildCsvTables(INVALID_DATE_PAYLOAD);

  assert.equal(tables.models.rows[0].last_updated, null);
  assert.equal(tables.models.rows[0].release_date, null);
  assert.match(
    tables.models.csv,
    /false,0.1,0.2,invalid date test,family-y,model-y,,1024,256/
  );
});

test("parseQuestDbConfig extracts base URL and auth settings", () => {
  assert.deepEqual(parseQuestDbConfig("http::addr=127.0.0.1:9000"), {
    baseUrl: "http://127.0.0.1:9000",
    username: null,
    password: null,
    token: null,
  });

  assert.deepEqual(
    parseQuestDbConfig("https::addr=db.example:9000;username=alice;password=secret"),
    {
      baseUrl: "https://db.example:9000",
      username: "alice",
      password: "secret",
      token: null,
    },
  );
});

test("getNextCronOccurrence resolves the next matching local time", () => {
  const first = getNextCronOccurrence("0 3 * * *", new Date(2026, 2, 31, 2, 59, 10));
  assert.equal(first.getFullYear(), 2026);
  assert.equal(first.getMonth(), 2);
  assert.equal(first.getDate(), 31);
  assert.equal(first.getHours(), 3);
  assert.equal(first.getMinutes(), 0);

  const second = getNextCronOccurrence("0 3 * * *", new Date(2026, 2, 31, 3, 0, 0));
  assert.equal(second.getFullYear(), 2026);
  assert.equal(second.getMonth(), 3);
  assert.equal(second.getDate(), 1);
  assert.equal(second.getHours(), 3);
  assert.equal(second.getMinutes(), 0);
});

test("MetadataSyncService fetches metadata and overwrites both QuestDB tables", async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });

    if (calls.length === 1) {
      assert.equal(String(url), "https://metadata.example/all.json");
      assert.equal(options.headers.accept, "application/json");
      return {
        ok: true,
        async json() {
          return SAMPLE_PAYLOAD;
        },
      };
    }

    const requestUrl = new URL(String(url));
    assert.equal(requestUrl.pathname, "/imp");
    assert.equal(requestUrl.searchParams.get("overwrite"), "true");
    assert.equal(requestUrl.searchParams.get("forceHeader"), "true");
    assert.equal(requestUrl.searchParams.get("fmt"), "json");
    assert.equal(requestUrl.searchParams.get("atomicity"), "abort");
    assert.match(options.headers.authorization, /^Basic /);

    const schema = JSON.parse(options.body.get("schema"));
    const csv = await options.body.get("data").text();

    if (requestUrl.searchParams.get("name") === "token_usage_vendors") {
      assert.equal(schema[0].name, "id");
      assert.match(csv, /vendor_a,Vendor A/);
    } else {
      assert.equal(requestUrl.searchParams.get("name"), "token_usage_models");
      assert.equal(schema[0].name, "attachment");
      assert.match(csv, /model-a/);
      assert.match(csv, /2025-02-01T00:00:00.000000Z/);
    }

    return {
      ok: true,
      async text() {
        return requestUrl.searchParams.get("name") === "token_usage_vendors"
          ? '{"status":"OK","rowsImported":2,"rowsRejected":0}'
          : '{"status":"OK","rowsImported":2,"rowsRejected":0}';
      },
    };
  };

  const service = new MetadataSyncService({
    questdb: {
      configString: "http::addr=questdb.example:9000;username=alice;password=secret",
    },
    metadata: {
      enabled: true,
      url: "https://metadata.example/all.json",
      cron: "0 3 * * *",
      timeoutMs: 1000,
    },
    fetchImpl,
  });

  const result = await service.syncNow();

  assert.deepEqual(result, { vendors: 2, models: 2 });
  assert.equal(calls.length, 3);
});

test("MetadataSyncService skips work when disabled", async () => {
  let called = false;
  const service = new MetadataSyncService({
    questdb: { configString: "http::addr=questdb.example:9000" },
    metadata: { enabled: false },
    fetchImpl: async () => {
      called = true;
      throw new Error("should not be called");
    },
  });

  const result = await service.syncNow();
  assert.deepEqual(result, { vendors: 0, models: 0 });
  assert.equal(called, false);
});

test("MetadataSyncService start runs one sync immediately and then schedules the next run", async () => {
  const timers = [];
  let syncCalls = 0;

  const fetchImpl = async (url) => {
    syncCalls += 1;

    if (String(url) === "https://metadata.example/all.json") {
      return {
        ok: true,
        async json() {
          return SAMPLE_PAYLOAD;
        },
      };
    }

    return {
      ok: true,
      async text() {
        return '{"status":"OK","rowsImported":2,"rowsRejected":0}';
      },
    };
  };

  const service = new MetadataSyncService({
    questdb: {
      configString: "http::addr=questdb.example:9000",
    },
    metadata: {
      enabled: true,
      url: "https://metadata.example/all.json",
      cron: "0 3 * * *",
      timeoutMs: 1000,
    },
    fetchImpl,
    now: () => new Date(2026, 2, 31, 2, 0, 0),
    setTimeoutImpl(callback, delay) {
      timers.push({ callback, delay });
      return { callback, delay };
    },
    clearTimeoutImpl() {},
  });

  service.start();
  await service.runningPromise;

  assert.equal(syncCalls, 3);
  assert.equal(
    timers.some((timer) => timer.delay === 60 * 60 * 1000),
    true,
  );
});
