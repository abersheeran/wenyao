import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { createClient, type RedisClientType } from 'redis'

import admin from './routes/admin.js'
import proxy from './routes/proxy.js'
import { createActiveRequestStore } from './services/active-requests/index.js'
import { concurrencyLimiter } from './services/concurrency-limiter.js'
import { configManager } from './services/config-manager.js'
import { instanceManager } from './services/instance-manager.js'
import { loadBalancer } from './services/load-balancer.js'
import { createMetricsCollector, validateMetricsRequirement } from './services/metrics/index.js'
import { mongoDBService } from './services/mongodb.js'

import type { MetricsCollector } from './services/metrics/index.js'

// Global metrics collector instance
let metricsCollector: MetricsCollector

const app = new Hono()

// Middleware
app.use('*', logger())

// Health check endpoint
app.get('/health', (c) => {
  return c.json({
    service: 'OpenAI API Proxy',
    status: 'running',
    version: '1.0.0',
    instanceId: instanceManager.getInstanceId(),
    metricsEnabled: metricsCollector?.isEnabled() ?? false,
  })
})

// Mount routes
app.route('/admin', admin)
app.route('/v1', proxy)

// Serve static files from the frontend build (SPA fallback)
app.use('/*', serveStatic({ root: './pages/build/client' }))
app.use('/*', serveStatic({ path: './pages/build/client/index.html' }))

// Initialize and start the server
async function startServer() {
  const port = process.env.PORT ? parseInt(process.env.PORT) : 51818

  // 1. Determine Configuration and Store types
  const enableMetrics = process.env.ENABLE_METRICS !== 'false'
  let resolvedStoreType: 'mongodb' | 'redis' =
    (process.env.ACTIVE_REQUEST_STORE_TYPE as 'mongodb' | 'redis') || 'mongodb'

  if (!['mongodb', 'redis'].includes(resolvedStoreType)) {
    console.error(
      `Invalid ACTIVE_REQUEST_STORE_TYPE: ${resolvedStoreType}. Must be 'mongodb' or 'redis'`
    )
    process.exit(1)
  }

  // 2. Initialize Data Services (MongoDB, Redis, Concurrency Limiter)
  await initializeDataServices(resolvedStoreType)

  // 3. Initialize Metrics System
  metricsCollector = await createMetricsCollector({
    enabled: enableMetrics && !!mongoDBService.isConnected(),
    db: mongoDBService.isConnected() ? mongoDBService.getDatabase() : undefined,
    instanceId: instanceManager.getInstanceId(),
  })

  if (enableMetrics && !mongoDBService.isConnected()) {
    console.warn('⚠️  Metrics require MongoDB. Metrics will be disabled.')
  }

  // 4. Configure Load Balancer
  loadBalancer.setMetricsCollector(metricsCollector)

  // 5. Validate Metrics Compatibility
  validateMetricsCompatibility()

  // 6. Start the HTTP server
  const server = serve(
    {
      fetch: app.fetch,
      port,
    },
    (info) => {
      console.log(`\n🚀 文鳐 is running!`)
      console.log(`- Instance ID: ${instanceManager.getInstanceId()}`)
      console.log(`- Port: ${info.port}`)
      console.log(`- Metrics: ${metricsCollector.isEnabled() ? 'Enabled' : 'Disabled'}`)
      console.log(`- Active Store: ${resolvedStoreType}\n`)
    }
  )

  // 7. Handle Graceful Shutdown
  setupGracefulShutdown()
}

/**
 * Initialize data layers including MongoDB and Redis
 */
async function initializeDataServices(storeType: 'mongodb' | 'redis') {
  if (process.env.MONGODB_URL) {
    console.log('Connecting to MongoDB...')
    await mongoDBService.connect()
    await configManager.initializeFromMongoDB()

    let redisClient: RedisClientType | undefined
    if (storeType === 'redis') {
      const redisUrl = process.env.REDIS_URL
      if (!redisUrl) {
        console.warn(
          '⚠️  REDIS_URL not provided, falling back to MongoDB for active request tracking'
        )
        storeType = 'mongodb'
      } else {
        console.log('Connecting to Redis...')
        try {
          const client = createClient({ url: redisUrl })
          await client.connect()
          await client.ping()
          redisClient = client as unknown as RedisClientType
          console.log('✓ Redis connection established')
        } catch (err) {
          console.error('Failed to connect to Redis:', err)
          console.warn('Falling back to MongoDB for active request tracking')
          storeType = 'mongodb'
        }
      }
    }

    // Initialize ConcurrencyLimiter with an ActiveRequestStore
    const activeRequestStore = createActiveRequestStore({
      type: storeType,
      instanceId: instanceManager.getInstanceId(),
      db: mongoDBService.getDatabase(),
      redis: redisClient,
    })
    await activeRequestStore.initialize()
    concurrencyLimiter.initialize(activeRequestStore)
  } else {
    console.log('MONGODB_URL not provided, using in-memory storage')
    // Fallback for standalone mode
    const activeRequestStore = createActiveRequestStore({
      type: 'mongodb', // Will fallback to in-memory if no DB
      instanceId: instanceManager.getInstanceId(),
    })
    await activeRequestStore.initialize()
    concurrencyLimiter.initialize(activeRequestStore)
  }
}

/**
 * Validates that the current model strategies are compatible with the metrics setting
 */
function validateMetricsCompatibility() {
  if (!metricsCollector.isEnabled()) {
    const models = configManager.getAllModels()
    for (const model of models) {
      try {
        validateMetricsRequirement(model.loadBalancingStrategy, false)
      } catch (error) {
        console.error(
          `❌ Configuration error for model '${model.model}':`,
          (error as Error).message
        )
        process.exit(1)
      }
    }
  }
}

/**
 * Setup process listeners for graceful shutdown
 */
function setupGracefulShutdown() {
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}. Shutting down gracefully...`)
    if (metricsCollector) {
      await metricsCollector.shutdown()
    }
    await mongoDBService.disconnect()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

// Export metrics collector for use in routes
export function getMetricsCollector(): MetricsCollector {
  return metricsCollector
}

startServer().catch((error) => {
  console.error('Failed to start server:', error)
  process.exit(1)
})
