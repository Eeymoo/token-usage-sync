CREATE TABLE 'token_usage_requests_stats' (
  request_id STRING,
  timestamp TIMESTAMP,
  provider STRING,
  category STRING,
  is_stream BOOLEAN,
  api_kind STRING,
  model_id STRING,
  user_id STRING,
  input_tokens INT,
  output_tokens INT,
  cached_tokens INT,
  input_chars INT,
  output_chars INT,
  status STRING,
  latency_ms INT,
  ttft_ms INT,
  session_id STRING,
  request_tag STRING,
  api_key_hash STRING,
  usage_json STRING
) timestamp (timestamp) PARTITION BY DAY WAL;

CREATE TABLE 'token_usage_requests_records' (
  request_id STRING,
  timestamp TIMESTAMP,
  provider STRING,
  category STRING,
  is_stream BOOLEAN,
  api_kind STRING,
  model_id STRING,
  user_id STRING,
  input_tokens INT,
  output_tokens INT,
  cached_tokens INT,
  input_chars INT,
  output_chars INT,
  status STRING,
  latency_ms INT,
  ttft_ms INT,
  session_id STRING,
  request_tag STRING,
  api_key_hash STRING,
  usage_json STRING,
  input_content STRING,
  output_content STRING,
  error_msg STRING
) timestamp (timestamp) PARTITION BY DAY WAL;

CREATE TABLE 'token_usage_vendors' (
  id STRING,
  name STRING,
  api STRING,
  doc STRING,
  iconURL STRING,
  modelCount INT
) WAL;

CREATE TABLE 'token_usage_models' (
  attachment BOOLEAN,
  cost_input DOUBLE,
  cost_output DOUBLE,
  description STRING,
  family STRING,
  id STRING,
  last_updated TIMESTAMP,
  limit_context INT,
  limit_output INT,
  modalities_input STRING,
  modalities_output STRING,
  name STRING,
  open_weights BOOLEAN,
  reasoning BOOLEAN,
  release_date TIMESTAMP,
  temperature BOOLEAN,
  tool_call BOOLEAN
) WAL;
