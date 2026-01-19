import { ChangeStream, Collection, Db, MongoClient } from 'mongodb'

import type { ApiKey } from '../types/apikey.js'
import type {
  AffinityMapping,
  ModelConfig,
  RecordedRequest,
  StatsDataPoint,
} from '../types/backend.js'

/**
 * MongoDB Service
 *
 * Centralized service for MongoDB operations.
 * Handles connection, collection access, and initial index creation.
 * Supports multiple collections for models, API keys, metrics, and affinity mappings.
 */
export class MongoDBService {
  private client: MongoClient | null = null
  private db: Db | null = null
  private changeStream: ChangeStream | null = null

  constructor(
    private url: string = process.env.MONGODB_URL || 'mongodb://localhost:27017/wenyao'
  ) {}

  /**
   * Establishes connection to MongoDB and initializes collections/indexes.
   */
  async connect(): Promise<void> {
    try {
      this.client = new MongoClient(this.url)
      await this.client.connect()
      this.db = this.client.db()
      console.log('Connected to MongoDB')

      // Ensure essential indexes exist
      await this.getModelsCollection().createIndex({ model: 1 }, { unique: true })
      await this.getApiKeysCollection().createIndex({ key: 1 }, { unique: true })

      // Initialize secondary collections
      await this.initializeRecordedRequestsCollection()
      await this.initializeAffinityMappingsCollection()
    } catch (error) {
      console.error('Failed to connect to MongoDB:', error)
      throw error
    }
  }

  /**
   * Closes the MongoDB connection and any active change streams.
   */
  async disconnect(): Promise<void> {
    if (this.changeStream) {
      await this.changeStream.close()
      this.changeStream = null
    }
    if (this.client) {
      await this.client.close()
      this.client = null
      this.db = null
      console.log('Disconnected from MongoDB')
    }
  }

  /**
   * Returns whether the service is currently connected to MongoDB.
   */
  isConnected(): boolean {
    return this.client !== null && this.db !== null
  }

  /**
   * Returns the active database instance.
   * Throws if not connected.
   */
  getDatabase(): Db {
    if (!this.db) {
      throw new Error('Database not initialized. Call connect() first.')
    }
    return this.db
  }

  /**
   * Collection for model and backend configurations.
   */
  getModelsCollection(): Collection<ModelConfig> {
    return this.getDatabase().collection<ModelConfig>('models')
  }

  /**
   * Collection for admin API keys.
   */
  getApiKeysCollection(): Collection<ApiKey> {
    return this.getDatabase().collection<ApiKey>('apikeys')
  }

  /**
   * Collection for recorded proxy requests (for debugging/audit).
   */
  getRecordedRequestsCollection(): Collection<RecordedRequest> {
    return this.getDatabase().collection<RecordedRequest>('recorded_requests')
  }

  /**
   * Collection for session affinity mappings.
   */
  getAffinityMappingsCollection(): Collection<AffinityMapping> {
    return this.getDatabase().collection<AffinityMapping>('affinity_mappings')
  }

  /**
   * Initializes the recorded requests collection with indexes.
   */
  private async initializeRecordedRequestsCollection(): Promise<void> {
    const collection = this.getRecordedRequestsCollection()

    // Compound index for backend + time queries (primary use case)
    await collection.createIndex({ backendId: 1, timestamp: -1 })

    // Index for model + time queries
    await collection.createIndex({ model: 1, timestamp: -1 })

    // Index for time range queries
    await collection.createIndex({ timestamp: -1 })

    console.log('Recorded requests collection initialized with indexes')
  }

  /**
   * Initializes the affinity mappings collection with indexes.
   * Includes a TTL index to expire mappings after 1 hour of inactivity.
   */
  private async initializeAffinityMappingsCollection(): Promise<void> {
    const collection = this.getAffinityMappingsCollection()

    // Compound unique index for model + sessionId lookups
    await collection.createIndex({ model: 1, sessionId: 1 }, { unique: true })

    // Index for backend cleanup queries
    await collection.createIndex({ backendId: 1 })

    // TTL index to auto-delete stale mappings (1 hour of inactivity)
    await collection.createIndex({ lastAccessedAt: 1 }, { expireAfterSeconds: 3600 })

    console.log('Affinity mappings collection initialized with indexes')
  }

  /**
   * Sets up a MongoDB Change Stream to watch for model configuration changes.
   * This allows the application to respond in real-time to changes made in the database.
   *
   * @param onChange - Callback triggered when a change occurs
   */
  async watchModels(
    onChange: (
      modelConfig: ModelConfig,
      operationType: 'insert' | 'update' | 'delete' | 'replace'
    ) => void
  ): Promise<void> {
    if (!this.isConnected()) return

    const collection = this.getModelsCollection()

    this.changeStream = collection.watch([], {
      fullDocument: 'updateLookup',
    })

    console.log('Watching MongoDB for model configuration changes...')

    this.changeStream.on('change', (change) => {
      try {
        switch (change.operationType) {
          case 'insert':
          case 'update':
          case 'replace':
            if ('fullDocument' in change && change.fullDocument) {
              onChange(change.fullDocument as ModelConfig, change.operationType)
            }
            break
          case 'delete':
            if ('documentKey' in change && change.documentKey) {
              // For delete, we might only have the ID or indexed fields depending on config
              // Here we pass a partial object as the actual config is gone
              onChange(
                { model: (change.documentKey as any).model?.toString() || 'unknown' } as any,
                'delete'
              )
            }
            break
        }
      } catch (error) {
        console.error('Error processing change stream event:', error)
      }
    })

    this.changeStream.on('error', (error) => {
      console.error('Change stream error:', error)
    })
  }

  /**
   * Stops the active MongoDB Change Stream.
   */
  async stopWatching(): Promise<void> {
    if (this.changeStream) {
      await this.changeStream.close()
      this.changeStream = null
      console.log('Stopped watching MongoDB changes')
    }
  }

  /**
   * DEPRECATED: Standardized stats history.
   * Kept for backward compatibility during migration.
   */
  async initializeStatsHistoryCollection(): Promise<void> {
    try {
      const collection = this.getDatabase().collection('stats_history')
      await collection.createIndex({ instanceId: 1, timestamp: -1 })
      await collection.createIndex({ instanceId: 1, backendId: 1, timestamp: -1 })
      console.log('Stats history collection initialized (DEPRECATED)')
    } catch (e) {
      // Ignore errors if collection doesn't exist or other issues
    }
  }
}

export const mongoDBService = new MongoDBService()
