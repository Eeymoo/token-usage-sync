"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const QUESTRDB_EXEC_URL = process.env.TEST_QUESTDB_EXEC_URL || "http://192.168.2.252:9000/exec";
const PROXY_BASE_URL = process.env.TEST_PROXY_BASE_URL || "http://127.0.0.1:19087";
const OPENAI_TOKEN = process.env.TEST_OPENAI_TOKEN;

async function execSql(query) {
  const url = `${QUESTRDB_EXEC_URL}?query=${encodeURIComponent(query)}`;
  const response = await fetch(url);
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return JSON.parse(text);
}

async function postJson(path, body, headers = {}) {
  const response = await fetch(`${PROXY_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  return { status: response.status, text, json: text ? JSON.parse(text) : null, headers: response.headers };
}

test("external OpenAI-compatible request writes QuestDB rows", { skip: !OPENAI_TOKEN }, async () => {
  const requestTag = `test_chat_${Date.now()}`;
  const sessionId = `test_session_${Date.now()}`;
  const userId = `test_user_${Date.now()}`;

  const response = await postJson(
    "/v1/chat/completions",
    {
      model: process.env.TEST_OPENAI_MODEL || "glm-5",
      messages: [{ role: "user", content: "Reply with the word pong only." }],
      metadata: { requestTag },
    },
    {
      authorization: `Bearer ${OPENAI_TOKEN}`,
      "x-user-id": userId,
      "x-session-id": sessionId,
    }
  );

  assert.equal(response.status, 200, response.text);

  await new Promise((resolve) => setTimeout(resolve, 1500));

  const stats = await execSql(
    `select request_id, provider, api_kind, model_id, user_id, session_id, request_tag, status from token_usage_requests_stats where request_tag = '${requestTag}' order by timestamp desc limit 1`
  );
  assert.equal(stats.dataset.length, 1);
  assert.equal(stats.dataset[0][1], "openai");
  assert.equal(stats.dataset[0][2], "openai.chat.completions");
  assert.equal(stats.dataset[0][4], userId);
  assert.equal(stats.dataset[0][5], sessionId);
  assert.equal(stats.dataset[0][6], requestTag);

  const records = await execSql(
    `select request_id, input_content, output_content, error_msg from token_usage_requests_records where request_tag = '${requestTag}' order by timestamp desc limit 1`
  );
  assert.equal(records.dataset.length, 1);
  assert.equal(records.dataset[0][0], stats.dataset[0][0]);
  assert.match(records.dataset[0][1], /user: Reply with the word pong only\./);
  assert.equal(typeof records.dataset[0][2], "string");
});
