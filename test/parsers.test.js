"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
const encoderInstances = [];
const encodingForModelCalls = [];
const getEncodingCalls = [];

function createEncoder(name) {
  return {
    name,
    freed: false,
    encode(text) {
      return Array.from({ length: String(text).length }, (_, index) => index);
    },
    free() {
      this.freed = true;
    },
  };
}

Module._load = function mockTiktoken(request, parent, isMain) {
  if (request === "@dqbd/tiktoken") {
    return {
      encoding_for_model(modelId) {
        encodingForModelCalls.push(modelId);
        if (modelId === "force-fallback") {
          throw new Error("unknown model");
        }
        const encoder = createEncoder(`model:${modelId}`);
        encoderInstances.push(encoder);
        return encoder;
      },
      get_encoding(name) {
        getEncodingCalls.push(name);
        const encoder = createEncoder(`encoding:${name}`);
        encoderInstances.push(encoder);
        return encoder;
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

const { createResponseTracker, parseRequestSnapshot, LimitedBuffer, clampText, detectApiKind, getHeader } = require("../src/parsers");
const { countTextTokens, freeEncoders } = require("../src/tokenizer");

Module._load = originalLoad;

test.afterEach(() => {
  encodingForModelCalls.length = 0;
  getEncodingCalls.length = 0;
  encoderInstances.length = 0;
  freeEncoders();
});

test("clampText truncates long content with marker", () => {
  assert.equal(clampText("hello", 10), "hello");
  assert.equal(clampText("abcdef", 3), "abc\n...[truncated]");
  assert.equal(clampText("", 3), "");
});

test("LimitedBuffer truncates at byte limit", () => {
  const buffer = new LimitedBuffer(5);
  buffer.add(Buffer.from("abc"));
  buffer.add(Buffer.from("def"));

  assert.equal(buffer.toString(), "abcde");
  assert.equal(buffer.truncated, true);
});

test("getHeader returns first header value from arrays", () => {
  assert.equal(getHeader({ test: ["a", "b"] }, "test"), "a");
  assert.equal(getHeader({ test: "x" }, "test"), "x");
  assert.equal(getHeader({}, "missing"), "");
});

test("detectApiKind recognizes provider routes", () => {
  assert.equal(detectApiKind("openai", "/v1/responses"), "openai.responses");
  assert.equal(detectApiKind("openai", "/other"), "openai.generic");
  assert.equal(detectApiKind("anthropic", "/v1/messages"), "anthropic.messages");
  assert.equal(detectApiKind("anthropic", "/other"), "anthropic.generic");
  assert.equal(detectApiKind("gemini", "/v1beta/models/gemini-2.5:generateContent"), "gemini.generateContent");
  assert.equal(detectApiKind("gemini", "/other"), "gemini.generic");
  assert.equal(detectApiKind("other", "/other"), "generic");
});

test("parseRequestSnapshot extracts OpenAI chat input and metadata", () => {
  const snapshot = parseRequestSnapshot({
    provider: "openai",
    headers: {
      "x-user-id": "user-1",
      "x-session-id": "session-1",
    },
    upstreamPath: "/v1/chat/completions",
    rawBody: JSON.stringify({
      model: "gpt-4.1",
      messages: [
        { role: "system", content: "Be brief" },
        { role: "user", content: "Hello" },
      ],
    }),
    contentLimitChars: 2000,
  });

  assert.equal(snapshot.apiKind, "openai.chat.completions");
  assert.equal(snapshot.category, "chat.completions");
  assert.equal(snapshot.isStream, false);
  assert.equal(snapshot.modelId, "gpt-4.1");
  assert.equal(snapshot.userId, "user-1");
  assert.ok(snapshot.inputTokensEstimate > 0);
  assert.match(snapshot.inputContent, /system: Be brief/);
  assert.match(snapshot.inputContent, /user: Hello/);
});

test("parseRequestSnapshot extracts OpenAI responses input and metadata fallbacks", () => {
  const snapshot = parseRequestSnapshot({
    provider: "openai",
    headers: {
      "x-openai-user": "header-user",
      "x-request-tag": "header-tag",
    },
    upstreamPath: "/v1/responses",
    rawBody: JSON.stringify({
      model: "gpt-4o",
      instructions: [{ type: "input_text", text: "System prompt" }],
      input: [
        { role: "user", content: [{ type: "input_text", text: "Hello" }, { inlineData: { mimeType: "image/png" } }] },
        { type: "input_text", text: "tail" },
      ],
      metadata: { sessionId: "meta-session", requestTag: "meta-tag" },
    }),
    contentLimitChars: 2000,
  });

  assert.equal(snapshot.apiKind, "openai.responses");
  assert.equal(snapshot.category, "responses");
  assert.equal(snapshot.isStream, false);
  assert.equal(snapshot.userId, "header-user");
  assert.equal(snapshot.sessionId, "meta-session");
  assert.equal(snapshot.requestTag, "meta-tag");
  assert.match(snapshot.inputContent, /instructions: System prompt/);
  assert.match(snapshot.inputContent, /user: Hello\[inline_data image\/png\]/);
  assert.match(snapshot.inputContent, /tail/);
});

test("parseRequestSnapshot extracts Anthropic input, metadata, and multimodal markers", () => {
  const snapshot = parseRequestSnapshot({
    provider: "anthropic",
    headers: {
      "x-session-id": "header-session",
    },
    upstreamPath: "/v1/messages",
    rawBody: JSON.stringify({
      model: "claude-sonnet-4-5",
      system: [{ type: "text", text: "Stay concise" }],
      messages: [
        { role: "user", content: [{ type: "text", text: "Hello" }, { fileData: { mimeType: "application/pdf" } }] },
      ],
      metadata: { user_id: "meta-user", request_tag: "tag-1" },
    }),
    contentLimitChars: 2000,
  });

  assert.equal(snapshot.apiKind, "anthropic.messages");
  assert.equal(snapshot.category, "messages");
  assert.equal(snapshot.isStream, false);
  assert.equal(snapshot.modelId, "claude-sonnet-4-5");
  assert.equal(snapshot.userId, "meta-user");
  assert.equal(snapshot.sessionId, "header-session");
  assert.equal(snapshot.requestTag, "tag-1");
  assert.match(snapshot.inputContent, /system: Stay concise/);
  assert.match(snapshot.inputContent, /user: Hello\[file_data application\/pdf\]/);
});

test("parseRequestSnapshot extracts Gemini content and model from URL", () => {
  const snapshot = parseRequestSnapshot({
    provider: "gemini",
    headers: {},
    upstreamPath: "/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
    rawBody: JSON.stringify({
      systemInstruction: { parts: [{ text: "Behave" }] },
      contents: [
        { role: "user", parts: [{ text: "Hello" }, { inline_data: { mime_type: "image/jpeg" } }] },
        { role: "model", parts: [{ text: "Prev" }] },
      ],
    }),
    contentLimitChars: 2000,
  });

  assert.equal(snapshot.apiKind, "gemini.generateContent");
  assert.equal(snapshot.category, "generateContent");
  assert.equal(snapshot.isStream, true);
  assert.equal(snapshot.modelId, "gemini-2.5-flash");
  assert.match(snapshot.inputContent, /system: Behave/);
  assert.match(snapshot.inputContent, /user: Hello\[inline_data image\/jpeg\]/);
  assert.match(snapshot.inputContent, /model: Prev/);
});

test("parseRequestSnapshot falls back to generic body serialization and truncation", () => {
  const snapshot = parseRequestSnapshot({
    provider: "openai",
    headers: {},
    upstreamPath: "/v1/unknown",
    rawBody: JSON.stringify({ hello: "world", nested: { ok: true } }),
    contentLimitChars: 8,
  });

  assert.equal(snapshot.apiKind, "openai.generic");
  assert.equal(snapshot.category, "generic");
  assert.equal(snapshot.isStream, false);
  assert.match(snapshot.inputContent, /^\{"hello"/);
  assert.equal(snapshot.inputChars > 8, true);
  assert.match(snapshot.inputContent, /\.\.\.\[truncated\]/);
});

test("parseRequestSnapshot detects explicit stream flag", () => {
  const snapshot = parseRequestSnapshot({
    provider: "openai",
    headers: {},
    upstreamPath: "/v1/chat/completions",
    rawBody: JSON.stringify({
      model: "gpt-4.1",
      stream: true,
      messages: [{ role: "user", content: "Hello" }],
    }),
    contentLimitChars: 2000,
  });

  assert.equal(snapshot.category, "chat.completions");
  assert.equal(snapshot.isStream, true);
});

test("parseRequestSnapshot handles generic provider and header array metadata", () => {
  const snapshot = parseRequestSnapshot({
    provider: "custom",
    headers: {
      "x-user-id": ["array-user", "ignored"],
      "x-session-id": "array-session",
      "x-request-tag": "array-tag",
    },
    upstreamPath: "/custom/path",
    rawBody: JSON.stringify({
      model: "custom-model",
      user: "body-user",
      sessionId: "body-session",
      requestTag: "body-tag",
      value: "hello",
    }),
    contentLimitChars: 2000,
  });

  assert.equal(snapshot.apiKind, "generic");
  assert.equal(snapshot.category, "generic");
  assert.equal(snapshot.isStream, false);
  assert.equal(snapshot.modelId, "custom-model");
  assert.equal(snapshot.userId, "body-user");
  assert.equal(snapshot.sessionId, "body-session");
  assert.equal(snapshot.requestTag, "body-tag");
  assert.match(snapshot.inputContent, /"value":"hello"/);
});

test("parseRequestSnapshot handles invalid JSON request bodies", () => {
  const snapshot = parseRequestSnapshot({
    provider: "openai",
    headers: {},
    upstreamPath: "/v1/chat/completions",
    rawBody: "{bad json",
    contentLimitChars: 2000,
  });

  assert.equal(snapshot.modelId, null);
  assert.equal(snapshot.userId, null);
  assert.equal(snapshot.sessionId, null);
  assert.equal(snapshot.requestTag, null);
  assert.equal(snapshot.inputContent, "");
  assert.equal(snapshot.inputChars, 0);
  assert.equal(snapshot.inputTokensEstimate, 0);
  assert.equal(snapshot.requestBody, null);
});

test("createResponseTracker handles generic SSE payloads and empty blocks", () => {
  const tracker = createResponseTracker({
    apiKind: "generic",
    contentType: "text/event-stream",
    contentLimitChars: 2000,
    responseCaptureLimitBytes: 4096,
  });

  tracker.onChunk(
    Buffer.from(
      [
        "",
        ":comment",
        "",
        'data: {"id":"generic-1","model":"generic-model","error":{"message":"generic error"}}',
        "",
      ].join("\n")
    )
  );

  const result = tracker.finish(500);
  assert.equal(result.responseId, "generic-1");
  assert.equal(result.modelId, "generic-model");
  assert.equal(result.errorMessage, "generic error");
  assert.equal(result.outputContent, "");
});
test("createResponseTracker extracts OpenAI responses streaming usage", () => {
  const tracker = createResponseTracker({
    apiKind: "openai.responses",
    contentType: "text/event-stream",
    contentLimitChars: 2000,
    responseCaptureLimitBytes: 4096,
  });

  tracker.onChunk(
    Buffer.from(
      [
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"Hel"}',
        "",
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"lo"}',
        "",
        'event: response.completed',
        'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-4.1","usage":{"input_tokens":10,"output_tokens":4,"input_tokens_details":{"cached_tokens":2}}}}',
        "",
      ].join("\n")
    )
  );

  const result = tracker.finish(200);
  assert.equal(result.responseId, "resp_1");
  assert.equal(result.modelId, "gpt-4.1");
  assert.equal(result.outputContent, "Hello");
  assert.deepEqual(result.usage, {
    inputTokens: 10,
    outputTokens: 4,
    cachedTokens: 2,
  });
});

test("createResponseTracker extracts Anthropic message output and usage", () => {
  const tracker = createResponseTracker({
    apiKind: "anthropic.messages",
    contentType: "application/json",
    contentLimitChars: 2000,
    responseCaptureLimitBytes: 4096,
  });

  tracker.onChunk(
    Buffer.from(
      JSON.stringify({
        id: "msg_1",
        model: "claude-sonnet-4-5",
        content: [{ type: "text", text: "Hi there" }],
        usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 3 },
      })
    )
  );

  const result = tracker.finish(200);
  assert.equal(result.responseId, "msg_1");
  assert.equal(result.modelId, "claude-sonnet-4-5");
  assert.equal(result.outputContent, "Hi there");
  assert.deepEqual(result.usage, {
    inputTokens: 20,
    outputTokens: 5,
    cachedTokens: 3,
  });
  assert.deepEqual(result.usageRaw, {
    input_tokens: 20,
    output_tokens: 5,
    cache_read_input_tokens: 3,
  });
});

test("createResponseTracker merges Anthropic streaming usage across events", () => {
  const tracker = createResponseTracker({
    apiKind: "anthropic.messages",
    contentType: "text/event-stream",
    contentLimitChars: 2000,
    responseCaptureLimitBytes: 4096,
  });

  tracker.onChunk(
    Buffer.from(
      [
        'event: message_start',
        'data: {"type":"message_start","message":{"id":"msg_2","model":"claude-sonnet-4-5","usage":{"input_tokens":21,"cache_creation_input_tokens":8,"cache_read_input_tokens":3}}}',
        "",
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}',
        "",
        'event: message_delta',
        'data: {"type":"message_delta","usage":{"output_tokens":7}}',
        "",
        'event: error',
        'data: {"type":"error","message":"upstream failed"}',
        "",
        'event: content_block_delta',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}',
        "",
      ].join("\n")
    )
  );

  const result = tracker.finish(200);
  assert.equal(result.responseId, "msg_2");
  assert.equal(result.modelId, "claude-sonnet-4-5");
  assert.equal(result.outputContent, "Hello");
  assert.equal(result.errorMessage, "upstream failed");
  assert.deepEqual(result.usage, {
    inputTokens: 21,
    outputTokens: 7,
    cachedTokens: 3,
  });
  assert.deepEqual(result.usageRaw, {
    input_tokens: 21,
    cache_creation_input_tokens: 8,
    cache_read_input_tokens: 3,
    output_tokens: 7,
  });
});

test("createResponseTracker extracts Gemini JSON response and usage", () => {
  const tracker = createResponseTracker({
    apiKind: "gemini.generateContent",
    contentType: "application/json",
    contentLimitChars: 2000,
    responseCaptureLimitBytes: 4096,
  });

  tracker.onChunk(
    Buffer.from(
      JSON.stringify({
        candidates: [
          { content: { parts: [{ text: "Hi" }, { text: " there" }] } },
          { content: { parts: [{ text: "!" }] } },
        ],
        usageMetadata: {
          promptTokenCount: 5,
          candidatesTokenCount: 3,
          cachedContentTokenCount: 1,
        },
      })
    )
  );

  const result = tracker.finish(200);
  assert.equal(result.outputContent, "Hi there\n!");
  assert.deepEqual(result.usage, {
    inputTokens: 5,
    outputTokens: 3,
    cachedTokens: 1,
  });
});

test("createResponseTracker estimates output tokens when upstream usage is absent", () => {
  const tracker = createResponseTracker({
    apiKind: "openai.chat.completions",
    contentType: "text/event-stream",
    contentLimitChars: 2000,
    responseCaptureLimitBytes: 4096,
  });

  tracker.onChunk(
    Buffer.from(
      [
        'data: {"id":"chatcmpl_1","choices":[{"delta":{"content":"Hello "}}]}',
        "",
        'data: {"id":"chatcmpl_1","choices":[{"delta":{"content":"world"}}]}',
        "",
        "data: [DONE]",
        "",
      ].join("\n")
    )
  );

  const result = tracker.finish(200);
  assert.equal(result.usage, null);
  assert.equal(result.outputContent, "Hello world");
  assert.ok(result.outputTokensEstimate > 0);
});

test("createResponseTracker handles partial SSE blocks, comments, and invalid JSON", () => {
  const tracker = createResponseTracker({
    apiKind: "gemini.generateContent",
    contentType: "text/event-stream",
    contentLimitChars: 2000,
    responseCaptureLimitBytes: 4096,
  });

  tracker.onChunk(Buffer.from(':comment\n'));
  tracker.onChunk(
    Buffer.from(
      'event: message\n' +
        'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}],"usageMetadata":{"promptTokenCount":1}}\n\n' +
        'data: {bad json}\n\n' +
        'data: {"candidates":[{"content":{"parts":[{"text":" there"}]}}],"usageMetadata":{"candidatesTokenCount":2}}\n'
    )
  );

  const result = tracker.finish(200);
  assert.equal(result.outputContent, "Hi there");
  assert.deepEqual(result.usage, {
    inputTokens: 1,
    outputTokens: 2,
    cachedTokens: undefined,
  });
});

test("createResponseTracker truncates output preview and preserves full output char count", () => {
  const tracker = createResponseTracker({
    apiKind: "openai.responses",
    contentType: "text/event-stream",
    contentLimitChars: 5,
    responseCaptureLimitBytes: 4096,
  });

  tracker.onChunk(
    Buffer.from(
      [
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"Hello"}',
        "",
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":" world"}',
        "",
      ].join("\n")
    )
  );

  const result = tracker.finish(200);
  assert.equal(result.outputChars, 11);
  assert.equal(result.outputContent, "Hello\n...[truncated]");
});

test("createResponseTracker returns raw error body for failed non-JSON responses", () => {
  const tracker = createResponseTracker({
    apiKind: "generic",
    contentType: "text/plain",
    contentLimitChars: 2000,
    responseCaptureLimitBytes: 4096,
  });

  tracker.onChunk(Buffer.from("upstream exploded"));

  const result = tracker.finish(502);
  assert.equal(result.errorMessage, "upstream exploded");
  assert.equal(result.outputContent, "");
});

test("createResponseTracker extracts error messages from JSON payloads", () => {
  const tracker = createResponseTracker({
    apiKind: "openai.generic",
    contentType: "application/json",
    contentLimitChars: 2000,
    responseCaptureLimitBytes: 4096,
  });

  tracker.onChunk(
    Buffer.from(
      JSON.stringify({
        id: "resp_error",
        model: "gpt-4.1",
        error: { message: "bad request" },
      })
    )
  );

  const result = tracker.finish(400);
  assert.equal(result.responseId, "resp_error");
  assert.equal(result.modelId, "gpt-4.1");
  assert.equal(result.errorMessage, "bad request");
});

test("countTextTokens falls back to model-specific encoding names and caches encoders", () => {
  assert.equal(countTextTokens("hello", { modelId: "gpt-4o-mini", apiKind: "openai.responses" }), 5);
  assert.equal(countTextTokens("world", { modelId: "gpt-4o-mini", apiKind: "openai.responses" }), 5);
  assert.deepEqual(encodingForModelCalls, ["gpt-4o-mini"]);
  assert.deepEqual(getEncodingCalls, []);
});

test("countTextTokens falls back to generic encoding when model lookup fails", () => {
  assert.equal(countTextTokens("abc", { modelId: "force-fallback", apiKind: "gemini.generateContent" }), 3);
  assert.deepEqual(encodingForModelCalls, ["force-fallback"]);
  assert.deepEqual(getEncodingCalls, ["o200k_base"]);
});

test("countTextTokens uses default encoding rules and freeEncoders releases cache", () => {
  assert.equal(countTextTokens("", { apiKind: "openai.chat.completions" }), 0);
  assert.equal(countTextTokens("abc", { apiKind: "openai.chat.completions" }), 3);
  assert.equal(countTextTokens("abc", { apiKind: "generic" }), 3);
  assert.deepEqual(getEncodingCalls, ["cl100k_base", "cl100k_base"]);

  const created = encoderInstances.slice();
  freeEncoders();
  assert.equal(created.every((encoder) => encoder.freed), true);
});
