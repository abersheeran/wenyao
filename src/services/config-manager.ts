import type { ApiKey } from '../types/apikey.js'
import type { BackendConfig, ModelConfig } from '../types/backend.js'

interface ApiKeyRow {
  key: string
  description: string
  models: string
  created_at: number
  last_used_at: number | null
}

export interface ConfigSnapshot {
  models: ModelConfig[]
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
      const [models, apiKeys] = await this.db.batch([
        this.db.prepare('SELECT config FROM models'),
        this.db.prepare('SELECT key, description, models, created_at, last_used_at FROM api_keys'),
      ])
      const snapshot = {
        models: (models.results as { config: string }[]).map(
          (row) => JSON.parse(row.config) as ModelConfig
        ),
        apiKeys: (apiKeys.results as unknown as ApiKeyRow[]).map(apiKeyFromRow),
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
    return rows.results.map((row) => JSON.parse(row.config) as ModelConfig)
  }

  async getModelConfig(model: string): Promise<ModelConfig | undefined> {
    const row = await this.db
      .prepare('SELECT config FROM models WHERE model = ?')
      .bind(model)
      .first<{ config: string }>()
    return row ? (JSON.parse(row.config) as ModelConfig) : undefined
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
      const updated = mutate(JSON.parse(row.config) as ModelConfig)
      this.validateProviders(updated)
      const nextConfig = JSON.stringify(updated)
      if (nextConfig === row.config) {
        this.invalidate()
        return updated
      }
      const statement = this.db
        .prepare('UPDATE models SET config = ? WHERE model = ? AND config = ?')
        .bind(nextConfig, model, row.config)
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
          `Backend provider '${backend.provider}' does not match model provider '${config.provider}'`,
          400
        )
      }
    }
    const ids = config.backends.map((backend) => backend.id)
    if (new Set(ids).size !== ids.length) {
      throw new BusinessError('Backend IDs must be unique within a model', 409)
    }
  }

  async addModelConfig(config: ModelConfig): Promise<ModelConfig> {
    this.validateProviders(config)
    const result = await this.db
      .prepare('INSERT OR IGNORE INTO models (model, config) VALUES (?, ?)')
      .bind(config.model, JSON.stringify(config))
      .run()
    if (!result.meta.changes) {
      throw new BusinessError(`Model configuration for ${config.model} already exists`, 409)
    }
    this.invalidate()
    return config
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
