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
import { useAdminApi } from "~/apis";

export function AddApiKeyDialog({
  open,
  onOpenChange,
  availableModels,
  onAdded
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  availableModels: string[];
  onAdded: () => void;
}) {
  const api = useAdminApi();
  const [form, setForm] = React.useState<{ key: string; description: string; models: string[] }>({
    key: "",
    description: "",
    models: []
  });

  const generateRandomKey = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const length = 32;
    let result = 'sk-';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    setForm({ ...form, key: result });
  };

  const toggleModel = (model: string) => {
    const newModels = form.models.includes(model)
      ? form.models.filter(m => m !== model)
      : [...form.models, model];
    setForm({ ...form, models: newModels });
  };

  const [submitState, submit] = useAsyncFn(async (e: React.FormEvent) => {
    e.preventDefault();
    await api.createApiKey(form);
    setForm({ key: "", description: "", models: [] });
    onOpenChange(false);
    onAdded();
  }, [api, form, onOpenChange, onAdded]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add API Key</DialogTitle>
        </DialogHeader>
        <form className="space-y-3" onSubmit={submit}>
          {submitState.error && <p className="text-sm text-red-600">{submitState.error.message}</p>}
          <div>
            <label className="block text-sm mb-1">API Key</label>
            <div className="flex gap-2">
              <Input
                required
                value={form.key}
                onChange={(e) => setForm({ ...form, key: e.target.value })}
                placeholder="sk-..."
                className="font-mono text-sm"
              />
              <Button type="button" variant="outline" onClick={generateRandomKey}>
                Generate
              </Button>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              Generate a random key or enter your own
            </p>
          </div>
          <div>
            <label className="block text-sm mb-1">Description</label>
            <Input
              required
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="e.g., Production API Key"
            />
          </div>
          <div>
            <label className="block text-sm mb-2">Allowed Models</label>
            {availableModels.length === 0 ? (
              <p className="text-sm text-gray-500">No models available. Please add models first.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {availableModels.map((model) => (
                  <button
                    key={model}
                    type="button"
                    onClick={() => toggleModel(model)}
                    className={`px-3 py-1.5 rounded border text-sm transition-colors ${form.models.includes(model)
                        ? 'bg-blue-100 border-blue-300 text-blue-800'
                        : 'bg-gray-50 border-gray-300 text-gray-700 hover:bg-gray-100'
                      }`}
                  >
                    {model}
                  </button>
                ))}
              </div>
            )}
            <p className="text-xs text-gray-500 mt-2">
              Select at least one model that this API key can access
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitState.loading || form.models.length === 0}>
              {submitState.loading ? "Creating..." : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
