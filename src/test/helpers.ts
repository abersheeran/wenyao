/**
 * Test helpers for creating test data
 */

import type { BackendConfig, ModelConfig } from '../types/backend.js'

/**
 * Create a test OpenAI backend configuration
 */
export function createTestOpenAIBackend(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    id: 'test-backend-1',
    provider: 'openai',
    weight: 1,
    enabled: true,
    openaiConfig: {
      url: 'https://api.openai.com',
      apiKey: 'test-api-key',
    },
    ...overrides,
  }
}

/**
 * Create a test Bedrock backend configuration
 */
export function createTestBedrockBackend(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return {
    id: 'test-backend-1',
    provider: 'bedrock',
    weight: 1,
    enabled: true,
    bedrockConfig: {
      region: 'us-east-1',
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
    },
    ...overrides,
  }
}
