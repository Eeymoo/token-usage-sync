"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const configPath = require.resolve("../src/config");

function loadConfigWithEnv(env) {
  const saved = {};
  const keys = [
    "PORT",
    "REQUEST_CAPTURE_LIMIT_BYTES",
    "RESPONSE_CAPTURE_LIMIT_BYTES",
    "CONTENT_LIMIT_CHARS",
    "QUESTDB_CONFIG",
    "QUESTDB_ADDR",
    "QUESTDB_USERNAME",
    "QUESTDB_PASSWORD",
    "QUESTDB_TOKEN",
    "QUESTDB_ENABLED",
    "OPENAI_PROXY_PREFIX",
    "ANTHROPIC_PROXY_PREFIX",
    "GEMINI_PROXY_PREFIX",
    "OPENAI_BASE_URL",
    "ANTHROPIC_BASE_URL",
    "GEMINI_BASE_URL",
    "LLM_METADATA_SYNC_ENABLED",
    "LLM_METADATA_SYNC_URL",
    "LLM_METADATA_SYNC_CRON",
    "LLM_METADATA_SYNC_TIMEOUT_MS",
    "ZAI_QUOTA_SYNC_ENABLED",
    "ZAI_QUOTA_SYNC_URL",
    "ZAI_QUOTA_SYNC_CRON",
    "ZAI_QUOTA_SYNC_TIMEOUT_MS",
    "ZAI_QUOTA_SYNC_AUTH_TOKEN",
    "ZAI_QUOTA_SYNC_ACCEPT_LANGUAGE",
    "ANTHROPIC_AUTH_TOKEN",
  ];

  for (const key of keys) {
    saved[key] = process.env[key];
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      process.env[key] = env[key];
    } else {
      delete process.env[key];
    }
  }

  delete require.cache[configPath];
  const { getConfig } = require("../src/config");
  const config = getConfig();

  delete require.cache[configPath];
  for (const key of keys) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }

  return config;
}

test("getConfig returns defaults", () => {
  const config = loadConfigWithEnv({});

  assert.equal(config.port, 8787);
  assert.equal(config.requestCaptureLimitBytes, 1024 * 1024);
  assert.equal(config.responseCaptureLimitBytes, 2 * 1024 * 1024);
  assert.equal(config.contentLimitChars, 20000);
  assert.equal(config.questdb.enabled, true);
  assert.equal(config.questdb.configString, "http::addr=127.0.0.1:9000");
  assert.equal(config.routes.openaiPrefix, "/openai");
  assert.equal(config.routes.anthropicPrefix, "/anthropic");
  assert.equal(config.routes.geminiPrefix, "/gemini");
  assert.equal(config.upstreams.openai, "https://api.openai.com");
  assert.equal(config.upstreams.anthropic, "https://api.anthropic.com");
  assert.equal(config.upstreams.gemini, "https://generativelanguage.googleapis.com");
  assert.equal(config.metadata.enabled, true);
  assert.equal(
    config.metadata.url,
    "https://basellm.github.io/llm-metadata/api/all.json"
  );
  assert.equal(config.metadata.cron, "0 3 * * *");
  assert.equal(config.metadata.timeoutMs, 120000);
  assert.equal(config.quota.enabled, false);
  assert.equal(config.quota.url, "https://api.z.ai/api/monitor/usage/quota/limit");
  assert.equal(config.quota.cron, "*/10 * * * *");
  assert.equal(config.quota.timeoutMs, 30000);
  assert.equal(config.quota.authToken, "");
  assert.equal(config.quota.acceptLanguage, "en-US,en");
});

test("getConfig respects explicit env vars and auth config fragments", () => {
  const config = loadConfigWithEnv({
    PORT: "9999",
    REQUEST_CAPTURE_LIMIT_BYTES: "10",
    RESPONSE_CAPTURE_LIMIT_BYTES: "20",
    CONTENT_LIMIT_CHARS: "30",
    QUESTDB_ADDR: "192.168.2.252:9000",
    QUESTDB_USERNAME: "alice",
    QUESTDB_PASSWORD: "secret",
    QUESTDB_TOKEN: "token-1",
    QUESTDB_ENABLED: "false",
    OPENAI_PROXY_PREFIX: "/oa",
    ANTHROPIC_PROXY_PREFIX: "/an",
    GEMINI_PROXY_PREFIX: "/ge",
    OPENAI_BASE_URL: "https://openai.example",
    ANTHROPIC_BASE_URL: "https://anthropic.example",
    GEMINI_BASE_URL: "https://gemini.example",
    LLM_METADATA_SYNC_ENABLED: "false",
    LLM_METADATA_SYNC_URL: "https://metadata.example/all.json",
    LLM_METADATA_SYNC_CRON: "15 4 * * *",
    LLM_METADATA_SYNC_TIMEOUT_MS: "45000",
    ZAI_QUOTA_SYNC_ENABLED: "true",
    ZAI_QUOTA_SYNC_URL: "https://quota.example/limit",
    ZAI_QUOTA_SYNC_CRON: "5 * * * *",
    ZAI_QUOTA_SYNC_TIMEOUT_MS: "20000",
    ZAI_QUOTA_SYNC_AUTH_TOKEN: "quota-token",
    ZAI_QUOTA_SYNC_ACCEPT_LANGUAGE: "zh-CN,zh",
  });

  assert.equal(config.port, 9999);
  assert.equal(config.requestCaptureLimitBytes, 10);
  assert.equal(config.responseCaptureLimitBytes, 20);
  assert.equal(config.contentLimitChars, 30);
  assert.equal(config.questdb.enabled, false);
  assert.equal(
    config.questdb.configString,
    "http::addr=192.168.2.252:9000;username=alice;password=secret;token=token-1"
  );
  assert.equal(config.routes.openaiPrefix, "/oa");
  assert.equal(config.routes.anthropicPrefix, "/an");
  assert.equal(config.routes.geminiPrefix, "/ge");
  assert.equal(config.upstreams.openai, "https://openai.example");
  assert.equal(config.upstreams.anthropic, "https://anthropic.example");
  assert.equal(config.upstreams.gemini, "https://gemini.example");
  assert.equal(config.metadata.enabled, false);
  assert.equal(config.metadata.url, "https://metadata.example/all.json");
  assert.equal(config.metadata.cron, "15 4 * * *");
  assert.equal(config.metadata.timeoutMs, 45000);
  assert.equal(config.quota.enabled, true);
  assert.equal(config.quota.url, "https://quota.example/limit");
  assert.equal(config.quota.cron, "5 * * * *");
  assert.equal(config.quota.timeoutMs, 20000);
  assert.equal(config.quota.authToken, "quota-token");
  assert.equal(config.quota.acceptLanguage, "zh-CN,zh");
});

test("getConfig uses QUESTDB_CONFIG and falls back on invalid integers", () => {
  const config = loadConfigWithEnv({
    PORT: "abc",
    REQUEST_CAPTURE_LIMIT_BYTES: "",
    RESPONSE_CAPTURE_LIMIT_BYTES: "NaN",
    CONTENT_LIMIT_CHARS: "oops",
    QUESTDB_CONFIG: "http::addr=custom:9000;token=abc",
  });

  assert.equal(config.port, 8787);
  assert.equal(config.requestCaptureLimitBytes, 1024 * 1024);
  assert.equal(config.responseCaptureLimitBytes, 2 * 1024 * 1024);
  assert.equal(config.contentLimitChars, 20000);
  assert.equal(config.questdb.configString, "http::addr=custom:9000;token=abc");
  assert.equal(config.metadata.timeoutMs, 120000);
  assert.equal(config.quota.cron, "*/10 * * * *");
});

test("getConfig falls back to ANTHROPIC_AUTH_TOKEN for quota auth token", () => {
  const config = loadConfigWithEnv({
    ANTHROPIC_AUTH_TOKEN: "anthropic-token",
  });

  assert.equal(config.quota.authToken, "anthropic-token");
});
