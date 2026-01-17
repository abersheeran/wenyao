import type { Db } from 'mongodb'
import type { RedisClientType } from 'redis'
import type { ActiveRequestStore } from './interface.js'
import { MongoActiveRequestStore } from './mongo-store.js'
import { RedisActiveRequestStore } from './redis-store.js'

/**
 * Active request store type
 */
export type ActiveRequestStoreType = 'mongodb' | 'redis'

/**
 * Configuration for creating an active request store
 */
export interface ActiveRequestStoreConfig {
  type: ActiveRequestStoreType
  instanceId: string

  // MongoDB options
  db?: Db

  // Redis options
  redis?: RedisClientType
}

/**
 * Create an active request store based on configuration
 */
export function createActiveRequestStore(config: ActiveRequestStoreConfig): ActiveRequestStore {
  switch (config.type) {
    case 'mongodb':
      if (!config.db) {
        throw new Error('MongoDB database instance is required for mongodb store type')
      }
      return new MongoActiveRequestStore(config.db, config.instanceId)

    case 'redis':
      if (!config.redis) {
        throw new Error('Redis client is required for redis store type')
      }
      return new RedisActiveRequestStore(config.redis, config.instanceId)

    default:
      throw new Error(`Unknown active request store type: ${config.type}`)
  }
}
