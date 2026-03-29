ALTER TABLE token_usage_requests_stats ADD COLUMN provider STRING;
ALTER TABLE token_usage_requests_stats ADD COLUMN api_kind STRING;
ALTER TABLE token_usage_requests_stats ADD COLUMN usage_json STRING;

ALTER TABLE token_usage_requests_records ADD COLUMN provider STRING;
ALTER TABLE token_usage_requests_records ADD COLUMN api_kind STRING;
ALTER TABLE token_usage_requests_records ADD COLUMN usage_json STRING;
