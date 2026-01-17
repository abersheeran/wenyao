import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { configManager } from '../services/config-manager.js'
import { mongoDBService } from '../services/mongodb.js'
import { affinityManager } from '../services/affinity-manager.js'
import { concurrencyLimiter } from '../services/concurrency-limiter.js'
import { getMetricsCollector } from '../index.js'
import {
  createModelConfigSchema,
  updateModelConfigSchema,
  addBackendToModelSchema,
  updateBackendInModelSchema,
  modelParamSchema,
  modelAndBackendParamSchema,
  affinityMappingFilterSchema,
  clearAffinityMappingsSchema
} from '../schemas/backend.js'
import {
  createApiKeySchema,
  updateApiKeySchema,
  apiKeyParamSchema
} from '../schemas/apikey.js'
import { recordedRequestsQuerySchema } from '../schemas/recorded-requests.js'
import { adminAuth } from '../middleware/auth.js'
import { ObjectId } from 'mongodb'

const admin = new Hono()

admin.use('*', adminAuth)

// ===== Model Configuration Endpoints =====

// GET /admin/models - Get all model configurations
admin.get('/models', (c) => {
  const models = configManager.getAllModels()

  // Calculate traffic ratio for each backend within each model
  const modelsWithRatio = models.map(model => {
    const totalWeight = configManager.getTotalWeight(model.model)
    const backendsWithRatio = model.backends.map(backend => ({
      ...backend,
      trafficRatio: backend.enabled && totalWeight > 0
        ? backend.weight / totalWeight
        : 0
    }))

    return {
      ...model,
      backends: backendsWithRatio
    }
  })

  return c.json({ models: modelsWithRatio })
})

// GET /admin/models/:model - Get a specific model configuration
admin.get(
  '/models/:model',
  zValidator('param', modelParamSchema),
  (c) => {
    const { model } = c.req.valid('param')
    const modelConfig = configManager.getModelConfig(model)

    if (!modelConfig) {
      return c.json({ error: `Model configuration for ${model} not found` }, 404)
    }

    // Calculate traffic ratio for each backend
    const totalWeight = configManager.getTotalWeight(model)
    const backendsWithRatio = modelConfig.backends.map(backend => ({
      ...backend,
      trafficRatio: backend.enabled && totalWeight > 0
        ? backend.weight / totalWeight
        : 0
    }))

    return c.json({
      model: {
        ...modelConfig,
        backends: backendsWithRatio
      }
    })
  }
)

// POST /admin/models - Add a new model configuration
admin.post(
  '/models',
  zValidator('json', createModelConfigSchema),
  async (c) => {
    const body = c.req.valid('json')
    const modelConfig = await configManager.addModelConfig(body)
    return c.json({ model: modelConfig }, 201)
  }
)

// PUT /admin/models/:model - Update a model configuration
admin.put(
  '/models/:model',
  zValidator('param', modelParamSchema),
  zValidator('json', updateModelConfigSchema),
  async (c) => {
    const { model } = c.req.valid('param')
    const updates = c.req.valid('json')
    const modelConfig = await configManager.updateModelConfig(model, updates)
    return c.json({ model: modelConfig })
  }
)

// DELETE /admin/models/:model - Delete a model configuration
admin.delete(
  '/models/:model',
  zValidator('param', modelParamSchema),
  async (c) => {
    const { model } = c.req.valid('param')
    const deleted = await configManager.deleteModelConfig(model)

    if (!deleted) {
      return c.json({ error: `Model configuration for ${model} not found` }, 404)
    }

    return c.json({ message: 'Model configuration deleted successfully' })
  }
)

// ===== Backend Management within Models =====

// GET /admin/models/:model/backends - Get all backends for a model
admin.get(
  '/models/:model/backends',
  zValidator('param', modelParamSchema),
  (c) => {
    const { model } = c.req.valid('param')
    const modelConfig = configManager.getModelConfig(model)

    if (!modelConfig) {
      return c.json({ error: `Model configuration for ${model} not found` }, 404)
    }

    const totalWeight = configManager.getTotalWeight(model)
    const backendsWithRatio = modelConfig.backends.map(backend => ({
      ...backend,
      trafficRatio: backend.enabled && totalWeight > 0
        ? backend.weight / totalWeight
        : 0
    }))

    return c.json({ backends: backendsWithRatio })
  }
)

// GET /admin/models/:model/backends/:backendId - Get a specific backend
admin.get(
  '/models/:model/backends/:backendId',
  zValidator('param', modelAndBackendParamSchema),
  (c) => {
    const { model, backendId } = c.req.valid('param')
    const backend = configManager.getBackend(model, backendId)

    if (!backend) {
      return c.json({
        error: `Backend ${backendId} not found in model ${model}`
      }, 404)
    }

    return c.json({ backend })
  }
)

// POST /admin/models/:model/backends - Add a backend to a model
admin.post(
  '/models/:model/backends',
  zValidator('param', modelParamSchema),
  zValidator('json', addBackendToModelSchema),
  async (c) => {
    const { model } = c.req.valid('param')
    const backend = c.req.valid('json')
    const modelConfig = await configManager.addBackendToModel(model, backend)
    return c.json({ model: modelConfig }, 201)
  }
)

// PUT /admin/models/:model/backends/:backendId - Update a backend
admin.put(
  '/models/:model/backends/:backendId',
  zValidator('param', modelAndBackendParamSchema),
  zValidator('json', updateBackendInModelSchema),
  async (c) => {
    const { model, backendId } = c.req.valid('param')
    const updates = c.req.valid('json')
    const modelConfig = await configManager.updateBackendInModel(model, backendId, updates)
    return c.json({ model: modelConfig })
  }
)

// DELETE /admin/models/:model/backends/:backendId - Delete a backend
admin.delete(
  '/models/:model/backends/:backendId',
  zValidator('param', modelAndBackendParamSchema),
  async (c) => {
    const { model, backendId } = c.req.valid('param')
    const modelConfig = await configManager.deleteBackendFromModel(model, backendId)
    return c.json({
      message: 'Backend deleted successfully',
      model: modelConfig
    })
  }
)

// ===== Statistics Endpoints =====

// GET /admin/stats - Get aggregated near-realtime statistics from all instances
admin.get('/stats', async (c) => {
  const metricsCollector = getMetricsCollector()

  if (!metricsCollector.isEnabled()) {
    return c.json({ error: 'Metrics collection is disabled' }, 503)
  }

  try {
    // Get recent stats from last 30 seconds
    const now = new Date()
    const thirtySecondsAgo = new Date(now.getTime() - 30 * 1000)

    const statsMap = await metricsCollector.getAllStats({
      startTime: thirtySecondsAgo,
      endTime: now
    })

    // Convert Map to array format
    const stats = Array.from(statsMap.values())

    return c.json({ stats })
  } catch (error) {
    console.error('Error fetching aggregated stats:', error)
    return c.json({ error: 'Failed to fetch stats' }, 500)
  }
})

// ===== Historical Statistics Endpoints =====
// IMPORTANT: These must come BEFORE /stats/:backendId to avoid route conflicts

// GET /admin/stats/history - Get historical stats for all backends (aggregated across instances)
admin.get('/stats/history', async (c) => {
  const metricsCollector = getMetricsCollector()

  if (!metricsCollector.isEnabled()) {
    return c.json({ error: 'Metrics collection is disabled' }, 503)
  }

  const startTimeParam = c.req.query('startTime')
  const endTimeParam = c.req.query('endTime')
  const instanceId = c.req.query('instanceId') // Optional: filter by specific instance

  // Default to last 24 hours if not specified
  const endTime = endTimeParam ? new Date(endTimeParam) : new Date()
  const startTime = startTimeParam
    ? new Date(startTimeParam)
    : new Date(endTime.getTime() - 24 * 60 * 60 * 1000)

  try {
    const dataPoints = await metricsCollector.getHistoricalStats({
      instanceId,
      startTime,
      endTime
    })

    if (dataPoints.length === 0) {
      return c.json({ history: {} })
    }

    // Group by backendId
    const grouped: Record<string, any[]> = {}
    for (const point of dataPoints) {
      if (!grouped[point.backendId]) grouped[point.backendId] = []
      grouped[point.backendId].push(point)
    }

    return c.json({ history: grouped })
  } catch (error) {
    console.error('Error fetching historical stats:', error)
    return c.json({ error: 'Failed to fetch historical stats' }, 500)
  }
})

// GET /admin/stats/history/:backendId - Get historical stats for a specific backend
admin.get('/stats/history/:backendId', async (c) => {
  const metricsCollector = getMetricsCollector()

  if (!metricsCollector.isEnabled()) {
    return c.json({ error: 'Metrics collection is disabled' }, 503)
  }

  const backendId = c.req.param('backendId')
  const startTimeParam = c.req.query('startTime')
  const endTimeParam = c.req.query('endTime')

  // Default to last 24 hours if not specified
  const endTime = endTimeParam ? new Date(endTimeParam) : new Date()
  const startTime = startTimeParam
    ? new Date(startTimeParam)
    : new Date(endTime.getTime() - 24 * 60 * 60 * 1000)

  try {
    const dataPoints = await metricsCollector.getHistoricalStats({
      backendId,
      startTime,
      endTime
    })

    if (dataPoints.length === 0) {
      return c.json({
        backendId,
        dataPoints: [],
        message: 'No historical data found for this backend'
      })
    }

    return c.json({
      backendId,
      dataPoints,
      startTime: dataPoints[0].timestamp,
      endTime: dataPoints[dataPoints.length - 1].timestamp
    })
  } catch (error) {
    console.error(`Error fetching historical stats for backend ${backendId}:`, error)
    return c.json({ error: 'Failed to fetch historical stats' }, 500)
  }
})

// GET /admin/stats/:backendId - Get statistics for a specific backend
admin.get('/stats/:backendId', async (c) => {
  const metricsCollector = getMetricsCollector()

  if (!metricsCollector.isEnabled()) {
    return c.json({ error: 'Metrics collection is disabled' }, 503)
  }

  const backendId = c.req.param('backendId')

  try {
    // Get recent stats from last 30 seconds
    const stats = await metricsCollector.getRecentStats(backendId, 30 * 1000)

    if (stats.totalRequests === 0) {
      return c.json({ error: `No statistics found for backend ${backendId}` }, 404)
    }

    return c.json({ stats })
  } catch (error) {
    console.error(`Error fetching stats for backend ${backendId}:`, error)
    return c.json({ error: 'Failed to fetch stats' }, 500)
  }
})

// DELETE /admin/stats/:backendId - Reset statistics for a specific backend
admin.delete('/stats/:backendId', async (c) => {
  const metricsCollector = getMetricsCollector()

  if (!metricsCollector.isEnabled()) {
    return c.json({ error: 'Metrics collection is disabled' }, 503)
  }

  const backendId = c.req.param('backendId')

  try {
    const deletedCount = await metricsCollector.resetStats(backendId)
    return c.json({
      message: 'Statistics reset successfully',
      deletedCount
    })
  } catch (error) {
    console.error(`Error resetting stats for backend ${backendId}:`, error)
    return c.json({ error: 'Failed to reset stats' }, 500)
  }
})

// DELETE /admin/stats - Reset all statistics
admin.delete('/stats', async (c) => {
  const metricsCollector = getMetricsCollector()

  if (!metricsCollector.isEnabled()) {
    return c.json({ error: 'Metrics collection is disabled' }, 503)
  }

  try {
    const deletedCount = await metricsCollector.resetStats()
    return c.json({
      message: 'All statistics reset successfully',
      deletedCount
    })
  } catch (error) {
    console.error('Error resetting all stats:', error)
    return c.json({ error: 'Failed to reset stats' }, 500)
  }
})

// GET /admin/metrics - Get Prometheus metrics
admin.get('/metrics', async (c) => {
  const metricsCollector = getMetricsCollector()

  if (!metricsCollector.isEnabled()) {
    return c.text('# Metrics collection is disabled\n', 503, {
      'Content-Type': 'text/plain; version=0.0.4'
    })
  }

  try {
    const metrics = await metricsCollector.getPrometheusMetrics()
    return c.text(metrics, 200, {
      'Content-Type': 'text/plain; version=0.0.4'
    })
  } catch (error) {
    console.error('Error fetching Prometheus metrics:', error)
    return c.text('# Error fetching metrics\n', 500, {
      'Content-Type': 'text/plain; version=0.0.4'
    })
  }
})

// GET /admin/active-requests - Get active request counts for all backends
admin.get('/active-requests', async (c) => {
  const metricsCollector = getMetricsCollector()

  if (!metricsCollector.isEnabled()) {
    return c.json({ error: 'Metrics collection is disabled' }, 503)
  }

  const models = configManager.getAllModels()
  const activeRequests: Record<string, {
    backendId: string
    model: string
    activeCount: number
    maxConcurrent: number | null
    utilizationPercent: number | null
  }> = {}

  const allActiveCounts = await concurrencyLimiter.getAllActiveRequestCounts()

  for (const model of models) {
    for (const backend of model.backends) {
      if (backend.enabled) {
        const activeCount = allActiveCounts[backend.id] || 0
        const maxConcurrent = backend.maxConcurrentRequests || null
        const utilizationPercent = maxConcurrent
          ? Math.round((activeCount / maxConcurrent) * 100)
          : null

        activeRequests[backend.id] = {
          backendId: backend.id,
          model: model.model,
          activeCount,
          maxConcurrent,
          utilizationPercent
        }
      }
    }
  }

  return c.json({ activeRequests })
})

// ===== Instance Management Endpoints =====

// GET /admin/instances - List all active instances
admin.get('/instances', async (c) => {
  const metricsCollector = getMetricsCollector()

  if (!metricsCollector.isEnabled()) {
    return c.json({ error: 'Metrics collection is disabled' }, 503)
  }

  try {
    const now = new Date()
    const recentTime = new Date(now.getTime() - 60 * 1000)

    // Get historical stats grouped by instance
    const dataPoints = await metricsCollector.getHistoricalStats({
      startTime: recentTime,
      endTime: now
    })

    // Group by instanceId
    const instanceMap = new Map<string, { lastSeen: Date; backendIds: Set<string> }>()

    for (const point of dataPoints) {
      if (!instanceMap.has(point.instanceId)) {
        instanceMap.set(point.instanceId, {
          lastSeen: point.timestamp,
          backendIds: new Set()
        })
      }
      const inst = instanceMap.get(point.instanceId)!
      if (point.timestamp > inst.lastSeen) {
        inst.lastSeen = point.timestamp
      }
      inst.backendIds.add(point.backendId)
    }

    const instances = Array.from(instanceMap.entries()).map(([instanceId, data]) => ({
      instanceId,
      lastSeen: data.lastSeen,
      backendCount: data.backendIds.size,
      isActive: Date.now() - data.lastSeen.getTime() < 30 * 1000
    }))

    // Sort by lastSeen descending
    instances.sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime())

    return c.json({ instances })
  } catch (error) {
    console.error('Error fetching instances:', error)
    return c.json({ error: 'Failed to fetch instances' }, 500)
  }
})

// GET /admin/instances/:instanceId/stats - Get near-realtime stats for a specific instance
admin.get('/instances/:instanceId/stats', async (c) => {
  const metricsCollector = getMetricsCollector()

  if (!metricsCollector.isEnabled()) {
    return c.json({ error: 'Metrics collection is disabled' }, 503)
  }

  const instanceId = c.req.param('instanceId')

  try {
    const now = new Date()
    const recentTime = new Date(now.getTime() - 30 * 1000)

    // Get historical stats for this specific instance
    const dataPoints = await metricsCollector.getHistoricalStats({
      instanceId,
      startTime: recentTime,
      endTime: now
    })

    if (dataPoints.length === 0) {
      return c.json({ error: 'Instance not found or inactive' }, 404)
    }

    return c.json({
      instanceId,
      stats: dataPoints
    })
  } catch (error) {
    console.error('Error fetching instance stats:', error)
    return c.json({ error: 'Failed to fetch instance stats' }, 500)
  }
})

// ===== Recorded Requests Endpoints =====

// GET /admin/recorded-requests - Query recorded requests with filters
admin.get(
  '/recorded-requests',
  zValidator('query', recordedRequestsQuerySchema),
  async (c) => {
    if (!mongoDBService.isConnected()) {
      return c.json({ error: 'MongoDB not connected' }, 503)
    }

    const { backendId, model, startTime, endTime, limit, offset } = c.req.valid('query')

    try {
      const collection = mongoDBService.getRecordedRequestsCollection()

      // Build query filter
      const query: any = {}
      if (backendId) query.backendId = backendId
      if (model) query.model = model
      if (startTime || endTime) {
        query.timestamp = {}
        if (startTime) query.timestamp.$gte = new Date(startTime)
        if (endTime) query.timestamp.$lte = new Date(endTime)
      }

      // Execute query with pagination
      const [requests, total] = await Promise.all([
        collection
          .find(query)
          .sort({ timestamp: -1 })
          .skip(offset)
          .limit(limit)
          .toArray(),
        collection.countDocuments(query)
      ])

      return c.json({
        requests,
        total,
        limit,
        offset
      })
    } catch (error) {
      console.error('Error fetching recorded requests:', error)
      return c.json({ error: 'Failed to fetch recorded requests' }, 500)
    }
  }
)

// GET /admin/recorded-requests/:id - Get a specific recorded request
admin.get('/recorded-requests/:id', async (c) => {
  if (!mongoDBService.isConnected()) {
    return c.json({ error: 'MongoDB not connected' }, 503)
  }

  const id = c.req.param('id')

  try {
    const collection = mongoDBService.getRecordedRequestsCollection()
    const request = await collection.findOne({ _id: new ObjectId(id) })

    if (!request) {
      return c.json({ error: 'Recorded request not found' }, 404)
    }

    return c.json({ request })
  } catch (error) {
    console.error('Error fetching recorded request:', error)
    return c.json({ error: 'Failed to fetch recorded request' }, 500)
  }
})

// DELETE /admin/recorded-requests - Delete recorded requests (with filters)
admin.delete(
  '/recorded-requests',
  zValidator('query', recordedRequestsQuerySchema.omit({ limit: true, offset: true })),
  async (c) => {
    if (!mongoDBService.isConnected()) {
      return c.json({ error: 'MongoDB not connected' }, 503)
    }

    const { backendId, model, startTime, endTime } = c.req.valid('query')

    try {
      const collection = mongoDBService.getRecordedRequestsCollection()

      // Build query filter
      const query: any = {}
      if (backendId) query.backendId = backendId
      if (model) query.model = model
      if (startTime || endTime) {
        query.timestamp = {}
        if (startTime) query.timestamp.$gte = new Date(startTime)
        if (endTime) query.timestamp.$lte = new Date(endTime)
      }

      // Require at least one filter to prevent accidental full deletion
      if (Object.keys(query).length === 0) {
        return c.json({
          error: 'At least one filter (backendId, model, or time range) is required'
        }, 400)
      }

      const result = await collection.deleteMany(query)

      return c.json({
        message: 'Recorded requests deleted successfully',
        deletedCount: result.deletedCount
      })
    } catch (error) {
      console.error('Error deleting recorded requests:', error)
      return c.json({ error: 'Failed to delete recorded requests' }, 500)
    }
  }
)

// ===== API Key Management Endpoints =====

// GET /admin/apikeys - Get all API keys
admin.get('/apikeys', async (c) => {
  if (!mongoDBService.isConnected()) {
    return c.json({ error: 'MongoDB not connected' }, 503)
  }

  try {
    const collection = mongoDBService.getApiKeysCollection()
    const apiKeys = await collection.find({}).toArray()
    return c.json({ apiKeys })
  } catch (error) {
    console.error('Error fetching API keys:', error)
    return c.json({ error: 'Failed to fetch API keys' }, 500)
  }
})

// GET /admin/apikeys/:key - Get a specific API key
admin.get(
  '/apikeys/:key',
  zValidator('param', apiKeyParamSchema),
  async (c) => {
    if (!mongoDBService.isConnected()) {
      return c.json({ error: 'MongoDB not connected' }, 503)
    }

    const { key } = c.req.valid('param')

    try {
      const collection = mongoDBService.getApiKeysCollection()
      const apiKey = await collection.findOne({ key })

      if (!apiKey) {
        return c.json({ error: 'API key not found' }, 404)
      }

      return c.json({ apiKey })
    } catch (error) {
      console.error('Error fetching API key:', error)
      return c.json({ error: 'Failed to fetch API key' }, 500)
    }
  }
)

// POST /admin/apikeys - Create a new API key
admin.post(
  '/apikeys',
  zValidator('json', createApiKeySchema),
  async (c) => {
    if (!mongoDBService.isConnected()) {
      return c.json({ error: 'MongoDB not connected' }, 503)
    }

    const body = c.req.valid('json')

    try {
      const collection = mongoDBService.getApiKeysCollection()

      // Check if key already exists
      const existing = await collection.findOne({ key: body.key })
      if (existing) {
        return c.json({ error: 'API key already exists' }, 409)
      }

      const apiKey = {
        key: body.key,
        description: body.description,
        models: body.models,
        createdAt: new Date()
      }

      await collection.insertOne(apiKey)
      return c.json({ apiKey }, 201)
    } catch (error) {
      console.error('Error creating API key:', error)
      return c.json({ error: 'Failed to create API key' }, 500)
    }
  }
)

// PUT /admin/apikeys/:key - Update an API key
admin.put(
  '/apikeys/:key',
  zValidator('param', apiKeyParamSchema),
  zValidator('json', updateApiKeySchema),
  async (c) => {
    if (!mongoDBService.isConnected()) {
      return c.json({ error: 'MongoDB not connected' }, 503)
    }

    const { key } = c.req.valid('param')
    const updates = c.req.valid('json')

    try {
      const collection = mongoDBService.getApiKeysCollection()

      const result = await collection.findOneAndUpdate(
        { key },
        { $set: updates },
        { returnDocument: 'after' }
      )

      if (!result) {
        return c.json({ error: 'API key not found' }, 404)
      }

      return c.json({ apiKey: result })
    } catch (error) {
      console.error('Error updating API key:', error)
      return c.json({ error: 'Failed to update API key' }, 500)
    }
  }
)

// DELETE /admin/apikeys/:key - Delete an API key
admin.delete(
  '/apikeys/:key',
  zValidator('param', apiKeyParamSchema),
  async (c) => {
    if (!mongoDBService.isConnected()) {
      return c.json({ error: 'MongoDB not connected' }, 503)
    }

    const { key } = c.req.valid('param')

    try {
      const collection = mongoDBService.getApiKeysCollection()
      const result = await collection.deleteOne({ key })

      if (result.deletedCount === 0) {
        return c.json({ error: 'API key not found' }, 404)
      }

      return c.json({ message: 'API key deleted successfully' })
    } catch (error) {
      console.error('Error deleting API key:', error)
      return c.json({ error: 'Failed to delete API key' }, 500)
    }
  }
)

// ===== Affinity Management Endpoints =====

// GET /admin/affinity - Get all affinity mappings (paginated, filtered)
admin.get(
  '/affinity',
  zValidator('query', affinityMappingFilterSchema),
  async (c) => {
    if (!mongoDBService.isConnected()) {
      return c.json({ error: 'MongoDB not connected' }, 503)
    }

    const { model, backendId, limit, offset } = c.req.valid('query')

    const filter: any = {}
    if (model) filter.model = model
    if (backendId) filter.backendId = backendId

    const result = await affinityManager.getAllMappings(filter, limit, offset)

    return c.json({
      mappings: result.mappings,
      total: result.total,
      limit,
      offset
    })
  }
)

// GET /admin/affinity/:model/:sessionId - Get specific affinity mapping
admin.get('/affinity/:model/:sessionId', async (c) => {
  if (!mongoDBService.isConnected()) {
    return c.json({ error: 'MongoDB not connected' }, 503)
  }

  const model = c.req.param('model')
  const sessionId = c.req.param('sessionId')

  const backend = await affinityManager.getAffinityBackend(
    model,
    sessionId,
    configManager
  )

  if (!backend) {
    return c.json({
      error: 'No affinity mapping found or backend unavailable'
    }, 404)
  }

  return c.json({
    model,
    sessionId,
    backendId: backend.id
  })
})

// DELETE /admin/affinity - Clear affinity mappings (requires filter)
admin.delete(
  '/affinity',
  zValidator('query', clearAffinityMappingsSchema),
  async (c) => {
    if (!mongoDBService.isConnected()) {
      return c.json({ error: 'MongoDB not connected' }, 503)
    }

    const filter = c.req.valid('query')
    const deletedCount = await affinityManager.clearMappings(filter)

    return c.json({
      message: 'Affinity mappings cleared successfully',
      deletedCount
    })
  }
)

// DELETE /admin/affinity/:model/:sessionId - Clear specific mapping
admin.delete('/affinity/:model/:sessionId', async (c) => {
  if (!mongoDBService.isConnected()) {
    return c.json({ error: 'MongoDB not connected' }, 503)
  }

  const model = c.req.param('model')
  const sessionId = c.req.param('sessionId')

  const deletedCount = await affinityManager.clearMappings({ model, sessionId })

  if (deletedCount === 0) {
    return c.json({ error: 'Affinity mapping not found' }, 404)
  }

  return c.json({
    message: 'Affinity mapping cleared successfully'
  })
})

export default admin
