import type { ApiKey } from './apikey.js'

/**
 * Custom context variables for Hono
 * This extends the Hono context type to include custom variables
 * that are set via c.set() in middleware
 */
export type Variables = {
  apiKey: ApiKey
}
