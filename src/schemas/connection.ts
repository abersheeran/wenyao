import { z } from 'zod'

import { bedrockConfigSchema, openaiConfigSchema } from './backend.js'

const connectionIdSchema = z
  .string()
  .min(1, 'Connection ID is required')
  .regex(/^[A-Za-z0-9._-]+$/, 'Connection ID may only contain letters, numbers, ., _, and -')

export const connectionParamSchema = z.object({ id: connectionIdSchema })

export const createConnectionSchema = z.discriminatedUnion('provider', [
  z
    .object({
      id: connectionIdSchema,
      name: z.string().trim().optional(),
      provider: z.literal('openai'),
      openaiConfig: openaiConfigSchema,
    })
    .strict(),
  z
    .object({
      id: connectionIdSchema,
      name: z.string().trim().optional(),
      provider: z.literal('bedrock'),
      bedrockConfig: bedrockConfigSchema,
    })
    .strict(),
])

export const updateConnectionSchema = z
  .object({
    name: z.string().trim().optional(),
    openaiConfig: openaiConfigSchema.optional(),
    bedrockConfig: bedrockConfigSchema.optional(),
  })
  .strict()
  .refine(
    (updates) =>
      updates.name !== undefined ||
      updates.openaiConfig !== undefined ||
      updates.bedrockConfig !== undefined,
    'At least one field is required'
  )
  .refine(
    (updates) => updates.openaiConfig === undefined || updates.bedrockConfig === undefined,
    'Only one provider configuration is allowed'
  )

export type CreateConnectionInput = z.infer<typeof createConnectionSchema>
export type UpdateConnectionInput = z.infer<typeof updateConnectionSchema>
