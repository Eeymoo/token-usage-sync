"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const Module = require("node:module");

const originalLoad = Module._load;
const writes = [];
const freeEncodersCalls = [];

class FakeQuestDbWriter {
  constructor(config) {
    this.config = config;
  }

  write(record) {
    writes.push(record);
    return Promise.resolve();
  }

  close() {
    return Promise.resolve();
  }
}

Module._load = function mockServerDeps(request, parent, isMain) {
  if (request === "./config" || request.endsWith("/src/config")) {
    return {
      getConfig() {
        return {
          port: 0,
          requestCaptureLimitBytes: 1024 * 1024,
          responseCaptureLimitBytes: 1024 * 1024,
          contentLimitChars: 2000,
          questdb: {
            enabled: true,
            configString: "http::addr=test",
          },
          routes: {
            openaiPrefix: "/openai",
            anthropicPrefix: "/anthropic",
            geminiPrefix: "/gemini",
          },
          upstreams: {
            openai: "http://127.0.0.1:1",
            anthropic: "http://127.0.0.1:1",
            gemini: "http://127.0.0.1:1",
          },
        };
      },
    };
  }

  if (request === "./questdb-writer" || request.endsWith("/src/questdb-writer")) {
    return {
      QuestDbWriter: FakeQuestDbWriter,
    };
  }

  if (request === "./tokenizer" || request.endsWith("/src/tokenizer")) {
    const actual = originalLoad(request, parent, isMain);
    return {
      ...actual,
      freeEncoders() {
        freeEncodersCalls.push(true);
      },
    };
  }

  return originalLoad(request, parent, isMain);
};

const { createApp } = require("../src/server");
const { hashApiKey } = require("../src/api-key");
Module._load = originalLoad;

async function startApp() {
  writes.length = 0;
  const app = createApp();
  await app.start();
  const port = app.server.address().port;
  return { app, port };
}

function httpRequest(port, path, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: options.method || "GET",
        headers: options.headers || {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

test("server handles health, hash-api-key, and missing route locally", async () => {
  const { app, port } = await startApp();

  try {
    const health = await httpRequest(port, "/healthz");
    assert.equal(health.statusCode, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true });

    const hashed = await httpRequest(port, "/hash-api-key?value=sk-test-123");
    assert.equal(hashed.statusCode, 200);
    assert.deepEqual(JSON.parse(hashed.body), {
      api_key_hash: hashApiKey("sk-test-123"),
    });

    const missingValue = await httpRequest(port, "/hash-api-key");
    assert.equal(missingValue.statusCode, 400);
    assert.match(missingValue.body, /Missing required query parameter: value/);

    const missing = await httpRequest(port, "/unknown");
    assert.equal(missing.statusCode, 404);
    assert.match(missing.body, /Use direct compatible paths/);
    assert.equal(writes.length, 0);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test("server writes estimated record on proxy connection failure", async () => {
  const { app, port } = await startApp();

  try {
    const body = JSON.stringify({
      model: "test_gpt-4.1",
      messages: [{ role: "user", content: "hello integration" }],
      metadata: { requestTag: "test_proxy_error" },
    });

    const response = await httpRequest(port, "/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-user-id": "test_user_error",
        "x-session-id": "test_session_error",
        authorization: "Bearer sk-test-error",
      },
      body,
    });

    assert.equal(response.statusCode, 502);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].provider, "openai");
    assert.equal(writes[0].category, "chat.completions");
    assert.equal(writes[0].isStream, false);
    assert.equal(writes[0].apiKind, "openai.chat.completions");
    assert.equal(writes[0].userId, "test_user_error");
    assert.equal(writes[0].apiKeyHash, hashApiKey("sk-test-error"));
    assert.equal(writes[0].sessionId, "test_session_error");
    assert.equal(writes[0].requestTag, "test_proxy_error");
    assert.equal(writes[0].modelId, "test_gpt-4.1");
    assert.equal(writes[0].status, "502_estimated");
    assert.equal(writes[0].errorMessage.length > 0, true);
    assert.match(writes[0].inputContent, /user: hello integration/);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test("server supports prefixed anthropic routes and logs estimated failure", async () => {
  const { app, port } = await startApp();

  try {
    const body = JSON.stringify({
      model: "test_claude",
      system: "be helpful",
      messages: [{ role: "user", content: "hello" }],
      metadata: { user_id: "test_user_body", request_tag: "test_anthropic_prefix" },
    });

    const response = await httpRequest(port, "/anthropic/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-api-key": "test-anthropic-key",
      },
      body,
    });

    assert.equal(response.statusCode, 502);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].provider, "anthropic");
    assert.equal(writes[0].apiKind, "anthropic.messages");
    assert.equal(writes[0].apiKeyHash, hashApiKey("test-anthropic-key"));
    assert.equal(writes[0].userId, "test_user_body");
    assert.equal(writes[0].requestTag, "test_anthropic_prefix");
    assert.match(writes[0].inputContent, /system: be helpful/);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test("server marks Gemini SSE route as streaming in records", async () => {
  const { app, port } = await startApp();

  try {
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });

    const response = await httpRequest(port, "/gemini/v1beta/models/test-model:streamGenerateContent?alt=sse", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-request-tag": "test_gemini_stream",
      },
      body,
    });

    assert.equal(response.statusCode, 502);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].provider, "gemini");
    assert.equal(writes[0].category, "generateContent");
    assert.equal(writes[0].isStream, true);
    assert.equal(writes[0].apiKind, "gemini.generateContent");
    assert.equal(writes[0].requestTag, "test_gemini_stream");
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test("server records upstream request id, usage, and output from successful proxy response", async () => {
  writes.length = 0;

  const upstream = http.createServer((req, res) => {
    assert.equal(req.headers["x-user-id"], "test_proxy_user");
    assert.equal(req.url, "/v1/chat/completions?trace=1");

    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "application/json",
        "x-request-id": "upstream_req_1",
      });
      res.end(
        JSON.stringify({
          id: "chatcmpl_local",
          model: "gpt-4.1",
          choices: [
            {
              message: {
                content: [{ text: "Hello back" }],
              },
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 4,
            prompt_tokens_details: { cached_tokens: 2 },
          },
        })
      );
    });
  });

  await new Promise((resolve) => upstream.listen(0, resolve));
  const upstreamPort = upstream.address().port;

  Module._load = function mockSuccessDeps(request, parent, isMain) {
    if (request === "./config" || request.endsWith("/src/config")) {
      return {
        getConfig() {
          return {
            port: 0,
            requestCaptureLimitBytes: 1024 * 1024,
            responseCaptureLimitBytes: 1024 * 1024,
            contentLimitChars: 2000,
            questdb: {
              enabled: true,
              configString: "http::addr=test",
            },
            routes: {
              openaiPrefix: "/openai",
              anthropicPrefix: "/anthropic",
              geminiPrefix: "/gemini",
            },
            upstreams: {
              openai: `http://127.0.0.1:${upstreamPort}`,
              anthropic: "http://127.0.0.1:1",
              gemini: "http://127.0.0.1:1",
            },
          };
        },
      };
    }

    if (request === "./questdb-writer" || request.endsWith("/src/questdb-writer")) {
      return {
        QuestDbWriter: FakeQuestDbWriter,
      };
    }

    if (request === "./tokenizer" || request.endsWith("/src/tokenizer")) {
      const actual = originalLoad(request, parent, isMain);
      return {
        ...actual,
        freeEncoders() {
          freeEncodersCalls.push(true);
        },
      };
    }

    return originalLoad(request, parent, isMain);
  };

  delete require.cache[require.resolve("../src/server")];
  const { createApp: createSuccessApp } = require("../src/server");
  Module._load = originalLoad;

  const app = createSuccessApp();
  await app.start();
  const port = app.server.address().port;

  try {
    const body = JSON.stringify({
      model: "gpt-4.1",
      messages: [{ role: "user", content: "hello success" }],
      metadata: { session_id: "session_success", request_tag: "tag_success" },
    });

    const response = await httpRequest(port, "/v1/chat/completions?trace=1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-user-id": "test_proxy_user",
        authorization: "Bearer sk-test-success",
      },
      body,
    });

    assert.equal(response.statusCode, 200);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].status, "200_reported");
    assert.equal(writes[0].requestId, "upstream_req_1");
    assert.equal(writes[0].provider, "openai");
    assert.equal(writes[0].modelId, "gpt-4.1");
    assert.equal(writes[0].apiKeyHash, hashApiKey("sk-test-success"));
    assert.equal(writes[0].inputTokens, 12);
    assert.equal(writes[0].outputTokens, 4);
    assert.equal(writes[0].cachedTokens, 2);
    assert.equal(writes[0].outputContent, "Hello back");
    assert.equal(writes[0].sessionId, "session_success");
    assert.equal(writes[0].requestTag, "tag_success");
    assert.equal(typeof writes[0].ttftMs, "number");
    assert.equal(JSON.parse(writes[0].usageJson).prompt_tokens, 12);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
    delete require.cache[require.resolve("../src/server")];
  }
});

