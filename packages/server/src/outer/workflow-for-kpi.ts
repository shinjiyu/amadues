/**
 * 为 KPI 挑选可 execute 的本地工作流（按 tag）。
 * 匹配：tags 含 `kpi:{kpiId}` 或恰好等于 kpiId。
 * W12：同 KPI 多 EW 时按 role 优先。
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md §6.1 W12
 */
import type { ExecutableWorkflowStore } from './executable-workflow-store.js';
import type { WorkflowMeta, WorkflowRef } from './executable-workflow-types.js';

export function kpiWorkflowTag(kpiId: string): string {
  return `kpi:${kpiId.trim()}`;
}

/** EW 相对 KPI 的角色标签（W12） */
export type KpiWorkflowRole = 'primary' | 'collect' | 'repair' | 'verify';

export function kpiWorkflowRoleTag(role: KpiWorkflowRole): string {
  return `role:${role}`;
}

function matchesKpi(meta: WorkflowMeta, kpiId: string, tag: string): boolean {
  return (
    meta.tags.includes(tag) ||
    meta.tags.includes(kpiId) ||
    meta.id === `ew-${kpiId}` ||
    meta.id === kpiId
  );
}

function roleRank(meta: WorkflowMeta): number {
  const tags = meta.tags;
  if (tags.includes('role:primary')) return 0;
  if (tags.includes('role:collect')) return 1;
  if (tags.includes('role:repair') || tags.includes('role:verify')) return 90;
  return 10; // 无 role：日常可跑，次于 primary/collect
}

/**
 * 挑选 KPI 的默认 execute 目标。
 * 优先：role:primary → role:collect → 无 repair/verify →（不选纯 repair/verify，除非别无他选）
 */
export function findWorkflowRefForKpi(
  store: ExecutableWorkflowStore,
  kpiId: string,
): WorkflowRef | null {
  const id = kpiId.trim();
  if (!id) return null;
  const tag = kpiWorkflowTag(id);
  const hits = store.list().filter((m) => !m.paused && matchesKpi(m, id, tag));
  if (hits.length === 0) return null;

  const preferred = hits
    .filter((m) => !m.tags.includes('role:repair') && !m.tags.includes('role:verify'))
    .sort((a, b) => roleRank(a) - roleRank(b) || a.id.localeCompare(b.id));
  const pool = preferred.length > 0 ? preferred : [...hits].sort(
    (a, b) => roleRank(a) - roleRank(b) || a.id.localeCompare(b.id),
  );
  const hit = pool[0]!;
  return { id: hit.id, version: hit.latestVersion };
}
