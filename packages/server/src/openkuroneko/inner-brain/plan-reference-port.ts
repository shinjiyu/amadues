/**
 * Designer 方案参考检索 — 内脑侧 Port 契约（实现由外脑注入）。
 *
 * ADL: doc/structurizr/TASK-PLAN-REFERENCE.md
 */

export type PlanReferenceSource = 'archive' | 'repository' | 'peer';

export interface PlanReferenceHit {
  source: PlanReferenceSource;
  title: string;
  snippet: string;
  score?: number;
}

export interface PlanReferenceSearchInput {
  query: string;
  kpiId?: string;
  sources?: PlanReferenceSource[];
  topK?: number;
}

export interface PlanReferencePort {
  search(input: PlanReferenceSearchInput): Promise<PlanReferenceHit[]>;
}

export interface PlanReferenceRecord {
  source: PlanReferenceSource;
  title: string;
  snippet: string;
  query: string;
  retrievedAt: string;
}

export const PLAN_REFERENCES_MEMORY_KEY = 'plan_references';
export const MAX_PLAN_REFERENCES = 20;

const ALL_SOURCES: PlanReferenceSource[] = ['archive', 'repository', 'peer'];

export function normalizePlanReferenceSources(
  sources?: PlanReferenceSource[],
): PlanReferenceSource[] {
  if (!sources?.length) return [...ALL_SOURCES];
  const allowed = new Set(ALL_SOURCES);
  const out: PlanReferenceSource[] = [];
  for (const s of sources) {
    if (allowed.has(s) && !out.includes(s)) out.push(s);
  }
  return out.length > 0 ? out : [...ALL_SOURCES];
}

export function formatPlanReferenceHits(hits: PlanReferenceHit[]): string {
  if (hits.length === 0) {
    return '（未命中任何方案参考）';
  }
  const parts = [
    '## 方案参考（未验证，禁止写入 facts）',
    '> 以下仅供编排参考；经验证后须 record_fact 方可当作事实。',
  ];
  for (const h of hits) {
    parts.push(`\n### [${h.source}] ${h.title}`, h.snippet.trim());
  }
  return parts.join('\n');
}

export function appendPlanReferences(
  existing: PlanReferenceRecord[] | undefined,
  query: string,
  hits: PlanReferenceHit[],
): PlanReferenceRecord[] {
  const now = new Date().toISOString();
  const appended: PlanReferenceRecord[] = hits.map((h) => ({
    source: h.source,
    title: h.title,
    snippet: h.snippet,
    query,
    retrievedAt: now,
  }));
  return [...(existing ?? []), ...appended].slice(-MAX_PLAN_REFERENCES);
}

export function summarizePlanReferences(records: PlanReferenceRecord[] | undefined): string {
  if (!records?.length) return '（无）';
  return records
    .slice(-8)
    .map(
      (r) =>
        `- [${r.source}] ${r.title}（query=${r.query.slice(0, 40)}… @ ${r.retrievedAt.slice(0, 19)}）\n  ${r.snippet.slice(0, 200)}${r.snippet.length > 200 ? '…' : ''}`,
    )
    .join('\n');
}
