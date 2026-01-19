/**
 * Provider factory for creating provider instances
 * Maps provider types to their implementations
 */

import { BedrockProvider } from './bedrock-provider.js'
import { OpenAIProvider } from './openai-provider.js'

import type { BaseProvider } from './base-provider.js'

export type ProviderType = 'openai' | 'bedrock'

type ProviderClassType = typeof BedrockProvider | typeof OpenAIProvider

/**
 * Provider factory singleton
 */
class ProviderFactory {
  private providers: Map<ProviderType, ProviderClassType> = new Map()

  constructor() {
    // Register built-in providers
    this.registerProvider('openai', OpenAIProvider)
    this.registerProvider('bedrock', BedrockProvider)
  }

  /**
   * Register a new provider
   */
  registerProvider(type: ProviderType, provider: ProviderClassType): void {
    this.providers.set(type, provider)
  }

  /**
   * Get a provider by type
   * @throws Error if provider not found
   */
  getProvider(type: ProviderType): BaseProvider {
    const provider = this.providers.get(type)
    if (!provider) {
      throw new Error(`Provider not found: ${type}`)
    }
    return new provider()
  }

  /**
   * Check if a provider exists
   */
  hasProvider(type: ProviderType): boolean {
    return this.providers.has(type)
  }

  /**
   * Get all registered provider types
   */
  getProviderTypes(): ProviderType[] {
    return Array.from(this.providers.keys())
  }
}

// Export singleton instance
export const providerFactory = new ProviderFactory()
