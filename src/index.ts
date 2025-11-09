import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { logger } from 'hono/logger'
import admin from './routes/admin.js'
import proxy from './routes/proxy.js'
import { mongoDBService } from './services/mongodb.js'
import { configManager } from './services/config-manager.js'
import { statsTracker } from './services/stats-tracker.js'
import { instanceManager } from './services/instance-manager.js'
import { adminAuth, proxyAuth } from './middleware/auth.js'

const app = new Hono()

// Middleware
app.use('*', logger())

// Health check endpoint
app.get('/health', (c) => {
  return c.json({
    service: 'OpenAI API Proxy',
    status: 'running',
    version: '1.0.0',
    instanceId: instanceManager.getInstanceId()
  })
})

// Apply admin authentication middleware to all admin routes
app.use('/admin/*', adminAuth)

// Apply proxy authentication middleware to all v1 routes
app.use('/v1/*', proxyAuth)

// Mount routes
app.route('/admin', admin)
app.route('/v1', proxy)

// Serve static files from the frontend build (SPA fallback)
app.use('/*', serveStatic({ root: './pages/build/client' }))
app.use('/*', serveStatic({ path: './pages/build/client/index.html' }))

// Initialize MongoDB and start server
async function startServer() {
  const port = process.env.PORT ? parseInt(process.env.PORT) : 51818

  // Try to connect to MongoDB if MONGODB_URL is provided
  if (process.env.MONGODB_URL) {
    try {
      console.log('Connecting to MongoDB...')
      await mongoDBService.connect()
      await configManager.initializeFromMongoDB()
      console.log('MongoDB integration enabled')

      // Start historical stats tracking (saves snapshot every 15 seconds)
      statsTracker.startHistoryTracking()
    } catch (error) {
      console.error('Failed to connect to MongoDB, using in-memory storage:', error)
    }
  } else {
    console.log('MONGODB_URL not provided, using in-memory storage')
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
    statsTracker.stopHistoryTracking()
    await mongoDBService.disconnect()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    console.log('\nShutting down gracefully...')
    statsTracker.stopHistoryTracking()
    await mongoDBService.disconnect()
    process.exit(0)
  })
}

startServer().catch((error) => {
  console.error('Failed to start server:', error)
  process.exit(1)
})
