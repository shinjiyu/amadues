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
  /**
   * W11：execute 时从 keychain 注入的密钥。
   * key = 注入名（shell → 环境变量；browser 常用 `COOKIES` → 写 `.run/ew/cookies.json`）
   * value = keychain entry key（禁止明文写入契约）
   */
  secretRefs?: Record<string, string>;
}

/** W13：随契约打包的相对文件（execute 前物化到 workDir） */
export interface WorkflowAsset {
  /** 相对 workDir，如 `.run/ew/fetch_tweets.py` */
  path: string;
  /** utf8 正文 */
  content: string;
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
  /** W13：辅助脚本等，execute 时写入 workDir */
  assets?: WorkflowAsset[];
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

/** Runner 可执行的 action 白名单（W5） */
export const WORKFLOW_STEP_ACTIONS: readonly WorkflowStepAction[] = [
  'shell',
  'browser_steps',
  'run_node',
  'assert',
  'skill_step',
  'kpi_charter',
] as const;

