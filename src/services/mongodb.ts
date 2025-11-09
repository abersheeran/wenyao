import { MongoClient, Db, ChangeStream, Collection } from 'mongodb'
import type { ModelConfig, StatsDataPoint } from '../types/backend.js'

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

      // Initialize stats history collection
      await this.initializeStatsHistoryCollection()
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

  // Stats history collection
  getStatsHistoryCollection(): Collection<StatsDataPoint> {
    return this.getDatabase().collection<StatsDataPoint>('stats_history')
  }

  // Initialize stats history collection with indexes
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

    console.log('Stats history collection initialized with indexes')
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
