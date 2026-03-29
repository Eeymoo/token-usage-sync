"use strict";

const { createHash } = require("node:crypto");

function hashApiKey(apiKey) {
  return createHash("sha256").update(String(apiKey)).digest("hex");
}

module.exports = {
  hashApiKey,
};
