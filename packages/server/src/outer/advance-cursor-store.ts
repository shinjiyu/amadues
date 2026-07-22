/**
 * 推进轻量 cursor — ADL KPI-ADVANCE-WORK-PACKAGE.md §4 / P3
 *
 * 每 KPI 仅记 bootstrapDone + sinceAt（增量窗口锚点），禁止做成 WP 状态机。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { BurstRunRecord } from './kpi-registry.js';
import { isBootstrapDoneFromHistory } from './advance-perception.js';

export interface AdvanceKpiCursor {
  bootstrapDone: boolean;
  /** 增量采集窗口起点（ISO）；缺省时 prompt 退化为「近 24h」 */
  sinceAt?: string;
  updatedAt: string;
}

export type AdvanceCursorMap = Record<string, AdvanceKpiCursor>;

const CURSOR_REL = ['autonomy', 'advance-cursors.json'] as const;

export function advanceCursorPath(dataRoot: string): string {
  return path.join(dataRoot, ...CURSOR_REL);
}

export function loadAdvanceCursors(dataRoot: string): AdvanceCursorMap {
  const file = advanceCursorPath(dataRoot);
  if (!fs.existsSync(file)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw as AdvanceCursorMap;
  } catch {
    return {};
  }
}

export function saveAdvanceCursors(dataRoot: string, cursors: AdvanceCursorMap): void {
  const file = advanceCursorPath(dataRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cursors, null, 2)}\n`, 'utf8');
}

export function upsertAdvanceCursor(
  dataRoot: string,
  kpiId: string,
  patch: Partial<Pick<AdvanceKpiCursor, 'bootstrapDone' | 'sinceAt'>>,
  now = new Date(),
): AdvanceKpiCursor {
  const cursors = loadAdvanceCursors(dataRoot);
  const prev = cursors[kpiId];
  const next: AdvanceKpiCursor = {
    bootstrapDone: patch.bootstrapDone ?? prev?.bootstrapDone ?? false,
    sinceAt: patch.sinceAt ?? prev?.sinceAt,
    updatedAt: now.toISOString(),
  };
  cursors[kpiId] = next;
  saveAdvanceCursors(dataRoot, cursors);
  return next;
}

/** 从 burst 历史取最近一次有产物的结束时间，作 sinceAt 候选（含 AWAITING+交付） */
export function lastSuccessfulDeliverableAt(
  history: BurstRunRecord[] | undefined,
): string | undefined {
  const withDeliverables = (history ?? [])
    .filter((run) => (run.deliverableCount ?? 0) > 0)
    .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
  return withDeliverables[0]?.finishedAt;
}

/**
 * 用 KPI burst 历史回填 cursor（幂等）：bootstrapDone / 缺 sinceAt 时补上。
 * @returns 发生写入的 kpi 数
 */
export function syncAdvanceCursorsFromKpiHistory(
  dataRoot: string,
  kpis: Array<{ kpiId: string; burstRunHistory: BurstRunRecord[] }>,
  now = new Date(),
): number {
  const cursors = loadAdvanceCursors(dataRoot);
  let changed = 0;
  for (const kpi of kpis) {
    const fromHistory = isBootstrapDoneFromHistory(kpi.burstRunHistory);
    if (!fromHistory) continue;
    const prev = cursors[kpi.kpiId];
    const sinceAt = prev?.sinceAt ?? lastSuccessfulDeliverableAt(kpi.burstRunHistory);
    const next: AdvanceKpiCursor = {
      bootstrapDone: true,
      sinceAt,
      updatedAt: now.toISOString(),
    };
    const same =
      prev?.bootstrapDone === next.bootstrapDone && prev?.sinceAt === next.sinceAt;
    if (same) continue;
    cursors[kpi.kpiId] = next;
    changed += 1;
  }
  if (changed > 0) saveAdvanceCursors(dataRoot, cursors);
  return changed;
}
