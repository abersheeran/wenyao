import * as React from "react";
import useAsyncFn from 'react-use/lib/useAsyncFn';
import { Button } from "../../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "../../ui/table";
import { useAdminApi, type ApiKey } from "~/apis";
import { AddApiKeyDialog } from "./add-api-key-dialog";
import { EditApiKeyDialog } from "./edit-api-key-dialog";

export function ApiKeysPanel({ api }: { api: ReturnType<typeof useAdminApi> }) {
  const [apiKeys, setApiKeys] = React.useState<ApiKey[]>([]);
  const [models, setModels] = React.useState<string[]>([]);
  const [addApiKeyOpen, setAddApiKeyOpen] = React.useState(false);
  const [editingApiKey, setEditingApiKey] = React.useState<ApiKey | null>(null);

  const [listState, load] = useAsyncFn(async () => {
    try {
      const [keysData, modelsData] = await Promise.all([
        api.listApiKeys(),
        api.listModels()
      ]);
      setApiKeys(keysData);
      setModels(modelsData.map(m => m.model));
      return keysData;
    } catch (error: any) {
      if (error?.message?.includes('Unauthorized') || error?.message?.includes('401')) {
        localStorage.removeItem('adminApiKey');
        window.location.reload();
      }
      throw error;
    }
  }, [api]);

  const [deleteState, deleteApiKey] = useAsyncFn(
    async (key: string) => {
      await api.deleteApiKey(key);
      await load();
    },
    [api, load]
  );

  React.useEffect(() => {
    load();
  }, []);

  const formatDate = (date: string | Date | undefined) => {
    if (!date) return 'Never';
    return new Date(date).toLocaleString('zh-CN');
  };

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>API Keys</CardTitle>
        <Button onClick={() => setAddApiKeyOpen(true)}>Add API Key</Button>
      </CardHeader>
      <CardContent>
        {(listState.error || deleteState.error) && (
          <p className="text-sm text-red-600 mb-2">
            {(listState.error || deleteState.error)?.message}
          </p>
        )}
        {listState.loading ? (
          <p className="text-sm text-gray-500">Loading...</p>
        ) : apiKeys.length === 0 ? (
          <p className="text-sm text-gray-500">No API keys configured.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Models</TableHead>
                <TableHead>Created At</TableHead>
                <TableHead>Last Used</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apiKeys.map((apiKey) => (
                <TableRow key={apiKey.key}>
                  <TableCell className="font-mono text-xs">
                    {apiKey.key.substring(0, 20)}...
                  </TableCell>
                  <TableCell>{apiKey.description}</TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {apiKey.models.map((model) => (
                        <span
                          key={model}
                          className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded text-xs"
                        >
                          {model}
                        </span>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {formatDate(apiKey.createdAt)}
                  </TableCell>
                  <TableCell className="text-sm">
                    {formatDate(apiKey.lastUsedAt)}
                  </TableCell>
                  <TableCell className="space-x-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditingApiKey(apiKey)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => {
                        if (confirm(`Delete API key ${apiKey.key}?`)) {
                          deleteApiKey(apiKey.key);
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
      </CardContent>

      <AddApiKeyDialog
        open={addApiKeyOpen}
        onOpenChange={setAddApiKeyOpen}
        availableModels={models}
        onAdded={load}
      />
      <EditApiKeyDialog
        open={!!editingApiKey}
        apiKey={editingApiKey}
        availableModels={models}
        onOpenChange={(v) => !v && setEditingApiKey(null)}
        onSaved={() => {
          setEditingApiKey(null);
          load();
        }}
      />
    </Card>
  );
}
