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
import { getModelSections } from "../model-groups";
import { useAdminApi, type ApiKey, type ModelConfig } from "~/apis";

export function EditApiKeyDialog({
  open,
  onOpenChange,
  apiKey,
  availableModels,
  onSaved
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  apiKey: ApiKey | null;
  availableModels: ModelConfig[];
  onSaved: () => void;
}) {
  const api = useAdminApi();
  const hasGroups = availableModels.some(model => model.group !== "");
  const sections = hasGroups ? getModelSections(availableModels) : [{ group: "", models: availableModels }];
  const [form, setForm] = React.useState<{ description: string; models: string[] }>({
    description: "",
    models: []
  });

  React.useEffect(() => {
    if (apiKey) {
      setForm({
        description: apiKey.description,
        models: apiKey.models
      });
    }
  }, [apiKey]);

  const toggleModel = (model: string) => {
    const newModels = form.models.includes(model)
      ? form.models.filter(m => m !== model)
      : [...form.models, model];
    setForm({ ...form, models: newModels });
  };

  const [submitState, submit] = useAsyncFn(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey) return;
    await api.updateApiKey(apiKey.key, form);
    onSaved();
  }, [api, apiKey, form, onSaved]);

  if (!apiKey) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit API Key</DialogTitle>
        </DialogHeader>
        <form className="space-y-3" onSubmit={submit}>
          {submitState.error && <p className="text-sm text-red-600">{submitState.error.message}</p>}
          <div>
            <label className="block text-sm mb-1">API Key</label>
            <Input value={apiKey.key} disabled readOnly className="font-mono text-sm" />
            <p className="text-xs text-gray-500 mt-1">API key cannot be changed</p>
          </div>
          <div>
            <label className="block text-sm mb-1">Description</label>
            <Input
              required
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
          <div>
            <label className="block text-sm mb-2">Allowed Models</label>
            {availableModels.length === 0 ? (
              <p className="text-sm text-gray-500">No models available.</p>
            ) : (
              <div className="space-y-3">
                {sections.map(section => (
                  <section key={section.group}>
                    {hasGroups && <h4 className="break-all mb-2 text-xs font-semibold text-gray-500">{section.group || "Ungrouped"} ({section.models.length})</h4>}
                    <div className="flex flex-wrap gap-2">
                      {section.models.map(({ model }) => (
                        <button
                          key={model}
                          type="button"
                          aria-pressed={form.models.includes(model)}
                          onClick={() => toggleModel(model)}
                          className={`max-w-full break-all px-3 py-1.5 rounded border text-sm transition-colors ${form.models.includes(model)
                              ? 'bg-blue-100 border-blue-300 text-blue-800'
                              : 'bg-gray-50 border-gray-300 text-gray-700 hover:bg-gray-100'
                            }`}
                        >
                          {model}
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitState.loading || form.models.length === 0}>
              {submitState.loading ? "Saving..." : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
