/**
 * Promote 建议（不写入）— ADL EXECUTABLE-WORKFLOW.md §8.2
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PromoteWorkflowInput } from './workflow-promote.js';
import type { WorkflowKind, WorkflowStep } from './executable-workflow-types.js';
import { normalizePlaybookSteps } from '../openkuroneko/browser/browser-playbook.js';

export interface PromoteSuggestion {
  kind: WorkflowKind;
  title: string;
  suggestedId: string;
  reason: string;
  fromArtifacts: string[];
  /** 可直接喂给 promoteWorkflow 的草稿（仍须人工/工具确认） */
  draft: PromoteWorkflowInput;
}

function safeIdSlug(workspaceId: string, kind: string): string {
  const base = workspaceId.replace(/^task-/, '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 24);
  return `ew-${kind}-${base || 'ws'}`;
}

function resolveUnder(workDir: string, rel: string): string | null {
  const abs = path.resolve(workDir, rel);
  if (!abs.startsWith(path.resolve(workDir))) return null;
  return abs;
}

function suggestFromDag(workDir: string, workspaceId: string): PromoteSuggestion | null {
  const rel = '.brain/local_dag.json';
  const abs = resolveUnder(workDir, rel);
  if (!abs || !fs.existsSync(abs)) return null;
  let dag: unknown;
  try {
    dag = JSON.parse(fs.readFileSync(abs, 'utf8')) as unknown;
  } catch {
    return null;
  }
  if (!dag || typeof dag !== 'object' || !Array.isArray((dag as { nodes?: unknown }).nodes)) {
    return null;
  }
  const nodes = (dag as { nodes: unknown[] }).nodes;
  if (nodes.length === 0) return null;
  const steps: WorkflowStep[] = [
    {
      id: 'frozen',
      action: 'run_node',
      args: { dag },
      expect: { fileExists: '.run/frozen_dag_ready.json', stdoutContains: 'frozen_nodes=' },
    },
  ];
  const suggestedId = safeIdSlug(workspaceId, 'dag');
  const draft: PromoteWorkflowInput = {
    id: suggestedId,
    kind: 'frozen_dag',
    title: `Frozen DAG from ${workspaceId}`,
    tags: [],
    steps,
    source: { workspaceId, fromArtifacts: [rel] },
  };
  return {
    kind: 'frozen_dag',
    title: draft.title,
    suggestedId,
    reason: `found ${rel} with ${nodes.length} nodes`,
    fromArtifacts: [rel],
    draft,
  };
}

function suggestFromPlaybook(workDir: string, workspaceId: string): PromoteSuggestion | null {
  const candidates = ['.run/playbook-prepared.json', '.brain/browser-playbook.json'];
  for (const rel of candidates) {
    const abs = resolveUnder(workDir, rel);
    if (!abs || !fs.existsSync(abs)) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(abs, 'utf8')) as unknown;
    } catch {
      continue;
    }
    const norm = normalizePlaybookSteps(raw);
    if ('error' in norm) continue;
    const steps: WorkflowStep[] = [
      {
        id: 'playbook',
        action: 'browser_steps',
        args: { steps: norm.steps, dryRun: true },
        expect: { fileExists: '.run/playbook-prepared.json', stdoutContains: 'playbook_steps=' },
      },
    ];
    const suggestedId = safeIdSlug(workspaceId, 'playbook');
    const draft: PromoteWorkflowInput = {
      id: suggestedId,
      kind: 'browser_playbook',
      title: `Browser playbook from ${workspaceId}`,
      tags: [],
      steps,
      source: { workspaceId, fromArtifacts: [rel] },
    };
    return {
      kind: 'browser_playbook',
      title: draft.title,
      suggestedId,
      reason: `found ${rel} with ${norm.steps.length} steps`,
      fromArtifacts: [rel],
      draft,
    };
  }
  return null;
}

function suggestFromWorkflowRun(workDir: string, workspaceId: string): PromoteSuggestion | null {
  const rel = '.run/workflow_run.json';
  const abs = resolveUnder(workDir, rel);
  if (!abs || !fs.existsSync(abs)) return null;
  try {
    const run = JSON.parse(fs.readFileSync(abs, 'utf8')) as {
      ok?: boolean;
      workflowId?: string;
      version?: string;
    };
    if (!run.ok) return null;
    // 已是 execute 成功迹：提示「可 bump 版本重晋升」而非自动再写
    return {
      kind: 'shell_pipeline',
      title: `Re-promote successful run ${run.workflowId ?? '?'}@${run.version ?? '?'}`,
      suggestedId: run.workflowId?.trim() || safeIdSlug(workspaceId, 'rerun'),
      reason: `${rel} ok=true — consider bumping version if explore improved the path`,
      fromArtifacts: [rel],
      draft: {
        id: run.workflowId?.trim() || safeIdSlug(workspaceId, 'rerun'),
        kind: 'shell_pipeline',
        title: `Re-promote ${run.workflowId ?? workspaceId}`,
        steps: [
          {
            id: 'assert-ok',
            action: 'assert',
            expect: { fileExists: rel },
          },
        ],
        source: { workspaceId, fromArtifacts: [rel] },
      },
    };
  } catch {
    return null;
  }
}

/**
 * 扫描 workspace，返回 0..N 条建议。**永不**调用 promoteWorkflow / store.put。
 */
export function suggestPromoteFromWorkspace(
  workDir: string,
  workspaceId?: string,
): PromoteSuggestion[] {
  const wsId = (workspaceId?.trim() || path.basename(workDir)).trim() || 'workspace';
  if (!fs.existsSync(workDir)) return [];
  const out: PromoteSuggestion[] = [];
  const dag = suggestFromDag(workDir, wsId);
  if (dag) out.push(dag);
  const pb = suggestFromPlaybook(workDir, wsId);
  if (pb) out.push(pb);
  // 成功 run 仅在无 dag/playbook 时作为弱提示，避免重复噪声
  if (out.length === 0) {
    const run = suggestFromWorkflowRun(workDir, wsId);
    if (run) out.push(run);
  }
  return out;
}
