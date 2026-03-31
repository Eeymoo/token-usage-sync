"use strict";

const http = require("node:http");
const { randomUUID } = require("node:crypto");
const httpProxy = require("http-proxy");

const { getConfig } = require("./config");
const {
  LimitedBuffer,
  createResponseTracker,
  detectApiKind,
  getHeader,
  parseRequestSnapshot,
} = require("./parsers");
const { MetadataSyncService } = require("./metadata-sync");
const { QuotaSyncService } = require("./quota-sync");
const { QuestDbWriter } = require("./questdb-writer");
const { hashApiKey } = require("./api-key");
const { freeEncoders } = require("./tokenizer");

const REQUEST_CONTEXT = Symbol("request-context");

function extractApiKey(req) {
  const authorization = getHeader(req.headers, "authorization");
  if (authorization) {
    const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch && bearerMatch[1]) {
      return bearerMatch[1].trim();
    }
  }

  const xApiKey = getHeader(req.headers, "x-api-key");
  if (xApiKey) {
    return xApiKey.trim();
  }

  return null;
}

function detectDirectRoute(config, urlPath) {
  if (
    urlPath.startsWith("/v1/responses") ||
    urlPath.startsWith("/v1/chat/completions")
  ) {
    return {
      provider: "openai",
      prefix: "",
      target: config.upstreams.openai,
    };
  }

  if (urlPath.startsWith("/v1/messages")) {
    return {
      provider: "anthropic",
      prefix: "",
      target: config.upstreams.anthropic,
    };
  }

  if (
    (urlPath.startsWith("/v1beta/models/") ||
      urlPath.startsWith("/v1/models/")) &&
    (urlPath.includes(":generateContent") ||
      urlPath.includes(":streamGenerateContent"))
  ) {
    return {
      provider: "gemini",
      prefix: "",
      target: config.upstreams.gemini,
    };
  }

  return null;
}

function resolveRoute(config, urlPath) {
  const directRoute = detectDirectRoute(config, urlPath);
  if (directRoute) {
    return directRoute;
  }

  const prefixes = [
    {
      provider: "openai",
      prefix: config.routes.openaiPrefix,
      target: config.upstreams.openai,
    },
    {
      provider: "anthropic",
      prefix: config.routes.anthropicPrefix,
      target: config.upstreams.anthropic,
    },
    {
      provider: "gemini",
      prefix: config.routes.geminiPrefix,
      target: config.upstreams.gemini,
    },
  ];

  for (const route of prefixes) {
    if (urlPath === route.prefix || urlPath.startsWith(`${route.prefix}/`)) {
      return route;
    }
  }

  return null;
}

function stripPrefix(urlPath, prefix) {
  if (!prefix) {
    return urlPath || "/";
  }
  const stripped = urlPath.slice(prefix.length) || "/";
  return stripped.startsWith("/") ? stripped : `/${stripped}`;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function safeStatus(statusCode) {
  return Number.isInteger(statusCode) ? String(statusCode) : "proxy_error";
}

function buildStatus(statusCode, usageSource) {
  return `${safeStatus(statusCode)}_${usageSource}`;
}

function attachRequestCapture(req, context, config) {
  const capture = new LimitedBuffer(config.requestCaptureLimitBytes);
  context.requestCapture = capture;

  req.on("data", (chunk) => {
    capture.add(chunk);
  });

  req.on("end", () => {
    const snapshot = parseRequestSnapshot({
      provider: context.provider,
      headers: req.headers,
      upstreamPath: context.upstreamPath,
      rawBody: capture.toString(),
      contentLimitChars: config.contentLimitChars,
    });

    context.apiKind = snapshot.apiKind;
    context.category = snapshot.category;
    context.isStream = snapshot.isStream;
    context.modelId = snapshot.modelId;
    context.userId = snapshot.userId;
    context.sessionId = snapshot.sessionId;
    context.requestTag = snapshot.requestTag;
    context.inputContent = snapshot.inputContent;
    context.inputChars = snapshot.inputChars;
    context.inputTokensEstimate = snapshot.inputTokensEstimate;
  });
}

function finalizeRequest(context, overrides) {
  if (context.finalized) {
    return;
  }

  context.finalized = true;
  const finishedAt = Date.now();
  const usage = overrides.usage || {};
  const usageSource = overrides.usage ? "reported" : "estimated";
  const record = {
    requestId: overrides.requestId || context.requestId,
    timestamp: context.startedAt,
    provider: context.provider,
    apiKind: context.apiKind,
    category: context.category || null,
    isStream: Boolean(context.isStream),
    modelId: overrides.modelId || context.modelId || null,
    userId: context.userId || null,
    apiKeyHash: context.apiKeyHash || null,
    inputTokens:
      usageSource === "reported"
        ? usage.inputTokens || 0
        : context.inputTokensEstimate || 0,
    outputTokens:
      usageSource === "reported"
        ? usage.outputTokens || 0
        : overrides.outputTokensEstimate || 0,
    cachedTokens: usageSource === "reported" ? usage.cachedTokens || 0 : 0,
    inputChars: context.inputChars || 0,
    outputChars: overrides.outputChars || 0,
    status: buildStatus(overrides.statusCode, usageSource),
    latencyMs: finishedAt - context.startedAt,
    ttftMs:
      typeof context.firstByteAt === "number"
        ? context.firstByteAt - context.startedAt
        : null,
    sessionId: context.sessionId || null,
    requestTag: context.requestTag || null,
    usageJson: overrides.usageRaw ? JSON.stringify(overrides.usageRaw) : null,
    inputContent: context.inputContent || "",
    outputContent: overrides.outputContent || "",
    errorMessage: overrides.errorMessage || null,
  };

  context.writer.write(record);
}

function createApp() {
  const config = getConfig();
  const writer = new QuestDbWriter(config.questdb);
  const metadataSync = new MetadataSyncService({
    questdb: config.questdb,
    metadata: config.metadata || { enabled: false },
  });
  const quotaSync = new QuotaSyncService({
    quota: config.quota || { enabled: false },
    writer,
  });
  const proxy = httpProxy.createProxyServer({
    changeOrigin: true,
    xfwd: true,
    secure: true,
    preserveHeaderKeyCase: true,
  });

  proxy.on("proxyReq", (proxyReq, req) => {
    if (!proxyReq.headersSent) {
      proxyReq.setHeader("accept-encoding", "identity");
    }

    const context = req[REQUEST_CONTEXT];
    if (!context) {
      return;
    }

    if (context.userId && !proxyReq.headersSent) {
      proxyReq.setHeader("x-user-id", context.userId);
    }
  });

  proxy.on("proxyRes", (proxyRes, req) => {
    const context = req[REQUEST_CONTEXT];
    if (!context) {
      return;
    }

    const tracker = createResponseTracker({
      apiKind: context.apiKind,
      contentType: String(proxyRes.headers["content-type"] || ""),
      contentLimitChars: config.contentLimitChars,
      responseCaptureLimitBytes: config.responseCaptureLimitBytes,
    });

    context.responseTracker = tracker;

    proxyRes.on("data", (chunk) => {
      if (!context.firstByteAt) {
        context.firstByteAt = Date.now();
      }
      tracker.onChunk(chunk);
    });

    proxyRes.on("end", () => {
      const summary = tracker.finish(proxyRes.statusCode || 0);
      finalizeRequest(context, {
        statusCode: proxyRes.statusCode || 0,
        requestId:
          getHeader(proxyRes.headers, "x-request-id") ||
          summary.responseId ||
          context.requestId,
        modelId: summary.modelId,
        outputContent: summary.outputContent,
        outputChars: summary.outputChars,
        outputTokensEstimate: summary.outputTokensEstimate,
        usage: summary.usage,
        usageRaw: summary.usageRaw,
        errorMessage: summary.errorMessage,
      });
    });
  });

  proxy.on("error", (error, req, res) => {
    const context = req && req[REQUEST_CONTEXT];
    if (res && !res.headersSent) {
      sendJson(res, 502, {
        error: "proxy_error",
        message: error.message,
      });
    }
    if (context) {
      finalizeRequest(context, {
        statusCode: 502,
        errorMessage: error.message,
      });
    }
  });

  const server = http.createServer((req, res) => {
    if (!req.url) {
      sendJson(res, 400, { error: "invalid_request", message: "Missing URL" });
      return;
    }

    const requestUrl = new URL(req.url, "http://localhost");
    if (requestUrl.pathname === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (requestUrl.pathname === "/hash-api-key") {
      const value = requestUrl.searchParams.get("value");
      if (!value) {
        sendJson(res, 400, {
          error: "invalid_request",
          message: "Missing required query parameter: value",
        });
        return;
      }
      sendJson(res, 200, { api_key_hash: hashApiKey(value) });
      return;
    }

    const route = resolveRoute(config, requestUrl.pathname);
    if (!route) {
      sendJson(res, 404, {
        error: "not_found",
        message:
          "Use direct compatible paths like /v1/chat/completions, /v1/messages, /v1beta/models/{model}:generateContent, or the optional /openai, /anthropic, /gemini prefixes.",
      });
      return;
    }

    const context = {
      requestId: randomUUID(),
      provider: route.provider,
      writer,
      startedAt: Date.now(),
      upstreamPath:
        stripPrefix(requestUrl.pathname, route.prefix) + requestUrl.search,
      apiKind: detectApiKind(
        route.provider,
        stripPrefix(requestUrl.pathname, route.prefix) + requestUrl.search,
      ),
      category: null,
      isStream: false,
      finalized: false,
      firstByteAt: null,
      inputContent: "",
      inputChars: 0,
      apiKeyHash: null,
    };

    const apiKey = extractApiKey(req);
    if (apiKey) {
      context.apiKeyHash = hashApiKey(apiKey);
    }

    req[REQUEST_CONTEXT] = context;
    attachRequestCapture(req, context, config);

    req.url = context.upstreamPath;

    proxy.web(req, res, { target: route.target });
  });

  let shutdownStarted = false;
  async function shutdown(signal) {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    console.log(`Shutting down on ${signal}`);
    await metadataSync.stop();
    await quotaSync.stop();
    await new Promise((resolve) => server.close(resolve));
    await writer.close();
    freeEncoders();
  }

  process.once("SIGINT", () => {
    shutdown("SIGINT").finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM").finally(() => process.exit(0));
  });

  server.on("close", async () => {
    await metadataSync.stop();
    await quotaSync.stop();
    await writer.close();
    freeEncoders();
  });

  return {
    async start() {
      await new Promise((resolve) => {
        server.listen(config.port, resolve);
      });
      metadataSync.start();
      quotaSync.start();
      console.log(`Proxy listening on :${config.port}`);
    },
    server,
  };
}

module.exports = {
  createApp,
};
