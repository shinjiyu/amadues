/**
 * 推进调配指标 — ADL KPI-ADVANCE-WORK-PACKAGE.md P3
 *
 * 盲派：派发时无 perception（hadPerception=false）
 * 重复日历写入：同 calendarKey 出现第二次 created=true（ADV-6 应恒为 0）
 */
import fs from 'node:fs';
import path from 'node:path';

export type AdvancePackageKind = 'bootstrap' | 'repair' | 'increment' | 'other';

export type AdvanceMetricKind = 'dispatch' | 'calendar_ensure';

export interface AdvanceMetricEvent {
  at: string;
  kind: AdvanceMetricKind;
  kpiId?: string;
  packageKind?: AdvancePackageKind;
  /** false = 盲派（无结构化感知） */
  hadPerception: boolean;
  /** calendar_ensure：是否新建；false = 幂等 no-op */
  created?: boolean;
  calendarKey?: string;
  reason?: string;
}

export interface AdvanceMetricsSummary {
  dispatches: number;
  blindDispatches: number;
  /** blindDispatches / dispatches；无派发时为 0 */
  blindDispatchRate: number;
  calendarEnsureAttempts: number;
  calendarEnsureCreated: number;
  calendarEnsureNoops: number;
  /** 同 key 二次 create=true 计数；健康时为 0 */
  duplicateCalendarCreates: number;
}

export function summarizeAdvanceMetrics(events: AdvanceMetricEvent[]): AdvanceMetricsSummary {
  let dispatches = 0;
  let blindDispatches = 0;
  let calendarEnsureAttempts = 0;
  let calendarEnsureCreated = 0;
  let calendarEnsureNoops = 0;
  let duplicateCalendarCreates = 0;
  const createdKeys = new Set<string>();

  for (const event of events) {
    if (event.kind === 'dispatch') {
      dispatches += 1;
      if (!event.hadPerception) blindDispatches += 1;
      continue;
    }
    if (event.kind === 'calendar_ensure') {
      calendarEnsureAttempts += 1;
      if (event.created) {
        calendarEnsureCreated += 1;
        const key = event.calendarKey ?? event.kpiId ?? '';
        if (key && createdKeys.has(key)) duplicateCalendarCreates += 1;
        if (key) createdKeys.add(key);
      } else {
        calendarEnsureNoops += 1;
      }
    }
  }

  return {
    dispatches,
    blindDispatches,
    blindDispatchRate: dispatches > 0 ? blindDispatches / dispatches : 0,
    calendarEnsureAttempts,
    calendarEnsureCreated,
    calendarEnsureNoops,
    duplicateCalendarCreates,
  };
}

export function detectAdvancePackageKind(action: string): AdvancePackageKind {
  if (action.includes('【本轮工作包·bootstrap】') || action.includes('·bootstrap】')) {
    return 'bootstrap';
  }
  if (action.includes('【本轮工作包·repair】') || action.includes('·repair】')) {
    return 'repair';
  }
  if (action.includes('【日历到期·increment】') || action.includes('·increment】')) {
    return 'increment';
  }
  return 'other';
}

const METRICS_REL = ['autonomy', 'advance-metrics.jsonl'] as const;
const MAX_READ = 2000;

export class AdvanceMetricsTracker {
  private readonly file: string;

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, ...METRICS_REL);
  }

  record(event: AdvanceMetricEvent): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`, 'utf8');
    } catch {
      /* 指标失败不影响主循环 */
    }
  }

  read(limit = MAX_READ): AdvanceMetricEvent[] {
    if (!fs.existsSync(this.file)) return [];
    try {
      const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
      return lines.slice(-limit).flatMap((line) => {
        try {
          return [JSON.parse(line) as AdvanceMetricEvent];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  summarize(limit = MAX_READ): AdvanceMetricsSummary {
    return summarizeAdvanceMetrics(this.read(limit));
  }
}
