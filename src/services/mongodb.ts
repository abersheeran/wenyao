import { MongoClient, Db, ChangeStream, Collection } from 'mongodb'
import type { ModelConfig, StatsDataPoint, RecordedRequest, AffinityMapping } from '../types/backend.js'
import type { ApiKey } from '../types/apikey.js'

export class MongoDBService {
  private client: MongoClient | null = null
  private db: Db | null = null
  private changeStream: ChangeStream | null = null

  constructor(private url: string = process.env.MONGODB_URL || 'mongodb://localhost:27017/wenyao') {}

  async connect(): Promise<void> {
    try {
      this.client = new MongoClient(this.url)
      await this.client.connect()
      this.db = this.client.db()
      console.log('Connected to MongoDB')

      // Create index on model field for faster queries
      await this.getModelsCollection().createIndex({ model: 1 }, { unique: true })

      // Create unique index on API key
      await this.getApiKeysCollection().createIndex({ key: 1 }, { unique: true })

      // Note: The request_metrics collection is now initialized by MetricsStorage
      // in src/services/metrics/storage.ts when metrics are enabled

      // Initialize recorded requests collection
      await this.initializeRecordedRequestsCollection()

      // Initialize affinity mappings collection
      await this.initializeAffinityMappingsCollection()
    } catch (error) {
      console.error('Failed to connect to MongoDB:', error)
      throw error
    }
  }

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

  getDatabase(): Db {
    if (!this.db) {
      throw new Error('Database not initialized. Call connect() first.')
    }
    return this.db
  }

  // Updated to use 'models' collection with model as primary key
  getModelsCollection(): Collection<ModelConfig> {
    return this.getDatabase().collection<ModelConfig>('models')
  }

  // Legacy method for backward compatibility - returns 'backends' collection
  // This is kept for migration purposes
  getBackendsCollection(): Collection<any> {
    return this.getDatabase().collection('backends')
  }

  // DEPRECATED: Stats history collection (replaced by request_metrics)
  // This is kept for backward compatibility but is no longer actively used
  // New metrics system uses the 'request_metrics' collection via MetricsStorage
  getStatsHistoryCollection(): Collection<StatsDataPoint> {
    return this.getDatabase().collection<StatsDataPoint>('stats_history')
  }

  // API keys collection
  getApiKeysCollection(): Collection<ApiKey> {
    return this.getDatabase().collection<ApiKey>('apikeys')
  }

  // Recorded requests collection
  getRecordedRequestsCollection(): Collection<RecordedRequest> {
    return this.getDatabase().collection<RecordedRequest>('recorded_requests')
  }

  // Affinity mappings collection
  getAffinityMappingsCollection(): Collection<AffinityMapping> {
    return this.getDatabase().collection<AffinityMapping>('affinity_mappings')
  }

  // DEPRECATED: Initialize stats history collection with indexes
  // This collection is no longer used by the new metrics system
  // Kept for backward compatibility only
  async initializeStatsHistoryCollection(): Promise<void> {
    const collection = this.getStatsHistoryCollection()

    // Create compound index on backendId and timestamp for efficient queries
    await collection.createIndex({ backendId: 1, timestamp: -1 })

    // Create index on instanceId and timestamp for single-instance queries
    await collection.createIndex({ instanceId: 1, timestamp: -1 })

    // Create compound index for multi-instance aggregation queries
    await collection.createIndex({ instanceId: 1, backendId: 1, timestamp: -1 })

    // Create TTL index to automatically delete data older than 7 days
    await collection.createIndex(
      { timestamp: 1 },
      { expireAfterSeconds: 7 * 24 * 60 * 60 } // 7 days in seconds
    )

    console.log('Stats history collection initialized with indexes (DEPRECATED)')
  }

  // Initialize recorded requests collection with indexes
  async initializeRecordedRequestsCollection(): Promise<void> {
    const collection = this.getRecordedRequestsCollection()

    // Create compound index for backend + time queries (primary use case)
    await collection.createIndex({ backendId: 1, timestamp: -1 })

    // Create index for model + time queries
    await collection.createIndex({ model: 1, timestamp: -1 })

    // Create index for time range queries
    await collection.createIndex({ timestamp: -1 })

    console.log('Recorded requests collection initialized with indexes')
  }

  // Initialize affinity mappings collection with indexes
  async initializeAffinityMappingsCollection(): Promise<void> {
    const collection = this.getAffinityMappingsCollection()

    // Compound unique index for model + sessionId lookups (primary use case)
    await collection.createIndex({ model: 1, sessionId: 1 }, { unique: true })

    // Index for backend cleanup queries
    await collection.createIndex({ backendId: 1 })

    // TTL index to auto-delete stale mappings (1 hour of inactivity)
    await collection.createIndex(
      { lastAccessedAt: 1 },
      { expireAfterSeconds: 3600 } // 1 hour in seconds
    )

    console.log('Affinity mappings collection initialized with indexes')
  }

  async watchModels(
    onChange: (modelConfig: ModelConfig, operationType: 'insert' | 'update' | 'delete' | 'replace') => void
  ): Promise<void> {
    const collection = this.getModelsCollection()

    this.changeStream = collection.watch([], {
      fullDocument: 'updateLookup'
    })

    console.log('Watching MongoDB for model configuration changes...')

    this.changeStream.on('change', (change) => {
      try {
        switch (change.operationType) {
          case 'insert':
            if ('fullDocument' in change && change.fullDocument) {
              onChange(change.fullDocument as ModelConfig, 'insert')
            }
            break
          case 'update':
          case 'replace':
            if ('fullDocument' in change && change.fullDocument) {
              onChange(change.fullDocument as ModelConfig, change.operationType)
            }
            break
          case 'delete':
            if ('documentKey' in change && change.documentKey.model) {
              // For delete, we only have the model name
              onChange({ model: change.documentKey.model.toString(), backends: [], loadBalancingStrategy: 'weighted' } as ModelConfig, 'delete')
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

  async stopWatching(): Promise<void> {
    if (this.changeStream) {
      await this.changeStream.close()
      this.changeStream = null
      console.log('Stopped watching MongoDB changes')
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.db !== null
  }
}

export const mongoDBService = new MongoDBService()
