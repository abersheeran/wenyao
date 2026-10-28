import * as React from "react";
import useAsyncFn from 'react-use/lib/useAsyncFn';
import { Button } from "../../ui/button";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "../../ui/table";
import { useAdminApi, type Connection, type ModelConfig } from "~/apis";
import { getProviderBadgeClass, getConnectionConfigDisplay, getProviderDisplayName } from "../../../config/provider-config";
import { DeleteConfirmationDialog } from "../backends/delete-confirmation-dialog";
import { ConnectionDialog } from "./connection-dialog";

export function ConnectionsPanel({ api }: { api: ReturnType<typeof useAdminApi> }) {
  const [connections, setConnections] = React.useState<Connection[]>([]);
  const [models, setModels] = React.useState<ModelConfig[]>([]);
  const [addConnectionOpen, setAddConnectionOpen] = React.useState(false);
  const [editingConnection, setEditingConnection] = React.useState<Connection | null>(null);
  const [deletingConnection, setDeletingConnection] = React.useState<Connection | null>(null);
  const [deleteError, setDeleteError] = React.useState<string>();

  const [listState, load] = useAsyncFn(async () => {
    const [connectionsData, modelsData] = await Promise.all([api.listConnections(), api.listModels()]);
    setConnections(connectionsData);
    setModels(modelsData);
  }, [api]);

  const [deleteState, deleteConnection] = useAsyncFn(async (id: string) => {
    setDeleteError(undefined);
    try {
      await api.deleteConnection(id);
      setDeletingConnection(null);
      await load();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Failed to delete connection');
    }
  }, [api, load]);

  React.useEffect(() => {
    load();
  }, []);

  const references = new Map<string, string[]>();
  for (const model of models) {
    for (const backend of model.backends) {
      if (!backend.connectionId) continue;
      const items = references.get(backend.connectionId) ?? [];
      items.push(`${model.model}/${backend.id}`);
      references.set(backend.connectionId, items);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Connections</h2>
        <Button onClick={() => setAddConnectionOpen(true)}>Add Connection</Button>
      </div>
      {listState.error && <p className="text-sm text-red-600" role="alert">{listState.error.message}</p>}
      {listState.loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : connections.length === 0 ? (
        <p className="text-sm text-gray-500">No connections configured.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name / ID</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>URL / Region</TableHead>
              <TableHead>References</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {connections.map((connection) => (
              <TableRow key={connection.id}>
                <TableCell className="text-sm">
                  <div>{connection.name || connection.id}</div>
                  {connection.name && <div className="font-mono text-xs text-gray-500">{connection.id}</div>}
                </TableCell>
                <TableCell>
                  <span className={`px-2 py-0.5 rounded text-xs whitespace-nowrap ${getProviderBadgeClass(connection.provider)}`}>
                    {getProviderDisplayName(connection.provider)}
                  </span>
                </TableCell>
                <TableCell className="text-sm">
                  {getConnectionConfigDisplay(connection)}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {(references.get(connection.id) ?? []).map((reference) => (
                      <span key={reference} className="px-2 py-0.5 bg-blue-100 text-blue-800 rounded text-xs">{reference}</span>
                    ))}
                    {!references.has(connection.id) && <span className="text-sm text-gray-500">None</span>}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="inline-flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setEditingConnection(connection)}>Edit</Button>
                    <Button variant="destructive" size="sm" onClick={() => {
                      setDeleteError(undefined);
                      setDeletingConnection(connection);
                    }}>Delete</Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {addConnectionOpen && (
        <ConnectionDialog open onOpenChange={setAddConnectionOpen} onSaved={load} />
      )}
      {editingConnection && (
        <ConnectionDialog
          key={editingConnection.id}
          open
          connection={editingConnection}
          onOpenChange={(value) => !value && setEditingConnection(null)}
          onSaved={load}
        />
      )}
      <DeleteConfirmationDialog
        open={!!deletingConnection}
        onOpenChange={(value) => !value && setDeletingConnection(null)}
        title="Delete Connection"
        description={`This will permanently delete the connection "${deletingConnection?.id}".`}
        expectedInput={deletingConnection?.id ?? ''}
        onConfirm={() => deletingConnection && deleteConnection(deletingConnection.id)}
        isDeleting={deleteState.loading}
        error={deleteError}
      />
    </div>
  );
}
