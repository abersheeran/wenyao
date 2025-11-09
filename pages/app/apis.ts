export type LoadBalancingStrategy = 'weighted' | 'lowest-ttft' | 'min-error-rate';

export type BackendConfig = {
  id: string;
  url: string;
  apiKey: string;
  weight: number;
  enabled: boolean;
};

export type ModelConfig = {
  model: string;
  backends: BackendConfig[];
  loadBalancingStrategy: LoadBalancingStrategy;
};

export type BackendStats = {
  backendId: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  successRate: number;
  averageTTFT: number;
  ttftSamples: number[];
};

export type StatsDataPoint = {
  instanceId: string; // Instance unique identifier
  backendId: string;
  timestamp: string | Date;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  successRate: number;
  averageTTFT: number;
  requestsInPeriod: number;
};

export type HistoricalStatsResponse = {
  backendId: string;
  dataPoints: StatsDataPoint[];
  startTime?: string | Date;
  endTime?: string | Date;
  message?: string;
};

export function useAdminApi() {
  const apiBase = (import.meta as any).env?.VITE_API_BASE ?? "";
  const base = apiBase ? `${String(apiBase).replace(/\/$/, "")}/admin` : "/admin";
  return {
    // Model-level operations
    async listModels(): Promise<(ModelConfig & { backends: (BackendConfig & { trafficRatio: number })[] })[]> {
      const res = await fetch(`${base}/models`);
      if (!res.ok) throw new Error("Failed to load models");
      const data = await res.json();
      return data.models ?? [];
    },
    async getModel(model: string): Promise<ModelConfig & { backends: (BackendConfig & { trafficRatio: number })[] }> {
      const res = await fetch(`${base}/models/${encodeURIComponent(model)}`);
      if (!res.ok) throw new Error("Failed to load model");
      const data = await res.json();
      return data.model;
    },
    async addModel(payload: Omit<ModelConfig, 'backends'> & { backends?: BackendConfig[] }): Promise<ModelConfig> {
      const res = await fetch(`${base}/models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, backends: payload.backends ?? [] }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to add model");
      }
      const data = await res.json();
      return data.model;
    },
    async updateModel(model: string, updates: { loadBalancingStrategy?: LoadBalancingStrategy; backends?: BackendConfig[] }): Promise<ModelConfig> {
      const res = await fetch(`${base}/models/${encodeURIComponent(model)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
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
      const res = await fetch(`${base}/models/${encodeURIComponent(model)}`, { method: "DELETE" });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to delete model");
      }
    },

    // Backend operations within models
    async listBackends(model: string): Promise<(BackendConfig & { trafficRatio: number })[]> {
      const res = await fetch(`${base}/models/${encodeURIComponent(model)}/backends`);
      if (!res.ok) throw new Error("Failed to load backends");
      const data = await res.json();
      return data.backends ?? [];
    },
    async addBackend(model: string, payload: BackendConfig): Promise<ModelConfig> {
      const res = await fetch(`${base}/models/${encodeURIComponent(model)}/backends`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
        headers: { "Content-Type": "application/json" },
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
        method: "DELETE"
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Failed to delete backend");
      }
    },

    // Prometheus Metrics
    async getPrometheusMetrics(): Promise<string> {
      const res = await fetch(`${base}/metrics`);
      if (!res.ok) throw new Error("Failed to load Prometheus metrics");
      return await res.text();
    },

    // Historical stats operations (near-realtime aggregated from MongoDB)
    async getHistoricalStats(backendId: string, startTime?: Date, endTime?: Date): Promise<HistoricalStatsResponse> {
      const params = new URLSearchParams();
      if (startTime) params.append('startTime', startTime.toISOString());
      if (endTime) params.append('endTime', endTime.toISOString());

      const queryString = params.toString();
      const url = `${base}/stats/history/${encodeURIComponent(backendId)}${queryString ? `?${queryString}` : ''}`;

      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to load historical stats");
      return await res.json();
    },
    async getAllHistoricalStats(startTime?: Date, endTime?: Date): Promise<Record<string, StatsDataPoint[]>> {
      const params = new URLSearchParams();
      if (startTime) params.append('startTime', startTime.toISOString());
      if (endTime) params.append('endTime', endTime.toISOString());

      const queryString = params.toString();
      const url = `${base}/stats/history${queryString ? `?${queryString}` : ''}`;

      const res = await fetch(url);
      if (!res.ok) throw new Error("Failed to load all historical stats");
      const data = await res.json();
      return data.history ?? {};
    },
  };
}
