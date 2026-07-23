/**
 * Executable Workflow 连败熔断 — ADL EXECUTABLE-WORKFLOW.md §8.1
 *
 * execute burst（.brain/burst-mode.json）按 ew:{id}@{ver} 计末尾连续失败；
 * ≥ 阈值 → store.setPaused(id) + action-log(workflow_failure_circuit)。
 * 不 pause KPI（与 R7 路线熔断互补）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { InnerBrainRegistry, TaskRecord } from './inner-brain-registry.js';
import type { ExecutableWorkflowStore } from './executable-workflow-store.js';
import type { WorkflowRef } from './executable-workflow-types.js';
import { appendAutonomyActionLog } from './autonomy-action-log.js';
import { DEFAULT_MAX_CONSECUTIVE_FAILURES } from './kpi/kpi-failure-circuit.js';

const FAILURE: ReadonlySet<string> = new Set(['ERROR', 'ABORTED', 'STOPPED']);
const SUCCESS: ReadonlySet<string> = new Set(['DONE']);

export function workflowRouteKey(id: string, version: string): string {
  return `ew:${id.trim()}@${String(version).trim()}`;
}

export function formatExecuteGoalPrefix(ref: WorkflowRef): string {
  return `[${workflowRouteKey(ref.id, ref.version)}]`;
}

/** 从 goal 文本解析 `[ew:id@ver]` 前缀（set_goal / workflow_run 写入） */
export function parseWorkflowRefFromGoal(goal: string): WorkflowRef | null {
  const m = goal.trim().match(/^\[ew:([\w.-]+)@([\w.]+)\]/);
  if (!m) return null;
  return { id: m[1]!, version: m[2]! };
}

export function readExecuteWorkflowRef(workDir: string): WorkflowRef | null {
  const p = path.join(workDir, '.brain', 'burst-mode.json');
  if (!fs.existsSync(p)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      burstMode?: string;
      workflowRef?: { id?: string; version?: string };
    };
    if (j.burstMode !== 'execute') return null;
    const id = j.workflowRef?.id?.trim();
    const version = j.workflowRef?.version != null ? String(j.workflowRef.version).trim() : '';
    if (!id || !version) return null;
    return { id, version };
  } catch {
    return null;
  }
}

function resolveRef(task: TaskRecord): WorkflowRef | null {
  return readExecuteWorkflowRef(task.workDir) ?? parseWorkflowRefFromGoal(task.goal ?? '');
}

export interface WorkflowCircuitHit {
  id: string;
  version: string;
  failures: number;
  lastError?: string;
  routeKey: string;
}

/**
 * 按 ew:{id}@{ver}：取该 ref 的任务（finished 优先），从新到旧数连续 FAILURE，遇 SUCCESS 打断。
 */
export function selectWorkflowsForCircuit(
  registry: InnerBrainRegistry,
  threshold: number = DEFAULT_MAX_CONSECUTIVE_FAILURES,
): WorkflowCircuitHit[] {
  if (!(threshold > 0)) return [];

  const byKey = new Map<string, TaskRecord[]>();
  for (const t of registry.list()) {
    if (t.status === 'RUNNING' || t.status === 'BLOCKED' || t.status === 'AWAITING') continue;
    const ref = resolveRef(t);
    if (!ref) continue;
    const key = workflowRouteKey(ref.id, ref.version);
    const list = byKey.get(key) ?? [];
    list.push(t);
    byKey.set(key, list);
  }

  const hits: WorkflowCircuitHit[] = [];
  for (const [key, tasks] of byKey) {
    tasks.sort((a, b) =>
      (b.finishedAt ?? b.startedAt).localeCompare(a.finishedAt ?? a.startedAt),
    );
    let failures = 0;
    let lastError: string | undefined;
    for (const t of tasks) {
      if (SUCCESS.has(t.status)) break;
      if (FAILURE.has(t.status)) {
        failures++;
        if (!lastError) lastError = t.errorMessage ?? t.abortReason;
        continue;
      }
      break;
    }
    if (failures < threshold) continue;
    const first = resolveRef(tasks[0]!);
    if (!first) continue;
    hits.push({
      id: first.id,
      version: first.version,
      failures,
      lastError,
      routeKey: key,
    });
  }
  return hits.sort((a, b) => a.routeKey.localeCompare(b.routeKey));
}

export interface TripWorkflowCircuitDeps {
  dataRoot: string;
  registry: InnerBrainRegistry;
  store: ExecutableWorkflowStore;
  maxConsecutiveFailures?: number;
}

export interface TripWorkflowCircuitResult {
  paused: WorkflowCircuitHit[];
  /** 已达阈值但 EW 本已 paused（幂等） */
  alreadyPaused: WorkflowCircuitHit[];
}

/**
 * 扫描并 pause 连败 EW。心跳可与 tripFailureCircuitBreakers 同 tick 调用。
 */
export function tripWorkflowFailureCircuit(
  deps: TripWorkflowCircuitDeps,
): TripWorkflowCircuitResult {
  const threshold = deps.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const hits = selectWorkflowsForCircuit(deps.registry, threshold);
  const paused: WorkflowCircuitHit[] = [];
  const alreadyPaused: WorkflowCircuitHit[] = [];

  for (const hit of hits) {
    const meta = deps.store.getMeta(hit.id);
    if (!meta) continue;
    if (meta.paused) {
      alreadyPaused.push(hit);
      continue;
    }
    deps.store.setPaused(hit.id, true);
    appendAutonomyActionLog(deps.dataRoot, {
      at: new Date().toISOString(),
      dispatched: false,
      reason: 'workflow_failure_circuit',
      detail:
        `${hit.routeKey} 连败 ${hit.failures} 次已 pause EW` +
        (hit.lastError ? `：${hit.lastError.slice(0, 160)}` : ''),
    });
    paused.push(hit);
  }

  return { paused, alreadyPaused };
}

/** 供 blockedRoutes：已 pause 的 EW 路线键 */
export function listPausedWorkflowRoutes(store: ExecutableWorkflowStore): string[] {
  return store
    .list()
    .filter((m) => m.paused)
    .map((m) => workflowRouteKey(m.id, m.latestVersion));
}
