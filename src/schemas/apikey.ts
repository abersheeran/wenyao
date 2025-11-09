import { z } from 'zod'

// Schema for creating a new API key
export const createApiKeySchema = z.object({
  key: z.string().min(1, 'API key is required'),
  description: z.string().min(1, 'Description is required'),
  models: z.array(z.string().min(1)).min(1, 'At least one model is required')
})

// Schema for updating an API key
export const updateApiKeySchema = z.object({
  description: z.string().min(1, 'Description cannot be empty').optional(),
  models: z.array(z.string().min(1)).min(1, 'At least one model is required').optional()
}).refine(
  (data) => Object.keys(data).length > 0,
  { message: 'At least one field must be provided for update' }
)

// Schema for path parameter (API key)
export const apiKeyParamSchema = z.object({
  key: z.string().min(1, 'API key is required')
})

// Export types
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>
export type UpdateApiKeyInput = z.infer<typeof updateApiKeySchema>
export type ApiKeyParam = z.infer<typeof apiKeyParamSchema>
