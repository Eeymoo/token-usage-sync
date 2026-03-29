# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This repository is a low-latency Node.js reverse proxy for LLM APIs. It forwards requests to OpenAI-, Anthropic-, and Gemini-compatible upstreams while passively capturing request/response bodies to compute and persist token-usage telemetry in QuestDB.

The design goal is to avoid buffering full upstream responses before forwarding them. The proxy streams through `http-proxy`, tracks request/response data on the side, and writes two QuestDB tables:
- `token_usage_requests_stats`
- `token_usage_requests_records`

## Common commands

- Install deps: `npm install`
- Start locally: `npm start`
- Run tests: `npm test`
- Run one test file: `node --test test/parsers.test.js`
- Build Docker image: `docker build -t token-usage-sync .`
- Start with Compose: `docker compose up -d --build`
- Follow Compose logs: `docker compose logs -f token-usage-sync`
- Apply schema: execute `sql/schema.sql` in QuestDB
- Apply migration for existing tables: execute `sql/migrate_add_provider_usage_json.sql` in QuestDB

## Runtime shape

- Entry point is `index.js`, which creates the app from `src/server.js` and starts the HTTP server.
- `src/server.js` owns routing, proxying, health checks, request lifecycle tracking, graceful shutdown, and final log-record assembly.
- Requests are routed either by direct compatible paths (`/v1/...`, `/v1beta/...`) or optional provider prefixes (`/openai`, `/anthropic`, `/gemini`).
- `/healthz` is handled locally and is used by Docker/Nginx health checks.

## Core architecture

### Request/response pipeline

1. `src/server.js` resolves the provider from the incoming path and rewrites the upstream path when a provider prefix is used.
2. Request bodies are captured with `LimitedBuffer` and parsed after request end via `parseRequestSnapshot()` in `src/parsers.js`.
3. The upstream request is proxied with `http-proxy`. The proxy forces `accept-encoding: identity` so response bodies remain parseable.
4. Response bodies are tracked incrementally with `createResponseTracker()` in `src/parsers.js`, including SSE handling for streaming APIs.
5. On response end or proxy error, `finalizeRequest()` in `src/server.js` assembles the final record and writes it through `QuestDbWriter`.

### Parsing and token estimation

`src/parsers.js` is the protocol-specific normalization layer. It:
- detects the API kind (`openai.responses`, `openai.chat.completions`, `anthropic.messages`, `gemini.generateContent`)
- extracts model/user/session/tag metadata from headers and bodies
- normalizes request input text across provider-specific payload shapes
- parses both JSON and SSE responses
- merges usage events across Anthropic/OpenAI streaming responses
- falls back to local token estimation when upstream usage is absent

`src/tokenizer.js` wraps `@dqbd/tiktoken` and caches encoders by model/api kind. Estimated tokens are used as fallback for input/output when providers omit usage.

### Persistence model

`src/questdb-writer.js` serializes writes through a promise chain so QuestDB writes stay ordered. Each finalized request writes:
- one summary row to `token_usage_requests_stats`
- one detailed row to `token_usage_requests_records`

Common columns are defined in `sql/schema.sql`; `usage_json` preserves provider-native usage payloads for fields that do not fit the normalized columns.

## Provider/protocol notes

- OpenAI-compatible traffic supports both `/v1/responses` and `/v1/chat/completions`.
- Anthropic-compatible traffic is handled through `/v1/messages`.
- Gemini-compatible traffic is detected from `:generateContent` and `:streamGenerateContent` model endpoints under `/v1beta/models/...` or `/v1/models/...`.
- `status` values are stored as `HTTPSTATUS_source`, e.g. `200_reported` or `200_estimated`.
- Request/response content is truncated by `CONTENT_LIMIT_CHARS`; raw capture size is bounded separately by request/response byte limits.

## Configuration

Environment parsing lives in `src/config.js`.

Important variables:
- `PORT`
- `QUESTDB_CONFIG` or `QUESTDB_ADDR` plus optional auth vars
- `QUESTDB_ENABLED`
- `OPENAI_BASE_URL`
- `ANTHROPIC_BASE_URL`
- `GEMINI_BASE_URL`
- `OPENAI_PROXY_PREFIX`
- `ANTHROPIC_PROXY_PREFIX`
- `GEMINI_PROXY_PREFIX`
- `REQUEST_CAPTURE_LIMIT_BYTES`
- `RESPONSE_CAPTURE_LIMIT_BYTES`
- `CONTENT_LIMIT_CHARS`

If `QUESTDB_CONFIG` is not set, the app builds a config string from `QUESTDB_ADDR` and optional auth env vars.

## Deployment files

- `Dockerfile` builds a production Node 22 image and copies `src/`, `sql/`, and runtime package files.
- `docker-compose.yml` runs the app behind an internal Nginx gateway and wires health checks plus environment defaults.
- `nginx.conf` forwards `/v1/` and `/v1beta/` traffic to the proxy, with a fallback upstream to `new-api.onemue.cn` on 502/503/504.

## Tests

Current automated coverage is concentrated in `test/parsers.test.js` and validates protocol parsing and streaming usage aggregation. If changing request/response normalization, start there.
