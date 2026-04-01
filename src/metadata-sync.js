"use strict";

const DEFAULT_METADATA_URL = "https://basellm.github.io/llm-metadata/api/all.json";
const DEFAULT_METADATA_CRON = "0 3 * * *";
const DEFAULT_SYNC_TIMEOUT_MS = 120000;

const VENDORS_COLUMNS = [
  "id",
  "name",
  "api",
  "doc",
  "iconURL",
  "modelCount",
];

const MODELS_COLUMNS = [
  "attachment",
  "cost_input",
  "cost_output",
  "description",
  "family",
  "id",
  "last_updated",
  "limit_context",
  "limit_output",
  "modalities_input",
  "modalities_output",
  "name",
  "open_weights",
  "reasoning",
  "release_date",
  "temperature",
  "tool_call",
];

const VENDORS_SCHEMA = [
  { name: "id", type: "STRING" },
  { name: "name", type: "STRING" },
  { name: "api", type: "STRING" },
  { name: "doc", type: "STRING" },
  { name: "iconURL", type: "STRING" },
  { name: "modelCount", type: "INT" },
];

const MODELS_SCHEMA = [
  { name: "attachment", type: "BOOLEAN" },
  { name: "cost_input", type: "DOUBLE" },
  { name: "cost_output", type: "DOUBLE" },
  { name: "description", type: "STRING" },
  { name: "family", type: "STRING" },
  { name: "id", type: "STRING" },
  {
    name: "last_updated",
    type: "TIMESTAMP",
    pattern: "yyyy-MM-ddTHH:mm:ss.SSSUUUZ",
  },
  { name: "limit_context", type: "INT" },
  { name: "limit_output", type: "INT" },
  { name: "modalities_input", type: "STRING" },
  { name: "modalities_output", type: "STRING" },
  { name: "name", type: "STRING" },
  { name: "open_weights", type: "BOOLEAN" },
  { name: "reasoning", type: "BOOLEAN" },
  {
    name: "release_date",
    type: "TIMESTAMP",
    pattern: "yyyy-MM-ddTHH:mm:ss.SSSUUUZ",
  },
  { name: "temperature", type: "BOOLEAN" },
  { name: "tool_call", type: "BOOLEAN" },
];

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

function readBool(value) {
  return typeof value === "boolean" ? value : null;
}

function readString(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

function readStringList(value) {
  return Array.isArray(value) && value.length > 0 ? JSON.stringify(value) : null;
}

function readDateOnly(value) {
  if (typeof value !== "string") {
    return null;
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function formatQuestTimestamp(value) {
  const date = readDateOnly(value);
  if (!date) {
    return null;
  }

  return `${date}T00:00:00.000000Z`;
}

function normalizeVendor(vendorId, vendor) {
  const models = vendor && typeof vendor.models === "object" ? vendor.models : {};
  return {
    id: readString(vendor && vendor.id) || vendorId,
    name: readString(vendor && vendor.name),
    api: readString(vendor && vendor.api),
    doc: readString(vendor && vendor.doc),
    iconURL: readString(vendor && vendor.iconURL),
    modelCount: Object.keys(models).length,
  };
}

function normalizeModel(model) {
  return {
    attachment: readBool(model && model.attachment),
    cost_input: readFiniteNumber(model && model.cost && model.cost.input),
    cost_output: readFiniteNumber(model && model.cost && model.cost.output),
    description: readString(model && model.description),
    family: readString(model && model.family),
    id: readString(model && model.id),
    last_updated: formatQuestTimestamp(model && model.last_updated),
    limit_context: readInt(model && model.limit && model.limit.context),
    limit_output: readInt(model && model.limit && model.limit.output),
    modalities_input: readStringList(
      model && model.modalities && model.modalities.input,
    ),
    modalities_output: readStringList(
      model && model.modalities && model.modalities.output,
    ),
    name: readString(model && model.name),
    open_weights: readBool(model && model.open_weights),
    reasoning: readBool(model && model.reasoning),
    release_date: formatQuestTimestamp(model && model.release_date),
    temperature: readBool(model && model.temperature),
    tool_call: readBool(model && model.tool_call),
  };
}

function normalizeMetadataPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Metadata payload must be an object keyed by vendor id");
  }

  const vendorEntries = Object.entries(payload).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  const vendors = vendorEntries.map(([vendorId, vendor]) =>
    normalizeVendor(vendorId, vendor),
  );
  const models = [];

  for (const [, vendor] of vendorEntries) {
    const sourceModels =
      vendor && vendor.models && typeof vendor.models === "object"
        ? vendor.models
        : {};
    const modelEntries = Object.entries(sourceModels).sort(([left], [right]) =>
      left.localeCompare(right),
    );

    for (const [, model] of modelEntries) {
      models.push(normalizeModel(model));
    }
  }

  return { vendors, models };
}

function escapeCsvCell(value) {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

function toCsv(rows, columns) {
  const header = columns.join(",");
  const lines = rows.map((row) =>
    columns.map((column) => escapeCsvCell(row[column])).join(","),
  );
  return [header, ...lines].join("\n");
}

function buildCsvTables(payload) {
  const normalized = normalizeMetadataPayload(payload);
  return {
    vendors: {
      rows: normalized.vendors,
      csv: toCsv(normalized.vendors, VENDORS_COLUMNS),
      schema: VENDORS_SCHEMA,
    },
    models: {
      rows: normalized.models,
      csv: toCsv(normalized.models, MODELS_COLUMNS),
      schema: MODELS_SCHEMA,
    },
  };
}

function parseQuestDbConfig(configString) {
  if (!configString) {
    throw new Error("Missing QuestDB config string");
  }

  const config = {};
  for (const part of configString.split(";")) {
    if (!part) {
      continue;
    }
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }
    const rawKey = part.slice(0, separatorIndex);
    const key = rawKey.replace(/^[^:]+::/, "");
    config[key] = part.slice(separatorIndex + 1);
  }

  const protocolMatch = configString.match(/^(https?)::/);
  const protocol = protocolMatch ? protocolMatch[1] : "http";
  const addr = config.addr;
  if (!addr) {
    throw new Error("QuestDB config string is missing addr=...");
  }

  return {
    baseUrl: `${protocol}://${addr}`,
    username: config.username || null,
    password: config.password || null,
    token: config.token || null,
  };
}

function buildQuestDbHeaders(connection) {
  const headers = {
    accept: "application/json",
  };

  if (connection.token) {
    headers.authorization = `Bearer ${connection.token}`;
  } else if (connection.username || connection.password) {
    const credentials = Buffer.from(
      `${connection.username || ""}:${connection.password || ""}`,
    ).toString("base64");
    headers.authorization = `Basic ${credentials}`;
  }

  return headers;
}

async function importCsvTable({
  fetchImpl,
  connection,
  tableName,
  csv,
  schema,
  expectedRows,
  signal,
}) {
  const url = new URL("/imp", connection.baseUrl);
  url.searchParams.set("name", tableName);
  url.searchParams.set("overwrite", "true");
  url.searchParams.set("forceHeader", "true");
  url.searchParams.set("fmt", "json");
  url.searchParams.set("atomicity", "abort");

  console.log(
    `[metadata-sync] submitting ${tableName}: rows=${expectedRows}, bytes=${Buffer.byteLength(csv)}`,
  );

  const form = new FormData();
  form.set("schema", JSON.stringify(schema));
  form.set("data", new Blob([csv], { type: "text/csv" }), `${tableName}.csv`);

  const response = await fetchImpl(url, {
    method: "POST",
    headers: buildQuestDbHeaders(connection),
    body: form,
    signal,
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(
      `QuestDB import failed for ${tableName}: ${response.status} ${responseText}`,
    );
  }

  let responseBody = null;
  try {
    responseBody = JSON.parse(responseText);
  } catch {
    responseBody = null;
  }

  const status =
    responseBody && typeof responseBody.status === "string"
      ? responseBody.status
      : null;
  const rowsImported =
    responseBody && Number.isFinite(responseBody.rowsImported)
      ? responseBody.rowsImported
      : null;
  const rowsRejected =
    responseBody && Number.isFinite(responseBody.rowsRejected)
      ? responseBody.rowsRejected
      : null;

  console.log(
    `[metadata-sync] QuestDB import ${tableName}: ${responseText}`,
  );

  if (status && status.toUpperCase() !== "OK") {
    throw new Error(
      `QuestDB import reported non-OK status for ${tableName}: ${responseText}`,
    );
  }

  if (typeof rowsRejected === "number" && rowsRejected > 0) {
    throw new Error(
      `QuestDB import rejected ${rowsRejected} rows for ${tableName}: ${responseText}`,
    );
  }

  if (
    typeof expectedRows === "number" &&
    typeof rowsImported === "number" &&
    rowsImported !== expectedRows
  ) {
    throw new Error(
      `QuestDB import row count mismatch for ${tableName}: expected ${expectedRows}, got ${rowsImported}; response=${responseText}`,
    );
  }

  return {
    status,
    rowsImported,
    rowsRejected,
    raw: responseText,
  };
}

function parseCronNumber(value, aliases) {
  const normalized = value.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(aliases, normalized)) {
    return aliases[normalized];
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function expandCronPart(part, min, max, aliases) {
  const stepMatch = part.split("/");
  if (stepMatch.length > 2) {
    throw new Error(`Invalid cron step segment: ${part}`);
  }

  const base = stepMatch[0];
  const step = stepMatch.length === 2 ? Number.parseInt(stepMatch[1], 10) : 1;
  if (!Number.isInteger(step) || step <= 0) {
    throw new Error(`Invalid cron step value: ${part}`);
  }

  let rangeStart = min;
  let rangeEnd = max;

  if (base !== "*") {
    const bounds = base.split("-");
    if (bounds.length > 2) {
      throw new Error(`Invalid cron range: ${part}`);
    }

    const start = parseCronNumber(bounds[0], aliases);
    const end = bounds.length === 2 ? parseCronNumber(bounds[1], aliases) : start;
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new Error(`Invalid cron number: ${part}`);
    }

    rangeStart = start;
    rangeEnd = end;
  }

  if (rangeStart < min || rangeEnd > max || rangeStart > rangeEnd) {
    throw new Error(`Cron segment out of range: ${part}`);
  }

  const values = [];
  for (let value = rangeStart; value <= rangeEnd; value += step) {
    values.push(value);
  }
  return values;
}

function parseCronField(field, min, max, aliases = {}) {
  if (!field) {
    throw new Error("Missing cron field");
  }

  const values = new Set();
  const isWildcard = field === "*";

  for (const part of field.split(",")) {
    for (const value of expandCronPart(part, min, max, aliases)) {
      values.add(value);
    }
  }

  return {
    isWildcard,
    values,
  };
}

function parseCronExpression(expression) {
  const parts = String(expression || "")
    .trim()
    .split(/\s+/);

  if (parts.length !== 5) {
    throw new Error(`Cron expression must have 5 fields: ${expression}`);
  }

  return {
    minute: parseCronField(parts[0], 0, 59),
    hour: parseCronField(parts[1], 0, 23),
    dayOfMonth: parseCronField(parts[2], 1, 31),
    month: parseCronField(parts[3], 1, 12, {
      JAN: 1,
      FEB: 2,
      MAR: 3,
      APR: 4,
      MAY: 5,
      JUN: 6,
      JUL: 7,
      AUG: 8,
      SEP: 9,
      OCT: 10,
      NOV: 11,
      DEC: 12,
    }),
    dayOfWeek: parseCronField(parts[4], 0, 7, {
      SUN: 0,
      MON: 1,
      TUE: 2,
      WED: 3,
      THU: 4,
      FRI: 5,
      SAT: 6,
    }),
  };
}

function cronMatches(parsed, candidate) {
  const dayOfWeek = candidate.getDay();
  const normalizedDayOfWeekValues = new Set(
    Array.from(parsed.dayOfWeek.values, (value) => (value === 7 ? 0 : value)),
  );
  const matchesDayOfMonth = parsed.dayOfMonth.values.has(candidate.getDate());
  const matchesDayOfWeek = normalizedDayOfWeekValues.has(dayOfWeek);

  const dayMatches =
    parsed.dayOfMonth.isWildcard && parsed.dayOfWeek.isWildcard
      ? true
      : parsed.dayOfMonth.isWildcard
        ? matchesDayOfWeek
        : parsed.dayOfWeek.isWildcard
          ? matchesDayOfMonth
          : matchesDayOfMonth || matchesDayOfWeek;

  return (
    parsed.minute.values.has(candidate.getMinutes()) &&
    parsed.hour.values.has(candidate.getHours()) &&
    parsed.month.values.has(candidate.getMonth() + 1) &&
    dayMatches
  );
}

function getNextCronOccurrence(expression, afterDate) {
  const parsed =
    typeof expression === "string" ? parseCronExpression(expression) : expression;
  const candidate = new Date(afterDate.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxIterations = 60 * 24 * 366 * 8;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    if (cronMatches(parsed, candidate)) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error("Could not resolve next cron occurrence");
}

class MetadataSyncService {
  constructor(options = {}) {
    const metadata = options.metadata || {};

    this.enabled = metadata.enabled !== false;
    this.url = metadata.url || DEFAULT_METADATA_URL;
    this.timeoutMs =
      Number.isInteger(metadata.timeoutMs) && metadata.timeoutMs > 0
        ? metadata.timeoutMs
        : DEFAULT_SYNC_TIMEOUT_MS;
    this.cronExpression = metadata.cron || DEFAULT_METADATA_CRON;
    this.parsedCron = parseCronExpression(this.cronExpression);
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.now = options.now || (() => new Date());
    this.setTimeoutImpl = options.setTimeoutImpl || setTimeout;
    this.clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;
    this.connection =
      this.enabled && options.questdb && options.questdb.configString
        ? parseQuestDbConfig(options.questdb.configString)
        : null;

    this.timer = null;
    this.runningPromise = null;
    this.currentAbortController = null;
    this.started = false;
    this.stopped = false;
  }

  start() {
    if (!this.enabled || !this.connection || this.started) {
      return;
    }

    this.started = true;
    this.stopped = false;
    console.log("[metadata-sync] running startup sync");
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
      `[metadata-sync] next run at ${nextRun.toISOString()} (${this.cronExpression})`,
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
      console.error("[metadata-sync] sync failed:", error);
    } finally {
      this.runningPromise = null;
      this.currentAbortController = null;
      if (!this.stopped) {
        this.scheduleNext();
      }
    }
  }

  async syncNow() {
    if (!this.enabled || !this.connection) {
      return { vendors: 0, models: 0 };
    }

    if (!this.fetchImpl) {
      throw new Error("Global fetch is not available");
    }

    console.log(`[metadata-sync] fetching ${this.url}`);
    this.currentAbortController = new AbortController();
    const timeoutId = this.setTimeoutImpl(() => {
      if (this.currentAbortController) {
        this.currentAbortController.abort();
      }
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.url, {
        headers: { accept: "application/json" },
        signal: this.currentAbortController.signal,
      });
      if (!response.ok) {
        throw new Error(
          `Metadata fetch failed: ${response.status} ${await response.text()}`,
        );
      }

      const payload = await response.json();
      const tables = buildCsvTables(payload);
      console.log(
        `[metadata-sync] data ready: vendors=${tables.vendors.rows.length}, models=${tables.models.rows.length}`,
      );

      const vendorsImport = await importCsvTable({
        fetchImpl: this.fetchImpl,
        connection: this.connection,
        tableName: "token_usage_vendors",
        csv: tables.vendors.csv,
        schema: tables.vendors.schema,
        expectedRows: tables.vendors.rows.length,
        signal: this.currentAbortController.signal,
      });

      const modelsImport = await importCsvTable({
        fetchImpl: this.fetchImpl,
        connection: this.connection,
        tableName: "token_usage_models",
        csv: tables.models.csv,
        schema: tables.models.schema,
        expectedRows: tables.models.rows.length,
        signal: this.currentAbortController.signal,
      });

      const result = {
        vendors: tables.vendors.rows.length,
        models: tables.models.rows.length,
      };
      console.log(
        `[metadata-sync] imported vendors=${result.vendors} (questdb=${vendorsImport.rowsImported ?? "unknown"}) models=${result.models} (questdb=${modelsImport.rowsImported ?? "unknown"})`,
      );
      return result;
    } finally {
      this.clearTimeoutImpl(timeoutId);
    }
  }
}

module.exports = {
  DEFAULT_METADATA_CRON,
  DEFAULT_METADATA_URL,
  MetadataSyncService,
  MODELS_COLUMNS,
  MODELS_SCHEMA,
  VENDORS_COLUMNS,
  VENDORS_SCHEMA,
  buildCsvTables,
  getNextCronOccurrence,
  normalizeMetadataPayload,
  parseCronExpression,
  parseQuestDbConfig,
};
