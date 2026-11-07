export type WebVitalMetric = "lcp" | "cls" | "inp" | "fcp" | "ttfb";
export type PercentileLevel = "p50" | "p75" | "p90" | "p99";

export interface PerformanceOverviewMetrics {
  lcp: number;
  fcp: number;
  cls: number;
  inp: number;
  ttfb: number;
}

export interface PerformanceTimeSeriesPoint {
  time: string;
  p50: number;
  p75: number;
  p90: number;
  p99: number;
}

export interface PerformanceByPathItem {
  path: string;
  page_title: string;
  sample_count: number;
  p50: number;
  p75: number;
  p90: number;
  p99: number;
}

export interface PerformanceByDimensionItem {
  dimension: string;
  page_count: number;
  p50: number;
  p75: number;
  p90: number;
  p99: number;
}