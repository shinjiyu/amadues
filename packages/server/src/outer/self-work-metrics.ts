/**
 * SelfWorkPolicy 评估指标 — ADL DIGITAL-EMPLOYEE-AUTONOMY.md §4.2
 *
 * 事件由 digitalEmployeeLoop 的日志回调喂入，落 JSONL；
 * summarize 为纯函数，供 Ops / 策略 A-B 对比读取。
 */
import fs from 'node:fs';
import path from 'node:path';

export type SelfWorkMetricKind = 'accepted' | 'rejected' | 'slept' | 'dispatch_failed';

export interface SelfWorkMetricEvent {
  at: string;
  kind: SelfWorkMetricKind;
  reason: string;
  strategyId?: string;
}

/** 视为"重复提案"的拒绝原因 */
const DUPLICATE_REASONS = new Set(['duplicate_action', 'route_blocked']);

export interface SelfWorkStrategyStats {
  accepted: number;
  rejected: number;
}

export interface SelfWorkMetricsSummary {
  total: number;
  accepted: number;
  rejected: number;
  slept: number;
  dispatchFailed: number;
  /** accepted / (accepted + rejected)；无提案时为 0 */
  acceptanceRate: number;
  /** duplicate_action + route_blocked 拒绝占提案（accepted+rejected）比例 */
  duplicateRate: number;
  /** 末尾连续未派活（rejected/slept/dispatch_failed）事件数 */
  noProgressStreak: number;
  byStrategy: Record<string, SelfWorkStrategyStats>;
}

export function summarizeSelfWorkMetrics(events: SelfWorkMetricEvent[]): SelfWorkMetricsSummary {
  let accepted = 0;
  let rejected = 0;
  let slept = 0;
  let dispatchFailed = 0;
  let duplicates = 0;
  const byStrategy: Record<string, SelfWorkStrategyStats> = {};

  for (const event of events) {
    if (event.strategyId) {
      const stats = (byStrategy[event.strategyId] ??= { accepted: 0, rejected: 0 });
      if (event.kind === 'accepted') stats.accepted++;
      if (event.kind === 'rejected') stats.rejected++;
    }
    switch (event.kind) {
      case 'accepted':
        accepted++;
        break;
      case 'rejected':
        rejected++;
        if (DUPLICATE_REASONS.has(event.reason)) duplicates++;
        break;
      case 'slept':
        slept++;
        break;
      case 'dispatch_failed':
        dispatchFailed++;
        break;
    }
  }

  let noProgressStreak = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind === 'accepted') break;
    noProgressStreak++;
  }

  const proposals = accepted + rejected;
  return {
    total: events.length,
    accepted,
    rejected,
    slept,
    dispatchFailed,
    acceptanceRate: proposals > 0 ? accepted / proposals : 0,
    duplicateRate: proposals > 0 ? duplicates / proposals : 0,
    noProgressStreak,
    byStrategy,
  };
}

const METRICS_FILE = ['autonomy', 'self-work-metrics.jsonl'] as const;
const MAX_READ_EVENTS = 2000;

export class SelfWorkMetricsTracker {
  private readonly file: string;

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, ...METRICS_FILE);
  }

  record(event: SelfWorkMetricEvent): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`, 'utf8');
    } catch {
      // 指标写失败不影响主循环
    }
  }

  read(limit = MAX_READ_EVENTS): SelfWorkMetricEvent[] {
    if (!fs.existsSync(this.file)) return [];
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-limit).flatMap((line) => {
        try {
          return [JSON.parse(line) as SelfWorkMetricEvent];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  summarize(limit = MAX_READ_EVENTS): SelfWorkMetricsSummary {
    return summarizeSelfWorkMetrics(this.read(limit));
  }
}
