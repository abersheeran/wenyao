import type { BackendConfig, LoadBalancingStrategy, ModelConfig } from '../types/backend.js'
import { configManager, type ConfigManager } from './config-manager.js'
import { affinityManager } from './affinity-manager.js'
import type { MetricsCollector } from './metrics/index.js'

/**
 * Load Balancer
 *
 * Responsible for selecting the most appropriate backend for a given request.
 * Implements various strategies:
 * - Weighted Round Robin (fallback)
 * - Lowest TTFT (Time-To-First-Token)
 * - Minimum Error Rate
 *
 * Also handles forced backend selection via headers and session affinity.
 */
export class LoadBalancer {
  private configManager: ConfigManager
  private metricsCollector: MetricsCollector | null

  constructor(configMgr?: ConfigManager, metricsCollector?: MetricsCollector) {
    this.configManager = configMgr || configManager
    this.metricsCollector = metricsCollector || null
  }

  /**
   * Updates the metrics collector instance.
   * Required for metrics-based strategies (lowest-ttft, min-error-rate).
   */
  setMetricsCollector(metricsCollector: MetricsCollector): void {
    this.metricsCollector = metricsCollector
  }

  /**
   * Selects a backend for a specific model request.
   *
   * Precedence:
   * 1. Forced backend (via X-Backend-ID header).
   * 2. Session affinity (if enabled for the model and session ID provided).
   * 3. Configured load balancing strategy.
   *
   * @param model - The target model name
   * @param forceBackendId - Optional ID to override selection
   * @param isStream - Whether the request is streaming
   * @param sessionId - Optional session ID for affinity
   * @returns Selected backend or null if no healthy backends are available.
   */
  async selectBackend(model: string, forceBackendId?: string, isStream?: boolean, sessionId?: string): Promise<BackendConfig | null> {
    const modelConfig = this.configManager.getModelConfig(model)

    if (!modelConfig) {
      throw new Error(`Model configuration for ${model} not found`)
    }

    // Priority 1: Force backend via X-Backend-ID header
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

    // Priority 2: Check affinity if enabled and sessionId provided
    if (modelConfig.enableAffinity && sessionId) {
      const affinityBackend = await affinityManager.getAffinityBackend(
        model,
        sessionId,
        this.configManager
      )
      if (affinityBackend) {
        console.log(`Using affinity backend ${affinityBackend.id} for session ${sessionId}`)
        return affinityBackend
      }
    }

    // Priority 3: Standard load balancing
    // Get backends for selection (excluding weight=0 backends)
    const backendsForSelection = this.configManager.getBackendsForSelection(model)

    if (backendsForSelection.length === 0) {
      return null
    }

    // Single backend - no need for load balancing
    if (backendsForSelection.length === 1) {
      return backendsForSelection[0]
    }

    // Apply load balancing strategy
    return this.applyStrategy(modelConfig, backendsForSelection, isStream)
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
        return await this.selectByMinErrorRate(enabledBackends, modelConfig)

      default:
        // Fallback to weighted strategy
        return this.selectByWeight(enabledBackends)
    }
  }

  /**
   * Weighted random selection strategy
   * Selects backends based on their configured weight
   * Filters out backends with weight=0
   */
  private selectByWeight(backends: BackendConfig[]): BackendConfig {
    // Filter out backends with weight=0
    const eligibleBackends = backends.filter(b => b.weight > 0)

    if (eligibleBackends.length === 0) {
      throw new Error('No backends with weight > 0 available for selection')
    }

    const totalWeight = eligibleBackends.reduce((sum, backend) => sum + backend.weight, 0)

    // Weighted random selection
    let random = Math.random() * totalWeight

    for (const backend of eligibleBackends) {
      random -= backend.weight
      if (random <= 0) {
        return backend
      }
    }

    // Fallback to last backend (should not reach here)
    return eligibleBackends[eligibleBackends.length - 1]
  }

  /**
   * Lowest TTFT (Time To First Token) strategy
   * Selects the backend with the lowest average TTFT
   * Uses stream-specific TTFT based on isStream parameter (undefined treated as non-streaming)
   * Uses time-windowed statistics (15 minutes) for more responsive selection
   * Includes cold start protection: backends without data use average TTFT of other backends
   * Filters out backends with weight=0
   */
  private async selectByLowestTTFT(backends: BackendConfig[], isStream?: boolean): Promise<BackendConfig> {
    // Check if metrics are available
    if (!this.metricsCollector || !this.metricsCollector.isEnabled()) {
      throw new Error('Strategy \'lowest-ttft\' requires metrics to be enabled. Set ENABLE_METRICS=true or use another strategy.')
    }

    // Filter out backends with weight=0
    const eligibleBackends = backends.filter(b => b.weight > 0)

    if (eligibleBackends.length === 0) {
      throw new Error('No backends with weight > 0 available for selection')
    }

    // Treat undefined isStream as false (non-streaming)
    const useStreaming = isStream === true

    // Get recent stats for all eligible backends (15 minute window)
    const backendStatsPromises = eligibleBackends.map(async backend => {
      const stats = await this.metricsCollector!.getRecentStats(backend.id, 15 * 60 * 1000) // 15 minutes in ms

      return {
        backend,
        stats,
        hasData: stats.totalRequests > 0
      }
    })

    const backendStats = await Promise.all(backendStatsPromises)

    // Calculate average TTFT for cold start protection
    const backendsWithData = backendStats.filter(s => s.hasData)
    const avgTTFT = backendsWithData.length > 0
      ? backendsWithData.reduce((sum, s) => {
          const ttft = useStreaming ? s.stats!.averageStreamingTTFT : s.stats!.averageNonStreamingTTFT
          return sum + ttft
        }, 0) / backendsWithData.length
      : 1000 // Default to 1000ms if no backends have data

    // Assign TTFT values, using average for backends without data
    const backendStatsWithTTFT = backendStats.map(stat => {
      let averageTTFT: number
      if (stat.hasData) {
        averageTTFT = useStreaming ? stat.stats.averageStreamingTTFT : stat.stats.averageNonStreamingTTFT
      } else {
        // Cold start protection: use average TTFT
        averageTTFT = avgTTFT
      }

      return {
        backend: stat.backend,
        averageTTFT
      }
    })

    // Sort by average TTFT (ascending)
    backendStatsWithTTFT.sort((a, b) => a.averageTTFT - b.averageTTFT)

    // Return backend with lowest TTFT
    return backendStatsWithTTFT[0].backend
  }

  /**
   * Minimum error rate strategy (improved version)
   * Dynamically adjusts traffic based on error rates with:
   * - Time-windowed statistics (default: 15 minutes)
   * - Circuit breaker for high-error backends
   * - Cold start protection
   * - Configurable weight integration
   * Filters out backends with weight=0
   */
  private async selectByMinErrorRate(backends: BackendConfig[], modelConfig: ModelConfig): Promise<BackendConfig> {
    // Check if metrics are available
    if (!this.metricsCollector || !this.metricsCollector.isEnabled()) {
      throw new Error('Strategy \'min-error-rate\' requires metrics to be enabled. Set ENABLE_METRICS=true or use another strategy.')
    }

    // Filter out backends with weight=0
    const eligibleBackends = backends.filter(b => b.weight > 0)

    if (eligibleBackends.length === 0) {
      throw new Error('No backends with weight > 0 available for selection')
    }

    // Get configuration options with defaults
    const options = modelConfig.minErrorRateOptions || {}
    const MIN_REQUESTS = options.minRequests ?? 20
    const CIRCUIT_BREAKER_THRESHOLD = options.circuitBreakerThreshold ?? 0.9
    const EPSILON = options.epsilon ?? 0.001
    const TIME_WINDOW_MINUTES = options.timeWindowMinutes ?? 15

    // Get time-windowed stats for all eligible backends
    const backendStatsPromises = eligibleBackends.map(async backend => {
      const stats = await this.metricsCollector!.getRecentStats(backend.id, TIME_WINDOW_MINUTES * 60 * 1000) // Convert to ms
      return {
        backend,
        errorRate: (1 - stats.successRate), // Error rate = 1 - success rate
        totalRequests: stats.totalRequests
      }
    })

    const backendStats = await Promise.all(backendStatsPromises)

    // Calculate average error rate for cold start protection
    const backendsWithData = backendStats.filter(s => s.totalRequests >= MIN_REQUESTS)
    const avgErrorRate = backendsWithData.length > 0
      ? backendsWithData.reduce((sum, s) => sum + s.errorRate, 0) / backendsWithData.length
      : 0.1 // Default to 10% if no backends have sufficient data

    // Filter out backends that should be circuit broken and calculate weights
    const weightsWithErrorRate = backendStats
      .filter(stat => {
        // Circuit breaker: exclude backends with high error rate and sufficient data
        if (stat.totalRequests >= MIN_REQUESTS && stat.errorRate > CIRCUIT_BREAKER_THRESHOLD) {
          console.log(`Circuit breaker triggered for backend ${stat.backend.id}: error rate ${(stat.errorRate * 100).toFixed(1)}% (threshold: ${(CIRCUIT_BREAKER_THRESHOLD * 100).toFixed(1)}%)`)
          return false
        }
        return true
      })
      .map(stat => {
        let effectiveErrorRate: number

        // Cold start protection: use average error rate for backends with insufficient data
        if (stat.totalRequests < MIN_REQUESTS) {
          effectiveErrorRate = avgErrorRate
        } else {
          effectiveErrorRate = stat.errorRate
        }

        // Calculate weight: combine configured weight with inverse error rate
        // weight = (configured_weight) / (error_rate + epsilon)
        const configuredWeight = stat.backend.weight > 0 ? stat.backend.weight : 1
        const weight = configuredWeight / (effectiveErrorRate + EPSILON)

        return {
          backend: stat.backend,
          weight,
          errorRate: stat.errorRate,
          totalRequests: stat.totalRequests
        }
      })

    // If all backends are circuit broken, fall back to weighted strategy
    if (weightsWithErrorRate.length === 0) {
      console.warn('All backends circuit broken, falling back to weighted strategy')
      return this.selectByWeight(eligibleBackends)
    }

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
