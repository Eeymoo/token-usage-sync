"use strict";

function readInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function readBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }

  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  return fallback;
}

function appendQuestDbAuth(parts, name, key) {
  const value = process.env[name];
  if (value) {
    parts.push(`${key}=${value}`);
  }
}

function buildQuestDbConfig() {
  if (process.env.QUESTDB_CONFIG) {
    return process.env.QUESTDB_CONFIG;
  }

  const parts = [`http::addr=${process.env.QUESTDB_ADDR || "127.0.0.1:9000"}`];
  appendQuestDbAuth(parts, "QUESTDB_USERNAME", "username");
  appendQuestDbAuth(parts, "QUESTDB_PASSWORD", "password");
  appendQuestDbAuth(parts, "QUESTDB_TOKEN", "token");
  return parts.join(";");
}

function getConfig() {
  return {
    port: readInt("PORT", 8787),
    requestCaptureLimitBytes: readInt("REQUEST_CAPTURE_LIMIT_BYTES", 1024 * 1024),
    responseCaptureLimitBytes: readInt("RESPONSE_CAPTURE_LIMIT_BYTES", 2 * 1024 * 1024),
    contentLimitChars: readInt("CONTENT_LIMIT_CHARS", 20000),
    questdb: {
      configString: buildQuestDbConfig(),
      enabled: process.env.QUESTDB_ENABLED !== "false",
    },
    routes: {
      openaiPrefix: process.env.OPENAI_PROXY_PREFIX || "/openai",
      anthropicPrefix: process.env.ANTHROPIC_PROXY_PREFIX || "/anthropic",
      geminiPrefix: process.env.GEMINI_PROXY_PREFIX || "/gemini",
    },
    upstreams: {
      openai: process.env.OPENAI_BASE_URL || "https://api.openai.com",
      anthropic: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
      gemini:
        process.env.GEMINI_BASE_URL ||
        "https://generativelanguage.googleapis.com",
    },
    metadata: {
      enabled: readBool("LLM_METADATA_SYNC_ENABLED", true),
      url:
        process.env.LLM_METADATA_SYNC_URL ||
        "https://basellm.github.io/llm-metadata/api/all.json",
      cron: process.env.LLM_METADATA_SYNC_CRON || "0 3 * * *",
      timeoutMs: readInt("LLM_METADATA_SYNC_TIMEOUT_MS", 120000),
    },
    quota: {
      enabled: readBool("ZAI_QUOTA_SYNC_ENABLED", false),
      url:
        process.env.ZAI_QUOTA_SYNC_URL ||
        "https://api.z.ai/api/monitor/usage/quota/limit",
      cron: process.env.ZAI_QUOTA_SYNC_CRON || "*/10 * * * *",
      timeoutMs: readInt("ZAI_QUOTA_SYNC_TIMEOUT_MS", 30000),
      authToken:
        process.env.ZAI_QUOTA_SYNC_AUTH_TOKEN ||
        process.env.ANTHROPIC_AUTH_TOKEN ||
        "",
      acceptLanguage: process.env.ZAI_QUOTA_SYNC_ACCEPT_LANGUAGE || "en-US,en",
    },
  };
}

module.exports = {
  getConfig,
};
