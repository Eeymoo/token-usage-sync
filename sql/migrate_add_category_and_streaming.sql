ALTER TABLE token_usage_requests_stats ADD COLUMN category STRING;
ALTER TABLE token_usage_requests_stats ADD COLUMN is_stream BOOLEAN;

ALTER TABLE token_usage_requests_records ADD COLUMN category STRING;
ALTER TABLE token_usage_requests_records ADD COLUMN is_stream BOOLEAN;
