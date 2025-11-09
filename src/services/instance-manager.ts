import { randomUUID } from 'crypto'

/**
 * Instance Manager
 *
 * Manages the unique instance identifier for this server process.
 * - Uses INSTANCE_ID environment variable if provided (useful for K8s/Docker)
 * - Otherwise generates a random UUID on startup
 */
export class InstanceManager {
  private instanceId: string

  constructor() {
    // Prefer environment variable for manual control (e.g., K8s Pod name)
    this.instanceId = process.env.INSTANCE_ID || randomUUID()
  }

  /**
   * Get the unique identifier for this instance
   */
  getInstanceId(): string {
    return this.instanceId
  }
}

// Singleton instance
export const instanceManager = new InstanceManager()
