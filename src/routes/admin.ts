import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'

import { adminAuth } from '../middleware/auth.js'
import { apiKeyParamSchema, createApiKeySchema, updateApiKeySchema } from '../schemas/apikey.js'
import {
  addBackendToModelSchema,
  affinityMappingFilterSchema,
  clearAffinityMappingsSchema,
  createModelConfigSchema,
  modelAndBackendParamSchema,
  modelParamSchema,
  updateBackendInModelSchema,
  updateModelConfigSchema,
} from '../schemas/backend.js'
import {
  connectionParamSchema,
  createConnectionSchema,
  updateConnectionSchema,
} from '../schemas/connection.js'
import { recordedRequestsQuerySchema } from '../schemas/recorded-requests.js'
import { AffinityManager } from '../services/affinity-manager.js'
import { ConcurrencyLimiter } from '../services/concurrency-limiter.js'
import { BusinessError, ConfigManager } from '../services/config-manager.js'
import { DbMetricsCollector } from '../services/metrics/db-collector.js'
import { RequestRecorder } from '../services/request-recorder.js'

import type { ModelConfig, StatsDataPoint } from '../types/backend.js'
import type { HonoEnv } from '../types/context.js'

const admin = new Hono<HonoEnv>()
admin.use('*', adminAuth)
admin.onError((error, c) => {
  if (error instanceof BusinessError) return c.json({ error: error.message }, error.status)
  console.error('Admin request failed:', error)
  return c.json({ error: 'Internal server error' }, 500)
})

function withTrafficRatio(model: ModelConfig) {
  const totalWeight = model.backends
    .filter((backend) => backend.enabled)
    .reduce((sum, backend) => sum + backend.weight, 0)
  return {
    ...model,
    backends: model.backends.map((backend) => ({
      ...backend,
      trafficRatio: backend.enabled && totalWeight > 0 ? backend.weight / totalWeight : 0,
    })),
  }
}

admin.get('/connections', async (c) => {
  const connections = await new ConfigManager(c.env.DB).getAllConnections()
  return c.json({ connections })
})

admin.get('/connections/:id', zValidator('param', connectionParamSchema), async (c) => {
  const { id } = c.req.valid('param')
  const connection = await new ConfigManager(c.env.DB).getConnection(id)
  if (!connection) return c.json({ error: `Connection '${id}' not found` }, 404)
  return c.json({ connection })
})

admin.post('/connections', zValidator('json', createConnectionSchema), async (c) => {
  const connection = await new ConfigManager(c.env.DB).addConnection(c.req.valid('json'))
  return c.json({ connection }, 201)
})

admin.put(
  '/connections/:id',
  zValidator('param', connectionParamSchema),
  zValidator('json', updateConnectionSchema),
  async (c) => {
    const connection = await new ConfigManager(c.env.DB).updateConnection(
      c.req.valid('param').id,
      c.req.valid('json')
    )
    return c.json({ connection })
  }
)

admin.delete('/connections/:id', zValidator('param', connectionParamSchema), async (c) => {
  await new ConfigManager(c.env.DB).deleteConnection(c.req.valid('param').id)
  return c.json({ message: 'Connection deleted successfully' })
})

admin.get('/models', async (c) => {
  const models = await new ConfigManager(c.env.DB).getAllModels()
  return c.json({ models: models.map(withTrafficRatio) })
})

admin.get('/models/:model', zValidator('param', modelParamSchema), async (c) => {
  const { model } = c.req.valid('param')
  const config = await new ConfigManager(c.env.DB).getModelConfig(model)
  if (!config) return c.json({ error: `Model configuration for ${model} not found` }, 404)
  return c.json({ model: withTrafficRatio(config) })
})

admin.post('/models', zValidator('json', createModelConfigSchema), async (c) => {
  const model = await new ConfigManager(c.env.DB).addModelConfig(c.req.valid('json'))
  return c.json({ model }, 201)
})

admin.put(
  '/models/:model',
  zValidator('param', modelParamSchema),
  zValidator('json', updateModelConfigSchema),
  async (c) => {
    const { model } = c.req.valid('param')
    const updated = await new ConfigManager(c.env.DB).updateModelConfig(model, c.req.valid('json'))
    return c.json({ model: updated })
  }
)

admin.delete('/models/:model', zValidator('param', modelParamSchema), async (c) => {
  const { model } = c.req.valid('param')
  if (!(await new ConfigManager(c.env.DB).deleteModelConfig(model))) {
    return c.json({ error: `Model configuration for ${model} not found` }, 404)
  }
  return c.json({ message: 'Model configuration deleted successfully' })
})

admin.get('/models/:model/backends', zValidator('param', modelParamSchema), async (c) => {
  const { model } = c.req.valid('param')
  const config = await new ConfigManager(c.env.DB).getModelConfig(model)
  if (!config) return c.json({ error: `Model configuration for ${model} not found` }, 404)
  return c.json({ backends: withTrafficRatio(config).backends })
})

admin.get(
  '/models/:model/backends/:backendId',
  zValidator('param', modelAndBackendParamSchema),
  async (c) => {
    const { model, backendId } = c.req.valid('param')
    const config = await new ConfigManager(c.env.DB).getModelConfig(model)
    const backend = config?.backends.find((item) => item.id === backendId)
    if (!backend) return c.json({ error: `Backend ${backendId} not found in model ${model}` }, 404)
    return c.json({ backend })
  }
)

admin.post(
  '/models/:model/backends',
  zValidator('param', modelParamSchema),
  zValidator('json', addBackendToModelSchema),
  async (c) => {
    const { model } = c.req.valid('param')
    const config = await new ConfigManager(c.env.DB).addBackendToModel(model, c.req.valid('json'))
    return c.json({ model: config }, 201)
  }
)

admin.put(
  '/models/:model/backends/:backendId',
  zValidator('param', modelAndBackendParamSchema),
  zValidator('json', updateBackendInModelSchema),
  async (c) => {
    const { model, backendId } = c.req.valid('param')
    const config = await new ConfigManager(c.env.DB).updateBackendInModel(
      model,
      backendId,
      c.req.valid('json')
    )
    return c.json({ model: config })
  }
)

admin.delete(
  '/models/:model/backends/:backendId',
  zValidator('param', modelAndBackendParamSchema),
  async (c) => {
    const { model, backendId } = c.req.valid('param')
    const config = await new ConfigManager(c.env.DB).deleteBackendFromModel(model, backendId)
    return c.json({ message: 'Backend deleted successfully', model: config })
  }
)

admin.get('/stats', async (c) => {
  const endTime = new Date()
  const stats = await new DbMetricsCollector(c.env.DB).getAllStats({
    startTime: new Date(endTime.getTime() - 30_000),
    endTime,
  })
  return c.json({ stats: Array.from(stats.values()) })
})

// History routes must precede /stats/:backendId.
admin.get('/stats/history', async (c) => {
  const endTime = c.req.query('endTime') ? new Date(c.req.query('endTime')!) : new Date()
  const startTime = c.req.query('startTime')
    ? new Date(c.req.query('startTime')!)
    : new Date(endTime.getTime() - 24 * 60 * 60 * 1000)
  const points = await new DbMetricsCollector(c.env.DB).getHistoricalStats({ startTime, endTime })
  const history: Record<string, StatsDataPoint[]> = {}
  for (const point of points) (history[point.backendId] ??= []).push(point)
  return c.json({ history })
})

admin.get('/stats/history/:backendId', async (c) => {
  const backendId = c.req.param('backendId')
  const endTime = c.req.query('endTime') ? new Date(c.req.query('endTime')!) : new Date()
  const startTime = c.req.query('startTime')
    ? new Date(c.req.query('startTime')!)
    : new Date(endTime.getTime() - 24 * 60 * 60 * 1000)
  const dataPoints = await new DbMetricsCollector(c.env.DB).getHistoricalStats({
    backendId,
    startTime,
    endTime,
  })
  if (!dataPoints.length)
    return c.json({
      backendId,
      dataPoints: [],
      message: 'No historical data found for this backend',
    })
  return c.json({
    backendId,
    dataPoints,
    startTime: dataPoints[0].timestamp,
    endTime: dataPoints[dataPoints.length - 1].timestamp,
  })
})

admin.get('/stats/:backendId', async (c) => {
  const backendId = c.req.param('backendId')
  const stats = await new DbMetricsCollector(c.env.DB).getRecentStats(backendId, 30_000)
  if (!stats.totalRequests)
    return c.json({ error: `No statistics found for backend ${backendId}` }, 404)
  return c.json({ stats })
})

admin.delete('/stats/:backendId', async (c) => {
  const deletedCount = await new DbMetricsCollector(c.env.DB).resetStats(c.req.param('backendId'))
  return c.json({ message: 'Statistics reset successfully', deletedCount })
})

admin.delete('/stats', async (c) => {
  const deletedCount = await new DbMetricsCollector(c.env.DB).resetStats()
  return c.json({ message: 'All statistics reset successfully', deletedCount })
})

admin.get('/metrics', async (c) => {
  const metrics = await new DbMetricsCollector(c.env.DB, c.env.CONCURRENCY).getPrometheusMetrics()
  return c.text(metrics, 200, { 'Content-Type': 'text/plain; version=0.0.4' })
})

admin.get('/active-requests', async (c) => {
  const models = await new ConfigManager(c.env.DB).getAllModels()
  const limiter = new ConcurrencyLimiter(c.env.CONCURRENCY)
  const activeRequests: Record<
    string,
    {
      backendId: string
      model: string
      activeCount: number
      maxConcurrent: number | null
      utilizationPercent: number | null
    }
  > = {}
  await Promise.all(
    models.flatMap((model) =>
      model.backends
        .filter((backend) => backend.enabled && (backend.maxConcurrentRequests ?? 0) > 0)
        .map(async (backend) => {
          const activeCount = await limiter.getCount(backend.id)
          const maxConcurrent = backend.maxConcurrentRequests!
          activeRequests[backend.id] = {
            backendId: backend.id,
            model: model.model,
            activeCount,
            maxConcurrent,
            utilizationPercent: Math.round((activeCount / maxConcurrent) * 100),
          }
        })
    )
  )
  return c.json({ activeRequests })
})

admin.get('/recorded-requests', zValidator('query', recordedRequestsQuerySchema), async (c) => {
  const { limit, offset, ...filter } = c.req.valid('query')
  const result = await new RequestRecorder(c.env.DB, c.env.RECORDINGS).list(filter, limit, offset)
  return c.json({ ...result, limit, offset })
})

admin.get('/recorded-requests/:id', async (c) => {
  const request = await new RequestRecorder(c.env.DB, c.env.RECORDINGS).get(c.req.param('id'))
  if (!request) return c.json({ error: 'Recorded request not found' }, 404)
  return c.json({ request })
})

admin.delete(
  '/recorded-requests',
  zValidator('query', recordedRequestsQuerySchema.omit({ limit: true, offset: true })),
  async (c) => {
    const filter = c.req.valid('query')
    if (!Object.values(filter).some(Boolean)) {
      return c.json(
        { error: 'At least one filter (backendId, model, or time range) is required' },
        400
      )
    }
    const deletedCount = await new RequestRecorder(c.env.DB, c.env.RECORDINGS).delete(filter)
    return c.json({ message: 'Recorded requests deleted successfully', deletedCount })
  }
)

admin.get('/apikeys', async (c) => {
  const apiKeys = await new ConfigManager(c.env.DB).getAllApiKeys()
  return c.json({ apiKeys })
})

admin.get('/apikeys/:key', zValidator('param', apiKeyParamSchema), async (c) => {
  const apiKey = await new ConfigManager(c.env.DB).getApiKey(c.req.valid('param').key)
  if (!apiKey) return c.json({ error: 'API key not found' }, 404)
  return c.json({ apiKey })
})

admin.post('/apikeys', zValidator('json', createApiKeySchema), async (c) => {
  const apiKey = await new ConfigManager(c.env.DB).addApiKey(c.req.valid('json'))
  return c.json({ apiKey }, 201)
})

admin.put(
  '/apikeys/:key',
  zValidator('param', apiKeyParamSchema),
  zValidator('json', updateApiKeySchema),
  async (c) => {
    const apiKey = await new ConfigManager(c.env.DB).updateApiKey(
      c.req.valid('param').key,
      c.req.valid('json')
    )
    return c.json({ apiKey })
  }
)

admin.delete('/apikeys/:key', zValidator('param', apiKeyParamSchema), async (c) => {
  await new ConfigManager(c.env.DB).deleteApiKey(c.req.valid('param').key)
  return c.json({ message: 'API key deleted successfully' })
})

admin.get('/affinity', zValidator('query', affinityMappingFilterSchema), async (c) => {
  const { limit = 100, offset = 0, ...filter } = c.req.valid('query')
  const result = await new AffinityManager(c.env.DB).getAllMappings(filter, limit, offset)
  return c.json({ ...result, limit, offset })
})

admin.get('/affinity/:model/:sessionId', async (c) => {
  const model = c.req.param('model')
  const sessionId = c.req.param('sessionId')
  const mapping = await new AffinityManager(c.env.DB).getMapping(model, sessionId)
  const config = mapping ? await new ConfigManager(c.env.DB).getModelConfig(model) : undefined
  const backend = config?.backends.find(
    (item) => item.id === mapping?.backendId && item.enabled && item.weight > 0
  )
  if (!backend) return c.json({ error: 'No affinity mapping found or backend unavailable' }, 404)
  return c.json({ model, sessionId, backendId: backend.id })
})

admin.delete('/affinity', zValidator('query', clearAffinityMappingsSchema), async (c) => {
  const deletedCount = await new AffinityManager(c.env.DB).clearMappings(c.req.valid('query'))
  return c.json({ message: 'Affinity mappings cleared successfully', deletedCount })
})

admin.delete('/affinity/:model/:sessionId', async (c) => {
  const deletedCount = await new AffinityManager(c.env.DB).clearMappings({
    model: c.req.param('model'),
    sessionId: c.req.param('sessionId'),
  })
  if (!deletedCount) return c.json({ error: 'Affinity mapping not found' }, 404)
  return c.json({ message: 'Affinity mapping cleared successfully' })
})

export default admin
