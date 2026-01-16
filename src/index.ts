import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import admin from './routes/admin.js'
import proxy from './routes/proxy.js'
import { mongoDBService } from './services/mongodb.js'
import { configManager } from './services/config-manager.js'
import { instanceManager } from './services/instance-manager.js'
import { loadBalancer } from './services/load-balancer.js'
import { createMetricsCollector, validateMetricsRequirement } from './services/metrics/index.js'
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
    metricsEnabled: metricsCollector?.isEnabled() ?? false
  })
})

// Mount routes
app.route('/admin', admin)
app.route('/v1', proxy)

// Serve static files from the frontend build (SPA fallback)
app.use('/*', serveStatic({ root: './pages/build/client' }))
app.use('/*', serveStatic({ path: './pages/build/client/index.html' }))

// Initialize MongoDB and start server
async function startServer() {
  const port = process.env.PORT ? parseInt(process.env.PORT) : 51818

  // Determine if metrics should be enabled
  const enableMetrics = process.env.ENABLE_METRICS !== 'false' // Default: true for backward compatibility

  // Try to connect to MongoDB if MONGODB_URL is provided
  if (process.env.MONGODB_URL) {
    console.log('Connecting to MongoDB...')
    await mongoDBService.connect()
    await configManager.initializeFromMongoDB()
    console.log('MongoDB integration enabled')

    // Initialize metrics collector
    metricsCollector = await createMetricsCollector({
      enabled: enableMetrics,
      db: mongoDBService.getDatabase(),
      instanceId: instanceManager.getInstanceId()
    })
  } else {
    console.log('MONGODB_URL not provided, using in-memory storage')

    // Without MongoDB, metrics cannot be enabled
    if (enableMetrics) {
      console.warn('Metrics require MongoDB. Metrics will be disabled.')
    }
    metricsCollector = await createMetricsCollector({
      enabled: false
    })
  }

  // Set metrics collector on load balancer
  loadBalancer.setMetricsCollector(metricsCollector)

  // Validate that all configured strategies are compatible with metrics settings
  if (metricsCollector.isEnabled() === false) {
    const models = configManager.getAllModels()
    for (const model of models) {
      try {
        validateMetricsRequirement(model.loadBalancingStrategy, false)
      } catch (error) {
        console.error(`Configuration error for model '${model.model}':`, (error as Error).message)
        process.exit(1)
      }
    }
  }

  // Start the HTTP server
  serve({
    fetch: app.fetch,
    port
  }, (info) => {
    console.log(`Instance ID: ${instanceManager.getInstanceId()}`)
    console.log(`OpenAI API Proxy is running on http://localhost:${info.port}`)
    console.log(`Admin API: http://localhost:${info.port}/api/admin`)
    console.log(`Proxy API: http://localhost:${info.port}/v1/chat/completions`)
  })

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down gracefully...')
    if (metricsCollector) {
      await metricsCollector.shutdown()
    }
    await mongoDBService.disconnect()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    console.log('\nShutting down gracefully...')
    if (metricsCollector) {
      await metricsCollector.shutdown()
    }
    await mongoDBService.disconnect()
    process.exit(0)
  })
}

// Export metrics collector for use in routes
export function getMetricsCollector(): MetricsCollector {
  return metricsCollector
}

startServer().catch((error) => {
  console.error('Failed to start server:', error)
  process.exit(1)
})
