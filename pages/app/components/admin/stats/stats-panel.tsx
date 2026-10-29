import * as React from "react";
import useAsyncFn from 'react-use/lib/useAsyncFn';
import { Button } from "../../ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select";
import { Switch } from "../../ui/switch";
import { Spinner } from "../../ui/spinner";
import { useAdminApi, type HistoricalStatsData } from "~/apis";
import { HistoricalCharts } from "./historical-charts";
import { TIME_RANGES, type StatsRangeConfig, type StatsTimeRange } from "./time-ranges";

export function StatsPanel({ api }: { api: ReturnType<typeof useAdminApi> }) {
  const [loadedHistory, setLoadedHistory] = React.useState<{
    historyData: HistoricalStatsData;
    startTime: Date;
    endTime: Date;
    range: StatsRangeConfig;
  } | null>(null);
  const [timeRange, setTimeRange] = React.useState<StatsTimeRange>("1h");
  const latestLoad = React.useRef(0);
  const [autoRefresh, setAutoRefresh] = React.useState<boolean>(false);

  const [historyState, loadHistory] = useAsyncFn(async () => {
    const loadId = ++latestLoad.current;
    const range = TIME_RANGES[timeRange];
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - range.durationMs);

    try {
      const data = await api.getAllHistoricalStats(startTime, endTime, range.intervalMinutes);
      if (loadId === latestLoad.current) {
        setLoadedHistory({ historyData: data, startTime, endTime, range });
      }
      return data;
    } catch (error: any) {
      // Handle metrics disabled (503) gracefully
      if (error.message?.includes('503') || error.message?.includes('disabled')) {
        if (loadId === latestLoad.current) setLoadedHistory(null);
        throw new Error('指标收集已禁用。请在服务器配置中启用 ENABLE_METRICS=true');
      }
      throw error;
    }
  }, [api, timeRange]);

  React.useEffect(() => {
    loadHistory();

    // Auto refresh every 30 seconds if enabled
    if (autoRefresh) {
      const interval = setInterval(() => {
        loadHistory();
      }, 30000);

      return () => clearInterval(interval);
    }
  }, [timeRange, autoRefresh]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">历史趋势</h2>
          <p className="text-sm text-muted-foreground mt-1">
            数据按模型与 Backend {loadedHistory?.range.granularityLabel ?? TIME_RANGES[timeRange].granularityLabel}聚合，以 model/backendId 标识
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={timeRange} onValueChange={(v) => setTimeRange(v as StatsTimeRange)}>
            <SelectTrigger className="text-sm w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(TIME_RANGES).map(([value, range]) => (
                <SelectItem key={value} value={value}>{range.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={loadHistory} disabled={historyState.loading}>
            {historyState.loading ? <Spinner /> : <></> }
            刷新
          </Button>
          <div className="flex items-center gap-2 ml-1">
            <Switch
              checked={autoRefresh}
              onCheckedChange={setAutoRefresh}
            />
            <span className="text-xs text-muted-foreground">
              自动刷新
            </span>
          </div>
        </div>
      </div>
      {historyState.error && (
        <p className="text-sm text-red-600 mb-2">{historyState.error.message}</p>
      )}
      {!loadedHistory || Object.keys(loadedHistory.historyData).length === 0 ? (
        historyState.loading ? (
          <p className="text-sm text-gray-500">加载中...</p>
        ) : (
          <p className="text-sm text-gray-500">暂无历史数据</p>
        )
      ) : (
        <div className="space-y-8">
          <HistoricalCharts {...loadedHistory} />
        </div>
      )}
    </div>
  );
}
