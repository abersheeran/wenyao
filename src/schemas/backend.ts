import { z } from 'zod'

import type { ProviderType } from '../types/backend.js'

// Load balancing strategy enum
export const loadBalancingStrategySchema = z.enum(['weighted', 'lowest-ttft', 'min-error-rate'])

// Provider type enum
export const providerTypeSchema = z.enum(['openai', 'bedrock'])

// Provider config field mapping
const PROVIDER_CONFIG_FIELD: Record<ProviderType, 'openaiConfig' | 'bedrockConfig'> = {
  openai: 'openaiConfig',
  bedrock: 'bedrockConfig',
}

// OpenAI configuration schema
export const openaiConfigSchema = z.object({
  url: z
    .string()
    .min(1, 'URL is required')
    .refine(
      (val) => {
        try {
          new URL(val)
          return true
        } catch {
          return false
        }
      },
      { message: 'Invalid URL format' }
    ),
  apiKey: z.string().min(1, 'API key is required'),
})

// Bedrock configuration schema
export const bedrockConfigSchema = z.object({
  region: z.string().min(1, 'AWS region is required'),
  accessKeyId: z.string().min(1, 'AWS access key ID is required'),
  secretAccessKey: z.string().min(1, 'AWS secret access key is required'),
})

// Schema for individual backend within a model config
export const backendConfigSchema = z
  .object({
    id: z.string().min(1, 'Backend ID is required'),
    provider: providerTypeSchema,
    weight: z.number().nonnegative('Weight must be non-negative').default(1),
    enabled: z.boolean().default(true),
    model: z.string().min(1, 'Model name cannot be empty').optional(),
    streamingTTFTTimeout: z
      .number()
      .nonnegative('Streaming TTFT timeout must be non-negative')
      .optional(),
    nonStreamingTTFTTimeout: z
      .number()
      .nonnegative('Non-streaming TTFT timeout must be non-negative')
      .optional(),
    recordRequests: z.boolean().default(false).optional(),
    maxConcurrentRequests: z
      .number()
      .int()
      .nonnegative('Max concurrent requests must be non-negative')
      .optional(),
    openaiConfig: openaiConfigSchema.optional(),
    bedrockConfig: bedrockConfigSchema.optional(),
  })
  .refine(
    (data) => {
      // Ensure the correct config is present based on provider type
      const configField = PROVIDER_CONFIG_FIELD[data.provider]
      return !!data[configField]
    },
    {
      message: 'Provider-specific configuration is required based on provider type',
    }
  )

// Schema for creating a new model configuration
export const createModelConfigSchema = z
  .object({
    model: z.string().min(1, 'Model name is required'),
    provider: providerTypeSchema,
    backends: z.array(backendConfigSchema).default([]), // Allow empty backends array
    loadBalancingStrategy: loadBalancingStrategySchema.default('weighted'),
    enableAffinity: z.boolean().default(false).optional(),
  })
  .refine(
    (data) => {
      // Ensure all backends use the same provider as the model
      if (data.backends.length > 0) {
        const modelProvider = data.provider
        return data.backends.every((backend) => backend.provider === modelProvider)
      }
      return true
    },
    {
      message: 'All backends must use the same provider as the model',
    }
  )

// Schema for updating a model configuration - all fields are optional
export const updateModelConfigSchema = z
  .object({
    backends: z.array(backendConfigSchema).min(1, 'At least one backend is required').optional(),
    loadBalancingStrategy: loadBalancingStrategySchema.optional(),
    enableAffinity: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  })

// Schema for adding a backend to an existing model
export const addBackendToModelSchema = backendConfigSchema

// Schema for updating a specific backend within a model
export const updateBackendInModelSchema = z
  .object({
    provider: providerTypeSchema.optional(),
    weight: z.number().nonnegative('Weight must be non-negative').optional(),
    enabled: z.boolean().optional(),
    model: z.string().min(1, 'Model name cannot be empty').optional(),
    streamingTTFTTimeout: z
      .number()
      .nonnegative('Streaming TTFT timeout must be non-negative')
      .optional(),
    nonStreamingTTFTTimeout: z
      .number()
      .nonnegative('Non-streaming TTFT timeout must be non-negative')
      .optional(),
    recordRequests: z.boolean().optional(),
    maxConcurrentRequests: z
      .number()
      .int()
      .nonnegative('Max concurrent requests must be non-negative')
      .optional(),
    openaiConfig: openaiConfigSchema.optional(),
    bedrockConfig: bedrockConfigSchema.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update',
  })

// Schema for path parameters
export const modelParamSchema = z.object({
  model: z.string().min(1, 'Model name is required'),
})

export const backendIdParamSchema = z.object({
  backendId: z.string().min(1, 'Backend ID is required'),
})

export const modelAndBackendParamSchema = z.object({
  model: z.string().min(1, 'Model name is required'),
  backendId: z.string().min(1, 'Backend ID is required'),
})

// Affinity management schemas
export const affinityMappingFilterSchema = z.object({
  model: z.string().optional(),
  backendId: z.string().optional(),
  limit: z.coerce.number().min(1).max(1000).default(100).optional(),
  offset: z.coerce.number().min(0).default(0).optional(),
})

export const clearAffinityMappingsSchema = z
  .object({
    model: z.string().optional(),
    sessionId: z.string().optional(),
    backendId: z.string().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one filter field is required to prevent accidental full deletion',
  })

export type LoadBalancingStrategy = z.infer<typeof loadBalancingStrategySchema>
export type BackendConfig = z.infer<typeof backendConfigSchema>
export type CreateModelConfigInput = z.infer<typeof createModelConfigSchema>
export type UpdateModelConfigInput = z.infer<typeof updateModelConfigSchema>
export type AddBackendToModelInput = z.infer<typeof addBackendToModelSchema>
export type UpdateBackendInModelInput = z.infer<typeof updateBackendInModelSchema>
export type ModelParam = z.infer<typeof modelParamSchema>
export type BackendIdParam = z.infer<typeof backendIdParamSchema>
export type ModelAndBackendParam = z.infer<typeof modelAndBackendParamSchema>
export type AffinityMappingFilter = z.infer<typeof affinityMappingFilterSchema>
export type ClearAffinityMappings = z.infer<typeof clearAffinityMappingsSchema>
