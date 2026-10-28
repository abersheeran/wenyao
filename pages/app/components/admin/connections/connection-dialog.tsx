import * as React from "react";
import useAsyncFn from 'react-use/lib/useAsyncFn';
import { Button } from "../../ui/button";
import Input from "../../ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { useAdminApi, type Connection, type ProviderType, type OpenAIConfig, type BedrockConfig, type JevConfig } from "~/apis";
import { createDefaultProviderConfig, getProviderConfig, getProviderDisplayName } from "../../../config/provider-config";

function createInitialForm(provider: ProviderType): Connection {
  switch (provider) {
    case 'openai':
      return { id: '', name: '', provider, openaiConfig: createDefaultProviderConfig(provider) as OpenAIConfig };
    case 'bedrock':
      return { id: '', name: '', provider, bedrockConfig: createDefaultProviderConfig(provider) as BedrockConfig };
    case 'jev':
      return { id: '', name: '', provider, jevConfig: createDefaultProviderConfig(provider) as JevConfig };
  }
}

export function ConnectionDialog({ open, onOpenChange, connection, onSaved }: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  connection?: Connection;
  onSaved: () => void;
}) {
  const api = useAdminApi();
  const [form, setForm] = React.useState<Connection>(() => connection ?? createInitialForm('openai'));
  const httpConfig = 'openaiConfig' in form ? form.openaiConfig : 'jevConfig' in form ? form.jevConfig : undefined;

  const updateHttpConfig = (updates: Partial<OpenAIConfig>) => {
    if (form.provider === 'bedrock') return;
    const { configField } = getProviderConfig(form.provider);
    setForm({ ...form, [configField]: { ...httpConfig, ...updates } });
  };

  const [submitState, submit] = useAsyncFn(async (e: React.FormEvent) => {
    e.preventDefault();
    if (connection) {
      const { id, provider: _provider, ...updates } = form;
      await api.updateConnection(id, updates);
    } else {
      await api.createConnection(form);
    }
    onOpenChange(false);
    onSaved();
  }, [api, connection, form, onOpenChange, onSaved]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{connection ? 'Edit Connection' : 'Add Connection'}</DialogTitle>
          <DialogDescription>Shared upstream configuration for backends using this provider.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={submit}>
          {submitState.error && <p className="text-sm text-red-600" role="alert">{submitState.error.message}</p>}
          <div>
            <label htmlFor="connection-id" className="block text-sm mb-1">Connection ID</label>
            <Input
              id="connection-id"
              required
              pattern={"[A-Za-z0-9._\\-]+"}
              value={form.id}
              disabled={!!connection}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              className="font-mono text-sm"
            />
            <p className="text-xs text-gray-500 mt-1">
              {connection ? 'ID cannot be changed.' : 'Use letters, numbers, dots, underscores or hyphens.'}
            </p>
          </div>
          <div>
            <label htmlFor="connection-name" className="block text-sm mb-1">Name (optional)</label>
            <Input
              id="connection-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Defaults to connection ID"
            />
          </div>
          <div>
            <label htmlFor="connection-provider" className="block text-sm mb-1">Provider</label>
            <Select
              value={form.provider}
              disabled={!!connection}
              onValueChange={(value: ProviderType) => setForm({ ...createInitialForm(value), id: form.id, name: form.name })}
            >
              <SelectTrigger id="connection-provider" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">{getProviderDisplayName('openai')}</SelectItem>
                <SelectItem value="bedrock">{getProviderDisplayName('bedrock')}</SelectItem>
                <SelectItem value="jev">{getProviderDisplayName('jev')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {form.provider !== 'bedrock' ? (
            <>
              <div>
                <label htmlFor="connection-url" className="block text-sm mb-1">URL</label>
                <Input
                  id="connection-url"
                  required
                  type="url"
                  value={httpConfig?.url}
                  onChange={(e) => updateHttpConfig({ url: e.target.value })}
                  placeholder={form.provider === 'jev' ? 'https://api.typesafe.ai' : 'https://api.openai.com/v1'}
                />
              </div>
              <div>
                <label htmlFor="connection-api-key" className="block text-sm mb-1">API Key</label>
                <Input
                  id="connection-api-key"
                  required
                  type="password"
                  value={httpConfig?.apiKey}
                  onChange={(e) => updateHttpConfig({ apiKey: e.target.value })}
                  placeholder="sk-..."
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <label htmlFor="connection-region" className="block text-sm mb-1">AWS Region</label>
                <Input
                  id="connection-region"
                  required
                  value={form.bedrockConfig.region}
                  onChange={(e) => setForm({ ...form, bedrockConfig: { ...form.bedrockConfig, region: e.target.value } })}
                  placeholder="us-east-1"
                />
              </div>
              <div>
                <label htmlFor="connection-access-key" className="block text-sm mb-1">Access Key ID</label>
                <Input
                  id="connection-access-key"
                  required
                  value={form.bedrockConfig.accessKeyId}
                  onChange={(e) => setForm({ ...form, bedrockConfig: { ...form.bedrockConfig, accessKeyId: e.target.value } })}
                  placeholder="AKIAIOSFODNN7EXAMPLE"
                />
              </div>
              <div>
                <label htmlFor="connection-secret-key" className="block text-sm mb-1">Secret Access Key</label>
                <Input
                  id="connection-secret-key"
                  required
                  type="password"
                  value={form.bedrockConfig.secretAccessKey}
                  onChange={(e) => setForm({ ...form, bedrockConfig: { ...form.bedrockConfig, secretAccessKey: e.target.value } })}
                />
              </div>
            </>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={submitState.loading}>
              {submitState.loading ? 'Saving...' : connection ? 'Save' : 'Create'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
