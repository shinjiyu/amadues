/**
 * DyFlow 内脑快照（Dashboard brain-inspector / 列表 enrichment）
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §12
 *       doc/structurizr/TASK-RUN-OBSERVABILITY.md §8（burst 执行 graph）
 */
import fs from 'node:fs';
import path from 'node:path';

import type { GraphEdge, InnerMemory, LocalDag, LocalNodeIndex } from './types.js';

export type DagNodeExecStatus = 'pending' | 'active' | 'ok' | 'fail';

export type DyflowDagNodeView = {
  id: string;
  ref: string;
  instructionPreview: string;
  /** 与 node_results / last_failure / RUN 进度合并 */
  status: DagNodeExecStatus;
  milestone?: string;
};

export type WorkflowRunStepView = {
  stepId: string;
  ok: boolean;
  attempts: number;
  detailPreview?: string;
};

export type WorkflowRunView = {
  workflowId: string;
  version: string;
  ok: boolean;
  abortedAt?: string;
  steps: WorkflowRunStepView[];
};

export type DyflowInspectorPayload = {
  engine: 'dyflow';
  state: { mode: string; burstId?: string } | null;
  dag: {
    nodeCount: number;
    entry?: string;
    /** 磁盘未写 edges 时按 nodes[] 顺序串行补边 */
    impliedEdges: boolean;
    nodes: DyflowDagNodeView[];
    edges: GraphEdge[];
  } | null;
  memory: {
    goal: string | null;
    factsCount: number;
    constraintsCount: number;
    lastFailure: {
      summary: string;
      transient?: boolean;
      localRef?: string;
      nodeInstId?: string;
    } | null;
    nodeResults: Array<{ id: string; ref: string; ok: boolean }>;
  } | null;
  localNodes: Array<{ id: string; kind: string; description: string }>;
  /** execute 模式：.run/workflow_run.json */
  workflowRun: WorkflowRunView | null;
};

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function listLocalNodeSummaries(brainDir: string): DyflowInspectorPayload['localNodes'] {
  const indexPath = path.join(brainDir, 'local_nodes', 'index.json');
  const index = readJsonFile<LocalNodeIndex>(indexPath);
  if (index?.entries?.length) {
    return index.entries.map((n) => ({
      id: n.id,
      kind: n.kind,
      description: (n.description ?? '').slice(0, 120),
    }));
  }
  const dir = path.join(brainDir, 'local_nodes');
  if (!fs.existsSync(dir)) return [];
  const out: DyflowInspectorPayload['localNodes'] = [];
  for (const sub of ['preset', 'local', 'imported']) {
    const subDir = path.join(dir, sub);
    if (!fs.existsSync(subDir)) continue;
    for (const f of fs.readdirSync(subDir).filter((x) => x.endsWith('.json'))) {
      const node = readJsonFile<{ id?: string; body?: { kind?: string }; description?: string }>(
        path.join(subDir, f),
      );
      if (node?.id) {
        out.push({
          id: node.id,
          kind: node.body?.kind ?? 'executor',
          description: (node.description ?? '').slice(0, 120),
        });
      }
    }
  }
  return out;
}

export function isDyflowWorkDir(workDir: string): boolean {
  return fs.existsSync(path.join(workDir, '.brain', 'dyflow-state.json'));
}

/** 缺 edges 时按 Designer 默认：nodes[] 顺序串行 */
export function resolveDagEdges(dag: LocalDag): { edges: GraphEdge[]; impliedEdges: boolean } {
  if (dag.edges && dag.edges.length > 0) {
    return { edges: dag.edges.map((e) => ({ from: e.from, to: e.to })), impliedEdges: false };
  }
  const nodes = dag.nodes ?? [];
  const edges: GraphEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({ from: nodes[i]!.id, to: nodes[i + 1]!.id });
  }
  return { edges, impliedEdges: nodes.length > 1 };
}

/**
 * 合并 node_results + last_failure + mode，标出当前进度。
 * RUN 时：第一个尚无结果的拓扑序节点标 active。
 */
export function resolveDagNodeStatuses(
  nodeIds: string[],
  edges: GraphEdge[],
  opts: {
    mode?: string | null;
    nodeResults?: Record<string, { ok: boolean; ref?: string }> | null;
    failureNodeId?: string | null;
  },
): Map<string, DagNodeExecStatus> {
  const results = opts.nodeResults ?? {};
  const status = new Map<string, DagNodeExecStatus>();
  for (const id of nodeIds) {
    const r = results[id];
    if (r) status.set(id, r.ok ? 'ok' : 'fail');
    else if (opts.failureNodeId === id) status.set(id, 'fail');
    else status.set(id, 'pending');
  }

  if (opts.mode === 'RUN') {
    const order = topoOrder(nodeIds, edges);
    for (const id of order) {
      if (status.get(id) === 'pending') {
        status.set(id, 'active');
        break;
      }
    }
  }
  return status;
}

function topoOrder(nodeIds: string[], edges: GraphEdge[]): string[] {
  const idSet = new Set(nodeIds);
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const id of nodeIds) {
    indeg.set(id, 0);
    adj.set(id, []);
  }
  for (const e of edges) {
    if (!idSet.has(e.from) || !idSet.has(e.to)) continue;
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const q = nodeIds.filter((id) => (indeg.get(id) ?? 0) === 0);
  const out: string[] = [];
  while (q.length) {
    const id = q.shift()!;
    out.push(id);
    for (const nxt of adj.get(id) ?? []) {
      const d = (indeg.get(nxt) ?? 1) - 1;
      indeg.set(nxt, d);
      if (d === 0) q.push(nxt);
    }
  }
  for (const id of nodeIds) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function readWorkflowRun(workDir: string): WorkflowRunView | null {
  const raw = readJsonFile<{
    workflowId?: string;
    version?: string;
    ok?: boolean;
    abortedAt?: string;
    steps?: Array<{ stepId?: string; ok?: boolean; attempts?: number; detail?: string }>;
  }>(path.join(workDir, '.run', 'workflow_run.json'));
  if (!raw?.workflowId) return null;
  return {
    workflowId: String(raw.workflowId),
    version: String(raw.version ?? '?'),
    ok: Boolean(raw.ok),
    abortedAt: raw.abortedAt,
    steps: (raw.steps ?? []).map((s) => ({
      stepId: String(s.stepId ?? '?'),
      ok: Boolean(s.ok),
      attempts: Number(s.attempts ?? 1),
      detailPreview: s.detail ? String(s.detail).slice(0, 160) : undefined,
    })),
  };
}

/** 仅读 EW 执行结果（execute 模式可能无 dyflow-state） */
export function buildWorkflowRunView(workDir: string): WorkflowRunView | null {
  return readWorkflowRun(workDir);
}

export function buildDyflowInspectorPayload(workDir: string): DyflowInspectorPayload {
  const brainDir = path.join(workDir, '.brain');
  const stateRaw = readJsonFile<{ mode?: string; burstId?: string }>(
    path.join(brainDir, 'dyflow-state.json'),
  );
  const state =
    stateRaw?.mode != null
      ? { mode: String(stateRaw.mode), burstId: stateRaw.burstId }
      : null;

  const dagRaw = readJsonFile<LocalDag>(path.join(brainDir, 'local_dag.json'));
  const memRaw = readJsonFile<InnerMemory>(path.join(brainDir, 'memory.json'));

  let dag: DyflowInspectorPayload['dag'] = null;
  if (dagRaw?.nodes?.length) {
    const { edges, impliedEdges } = resolveDagEdges(dagRaw);
    const statuses = resolveDagNodeStatuses(
      dagRaw.nodes.map((n) => n.id),
      edges,
      {
        mode: state?.mode,
        nodeResults: memRaw?.node_results ?? null,
        failureNodeId: memRaw?.last_failure?.nodeInstId ?? null,
      },
    );
    dag = {
      nodeCount: dagRaw.nodes.length,
      entry: dagRaw.entry ?? dagRaw.nodes[0]?.id,
      impliedEdges,
      edges,
      nodes: dagRaw.nodes.map((n) => ({
        id: n.id,
        ref: n.ref,
        instructionPreview: (n.instruction ?? '').slice(0, 160),
        status: statuses.get(n.id) ?? 'pending',
        milestone: n.milestone,
      })),
    };
  }

  const memory = memRaw
    ? {
        goal: memRaw.goal ?? null,
        factsCount: memRaw.facts?.length ?? 0,
        constraintsCount: memRaw.constraints?.length ?? 0,
        lastFailure: memRaw.last_failure
          ? {
              summary: memRaw.last_failure.summary.slice(0, 500),
              transient: memRaw.last_failure.transient,
              localRef: memRaw.last_failure.localRef,
              nodeInstId: memRaw.last_failure.nodeInstId,
            }
          : null,
        nodeResults: Object.entries(memRaw.node_results ?? {}).map(([id, r]) => ({
          id,
          ref: r.ref,
          ok: r.ok,
        })),
      }
    : null;

  return {
    engine: 'dyflow',
    state,
    dag,
    memory,
    localNodes: listLocalNodeSummaries(brainDir),
    workflowRun: readWorkflowRun(workDir),
  };
}

/** 列表轮询路径：超过此体积的 memory.json 不再整文件 JSON.parse（实测可达 0.5–1MB）。 */
const LIST_MEMORY_MAX_BYTES = 64 * 1024;

function readJsonFileIfSmall<T>(filePath: string, maxBytes: number): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    if (fs.statSync(filePath).size > maxBytes) return null;
  } catch {
    return null;
  }
  return readJsonFile<T>(filePath);
}

/**
 * 列表行用的轻量摘要。
 *
 * 只读 dyflow-state + local_dag；memory.json 仅在 ≤64KB 时取 last_failure。
 * **不**走 `buildDyflowInspectorPayload`（会扫 local_nodes），也避免每 3–8s
 * 对分页 20 行整读大 memory。
 */
export function summarizeDyflowForList(workDir: string): {
  dyflow_mode: string | null;
  dyflow_dag_nodes: number | null;
  dyflow_failure: string | null;
  dyflow_progress: string | null;
} {
  const brainDir = path.join(workDir, '.brain');
  const stateRaw = readJsonFile<{ mode?: string }>(path.join(brainDir, 'dyflow-state.json'));
  if (!stateRaw) {
    return {
      dyflow_mode: null,
      dyflow_dag_nodes: null,
      dyflow_failure: null,
      dyflow_progress: null,
    };
  }
  const dagRaw = readJsonFile<LocalDag>(path.join(brainDir, 'local_dag.json'));
  const memRaw = readJsonFileIfSmall<InnerMemory>(
    path.join(brainDir, 'memory.json'),
    LIST_MEMORY_MAX_BYTES,
  );
  const nodeCount = dagRaw?.nodes?.length ?? 0;
  const done = memRaw?.node_results
    ? Object.values(memRaw.node_results).filter((r) => r.ok).length
    : null;
  return {
    dyflow_mode: stateRaw.mode != null ? String(stateRaw.mode) : null,
    dyflow_dag_nodes: nodeCount > 0 ? nodeCount : null,
    dyflow_failure: memRaw?.last_failure?.summary?.slice(0, 80) ?? null,
    dyflow_progress:
      nodeCount > 0 && done != null ? `${done}/${nodeCount}` : null,
  };
}
