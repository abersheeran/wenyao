import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { configManager } from '../services/config-manager.js'
import { statsTracker } from '../services/stats-tracker.js'
import { mongoDBService } from '../services/mongodb.js'
import {
  createModelConfigSchema,
  updateModelConfigSchema,
  addBackendToModelSchema,
  updateBackendInModelSchema,
  modelParamSchema,
  modelAndBackendParamSchema
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
  if (!mongoDBService.isConnected()) {
    return c.json({ error: 'MongoDB not connected, stats unavailable' }, 503)
  }

  try {
    const collection = mongoDBService.getStatsHistoryCollection()
    // Query snapshots from the last 30 seconds
    const recentTime = new Date(Date.now() - 30 * 1000)

    const pipeline = [
      // 1. Only take data from the last 30 seconds
      { $match: { timestamp: { $gte: recentTime } } },

      // 2. Sort by timestamp descending to get latest first
      { $sort: { timestamp: -1 } },

      // 3. Group by (instanceId, backendId) and take the most recent snapshot
      {
        $group: {
          _id: { instanceId: '$instanceId', backendId: '$backendId' },
          latestSnapshot: { $first: '$$ROOT' }
        }
      },

      // 4. Aggregate across all instances for each backend
      {
        $group: {
          _id: '$latestSnapshot.backendId',
          totalRequests: { $sum: '$latestSnapshot.totalRequests' },
          successfulRequests: { $sum: '$latestSnapshot.successfulRequests' },
          failedRequests: { $sum: '$latestSnapshot.failedRequests' },
          averageStreamingTTFT: { $avg: '$latestSnapshot.averageStreamingTTFT' },
          averageNonStreamingTTFT: { $avg: '$latestSnapshot.averageNonStreamingTTFT' },
          instanceCount: { $sum: 1 }
        }
      },

      // 5. Calculate success rate and format output
      {
        $project: {
          _id: 0,
          backendId: '$_id',
          totalRequests: 1,
          successfulRequests: 1,
          failedRequests: 1,
          successRate: {
            $cond: [
              { $eq: ['$totalRequests', 0] },
              1.0,
              { $divide: ['$successfulRequests', '$totalRequests'] }
            ]
          },
          averageStreamingTTFT: { $ifNull: ['$averageStreamingTTFT', 0] },
          averageNonStreamingTTFT: { $ifNull: ['$averageNonStreamingTTFT', 0] },
          instanceCount: 1
        }
      }
    ]

    const stats = await collection.aggregate(pipeline).toArray()
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
  if (!mongoDBService.isConnected()) {
    return c.json({ error: 'MongoDB not connected, history unavailable' }, 503)
  }

  const startTimeParam = c.req.query('startTime')
  const endTimeParam = c.req.query('endTime')
  const instanceId = c.req.query('instanceId') // Optional: filter by specific instance
  const aggregateByInstance = c.req.query('aggregate') === 'false' // Default: aggregate across instances

  try {
    const collection = mongoDBService.getStatsHistoryCollection()
    const query: any = {}

    if (startTimeParam) {
      query.timestamp = { ...query.timestamp, $gte: new Date(startTimeParam) }
    }
    if (endTimeParam) {
      query.timestamp = { ...query.timestamp, $lte: new Date(endTimeParam) }
    }
    if (instanceId) {
      query.instanceId = instanceId
    }

    if (aggregateByInstance) {
      // Return data separated by instance
      const dataPoints = await collection
        .find(query)
        .sort({ timestamp: 1, instanceId: 1 })
        .toArray()

      // Group by instanceId and backendId
      const grouped: Record<string, Record<string, any[]>> = {}
      for (const point of dataPoints) {
        if (!grouped[point.instanceId]) grouped[point.instanceId] = {}
        if (!grouped[point.instanceId][point.backendId]) grouped[point.instanceId][point.backendId] = []
        grouped[point.instanceId][point.backendId].push(point)
      }

      return c.json({ history: grouped })
    } else {
      // Aggregate across all instances (group by time window)
      const pipeline = [
        { $match: query },
        {
          $group: {
            _id: {
              backendId: '$backendId',
              // Align timestamps to the minute
              timestamp: {
                $dateFromParts: {
                  year: { $year: '$timestamp' },
                  month: { $month: '$timestamp' },
                  day: { $dayOfMonth: '$timestamp' },
                  hour: { $hour: '$timestamp' },
                  minute: { $minute: '$timestamp' }
                }
              }
            },
            totalRequests: { $sum: '$totalRequests' },
            successfulRequests: { $sum: '$successfulRequests' },
            failedRequests: { $sum: '$failedRequests' },
            averageStreamingTTFT: { $avg: '$averageStreamingTTFT' },
            averageNonStreamingTTFT: { $avg: '$averageNonStreamingTTFT' }
          }
        },
        {
          $project: {
            _id: 0,
            backendId: '$_id.backendId',
            timestamp: '$_id.timestamp',
            totalRequests: 1,
            successfulRequests: 1,
            failedRequests: 1,
            successRate: {
              $cond: [
                { $eq: ['$totalRequests', 0] },
                1,
                { $divide: ['$successfulRequests', '$totalRequests'] }
              ]
            },
            averageStreamingTTFT: { $ifNull: ['$averageStreamingTTFT', 0] },
            averageNonStreamingTTFT: { $ifNull: ['$averageNonStreamingTTFT', 0] }
          }
        },
        { $sort: { timestamp: 1 } }
      ]

      const dataPoints = await collection.aggregate(pipeline).toArray()

      if (dataPoints.length === 0) {
        return c.json({ history: {} })
      }

      // Group by backendId
      const grouped: Record<string, any[]> = {}
      for (const point of dataPoints) {
        if (!grouped[point.backendId]) grouped[point.backendId] = []
        grouped[point.backendId].push(point)
      }

      // Fill missing time points with zero values
      const startTime = startTimeParam ? new Date(startTimeParam) : new Date(Math.min(...dataPoints.map((p: any) => new Date(p.timestamp).getTime())))
      const endTime = endTimeParam ? new Date(endTimeParam) : new Date(Math.max(...dataPoints.map((p: any) => new Date(p.timestamp).getTime())))

      // Generate all minute-aligned timestamps in the range
      const allTimestamps: Date[] = []
      const current = new Date(startTime)
      current.setSeconds(0, 0) // Align to minute
      while (current <= endTime) {
        allTimestamps.push(new Date(current))
        current.setMinutes(current.getMinutes() + 1)
      }

      // Fill gaps for each backend
      const backendIds = Object.keys(grouped)
      for (const backendId of backendIds) {
        const existingPoints = grouped[backendId]
        const existingTimestamps = new Set(existingPoints.map((p: any) => new Date(p.timestamp).getTime()))

        const filledPoints: any[] = []
        for (const timestamp of allTimestamps) {
          const timestampMs = timestamp.getTime()
          if (existingTimestamps.has(timestampMs)) {
            // Use existing data point
            const existing = existingPoints.find((p: any) => new Date(p.timestamp).getTime() === timestampMs)
            filledPoints.push(existing)
          } else {
            // Fill with zero values
            filledPoints.push({
              backendId,
              timestamp,
              totalRequests: 0,
              successfulRequests: 0,
              failedRequests: 0,
              successRate: 1,
              averageStreamingTTFT: 0,
              averageNonStreamingTTFT: 0
            })
          }
        }
        grouped[backendId] = filledPoints
      }

      return c.json({ history: grouped })
    }
  } catch (error) {
    console.error('Error fetching historical stats:', error)
    return c.json({ error: 'Failed to fetch historical stats' }, 500)
  }
})

// GET /admin/stats/history/:backendId - Get historical stats for a specific backend
admin.get('/stats/history/:backendId', async (c) => {
  const backendId = c.req.param('backendId')
  const startTimeParam = c.req.query('startTime')
  const endTimeParam = c.req.query('endTime')

  const startTime = startTimeParam ? new Date(startTimeParam) : undefined
  const endTime = endTimeParam ? new Date(endTimeParam) : undefined

  const dataPoints = await statsTracker.getHistoricalStats(backendId, startTime, endTime)

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
})

// GET /admin/stats/:backendId - Get statistics for a specific backend
admin.get('/stats/:backendId', async (c) => {
  const backendId = c.req.param('backendId')
  const stats = await statsTracker.getStats(backendId)

  if (!stats) {
    return c.json({ error: `No statistics found for backend ${backendId}` }, 404)
  }

  return c.json({ stats })
})

// DELETE /admin/stats/:backendId - Reset statistics for a specific backend
admin.delete('/stats/:backendId', (c) => {
  const backendId = c.req.param('backendId')
  statsTracker.resetStats(backendId)
  return c.json({ message: 'Statistics reset successfully' })
})

// DELETE /admin/stats - Reset all statistics
admin.delete('/stats', (c) => {
  statsTracker.resetAllStats()
  return c.json({ message: 'All statistics reset successfully' })
})

// GET /admin/metrics - Get Prometheus metrics
admin.get('/metrics', async (c) => {
  const metrics = await statsTracker.getMetrics()
  return c.text(metrics, 200, {
    'Content-Type': 'text/plain; version=0.0.4'
  })
})

// ===== Instance Management Endpoints =====

// GET /admin/instances - List all active instances
admin.get('/instances', async (c) => {
  if (!mongoDBService.isConnected()) {
    return c.json({ error: 'MongoDB not connected' }, 503)
  }

  try {
    const collection = mongoDBService.getStatsHistoryCollection()
    // Consider instances active if they have snapshots in the last 60 seconds
    const recentTime = new Date(Date.now() - 60 * 1000)

    const pipeline = [
      { $match: { timestamp: { $gte: recentTime } } },
      {
        $group: {
          _id: '$instanceId',
          lastSeen: { $max: '$timestamp' },
          backendIds: { $addToSet: '$backendId' }
        }
      },
      { $sort: { lastSeen: -1 } }
    ]

    const instances = await collection.aggregate(pipeline).toArray()

    return c.json({
      instances: instances.map((inst) => ({
        instanceId: inst._id,
        lastSeen: inst.lastSeen,
        backendCount: inst.backendIds.length,
        isActive: Date.now() - inst.lastSeen.getTime() < 30 * 1000 // Active if updated within 30s
      }))
    })
  } catch (error) {
    console.error('Error fetching instances:', error)
    return c.json({ error: 'Failed to fetch instances' }, 500)
  }
})

// GET /admin/instances/:instanceId/stats - Get near-realtime stats for a specific instance
admin.get('/instances/:instanceId/stats', async (c) => {
  if (!mongoDBService.isConnected()) {
    return c.json({ error: 'MongoDB not connected' }, 503)
  }

  const instanceId = c.req.param('instanceId')

  try {
    const collection = mongoDBService.getStatsHistoryCollection()
    // Get the latest snapshot from this instance (last 30 seconds)
    const recentTime = new Date(Date.now() - 30 * 1000)

    const pipeline = [
      { $match: { instanceId, timestamp: { $gte: recentTime } } },
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: '$backendId',
          latestSnapshot: { $first: '$$ROOT' }
        }
      }
    ]

    const stats = await collection.aggregate(pipeline).toArray()

    if (stats.length === 0) {
      return c.json({ error: 'Instance not found or inactive' }, 404)
    }

    return c.json({
      instanceId,
      stats: stats.map((s) => s.latestSnapshot)
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

export default admin
