export const MAX_STATEMENT_BYTES = 100_000
const encoder = new TextEncoder()
const CHUNKS_TABLE = '_wenyao_migration_chunks'
export const migrationPreamble = `CREATE TABLE IF NOT EXISTS ${CHUNKS_TABLE} (column_id INTEGER NOT NULL, ordinal INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (column_id, ordinal));`
export const migrationFinish = `DROP TABLE ${CHUNKS_TABLE};`

type SqlValue = string | number | null

function quote(value: SqlValue): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid numeric value in source data')
    return String(value)
  }
  // SQLite SQL source cannot contain NUL. A hex literal preserves all UTF-8 bytes.
  if (value.includes('\0')) {
    const hex = Array.from(encoder.encode(value), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('')
    return `CAST(X'${hex}' AS TEXT)`
  }
  return `'${value.replace(/'/g, "''")}'`
}

function* chunks(value: string): Generator<string> {
  let chunk = ''
  let size = 0
  for (const character of value) {
    const bytes = encoder.encode(character).byteLength
    if (size + bytes > 20_000) {
      yield chunk
      chunk = ''
      size = 0
    }
    chunk += character
    size += bytes
  }
  if (chunk || value.length === 0) yield chunk
}

function* insert(table: string, columns: string[], values: SqlValue[]): Generator<string> {
  if (
    values.reduce<number>(
      (size, value) => size + (typeof value === 'string' ? encoder.encode(value).byteLength : 8),
      0
    ) > 2_000_000
  ) {
    throw new Error(`Source ${table} record exceeds D1's 2 MB row limit`)
  }
  const prefix = `INSERT OR REPLACE INTO ${table} (${columns.join(', ')})`
  const statement = `${prefix} VALUES (${values.map(quote).join(', ')});`
  if (encoder.encode(statement).byteLength < MAX_STATEMENT_BYTES) {
    yield statement
    return
  }

  // A persistent scratch table also works when Wrangler executes file chunks in
  // separate requests. It is cleared before each staged row and dropped at EOF.
  yield `DELETE FROM ${CHUNKS_TABLE};`
  const expressions: string[] = []
  for (const [columnId, value] of values.entries()) {
    if (typeof value !== 'string') {
      expressions.push(quote(value))
      continue
    }
    let ordinal = 0
    for (const chunk of chunks(value)) {
      yield `INSERT OR REPLACE INTO ${CHUNKS_TABLE} (column_id, ordinal, value) VALUES (${columnId}, ${ordinal++}, ${quote(chunk)});`
    }
    expressions.push(
      `(SELECT group_concat(value, '') FROM (SELECT value FROM ${CHUNKS_TABLE} WHERE column_id = ${columnId} ORDER BY ordinal))`
    )
  }
  yield `${prefix} VALUES (${expressions.join(', ')});`
}

function timestamp(value: unknown, field: string): number {
  if (value == null) throw new Error(`Missing or invalid ${field} in API key record`)
  const result =
    value instanceof Date ? value.getTime() : new Date(value as string | number).getTime()
  if (!Number.isFinite(result)) throw new Error(`Missing or invalid ${field} in API key record`)
  return result
}

function connectionConfig(backend: Record<string, unknown>): Record<string, string> | null {
  const fields =
    backend.provider === 'openai'
      ? ['url', 'apiKey']
      : backend.provider === 'bedrock'
        ? ['region', 'accessKeyId', 'secretAccessKey']
        : null
  if (!fields) return null
  const config = backend[`${backend.provider}Config`]
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null
  const values = config as Record<string, unknown>
  if (fields.some((field) => typeof values[field] !== 'string' || !values[field])) return null
  return Object.fromEntries(fields.map((field) => [field, values[field] as string]))
}

export function* modelSql(
  document: Record<string, unknown>,
  connections = new Map<string, string>()
): Generator<string> {
  const { _id, ...config } = document
  if (typeof config.model !== 'string' || !config.model)
    throw new Error('Model record has no model name')
  const connectionCounts = new Map<string, number>()
  for (const id of connections.values()) {
    const provider = id.slice(0, id.lastIndexOf('-'))
    connectionCounts.set(provider, (connectionCounts.get(provider) ?? 0) + 1)
  }
  if (Array.isArray(config.backends)) {
    const backends: Record<string, unknown>[] = []
    for (const backend of config.backends as Record<string, unknown>[]) {
      const { openaiConfig, bedrockConfig, ...converted } = backend
      const connection = connectionConfig(backend)
      if (connection) {
        const json = JSON.stringify(connection)
        const key = JSON.stringify([backend.provider, connection])
        let id = connections.get(key)
        if (!id) {
          const provider = backend.provider as string
          const number = (connectionCounts.get(provider) ?? 0) + 1
          connectionCounts.set(provider, number)
          id = `${provider}-${number}`
          connections.set(key, id)
          yield* insert(
            'connections',
            ['id', 'provider', 'config'],
            [id, backend.provider as string, json]
          )
        }
        converted.connectionId = id
      }
      backends.push(converted)
    }
    config.backends = backends
  }
  yield* insert('models', ['model', 'config'], [config.model, JSON.stringify(config)])
}

export function* apiKeySql(document: Record<string, unknown>): Generator<string> {
  if (typeof document.key !== 'string' || !document.key)
    throw new Error('API key record has no key')
  if (
    typeof document.description !== 'string' ||
    !Array.isArray(document.models) ||
    !document.models.every((model) => typeof model === 'string')
  ) {
    throw new Error('API key record has invalid description or models')
  }
  yield* insert(
    'api_keys',
    ['key', 'description', 'models', 'created_at', 'last_used_at'],
    [
      document.key,
      document.description,
      JSON.stringify(document.models),
      timestamp(document.createdAt, 'createdAt'),
      document.lastUsedAt == null ? null : timestamp(document.lastUsedAt, 'lastUsedAt'),
    ]
  )
}
