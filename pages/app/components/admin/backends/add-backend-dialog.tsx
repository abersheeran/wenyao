import * as React from "react";
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
import { useAdminApi, type BackendConfig } from "~/apis";

export function AddBackendDialog({ open, onOpenChange, model, onAdded }: {
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
    enabled: true,
    model: undefined,
    streamingTTFTTimeout: 0,
    nonStreamingTTFTTimeout: 0,
    recordRequests: false,
    maxConcurrentRequests: 0
  });

  const [submitState, submit] = useAsyncFn(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!model) return;
    await api.addBackend(model, form);
    setForm({ id: "", url: "", apiKey: "", weight: 1, enabled: true, model: undefined, streamingTTFTTimeout: 0, nonStreamingTTFTTimeout: 0, recordRequests: false, maxConcurrentRequests: 0 });
    onOpenChange(false);
    onAdded();
  }, [api, model, form, onOpenChange, onAdded]);

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
            <h4 className="text-sm font-medium text-gray-700">Backend 配置</h4>
            <div>
              <label className="block text-sm mb-1">URL</label>
              <Input required value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://api.example.com" />
            </div>
            <div>
              <label className="block text-sm mb-1">API Key</label>
              <Input required value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} placeholder="sk-..." />
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

          {/* Request Recording Section */}
          <div className="border rounded-lg p-3 space-y-3 bg-gray-50">
            <h4 className="text-sm font-medium text-gray-700">请求记录 (可选)</h4>
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <label className="block text-sm mb-1" htmlFor="record-requests-add">
                  记录所有请求
                </label>
                <p className="text-xs text-gray-500">
                  启用后将记录所有发往此 backend 的请求（URL、Headers、Body）。响应不会被记录。
                </p>
              </div>
              <Switch
                id="record-requests-add"
                size="md"
                checked={form.recordRequests || false}
                onCheckedChange={(v) => setForm({ ...form, recordRequests: v })}
              />
            </div>
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
            <Button type="submit" disabled={submitState.loading}>
              {submitState.loading ? "Adding..." : "Add"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
