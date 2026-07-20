ALTER TABLE token_usage_requests_stats ADD COLUMN model_mapped_from STRING;
ALTER TABLE token_usage_requests_stats ADD COLUMN model_mapped_to STRING;

ALTER TABLE token_usage_requests_records ADD COLUMN model_mapped_from STRING;
ALTER TABLE token_usage_requests_records ADD COLUMN model_mapped_to STRING;
