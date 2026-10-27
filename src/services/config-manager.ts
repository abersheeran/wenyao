import type { CreateConnectionInput, UpdateConnectionInput } from '../schemas/connection.js'
import type { ApiKey } from '../types/apikey.js'
import type { BackendConfig, ModelConfig, ResolvedModelConfig } from '../types/backend.js'
import type { Connection } from '../types/connection.js'

interface ApiKeyRow {
  key: string
  description: string
  models: string
  created_at: number
  last_used_at: number | null
}

interface ConnectionRow {
  id: string
  name: string
  provider: Connection['provider']
  config: string
}

export interface ConfigSnapshot {
  models: ResolvedModelConfig[]
  apiKeys: ApiKey[]
}

interface CachedSnapshot {
  snapshot: ConfigSnapshot
  expiresAt: number
}

// Only parsed data is shared between requests, never an in-flight I/O promise.
const snapshots = new WeakMap<D1Database, CachedSnapshot>()
const revisions = new WeakMap<D1Database, number>()
const CACHE_TTL_MS = 10_000

// Bind only changed backends and their model provider; check references atomically.
const VALID_CONNECTIONS_SQL = `NOT EXISTS (
  SELECT 1 FROM json_each(?) AS backend
  WHERE NOT EXISTS (
    SELECT 1 FROM connections
    WHERE connections.id = json_extract(backend.value, '$.connectionId')
      AND connections.provider = ?
  )
)`

export class BusinessError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 503
  ) {
    super(message)
  }
}

function apiKeyFromRow(row: ApiKeyRow): ApiKey {
  return {
    key: row.key,
    description: row.description,
    models: JSON.parse(row.models) as string[],
    createdAt: new Date(row.created_at),
    ...(row.last_used_at === null ? {} : { lastUsedAt: new Date(row.last_used_at) }),
  }
}

function connectionFromRow(row: ConnectionRow): Connection {
  const { id, name, provider } = row
  return provider === 'openai'
    ? { id, name, provider, openaiConfig: JSON.parse(row.config) }
    : { id, name, provider, bedrockConfig: JSON.parse(row.config) }
}

function parseModelConfig(config: string): ModelConfig {
  const model = JSON.parse(config) as ResolvedModelConfig
  return {
    ...model,
    backends: model.backends.map(
      ({ openaiConfig: _openai, bedrockConfig: _bedrock, ...backend }) => backend
    ),
  }
}

export class ConfigManager {
  constructor(private readonly db: D1Database) {}

  invalidate(): void {
    const cached = snapshots.get(this.db)
    if (cached) cached.expiresAt = 0
    revisions.set(this.db, (revisions.get(this.db) ?? 0) + 1)
  }

  async getSnapshot(): Promise<ConfigSnapshot> {
    const cached = snapshots.get(this.db)
    if (cached && cached.expiresAt > Date.now()) return cached.snapshot
    const revision = revisions.get(this.db) ?? 0
    try {
      const [models, connectionRows, apiKeys] = await this.db.batch([
        this.db.prepare('SELECT config FROM models'),
        this.db.prepare('SELECT id, name, provider, config FROM connections'),
        this.db.prepare('SELECT key, description, models, created_at, last_used_at FROM api_keys'),
      ])
      const connections = (connectionRows.results as ConnectionRow[]).map(connectionFromRow)
      const byId = new Map(connections.map((connection) => [connection.id, connection]))
      const snapshot: ConfigSnapshot = {
        models: (models.results as { config: string }[]).map((row) => {
          const model = parseModelConfig(row.config)
          return {
            ...model,
            backends: model.backends.map((backend) => {
              const connection = backend.connectionId ? byId.get(backend.connectionId) : undefined
              if (
                !connection ||
                connection.provider !== model.provider ||
                backend.provider !== model.provider
              )
                return backend
              return connection.provider === 'openai'
                ? { ...backend, openaiConfig: connection.openaiConfig }
                : { ...backend, bedrockConfig: connection.bedrockConfig }
            }),
          }
        }),
        apiKeys: (apiKeys.results as ApiKeyRow[]).map(apiKeyFromRow),
      }
      // A management write during this read must not repopulate a stale cache.
      if ((revisions.get(this.db) ?? 0) === revision) {
        snapshots.set(this.db, { snapshot, expiresAt: Date.now() + CACHE_TTL_MS })
      }
      return snapshot
    } catch (error) {
      console.error('Failed to refresh configuration cache:', error)
      if (cached) return cached.snapshot
      throw new BusinessError('Configuration is temporarily unavailable', 503)
    }
  }

  async getAllModels(): Promise<ModelConfig[]> {
    const rows = await this.db.prepare('SELECT config FROM models').all<{ config: string }>()
    return rows.results.map((row) => parseModelConfig(row.config))
  }

  async getModelConfig(model: string): Promise<ModelConfig | undefined> {
    const row = await this.db
      .prepare('SELECT config FROM models WHERE model = ?')
      .bind(model)
      .first<{ config: string }>()
    return row ? parseModelConfig(row.config) : undefined
  }

  private async mutateModel(
    model: string,
    mutate: (config: ModelConfig) => ModelConfig,
    deletedBackendId?: string
  ): Promise<ModelConfig> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await this.db
        .prepare('SELECT config FROM models WHERE model = ?')
        .bind(model)
        .first<{ config: string }>()
      if (!row) throw new BusinessError(`Model configuration for ${model} not found`, 404)

      // Reapply the edit and validation to the latest document on every retry.
      const config = parseModelConfig(row.config)
      const updated = mutate(config)
      this.validateProviders(updated)
      const previousBackends = new Map(config.backends.map((backend) => [backend.id, backend]))
      const changedBackends = updated.backends.filter((backend) => {
        const previous = previousBackends.get(backend.id)
        // Backend fields are scalar; compare content independently of key/array order.
        const fields = Object.keys(backend) as (keyof BackendConfig)[]
        return (
          !previous ||
          fields.length !== Object.keys(previous).length ||
          fields.some((field) => backend[field] !== previous[field])
        )
      })
      await this.validateConnections(changedBackends, updated.provider)
      const nextConfig = JSON.stringify(updated)
      if (nextConfig === row.config) {
        this.invalidate()
        return updated
      }
      const statement = this.db
        .prepare(
          `UPDATE models SET config = ? WHERE model = ? AND config = ?${changedBackends.length ? ` AND ${VALID_CONNECTIONS_SQL}` : ''}`
        )
        .bind(
          nextConfig,
          model,
          row.config,
          ...(changedBackends.length ? [JSON.stringify(changedBackends), updated.provider] : [])
        )
      const result =
        deletedBackendId === undefined
          ? await statement.run()
          : (
              await this.db.batch([
                statement,
                // changes() refers to the preceding CAS in this same transaction.
                // A conflict must not clear affinity for a backend that still exists.
                this.db
                  .prepare(
                    'DELETE FROM affinity_mappings WHERE model = ? AND backend_id = ? AND changes() > 0'
                  )
                  .bind(model, deletedBackendId),
              ])
            )[0]
      if (result.meta.changes > 0) {
        this.invalidate()
        return updated
      }
    }
    throw new BusinessError(`Model configuration for ${model} changed concurrently`, 409)
  }

  private validateProviders(config: ModelConfig): void {
    for (const backend of config.backends) {
      if (backend.provider !== config.provider) {
        throw new BusinessError(
          `Backend '${backend.id}' provider '${backend.provider}' does not match model provider '${config.provider}'`,
          400
        )
      }
    }
    const ids = config.backends.map((backend) => backend.id)
    if (new Set(ids).size !== ids.length) {
      throw new BusinessError('Backend IDs must be unique within a model', 409)
    }
  }

  private async validateConnections(
    backends: BackendConfig[],
    provider: ModelConfig['provider']
  ): Promise<void> {
    if (!backends.length) return
    const rows = await this.db
      .prepare(
        `SELECT id, provider FROM connections WHERE id IN (
          SELECT json_extract(value, '$.connectionId') FROM json_each(?)
        )`
      )
      .bind(JSON.stringify(backends))
      .all<Pick<ConnectionRow, 'id' | 'provider'>>()
    const connections = new Map(rows.results.map((connection) => [connection.id, connection]))
    for (const backend of backends) {
      const connection = backend.connectionId ? connections.get(backend.connectionId) : undefined
      if (!connection || connection.provider !== provider) {
        throw new BusinessError(
          `Backend '${backend.id}' connection '${backend.connectionId ?? ''}' ${connection ? `provider '${connection.provider}' does not match model provider '${provider}'` : 'does not exist'}`,
          400
        )
      }
    }
  }

  async addModelConfig(config: ModelConfig): Promise<ModelConfig> {
    this.validateProviders(config)
    const nextConfig = JSON.stringify(config)
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.validateConnections(config.backends, config.provider)
      const result = await this.db
        .prepare(
          `INSERT OR IGNORE INTO models (model, config) SELECT ?, ?${config.backends.length ? ` WHERE ${VALID_CONNECTIONS_SQL}` : ''}`
        )
        .bind(
          config.model,
          nextConfig,
          ...(config.backends.length ? [JSON.stringify(config.backends), config.provider] : [])
        )
        .run()
      if (result.meta.changes) {
        this.invalidate()
        return config
      }
      if (await this.getModelConfig(config.model)) {
        throw new BusinessError(`Model configuration for ${config.model} already exists`, 409)
      }
    }
    throw new BusinessError(`Model configuration for ${config.model} changed concurrently`, 409)
  }

  async updateModelConfig(
    model: string,
    updates: Partial<Omit<ModelConfig, 'model'>>
  ): Promise<ModelConfig> {
    const definedUpdates = Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined)
    )
    return this.mutateModel(model, (config) => ({ ...config, ...definedUpdates }))
  }

  async deleteModelConfig(model: string): Promise<boolean> {
    const [result] = await this.db.batch([
      this.db.prepare('DELETE FROM models WHERE model = ?').bind(model),
      this.db.prepare('DELETE FROM affinity_mappings WHERE model = ?').bind(model),
    ])
    this.invalidate()
    return result.meta.changes > 0
  }

  async addBackendToModel(model: string, backend: BackendConfig): Promise<ModelConfig> {
    return this.mutateModel(model, (config) => {
      this.validateProviders({ ...config, backends: [backend] })
      if (config.backends.some((item) => item.id === backend.id)) {
        throw new BusinessError(
          `Backend with id ${backend.id} already exists in model ${model}`,
          409
        )
      }
      return { ...config, backends: [...config.backends, backend] }
    })
  }

  async updateBackendInModel(
    model: string,
    backendId: string,
    updates: Partial<Omit<BackendConfig, 'id'>>
  ): Promise<ModelConfig> {
    const definedUpdates = Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined)
    )
    return this.mutateModel(model, (config) => {
      const index = config.backends.findIndex((item) => item.id === backendId)
      if (index === -1) {
        throw new BusinessError(`Backend with id ${backendId} not found in model ${model}`, 404)
      }
      const backends = [...config.backends]
      backends[index] = { ...backends[index], ...definedUpdates }
      return { ...config, backends }
    })
  }

  async deleteBackendFromModel(model: string, backendId: string): Promise<ModelConfig> {
    return this.mutateModel(
      model,
      (config) => {
        if (!config.backends.some((backend) => backend.id === backendId)) {
          throw new BusinessError(`Backend with id ${backendId} not found in model ${model}`, 404)
        }
        return {
          ...config,
          backends: config.backends.filter((backend) => backend.id !== backendId),
        }
      },
      backendId
    )
  }

  async getAllConnections(): Promise<Connection[]> {
    const rows = await this.db
      .prepare('SELECT id, name, provider, config FROM connections ORDER BY id')
      .all<ConnectionRow>()
    return rows.results.map(connectionFromRow)
  }

  async getConnection(id: string): Promise<Connection | undefined> {
    const row = await this.db
      .prepare('SELECT id, name, provider, config FROM connections WHERE id = ?')
      .bind(id)
      .first<ConnectionRow>()
    return row ? connectionFromRow(row) : undefined
  }

  async addConnection(connection: CreateConnectionInput): Promise<Connection> {
    const name = connection.name ?? ''
    const config =
      connection.provider === 'openai' ? connection.openaiConfig : connection.bedrockConfig
    const result = await this.db
      .prepare('INSERT OR IGNORE INTO connections (id, name, provider, config) VALUES (?, ?, ?, ?)')
      .bind(connection.id, name, connection.provider, JSON.stringify(config))
      .run()
    if (!result.meta.changes)
      throw new BusinessError(`Connection '${connection.id}' already exists`, 409)
    this.invalidate()
    return { ...connection, name }
  }

  async updateConnection(id: string, updates: UpdateConnectionInput): Promise<Connection> {
    const connection = await this.getConnection(id)
    if (!connection) throw new BusinessError(`Connection '${id}' not found`, 404)
    if (
      (updates.openaiConfig !== undefined && connection.provider !== 'openai') ||
      (updates.bedrockConfig !== undefined && connection.provider !== 'bedrock')
    ) {
      throw new BusinessError(
        `Configuration does not match connection '${id}' provider '${connection.provider}'`,
        400
      )
    }
    const config = updates.openaiConfig ?? updates.bedrockConfig
    const row = await this.db
      .prepare(
        `UPDATE connections SET name = COALESCE(?, name), config = COALESCE(?, config)
         WHERE id = ? AND provider = ? RETURNING id, name, provider, config`
      )
      .bind(
        updates.name ?? null,
        config === undefined ? null : JSON.stringify(config),
        id,
        connection.provider
      )
      .first<ConnectionRow>()
    if (!row) throw new BusinessError(`Connection '${id}' not found`, 404)
    this.invalidate()
    return connectionFromRow(row)
  }

  async deleteConnection(id: string): Promise<void> {
    // Read failure details in the same transaction so concurrent unlinking cannot
    // erase the references that made the conditional DELETE fail.
    const [result, existing, references] = await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM connections WHERE id = ? AND NOT EXISTS (
        SELECT 1 FROM models, json_each(models.config, '$.backends') AS backend
        WHERE json_extract(backend.value, '$.connectionId') = connections.id
      )`
        )
        .bind(id),
      this.db.prepare('SELECT id FROM connections WHERE id = ?').bind(id),
      this.db
        .prepare(
          `SELECT models.model AS model, json_extract(backend.value, '$.id') AS backendId
        FROM models, json_each(models.config, '$.backends') AS backend
        WHERE json_extract(backend.value, '$.connectionId') = ?
        ORDER BY models.model, CAST(backend.key AS INTEGER)`
        )
        .bind(id),
    ])
    if (result.meta.changes) {
      this.invalidate()
      return
    }
    if (!existing.results.length) throw new BusinessError(`Connection '${id}' not found`, 404)
    const referencedBy = references.results as { model: string; backendId: string }[]
    throw new BusinessError(
      `Connection '${id}' is referenced by ${referencedBy.map((reference) => `${reference.model}/${reference.backendId}`).join(', ')}`,
      409
    )
  }

  async getAllApiKeys(): Promise<ApiKey[]> {
    const rows = await this.db.prepare('SELECT * FROM api_keys').all<ApiKeyRow>()
    return rows.results.map(apiKeyFromRow)
  }

  async getApiKey(key: string): Promise<ApiKey | undefined> {
    const row = await this.db
      .prepare('SELECT * FROM api_keys WHERE key = ?')
      .bind(key)
      .first<ApiKeyRow>()
    return row ? apiKeyFromRow(row) : undefined
  }

  async addApiKey(input: Pick<ApiKey, 'key' | 'description' | 'models'>): Promise<ApiKey> {
    const createdAt = new Date()
    const result = await this.db
      .prepare(
        'INSERT OR IGNORE INTO api_keys (key, description, models, created_at) VALUES (?, ?, ?, ?)'
      )
      .bind(input.key, input.description, JSON.stringify(input.models), createdAt.getTime())
      .run()
    if (!result.meta.changes) throw new BusinessError('API key already exists', 409)
    this.invalidate()
    return { ...input, createdAt }
  }

  async updateApiKey(
    key: string,
    updates: Partial<Pick<ApiKey, 'description' | 'models'>>
  ): Promise<ApiKey> {
    const row = await this.db
      .prepare(
        `UPDATE api_keys
      SET description = COALESCE(?, description), models = COALESCE(?, models)
      WHERE key = ? RETURNING *`
      )
      .bind(
        updates.description ?? null,
        updates.models === undefined ? null : JSON.stringify(updates.models),
        key
      )
      .first<ApiKeyRow>()
    if (!row) throw new BusinessError('API key not found', 404)
    this.invalidate()
    return apiKeyFromRow(row)
  }

  async deleteApiKey(key: string): Promise<void> {
    const result = await this.db.prepare('DELETE FROM api_keys WHERE key = ?').bind(key).run()
    if (!result.meta.changes) throw new BusinessError('API key not found', 404)
    this.invalidate()
  }
}
