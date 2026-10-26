#!/usr/bin/env tsx

import { open, rename, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { MongoClient } from 'mongodb'

const MAX_STATEMENT_BYTES = 100_000
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

export function* modelSql(document: Record<string, unknown>): Generator<string> {
  const { _id, ...config } = document
  if (typeof config.model !== 'string' || !config.model)
    throw new Error('Model record has no model name')
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

async function main(): Promise<void> {
  const url = process.env.MONGODB_URL
  if (!url) throw new Error('MONGODB_URL is required')
  const output = resolve(process.argv[2] || 'wenyao.migration.sql')
  const temporary = `${output}.${crypto.randomUUID()}.tmp`
  const client = new MongoClient(url)
  const file = await open(temporary, 'wx', 0o600)
  let modelCount = 0
  let keyCount = 0
  async function write(statement: string): Promise<void> {
    if (encoder.encode(statement).byteLength >= MAX_STATEMENT_BYTES) {
      throw new Error('Generated SQL statement exceeds the 100 KB limit')
    }
    await file.write(`${statement}\n`)
  }
  try {
    await client.connect()
    const database = client.db()
    await write(migrationPreamble)
    for await (const document of database.collection('models').find()) {
      for (const statement of modelSql(document)) await write(statement)
      modelCount++
    }
    for await (const document of database.collection('apikeys').find()) {
      for (const statement of apiKeySql(document)) await write(statement)
      keyCount++
    }
    await write(migrationFinish)
    await file.sync()
    await file.close()
    await rename(temporary, output)
    console.log(`Exported ${modelCount} models and ${keyCount} API keys to ${output}`)
  } catch (error) {
    await file.close().catch(() => {})
    await rm(temporary, { force: true })
    throw error
  } finally {
    await client.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    // Do not print the connection URL or driver errors that could contain it.
    console.error(
      error instanceof Error
        ? error.message.replace(/mongodb(?:\+srv)?:\/\/\S+/g, '[redacted]')
        : 'Migration export failed'
    )
    process.exitCode = 1
  })
}
