"use strict";

const { encoding_for_model, get_encoding } = require("@dqbd/tiktoken");

const encoderCache = new Map();

function pickEncodingName(modelId, apiKind) {
  const model = String(modelId || "").toLowerCase();

  if (
    model.includes("gpt-4o") ||
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4")
  ) {
    return "o200k_base";
  }

  if (apiKind && apiKind.startsWith("openai")) {
    return "cl100k_base";
  }

  if (apiKind === "gemini.generateContent") {
    return "o200k_base";
  }

  return "cl100k_base";
}

function getEncoder(modelId, apiKind) {
  const cacheKey = `${modelId || ""}::${apiKind || ""}`;
  const cached = encoderCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let encoder;
  if (modelId) {
    try {
      encoder = encoding_for_model(modelId);
    } catch {
      encoder = null;
    }
  }

  if (!encoder) {
    encoder = get_encoding(pickEncodingName(modelId, apiKind));
  }

  encoderCache.set(cacheKey, encoder);
  return encoder;
}

function countTextTokens(text, options = {}) {
  if (!text) {
    return 0;
  }

  const encoder = getEncoder(options.modelId, options.apiKind);
  return encoder.encode(text).length;
}

function freeEncoders() {
  for (const encoder of encoderCache.values()) {
    try {
      encoder.free();
    } catch {
      // noop
    }
  }
  encoderCache.clear();
}

module.exports = {
  countTextTokens,
  freeEncoders,
};
