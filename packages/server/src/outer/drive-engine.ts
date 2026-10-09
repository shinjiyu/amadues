/**
 * DriveEngine — 宪章长期目标 → KPI 种子（ADL doc/structurizr/AGENT-SUBJECT-DESIGN.md §3 意志层）
 *
 * 每条宪章目标只播种一次：只要已有任何状态（active/paused/achieved/abandoned）的 KPI
 * 带着该 slug 标记，就不再重播——放弃即放弃，不会被引擎自动复活。
 * 播种后的 KPI 走既有 SelfWorkPolicy / DigitalEmployeeLoop 推进。
 */
import type { Constitution } from './constitution.js';
import type { CreateKpiInput, KpiRecord } from './kpi-registry.js';

export const DRIVE_GOAL_CREATED_BY = 'agent:self:constitution';
const DRIVE_GOAL_MARKER_RE = /drive-goal:([a-z0-9][a-z0-9_-]*)/i;

export function driveGoalMarker(slug: string): string {
  return `drive-goal:${slug}`;
}

export function extractDriveGoalSlug(kpi: Pick<KpiRecord, 'notes'>): string | null {
  const m = kpi.notes ? DRIVE_GOAL_MARKER_RE.exec(kpi.notes) : null;
  return m ? m[1]!.toLowerCase() : null;
}

export interface DriveSeedInput {
  constitution: Constitution;
  /** 全部 KPI（任意状态），用于判定 slug 是否已播种 */
  existingKpis: Pick<KpiRecord, 'notes'>[];
  /** 单次最多播种几条；默认 1，避免一次铺开过多目标 */
  maxNewPerCycle?: number;
}

export function proposeDriveSeeds(input: DriveSeedInput): CreateKpiInput[] {
  const max = Math.max(0, input.maxNewPerCycle ?? 1);
  if (max === 0) return [];
  const seeded = new Set(
    input.existingKpis.map(extractDriveGoalSlug).filter((s): s is string => s !== null),
  );
  const abandonment = input.constitution.abandonmentClause.trim();
  const seeds: CreateKpiInput[] = [];
  for (const goal of input.constitution.goals) {
    if (seeds.length >= max) break;
    if (seeded.has(goal.slug)) continue;
    seeds.push({
      description: goal.objective,
      createdBy: DRIVE_GOAL_CREATED_BY,
      kind: goal.kind,
      notes: [
        driveGoalMarker(goal.slug),
        abandonment ? `放弃条款：${abandonment}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    });
  }
  return seeds;
}