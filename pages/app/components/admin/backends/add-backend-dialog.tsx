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
    model: undefined
  });

  const [submitState, submit] = useAsyncFn(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!model) return;
    await api.addBackend(model, form);
    setForm({ id: "", url: "", apiKey: "", weight: 1, enabled: true, model: undefined });
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
