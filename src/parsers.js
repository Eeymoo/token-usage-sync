"use strict";

const { StringDecoder } = require("node:string_decoder");
const { countTextTokens } = require("./tokenizer");

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

function coalesce(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return null;
}

function coalesceDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }
  return undefined;
}

function clampText(text, limitChars) {
  if (!text) {
    return "";
  }
  if (text.length <= limitChars) {
    return text;
  }
  return `${text.slice(0, limitChars)}\n...[truncated]`;
}

function previewText(text, totalChars, limitChars) {
  if (!text) {
    return "";
  }
  if (totalChars <= limitChars) {
    return text;
  }
  return `${text.slice(0, limitChars)}\n...[truncated]`;
}

function appendLimited(target, addition, limitChars) {
  if (!addition || target.length >= limitChars) {
    return target;
  }

  const next = target + addition;
  return clampText(next, limitChars);
}

function readUsageNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function mergeUsage(previous, next) {
  if (!next) {
    return previous || null;
  }

  if (!previous) {
    return {
      inputTokens: next.inputTokens,
      outputTokens: next.outputTokens,
      cachedTokens: next.cachedTokens,
    };
  }

  return {
    inputTokens: coalesceDefined(next.inputTokens, previous.inputTokens),
    outputTokens: coalesceDefined(next.outputTokens, previous.outputTokens),
    cachedTokens: coalesceDefined(next.cachedTokens, previous.cachedTokens),
  };
}

function mergeUsageRaw(previous, next) {
  if (!previous) {
    return next || null;
  }
  if (!next) {
    return previous;
  }
  return {
    ...previous,
    ...next,
  };
}

class LimitedBuffer {
  constructor(limitBytes) {
    this.limitBytes = limitBytes;
    this.size = 0;
    this.truncated = false;
    this.chunks = [];
  }

  add(chunk) {
    if (!chunk || this.limitBytes <= 0 || this.size >= this.limitBytes) {
      this.truncated = this.truncated || this.size >= this.limitBytes;
      return;
    }

    const remaining = this.limitBytes - this.size;
    const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    this.chunks.push(slice);
    this.size += slice.length;
    if (slice.length < chunk.length) {
      this.truncated = true;
    }
  }

  toString() {
    if (this.chunks.length === 0) {
      return "";
    }
    return Buffer.concat(this.chunks, this.size).toString("utf8");
  }
}

function getHeader(headers, name) {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0] || "";
  }
  return value || "";
}

function collectTextParts(parts) {
  if (!Array.isArray(parts)) {
    return "";
  }

  return parts
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (!part || typeof part !== "object") {
        return "";
      }

      if (typeof part.text === "string") {
        return part.text;
      }

      if (typeof part.output_text === "string") {
        return part.output_text;
      }

      if (typeof part.input_text === "string") {
        return part.input_text;
      }

      if (typeof part.value === "string") {
        return part.value;
      }

      if (part.type === "text_delta" && typeof part.delta === "string") {
        return part.delta;
      }

      if (part.inlineData || part.inline_data) {
        const inlineData = part.inlineData || part.inline_data;
        const mimeType = inlineData.mimeType || inlineData.mime_type || "application/octet-stream";
        return `[inline_data ${mimeType}]`;
      }

      if (part.fileData || part.file_data) {
        const fileData = part.fileData || part.file_data;
        const mimeType = fileData.mimeType || fileData.mime_type || "application/octet-stream";
        return `[file_data ${mimeType}]`;
      }

      if (part.image_url) {
        return "[image_url]";
      }

      if (part.type === "input_image" || part.type === "image") {
        return "[image]";
      }

      return "";
    })
    .filter(Boolean)
    .join("");
}

function formatRoleLines(items, contentSelector) {
  if (!Array.isArray(items)) {
    return "";
  }

  return items
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }
      const role = item.role || item.type || "unknown";
      const content = contentSelector(item);
      return content ? `${role}: ${content}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractOpenAiMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return collectTextParts(content);
  }
  if (content && typeof content === "object") {
    return collectTextParts([content]);
  }
  return "";
}

function extractOpenAiResponsesInput(input) {
  if (typeof input === "string") {
    return input;
  }
  if (!Array.isArray(input)) {
    return "";
  }

  return input
    .map((item) => {
      if (!item || typeof item !== "object") {
        return "";
      }

      if (typeof item === "string") {
        return item;
      }

      if (Array.isArray(item.content)) {
        return `${item.role || item.type || "unknown"}: ${collectTextParts(item.content)}`;
      }

      if (typeof item.content === "string") {
        return `${item.role || item.type || "unknown"}: ${item.content}`;
      }

      return collectTextParts([item]);
    })
    .filter(Boolean)
    .join("\n");
}

function extractAnthropicSystem(system) {
  if (typeof system === "string") {
    return system;
  }
  if (Array.isArray(system)) {
    return collectTextParts(system);
  }
  return "";
}

function extractAnthropicContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return collectTextParts(content);
  }
  return "";
}

function extractGeminiParts(content) {
  if (!content || typeof content !== "object") {
    return "";
  }
  return collectTextParts(content.parts);
}

function extractModelFromGeminiPath(upstreamPath) {
  const match = upstreamPath.match(/\/models\/([^:/?]+)(?::|$)/);
  return match ? match[1] : null;
}

function detectApiKind(provider, upstreamPath) {
  if (provider === "openai") {
    if (upstreamPath.includes("/v1/responses")) {
      return "openai.responses";
    }
    if (upstreamPath.includes("/v1/chat/completions")) {
      return "openai.chat.completions";
    }
    return "openai.generic";
  }

  if (provider === "anthropic") {
    if (upstreamPath.includes("/v1/messages")) {
      return "anthropic.messages";
    }
    return "anthropic.generic";
  }

  if (provider === "gemini") {
    if (
      upstreamPath.includes(":generateContent") ||
      upstreamPath.includes(":streamGenerateContent")
    ) {
      return "gemini.generateContent";
    }
    return "gemini.generic";
  }

  return "generic";
}

function inferMetadata(body, headers, upstreamPath) {
  return {
    userId: coalesce(
      body && body.user,
      body && body.metadata && body.metadata.user_id,
      body && body.metadata && body.metadata.userId,
      getHeader(headers, "x-user-id"),
      getHeader(headers, "x-openai-user")
    ),
    sessionId: coalesce(
      body && body.session_id,
      body && body.sessionId,
      body && body.metadata && body.metadata.session_id,
      body && body.metadata && body.metadata.sessionId,
      getHeader(headers, "x-session-id")
    ),
    requestTag: coalesce(
      body && body.request_tag,
      body && body.requestTag,
      body && body.metadata && body.metadata.request_tag,
      body && body.metadata && body.metadata.requestTag,
      Array.isArray(body && body.tags) ? body.tags.join(",") : null,
      getHeader(headers, "x-request-tag")
    ),
    modelId: coalesce(
      body && body.model,
      extractModelFromGeminiPath(upstreamPath)
    ),
  };
}

function extractRequestInput(apiKind, body) {
  if (!body || typeof body !== "object") {
    return "";
  }

  if (apiKind === "openai.chat.completions") {
    return formatRoleLines(body.messages, (message) =>
      extractOpenAiMessageContent(message.content)
    );
  }

  if (apiKind === "openai.responses") {
    const parts = [];
    if (body.instructions) {
      parts.push(`instructions: ${extractOpenAiMessageContent(body.instructions)}`);
    }
    const input = extractOpenAiResponsesInput(body.input);
    if (input) {
      parts.push(input);
    }
    return parts.join("\n");
  }

  if (apiKind === "anthropic.messages") {
    const parts = [];
    const system = extractAnthropicSystem(body.system);
    if (system) {
      parts.push(`system: ${system}`);
    }
    const messages = formatRoleLines(body.messages, (message) =>
      extractAnthropicContent(message.content)
    );
    if (messages) {
      parts.push(messages);
    }
    return parts.join("\n");
  }

  if (apiKind === "gemini.generateContent") {
    const parts = [];
    const system = extractGeminiParts(body.systemInstruction);
    if (system) {
      parts.push(`system: ${system}`);
    }
    const contents = formatRoleLines(body.contents, (content) =>
      extractGeminiParts(content)
    );
    if (contents) {
      parts.push(contents);
    }
    return parts.join("\n");
  }

  return JSON.stringify(body);
}

function extractOpenAiUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  return {
    raw: usage,
    inputTokens: readUsageNumber(coalesceDefined(usage.input_tokens, usage.prompt_tokens)),
    outputTokens: readUsageNumber(
      coalesceDefined(usage.output_tokens, usage.completion_tokens)
    ),
    cachedTokens: readUsageNumber(
      coalesceDefined(
        usage.input_tokens_details && usage.input_tokens_details.cached_tokens,
        usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens
      )
    ),
  };
}

function extractAnthropicUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return null;
  }

  return {
    raw: usage,
    inputTokens: readUsageNumber(usage.input_tokens),
    outputTokens: readUsageNumber(usage.output_tokens),
    cachedTokens: readUsageNumber(usage.cache_read_input_tokens),
  };
}

function extractGeminiUsage(usageMetadata) {
  if (!usageMetadata || typeof usageMetadata !== "object") {
    return null;
  }

  return {
    raw: usageMetadata,
    inputTokens: readUsageNumber(usageMetadata.promptTokenCount),
    outputTokens: readUsageNumber(usageMetadata.candidatesTokenCount),
    cachedTokens: readUsageNumber(usageMetadata.cachedContentTokenCount),
  };
}

function extractOpenAiResponseText(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  if (typeof payload.output_text === "string") {
    return payload.output_text;
  }

  if (Array.isArray(payload.choices)) {
    return payload.choices
      .map((choice) => {
        if (!choice || typeof choice !== "object") {
          return "";
        }

        if (choice.message) {
          return extractOpenAiMessageContent(choice.message.content);
        }

        return extractOpenAiMessageContent(choice.delta && choice.delta.content);
      })
      .filter(Boolean)
      .join("\n");
  }

  if (Array.isArray(payload.output)) {
    return payload.output
      .map((item) => {
        if (!item || typeof item !== "object") {
          return "";
        }
        return collectTextParts(item.content);
      })
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

function extractAnthropicResponseText(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  return collectTextParts(payload.content);
}

function extractGeminiResponseText(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.candidates)) {
    return "";
  }

  return payload.candidates
    .map((candidate) => {
      if (!candidate || typeof candidate !== "object") {
        return "";
      }
      return extractGeminiParts(candidate.content);
    })
    .filter(Boolean)
    .join("\n");
}

function extractErrorMessage(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  if (payload.error && typeof payload.error.message === "string") {
    return payload.error.message;
  }

  if (typeof payload.message === "string" && payload.type === "error") {
    return payload.message;
  }

  return null;
}

function createResponseTracker(options) {
  const {
    apiKind,
    contentType,
    contentLimitChars,
    responseCaptureLimitBytes,
  } = options;

  const state = {
    apiKind,
    isSse: contentType.includes("text/event-stream"),
    decoder: new StringDecoder("utf8"),
    sseBuffer: "",
    rawBody: new LimitedBuffer(responseCaptureLimitBytes),
    fullOutputContent: "",
    outputPreview: "",
    outputChars: 0,
    usage: null,
    usageRaw: null,
    responseId: null,
    modelId: null,
    errorMessage: null,
  };

  function setMetadataFromPayload(payload) {
    if (!payload || typeof payload !== "object") {
      return;
    }
    state.responseId = coalesce(state.responseId, payload.id);
    state.modelId = coalesce(state.modelId, payload.model);
    state.errorMessage = coalesce(state.errorMessage, extractErrorMessage(payload));
  }

  function appendOutput(text) {
    if (!text) {
      return;
    }

    if (text.startsWith(state.outputPreview) && text.length >= state.outputChars) {
      state.outputPreview = text.slice(0, contentLimitChars);
      state.outputChars = text.length;
      return;
    }

    if (state.outputPreview.startsWith(text) && state.outputChars >= text.length) {
      return;
    }

    state.fullOutputContent += text;
    state.outputChars += text.length;
    state.outputPreview = appendLimited(state.outputPreview, text, contentLimitChars);
  }

  function updateUsage(nextUsage) {
    if (!nextUsage) {
      return;
    }
    state.usage = mergeUsage(state.usage, nextUsage);
    state.usageRaw = mergeUsageRaw(state.usageRaw, nextUsage.raw || null);
  }

  function applyPayload(payload) {
    if (!payload || typeof payload !== "object") {
      return;
    }

    setMetadataFromPayload(payload);

    if (apiKind.startsWith("openai")) {
      updateUsage(extractOpenAiUsage(payload.usage));
    }

    if (apiKind.startsWith("anthropic")) {
      updateUsage(extractAnthropicUsage(payload.usage));
    }

    if (apiKind.startsWith("gemini")) {
      updateUsage(extractGeminiUsage(payload.usageMetadata));
    }
  }

  function handleSseEvent(eventName, data) {
    if (!data || data === "[DONE]") {
      return;
    }

    const payload = safeJsonParse(data);
    if (!payload) {
      return;
    }

    if (apiKind === "openai.chat.completions") {
      applyPayload(payload);
      appendOutput(extractOpenAiResponseText(payload));
      return;
    }

    if (apiKind === "openai.responses") {
      const type = payload.type || eventName;
      if (type === "response.output_text.delta" && typeof payload.delta === "string") {
        appendOutput(payload.delta);
      }

      if (type === "response.completed" && payload.response) {
        applyPayload(payload.response);
        appendOutput(extractOpenAiResponseText(payload.response));
      } else {
        applyPayload(payload);
      }

      return;
    }

    if (apiKind === "anthropic.messages") {
      if (eventName === "content_block_delta" && payload.delta) {
        appendOutput(asString(payload.delta.text));
      }
      if (eventName === "message_start" && payload.message) {
        applyPayload(payload.message);
      }
      if (eventName === "message_delta") {
        applyPayload(payload);
      }
      if (eventName === "error") {
        state.errorMessage = coalesce(state.errorMessage, extractErrorMessage(payload));
      }
      return;
    }

    if (apiKind === "gemini.generateContent") {
      applyPayload(payload);
      appendOutput(extractGeminiResponseText(payload));
      return;
    }

    applyPayload(payload);
  }

  function parseSseBlocks(finalChunk) {
    state.sseBuffer += finalChunk;
    const blocks = state.sseBuffer.split(/\r?\n\r?\n/);
    state.sseBuffer = blocks.pop() || "";

    for (const block of blocks) {
      if (!block.trim()) {
        continue;
      }

      let eventName = "message";
      const dataLines = [];
      for (const line of block.split(/\r?\n/)) {
        if (!line || line.startsWith(":")) {
          continue;
        }
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
          continue;
        }
        if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      handleSseEvent(eventName, dataLines.join("\n"));
    }
  }

  return {
    onChunk(chunk) {
      if (state.isSse) {
        parseSseBlocks(state.decoder.write(chunk));
        return;
      }
      state.rawBody.add(chunk);
    },
    finish(statusCode) {
      if (state.isSse) {
        parseSseBlocks(state.decoder.end());
        if (state.sseBuffer.trim()) {
          parseSseBlocks("\n\n");
        }
      } else {
        const bodyText = `${state.rawBody.toString()}${state.decoder.end()}`;
        const payload = safeJsonParse(bodyText);
        if (payload) {
          applyPayload(payload);

          if (apiKind.startsWith("openai")) {
            appendOutput(extractOpenAiResponseText(payload));
          } else if (apiKind.startsWith("anthropic")) {
            appendOutput(extractAnthropicResponseText(payload));
          } else if (apiKind.startsWith("gemini")) {
            appendOutput(extractGeminiResponseText(payload));
          }
        } else if (statusCode >= 400) {
          state.errorMessage = coalesce(state.errorMessage, bodyText || null);
        }
      }

      return {
        responseId: state.responseId,
        modelId: state.modelId,
        outputContent: previewText(
          state.outputPreview,
          state.outputChars,
          contentLimitChars
        ),
        outputChars: state.outputChars,
        outputTokensEstimate: countTextTokens(state.fullOutputContent, {
          modelId: state.modelId,
          apiKind,
        }),
        usage: state.usage,
        usageRaw: state.usageRaw,
        errorMessage: state.errorMessage,
      };
    },
  };
}

function categoryFromApiKind(apiKind) {
  if (typeof apiKind !== "string" || !apiKind) {
    return "generic";
  }

  const dotIndex = apiKind.indexOf(".");
  return dotIndex >= 0 ? apiKind.slice(dotIndex + 1) : apiKind;
}

function detectStream(body, apiKind, upstreamPath) {
  if (body && typeof body === "object" && typeof body.stream === "boolean") {
    return body.stream;
  }

  if (apiKind === "gemini.generateContent") {
    return upstreamPath.includes(":streamGenerateContent") || upstreamPath.includes("alt=sse");
  }

  return false;
}

function parseRequestSnapshot(options) {
  const { provider, headers, upstreamPath, rawBody, contentLimitChars } = options;
  const apiKind = detectApiKind(provider, upstreamPath);
  const body = safeJsonParse(rawBody);
  const metadata = inferMetadata(body, headers, upstreamPath);
  const fullInputContent = extractRequestInput(apiKind, body);
  const inputContent = clampText(fullInputContent, contentLimitChars);

  return {
    apiKind,
    category: categoryFromApiKind(apiKind),
    isStream: detectStream(body, apiKind, upstreamPath),
    requestBody: body,
    modelId: metadata.modelId,
    userId: metadata.userId,
    sessionId: metadata.sessionId,
    requestTag: metadata.requestTag,
    inputContent,
    inputChars: fullInputContent.length,
    inputTokensEstimate: countTextTokens(fullInputContent, {
      modelId: metadata.modelId,
      apiKind,
    }),
  };
}

module.exports = {
  LimitedBuffer,
  clampText,
  createResponseTracker,
  detectApiKind,
  getHeader,
  parseRequestSnapshot,
};

