/**
 * Promote explore artifacts → versioned Executable Workflow.
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md §6
 */
import {
  DEFAULT_FAILURE_POLICY,
  WORKFLOW_KINDS,
  type ExecutableWorkflow,
  type WorkflowKind,
  type WorkflowStep,
  type WorkflowStepExpect,
} from './executable-workflow-types.js';
import {
  ExecutableWorkflowStore,
  nextIntegerVersion,
} from './executable-workflow-store.js';
import type { WorkflowDrive9Store } from '../drive9/workflow-drive9-store.js';

export class WorkflowPromoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowPromoteError';
  }
}

export interface PromoteWorkflowInput {
  id: string;
  kind: WorkflowKind;
  title: string;
  tags?: string[];
  entry?: string;
  steps: WorkflowStep[];
  failurePolicy?: ExecutableWorkflow['failurePolicy'];
  source?: {
    agentId?: string;
    workspaceId?: string;
    fromArtifacts?: string[];
  };
  bodyRef?: string;
}

/** W3：每步必须有可机检 expect */
export function assertStepExpect(step: WorkflowStep, index: number): void {
  if (!step?.id?.trim()) {
    throw new WorkflowPromoteError(`step[${index}]: id required`);
  }
  if (!step.action) {
    throw new WorkflowPromoteError(`step[${index}] ${step.id}: action required`);
  }
  const e = step.expect;
  if (!e || typeof e !== 'object') {
    throw new WorkflowPromoteError(`step[${index}] ${step.id}: expect required (W3)`);
  }
  if (!hasMechanicalExpect(e)) {
    throw new WorkflowPromoteError(
      `step[${index}] ${step.id}: expect must include exitCode | fileExists | stdoutContains (W3)`,
    );
  }
}

export function hasMechanicalExpect(e: WorkflowStepExpect): boolean {
  return (
    e.exitCode !== undefined ||
    Boolean(e.fileExists?.trim()) ||
    Boolean(e.stdoutContains?.trim())
  );
}

export function validatePromoteDraft(input: PromoteWorkflowInput): void {
  if (!input.id?.trim()) throw new WorkflowPromoteError('id required');
  if (!WORKFLOW_KINDS.includes(input.kind)) {
    throw new WorkflowPromoteError(`unknown kind ${input.kind}`);
  }
  if (!input.title?.trim()) throw new WorkflowPromoteError('title required');
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new WorkflowPromoteError('steps must be non-empty');
  }
  input.steps.forEach((s, i) => assertStepExpect(s, i));
}

export interface PromoteWorkflowOptions {
  /** 可选：晋升后同步 drive9 /workflows/shared/ */
  drive9?: WorkflowDrive9Store | null;
}

/**
 * 校验并写入新 version（不可变旧版）。返回冻结后的 EW。
 */
export function promoteWorkflow(
  store: ExecutableWorkflowStore,
  input: PromoteWorkflowInput,
  opts?: PromoteWorkflowOptions,
): ExecutableWorkflow {
  validatePromoteDraft(input);
  const meta = store.getMeta(input.id);
  const version = nextIntegerVersion(meta?.latestVersion);
  const now = new Date().toISOString();
  const wf: ExecutableWorkflow = {
    id: input.id.trim(),
    version,
    kind: input.kind,
    title: input.title.trim(),
    tags: [...(input.tags ?? [])],
    entry: (input.entry ?? input.steps[0]!.id).trim(),
    steps: input.steps.map((s) => ({
      id: s.id.trim(),
      action: s.action,
      args: s.args ? { ...s.args } : undefined,
      expect: { ...s.expect },
    })),
    failurePolicy: input.failurePolicy
      ? { ...DEFAULT_FAILURE_POLICY, ...input.failurePolicy }
      : { ...DEFAULT_FAILURE_POLICY },
    source: {
      agentId: input.source?.agentId,
      workspaceId: input.source?.workspaceId,
      promotedAt: now,
      fromArtifacts: input.source?.fromArtifacts,
    },
    bodyRef: input.bodyRef,
  };
  store.put(wf);
  opts?.drive9?.storeShared(wf);
  return wf;
}
