export type LoadBalancingStrategy = 'weighted' | 'lowest-ttft' | 'min-error-rate';

export type ProviderType = 'openai' | 'bedrock' | 'jev';

export type OpenAIConfig = {
  url: string;
  apiKey: string;
};

export type JevConfig = OpenAIConfig;

export type BedrockConfig = {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export type Connection = { id: string; name: string } & (
  | { provider: 'openai'; openaiConfig: OpenAIConfig }
  | { provider: 'bedrock'; bedrockConfig: BedrockConfig }
  | { provider: 'jev'; jevConfig: JevConfig }
);

export type ConnectionConfig = { openaiConfig: OpenAIConfig } | { bedrockConfig: BedrockConfig } | { jevConfig: JevConfig };

export type BackendConfig = {
  id: string;
  provider: ProviderType;
  weight: number;
  enabled: boolean;
  model?: string; // Optional: Override the model name when forwarding to this backend
  streamingTTFTTimeout?: number; // Optional: TTFT timeout in milliseconds for streaming requests
  nonStreamingTTFTTimeout?: number; // Optional: TTFT timeout in milliseconds for non-streaming requests
  recordRequests?: boolean; // Optional: Record all requests (URL, headers, body) to D1 and R2
  recordResponses?: boolean; // Optional: Record responses when request recording is enabled
  maxConcurrentRequests?: number; // Optional: Maximum concurrent requests (undefined/0 = no limit, >0 = specific limit)
  connectionId: string;
};

export type MinErrorRateOptions = {
  minRequests?: number;
  circuitBreakerThreshold?: number;
  epsilon?: number;
  timeWindowMinutes?: number;
};

export type ModelConfig = {
  model: string;
  provider: ProviderType;
  backends: BackendConfig[];
  loadBalancingStrategy: LoadBalancingStrategy;
  minErrorRateOptions?: MinErrorRateOptions;
  enableAffinity?: boolean;
};

export type BackendStats = {
  model: string;
  backendId: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  successRate: number;
  averageStreamingTTFT: number;
  averageNonStreamingTTFT: number;
  ttftSamples: number[];
};

export type StatsDataPoint = {
  model: string;
  backendId: string;
  timestamp: string | Date;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  successRate: number;
  averageStreamingTTFT: number;
  averageNonStreamingTTFT: number;
  requestsInPeriod: number;
};

export type HistoricalStatsData = Record<string, Record<string, StatsDataPoint[]>>;

export type HistoricalStatsResponse = {
  model: string;
  backendId: string;
  dataPoints: StatsDataPoint[];
  startTime?: string | Date;
  endTime?: string | Date;
  message?: string;
};

export type ApiKey = {
  key: string;
  description: string;
  models: string[];
  createdAt: string | Date;
  lastUsedAt?: string | Date;
};

export type RecordedRequest = {
  _id?: string;
  backendId: string;
  model: string;
  timestamp: string | Date;
  url: string;
  headers: Record<string, string>;
  body: string;
  response: {
    status: number | null;
    headers: Record<string, string> | null;
    body: string;
    bodyEncoding: 'utf8' | 'base64';
    error: string | null;
    truncated: boolean;
    completedAt: string;
  } | null;
};

export type AffinityMapping = {
  model: string;
  sessionId: string;
  backendId: string;
  createdAt: string | Date;
  lastAccessedAt: string | Date;
  accessCount: number;
};

/**
 * 从 localStorage 获取管理 API 密钥
 */
function getAdminApiKey(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('adminApiKey');
}

/**
 * 创建带有鉴权头的 fetch 选项
 */
function createAuthHeaders(additionalHeaders?: HeadersInit): HeadersInit {
  const headers: HeadersInit = { ...(additionalHeaders || {}) };
  const apiKey = getAdminApiKey();

  if (apiKey) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${apiKey}`;
  }

  return headers;
}

export function useAdminApi() {
  const apiBase = (import.meta as any).env?.VITE_API_BASE ?? "";
  const base = apiBase ? `${String(apiBase).replace(/\/$/, "")}/admin` : "/admin";
  return {
    // Shared connection operations
    async listConnections(): Promise<Connection[]> {
      const res = await fetch(`${base}/connections`, {
        headers: createAuthHeaders()
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to load connections");
      }
      const data = await res.json();
      return data.connections ?? [];
    },
    async getConnection(id: string): Promise<Connection> {
      const res = await fetch(`${base}/connections/${encodeURIComponent(id)}`, {
        headers: createAuthHeaders()
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to load connection");
      }
      const data = await res.json();
      return data.connection;
    },
    async createConnection(payload: { id: string; name?: string } & (
      | { provider: 'openai'; openaiConfig: OpenAIConfig }
      | { provider: 'bedrock'; bedrockConfig: BedrockConfig }
      | { provider: 'jev'; jevConfig: JevConfig }
    )): Promise<Connection> {
      const res = await fetch(`${base}/connections`, {
        method: "POST",
        headers: createAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to create connection");
      }
      const data = await res.json();
      return data.connection;
    },
    async updateConnection(id: string, updates: { name: string } | ({ name?: string } & ConnectionConfig)): Promise<Connection> {
      const res = await fetch(`${base}/connections/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: createAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(updates),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to update connection");
      }
      const data = await res.json();
      return data.connection;
    },
    async deleteConnection(id: string): Promise<void> {
      const res = await fetch(`${base}/connections/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: createAuthHeaders()
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to delete connection");
      }
    },

    // Model-level operations
    async listModels(): Promise<(ModelConfig & { backends: (BackendConfig & { trafficRatio: number })[] })[]> {
      const res = await fetch(`${base}/models`, {
        headers: createAuthHeaders()
      });
      if (!res.ok) throw new Error("Failed to load models");
      const data = await res.json();
      return data.models ?? [];
    },
    async getModel(model: string): Promise<ModelConfig & { backends: (BackendConfig & { trafficRatio: number })[] }> {
      const res = await fetch(`${base}/models/${encodeURIComponent(model)}`, {
        headers: createAuthHeaders()
      });
      if (!res.ok) throw new Error("Failed to load model");
      const data = await res.json();
      return data.model;
    },
    async addModel(payload: Omit<ModelConfig, 'backends'> & { backends?: BackendConfig[] }): Promise<ModelConfig> {
      const res = await fetch(`${base}/models`, {
        method: "POST",
        headers: createAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ ...payload, backends: payload.backends ?? [] }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to add model");
      }
      const data = await res.json();
      return data.model;
    },
    async updateModel(model: string, updates: { loadBalancingStrategy?: LoadBalancingStrategy; backends?: BackendConfig[]; minErrorRateOptions?: MinErrorRateOptions; enableAffinity?: boolean }): Promise<ModelConfig> {
      const res = await fetch(`${base}/models/${encodeURIComponent(model)}`, {
        method: "PUT",
        headers: createAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(updates),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to update model");
      }
      const data = await res.json();
      return data.model;
    },
    async deleteModel(model: string): Promise<void> {
      const res = await fetch(`${base}/models/${encodeURIComponent(model)}`, {
        method: "DELETE",
        headers: createAuthHeaders()
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to delete model");
      }
    },

    // Backend operations within models
    async reorderBackends(model: string, backendIds: string[]): Promise<ModelConfig> {
      const res = await fetch(`${base}/models/${encodeURIComponent(model)}/backend-order`, {
        method: "PUT",
        headers: createAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ backendIds }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to reorder backends");
      }
      const data = await res.json();
      return data.model;
    },
    async listBackends(model: string): Promise<(BackendConfig & { trafficRatio: number })[]> {
      const res = await fetch(`${base}/models/${encodeURIComponent(model)}/backends`, {
        headers: createAuthHeaders()
      });
      if (!res.ok) throw new Error("Failed to load backends");
      const data = await res.json();
      return data.backends ?? [];
    },
    async addBackend(model: string, payload: BackendConfig): Promise<ModelConfig> {
      const res = await fetch(`${base}/models/${encodeURIComponent(model)}/backends`, {
        method: "POST",
        headers: createAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to add backend");
      }
      const data = await res.json();
      return data.model;
    },
    async updateBackend(model: string, backendId: string, updates: Partial<Omit<BackendConfig, "id">>): Promise<ModelConfig> {
      const res = await fetch(`${base}/models/${encodeURIComponent(model)}/backends/${encodeURIComponent(backendId)}`, {
        method: "PUT",
        headers: createAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(updates),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to update backend");
      }
      const data = await res.json();
      return data.model;
    },
    async deleteBackend(model: string, backendId: string): Promise<void> {
      const res = await fetch(`${base}/models/${encodeURIComponent(model)}/backends/${encodeURIComponent(backendId)}`, {
        method: "DELETE",
        headers: createAuthHeaders()
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to delete backend");
      }
    },

    // Prometheus Metrics
    async getPrometheusMetrics(): Promise<string> {
      const res = await fetch(`${base}/metrics`, {
        headers: createAuthHeaders()
      });
      if (!res.ok) throw new Error("Failed to load Prometheus metrics");
      return await res.text();
    },

    // Historical stats operations (near-realtime aggregated from D1)
    async getHistoricalStats(model: string, backendId: string, startTime?: Date, endTime?: Date, intervalMinutes?: number): Promise<HistoricalStatsResponse> {
      const params = new URLSearchParams();
      if (startTime) params.append('startTime', startTime.toISOString());
      if (endTime) params.append('endTime', endTime.toISOString());
      if (intervalMinutes !== undefined) params.append('intervalMinutes', String(intervalMinutes));

      const queryString = params.toString();
      const url = `${base}/stats/history/${encodeURIComponent(model)}/${encodeURIComponent(backendId)}${queryString ? `?${queryString}` : ''}`;

      const res = await fetch(url, {
        headers: createAuthHeaders()
      });
      if (!res.ok) throw new Error("Failed to load historical stats");
      return await res.json();
    },
    async getAllHistoricalStats(startTime?: Date, endTime?: Date, intervalMinutes?: number): Promise<HistoricalStatsData> {
      const params = new URLSearchParams();
      if (startTime) params.append('startTime', startTime.toISOString());
      if (endTime) params.append('endTime', endTime.toISOString());
      if (intervalMinutes !== undefined) params.append('intervalMinutes', String(intervalMinutes));

      const queryString = params.toString();
      const url = `${base}/stats/history${queryString ? `?${queryString}` : ''}`;

      const res = await fetch(url, {
        headers: createAuthHeaders()
      });
      if (!res.ok) throw new Error("Failed to load all historical stats");
      const data = await res.json();
      return data.history ?? {};
    },

    // API Key operations
    async listApiKeys(): Promise<ApiKey[]> {
      const res = await fetch(`${base}/apikeys`, {
        headers: createAuthHeaders()
      });
      if (!res.ok) throw new Error("Failed to load API keys");
      const data = await res.json();
      return data.apiKeys ?? [];
    },
    async getApiKey(key: string): Promise<ApiKey> {
      const res = await fetch(`${base}/apikeys/${encodeURIComponent(key)}`, {
        headers: createAuthHeaders()
      });
      if (!res.ok) throw new Error("Failed to load API key");
      const data = await res.json();
      return data.apiKey;
    },
    async createApiKey(payload: { key: string; description: string; models: string[] }): Promise<ApiKey> {
      const res = await fetch(`${base}/apikeys`, {
        method: "POST",
        headers: createAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to create API key");
      }
      const data = await res.json();
      return data.apiKey;
    },
    async updateApiKey(key: string, updates: { description?: string; models?: string[] }): Promise<ApiKey> {
      const res = await fetch(`${base}/apikeys/${encodeURIComponent(key)}`, {
        method: "PUT",
        headers: createAuthHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(updates),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to update API key");
      }
      const data = await res.json();
      return data.apiKey;
    },
    async deleteApiKey(key: string): Promise<void> {
      const res = await fetch(`${base}/apikeys/${encodeURIComponent(key)}`, {
        method: "DELETE",
        headers: createAuthHeaders()
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to delete API key");
      }
    },

    // Recorded requests operations
    async listRecordedRequests(params?: {
      backendId?: string;
      model?: string;
      startTime?: Date;
      endTime?: Date;
      limit?: number;
      offset?: number;
    }): Promise<{ requests: RecordedRequest[]; total: number; limit: number; offset: number }> {
      const queryParams = new URLSearchParams();
      if (params?.backendId) queryParams.append('backendId', params.backendId);
      if (params?.model) queryParams.append('model', params.model);
      if (params?.startTime) queryParams.append('startTime', params.startTime.toISOString());
      if (params?.endTime) queryParams.append('endTime', params.endTime.toISOString());
      if (params?.limit) queryParams.append('limit', params.limit.toString());
      if (params?.offset) queryParams.append('offset', params.offset.toString());

      const url = `${base}/recorded-requests${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
      const res = await fetch(url, {
        headers: createAuthHeaders()
      });
      if (!res.ok) throw new Error("Failed to load recorded requests");
      return await res.json();
    },

    async getRecordedRequest(id: string): Promise<RecordedRequest> {
      const res = await fetch(`${base}/recorded-requests/${encodeURIComponent(id)}`, {
        headers: createAuthHeaders()
      });
      if (!res.ok) throw new Error("Failed to load recorded request");
      const data = await res.json();
      return data.request;
    },

    async deleteRecordedRequests(params?: {
      backendId?: string;
      model?: string;
      startTime?: Date;
      endTime?: Date;
    }): Promise<{ deletedCount: number }> {
      const queryParams = new URLSearchParams();
      if (params?.backendId) queryParams.append('backendId', params.backendId);
      if (params?.model) queryParams.append('model', params.model);
      if (params?.startTime) queryParams.append('startTime', params.startTime.toISOString());
      if (params?.endTime) queryParams.append('endTime', params.endTime.toISOString());

      const url = `${base}/recorded-requests${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: createAuthHeaders()
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to delete recorded requests");
      }
      return await res.json();
    },

    // ===== Affinity Management APIs =====

    async listAffinityMappings(params?: {
      model?: string;
      backendId?: string;
      limit?: number;
      offset?: number;
    }): Promise<{ mappings: AffinityMapping[]; total: number; limit: number; offset: number }> {
      const queryParams = new URLSearchParams();
      if (params?.model) queryParams.append('model', params.model);
      if (params?.backendId) queryParams.append('backendId', params.backendId);
      if (params?.limit !== undefined) queryParams.append('limit', params.limit.toString());
      if (params?.offset !== undefined) queryParams.append('offset', params.offset.toString());

      const url = `${base}/affinity${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
      const res = await fetch(url, {
        headers: createAuthHeaders()
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to fetch affinity mappings");
      }
      return await res.json();
    },

    async getAffinityMapping(model: string, sessionId: string): Promise<{ model: string; sessionId: string; backendId: string }> {
      const url = `${base}/affinity/${encodeURIComponent(model)}/${encodeURIComponent(sessionId)}`;
      const res = await fetch(url, {
        headers: createAuthHeaders()
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to fetch affinity mapping");
      }
      return await res.json();
    },

    async deleteAffinityMapping(model: string, sessionId: string): Promise<{ message: string }> {
      const url = `${base}/affinity/${encodeURIComponent(model)}/${encodeURIComponent(sessionId)}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: createAuthHeaders()
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to delete affinity mapping");
      }
      return await res.json();
    },

    async clearAffinityMappings(filter: {
      model?: string;
      sessionId?: string;
      backendId?: string;
    }): Promise<{ message: string; deletedCount: number }> {
      const queryParams = new URLSearchParams();
      if (filter.model) queryParams.append('model', filter.model);
      if (filter.sessionId) queryParams.append('sessionId', filter.sessionId);
      if (filter.backendId) queryParams.append('backendId', filter.backendId);

      const url = `${base}/affinity${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
      const res = await fetch(url, {
        method: 'DELETE',
        headers: createAuthHeaders()
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to clear affinity mappings");
      }
      return await res.json();
    }
  };
}
