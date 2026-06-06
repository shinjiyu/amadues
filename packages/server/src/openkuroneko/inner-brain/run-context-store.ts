/**
 * RunContext — RUN 结束 → ATTRIBUTE 读的临时执行快照。
 *
 * ADL：doc/structurizr/DYFLOW-ATTRIBUTION.md §3
 */

import fs from 'node:fs';
import path from 'node:path';

import type { ExecutionEntry } from '../brain/index.js';
import type { LocalDag, NodeOutcomeStatus, NodeResult } from './types.js';
import type { NodeExecutionRecord, RunnerResult } from './runner.js';

export interface RunContextNodeLog {
  nodeInstId: string;
  ref: string;
  ok: boolean;
  status?: NodeOutcomeStatus;
  instruction?: string;
  deliverable?: string;
  failureSummary?: string;
  rawTail?: string;
  entries: ExecutionEntry[];
}

export interface RunContext {
  burstId: string;
  designedAt: string;
  finishedAt: string;
  ok: boolean;
  failedAt?: string;
  dagNotes?: string;
  nodes: RunContextNodeLog[];
  /** 本轮 RUN 的 NodeResult 快照（failure-distill 用） */
  results: NodeResult[];
}

const FILE = 'run-context.json';

function runContextPath(workDir: string): string {
  return path.join(workDir, '.brain', FILE);
}

export function buildRunContext(dag: LocalDag, res: RunnerResult): RunContext {
  const byId = new Map(dag.nodes.map(n => [n.id, n]));
  const nodes: RunContextNodeLog[] = res.executionRecords.map(rec => {
    const inst = byId.get(rec.nodeInstId);
    return {
      nodeInstId: rec.nodeInstId,
      ref: rec.ref,
      ok: rec.ok,
      ...(rec.status ? { status: rec.status } : {}),
      ...(inst?.instruction ? { instruction: inst.instruction.slice(0, 500) } : {}),
      ...(inst?.deliverable?.summary ? { deliverable: inst.deliverable.summary } : {}),
      ...(rec.failureSummary ? { failureSummary: rec.failureSummary } : {}),
      ...(rec.rawTail ? { rawTail: rec.rawTail } : {}),
      entries: rec.executionLog,
    };
  });
  return {
    burstId: dag.burstId,
    designedAt: dag.designedAt,
    finishedAt: new Date().toISOString(),
    ok: res.ok,
    ...(res.failedAt ? { failedAt: res.failedAt } : {}),
    ...(dag.notes ? { dagNotes: dag.notes } : {}),
    nodes,
    results: res.results,
  };
}

export function writeRunContext(workDir: string, ctx: RunContext): void {
  const p = runContextPath(workDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(ctx, null, 2), 'utf8');
}

export function readRunContext(workDir: string): RunContext | null {
  try {
    const raw = fs.readFileSync(runContextPath(workDir), 'utf8');
    const parsed = JSON.parse(raw) as RunContext;
    if (!parsed || !Array.isArray(parsed.nodes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearRunContext(workDir: string): void {
  try {
    fs.unlinkSync(runContextPath(workDir));
  } catch { /* absent ok */ }
}
