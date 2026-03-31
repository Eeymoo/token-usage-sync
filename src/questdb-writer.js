"use strict";

const { Sender } = require("@questdb/nodejs-client");

function addString(sender, column, value) {
  if (value !== undefined && value !== null && value !== "") {
    sender.stringColumn(column, String(value));
  }
}

function addInt(sender, column, value) {
  if (Number.isInteger(value)) {
    sender.intColumn(column, value);
  }
}

function addBool(sender, column, value) {
  if (typeof value === "boolean") {
    sender.booleanColumn(column, value);
  }
}

function addFloat(sender, column, value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof sender.floatColumn === "function") {
      sender.floatColumn(column, value);
      return;
    }

    if (Number.isInteger(value)) {
      sender.intColumn(column, value);
      return;
    }

    sender.stringColumn(column, String(value));
  }
}

class QuestDbWriter {
  constructor(config) {
    this.enabled = Boolean(config && config.enabled !== false);
    this.configString = config && config.configString;
    this.senderPromise = null;
    this.pending = Promise.resolve();
    this.closed = false;
  }

  async getSender() {
    if (!this.enabled) {
      return null;
    }

    if (!this.senderPromise) {
      this.senderPromise = Sender.fromConfig(this.configString);
    }
    return this.senderPromise;
  }

  write(logRecord) {
    if (!this.enabled) {
      return Promise.resolve();
    }

    this.pending = this.pending
      .then(async () => {
        let sender = await this.getSender();
        if (!sender) {
          return;
        }

        try {
          await this.writeStatsRow(sender, logRecord);
          await this.writeRecordRow(sender, logRecord);
          await sender.flush();
        } catch (error) {
          sender.reset();
          throw error;
        }
      })
      .catch((error) => {
        console.error("QuestDB write failed:", error);
      });

    return this.pending;
  }

  writeQuotaSnapshot(snapshot) {
    if (!this.enabled) {
      return Promise.resolve();
    }

    this.pending = this.pending
      .then(async () => {
        let sender = await this.getSender();
        if (!sender) {
          return;
        }

        try {
          await this.writeQuotaRows(sender, snapshot);
          await sender.flush();
        } catch (error) {
          sender.reset();
          throw error;
        }
      })
      .catch((error) => {
        console.error("QuestDB quota write failed:", error);
      });

    return this.pending;
  }

  async writeStatsRow(sender, record) {
    sender.table("token_usage_requests_stats");
    this.writeCommonColumns(sender, record);
    await sender.at(record.timestamp, "ms");
  }

  async writeRecordRow(sender, record) {
    sender.table("token_usage_requests_records");
    this.writeCommonColumns(sender, record);
    addString(sender, "input_content", record.inputContent);
    addString(sender, "output_content", record.outputContent);
    addString(sender, "error_msg", record.errorMessage);
    await sender.at(record.timestamp, "ms");
  }

  writeCommonColumns(sender, record) {
    addString(sender, "request_id", record.requestId);
    addString(sender, "provider", record.provider);
    addString(sender, "category", record.category);
    addBool(sender, "is_stream", record.isStream);
    addString(sender, "api_kind", record.apiKind);
    addString(sender, "model_id", record.modelId);
    addString(sender, "user_id", record.userId);
    addInt(sender, "input_tokens", record.inputTokens);
    addInt(sender, "output_tokens", record.outputTokens);
    addInt(sender, "cached_tokens", record.cachedTokens);
    addInt(sender, "input_chars", record.inputChars);
    addInt(sender, "output_chars", record.outputChars);
    addString(sender, "status", record.status);
    addInt(sender, "latency_ms", record.latencyMs);
    addInt(sender, "ttft_ms", record.ttftMs);
    addString(sender, "session_id", record.sessionId);
    addString(sender, "request_tag", record.requestTag);
    addString(sender, "api_key_hash", record.apiKeyHash);
    addString(sender, "usage_json", record.usageJson);
  }

  async writeQuotaRows(sender, snapshot) {
    const limits = Array.isArray(snapshot.limits) ? snapshot.limits : [];
    const timestamp = Number.isInteger(snapshot.timestamp)
      ? snapshot.timestamp
      : Date.now();

    for (const limit of limits) {
      sender.table("token_usage_quota_limits");
      addString(sender, "sync_id", snapshot.syncId);
      addString(sender, "source", snapshot.source);
      addString(sender, "status", snapshot.status);
      addString(sender, "level", snapshot.level);
      addString(sender, "limit_type", limit.type);
      addInt(sender, "unit", limit.unit);
      addInt(sender, "limit_number", limit.number);
      addInt(sender, "usage", limit.usage);
      addInt(sender, "current_value", limit.currentValue);
      addInt(sender, "remaining", limit.remaining);
      addFloat(sender, "percentage", limit.percentage);
      addString(sender, "next_reset_at", limit.nextResetAt);
      addString(sender, "usage_json", limit.usageJson);
      await sender.at(timestamp, "ms");

      const details = Array.isArray(limit.usageDetails) ? limit.usageDetails : [];
      for (const detail of details) {
        sender.table("token_usage_quota_usage_details");
        addString(sender, "sync_id", snapshot.syncId);
        addString(sender, "source", snapshot.source);
        addString(sender, "limit_type", limit.type);
        addString(sender, "model_code", detail.modelCode);
        addInt(sender, "usage", detail.usage);
        await sender.at(timestamp, "ms");
      }
    }
  }

  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.pending.catch(() => {});
    const sender = await this.senderPromise;
    if (sender) {
      await sender.close();
    }
  }
}

module.exports = {
  QuestDbWriter,
};
