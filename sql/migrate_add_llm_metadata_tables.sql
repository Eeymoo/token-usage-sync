CREATE TABLE IF NOT EXISTS 'token_usage_vendors' (
  id STRING,
  name STRING,
  api STRING,
  doc STRING,
  iconURL STRING,
  modelCount INT
) WAL;

CREATE TABLE IF NOT EXISTS 'token_usage_models' (
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
