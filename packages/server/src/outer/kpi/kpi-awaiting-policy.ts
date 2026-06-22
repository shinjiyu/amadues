/**
 * AWAITING 超时策略 — ADL KPI-MANAGER-LAYER.md §3.1 R5
 */
export interface StaleAwaitingPolicy {
  /** AWAITING 超时硬上限（默认 7d） */
  maxAwaitingMs: number;
  /** 无进展信号触发复审（默认 3d） */
  requireProgressSignalAfterMs: number;
}

export const DEFAULT_STALE_AWAITING_POLICY: StaleAwaitingPolicy = {
  maxAwaitingMs: 7 * 24 * 60 * 60 * 1000,
  requireProgressSignalAfterMs: 3 * 24 * 60 * 60 * 1000,
};
