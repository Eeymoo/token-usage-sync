"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { hashApiKey } = require("../src/api-key");
const { hashApiKey: exportedHashApiKey } = require("../index");

test("hashApiKey returns stable sha256 hex", () => {
  const apiKey = "sk-test-123";
  const hashed = hashApiKey(apiKey);

  assert.equal(hashed.length, 64);
  assert.match(hashed, /^[0-9a-f]{64}$/);
  assert.equal(hashApiKey(apiKey), hashed);
  assert.notEqual(hashApiKey("sk-test-456"), hashed);
});

test("package exports hashApiKey helper", () => {
  assert.equal(exportedHashApiKey("sk-test-123"), hashApiKey("sk-test-123"));
});
