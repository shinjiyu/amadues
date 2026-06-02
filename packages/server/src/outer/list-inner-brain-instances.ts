/**
 * 内脑实例列表 enrichment（供 GET /api/inner-brains 分页 API 使用）。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { InnerBrainEngine } from '../workspace-kit/index.js';
import { summarizeDyflowForList, isDyflowWorkDir } from '../openkuroneko/inner-brain/dyflow-inspector.js';
import { isPidAlive, readWorkerStatus } from '../pi-mono/inner-brain-spawner.js';
import type { TaskRecord } from './inner-brain-registry.js';

const STUCK_THRESHOLD_MS = 5 * 60 * 1000;

export type InnerBrainInstanceRow = {
  instance_id: string;
  workspace_id: string;
  registry_status: TaskRecord['status'];
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
  /** DyFlow：有 dyflow-state.json */
  engine: 'dyflow' | 'legacy' | null;
  dyflow_mode: string | null;
  dyflow_dag_nodes: number | null;
  dyflow_failure: string | null;
};

export function parseInnerBrainListPagination(query: {
  page?: string;
  pageSize?: string;
}): { page: number; pageSize: number } {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(query.pageSize ?? '20', 10) || 20));
  return { page, pageSize };
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

  let liveness: 'active' | 'stuck' | 'dead' | null = null;
  if (r.status === 'RUNNING') {
    if (pidAlive === false) {
      liveness = 'dead';
    } else {
      const anchor = lastTickAt ?? r.startedAt;
      const sinceAnchor = now - new Date(anchor).getTime();
      liveness = sinceAnchor > STUCK_THRESHOLD_MS ? 'stuck' : 'active';
    }
  }

  const dyflow = isDyflowWorkDir(r.workDir)
    ? { engine: 'dyflow' as const, ...summarizeDyflowForList(r.workDir) }
    : {
        engine: isLegacyBrainWorkDir(r.workDir) ? ('legacy' as const) : null,
        dyflow_mode: null,
        dyflow_dag_nodes: null,
        dyflow_failure: null,
      };

  return {
    instance_id: r.instanceId,
    workspace_id: r.workspaceId,
    registry_status: r.status,
    liveness,
    pid: r.pid ?? null,
    pid_alive: pidAlive,
    worker_phase: workerPhase,
    last_tick_at: lastTickAt ? formatAgentIsoLocal(lastTickAt) : null,
    phase,
    lastAction,
    tickCount,
    goal: r.goal.slice(0, 200),
    origin_user: r.originUser,
    origin_thread: r.originThread ?? null,
    started_at: formatAgentIsoLocal(r.startedAt),
    finished_at: r.finishedAt ? formatAgentIsoLocal(r.finishedAt) : null,
    ticks: liveTicks,
    error: r.errorMessage ?? null,
    ...dyflow,
  };
}

function isLegacyBrainWorkDir(workDir: string): boolean {
  return fs.existsSync(path.join(workDir, '.brain', 'controller-state.json'));
}
