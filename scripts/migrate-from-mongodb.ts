#!/usr/bin/env tsx

import { open, rename, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { MongoClient } from 'mongodb'

import {
  apiKeySql,
  MAX_STATEMENT_BYTES,
  migrationFinish,
  migrationPreamble,
  modelSql,
} from './mongodb-migration-sql.js'

const encoder = new TextEncoder()

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
    const connections = new Map<string, string>()
    const models = database
      .collection('models')
      .find()
      .collation({ locale: 'simple' })
      .sort({ model: 1 })
    for await (const document of models) {
      for (const statement of modelSql(document, connections)) await write(statement)
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
