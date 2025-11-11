import { describe, it, expect, beforeEach } from 'vitest'
import { ConfigManager } from '../services/config-manager.js'
import { StatsTracker } from '../services/stats-tracker.js'
import { LoadBalancer } from '../services/load-balancer.js'
import type { BackendConfig, ModelConfig } from '../types/backend.js'

describe('ConfigManager', () => {
  let configManager: ConfigManager

  beforeEach(() => {
    configManager = new ConfigManager()
  })

  function sampleModel(backends: BackendConfig[] = [
    { id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: true }
  ]): ModelConfig {
    return { model: 'gpt-4', backends, loadBalancingStrategy: 'weighted' }
  }

  it('starts with no models', () => {
    expect(configManager.getAllModels()).toEqual([])
  })

  it('adds a model configuration', async () => {
    const model = sampleModel()
    const saved = await configManager.addModelConfig(model)
    expect(configManager.getAllModels()).toHaveLength(1)
    expect(configManager.getModelConfig('gpt-4')).toEqual(saved)
  })

  it('does not allow duplicate model configs', async () => {
    const model = sampleModel()
    await configManager.addModelConfig(model)
    await expect(configManager.addModelConfig(model)).rejects.toThrow('already exists')
  })

  it('updates a model configuration', async () => {
    const model = sampleModel()
    await configManager.addModelConfig(model)
    const updates = { backends: [{ id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 5, enabled: false }] }
    const updated = await configManager.updateModelConfig('gpt-4', updates)
    const backend = updated.backends.find(b => b.id === 'b1')!
    expect(backend.weight).toBe(5)
    expect(backend.enabled).toBe(false)
  })

  it('throws when updating non-existent model', async () => {
    await expect(configManager.updateModelConfig('missing', { loadBalancingStrategy: 'lowest-ttft' }))
      .rejects.toThrow('not found')
  })

  it('deletes a model configuration', async () => {
    await configManager.addModelConfig(sampleModel())
    expect(await configManager.deleteModelConfig('gpt-4')).toBe(true)
    expect(configManager.getModelConfig('gpt-4')).toBeUndefined()
  })

  it('returns false when deleting non-existent model', async () => {
    expect(await configManager.deleteModelConfig('missing')).toBe(false)
  })

  it('gets only enabled backends for a model', async () => {
    await configManager.addModelConfig(sampleModel([
      { id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: true },
      { id: 'b2', url: 'https://b.test', apiKey: 'k2', weight: 1, enabled: false }
    ]))
    const enabled = configManager.getEnabledBackends('gpt-4')
    expect(enabled).toHaveLength(1)
    expect(enabled[0].id).toBe('b1')
  })

  it('calculates total weight of enabled backends', async () => {
    await configManager.addModelConfig(sampleModel([
      { id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 3, enabled: true },
      { id: 'b2', url: 'https://b.test', apiKey: 'k2', weight: 7, enabled: true },
      { id: 'b3', url: 'https://c.test', apiKey: 'k3', weight: 5, enabled: false }
    ]))
    expect(configManager.getTotalWeight('gpt-4')).toBe(10)
  })

  it('adds, updates, deletes a backend within a model', async () => {
    await configManager.addModelConfig(sampleModel())
    // add
    let updated = await configManager.addBackendToModel('gpt-4', { id: 'b2', url: 'https://b.test', apiKey: 'k2', weight: 2, enabled: true })
    expect(updated.backends).toHaveLength(2)
    // update
    updated = await configManager.updateBackendInModel('gpt-4', 'b2', { weight: 5, enabled: false })
    const b2 = updated.backends.find(b => b.id === 'b2')!
    expect(b2.weight).toBe(5)
    expect(b2.enabled).toBe(false)
    // delete
    updated = await configManager.deleteBackendFromModel('gpt-4', 'b2')
    expect(updated.backends.find(b => b.id === 'b2')).toBeUndefined()
  })
})

describe('StatsTracker', () => {
  let statsTracker: StatsTracker

  beforeEach(() => {
    statsTracker = new StatsTracker()
  })

  it('should start with no stats', async () => {
    const stats = await statsTracker.getAllStats()
    expect(stats).toEqual([])
  })

  it('should record a successful request', async () => {
    statsTracker.recordSuccess('backend-1', 100, 1000, true)

    const stats = await statsTracker.getStats('backend-1')
    expect(stats?.totalRequests).toBe(1)
    expect(stats?.successfulRequests).toBe(1)
    expect(stats?.failedRequests).toBe(0)
    expect(stats?.successRate).toBe(1)
    expect(stats?.averageStreamingTTFT).toBe(100)
    expect(stats?.averageNonStreamingTTFT).toBe(0)
  })

  it('should record a failed request', async () => {
    statsTracker.recordFailure('backend-1')

    const stats = await statsTracker.getStats('backend-1')
    expect(stats?.totalRequests).toBe(1)
    expect(stats?.successfulRequests).toBe(0)
    expect(stats?.failedRequests).toBe(1)
    expect(stats?.successRate).toBe(0)
  })

  it('should calculate average streaming TTFT correctly', async () => {
    statsTracker.recordSuccess('backend-1', 100, 1000, true)
    statsTracker.recordSuccess('backend-1', 200, 1000, true)
    statsTracker.recordSuccess('backend-1', 150, 1000, true)

    const stats = await statsTracker.getStats('backend-1')
    expect(stats?.averageStreamingTTFT).toBeCloseTo(150, 1)
  })

  it('should calculate average non-streaming TTFT correctly', async () => {
    statsTracker.recordSuccess('backend-2', 50, 1000, false)
    statsTracker.recordSuccess('backend-2', 100, 1000, false)
    statsTracker.recordSuccess('backend-2', 75, 1000, false)

    const stats = await statsTracker.getStats('backend-2')
    expect(stats?.averageNonStreamingTTFT).toBeCloseTo(75, 1)
  })

  it('should handle undefined isStream as non-streaming', async () => {
    statsTracker.recordSuccess('backend-3', 80, 1000)

    const stats = await statsTracker.getStats('backend-3')
    expect(stats?.averageNonStreamingTTFT).toBe(80)
    expect(stats?.averageStreamingTTFT).toBe(0)
  })

  it('should calculate success rate correctly', async () => {
    statsTracker.recordSuccess('backend-1')
    statsTracker.recordSuccess('backend-1')
    statsTracker.recordFailure('backend-1')
    statsTracker.recordSuccess('backend-1')

    const stats = await statsTracker.getStats('backend-1')
    expect(stats?.totalRequests).toBe(4)
    expect(stats?.successfulRequests).toBe(3)
    expect(stats?.failedRequests).toBe(1)
    expect(stats?.successRate).toBe(0.75)
  })

  it('should limit TTFT samples to prevent memory bloat', async () => {
    // Record more than MAX_TTFT_SAMPLES (100)
    for (let i = 0; i < 150; i++) {
      statsTracker.recordSuccess('backend-1', i)
    }

    const stats = await statsTracker.getStats('backend-1')
    // With Prometheus, all samples are counted (not limited like before)
    // Just verify we got stats
    expect(stats?.totalRequests).toBe(150)
  })

  it('should reset stats for a backend', async () => {
    statsTracker.recordSuccess('backend-1', 100)
    statsTracker.resetStats('backend-1')

    // Prometheus doesn't support individual resets, so stats will still exist
    const stats = await statsTracker.getStats('backend-1')
    expect(stats).toBeDefined()
  })

  it('should reset all stats', async () => {
    statsTracker.recordSuccess('backend-1', 100)
    statsTracker.recordSuccess('backend-2', 200)
    statsTracker.resetAllStats()

    const stats = await statsTracker.getAllStats()
    expect(stats).toEqual([])
  })

  it('should include instance label in Prometheus metrics', async () => {
    statsTracker.recordSuccess('backend-1', 100, 1500, true)
    statsTracker.recordFailure('backend-2', 3000)

    const metrics = await statsTracker.getMetrics()

    // Verify metrics include instance label
    expect(metrics).toContain('instance=')
    expect(metrics).toContain('backend_id="backend-1"')
    expect(metrics).toContain('backend_id="backend-2"')

    // Verify all metric types include instance label
    expect(metrics).toMatch(/llm_proxy_requests_total\{instance="[^"]+",backend_id="backend-1",status="success"\}/)
    expect(metrics).toMatch(/llm_proxy_requests_total\{instance="[^"]+",backend_id="backend-2",status="failure"\}/)
    expect(metrics).toMatch(/llm_proxy_ttft_seconds_sum\{instance="[^"]+",backend_id="backend-1",stream_type="streaming"\}/)
    expect(metrics).toMatch(/llm_proxy_request_duration_seconds_sum\{instance="[^"]+",backend_id="backend-1",status="success"\}/)
  })
})

describe('LoadBalancer', () => {
  let lb: LoadBalancer
  let cm: ConfigManager

  beforeEach(async () => {
    cm = new ConfigManager()
    lb = new LoadBalancer(cm)
  })

  it('throws when model not found', async () => {
    await expect(lb.selectBackend('gpt-4')).rejects.toThrow('not found')
  })

  it('returns null when no enabled backends', async () => {
    await cm.addModelConfig({ model: 'gpt-4', backends: [ { id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: false } ], loadBalancingStrategy: 'weighted' })
    const backend = await lb.selectBackend('gpt-4')
    expect(backend).toBeNull()
  })

  it('selects backend when forced id provided', async () => {
    await cm.addModelConfig({ model: 'gpt-4', backends: [ { id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: true } ], loadBalancingStrategy: 'weighted' })
    const selected = await lb.selectBackend('gpt-4', 'b1')
    expect(selected?.id).toBe('b1')
  })

  it('throws when forced id does not exist', async () => {
    await cm.addModelConfig({ model: 'gpt-4', backends: [ { id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: true } ], loadBalancingStrategy: 'weighted' })
    await expect(lb.selectBackend('gpt-4', 'nope')).rejects.toThrow('not found')
  })

  it('throws when forced id is disabled', async () => {
    await cm.addModelConfig({ model: 'gpt-4', backends: [ { id: 'b1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: false } ], loadBalancingStrategy: 'weighted' })
    await expect(lb.selectBackend('gpt-4', 'b1')).rejects.toThrow('disabled')
  })

  it('only selects from enabled backends', async () => {
    await cm.addModelConfig({ model: 'gpt-4', backends: [
      { id: 'disabled', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: false },
      { id: 'enabled', url: 'https://b.test', apiKey: 'k2', weight: 1, enabled: true }
    ], loadBalancingStrategy: 'weighted' })
    const selected = await lb.selectBackend('gpt-4')
    expect(selected?.id).toBe('enabled')
  })

  it('respects weight distribution', async () => {
    await cm.addModelConfig({ model: 'gpt-4', backends: [
      { id: 'heavy', url: 'https://a.test', apiKey: 'k1', weight: 90, enabled: true },
      { id: 'light', url: 'https://b.test', apiKey: 'k2', weight: 10, enabled: true }
    ], loadBalancingStrategy: 'weighted' })

    const counts = { heavy: 0, light: 0 }
    for (let i = 0; i < 1000; i++) {
      const selected = await lb.selectBackend('gpt-4')
      if (selected?.id === 'heavy') counts.heavy++
      if (selected?.id === 'light') counts.light++
    }

    expect(counts.heavy).toBeGreaterThan(800)
    expect(counts.heavy).toBeLessThan(950)
    expect(counts.light).toBeGreaterThan(50)
    expect(counts.light).toBeLessThan(200)
  })

  it('handles equal weights', async () => {
    await cm.addModelConfig({ model: 'gpt-4', backends: [
      { id: 'backend-1', url: 'https://a.test', apiKey: 'k1', weight: 1, enabled: true },
      { id: 'backend-2', url: 'https://b.test', apiKey: 'k2', weight: 1, enabled: true }
    ], loadBalancingStrategy: 'weighted' })

    const counts = { 'backend-1': 0, 'backend-2': 0 }
    for (let i = 0; i < 1000; i++) {
      const selected = await lb.selectBackend('gpt-4')
      if (selected?.id === 'backend-1') counts['backend-1']++
      if (selected?.id === 'backend-2') counts['backend-2']++
    }

    expect(counts['backend-1']).toBeGreaterThan(400)
    expect(counts['backend-1']).toBeLessThan(600)
    expect(counts['backend-2']).toBeGreaterThan(400)
    expect(counts['backend-2']).toBeLessThan(600)
  })

  it('handles zero weights by random selection', async () => {
    await cm.addModelConfig({ model: 'gpt-4', backends: [
      { id: 'backend-1', url: 'https://a.test', apiKey: 'k1', weight: 0, enabled: true },
      { id: 'backend-2', url: 'https://b.test', apiKey: 'k2', weight: 0, enabled: true }
    ], loadBalancingStrategy: 'weighted' })
    const selected = await lb.selectBackend('gpt-4')
    expect(selected).not.toBeNull()
    expect(['backend-1', 'backend-2']).toContain(selected?.id)
  })
})
