import { z } from 'zod'

export const recordedRequestsQuerySchema = z.object({
  backendId: z.string().optional(),
  model: z.string().optional(),
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(1000).default(100),
  offset: z.coerce.number().int().nonnegative().default(0),
})

export type RecordedRequestsQuery = z.infer<typeof recordedRequestsQuerySchema>
