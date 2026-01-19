import * as React from "react";
import useAsyncFn from 'react-use/lib/useAsyncFn';
import { Button } from "../../ui/button";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "../../ui/table";
import { Switch } from "../../ui/switch";
import { useAdminApi, type BackendConfig, type ModelConfig, type LoadBalancingStrategy } from "~/apis";
import { AddModelDialog } from "./add-model-dialog";
import { EditModelDialog } from "./edit-model-dialog";
import { AddBackendDialog } from "./add-backend-dialog";
import { EditBackendDialog } from "./edit-backend-dialog";
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog";
import { getProviderDisplayName, getProviderBadgeClass } from "../../../config/provider-config";

export function BackendsPanel({ api }: { api: ReturnType<typeof useAdminApi> }) {
  const [models, setModels] = React.useState<(ModelConfig & { backends: (BackendConfig & { trafficRatio: number })[] })[]>([]);
  const [expandedModels, setExpandedModels] = React.useState<Set<string>>(new Set());
  const [addModelOpen, setAddModelOpen] = React.useState(false);
  const [editingModel, setEditingModel] = React.useState<ModelConfig | null>(null);
  const [addingBackendFor, setAddingBackendFor] = React.useState<string | null>(null);
  const [editingBackend, setEditingBackend] = React.useState<{ model: string; backend: BackendConfig } | null>(null);
  const [deletingModel, setDeletingModel] = React.useState<string | null>(null);
  const [deletingBackend, setDeletingBackend] = React.useState<{ model: string; backendId: string } | null>(null);

  const [listState, load] = useAsyncFn(async () => {
    try {
      const data = await api.listModels();
      setModels(data);
      // 默认展开所有模型
      setExpandedModels(new Set(data.map(m => m.model)));
      return data;
    } catch (error: any) {
      // 如果是鉴权错误,清除本地存储的密钥并刷新页面
      if (error?.message?.includes('Unauthorized') || error?.message?.includes('401')) {
        localStorage.removeItem('adminApiKey');
        window.location.reload();
      }
      throw error;
    }
  }, [api]);

  const [deleteModelState, deleteModel] = useAsyncFn(
    async (model: string) => {
      await api.deleteModel(model);
      await load();
    },
    [api, load]
  );

  const [updateEnabledState, updateEnabled] = useAsyncFn(
    async (model: string, backendId: string, enabled: boolean) => {
      await api.updateBackend(model, backendId, { enabled });
      await load();
    },
    [api, load]
  );

  const [updateRecordRequestsState, updateRecordRequests] = useAsyncFn(
    async (model: string, backendId: string, recordRequests: boolean) => {
      await api.updateBackend(model, backendId, { recordRequests });
      await load();
    },
    [api, load]
  );

  const [deleteBackendState, deleteBackend] = useAsyncFn(
    async (model: string, backendId: string) => {
      await api.deleteBackend(model, backendId);
      await load();
    },
    [api, load]
  );

  React.useEffect(() => {
    load();
  }, []);

  const toggleModel = (model: string) => {
    const newExpanded = new Set(expandedModels);
    if (newExpanded.has(model)) {
      newExpanded.delete(model);
    } else {
      newExpanded.add(model);
    }
    setExpandedModels(newExpanded);
  };

  const getStrategyLabel = (strategy: LoadBalancingStrategy) => {
    const labels = {
      'weighted': { text: '权重策略', color: 'bg-blue-100 text-blue-800' },
      'lowest-ttft': { text: '最低 TTFT', color: 'bg-green-100 text-green-800' },
      'min-error-rate': { text: '最小错误率', color: 'bg-purple-100 text-purple-800' }
    };
    return labels[strategy] || { text: strategy, color: 'bg-gray-100 text-gray-800' };
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Models & Backends</h2>
        <Button onClick={() => setAddModelOpen(true)}>Add Model</Button>
      </div>
      {(listState.error || deleteModelState.error || updateEnabledState.error || updateRecordRequestsState.error || deleteBackendState.error) && (
        <p className="text-sm text-red-600 mb-2">
          {(listState.error || deleteModelState.error || updateEnabledState.error || updateRecordRequestsState.error || deleteBackendState.error)?.message}
        </p>
      )}
      {models.length === 0 ? (
        <p className="text-sm text-gray-500">No models configured.</p>
      ) : (
        <div className="space-y-3">
          {models.map((modelConfig) => {
            const isExpanded = expandedModels.has(modelConfig.model);
            const strategyLabel = getStrategyLabel(modelConfig.loadBalancingStrategy);

            return (
              <div key={modelConfig.model} className="border rounded-lg shadow-sm hover:shadow-md transition-shadow">
                {/* Model header */}
                <div className="p-4 bg-gray-50/80 hover:bg-gray-100/80 cursor-pointer transition-colors" onClick={() => toggleModel(modelConfig.model)}>
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    {/* Model name */}
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-gray-400 shrink-0">{isExpanded ? '▼' : '▶'}</span>
                      <span className="text-lg font-medium break-all">{modelConfig.model}</span>
                    </div>

                    {/* Tags and actions */}
                    <div className="flex items-center gap-3 flex-wrap">
                      <span className={`px-2 py-1 rounded text-xs font-medium whitespace-nowrap ${getProviderBadgeClass(modelConfig.provider)}`}>
                        {getProviderDisplayName(modelConfig.provider)}
                      </span>
                      <span className={`px-2 py-1 rounded text-xs font-medium whitespace-nowrap ${strategyLabel.color}`}>
                        {strategyLabel.text}
                      </span>
                      <span className="text-sm text-gray-600 whitespace-nowrap">
                        ({modelConfig.backends.length} backend{modelConfig.backends.length !== 1 ? 's' : ''})
                      </span>
                      <div className="flex gap-2" onClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setEditingModel(modelConfig)}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => setDeletingModel(modelConfig.model)}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Backends table (expanded) */}
                {isExpanded && (
                  <div className="p-4 bg-white border-t">
                    {modelConfig.backends.length === 0 ? (
                      <p className="text-sm text-gray-500 mb-3">No backends configured for this model.</p>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>ID</TableHead>
                            <TableHead>Weight</TableHead>
                            <TableHead>Traffic Ratio</TableHead>
                            <TableHead>Max Concurrency</TableHead>
                            <TableHead>TTFT Timeout</TableHead>
                            <TableHead>Record Requests</TableHead>
                            <TableHead>Enabled</TableHead>
                            <TableHead>Actions</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {modelConfig.backends.map((backend) => {
                            return (
                              <TableRow key={backend.id}>
                                <TableCell className="font-mono">{backend.id}</TableCell>
                                <TableCell>{backend.weight}</TableCell>
                                <TableCell>{((backend as any).trafficRatio * 100).toFixed(1)}%</TableCell>
                                <TableCell>
                                  {backend.maxConcurrentRequests !== undefined && backend.maxConcurrentRequests > 0 ? (
                                    <span className="font-mono text-sm" title="最大并发请求数">
                                      {backend.maxConcurrentRequests}
                                    </span>
                                  ) : (
                                    <span className="text-gray-400" title="无限制">∞</span>
                                  )}
                                </TableCell>
                                <TableCell>
                                  <div className="flex flex-col gap-1 text-sm">
                                    {backend.streamingTTFTTimeout !== undefined && backend.streamingTTFTTimeout > 0 ? (
                                      <span className="font-mono" title="流式请求 TTFT 超时">
                                        Stream: {backend.streamingTTFTTimeout}ms
                                      </span>
                                    ) : null}
                                    {backend.nonStreamingTTFTTimeout !== undefined && backend.nonStreamingTTFTTimeout > 0 ? (
                                      <span className="font-mono" title="非流式请求 TTFT 超时">
                                        Non-Stream: {backend.nonStreamingTTFTTimeout}ms
                                      </span>
                                    ) : null}
                                    {(!backend.streamingTTFTTimeout || backend.streamingTTFTTimeout === 0) &&
                                      (!backend.nonStreamingTTFTTimeout || backend.nonStreamingTTFTTimeout === 0) ? (
                                      <span className="text-gray-400" title="未配置超时">-</span>
                                    ) : null}
                                  </div>
                                </TableCell>
                                <TableCell>
                                  <Switch
                                    checked={backend.recordRequests ?? false}
                                    onCheckedChange={(checked) => updateRecordRequests(modelConfig.model, backend.id, checked)}
                                  />
                                </TableCell>
                                <TableCell>
                                  <Switch
                                    checked={backend.enabled}
                                    onCheckedChange={(checked) => updateEnabled(modelConfig.model, backend.id, checked)}
                                  />
                                </TableCell>
                                <TableCell>
                                  <div className="inline-flex gap-2">
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => setEditingBackend({ model: modelConfig.model, backend })}
                                    >
                                      Edit
                                    </Button>
                                    <Button
                                      variant="destructive"
                                      size="sm"
                                      onClick={() => setDeletingBackend({ model: modelConfig.model, backendId: backend.id })}
                                    >
                                      Delete
                                    </Button>
                                  </div>
                                </TableCell>
                              </TableRow>
                            )
                          }
                          )}
                        </TableBody>
                      </Table>
                    )}
                    <div className="mt-3">
                      <Button variant="outline" size="sm" onClick={() => setAddingBackendFor(modelConfig.model)}>
                        + Add Backend
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <AddModelDialog open={addModelOpen} onOpenChange={setAddModelOpen} onAdded={load} />
      <EditModelDialog
        open={!!editingModel}
        model={editingModel}
        onOpenChange={(v) => !v && setEditingModel(null)}
        onSaved={() => {
          setEditingModel(null);
          load();
        }}
      />
      <AddBackendDialog
        open={!!addingBackendFor}
        model={addingBackendFor}
        provider={addingBackendFor ? models.find(m => m.model === addingBackendFor)?.provider ?? null : null}
        onOpenChange={(v) => !v && setAddingBackendFor(null)}
        onAdded={() => {
          setAddingBackendFor(null);
          load();
        }}
      />
      <EditBackendDialog
        open={!!editingBackend}
        model={editingBackend?.model ?? null}
        backend={editingBackend?.backend ?? null}
        onOpenChange={(v) => !v && setEditingBackend(null)}
        onSaved={() => {
          setEditingBackend(null);
          load();
        }}
      />
      <DeleteConfirmationDialog
        open={!!deletingModel}
        onOpenChange={(v) => !v && setDeletingModel(null)}
        title="Delete Model"
        description={`This will permanently delete the model "${deletingModel}" and all its backends. This action cannot be undone.`}
        expectedInput={deletingModel ?? ""}
        onConfirm={async () => {
          if (deletingModel) {
            await deleteModel(deletingModel);
            setDeletingModel(null);
          }
        }}
        isDeleting={deleteModelState.loading}
      />
      <DeleteConfirmationDialog
        open={!!deletingBackend}
        onOpenChange={(v) => !v && setDeletingBackend(null)}
        title="Delete Backend"
        description={`This will permanently delete the backend. This action cannot be undone.`}
        expectedInput={deletingBackend ? `${deletingBackend.model}/${deletingBackend.backendId}` : ""}
        onConfirm={async () => {
          if (deletingBackend) {
            await deleteBackend(deletingBackend.model, deletingBackend.backendId);
            setDeletingBackend(null);
          }
        }}
        isDeleting={deleteBackendState.loading}
      />
    </div>
  );
}
