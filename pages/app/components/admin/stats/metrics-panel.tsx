import * as React from "react";
import useAsyncFn from 'react-use/lib/useAsyncFn';
import { Button } from "../../ui/button";
import { useAdminApi } from "~/apis";

export function MetricsPanel({ api }: { api: ReturnType<typeof useAdminApi> }) {
  const [text, setText] = React.useState<string>("");
  const [isDisabled, setIsDisabled] = React.useState<boolean>(false);
  const [loadState, load] = useAsyncFn(async () => {
    try {
      const data = await api.getPrometheusMetrics();
      setText(data);
      setIsDisabled(false);
      return data;
    } catch (error: any) {
      // Handle metrics disabled (503) gracefully
      if (error.message?.includes('503') || error.message?.includes('disabled')) {
        setText('');
        setIsDisabled(true);
        throw new Error('Metrics collection is disabled. Enable with ENABLE_METRICS=true');
      }
      throw error;
    }
  }, [api]);

  React.useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Prometheus Metrics</h2>
        <Button variant="outline" onClick={load} disabled={loadState.loading || isDisabled}>
          Refresh
        </Button>
      </div>
      {loadState.error && <p className="text-sm text-red-600 mb-2">{loadState.error.message}</p>}
      {isDisabled ? (
        <div className="text-sm text-gray-500 p-4 bg-yellow-50 border border-yellow-200 rounded">
          <p className="font-medium mb-2">Metrics Collection Disabled</p>
          <p>To enable metrics, set <code className="bg-gray-100 px-1 py-0.5 rounded">ENABLE_METRICS=true</code> in your server configuration and restart.</p>
        </div>
      ) : loadState.loading ? (
        <p className="text-sm text-gray-500">Loading...</p>
      ) : text ? (
        <pre className="text-xs whitespace-pre-wrap bg-gray-50 p-3 rounded border border-gray-200 overflow-auto max-h-[60vh]">{text}</pre>
      ) : (
        <p className="text-sm text-gray-500">No metrics available</p>
      )}
    </div>
  );
}
