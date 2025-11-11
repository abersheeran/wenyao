import type { BackendConfig, LoadBalancingStrategy, ModelConfig } from '../types/backend.js'
import { configManager, type ConfigManager } from './config-manager.js'
import { statsTracker } from './stats-tracker.js'

export class LoadBalancer {
  private configManager: ConfigManager

  constructor(configMgr?: ConfigManager) {
    this.configManager = configMgr || configManager
  }

  /**
   * Select a backend for a specific model using the configured load balancing strategy
   * @param model - The model name from the OpenAI request
   * @param forceBackendId - Optional backend ID to force selection (bypasses load balancing)
   * @param isStream - Whether this is a streaming request (used for TTFT-based strategies)
   * @returns Selected backend or null if none available
   */
  async selectBackend(model: string, forceBackendId?: string, isStream?: boolean): Promise<BackendConfig | null> {
    const modelConfig = this.configManager.getModelConfig(model)

    if (!modelConfig) {
      throw new Error(`Model configuration for ${model} not found`)
    }

    // If backend-id is specified, use that backend directly
    if (forceBackendId) {
      const backend = this.configManager.getBackend(model, forceBackendId)
      if (!backend) {
        throw new Error(`Backend with id ${forceBackendId} not found in model ${model}`)
      }
      if (!backend.enabled) {
        throw new Error(`Backend with id ${forceBackendId} is disabled`)
      }
      return backend
    }

    // Get all enabled backends for this model
    const enabledBackends = this.configManager.getEnabledBackends(model)

    if (enabledBackends.length === 0) {
      return null
    }

    // Single backend - no need for load balancing
    if (enabledBackends.length === 1) {
      return enabledBackends[0]
    }

    // Apply load balancing strategy
    return this.applyStrategy(modelConfig, enabledBackends, isStream)
  }

  /**
   * Apply the configured load balancing strategy to select a backend
   */
  private async applyStrategy(modelConfig: ModelConfig, enabledBackends: BackendConfig[], isStream?: boolean): Promise<BackendConfig> {
    switch (modelConfig.loadBalancingStrategy) {
      case 'weighted':
        return this.selectByWeight(enabledBackends)

      case 'lowest-ttft':
        return await this.selectByLowestTTFT(enabledBackends, isStream)

      case 'min-error-rate':
        return await this.selectByMinErrorRate(enabledBackends)

      default:
        // Fallback to weighted strategy
        return this.selectByWeight(enabledBackends)
    }
  }

  /**
   * Weighted random selection strategy
   * Selects backends based on their configured weight
   */
  private selectByWeight(backends: BackendConfig[]): BackendConfig {
    const totalWeight = backends.reduce((sum, backend) => sum + backend.weight, 0)

    if (totalWeight === 0) {
      // If all weights are 0, select randomly with equal probability
      const randomIndex = Math.floor(Math.random() * backends.length)
      return backends[randomIndex]
    }

    // Weighted random selection
    let random = Math.random() * totalWeight

    for (const backend of backends) {
      random -= backend.weight
      if (random <= 0) {
        return backend
      }
    }

    // Fallback to last backend (should not reach here)
    return backends[backends.length - 1]
  }

  /**
   * Lowest TTFT (Time To First Token) strategy
   * Selects the backend with the lowest average TTFT
   * Uses stream-specific TTFT based on isStream parameter (undefined treated as non-streaming)
   */
  private async selectByLowestTTFT(backends: BackendConfig[], isStream?: boolean): Promise<BackendConfig> {
    // Treat undefined isStream as false (non-streaming)
    const useStreaming = isStream === true

    // Get stats for all backends
    const backendStatsPromises = backends.map(async backend => {
      const stats = await statsTracker.getStats(backend.id)

      // Choose TTFT metric based on stream type
      let averageTTFT: number
      if (stats) {
        averageTTFT = useStreaming ? stats.averageStreamingTTFT : stats.averageNonStreamingTTFT
      } else {
        averageTTFT = 0
      }

      return {
        backend,
        averageTTFT
      }
    })

    const backendStats = await Promise.all(backendStatsPromises)

    // Sort by average TTFT (ascending)
    backendStats.sort((a, b) => a.averageTTFT - b.averageTTFT)

    // Return backend with lowest TTFT
    return backendStats[0].backend
  }

  /**
   * Minimum error rate strategy
   * Dynamically adjusts traffic based on error rates
   * Backends with higher error rates receive less traffic
   */
  private async selectByMinErrorRate(backends: BackendConfig[]): Promise<BackendConfig> {
    // Get stats for all backends
    const backendStatsPromises = backends.map(async backend => {
      const stats = await statsTracker.getStats(backend.id)
      return {
        backend,
        errorRate: stats ? (1 - stats.successRate) : 1, // Default to 100% error rate if no stats
        totalRequests: stats?.totalRequests ?? 0
      }
    })

    const backendStats = await Promise.all(backendStatsPromises)

    // Calculate inverse error rate weights
    // Lower error rate = higher weight
    // Add small epsilon to avoid division by zero
    const epsilon = 0.01
    const weightsWithErrorRate = backendStats.map(stat => {
      // If backend has very few requests (< 5), treat it as having average error rate
      // This gives new backends a chance
      if (stat.totalRequests < 5) {
        const avgErrorRate = backendStats.reduce((sum, s) => sum + s.errorRate, 0) / backendStats.length
        return {
          backend: stat.backend,
          weight: 1 / (avgErrorRate + epsilon)
        }
      }

      // For backends with sufficient data, use actual error rate
      return {
        backend: stat.backend,
        weight: 1 / (stat.errorRate + epsilon)
      }
    })

    // Calculate total weight
    const totalWeight = weightsWithErrorRate.reduce((sum, item) => sum + item.weight, 0)

    // Weighted random selection based on inverse error rate
    let random = Math.random() * totalWeight

    for (const item of weightsWithErrorRate) {
      random -= item.weight
      if (random <= 0) {
        return item.backend
      }
    }

    // Fallback to last backend
    return weightsWithErrorRate[weightsWithErrorRate.length - 1].backend
  }
}

// Singleton instance
export const loadBalancer = new LoadBalancer()
