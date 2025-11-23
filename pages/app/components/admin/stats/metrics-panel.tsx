import * as React from "react";
import useAsyncFn from 'react-use/lib/useAsyncFn';
import { Button } from "../../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card";
import { useAdminApi } from "~/apis";

export function MetricsPanel({ api }: { api: ReturnType<typeof useAdminApi> }) {
  const [text, setText] = React.useState<string>("");
  const [loadState, load] = useAsyncFn(async () => {
    const data = await api.getPrometheusMetrics();
    setText(data);
    return data;
  }, [api]);

  React.useEffect(() => {
    load();
  }, []);

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <CardTitle>Prometheus Metrics</CardTitle>
        <Button variant="outline" onClick={load} disabled={loadState.loading}>Refresh</Button>
      </CardHeader>
      <CardContent>
        {loadState.error && <p className="text-sm text-red-600 mb-2">{loadState.error.message}</p>}
        {loadState.loading ? (
          <p className="text-sm text-gray-500">Loading...</p>
        ) : (
          <pre className="text-xs whitespace-pre-wrap bg-gray-50 p-3 rounded border border-gray-200 overflow-auto max-h-[60vh]">{text}</pre>
        )}
      </CardContent>
    </Card>
  );
}
