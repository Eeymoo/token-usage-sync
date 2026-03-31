CREATE TABLE IF NOT EXISTS 'token_usage_quota_limits' (
  sync_id STRING,
  timestamp TIMESTAMP,
  source STRING,
  status STRING,
  level STRING,
  limit_type STRING,
  unit INT,
  limit_number INT,
  usage INT,
  current_value INT,
  remaining INT,
  percentage DOUBLE,
  next_reset_at STRING,
  usage_json STRING
) timestamp (timestamp) PARTITION BY DAY WAL;

CREATE TABLE IF NOT EXISTS 'token_usage_quota_usage_details' (
  sync_id STRING,
  timestamp TIMESTAMP,
  source STRING,
  limit_type STRING,
  model_code STRING,
  usage INT
) timestamp (timestamp) PARTITION BY DAY WAL;
