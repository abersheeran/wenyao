import * as React from "react";
import { Link, useSearchParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import { arrayMove } from "@dnd-kit/sortable";
import useAsyncFn from 'react-use/lib/useAsyncFn';
import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import { useAdminApi, type BackendConfig, type ModelConfig, type Connection } from "~/apis";
import { AddModelDialog } from "./add-model-dialog";
import { EditModelDialog } from "./edit-model-dialog";
import { AddBackendDialog } from "./add-backend-dialog";
import { EditBackendDialog } from "./edit-backend-dialog";
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog";
import { ModelList } from "./model-list";
import { ModelDetails, type ListedModel } from "./model-details";

export function BackendsPanel({ api }: { api: ReturnType<typeof useAdminApi> }) {
  const [models, setModels] = React.useState<ListedModel[]>([]);
  const [connections, setConnections] = React.useState<Connection[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = React.useState("");
  const [addModelOpen, setAddModelOpen] = React.useState(false);
  const [editingModel, setEditingModel] = React.useState<ModelConfig | null>(null);
  const [addingBackendFor, setAddingBackendFor] = React.useState<string | null>(null);
  const [editingBackend, setEditingBackend] = React.useState<{ model: string; backend: BackendConfig } | null>(null);
  const [deletingModel, setDeletingModel] = React.useState<string | null>(null);
  const [deletingBackend, setDeletingBackend] = React.useState<{ model: string; backendId: string } | null>(null);

  const sortedModels = React.useMemo(
    () => [...models].sort((a, b) => a.model.localeCompare(b.model)),
    [models]
  );
  // Searching only filters the list; details always resolve against all models.
  const selectedModel = sortedModels.find(model => model.model === searchParams.get("model")) ?? sortedModels[0];
  const hasModelParam = searchParams.has("model");
  const listParams = new URLSearchParams(searchParams);
  listParams.delete("model");
  const dialogOpen = addModelOpen || editingModel !== null || addingBackendFor !== null ||
    editingBackend !== null || deletingModel !== null || deletingBackend !== null;

  const [listState, load] = useAsyncFn(async () => {
    try {
      const [data, connectionsData] = await Promise.all([api.listModels(), api.listConnections()]);
      setModels(data);
      setConnections(connectionsData);
      return data;
    } catch (error: unknown) {
      if (error instanceof Error && (error.message.includes('Unauthorized') || error.message.includes('401'))) {
        localStorage.removeItem('adminApiKey');
        window.location.reload();
      }
      throw error;
    }
  }, [api], { loading: true });

  const [deleteModelState, deleteModel] = useAsyncFn(
    async (model: string) => {
      await api.deleteModel(model);
      if (selectedModel?.model === model && hasModelParam) {
        setSearchParams(params => {
          const next = new URLSearchParams(params);
          next.delete("model");
          return next;
        });
      }
      setDeletingModel(null);
      await load();
    },
    [api, load, selectedModel?.model, hasModelParam, setSearchParams]
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

  const [updateRecordResponsesState, updateRecordResponses] = useAsyncFn(
    async (model: string, backendId: string, recordResponses: boolean) => {
      await api.updateBackend(model, backendId, { recordResponses });
      await load();
    },
    [api, load]
  );

  const [deleteBackendState, deleteBackend] = useAsyncFn(
    async (model: string, backendId: string) => {
      await api.deleteBackend(model, backendId);
      setDeletingBackend(null);
      await load();
    },
    [api, load]
  );

  const [reorderState, reorderBackends] = useAsyncFn(
    async (model: string, from: number, to: number) => {
      const current = models.find(item => item.model === model);
      if (!current) return;
      const backends = arrayMove(current.backends, from, to);
      setModels(items => items.map(item => item.model === model ? { ...item, backends } : item));
      try {
        await api.reorderBackends(model, backends.map(backend => backend.id));
      } finally {
        // Refresh after success or failure, including concurrent backend additions/deletions.
        await load();
      }
    },
    [api, load, models]
  );

  // The API object is recreated on render; only the initial load runs on mount.
  React.useEffect(() => {
    void load();
  }, []);

  const error = listState.error || deleteModelState.error || updateEnabledState.error ||
    updateRecordRequestsState.error || updateRecordResponsesState.error || deleteBackendState.error || reorderState.error;
  const addingBackendModel = models.find(model => model.model === addingBackendFor);
  const editingBackendModel = models.find(model => model.model === editingBackend?.model);

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Models & Backends</h2>
        <Button onClick={() => setAddModelOpen(true)}>Add Model</Button>
      </div>
      {error && <p className="text-sm text-red-600" role="alert">{error.message}</p>}
      {listState.loading && models.length === 0 ? (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-500" aria-live="polite">
          <Spinner />
          Loading models...
        </div>
      ) : models.length === 0 ? (
        !listState.error && (
          <div className="rounded-lg border p-8 text-center">
            <p className="mb-4 text-sm text-gray-500">No models configured.</p>
            <Button onClick={() => setAddModelOpen(true)}>Add Model</Button>
          </div>
        )
      ) : (
        <div className="flex min-w-0 items-start gap-6">
          <aside className={`${hasModelParam ? "hidden lg:flex" : "flex"} w-full min-w-0 flex-col lg:sticky lg:top-4 lg:h-[calc(100dvh-2rem)] lg:w-72 lg:shrink-0`}>
            <ModelList
              models={sortedModels}
              connections={connections}
              selectedModel={selectedModel.model}
              selectedIsFallback={!hasModelParam}
              query={query}
              onQueryChange={setQuery}
              dialogOpen={dialogOpen}
            />
          </aside>
          <div className={`${hasModelParam ? "block" : "hidden lg:block"} min-w-0 flex-1 space-y-3`}>
            <Link to={{ search: listParams.size ? `?${listParams}` : "" }} className="inline-flex items-center gap-2 text-sm text-gray-600 hover:text-gray-900 lg:hidden">
              <ArrowLeft className="size-4" aria-hidden="true" />
              Back to models
            </Link>
            <ModelDetails
              model={selectedModel}
              connections={connections}
              onEditModel={setEditingModel}
              onDeleteModel={setDeletingModel}
              onAddBackend={setAddingBackendFor}
              onEditBackend={(model, backend) => setEditingBackend({ model, backend })}
              onDeleteBackend={(model, backendId) => setDeletingBackend({ model, backendId })}
              onUpdateEnabled={updateEnabled}
              onUpdateRecordRequests={updateRecordRequests}
              onUpdateRecordResponses={updateRecordResponses}
              onReorderBackends={reorderBackends}
              reordering={reorderState.loading}
            />
          </div>
        </div>
      )}

      <AddModelDialog
        open={addModelOpen}
        onOpenChange={setAddModelOpen}
        onAdded={model => {
          setSearchParams(params => {
            const next = new URLSearchParams(params);
            next.set("model", model);
            return next;
          });
          void load();
        }}
      />
      <EditModelDialog
        open={editingModel !== null}
        model={editingModel}
        onOpenChange={open => !open && setEditingModel(null)}
        onSaved={() => {
          setEditingModel(null);
          void load();
        }}
      />
      <AddBackendDialog
        open={addingBackendFor !== null}
        model={addingBackendFor}
        connections={connections.filter(connection => connection.provider === addingBackendModel?.provider)}
        provider={addingBackendModel?.provider ?? null}
        onOpenChange={open => !open && setAddingBackendFor(null)}
        onAdded={() => {
          setAddingBackendFor(null);
          void load();
        }}
      />
      <EditBackendDialog
        open={editingBackend !== null}
        model={editingBackend?.model ?? null}
        backend={editingBackend?.backend ?? null}
        connections={connections.filter(connection => connection.provider === editingBackendModel?.provider)}
        onOpenChange={open => !open && setEditingBackend(null)}
        onSaved={() => {
          setEditingBackend(null);
          void load();
        }}
      />
      <DeleteConfirmationDialog
        open={deletingModel !== null}
        onOpenChange={open => !open && setDeletingModel(null)}
        title="Delete Model"
        description={`This will permanently delete the model "${deletingModel}" and all its backends. This action cannot be undone.`}
        expectedInput={deletingModel ?? ""}
        onConfirm={() => {
          if (deletingModel !== null) void deleteModel(deletingModel);
        }}
        isDeleting={deleteModelState.loading}
        error={deleteModelState.error?.message}
      />
      <DeleteConfirmationDialog
        open={deletingBackend !== null}
        onOpenChange={open => !open && setDeletingBackend(null)}
        title="Delete Backend"
        description="This will permanently delete the backend. This action cannot be undone."
        expectedInput={deletingBackend ? `${deletingBackend.model}/${deletingBackend.backendId}` : ""}
        onConfirm={() => {
          if (deletingBackend !== null) void deleteBackend(deletingBackend.model, deletingBackend.backendId);
        }}
        isDeleting={deleteBackendState.loading}
        error={deleteBackendState.error?.message}
      />
    </div>
  );
}
