/**
 * Executable Workflow — types (ADL: EXECUTABLE-WORKFLOW.md)
 */
export type WorkflowKind =
  | 'skill_md'
  | 'browser_playbook'
  | 'frozen_dag'
  | 'shell_pipeline'
  | 'kpi_sequence';

export type BurstMode = 'explore' | 'execute';

export type WorkflowStepFailPolicy = 'retry_same' | 'abort_escalate' | 'fallback_explore';

export type WorkflowStepAction =
  | 'shell'
  | 'browser_steps'
  | 'run_node'
  | 'assert'
  | 'skill_step'
  | 'kpi_charter';

export interface WorkflowStepExpect {
  /** 期望进程退出码（shell） */
  exitCode?: number;
  /** 相对 workDir 的文件必须存在 */
  fileExists?: string;
  /** 输出/日志须包含（子串） */
  stdoutContains?: string;
  /** 自定义说明（机检仍靠上面字段） */
  note?: string;
}

export interface WorkflowStep {
  id: string;
  action: WorkflowStepAction;
  args?: Record<string, unknown>;
  expect: WorkflowStepExpect;
}

export interface WorkflowFailurePolicy {
  onStepFail: WorkflowStepFailPolicy;
  maxRetries: number;
}

export interface WorkflowSource {
  agentId?: string;
  workspaceId?: string;
  promotedAt: string;
  fromArtifacts?: string[];
}

export interface ExecutableWorkflow {
  id: string;
  version: string;
  kind: WorkflowKind;
  title: string;
  tags: string[];
  entry: string;
  steps: WorkflowStep[];
  failurePolicy: WorkflowFailurePolicy;
  source: WorkflowSource;
  bodyRef?: string;
}

export interface WorkflowRef {
  id: string;
  version: string;
}

export interface WorkflowMeta {
  schema: 'executable-workflow.meta.v1';
  id: string;
  kind: WorkflowKind;
  title: string;
  latestVersion: string;
  tags: string[];
  updatedAt: string;
  paused?: boolean;
}

export const DEFAULT_FAILURE_POLICY: WorkflowFailurePolicy = {
  onStepFail: 'abort_escalate',
  maxRetries: 1,
};

export const WORKFLOW_KINDS: readonly WorkflowKind[] = [
  'skill_md',
  'browser_playbook',
  'frozen_dag',
  'shell_pipeline',
  'kpi_sequence',
] as const;
