"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
let senderFactory;

Module._load = function mockQuestDb(request, parent, isMain) {
  if (request === "@questdb/nodejs-client") {
    return {
      Sender: {
        fromConfig(configString) {
          return senderFactory(configString);
        },
      },
    };
  }
  return originalLoad(request, parent, isMain);
};

const { QuestDbWriter } = require("../src/questdb-writer");
Module._load = originalLoad;

function createSender() {
  return {
    calls: [],
    flushed: 0,
    closed: 0,
    table(name) {
      this.calls.push(["table", name]);
    },
    stringColumn(name, value) {
      this.calls.push(["string", name, value]);
    },
    intColumn(name, value) {
      this.calls.push(["int", name, value]);
    },
    booleanColumn(name, value) {
      this.calls.push(["bool", name, value]);
    },
    reset() {
      this.calls.push(["reset"]);
    },
    async at(timestamp, unit) {
      this.calls.push(["at", timestamp, unit]);
    },
    async flush() {
      this.flushed += 1;
    },
    async close() {
      this.closed += 1;
    },
  };
}

test("QuestDbWriter skips writes when disabled", async () => {
  senderFactory = () => {
    throw new Error("should not create sender");
  };

  const writer = new QuestDbWriter({ enabled: false, configString: "http::addr=test" });
  await writer.write({ requestId: "ignored" });
  await writer.close();
});

test("QuestDbWriter writes stats and record rows with common fields", async () => {
  const sender = createSender();
  let configs = [];
  senderFactory = (configString) => {
    configs.push(configString);
    return Promise.resolve(sender);
  };

  const writer = new QuestDbWriter({ enabled: true, configString: "http::addr=test" });
  await writer.write({
    requestId: "req-1",
    timestamp: 123,
    provider: "openai",
    category: "chat.completions",
    isStream: true,
    apiKind: "openai.chat.completions",
    modelId: "gpt-4.1",
    userId: "user-1",
    inputTokens: 11,
    outputTokens: 7,
    cachedTokens: 2,
    inputChars: 5,
    outputChars: 9,
    status: "200_reported",
    latencyMs: 50,
    ttftMs: 12,
    sessionId: "session-1",
    requestTag: "tag-1",
    apiKeyHash: "hash-1",
    usageJson: '{"a":1}',
    inputContent: "hello",
    outputContent: "world",
    errorMessage: "",
  });
  await writer.close();

  assert.deepEqual(configs, ["http::addr=test"]);
  assert.equal(sender.flushed, 1);
  assert.equal(sender.closed, 1);
  assert.equal(
    sender.calls.some((call) => call[0] === "table" && call[1] === "token_usage_requests_stats"),
    true
  );
  assert.equal(
    sender.calls.some((call) => call[0] === "table" && call[1] === "token_usage_requests_records"),
    true
  );
  assert.equal(
    sender.calls.some((call) => call[0] === "string" && call[1] === "request_id" && call[2] === "req-1"),
    true
  );
  assert.equal(
    sender.calls.some((call) => call[0] === "string" && call[1] === "category" && call[2] === "chat.completions"),
    true
  );
  assert.equal(
    sender.calls.some((call) => call[0] === "bool" && call[1] === "is_stream" && call[2] === true),
    true
  );
  assert.equal(
    sender.calls.some((call) => call[0] === "int" && call[1] === "input_tokens" && call[2] === 11),
    true
  );
  assert.equal(
    sender.calls.some((call) => call[0] === "string" && call[1] === "api_key_hash" && call[2] === "hash-1"),
    true
  );
  assert.equal(
    sender.calls.some((call) => call[0] === "string" && call[1] === "input_content" && call[2] === "hello"),
    true
  );
  assert.equal(
    sender.calls.some((call) => call[0] === "string" && call[1] === "output_content" && call[2] === "world"),
    true
  );
  assert.equal(
    sender.calls.some((call) => call[0] === "string" && call[1] === "error_msg"),
    false
  );
});

test("QuestDbWriter serializes writes and swallows write errors", async () => {
  const sender = createSender();
  let failFlush = true;
  sender.flush = async function flush() {
    this.flushed += 1;
    if (failFlush) {
      failFlush = false;
      throw new Error("flush failed");
    }
  };

  senderFactory = () => Promise.resolve(sender);

  const messages = [];
  const originalError = console.error;
  console.error = (...args) => messages.push(args.join(" "));

  try {
    const writer = new QuestDbWriter({ enabled: true, configString: "http::addr=test" });
    await Promise.all([
      writer.write({ requestId: "req-1", timestamp: 1 }),
      writer.write({ requestId: "req-2", timestamp: 2 }),
    ]);
    await writer.close();
  } finally {
    console.error = originalError;
  }

  assert.equal(messages.some((line) => line.includes("QuestDB write failed:")), true);
  assert.equal(sender.flushed, 2);
  assert.equal(sender.closed, 1);
});

test("QuestDbWriter close is idempotent and tolerates missing sender", async () => {
  senderFactory = () => Promise.resolve(null);
  const writer = new QuestDbWriter({ enabled: true, configString: "http::addr=test" });

  await writer.close();
  await writer.close();
});
