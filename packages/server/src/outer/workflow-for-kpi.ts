/**
 * 为 KPI 挑选可 execute 的本地工作流（按 tag）。
 * 匹配：tags 含 `kpi:{kpiId}` 或恰好等于 kpiId。
 */
import type { ExecutableWorkflowStore } from './executable-workflow-store.js';
import type { WorkflowRef } from './executable-workflow-types.js';

export function kpiWorkflowTag(kpiId: string): string {
  return `kpi:${kpiId.trim()}`;
}

export function findWorkflowRefForKpi(
  store: ExecutableWorkflowStore,
  kpiId: string,
): WorkflowRef | null {
  const id = kpiId.trim();
  if (!id) return null;
  const tag = kpiWorkflowTag(id);
  const metas = store.list().filter((m) => !m.paused);
  const hit = metas.find(
    (m) => m.tags.includes(tag) || m.tags.includes(id) || m.id === `ew-${id}` || m.id === id,
  );
  if (!hit) return null;
  return { id: hit.id, version: hit.latestVersion };
}
