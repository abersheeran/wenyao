import * as React from "react";
import useAsyncFn from 'react-use/lib/useAsyncFn';
import { Button } from "../components/ui/button";
import Input from "../components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "../components/ui/table";
import { Switch } from "../components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { useAdminApi, type BackendConfig, type ModelConfig, type LoadBalancingStrategy, type StatsDataPoint } from "~/apis";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../components/ui/chart";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

export function meta() {
  return [
    { title: "Admin | LLM Proxy" },
  ];
}

export default function Admin() {
  const api = useAdminApi();
  const [tab, setTab] = React.useState<string>("backends");
  const [showApiKeyDialog, setShowApiKeyDialog] = React.useState(false);
  const [apiKeyInput, setApiKeyInput] = React.useState("");
  const [hasApiKey, setHasApiKey] = React.useState(false);

  // 检查是否已有 API Key
  React.useEffect(() => {
    const storedKey = localStorage.getItem('adminApiKey');
    setHasApiKey(!!storedKey);
    if (!storedKey) {
      setShowApiKeyDialog(true);
    }
  }, []);

  const handleSaveApiKey = () => {
    if (apiKeyInput.trim()) {
      localStorage.setItem('adminApiKey', apiKeyInput.trim());
      setHasApiKey(true);
      setShowApiKeyDialog(false);
      setApiKeyInput("");
      // 刷新页面以使用新的 API Key
      window.location.reload();
    }
  };

  const handleClearApiKey = () => {
    localStorage.removeItem('adminApiKey');
    setHasApiKey(false);
    setShowApiKeyDialog(true);
  };

  return (
    <main className="container mx-auto p-4 space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Admin</h1>
        <div className="flex items-center gap-4">
          <Tabs value={tab} onValueChange={(v) => setTab(v)}>
            <TabsList>
              <TabsTrigger value="backends">Backends</TabsTrigger>
              <TabsTrigger value="stats">Stats</TabsTrigger>
              <TabsTrigger value="metrics">Metrics</TabsTrigger>
            </TabsList>
          </Tabs>
          {hasApiKey && (
            <Button variant="outline" size="sm" onClick={handleClearApiKey}>
              更换密钥
            </Button>
          )}
        </div>
      </header>

      {/* API Key 输入对话框 */}
      <Dialog open={showApiKeyDialog} onOpenChange={setShowApiKeyDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>请输入管理 API 密钥</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              需要提供 API 密钥才能访问管理接口
            </p>
            <Input
              type="password"
              placeholder="请输入 API Key"
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleSaveApiKey();
                }
              }}
            />
            <Button onClick={handleSaveApiKey} className="w-full">
              确认
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {tab === "backends" && <BackendsPanel api={api} />}
      {tab === "stats" && <StatsPanel api={api} />}
      {tab === "metrics" && <MetricsPanel api={api} />}
    </main>
  );
}

function BackendsPanel({ api }: { api: ReturnType<typeof useAdminApi> }) {
  const [models, setModels] = React.useState<(ModelConfig & { backends: (BackendConfig & { trafficRatio: number })[] })[]>([]);
  const [expandedModels, setExpandedModels] = React.useState<Set<string>>(new Set());
  const [addModelOpen, setAddModelOpen] = React.useState(false);
  const [editingModel, setEditingModel] = React.useState<ModelConfig | null>(null);
  const [addingBackendFor, setAddingBackendFor] = React.useState<string | null>(null);
  const [editingBackend, setEditingBackend] = React.useState<{ model: string; backend: BackendConfig } | null>(null);

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
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Models & Backends</CardTitle>
        <Button onClick={() => setAddModelOpen(true)}>Add Model</Button>
      </CardHeader>
      <CardContent>
        {(listState.error || deleteModelState.error || updateEnabledState.error || deleteBackendState.error) && (
          <p className="text-sm text-red-600 mb-2">
            {(listState.error || deleteModelState.error || updateEnabledState.error || deleteBackendState.error)?.message}
          </p>
        )}
        {listState.loading ? (
          <p className="text-sm text-gray-500">Loading...</p>
        ) : models.length === 0 ? (
          <p className="text-sm text-gray-500">No models configured.</p>
        ) : (
          <div className="space-y-4">
            {models.map((modelConfig) => {
              const isExpanded = expandedModels.has(modelConfig.model);
              const strategyLabel = getStrategyLabel(modelConfig.loadBalancingStrategy);

              return (
                <div key={modelConfig.model} className="border rounded-lg">
                  {/* Model header */}
                  <div className="flex items-center justify-between p-4 bg-gray-50 hover:bg-gray-100 cursor-pointer" onClick={() => toggleModel(modelConfig.model)}>
                    <div className="flex items-center gap-3">
                      <span className="text-lg font-medium">
                        {isExpanded ? '▼' : '▶'} {modelConfig.model}
                      </span>
                      <span className={`px-2 py-1 rounded text-xs font-medium ${strategyLabel.color}`}>
                        {strategyLabel.text}
                      </span>
                      <span className="text-sm text-gray-600">
                        ({modelConfig.backends.length} backend{modelConfig.backends.length !== 1 ? 's' : ''})
                      </span>
                    </div>
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
                        onClick={() => {
                          if (confirm(`Delete model ${modelConfig.model} and all its backends?`)) {
                            deleteModel(modelConfig.model);
                          }
                        }}
                      >
                        Delete
                      </Button>
                    </div>
                  </div>

                  {/* Backends table (expanded) */}
                  {isExpanded && (
                    <div className="p-4">
                      {modelConfig.backends.length === 0 ? (
                        <p className="text-sm text-gray-500 mb-3">No backends configured for this model.</p>
                      ) : (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>ID</TableHead>
                              <TableHead>URL</TableHead>
                              <TableHead>Weight</TableHead>
                              <TableHead>Traffic Ratio</TableHead>
                              <TableHead>Enabled</TableHead>
                              <TableHead>Actions</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {modelConfig.backends.map((backend) => (
                              <TableRow key={backend.id}>
                                <TableCell className="font-mono">{backend.id}</TableCell>
                                <TableCell className="truncate max-w-[300px]" title={backend.url}>{backend.url}</TableCell>
                                <TableCell>{backend.weight}</TableCell>
                                <TableCell>{((backend as any).trafficRatio * 100).toFixed(1)}%</TableCell>
                                <TableCell>
                                  <Switch
                                    checked={backend.enabled}
                                    onCheckedChange={(checked) => updateEnabled(modelConfig.model, backend.id, checked)}
                                  />
                                </TableCell>
                                <TableCell className="space-x-2">
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
                                    onClick={() => {
                                      if (confirm(`Delete backend ${backend.id}?`)) {
                                        deleteBackend(modelConfig.model, backend.id);
                                      }
                                    }}
                                  >
                                    Delete
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                      <div className="mt-3">
                        <Button variant="outline" size="sm" onClick={() => setAddingBackendFor(modelConfig.model)}>
                          + Add Backend to {modelConfig.model}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

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
    </Card>
  );
}

function AddModelDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (v: boolean) => void; onAdded: () => void; }) {
  const api = useAdminApi();
  const [form, setForm] = React.useState<{ model: string; loadBalancingStrategy: LoadBalancingStrategy }>({
    model: "",
    loadBalancingStrategy: "weighted"
  });

  const [submitState, submit] = useAsyncFn(async (e: React.FormEvent) => {
    e.preventDefault();
    await api.addModel(form);
    setForm({ model: "", loadBalancingStrategy: "weighted" });
    onOpenChange(false);
    onAdded();
  }, [api, form, onOpenChange, onAdded]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Model</DialogTitle>
        </DialogHeader>
        <form className="space-y-3" onSubmit={submit}>
          {submitState.error && <p className="text-sm text-red-600">{submitState.error.message}</p>}
          <div>
            <label className="block text-sm mb-1">Model Name</label>
            <Input
              required
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              placeholder="e.g., gpt-4, claude-3-sonnet"
            />
          </div>
          <div>
            <label className="block text-sm mb-1">Load Balancing Strategy</label>
            <Select
              value={form.loadBalancingStrategy}
              onValueChange={(v) => setForm({ ...form, loadBalancingStrategy: v as LoadBalancingStrategy })}
           >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="weighted">权重策略 (Weighted)</SelectItem>
                <SelectItem value="lowest-ttft">最低 TTFT (Lowest TTFT)</SelectItem>
                <SelectItem value="min-error-rate">最小错误率 (Min Error Rate)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-gray-500 mt-1">
              {form.loadBalancingStrategy === 'weighted' && '根据配置的权重分配流量'}
              {form.loadBalancingStrategy === 'lowest-ttft' && '选择平均首token时间最低的后端'}
              {form.loadBalancingStrategy === 'min-error-rate' && '根据错误率动态调整流量分配'}
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitState.loading}>
              {submitState.loading ? "Creating..." : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditModelDialog({ open, onOpenChange, model, onSaved }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  model: ModelConfig | null;
  onSaved: () => void;
}) {
  const api = useAdminApi();
  const [strategy, setStrategy] = React.useState<LoadBalancingStrategy>("weighted");

  React.useEffect(() => {
    if (model) {
      setStrategy(model.loadBalancingStrategy);
    }
  }, [model]);

  const [submitState, submit] = useAsyncFn(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!model) return;
    await api.updateModel(model.model, { loadBalancingStrategy: strategy });
    onSaved();
  }, [api, model, strategy, onSaved]);

  if (!model) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Model: {model.model}</DialogTitle>
        </DialogHeader>
        <form className="space-y-3" onSubmit={submit}>
          {submitState.error && <p className="text-sm text-red-600">{submitState.error.message}</p>}
          <div>
            <label className="block text-sm mb-1">Model Name</label>
            <Input value={model.model} disabled readOnly />
            <p className="text-xs text-gray-500 mt-1">Model name cannot be changed</p>
          </div>
          <div>
            <label className="block text-sm mb-1">Load Balancing Strategy</label>
            <Select value={strategy} onValueChange={(v) => setStrategy(v as LoadBalancingStrategy)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="weighted">权重策略 (Weighted)</SelectItem>
                <SelectItem value="lowest-ttft">最低 TTFT (Lowest TTFT)</SelectItem>
                <SelectItem value="min-error-rate">最小错误率 (Min Error Rate)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-gray-500 mt-1">
              {strategy === 'weighted' && '根据配置的权重分配流量'}
              {strategy === 'lowest-ttft' && '选择平均首token时间最低的后端'}
              {strategy === 'min-error-rate' && '根据错误率动态调整流量分配'}
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitState.loading}>
              {submitState.loading ? "Saving..." : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AddBackendDialog({ open, onOpenChange, model, onAdded }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  model: string | null;
  onAdded: () => void;
}) {
  const api = useAdminApi();
  const [form, setForm] = React.useState<BackendConfig>({
    id: "",
    url: "",
    apiKey: "",
    weight: 1,
    enabled: true
  });

  const [submitState, submit] = useAsyncFn(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!model) return;
    await api.addBackend(model, form);
    setForm({ id: "", url: "", apiKey: "", weight: 1, enabled: true });
    onOpenChange(false);
    onAdded();
  }, [api, model, form, onOpenChange, onAdded]);

  if (!model) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Backend to {model}</DialogTitle>
        </DialogHeader>
        <form className="space-y-3" onSubmit={submit}>
          {submitState.error && <p className="text-sm text-red-600">{submitState.error.message}</p>}
          <div>
            <label className="block text-sm mb-1">Backend ID</label>
            <Input required value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
          </div>
          <div>
            <label className="block text-sm mb-1">URL</label>
            <Input required value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          </div>
          <div>
            <label className="block text-sm mb-1">API Key</label>
            <Input required value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm mb-1">Weight</label>
              <Input
                type="number"
                min={0}
                step={1}
                value={form.weight}
                onChange={(e) => setForm({ ...form, weight: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="block text-sm mb-1" htmlFor="enabled-add">Enabled</label>
              <Switch
                id="enabled-add"
                size="md"
                checked={form.enabled}
                onCheckedChange={(v) => setForm({ ...form, enabled: v })}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitState.loading}>
              {submitState.loading ? "Adding..." : "Add"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditBackendDialog({ open, onOpenChange, model, backend, onSaved }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  model: string | null;
  backend: BackendConfig | null;
  onSaved: () => void;
}) {
  const api = useAdminApi();
  const [form, setForm] = React.useState<BackendConfig | null>(backend);

  React.useEffect(() => {
    setForm(backend);
  }, [backend]);

  const [submitState, submit] = useAsyncFn(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!model || !form) return;
    await api.updateBackend(model, form.id, {
      url: form.url,
      apiKey: form.apiKey,
      weight: form.weight,
      enabled: form.enabled
    });
    onSaved();
  }, [api, model, form, onSaved]);

  if (!form || !model) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit Backend: {form.id}</DialogTitle>
        </DialogHeader>
        <form className="space-y-3" onSubmit={submit}>
          {submitState.error && <p className="text-sm text-red-600">{submitState.error.message}</p>}
          <div>
            <label className="block text-sm mb-1">Backend ID</label>
            <Input value={form.id} disabled readOnly />
          </div>
          <div>
            <label className="block text-sm mb-1">Model</label>
            <Input value={model} disabled readOnly />
          </div>
          <div>
            <label className="block text-sm mb-1">URL</label>
            <Input required value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
          </div>
          <div>
            <label className="block text-sm mb-1">API Key</label>
            <Input required value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm mb-1">Weight</label>
              <Input
                type="number"
                min={0}
                step={1}
                value={form.weight}
                onChange={(e) => setForm({ ...form, weight: Number(e.target.value) })}
              />
            </div>
            <div>
              <label className="block text-sm mb-1" htmlFor="enabled-edit">Enabled</label>
              <Switch
                id="enabled-edit"
                size="md"
                checked={form.enabled}
                onCheckedChange={(v) => setForm({ ...form, enabled: v })}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitState.loading}>
              {submitState.loading ? "Saving..." : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function StatsPanel({ api }: { api: ReturnType<typeof useAdminApi> }) {
  const [historyData, setHistoryData] = React.useState<Record<string, StatsDataPoint[]>>({});
  const [timeRange, setTimeRange] = React.useState<string>("1h"); // 1h, 6h, 24h, 7d

  const [historyState, loadHistory] = useAsyncFn(async () => {
    const now = new Date();
    let startTime: Date;

    switch (timeRange) {
      case "1h":
        startTime = new Date(now.getTime() - 60 * 60 * 1000);
        break;
      case "6h":
        startTime = new Date(now.getTime() - 6 * 60 * 60 * 1000);
        break;
      case "24h":
        startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case "7d":
        startTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      default:
        startTime = new Date(now.getTime() - 60 * 60 * 1000);
    }

    const data = await api.getAllHistoricalStats(startTime, now);
    setHistoryData(data);
    return data;
  }, [api, timeRange]);

  React.useEffect(() => {
    loadHistory();

    // Auto refresh every 30 seconds
    const interval = setInterval(() => {
      loadHistory();
    }, 30000);

    return () => clearInterval(interval);
  }, [timeRange]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>历史趋势（多实例聚合）</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              数据每 15 秒更新一次，显示所有实例的聚合结果
            </p>
          </div>
          <div className="flex gap-2">
            <Select value={timeRange} onValueChange={(v) => setTimeRange(v)}>
              <SelectTrigger className="text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1h">过去 1 小时</SelectItem>
                <SelectItem value="6h">过去 6 小时</SelectItem>
                <SelectItem value="24h">过去 24 小时</SelectItem>
                <SelectItem value="7d">过去 7 天</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={loadHistory} disabled={historyState.loading}>
              刷新
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {historyState.error && (
          <p className="text-sm text-red-600 mb-2">{historyState.error.message}</p>
        )}
        {historyState.loading ? (
          <p className="text-sm text-gray-500">加载中...</p>
        ) : Object.keys(historyData).length === 0 ? (
          <p className="text-sm text-gray-500">暂无历史数据</p>
        ) : (
          <div className="space-y-8">
            <HistoricalCharts historyData={historyData} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HistoricalCharts({ historyData }: { historyData: Record<string, StatsDataPoint[]> }) {
  const backendIds = Object.keys(historyData);

  // Generate colors for each backend using CSS variables
  // Use var(...) so they resolve to actual theme colors
  const colorKeys = [
    "var(--chart-1)",
    "var(--chart-2)",
    "var(--chart-3)",
    "var(--chart-4)",
    "var(--chart-5)"
  ];

  // Prepare data for charts - merge all backends into single timeline
  const mergedData = React.useMemo(() => {
    const timeMap = new Map<string, any>();

    backendIds.forEach((backendId) => {
      const points = historyData[backendId] || [];
      points.forEach(point => {
        const time = new Date(point.timestamp).getTime();
        const timeKey = time.toString();

        if (!timeMap.has(timeKey)) {
          timeMap.set(timeKey, { time, timestamp: point.timestamp });
        }

        const entry = timeMap.get(timeKey);
        entry[`successRate_${backendId}`] = point.successRate * 100;
        entry[`ttft_${backendId}`] = point.averageTTFT;
        entry[`requests_${backendId}`] = point.totalRequests;
      });
    });

    return Array.from(timeMap.values()).sort((a, b) => a.time - b.time);
  }, [historyData, backendIds]);

  const formatTime = (timestamp: string | Date) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  };

  const chartConfig = React.useMemo(() => {
    const config: Record<string, { label: string; color: string }> = {};
    backendIds.forEach((id) => {
      const blue = "var(--chart-2)"; // unified blue from theme palette
      config[`successRate_${id}`] = {
        label: id,
        color: blue,
      };
      config[`ttft_${id}`] = {
        label: id,
        color: blue,
      };
      config[`requests_${id}`] = {
        label: id,
        color: blue,
      };
    });
    return config;
  }, [backendIds]);

  return (
    <>
      {/* Success Rate Chart */}
      <div>
        <div className="mb-4">
          <h3 className="text-base font-medium mb-1">成功率趋势</h3>
          <p className="text-sm text-muted-foreground">各 Backend 请求成功率变化 (%)</p>
        </div>
        <ChartContainer config={chartConfig} className="h-[300px] w-full">
          <AreaChart
            accessibilityLayer
            data={mergedData}
            margin={{
              left: 12,
              right: 12,
              top: 12,
            }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="timestamp"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={formatTime}
            />
            <YAxis
              domain={[0, 100]}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(value) => `${value}%`}
            />
            <ChartTooltip
              cursor={false}
              content={<ChartTooltipContent indicator="dot" />}
            />
            {backendIds.map((id, index) => (
              <Area
                key={id}
                dataKey={`successRate_${id}`}
                type="linear"
                // Use the per-series CSS variable generated by ChartContainer
                fill={`var(--color-successRate_${id})`}
                fillOpacity={0.25}
                stroke={`var(--color-successRate_${id})`}
                strokeWidth={2}
                stackId="a"
              />
            ))}
          </AreaChart>
        </ChartContainer>
      </div>

      {/* TTFT Chart */}
      <div>
        <div className="mb-4">
          <h3 className="text-base font-medium mb-1">平均 TTFT 趋势</h3>
          <p className="text-sm text-muted-foreground">各 Backend 首 Token 响应时间 (毫秒)</p>
        </div>
        <ChartContainer config={chartConfig} className="h-[300px] w-full">
          <AreaChart
            accessibilityLayer
            data={mergedData}
            margin={{
              left: 12,
              right: 12,
              top: 12,
            }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="timestamp"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={formatTime}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(value) => `${value}ms`}
            />
            <ChartTooltip
              cursor={false}
              content={<ChartTooltipContent indicator="dot" />}
            />
            {backendIds.map((id, index) => (
              <Area
                key={id}
                dataKey={`ttft_${id}`}
                type="linear"
                fill={`var(--color-ttft_${id})`}
                fillOpacity={0.25}
                stroke={`var(--color-ttft_${id})`}
                strokeWidth={2}
                stackId="a"
              />
            ))}
          </AreaChart>
        </ChartContainer>
      </div>

      {/* Total Requests Chart */}
      <div>
        <div className="mb-4">
          <h3 className="text-base font-medium mb-1">累计请求数趋势</h3>
          <p className="text-sm text-muted-foreground">各 Backend 处理的总请求数量</p>
        </div>
        <ChartContainer config={chartConfig} className="h-[300px] w-full">
          <AreaChart
            accessibilityLayer
            data={mergedData}
            margin={{
              left: 12,
              right: 12,
              top: 12,
            }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="timestamp"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={formatTime}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
            />
            <ChartTooltip
              cursor={false}
              content={<ChartTooltipContent indicator="dot" />}
            />
            {backendIds.map((id, index) => (
              <Area
                key={id}
                dataKey={`requests_${id}`}
                type="linear"
                fill={`var(--color-requests_${id})`}
                fillOpacity={0.25}
                stroke={`var(--color-requests_${id})`}
                strokeWidth={2}
                stackId="a"
              />
            ))}
          </AreaChart>
        </ChartContainer>
      </div>
    </>
  );
}

function MetricsPanel({ api }: { api: ReturnType<typeof useAdminApi> }) {
  const [text, setText] = React.useState<string>("");
  const [loadState, load] = useAsyncFn(async () => {
    const data = await api.getPrometheusMetrics();
    setText(data);
    return data;
  }, [api]);

  React.useEffect(() => {
    load();
  }, []);

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Prometheus Metrics</CardTitle>
        <Button variant="outline" onClick={load} disabled={loadState.loading}>Refresh</Button>
      </CardHeader>
      <CardContent>
        {loadState.error && <p className="text-sm text-red-600 mb-2">{loadState.error.message}</p>}
        {loadState.loading ? (
          <p className="text-sm text-gray-500">Loading...</p>
        ) : (
          <pre className="text-xs whitespace-pre-wrap bg-gray-50 p-3 rounded border border-gray-200 overflow-auto max-h-[60vh]">{text}</pre>
        )}
      </CardContent>
    </Card>
  );
}
