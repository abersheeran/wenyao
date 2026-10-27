CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  config TEXT NOT NULL
);

-- Canonical objects contain only known fields, in a fixed order. Comparing
-- these objects ignores the key order and extra fields in the old configs.
CREATE TABLE _wenyao_connection_backends AS
SELECT
  models.model,
  CAST(backends.key AS INTEGER) AS ordinal,
  backends.value AS backend,
  json_extract(backends.value, '$.provider') AS provider,
  CASE
    WHEN json_extract(backends.value, '$.provider') = 'openai'
      AND json_type(backends.value, '$.openaiConfig') = 'object'
      AND json_type(backends.value, '$.openaiConfig.url') = 'text'
      AND json_extract(backends.value, '$.openaiConfig.url') <> ''
      AND json_type(backends.value, '$.openaiConfig.apiKey') = 'text'
      AND json_extract(backends.value, '$.openaiConfig.apiKey') <> ''
    THEN json_object(
      'url', json_extract(backends.value, '$.openaiConfig.url'),
      'apiKey', json_extract(backends.value, '$.openaiConfig.apiKey')
    )
    WHEN json_extract(backends.value, '$.provider') = 'bedrock'
      AND json_type(backends.value, '$.bedrockConfig') = 'object'
      AND json_type(backends.value, '$.bedrockConfig.region') = 'text'
      AND json_extract(backends.value, '$.bedrockConfig.region') <> ''
      AND json_type(backends.value, '$.bedrockConfig.accessKeyId') = 'text'
      AND json_extract(backends.value, '$.bedrockConfig.accessKeyId') <> ''
      AND json_type(backends.value, '$.bedrockConfig.secretAccessKey') = 'text'
      AND json_extract(backends.value, '$.bedrockConfig.secretAccessKey') <> ''
    THEN json_object(
      'region', json_extract(backends.value, '$.bedrockConfig.region'),
      'accessKeyId', json_extract(backends.value, '$.bedrockConfig.accessKeyId'),
      'secretAccessKey', json_extract(backends.value, '$.bedrockConfig.secretAccessKey')
    )
  END AS config
FROM models, json_each(models.config, '$.backends') AS backends;

WITH occurrences AS (
  SELECT *, ROW_NUMBER() OVER (
    PARTITION BY provider, config ORDER BY model COLLATE BINARY, ordinal
  ) AS occurrence
  FROM _wenyao_connection_backends
  WHERE config IS NOT NULL
)
INSERT INTO connections (id, provider, config)
SELECT
  provider || '-' || ROW_NUMBER() OVER (
    PARTITION BY provider ORDER BY model COLLATE BINARY, ordinal
  ),
  provider,
  config
FROM occurrences
WHERE occurrence = 1;

-- Append exactly the next array index at each step; no aggregate ordering is
-- involved, so backends retain their original order even if query plans change.
WITH RECURSIVE rewritten (model, ordinal, backends) AS (
  SELECT model, 0, json('[]') FROM models
  UNION ALL
  SELECT
    rewritten.model,
    rewritten.ordinal + 1,
    json_insert(rewritten.backends, '$[#]', json(
      CASE WHEN connections.id IS NULL
        THEN json_remove(source.backend, '$.openaiConfig', '$.bedrockConfig')
        ELSE json_set(
          json_remove(source.backend, '$.openaiConfig', '$.bedrockConfig'),
          '$.connectionId', connections.id
        )
      END
    ))
  FROM rewritten
  JOIN _wenyao_connection_backends AS source
    ON source.model = rewritten.model AND source.ordinal = rewritten.ordinal
  LEFT JOIN connections
    ON connections.provider = source.provider AND connections.config = source.config
)
UPDATE models
SET config = json_set(config, '$.backends', json((
  SELECT backends FROM rewritten
  WHERE rewritten.model = models.model
  ORDER BY ordinal DESC
  LIMIT 1
)))
WHERE json_type(config, '$.backends') = 'array';

DROP TABLE _wenyao_connection_backends;
