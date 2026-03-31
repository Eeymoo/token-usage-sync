# token-usage-sync

一个低额外延迟的 LLM API 反向代理。

- 使用 `http-proxy` 直接转发请求和流式响应
- 被动旁路采集请求体与响应体，不做整包转发前缓冲
- 使用 `@questdb/nodejs-client` 将统计行和明细行写入 QuestDB
- 支持 OpenAI Responses、OpenAI Chat Completions、Gemini Generate Content、Anthropic Claude Messages 兼容格式
- 适合挂在同一个根域名下的 Nginx 代理层后面，通过路径区分协议格式

## Install

```bash
npm i -s @questdb/nodejs-client http-proxy
```

## Start

```bash
PORT=8787 \
QUESTDB_CONFIG='http::addr=127.0.0.1:9000' \
node index.js
```

## Docker

```bash
docker build -t token-usage-sync .
docker run --rm -p 8787:8787 \
  -e QUESTDB_CONFIG='http::addr=host.docker.internal:9000' \
  token-usage-sync
```

使用 Compose：

```bash
docker compose up -d --build
docker compose logs -f token-usage-sync
```

也可以拆开配置：

```bash
PORT=8787
QUESTDB_ADDR=127.0.0.1:9000
OPENAI_BASE_URL=https://api.openai.com
ANTHROPIC_BASE_URL=https://api.anthropic.com
GEMINI_BASE_URL=https://generativelanguage.googleapis.com
```

## Routes

- Nginx 直接透传同根域名路径
- `POST /v1/responses`
- `POST /v1/chat/completions`
- `POST /v1/messages`
- `POST /v1beta/models/{model}:generateContent`
- `POST /v1beta/models/{model}:streamGenerateContent?alt=sse`

- 可选前缀路径
- `POST /openai/v1/responses`
- `POST /openai/v1/chat/completions`
- `POST /anthropic/v1/messages`
- `POST /gemini/v1beta/models/{model}:generateContent`
- `POST /gemini/v1beta/models/{model}:streamGenerateContent?alt=sse`

## QuestDB Schema

先执行 [sql/schema.sql](/home/eeymoo/Codes/token-usage-sync/sql/schema.sql)。
如果表已经存在，再执行 [sql/migrate_add_provider_usage_json.sql](/home/eeymoo/Codes/token-usage-sync/sql/migrate_add_provider_usage_json.sql) 补齐新列。
如果需要补齐模型元数据表，再执行 [sql/migrate_add_llm_metadata_tables.sql](/home/eeymoo/Codes/token-usage-sync/sql/migrate_add_llm_metadata_tables.sql)。

## Logged Fields

写入两张表：

- `token_usage_requests_stats`
- `token_usage_requests_records`

公共字段：

- `request_id`
- `provider`
- `api_kind`
- `timestamp`
- `model_id`
- `user_id`
- `input_tokens`
- `output_tokens`
- `cached_tokens`
- `input_chars`
- `output_chars`
- `status`
- `latency_ms`
- `ttft_ms`
- `session_id`
- `request_tag`
- `usage_json`

明细表额外字段：

- `input_content`
- `output_content`
- `error_msg`

## Notes

- 为了可解析日志，代理会把上游 `accept-encoding` 固定为 `identity`。
- `REQUEST_CAPTURE_LIMIT_BYTES`、`RESPONSE_CAPTURE_LIMIT_BYTES`、`CONTENT_LIMIT_CHARS` 可调。
- 如果上游未返回 usage，代理会使用 `@dqbd/tiktoken` 在本地估算输入输出 token，避免出现空值。
- `status` 格式为 `HTTP状态_usage来源`，例如 `200_reported`、`200_estimated`。
- `usage_json` 会保留上游原始 usage 结构，方便查询 Anthropic 的 `cache_creation_input_tokens`、`cache_read_input_tokens` 等协议特有字段。
- 服务启动后会先立即同步一次，之后再按 `LLM_METADATA_SYNC_CRON` 定时从 `LLM_METADATA_SYNC_URL` 拉取 vendors/models，并通过 QuestDB `/imp?overwrite=true` 全量覆盖 `token_usage_vendors`、`token_usage_models`；默认 cron 为每天 `03:00`。
