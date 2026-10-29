import * as React from "react";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../../ui/chart";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis, Line, LineChart } from "recharts";
import type { HistoricalStatsData } from "~/apis";
import { Button } from "../../ui/button";
import type { StatsRangeConfig } from "./time-ranges";

// Generate a distinct color palette for any number of backends
const generateColor = (index: number, total: number): string => {
  // Use HSL color space for evenly distributed colors
  const hue = (index * 360) / Math.max(total, 1);
  const saturation = 70; // Vibrant colors
  const lightness = 50; // Medium brightness
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
};

export function HistoricalCharts({ historyData, startTime, endTime, range }: {
  historyData: HistoricalStatsData;
  startTime: Date;
  endTime: Date;
  range: StatsRangeConfig;
}) {
  const backends = React.useMemo(() => {
    const identities = Object.keys(historyData).sort().flatMap(model =>
      Object.keys(historyData[model]).sort().map(backendId => ({ model, backendId }))
    );
    return identities.map(({ model, backendId }, index) => ({
      model,
      backendId,
      // Tuple serialization is unambiguous even when either name contains a slash.
      identity: JSON.stringify([model, backendId]),
      // Recharts paths and chart CSS variables must never contain user-provided names.
      key: `s${index}`,
      label: `${model}/${backendId}`,
      color: generateColor(index, identities.length),
    }));
  }, [historyData]);

  // Store exclusions so new backends start selected and refreshes retain user choices.
  const [hiddenBackends, setHiddenBackends] = React.useState<Set<string>>(new Set());
  const visibleBackends = backends.filter(backend => !hiddenBackends.has(backend.identity));
  const allSelected = visibleBackends.length === backends.length;

  const toggleBackend = (identity: string) => {
    setHiddenBackends(prev => {
      const next = new Set(prev);
      if (next.has(identity)) next.delete(identity);
      else next.add(identity);
      return next;
    });
  };

  const toggleAll = () => {
    setHiddenBackends(allSelected ? new Set(backends.map(b => b.identity)) : new Set());
  };

  // Include every epoch-aligned bucket, including idle periods for each backend.
  const mergedData = React.useMemo(() => {
    const intervalMs = range.intervalMinutes * 60_000;
    const firstBucket = Math.floor(startTime.getTime() / intervalMs) * intervalMs;
    const lastBucket = Math.floor(endTime.getTime() / intervalMs) * intervalMs;
    const timeMap = new Map<number, Record<string, number | string | null>>();
    for (let time = firstBucket; time <= lastBucket; time += intervalMs) {
      const entry: Record<string, number | string | null> = {
        time,
        timestamp: new Date(time).toISOString(),
      };
      backends.forEach(({ key }) => {
        entry[`successRate_${key}`] = null;
        entry[`streamingTtft_${key}`] = null;
        entry[`nonStreamingTtft_${key}`] = null;
        entry[`requests_${key}`] = 0;
      });
      timeMap.set(time, entry);
    }
    backends.forEach(({ model, backendId, key }) => {
      historyData[model][backendId].forEach(point => {
        const time = new Date(point.timestamp).getTime();
        const entry = timeMap.get(time);
        if (!entry) return;
        entry[`successRate_${key}`] = point.successRate * 100;
        entry[`streamingTtft_${key}`] = point.averageStreamingTTFT || null;
        entry[`nonStreamingTtft_${key}`] = point.averageNonStreamingTTFT || null;
        entry[`requests_${key}`] = point.requestsInPeriod;
      });
    });
    return [...timeMap.values()];
  }, [backends, historyData, startTime, endTime, range]);

  const formatTime = (timestamp: string | Date, includeDate = range.tickFormat === "dateTime") => {
    const date = new Date(timestamp);
    const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    if (!includeDate) return time;
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${month}-${day} ${time}`;
  };

  const formatTooltipLabel = (timestamp: string | Date) => {
    const start = new Date(timestamp);
    const label = formatTime(start, true);
    if (range.intervalMinutes === 1) return label;
    const end = new Date(start.getTime() + range.intervalMinutes * 60_000);
    return `${label}–${formatTime(end, start.toDateString() !== end.toDateString())}`;
  };

  const chartConfig = React.useMemo(() => {
    const config: Record<string, { label: string; color: string }> = {};
    backends.forEach(({ key, label, color }) => {
      config[`successRate_${key}`] = { label, color };
      config[`streamingTtft_${key}`] = { label: `${label} (流式)`, color };
      config[`nonStreamingTtft_${key}`] = { label: `${label} (非流式)`, color };
      config[`requests_${key}`] = { label, color };
    });
    return config;
  }, [backends]);

  return (
    <>
      {/* Backend Filter */}
      <div className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-medium">Backend 筛选器</h4>
          <Button
            variant="outline"
            size="sm"
            onClick={toggleAll}
          >
            {allSelected ? '取消全选' : '全选'}
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {backends.map(({ identity, label, color }) => (
            <button
              key={identity}
              onClick={() => toggleBackend(identity)}
              aria-pressed={!hiddenBackends.has(identity)}
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                !hiddenBackends.has(identity)
                  ? 'bg-white border-2 shadow-sm'
                  : 'bg-gray-200 border-2 border-transparent opacity-50'
              }`}
              style={{
                borderColor: !hiddenBackends.has(identity) ? color : 'transparent',
              }}
            >
              <span
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: color }}
              />
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Success Rate Chart */}
      <div>
        <div className="mb-4">
          <h3 className="text-base font-medium mb-1">成功率趋势</h3>
          <p className="text-sm text-muted-foreground">各 Backend 在{range.granularityLabel}内的请求成功率 (%)</p>
        </div>
        <ChartContainer config={chartConfig} className="h-[300px] w-full">
          <LineChart
            accessibilityLayer
            data={mergedData}
            margin={{
              left: 12,
              right: 12,
              top: 12,
            }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="timestamp"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(timestamp) => formatTime(timestamp)}
            />
            <YAxis
              domain={[0, 100]}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(value) => `${value}%`}
            />
            <ChartTooltip
              cursor={false}
              content={<ChartTooltipContent indicator="dot" labelFormatter={formatTooltipLabel} />}
            />
            {visibleBackends.map(({ key, identity, color }) => {
              return (
                <Line
                  key={identity}
                  dataKey={`successRate_${key}`}
                  type="monotone"
                  stroke={color}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              );
            })}
          </LineChart>
        </ChartContainer>
      </div>

      {/* Streaming TTFT Chart */}
      <div>
        <div className="mb-4">
          <h3 className="text-base font-medium mb-1">流式 TTFT 趋势</h3>
          <p className="text-sm text-muted-foreground">各 Backend 在{range.granularityLabel}内的流式请求平均首 Token 响应时间 (毫秒)</p>
        </div>
        <ChartContainer config={chartConfig} className="h-[300px] w-full">
          <LineChart
            accessibilityLayer
            data={mergedData}
            margin={{
              left: 12,
              right: 12,
              top: 12,
            }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="timestamp"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(timestamp) => formatTime(timestamp)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(value) => `${value}ms`}
            />
            <ChartTooltip
              cursor={false}
              content={<ChartTooltipContent indicator="dot" labelFormatter={formatTooltipLabel} />}
            />
            {visibleBackends.map(({ key, identity, color }) => {
              return (
                <Line
                  key={identity}
                  dataKey={`streamingTtft_${key}`}
                  type="monotone"
                  stroke={color}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              );
            })}
          </LineChart>
        </ChartContainer>
      </div>

      {/* Non-Streaming TTFT Chart */}
      <div>
        <div className="mb-4">
          <h3 className="text-base font-medium mb-1">非流式 TTFT 趋势</h3>
          <p className="text-sm text-muted-foreground">各 Backend 在{range.granularityLabel}内的非流式请求平均首 Token 响应时间 (毫秒)</p>
        </div>
        <ChartContainer config={chartConfig} className="h-[300px] w-full">
          <LineChart
            accessibilityLayer
            data={mergedData}
            margin={{
              left: 12,
              right: 12,
              top: 12,
            }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="timestamp"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(timestamp) => formatTime(timestamp)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(value) => `${value}ms`}
            />
            <ChartTooltip
              cursor={false}
              content={<ChartTooltipContent indicator="dot" labelFormatter={formatTooltipLabel} />}
            />
            {visibleBackends.map(({ key, identity, color }) => {
              return (
                <Line
                  key={identity}
                  dataKey={`nonStreamingTtft_${key}`}
                  type="monotone"
                  stroke={color}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              );
            })}
          </LineChart>
        </ChartContainer>
      </div>

      {/* Total Requests Chart */}
      <div>
        <div className="mb-4">
          <h3 className="text-base font-medium mb-1">请求量趋势</h3>
          <p className="text-sm text-muted-foreground">各 Backend 在{range.granularityLabel}内处理的请求数量</p>
        </div>
        <ChartContainer config={chartConfig} className="h-[300px] w-full">
          <AreaChart
            accessibilityLayer
            data={mergedData}
            margin={{
              left: 12,
              right: 12,
              top: 12,
            }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="timestamp"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(timestamp) => formatTime(timestamp)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
            />
            <ChartTooltip
              cursor={false}
              content={<ChartTooltipContent indicator="dot" labelFormatter={formatTooltipLabel} />}
            />
            {visibleBackends.map(({ key, identity, color }) => {
              return (
                <Area
                  key={identity}
                  dataKey={`requests_${key}`}
                  type="linear"
                  fill={color}
                  fillOpacity={0.25}
                  stroke={color}
                  strokeWidth={2}
                  stackId="a"
                />
              );
            })}
          </AreaChart>
        </ChartContainer>
      </div>
    </>
  );
}
