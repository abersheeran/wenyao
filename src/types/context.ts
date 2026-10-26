import type { ApiKey } from './apikey.js'
import type { ModelConfig } from './backend.js'

export type Bindings = Omit<Env, 'ADMIN_APIKEYS'> & { ADMIN_APIKEYS?: string }
export type Variables = { apiKey: ApiKey; models: ModelConfig[] }
export type HonoEnv = { Bindings: Bindings; Variables: Variables }
