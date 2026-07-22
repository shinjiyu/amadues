/**
 * DyFlow 内脑快照（Dashboard brain-inspector / 列表 enrichment）
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §12
 */
import fs from 'node:fs';
import path from 'node:path';

import type { InnerMemory, LocalDag, LocalNodeIndex } from './types.js';

export type DyflowInspectorPayload = {
  engine: 'dyflow';
  state: { mode: string; burstId?: string } | null;
  dag: {
    nodeCount: number;
    nodes: Array<{ id: string; ref: string; instructionPreview: string }>;
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
  const dag = dagRaw?.nodes?.length
    ? {
        nodeCount: dagRaw.nodes.length,
        nodes: dagRaw.nodes.map((n) => ({
          id: n.id,
          ref: n.ref,
          instructionPreview: (n.instruction ?? '').slice(0, 160),
        })),
      }
    : null;

  const memRaw = readJsonFile<InnerMemory>(path.join(brainDir, 'memory.json'));
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
} {
  const brainDir = path.join(workDir, '.brain');
  const stateRaw = readJsonFile<{ mode?: string }>(path.join(brainDir, 'dyflow-state.json'));
  if (!stateRaw) {
    return { dyflow_mode: null, dyflow_dag_nodes: null, dyflow_failure: null };
  }
  const dagRaw = readJsonFile<LocalDag>(path.join(brainDir, 'local_dag.json'));
  const memRaw = readJsonFileIfSmall<InnerMemory>(
    path.join(brainDir, 'memory.json'),
    LIST_MEMORY_MAX_BYTES,
  );
  return {
    dyflow_mode: stateRaw.mode != null ? String(stateRaw.mode) : null,
    dyflow_dag_nodes: dagRaw?.nodes?.length ?? null,
    dyflow_failure: memRaw?.last_failure?.summary?.slice(0, 80) ?? null,
  };
}
