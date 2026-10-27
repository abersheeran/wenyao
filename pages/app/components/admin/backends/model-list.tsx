import * as React from "react";
import { Link, useSearchParams } from "react-router";
import { Search, TriangleAlert } from "lucide-react";
import type { Connection, ModelConfig } from "~/apis";
import {
  getProviderBadgeClass,
  getProviderDisplayName,
} from "../../../config/provider-config";
import Input from "../../ui/input";

interface ModelListProps {
  models: ModelConfig[];
  connections: Connection[];
  selectedModel: string;
  // The fallback selection is only shown beside the details pane on wide screens.
  selectedIsFallback: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  dialogOpen: boolean;
}

export function ModelList({
  models,
  connections,
  selectedModel,
  selectedIsFallback,
  query,
  onQueryChange,
  dialogOpen,
}: ModelListProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const searchRef = React.useRef<HTMLInputElement>(null);
  const itemRefs = React.useRef(new Map<string, HTMLAnchorElement>());
  const [highlightedIndex, setHighlightedIndex] = React.useState(0);
  const [searchFocused, setSearchFocused] = React.useState(false);
  const helpId = React.useId();
  const keyword = query.trim().toLowerCase();
  const connectionsById = React.useMemo(
    () => new Map(connections.map((connection) => [connection.id, connection])),
    [connections],
  );
  const visibleModels = React.useMemo(
    () => models.filter((model) => !keyword
      || model.model.toLowerCase().includes(keyword)
      || model.backends.some((backend) => {
        const connection = connectionsById.get(backend.connectionId);
        return backend.id.toLowerCase().includes(keyword)
          || backend.connectionId?.toLowerCase().includes(keyword)
          || connection?.name?.toLowerCase().includes(keyword);
      })),
    [models, connectionsById, keyword],
  );

  React.useEffect(() => {
    setHighlightedIndex(0);
  }, [query]);

  React.useEffect(() => {
    setHighlightedIndex((index) => Math.min(index, Math.max(visibleModels.length - 1, 0)));
  }, [visibleModels.length]);

  React.useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || event.isComposing || dialogOpen
        || document.querySelector('[role="dialog"][data-state="open"]')) {
        return;
      }
      const target = event.target;
      const activeElement = document.activeElement;
      if ((target instanceof Element && target.closest("input, textarea, select"))
        || (target instanceof HTMLElement && target.isContentEditable)
        || (activeElement instanceof HTMLElement && activeElement.isContentEditable)
        || !searchRef.current?.getClientRects().length) {
        return;
      }
      event.preventDefault();
      searchRef.current.focus();
    };
    document.addEventListener("keydown", focusSearch);
    return () => document.removeEventListener("keydown", focusSearch);
  }, [dialogOpen]);

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey
      || visibleModels.length === 0) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const nextIndex = Math.max(0, Math.min(
        visibleModels.length - 1,
        highlightedIndex + (event.key === "ArrowDown" ? 1 : -1),
      ));
      setHighlightedIndex(nextIndex);
      itemRefs.current.get(visibleModels[nextIndex].model)?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      const model = visibleModels[highlightedIndex] ?? visibleModels[0];
      setSearchParams((previous) => {
        const next = new URLSearchParams(previous);
        next.set("model", model.model);
        return next;
      });
    }
  };

  return (
    <nav aria-label="Models" className="flex h-full min-h-0 flex-col rounded-lg border bg-white">
      <div className="shrink-0 space-y-2 border-b p-3">
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
          <Input
            ref={searchRef}
            type="search"
            aria-label="Search models, backend IDs, or connections"
            aria-describedby={helpId}
            placeholder="Search models, backends..."
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={onSearchKeyDown}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            className="pl-9"
          />
        </div>
        <p className="text-xs text-gray-500" aria-live="polite">
          {visibleModels.length} / {models.length} models
        </p>
        <p id={helpId} className="text-xs text-gray-500">↑ ↓ 高亮 · Enter 选中 · / 搜索</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {visibleModels.length === 0 ? (
          <p className="px-2 py-4 text-sm text-gray-500">No models match "{query.trim()}".</p>
        ) : (
          <ul className="space-y-1">
            {visibleModels.map((model, index) => {
              const enabledCount = model.backends.filter((backend) => backend.enabled && backend.weight > 0).length;
              const warnings: string[] = [];
              if (enabledCount === 0) warnings.push("No available backend (enabled with weight > 0).");
              if (model.backends.some((backend) => !backend.connectionId)) {
                warnings.push("A backend has no connection configured.");
              }
              if (model.backends.some((backend) => backend.connectionId && !connectionsById.has(backend.connectionId))) {
                warnings.push("A backend references a connection that does not exist.");
              }
              const nextParams = new URLSearchParams(searchParams);
              nextParams.set("model", model.model);
              const selected = model.model === selectedModel;

              return (
                <li key={model.model}>
                  <Link
                    ref={(element) => {
                      if (element) itemRefs.current.set(model.model, element);
                      else itemRefs.current.delete(model.model);
                    }}
                    to={`?${nextParams.toString()}`}
                    aria-current={selected ? "page" : undefined}
                    className={`block rounded-md border px-3 py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/30 ${!selected ? "border-transparent hover:bg-gray-50" : selectedIsFallback ? "border-transparent hover:bg-gray-50 lg:border-blue-200 lg:bg-blue-50 lg:text-blue-950" : "border-blue-200 bg-blue-50 text-blue-950"} ${searchFocused && index === highlightedIndex ? "ring-1 ring-inset ring-gray-400" : ""}`}
                  >
                    <div className="flex items-start gap-2">
                      <span className="min-w-0 flex-1 break-all text-sm font-medium">{model.model}</span>
                      {warnings.length > 0 && (
                        <TriangleAlert
                          role="img"
                          aria-label={warnings.join(" ")}
                          className="mt-0.5 h-4 w-4 shrink-0 text-amber-600"
                        >
                          <title>{warnings.join(" ")}</title>
                        </TriangleAlert>
                      )}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                      <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${getProviderBadgeClass(model.provider)}`}>
                        {getProviderDisplayName(model.provider)}
                      </span>
                      <span className="text-xs text-gray-500" title="Enabled backends / All backends">
                        {enabledCount} / {model.backends.length} 已启用
                      </span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </nav>
  );
}
