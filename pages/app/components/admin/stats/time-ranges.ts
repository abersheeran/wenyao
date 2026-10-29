export const TIME_RANGES = {
  "1h": {
    label: "过去 1 小时",
    durationMs: 60 * 60 * 1000,
    intervalMinutes: 1,
    granularityLabel: "每分钟",
    tickFormat: "time",
  },
  "6h": {
    label: "过去 6 小时",
    durationMs: 6 * 60 * 60 * 1000,
    intervalMinutes: 5,
    granularityLabel: "每 5 分钟",
    tickFormat: "time",
  },
  "24h": {
    label: "过去 24 小时",
    durationMs: 24 * 60 * 60 * 1000,
    intervalMinutes: 15,
    granularityLabel: "每 15 分钟",
    tickFormat: "time",
  },
  "7d": {
    label: "过去 7 天",
    durationMs: 7 * 24 * 60 * 60 * 1000,
    intervalMinutes: 60,
    granularityLabel: "每小时",
    tickFormat: "dateTime",
  },
} as const;

export type StatsTimeRange = keyof typeof TIME_RANGES;
export type StatsRangeConfig = (typeof TIME_RANGES)[StatsTimeRange];
