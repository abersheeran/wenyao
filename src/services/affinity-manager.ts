import { mongoDBService } from './mongodb.js'
import type { ConfigManager } from './config-manager.js'
import type { AffinityMapping, BackendConfig } from '../types/backend.js'

export class AffinityManager {
  // In-memory cache: key = "model:sessionId", value = backendId
  private affinityCache: Map<string, string> = new Map()
  private readonly cacheMaxSize = 10000

  private getCacheKey(model: string, sessionId: string): string {
    return `${model}:${sessionId}`
  }

  /**
   * Get backend for a session, returns null if:
   * - No mapping exists
   * - Backend is disabled/not found
   * - Affinity disabled for model
   */
  async getAffinityBackend(
    model: string,
    sessionId: string,
    configManager: ConfigManager
  ): Promise<BackendConfig | null> {
    // Check cache first (hot path optimization)
    const cacheKey = this.getCacheKey(model, sessionId)
    let backendId = this.affinityCache.get(cacheKey)

    // If not in cache, check MongoDB
    if (!backendId && mongoDBService.isConnected()) {
      try {
        const collection = mongoDBService.getAffinityMappingsCollection()
        const mapping = await collection.findOne({ model, sessionId })

        if (mapping) {
          backendId = mapping.backendId
          // Update cache
          this.updateCache(cacheKey, backendId)

          // Update lastAccessedAt asynchronously (don't block)
          collection.updateOne(
            { model, sessionId },
            {
              $set: { lastAccessedAt: new Date() },
              $inc: { accessCount: 1 }
            }
          ).catch(err => console.error('Failed to update affinity access time:', err))
        }
      } catch (error) {
        console.error(`Error fetching affinity mapping for ${model}:${sessionId}:`, error)
        return null
      }
    }

    if (!backendId) return null

    // Verify backend exists and is enabled
    const backend = configManager.getBackend(model, backendId)
    if (!backend || !backend.enabled || backend.weight === 0) {
      // Backend no longer valid, clean up mapping
      this.clearMappings({ model, sessionId }).catch(err =>
        console.error('Failed to cleanup invalid affinity:', err)
      )
      return null
    }

    return backend
  }

  /**
   * Set/update backend affinity for a session
   * Creates new mapping or updates lastAccessedAt
   */
  async setAffinityBackend(
    model: string,
    sessionId: string,
    backendId: string
  ): Promise<void> {
    if (!mongoDBService.isConnected()) {
      console.warn('MongoDB not connected, affinity will not persist')
      return
    }

    try {
      const collection = mongoDBService.getAffinityMappingsCollection()
      const now = new Date()

      // Upsert: create new or update existing
      await collection.updateOne(
        { model, sessionId },
        {
          $set: {
            backendId,
            lastAccessedAt: now
          },
          $setOnInsert: {
            createdAt: now,
            accessCount: 0
          }
        },
        { upsert: true }
      )

      // Update cache
      const cacheKey = this.getCacheKey(model, sessionId)
      this.updateCache(cacheKey, backendId)

      console.log(`Set affinity: ${model}:${sessionId} -> ${backendId}`)
    } catch (error) {
      console.error('Error setting affinity mapping:', error)
    }
  }

  private updateCache(key: string, value: string): void {
    // Simple LRU: if cache full, delete oldest entry
    if (this.affinityCache.size >= this.cacheMaxSize) {
      const firstKey = this.affinityCache.keys().next().value
      if (firstKey !== undefined) {
        this.affinityCache.delete(firstKey)
      }
    }
    this.affinityCache.set(key, value)
  }

  /**
   * Clean up all affinity mappings for a deleted backend
   * Called when backend is removed from configuration
   */
  async cleanupBackendMappings(backendId: string): Promise<number> {
    if (!mongoDBService.isConnected()) return 0

    try {
      const collection = mongoDBService.getAffinityMappingsCollection()
      const result = await collection.deleteMany({ backendId })

      // Clear from cache
      for (const [key, value] of this.affinityCache.entries()) {
        if (value === backendId) {
          this.affinityCache.delete(key)
        }
      }

      console.log(`Cleaned up ${result.deletedCount} affinity mappings for backend ${backendId}`)
      return result.deletedCount || 0
    } catch (error) {
      console.error(`Error cleaning up affinity mappings for backend ${backendId}:`, error)
      return 0
    }
  }

  /**
   * Clean up all affinity mappings for a model
   * Called when model is deleted
   */
  async cleanupModelMappings(model: string): Promise<number> {
    if (!mongoDBService.isConnected()) return 0

    try {
      const collection = mongoDBService.getAffinityMappingsCollection()
      const result = await collection.deleteMany({ model })

      // Clear from cache
      const prefix = `${model}:`
      for (const key of this.affinityCache.keys()) {
        if (key.startsWith(prefix)) {
          this.affinityCache.delete(key)
        }
      }

      console.log(`Cleaned up ${result.deletedCount} affinity mappings for model ${model}`)
      return result.deletedCount || 0
    } catch (error) {
      console.error(`Error cleaning up affinity mappings for model ${model}:`, error)
      return 0
    }
  }

  /**
   * Admin API: Get all affinity mappings (paginated)
   */
  async getAllMappings(
    filter?: { model?: string, backendId?: string },
    limit: number = 100,
    offset: number = 0
  ): Promise<{ mappings: AffinityMapping[], total: number }> {
    if (!mongoDBService.isConnected()) {
      return { mappings: [], total: 0 }
    }

    try {
      const collection = mongoDBService.getAffinityMappingsCollection()
      const query = filter || {}

      const [mappings, total] = await Promise.all([
        collection
          .find(query)
          .sort({ lastAccessedAt: -1 })
          .skip(offset)
          .limit(limit)
          .toArray(),
        collection.countDocuments(query)
      ])

      return { mappings, total }
    } catch (error) {
      console.error('Error fetching affinity mappings:', error)
      return { mappings: [], total: 0 }
    }
  }

  /**
   * Admin API: Clear affinity mappings
   */
  async clearMappings(filter?: {
    model?: string,
    sessionId?: string,
    backendId?: string
  }): Promise<number> {
    if (!mongoDBService.isConnected()) return 0

    try {
      const collection = mongoDBService.getAffinityMappingsCollection()
      const query = filter || {}

      const result = await collection.deleteMany(query)

      // Clear entire cache if no specific filter
      if (!filter || Object.keys(filter).length === 0) {
        this.affinityCache.clear()
      } else {
        // Selective cache invalidation
        if (filter.model && filter.sessionId) {
          const key = this.getCacheKey(filter.model, filter.sessionId)
          this.affinityCache.delete(key)
        } else if (filter.model) {
          const prefix = `${filter.model}:`
          for (const key of this.affinityCache.keys()) {
            if (key.startsWith(prefix)) {
              this.affinityCache.delete(key)
            }
          }
        } else if (filter.backendId) {
          for (const [key, value] of this.affinityCache.entries()) {
            if (value === filter.backendId) {
              this.affinityCache.delete(key)
            }
          }
        }
      }

      console.log(`Cleared ${result.deletedCount} affinity mappings`)
      return result.deletedCount || 0
    } catch (error) {
      console.error('Error clearing affinity mappings:', error)
      return 0
    }
  }
}

// Singleton instance
export const affinityManager = new AffinityManager()
