import { DbMetricsCollector } from './db-collector.js'
import { NoopMetricsCollector } from './noop-collector.js'

import type { MetricsCollector } from './interface.js'
import type { Db } from 'mongodb'

export * from './interface.js'
export * from './types.js'

export interface MetricsCollectorConfig {
  enabled: boolean
  db?: Db
  instanceId?: string
}

/**
 * Factory function to create the appropriate metrics collector
 * @param config Configuration object
 * @returns MetricsCollector instance (either DbMetricsCollector or NoopMetricsCollector)
 */
export async function createMetricsCollector(
  config: MetricsCollectorConfig
): Promise<MetricsCollector> {
  if (!config.enabled) {
    console.log('Metrics collection disabled')
    return new NoopMetricsCollector()
  }

  if (!config.db) {
    console.warn('Metrics enabled but MongoDB not available, falling back to NoopMetricsCollector')
    return new NoopMetricsCollector()
  }

  try {
    const collector = new DbMetricsCollector(config.db, config.instanceId)
    await collector.initialize()
    console.log('Metrics collection enabled with database backend')
    return collector
  } catch (error) {
    console.error(
      'Failed to initialize DbMetricsCollector, falling back to NoopMetricsCollector:',
      error
    )
    return new NoopMetricsCollector()
  }
}

/**
 * Validate that metrics-dependent strategies are compatible with metrics config
 * Throws error if validation fails
 */
export function validateMetricsRequirement(strategy: string, metricsEnabled: boolean): void {
  const metricsRequiredStrategies = ['lowest-ttft', 'min-error-rate']

  if (metricsRequiredStrategies.includes(strategy) && !metricsEnabled) {
    throw new Error(
      `Strategy '${strategy}' requires metrics to be enabled. ` +
        `Set ENABLE_METRICS=true or use another strategy (e.g., 'weighted', 'round-robin')`
    )
  }
}
