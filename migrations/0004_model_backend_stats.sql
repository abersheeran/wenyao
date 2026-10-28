CREATE TABLE backend_stats_minute_new (
  model TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  minute INTEGER NOT NULL,
  total INTEGER NOT NULL DEFAULT 0,
  success INTEGER NOT NULL DEFAULT 0,
  failure INTEGER NOT NULL DEFAULT 0,
  streaming_ttft_sum REAL NOT NULL DEFAULT 0,
  streaming_ttft_count INTEGER NOT NULL DEFAULT 0,
  non_streaming_ttft_sum REAL NOT NULL DEFAULT 0,
  non_streaming_ttft_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (model, backend_id, minute)
);

-- Only an ID belonging to exactly one model has recoverable historical data.
-- Include disabled backends; repeated IDs within one config still have one owner.
INSERT INTO backend_stats_minute_new
  (model, backend_id, minute, total, success, failure, streaming_ttft_sum,
   streaming_ttft_count, non_streaming_ttft_sum, non_streaming_ttft_count)
WITH backend_models AS (
  SELECT DISTINCT models.model, json_extract(backend.value, '$.id') AS backend_id
  FROM models, json_each(models.config, '$.backends') AS backend
), unique_owners AS (
  SELECT MIN(model) AS model, backend_id
  FROM backend_models
  GROUP BY backend_id
  HAVING COUNT(*) = 1
)
SELECT owner.model, stats.backend_id, stats.minute, stats.total, stats.success,
       stats.failure, stats.streaming_ttft_sum, stats.streaming_ttft_count,
       stats.non_streaming_ttft_sum, stats.non_streaming_ttft_count
FROM backend_stats_minute AS stats
JOIN unique_owners AS owner ON owner.backend_id = stats.backend_id;

DROP TABLE backend_stats_minute;
ALTER TABLE backend_stats_minute_new RENAME TO backend_stats_minute;
CREATE INDEX idx_backend_stats_minute ON backend_stats_minute (minute);
