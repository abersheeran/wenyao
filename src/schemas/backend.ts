import { z } from 'zod'

// Load balancing strategy enum
export const loadBalancingStrategySchema = z.enum(['weighted', 'lowest-ttft', 'min-error-rate'])

// Schema for individual backend within a model config
export const backendConfigSchema = z.object({
  id: z.string().min(1, 'Backend ID is required'),
  url: z.url('Invalid URL format'),
  apiKey: z.string().min(1, 'API key is required'),
  weight: z.number().nonnegative('Weight must be non-negative').default(1),
  enabled: z.boolean().default(true),
  model: z.string().min(1, 'Model name cannot be empty').optional(),
  streamingTTFTTimeout: z.number().nonnegative('Streaming TTFT timeout must be non-negative').optional(),
  nonStreamingTTFTTimeout: z.number().nonnegative('Non-streaming TTFT timeout must be non-negative').optional(),
  recordRequests: z.boolean().default(false).optional(),
  maxConcurrentRequests: z.number().int().nonnegative('Max concurrent requests must be non-negative').optional()
})

// Schema for creating a new model configuration
export const createModelConfigSchema = z.object({
  model: z.string().min(1, 'Model name is required'),
  backends: z.array(backendConfigSchema).default([]), // Allow empty backends array
  loadBalancingStrategy: loadBalancingStrategySchema.default('weighted'),
  enableAffinity: z.boolean().default(false).optional()
})

// Schema for updating a model configuration - all fields are optional
export const updateModelConfigSchema = z.object({
  backends: z.array(backendConfigSchema).min(1, 'At least one backend is required').optional(),
  loadBalancingStrategy: loadBalancingStrategySchema.optional(),
  enableAffinity: z.boolean().optional()
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: 'At least one field must be provided for update' }
)

// Schema for adding a backend to an existing model
export const addBackendToModelSchema = backendConfigSchema

// Schema for updating a specific backend within a model
export const updateBackendInModelSchema = z.object({
  url: z.url('Invalid URL format').optional(),
  apiKey: z.string().min(1, 'API key cannot be empty').optional(),
  weight: z.number().nonnegative('Weight must be non-negative').optional(),
  enabled: z.boolean().optional(),
  model: z.string().min(1, 'Model name cannot be empty').optional(),
  streamingTTFTTimeout: z.number().nonnegative('Streaming TTFT timeout must be non-negative').optional(),
  nonStreamingTTFTTimeout: z.number().nonnegative('Non-streaming TTFT timeout must be non-negative').optional(),
  recordRequests: z.boolean().optional(),
  maxConcurrentRequests: z.number().int().nonnegative('Max concurrent requests must be non-negative').optional()
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: 'At least one field must be provided for update' }
)

// Schema for path parameters
export const modelParamSchema = z.object({
  model: z.string().min(1, 'Model name is required')
})

export const backendIdParamSchema = z.object({
  backendId: z.string().min(1, 'Backend ID is required')
})

export const modelAndBackendParamSchema = z.object({
  model: z.string().min(1, 'Model name is required'),
  backendId: z.string().min(1, 'Backend ID is required')
})

// Affinity management schemas
export const affinityMappingFilterSchema = z.object({
  model: z.string().optional(),
  backendId: z.string().optional(),
  limit: z.coerce.number().min(1).max(1000).default(100).optional(),
  offset: z.coerce.number().min(0).default(0).optional()
})

export const clearAffinityMappingsSchema = z.object({
  model: z.string().optional(),
  sessionId: z.string().optional(),
  backendId: z.string().optional()
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: 'At least one filter field is required to prevent accidental full deletion' }
)

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
