"use strict";

const http = require("node:http");
const { createHmac, randomUUID, timingSafeEqual } = require("node:crypto");
const { Readable } = require("node:stream");
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
const { ModelMappingStore } = require("./model-mapping-store");
const { freeEncoders } = require("./tokenizer");

const REQUEST_CONTEXT = Symbol("request-context");
const ADMIN_SESSION_COOKIE = "admin_session";

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
  });
  res.end(html);
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) {
    return cookies;
  }

  for (const part of String(cookieHeader).split(";")) {
    const trimmed = part.trim();
    if (!trimmed) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!key) {
      continue;
    }
    cookies[key] = value;
  }

  return cookies;
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    let settled = false;

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    };

    const onData = (chunk) => {
      if (settled) {
        return;
      }
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        cleanup();
        req.pause();
        reject(new Error(`Body too large (>${maxBytes} bytes)`));
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };

    const onError = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function safeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function signAdminSession(payload, sessionSecret) {
  return createHmac("sha256", sessionSecret).update(payload).digest("hex");
}

function createAdminSessionCookie(config) {
  const expiresAt =
    Math.floor(Date.now() / 1000) + Math.max(1, config.admin.sessionMaxAgeSeconds);
  const tokenHashPrefix = hashApiKey(config.admin.webToken).slice(0, 16);
  const payload = `${expiresAt}.${tokenHashPrefix}`;
  const signature = signAdminSession(payload, config.admin.sessionSecret);
  return `${payload}.${signature}`;
}

function isAdminAuthenticated(req, config) {
  if (!config.admin.webToken) {
    return false;
  }

  const cookies = parseCookies(req.headers.cookie);
  const sessionValue = cookies[ADMIN_SESSION_COOKIE];
  if (!sessionValue) {
    return false;
  }

  const parts = sessionValue.split(".");
  if (parts.length !== 3) {
    return false;
  }

  const [expiresAtRaw, tokenHashPrefix, signature] = parts;
  const payload = `${expiresAtRaw}.${tokenHashPrefix}`;
  const expected = signAdminSession(payload, config.admin.sessionSecret);
  if (!safeEqualString(signature, expected)) {
    return false;
  }

  const expiresAt = Number.parseInt(expiresAtRaw, 10);
  if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    return false;
  }

  return true;
}

function buildSessionCookieHeader(config, value, maxAgeSeconds) {
  const parts = [
    `${ADMIN_SESSION_COOKIE}=${value}`,
    "Path=/admin",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (maxAgeSeconds <= 0) {
    parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  }
  return parts.join("; ");
}

function renderLoginPage() {
  return [
    "<!doctype html>",
    "<html lang=\"zh-CN\">",
    "<head>",
    "  <meta charset=\"utf-8\" />",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
    "  <title>Token 登录</title>",
    "  <style>",
    "    :root { --bg: #f3efe6; --card: #fff8ed; --text: #1f1b16; --accent: #c45b1e; --muted: #7b6f64; }",
    "    * { box-sizing: border-box; }",
    "    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: 'Avenir Next', 'Noto Sans SC', sans-serif; background: radial-gradient(circle at 20% 20%, #ffe6c9 0%, #f3efe6 45%, #e8e2d8 100%); color: var(--text); }",
    "    .card { width: min(460px, 92vw); background: var(--card); border: 1px solid #ead7c1; border-radius: 20px; padding: 28px; box-shadow: 0 18px 40px rgba(65, 38, 17, 0.12); }",
    "    h1 { margin: 0 0 10px; font-size: 28px; letter-spacing: 0.02em; }",
    "    p { margin: 0 0 18px; color: var(--muted); }",
    "    label { display: block; margin-bottom: 8px; font-weight: 600; }",
    "    input { width: 100%; border: 1px solid #d9c5ad; border-radius: 12px; padding: 12px 14px; font-size: 16px; background: #fffcf6; }",
    "    button { margin-top: 14px; width: 100%; border: 0; border-radius: 12px; padding: 12px 14px; background: linear-gradient(120deg, #c45b1e, #d97b29); color: #fff; font-size: 16px; font-weight: 700; cursor: pointer; }",
    "    .tip { margin-top: 12px; min-height: 22px; color: #8a2d12; }",
    "  </style>",
    "</head>",
    "<body>",
    "  <main class=\"card\">",
    "    <h1>Token 登录</h1>",
    "    <p>输入管理 Token 进入模型映射配置页面。</p>",
    "    <form id=\"login-form\">",
    "      <label for=\"token\">管理 Token</label>",
    "      <input id=\"token\" name=\"token\" type=\"password\" autocomplete=\"current-password\" required />",
    "      <button type=\"submit\">登录</button>",
    "      <div class=\"tip\" id=\"tip\"></div>",
    "    </form>",
    "  </main>",
    "  <script>",
    "    const form = document.getElementById('login-form');",
    "    const tip = document.getElementById('tip');",
    "    form.addEventListener('submit', async (event) => {",
    "      event.preventDefault();",
    "      tip.textContent = '登录中...';",
    "      const token = document.getElementById('token').value;",
    "      const response = await fetch('/admin/api/login', {",
    "        method: 'POST',",
    "        headers: { 'content-type': 'application/json' },",
    "        body: JSON.stringify({ token }),",
    "      });",
    "      if (response.ok) {",
    "        location.href = '/admin/mappings';",
    "        return;",
    "      }",
    "      const payload = await response.json().catch(() => ({}));",
    "      tip.textContent = payload.message || '登录失败，请检查 Token';",
    "    });",
    "  </script>",
    "</body>",
    "</html>",
  ].join("\n");
}

function renderMappingPage() {
  return [
    "<!doctype html>",
    "<html lang=\"zh-CN\">",
    "<head>",
    "  <meta charset=\"utf-8\" />",
    "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
    "  <title>模型映射配置</title>",
    "  <style>",
    "    :root { --bg1: #f5f7dc; --bg2: #dbe8cf; --card: #fefef8; --line: #d1dcc0; --text: #232c1e; --accent: #296a37; --danger: #9f2e2e; --muted: #5f6b57; }",
    "    * { box-sizing: border-box; }",
    "    body { margin: 0; min-height: 100vh; font-family: 'DIN Alternate', 'Noto Sans SC', sans-serif; color: var(--text); background: linear-gradient(145deg, var(--bg1), var(--bg2)); padding: 24px; }",
    "    .wrap { max-width: 960px; margin: 0 auto; background: var(--card); border: 1px solid var(--line); border-radius: 20px; overflow: hidden; box-shadow: 0 24px 50px rgba(35, 44, 30, 0.12); }",
    "    .head { padding: 20px 24px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--line); }",
    "    .head h1 { margin: 0; font-size: 24px; }",
    "    .head p { margin: 4px 0 0; color: var(--muted); font-family: 'Avenir Next', 'Noto Sans SC', sans-serif; }",
    "    .actions button { border: 0; border-radius: 10px; padding: 9px 14px; font-weight: 700; cursor: pointer; }",
    "    #save { background: var(--accent); color: #fff; }",
    "    #logout { background: #e7eee0; color: #293124; margin-left: 8px; }",
    "    table { width: 100%; border-collapse: collapse; }",
    "    th, td { border-bottom: 1px solid var(--line); padding: 12px 14px; text-align: left; }",
    "    th { background: #f3f8eb; font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: #516149; }",
    "    input { width: 100%; padding: 10px 12px; border: 1px solid #c8d4ba; border-radius: 10px; font-size: 14px; }",
    "    .remove { background: #fceaea; color: var(--danger); border: 0; border-radius: 8px; padding: 8px 10px; cursor: pointer; }",
    "    .foot { padding: 14px; display: flex; justify-content: space-between; align-items: center; }",
    "    #add { border: 1px dashed #84a378; background: #eef6e9; color: #1d5327; border-radius: 10px; padding: 8px 12px; cursor: pointer; }",
    "    #tip { color: var(--muted); min-height: 20px; }",
    "    @media (max-width: 680px) { .head { display: block; } .actions { margin-top: 10px; } }",
    "  </style>",
    "</head>",
    "<body>",
    "  <section class=\"wrap\">",
    "    <header class=\"head\">",
    "      <div>",
    "        <h1>模型映射配置</h1>",
    "        <p>例如：将调用侧的别名映射到真实模型名。</p>",
    "      </div>",
    "      <div class=\"actions\">",
    "        <button id=\"save\">保存映射</button>",
    "        <button id=\"logout\">退出</button>",
    "      </div>",
    "    </header>",
    "    <table>",
    "      <thead>",
    "        <tr><th>别名（调用侧）</th><th>目标模型（上游）</th><th>操作</th></tr>",
    "      </thead>",
    "      <tbody id=\"rows\"></tbody>",
    "    </table>",
    "    <div class=\"foot\">",
    "      <button id=\"add\">新增一行</button>",
    "      <div id=\"tip\"></div>",
    "    </div>",
    "  </section>",
    "  <script>",
    "    const rows = document.getElementById('rows');",
    "    const tip = document.getElementById('tip');",
    "    const add = document.getElementById('add');",
    "    const save = document.getElementById('save');",
    "    const logout = document.getElementById('logout');",
    "",
    "    function row(alias = '', target = '') {",
    "      const tr = document.createElement('tr');",
    "      tr.innerHTML = '<td><input class=\"alias\" value=\"' + alias.replace(/\"/g, '&quot;') + '\" /></td>' +",
    "        '<td><input class=\"target\" value=\"' + target.replace(/\"/g, '&quot;') + '\" /></td>' +",
    "        '<td><button class=\"remove\" type=\"button\">删除</button></td>';",
    "      tr.querySelector('.remove').addEventListener('click', () => tr.remove());",
    "      rows.appendChild(tr);",
    "    }",
    "",
    "    async function load() {",
    "      const response = await fetch('/admin/api/mappings');",
    "      if (response.status === 401) { location.href = '/admin/login'; return; }",
    "      const payload = await response.json();",
    "      rows.innerHTML = '';",
    "      (payload.mappings || []).forEach((item) => row(item.alias || '', item.target || ''));",
    "      if (!rows.children.length) { row(); }",
    "      tip.textContent = payload.updatedAt ? ('上次更新：' + payload.updatedAt) : '暂无映射，先新增一条';",
    "    }",
    "",
    "    function collectMappings() {",
    "      return Array.from(rows.querySelectorAll('tr')).map((tr) => ({",
    "        alias: tr.querySelector('.alias').value.trim(),",
    "        target: tr.querySelector('.target').value.trim(),",
    "      })).filter((item) => item.alias && item.target);",
    "    }",
    "",
    "    add.addEventListener('click', () => row());",
    "    save.addEventListener('click', async () => {",
    "      tip.textContent = '保存中...';",
    "      const response = await fetch('/admin/api/mappings', {",
    "        method: 'PUT',",
    "        headers: { 'content-type': 'application/json' },",
    "        body: JSON.stringify({ mappings: collectMappings() }),",
    "      });",
    "      const payload = await response.json().catch(() => ({}));",
    "      if (!response.ok) { tip.textContent = payload.message || '保存失败'; return; }",
    "      tip.textContent = '保存成功，更新时间：' + payload.updatedAt;",
    "      load();",
    "    });",
    "",
    "    logout.addEventListener('click', async () => {",
    "      await fetch('/admin/api/logout', { method: 'POST' });",
    "      location.href = '/admin/login';",
    "    });",
    "",
    "    load();",
    "  </script>",
    "</body>",
    "</html>",
  ].join("\n");
}

function rewriteRequestModel(rawBody, provider, mappingStore) {
  if (!rawBody || (provider !== "openai" && provider !== "anthropic")) {
    return { rawBody, mappedFrom: null, mappedTo: null };
  }

  try {
    const payload = JSON.parse(rawBody);
    if (!payload || typeof payload !== "object" || typeof payload.model !== "string") {
      return { rawBody, mappedFrom: null, mappedTo: null };
    }

    const aliasModel = payload.model;
    const mappedModel = mappingStore.getTargetModel(aliasModel);
    if (!mappedModel) {
      return { rawBody, mappedFrom: null, mappedTo: null };
    }

    payload.model = mappedModel;
    return {
      rawBody: JSON.stringify(payload),
      mappedFrom: aliasModel,
      mappedTo: mappedModel,
    };
  } catch {
    return { rawBody, mappedFrom: null, mappedTo: null };
  }
}

function rewriteGeminiPath(urlPath, mappingStore) {
  const modelPathPattern = /^(\/v1(?:beta)?\/models\/)([^/:]+)(:generateContent|:streamGenerateContent)$/;
  const match = urlPath.match(modelPathPattern);
  if (!match) {
    return { path: urlPath, mappedFrom: null, mappedTo: null };
  }

  const [, prefix, encodedModel, suffix] = match;
  const modelAlias = decodeURIComponent(encodedModel);
  const mappedModel = mappingStore.getTargetModel(modelAlias);
  if (!mappedModel) {
    return { path: urlPath, mappedFrom: null, mappedTo: null };
  }

  return {
    path: `${prefix}${encodeURIComponent(mappedModel)}${suffix}`,
    mappedFrom: modelAlias,
    mappedTo: mappedModel,
  };
}

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
    modelMappedFrom: context.modelMappedFrom || null,
    modelMappedTo: context.modelMappedTo || null,
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
  const mappingStore = new ModelMappingStore(config.modelMapping.filePath);
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

    if (context.forwardBodyBuffer && !proxyReq.headersSent) {
      proxyReq.setHeader("content-length", context.forwardBodyBuffer.length);
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

  async function handleRequest(req, res) {
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

    if (requestUrl.pathname === "/admin/login" && req.method === "GET") {
      sendHtml(res, 200, renderLoginPage());
      return;
    }

    if (requestUrl.pathname === "/admin/api/login" && req.method === "POST") {
      if (!config.admin.webToken) {
        sendJson(res, 503, {
          error: "admin_disabled",
          message: "ADMIN_WEB_TOKEN is not configured",
        });
        return;
      }

      let body;
      try {
        body = JSON.parse(await readRawBody(req, 64 * 1024));
      } catch {
        sendJson(res, 400, {
          error: "invalid_request",
          message: "Invalid JSON body",
        });
        return;
      }

      if (!body || typeof body.token !== "string") {
        sendJson(res, 400, {
          error: "invalid_request",
          message: "Missing token",
        });
        return;
      }

      if (!safeEqualString(body.token, config.admin.webToken)) {
        sendJson(res, 401, {
          error: "unauthorized",
          message: "Token invalid",
        });
        return;
      }

      const sessionValue = createAdminSessionCookie(config);
      res.setHeader(
        "set-cookie",
        buildSessionCookieHeader(
          config,
          sessionValue,
          Math.max(1, config.admin.sessionMaxAgeSeconds),
        ),
      );
      sendJson(res, 200, { ok: true });
      return;
    }

    if (requestUrl.pathname === "/admin/api/logout" && req.method === "POST") {
      res.setHeader("set-cookie", buildSessionCookieHeader(config, "", 0));
      sendJson(res, 200, { ok: true });
      return;
    }

    if (requestUrl.pathname === "/admin/mappings" && req.method === "GET") {
      if (!isAdminAuthenticated(req, config)) {
        res.writeHead(302, { location: "/admin/login" });
        res.end();
        return;
      }

      sendHtml(res, 200, renderMappingPage());
      return;
    }

    if (requestUrl.pathname === "/admin/api/mappings") {
      if (!isAdminAuthenticated(req, config)) {
        sendJson(res, 401, {
          error: "unauthorized",
          message: "Login required",
        });
        return;
      }

      await mappingStore.ensureLoaded();

      if (req.method === "GET") {
        sendJson(res, 200, mappingStore.getState());
        return;
      }

      if (req.method === "PUT") {
        let body;
        try {
          body = JSON.parse(await readRawBody(req, 256 * 1024));
        } catch {
          sendJson(res, 400, {
            error: "invalid_request",
            message: "Invalid JSON body",
          });
          return;
        }

        if (!body || !Array.isArray(body.mappings)) {
          sendJson(res, 400, {
            error: "invalid_request",
            message: "mappings must be an array",
          });
          return;
        }

        const saved = await mappingStore.saveMappings(body.mappings);
        sendJson(res, 200, saved);
        return;
      }

      sendJson(res, 405, {
        error: "method_not_allowed",
        message: "Use GET or PUT",
      });
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

    await mappingStore.ensureLoaded();

    const baseUpstreamPath = stripPrefix(requestUrl.pathname, route.prefix);
    const geminiPathRewrite =
      route.provider === "gemini"
        ? rewriteGeminiPath(baseUpstreamPath, mappingStore)
        : { path: baseUpstreamPath, mappedFrom: null, mappedTo: null };

    const context = {
      requestId: randomUUID(),
      provider: route.provider,
      writer,
      startedAt: Date.now(),
      upstreamPath: geminiPathRewrite.path + requestUrl.search,
      apiKind: detectApiKind(
        route.provider,
        geminiPathRewrite.path + requestUrl.search,
      ),
      category: null,
      isStream: false,
      finalized: false,
      firstByteAt: null,
      inputContent: "",
      inputChars: 0,
      apiKeyHash: null,
      modelMappedFrom: geminiPathRewrite.mappedFrom,
      modelMappedTo: geminiPathRewrite.mappedTo,
    };

    const apiKey = extractApiKey(req);
    if (apiKey) {
      context.apiKeyHash = hashApiKey(apiKey);
    }

    req[REQUEST_CONTEXT] = context;
    attachRequestCapture(req, context, config);

    req.url = context.upstreamPath;

    const isJsonBodyRequest =
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      String(getHeader(req.headers, "content-type") || "")
        .toLowerCase()
        .includes("application/json");

    const rewriteMaxBytes = config.requestCaptureLimitBytes;
    const declaredLength = Number.parseInt(
      String(getHeader(req.headers, "content-length") || ""),
      10,
    );
    const declaredTooLarge =
      Number.isFinite(declaredLength) && declaredLength > rewriteMaxBytes;

    if (
      isJsonBodyRequest &&
      (route.provider === "openai" || route.provider === "anthropic") &&
      !declaredTooLarge
    ) {
      let rawBody;
      try {
        rawBody = await readRawBody(req, rewriteMaxBytes);
      } catch (error) {
        if (context && !context.finalized) {
          finalizeRequest(context, {
            statusCode: 499,
            errorMessage: error.message,
          });
        }
        sendJson(res, 413, {
          error: "request_too_large",
          message: error.message,
        });
        return;
      }

      const rewriteResult = rewriteRequestModel(rawBody, route.provider, mappingStore);
      if (rewriteResult.mappedFrom && rewriteResult.mappedTo) {
        context.modelMappedFrom = rewriteResult.mappedFrom;
        context.modelMappedTo = rewriteResult.mappedTo;
      }

      context.forwardBodyBuffer = Buffer.from(rewriteResult.rawBody, "utf8");

      proxy.web(req, res, {
        target: route.target,
        buffer: Readable.from([context.forwardBodyBuffer]),
      });
      return;
    }

    proxy.web(req, res, { target: route.target });
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: "internal_error",
          message: error.message,
        });
      }
    });
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
      await mappingStore.ensureLoaded();
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
