import * as React from "react";
import { Link } from "react-router";
import useAsyncFn from 'react-use/lib/useAsyncFn';
import { Button } from "../../ui/button";
import Input from "../../ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import { Switch } from "../../ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { useAdminApi, type BackendConfig, type ProviderType, type Connection } from "~/apis";
import { getProviderDisplayName } from "../../../config/provider-config";

export function AddBackendDialog({ open, onOpenChange, model, provider, connections, onAdded }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  model: string | null;
  provider: ProviderType | null;
  connections: Connection[];
  onAdded: () => void;
}) {
  const api = useAdminApi();

  const createInitialForm = (prov: ProviderType): BackendConfig => {
    return {
      id: "",
      provider: prov,
      weight: 1,
      enabled: true,
      model: undefined,
      streamingTTFTTimeout: 0,
      nonStreamingTTFTTimeout: 0,
      recordRequests: false,
      recordResponses: false,
      maxConcurrentRequests: 0,
      connectionId: "",
    };
  };

  const [form, setForm] = React.useState<BackendConfig>(
    createInitialForm(provider || "openai")
  );

  // Update form when provider changes
  React.useEffect(() => {
    if (provider) {
      setForm(createInitialForm(provider));
    }
  }, [provider]);

  const [submitState, submit] = useAsyncFn(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!model || !provider || !connections.some(connection => connection.id === form.connectionId)) return;
    await api.addBackend(model, form);
    // Reset form
    setForm(createInitialForm(provider));
    onOpenChange(false);
    onAdded();
  }, [api, model, provider, connections, form, onOpenChange, onAdded]);

  if (!model) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Backend to {model}</DialogTitle>
        </DialogHeader>
        <form className="space-y-3" onSubmit={submit}>
          {submitState.error && <p className="text-sm text-red-600">{submitState.error.message}</p>}
          <div>
            <label className="block text-sm mb-1">Backend ID</label>
            <Input required value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
          </div>

          {/* Backend Configuration Section */}
          <div className="border rounded-lg p-3 space-y-3 bg-gray-50">
            <h4 className="text-sm font-medium text-gray-700">Backend 配置 ({provider && getProviderDisplayName(provider)})</h4>

            <div>
              <label htmlFor="backend-connection-add" className="block text-sm mb-1">Connection</label>
              {connections.length === 0 ? (
                <p className="text-sm text-gray-500">
                  No connections available for this provider. <Link to="/connections" className="text-blue-600 underline">Create a connection</Link> first.
                </p>
              ) : (
                <Select
                  value={connections.some(connection => connection.id === form.connectionId) ? form.connectionId : ""}
                  onValueChange={(connectionId) => setForm({ ...form, connectionId })}
                  required
                >
                  <SelectTrigger id="backend-connection-add" className="w-full">
                    <SelectValue placeholder="Select a connection" />
                  </SelectTrigger>
                  <SelectContent>
                    {connections.map((connection) => (
                      <SelectItem key={connection.id} value={connection.id}>{connection.id}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            <div>
              <label className="block text-sm mb-1">Model (可选)</label>
              <Input
                value={form.model || ""}
                onChange={(e) => setForm({ ...form, model: e.target.value || undefined })}
                placeholder="留空使用客户端请求的模型名"
              />
              <p className="text-xs text-gray-500 mt-1">
                指定转发到此 backend 时使用的模型名称。留空则使用客户端请求的原始模型名。
              </p>
            </div>
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

          {/* TTFT Timeout Section */}
          <div className="border rounded-lg p-3 space-y-3 bg-gray-50">
            <h4 className="text-sm font-medium text-gray-700">TTFT 超时配置 (可选)</h4>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm mb-1">流式请求超时 (ms)</label>
                <Input
                  type="number"
                  min={0}
                  step={1000}
                  value={form.streamingTTFTTimeout || ""}
                  onChange={(e) => setForm({ ...form, streamingTTFTTimeout: e.target.value === "" ? 0 : Number(e.target.value) })}
                  placeholder="例如: 10000 (留空或填 0 表示不限制)"
                />
                <p className="text-xs text-gray-500 mt-1">
                  流式请求第一个 token 到达的超时时间（毫秒），留空表示不限制
                </p>
              </div>
              <div>
                <label className="block text-sm mb-1">非流式请求超时 (ms)</label>
                <Input
                  type="number"
                  min={0}
                  step={1000}
                  value={form.nonStreamingTTFTTimeout || ""}
                  onChange={(e) => setForm({ ...form, nonStreamingTTFTTimeout: e.target.value === "" ? 0 : Number(e.target.value) })}
                  placeholder="例如: 60000 (留空或填 0 表示不限制)"
                />
                <p className="text-xs text-gray-500 mt-1">
                  非流式请求完整响应的超时时间（毫秒），留空表示不限制
                </p>
              </div>
            </div>
          </div>

          {/* Request and Response Recording Section */}
          <div className="border rounded-lg p-3 space-y-3 bg-gray-50">
            <h4 className="text-sm font-medium text-gray-700">请求与响应记录 (可选)</h4>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center justify-between gap-2">
                <label className="text-sm" htmlFor="record-requests-add">
                  记录所有请求
                </label>
                <Switch
                  id="record-requests-add"
                  size="md"
                  checked={form.recordRequests || false}
                  onCheckedChange={(v) => setForm({ ...form, recordRequests: v })}
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <label className="text-sm" htmlFor="record-responses-add">
                  记录所有响应
                </label>
                <Switch
                  id="record-responses-add"
                  size="md"
                  checked={form.recordResponses || false}
                  disabled={!form.recordRequests}
                  onCheckedChange={(v) => setForm({ ...form, recordResponses: v })}
                />
              </div>
            </div>
            <p className="text-xs text-gray-500">
              启用后将记录所有发往此 backend 的请求（URL、Headers、Body）。响应记录需要先启用请求记录，每条响应体最多保留 10 MiB。
            </p>
          </div>

          {/* Concurrency Limit Section */}
          <div className="border rounded-lg p-3 space-y-3 bg-gray-50">
            <h4 className="text-sm font-medium text-gray-700">并发限制 (可选)</h4>
            <div>
              <label className="block text-sm mb-1">最大并发请求数</label>
              <Input
                type="number"
                min={0}
                step={1}
                value={form.maxConcurrentRequests ?? 0}
                onChange={(e) => setForm({ ...form, maxConcurrentRequests: e.target.value === "" ? 0 : Number(e.target.value) })}
                placeholder="0"
              />
              <p className="text-xs text-gray-500 mt-1">
                限制该 backend 同时处理的最大请求数。0 表示不限制，大于 0 表示具体限制。
              </p>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitState.loading || !connections.some(connection => connection.id === form.connectionId)}>
              {submitState.loading ? "Adding..." : "Add"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
