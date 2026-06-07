/**
 * KPI 节拍纯函数 — ADL KPI-ADVANCEMENT.md §3
 */
import type { KpiCadence, KpiRecord } from '../kpi-registry.js';

const MS_HOUR = 60 * 60 * 1000;

/** 下一 due 时刻（ISO）；`once` 且无 lastBurst → 立即 due */
export function computeNextDueAt(kpi: KpiRecord, fromMs: number = Date.now()): string | undefined {
  const cadence = kpi.cadence;
  if (cadence.type === 'once') {
    if (!kpi.lastBurstAt) return new Date(fromMs).toISOString();
    return undefined;
  }
  if (cadence.type === 'interval') {
    const base = kpi.lastBurstAt ? new Date(kpi.lastBurstAt).getTime() : fromMs;
    return new Date(base + cadence.everyMs).toISOString();
  }
  if (cadence.type === 'continuous') {
    const base = kpi.lastBurstAt ? new Date(kpi.lastBurstAt).getTime() : fromMs;
    return new Date(base + cadence.minGapMs).toISOString();
  }
  if (cadence.type === 'cron') {
    return nextCronDue(cadence.hours, cadence.tz, fromMs);
  }
  return undefined;
}

function nextCronDue(hours: number[], _tz: string, fromMs: number): string {
  const sorted = [...hours].sort((a, b) => a - b);
  const d = new Date(fromMs);
  for (let dayOffset = 0; dayOffset < 2; dayOffset++) {
    const base = new Date(d);
    base.setDate(base.getDate() + dayOffset);
    base.setMinutes(0, 0, 0);
    for (const h of sorted) {
      const candidate = new Date(base);
      candidate.setHours(h, 0, 0, 0);
      if (candidate.getTime() > fromMs) {
        return candidate.toISOString();
      }
    }
  }
  const fallback = new Date(fromMs + 12 * MS_HOUR);
  return fallback.toISOString();
}

export function isCadenceDue(kpi: KpiRecord, nowMs: number = Date.now()): boolean {
  if (kpi.status !== 'active' || !kpi.isLeaf) return false;
  const cadence = kpi.cadence;
  if (cadence.type === 'once') {
    return !kpi.lastBurstAt;
  }
  if (kpi.nextDueAt) {
    return nowMs >= new Date(kpi.nextDueAt).getTime();
  }
  if (!kpi.lastBurstAt) return true;
  if (cadence.type === 'interval') {
    return nowMs >= new Date(kpi.lastBurstAt).getTime() + cadence.everyMs;
  }
  if (cadence.type === 'continuous') {
    return nowMs >= new Date(kpi.lastBurstAt).getTime() + cadence.minGapMs;
  }
  if (cadence.type === 'cron') {
    const next = nextCronDue(cadence.hours, cadence.tz, nowMs - 1000);
    return nowMs >= new Date(next).getTime() - 60_000;
  }
  return false;
}

/** burst 结束后刷新 nextDueAt */
export function refreshKpiNextDueAt(kpi: KpiRecord, finishedAtMs: number = Date.now()): string | undefined {
  return computeNextDueAt(
    { ...kpi, lastBurstAt: new Date(finishedAtMs).toISOString() },
    finishedAtMs,
  );
}
