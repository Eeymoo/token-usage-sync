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
    sender.boolColumn(column, value);
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
        const sender = await this.getSender();
        if (!sender) {
          return;
        }

        await this.writeStatsRow(sender, logRecord);
        await this.writeRecordRow(sender, logRecord);
        await sender.flush();
      })
      .catch((error) => {
        console.error("QuestDB write failed:", error);
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
