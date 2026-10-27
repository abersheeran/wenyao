import { Pencil, Trash2 } from "lucide-react";
import type { BackendConfig, Connection, LoadBalancingStrategy, ModelConfig, useAdminApi } from "~/apis";
import { getProviderBadgeClass, getProviderDisplayName } from "../../../config/provider-config";
import { Button } from "../../ui/button";
import { Switch } from "../../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../ui/table";

export type ListedModel = Awaited<ReturnType<ReturnType<typeof useAdminApi>["listModels"]>>[number];

type ModelDetailsProps = {
  model: ListedModel;
  connections: Connection[];
  onEditModel: (model: ModelConfig) => void;
  onDeleteModel: (model: string) => void;
  onAddBackend: (model: string) => void;
  onEditBackend: (model: string, backend: BackendConfig) => void;
  onDeleteBackend: (model: string, backendId: string) => void;
  onUpdateEnabled: (model: string, backendId: string, value: boolean) => void;
  onUpdateRecordRequests: (model: string, backendId: string, value: boolean) => void;
  onUpdateRecordResponses: (model: string, backendId: string, value: boolean) => void;
};

function formatTimeout(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}

const strategyLabels: Record<LoadBalancingStrategy, { text: string; color: string }> = {
  weighted: { text: "权重策略", color: "bg-blue-100 text-blue-800" },
  "lowest-ttft": { text: "最低 TTFT", color: "bg-green-100 text-green-800" },
  "min-error-rate": { text: "最小错误率", color: "bg-purple-100 text-purple-800" },
};

export function ModelDetails({
  model,
  connections,
  onEditModel,
  onDeleteModel,
  onAddBackend,
  onEditBackend,
  onDeleteBackend,
  onUpdateEnabled,
  onUpdateRecordRequests,
  onUpdateRecordResponses,
}: ModelDetailsProps) {
  const strategy = strategyLabels[model.loadBalancingStrategy] ?? {
    text: model.loadBalancingStrategy,
    color: "bg-gray-100 text-gray-800",
  };
  const backends: ListedModel["backends"][number][] = model.backends;

  return (
    <section className="min-w-0 max-w-full rounded-lg border bg-white shadow-sm" aria-label={`Model details for ${model.model}`}>
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-t-lg border-b bg-gray-50/80 p-4">
        <div className="min-w-0 space-y-3">
          <h3 className="break-all text-lg font-medium">{model.model}</h3>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`whitespace-nowrap rounded px-2 py-1 text-xs font-medium ${getProviderBadgeClass(model.provider)}`}>
              {getProviderDisplayName(model.provider)}
            </span>
            <span className={`whitespace-nowrap rounded px-2 py-1 text-xs font-medium ${strategy.color}`}>
              {strategy.text}
            </span>
            <span className="text-sm text-gray-600">亲和: {model.enableAffinity ? "已开启" : "未开启"}</span>
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" onClick={() => onEditModel(model)}>
            Edit
          </Button>
          <Button variant="destructive" size="sm" onClick={() => onDeleteModel(model.model)}>
            Delete
          </Button>
        </div>
      </div>

      <div className="min-w-0 space-y-4 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h4 className="font-medium">Backends ({backends.length})</h4>
          <Button size="sm" onClick={() => onAddBackend(model.model)}>
            + Add Backend
          </Button>
        </div>
        {backends.length === 0 ? (
          <p className="py-4 text-sm text-gray-500">No backends configured for this model. Add a backend to start routing requests.</p>
        ) : (
          <Table aria-label={`Backends for ${model.model}`}>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Enabled</TableHead>
                <TableHead>Backend</TableHead>
                <TableHead>Weight</TableHead>
                <TableHead>Limits</TableHead>
                <TableHead>Recording</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {backends.map((backend) => {
                const connection = connections.find((item) => item.id === backend.connectionId);
                const streaming = backend.streamingTTFTTimeout ?? 0;
                const nonStreaming = backend.nonStreamingTTFTTimeout ?? 0;
                return (
                  <TableRow key={backend.id}>
                    <TableCell>
                      <Switch
                        aria-label={`Enable backend ${backend.id}`}
                        checked={backend.enabled}
                        onCheckedChange={(checked) => onUpdateEnabled(model.model, backend.id, checked)}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="font-mono text-sm">{backend.id}</div>
                      <div className="text-xs text-gray-500" title="Connection">
                        {connection?.name || backend.connectionId || <span className="text-amber-700">Connection not configured</span>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{backend.weight}</div>
                      <div className="text-xs text-gray-500" title="流量占比">{(backend.trafficRatio * 100).toFixed(1)}%</div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm" title="最大并发请求数">
                        并发 {backend.maxConcurrentRequests ? backend.maxConcurrentRequests : "∞"}
                      </div>
                      <div className="text-xs text-gray-500" title="TTFT 超时">
                        TTFT {streaming || nonStreaming
                          ? [streaming && `流式 ${formatTimeout(streaming)}`, nonStreaming && `非流式 ${formatTimeout(nonStreaming)}`].filter(Boolean).join(" · ")
                          : "-"}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-1.5 text-xs">
                        <label className="inline-flex items-center gap-2">
                          <Switch
                            aria-label={`Record requests for ${backend.id}`}
                            checked={backend.recordRequests ?? false}
                            onCheckedChange={(checked) => onUpdateRecordRequests(model.model, backend.id, checked)}
                          />
                          请求
                        </label>
                        <label className={`inline-flex items-center gap-2 ${backend.recordRequests ? "" : "text-gray-400"}`}>
                          <Switch
                            aria-label={`Record responses for ${backend.id}`}
                            checked={backend.recordResponses ?? false}
                            disabled={!backend.recordRequests}
                            onCheckedChange={(checked) => onUpdateRecordResponses(model.model, backend.id, checked)}
                          />
                          响应
                        </label>
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="inline-flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Edit backend ${backend.id}`}
                          title="Edit"
                          onClick={() => onEditBackend(model.model, backend)}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete backend ${backend.id}`}
                          title="Delete"
                          className="text-red-600 hover:text-red-700"
                          onClick={() => onDeleteBackend(model.model, backend.id)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </section>
  );
}
