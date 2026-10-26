CREATE TABLE models (
  model TEXT PRIMARY KEY,
  config TEXT NOT NULL
);

CREATE TABLE api_keys (
  key TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  models TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE backend_stats_minute (
  backend_id TEXT NOT NULL,
  minute INTEGER NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  failure INTEGER NOT NULL DEFAULT 0,
  streaming_ttft_sum REAL NOT NULL DEFAULT 0,
  streaming_ttft_count INTEGER NOT NULL DEFAULT 0,
  non_streaming_ttft_sum REAL NOT NULL DEFAULT 0,
  non_streaming_ttft_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (backend_id, minute)
);
CREATE INDEX idx_backend_stats_minute ON backend_stats_minute (minute);

CREATE TABLE affinity_mappings (
  model TEXT NOT NULL,
  session_id TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (model, session_id)
);
CREATE INDEX idx_affinity_backend ON affinity_mappings (backend_id);
CREATE INDEX idx_affinity_last_accessed ON affinity_mappings (last_accessed_at);

CREATE TABLE recorded_requests (
  id TEXT PRIMARY KEY,
  backend_id TEXT NOT NULL,
  model TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  url TEXT NOT NULL,
  headers TEXT NOT NULL,
  response_status INTEGER,
  response_headers TEXT,
  response_error TEXT,
  response_truncated INTEGER NOT NULL DEFAULT 0,
  response_completed_at INTEGER
);
CREATE INDEX idx_recorded_backend ON recorded_requests (backend_id, timestamp);
CREATE INDEX idx_recorded_model ON recorded_requests (model, timestamp);
CREATE INDEX idx_recorded_timestamp ON recorded_requests (timestamp);
