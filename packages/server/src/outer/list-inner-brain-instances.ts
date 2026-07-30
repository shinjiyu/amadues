/**
 * 内脑实例列表 enrichment（供 GET /api/inner-brains 分页 API 使用）。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { InnerBrainEngine } from '../workspace-kit/index.js';
import { summarizeDyflowForList, isDyflowWorkDir, buildWorkflowRunView } from '../openkuroneko/inner-brain/dyflow-inspector.js';
import { resolveOuterBrainPhase } from '../openkuroneko/inner-brain/status-projection.js';
import { isPidAlive, readWorkerStatus } from '../pi-mono/inner-brain-spawner.js';
import { computeBurstLiveness } from './advance-perception.js';
import type { TaskRecord } from './inner-brain-registry.js';

export type InnerBrainInstanceRow = {
  instance_id: string;
  workspace_id: string;
  registry_status: TaskRecord['status'];
  kpi_id: string | null;
  liveness: 'active' | 'stuck' | 'dead' | null;
  pid: number | null;
  pid_alive: boolean | null;
  worker_phase: string | null;
  last_tick_at: string | null;
  phase: string | null;
  lastAction: string | null;
  tickCount: number | null;
  goal: string;
  origin_user: string;
  origin_thread: string | null;
  started_at: string;
  finished_at: string | null;
  ticks: number | null;
  error: string | null;
  /** DyFlow / Executable Workflow */
  engine: 'dyflow' | 'execute' | 'legacy' | null;
  dyflow_mode: string | null;
  dyflow_dag_nodes: number | null;
  dyflow_failure: string | null;
  /** 如 2/5：node_results ok / DAG 节点数；或 EW 2/3 */
  dyflow_progress: string | null;
};

export function parseInnerBrainListPagination(query: {
  page?: string;
  pageSize?: string;
}): { page: number; pageSize: number } {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.pageSize ?? '20', 10) || 20));
  return { page, pageSize };
}

const LIVE_STATUSES = new Set<TaskRecord['status']>(['RUNNING', 'AWAITING', 'BLOCKED']);

/**
 * status 过滤：
 * - 缺省 / `live`：RUNNING|AWAITING|BLOCKED（dashboard 默认，避免扫几百条历史 DONE）
 * - `all`：全部
 * - 其它：逗号分隔状态名
 */
export function filterInnerBrainRecords(
  records: TaskRecord[],
  statusQuery?: string,
): TaskRecord[] {
  const raw = statusQuery?.trim().toLowerCase();
  if (!raw || raw === 'live') {
    return records.filter((r) => LIVE_STATUSES.has(r.status));
  }
  if (raw === 'all') return records;
  const wanted = new Set(
    raw
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
  return records.filter((r) => wanted.has(r.status));
}

export function enrichInnerBrainInstanceRow(
  r: TaskRecord,
  getEngine: (workspaceId: string) => InnerBrainEngine,
  formatAgentIsoLocal: (iso: string) => string,
  now = Date.now(),
): InnerBrainInstanceRow {
  let phase: string | null = null;
  let lastAction: string | null = null;
  let tickCount: number | null = null;
  try {
    const st = getEngine(r.workspaceId).readStatus();
    phase = st?.phase ?? null;
    lastAction = st?.lastAction ?? null;
    tickCount = st?.tickCount ?? null;
  } catch {
    /* workspace 可能还未初始化 */
  }

  const workerStatus = r.status === 'RUNNING' ? readWorkerStatus(r.workDir) : null;
  const lastTickAt = workerStatus?.lastTickAt ?? r.lastTickAt ?? null;
  const liveTicks = workerStatus?.ticks ?? r.ticks ?? null;
  const workerPhase = workerStatus?.phase ?? null;

  const pidAlive = r.status === 'RUNNING' && r.pid != null ? isPidAlive(r.pid) : null;
  const liveness = computeBurstLiveness(r, now);

  const outerPhase = resolveOuterBrainPhase(r.workDir);
  let engineMeta: {
    engine: 'dyflow' | 'execute' | 'legacy' | null;
    dyflow_mode: string | null;
    dyflow_dag_nodes: number | null;
    dyflow_failure: string | null;
    dyflow_progress: string | null;
  };
  if (isDyflowWorkDir(r.workDir)) {
    engineMeta = { engine: 'dyflow', ...summarizeDyflowForList(r.workDir) };
  } else {
    const wr = buildWorkflowRunView(r.workDir);
    if (wr) {
      const done = wr.steps.filter((s) => s.ok).length;
      engineMeta = {
        engine: 'execute',
        dyflow_mode: wr.ok ? 'EW_OK' : 'EW_FAIL',
        dyflow_dag_nodes: wr.steps.length,
        dyflow_failure: wr.ok ? null : wr.steps.find((s) => !s.ok)?.detailPreview?.slice(0, 80) ?? 'EW fail',
        dyflow_progress: `${done}/${wr.steps.length}`,
      };
    } else {
      engineMeta = {
        engine: isLegacyBrainWorkDir(r.workDir) ? 'legacy' : null,
        dyflow_mode: null,
        dyflow_dag_nodes: null,
        dyflow_failure: null,
        dyflow_progress: null,
      };
    }
  }

  const displayPhase = outerPhase.engine === 'dyflow' ? outerPhase.phase : phase;

  return {
    instance_id: r.instanceId,
    workspace_id: r.workspaceId,
    registry_status: r.status,
    kpi_id: r.kpiId ?? null,
    liveness,
    pid: r.pid ?? null,
    pid_alive: pidAlive,
    worker_phase: workerPhase,
    last_tick_at: lastTickAt ? formatAgentIsoLocal(lastTickAt) : null,
    phase: displayPhase,
    lastAction,
    tickCount: liveTicks ?? tickCount,
    goal: r.goal.slice(0, 200),
    origin_user: r.originUser,
    origin_thread: r.originThread ?? null,
    started_at: formatAgentIsoLocal(r.startedAt),
    finished_at: r.finishedAt ? formatAgentIsoLocal(r.finishedAt) : null,
    ticks: liveTicks,
    error: r.errorMessage ?? null,
    ...engineMeta,
  };
}

function isLegacyBrainWorkDir(workDir: string): boolean {
  return fs.existsSync(path.join(workDir, '.brain', 'controller-state.json'));
}
