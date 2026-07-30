/**
 * Promote explore artifacts → versioned Executable Workflow.
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md §6 · W3/W5–W13
 */
import path from 'node:path';
import {
  DEFAULT_FAILURE_POLICY,
  WORKFLOW_KINDS,
  WORKFLOW_STEP_ACTIONS,
  type ExecutableWorkflow,
  type WorkflowAsset,
  type WorkflowKind,
  type WorkflowStep,
  type WorkflowStepAction,
  type WorkflowStepExpect,
} from './executable-workflow-types.js';
import {
  ExecutableWorkflowStore,
  nextIntegerVersion,
} from './executable-workflow-store.js';
import type { WorkflowDrive9Store } from '../drive9/workflow-drive9-store.js';
import {
  assertScriptsBundled,
  collectWorkflowAssetsFromWorkDir,
} from './workflow-assets.js';

/** W9：允许在 shell 中裸用的环境变量（系统/壳自带，非步间传递） */
const SHELL_ENV_ALLOWLIST = new Set([
  'HOME',
  'PATH',
  'PWD',
  'USER',
  'USERNAME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SHELL',
  'LANG',
  'LC_ALL',
  'NODE_ENV',
  'TERM',
  'HOSTNAME',
  'RANDOM',
  'UID',
  'EUID',
  'OLDPWD',
  'IFS',
  'OSTYPE',
  'BASH_VERSION',
  'ZSH_VERSION',
]);

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
  /** W13：显式 assets；缺省时若有 workDir 则从 shell 引用自动收集 */
  assets?: WorkflowAsset[];
}

/**
 * W11：把误写在 args.secretRefs 的项提升到顶层，并从 args 删除。
 */
export function hoistSecretRefs(step: WorkflowStep): WorkflowStep {
  const args = step.args ? { ...step.args } : undefined;
  const fromArgs =
    args && typeof args['secretRefs'] === 'object' && args['secretRefs'] !== null
      ? (args['secretRefs'] as Record<string, unknown>)
      : undefined;
  if (args && 'secretRefs' in args) delete args['secretRefs'];

  const merged: Record<string, string> = { ...(step.secretRefs ?? {}) };
  if (fromArgs) {
    for (const [k, v] of Object.entries(fromArgs)) {
      const key = k.trim();
      const val = String(v ?? '').trim();
      if (key && val) merged[key] = val;
    }
  }
  return {
    ...step,
    args: args && Object.keys(args).length > 0 ? args : undefined,
    ...(Object.keys(merged).length > 0 ? { secretRefs: merged } : {}),
  };
}

export function normalizePromoteSteps(steps: WorkflowStep[]): WorkflowStep[] {
  return steps.map((s) => hoistSecretRefs(s));
}

function wrapAssetErr(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  throw new WorkflowPromoteError(msg);
}

/** 常见误用：内脑工具名 → 应改用的 EW action 提示 */
const TOOL_NAME_HINTS: Record<string, string> = {
  shell_exec: 'shell（args.command）',
  shell_probe: 'shell（args.command）',
  browser_open: 'browser_steps（args.steps|playbook）',
  browser_act: 'browser_steps（args.steps|playbook）',
  browser_close: 'browser_steps（args.steps|playbook）',
  browser_run_steps: 'browser_steps（args.steps|playbook）',
  write_file: 'shell 写文件，或 assert/skill_step + expect.fileExists',
  edit_file: 'shell / assert',
  read_file: 'assert + expect，或并入 shell',
  register_deliverable: 'assert + expect.fileExists（产物路径）',
  web_search: '勿写入 EW；探索用工具，稳定后用 shell/browser_steps 固化',
  read_peer_file: 'shell / assert（路径写死）',
};

export function hasMechanicalExpect(e: WorkflowStepExpect): boolean {
  return (
    e.exitCode !== undefined ||
    Boolean(e.fileExists?.trim()) ||
    Boolean(e.stdoutContains?.trim())
  );
}

function isAllowedAction(action: string): action is WorkflowStepAction {
  return (WORKFLOW_STEP_ACTIONS as readonly string[]).includes(action);
}

/** W5：action 白名单 */
export function assertStepAction(step: WorkflowStep, index: number): void {
  const action = String(step?.action ?? '').trim();
  if (!action) {
    throw new WorkflowPromoteError(`step[${index}] ${step?.id ?? '?'}: action required (W5)`);
  }
  if (!isAllowedAction(action)) {
    const hint = TOOL_NAME_HINTS[action];
    throw new WorkflowPromoteError(
      `step[${index}] ${step.id}: unknown action "${action}" (W5；仅允许 ${WORKFLOW_STEP_ACTIONS.join('|')})` +
        (hint ? `；若想表达「${action}」请改用 ${hint}` : ''),
    );
  }
}

/** W6：按 action 必填 args */
export function assertStepArgs(step: WorkflowStep, index: number): void {
  const action = step.action;
  const args = step.args ?? {};
  const label = `step[${index}] ${step.id}`;

  switch (action) {
    case 'shell': {
      const cmd = typeof args['command'] === 'string' ? args['command'].trim() : '';
      if (!cmd) {
        throw new WorkflowPromoteError(`${label}: shell 需要 args.command（W6；禁止空壳）`);
      }
      break;
    }
    case 'browser_steps': {
      const hasSteps = args['steps'] != null || args['playbook'] != null;
      const hasPath =
        typeof args['playbookPath'] === 'string' && Boolean(args['playbookPath'].trim());
      if (!hasSteps && !hasPath) {
        throw new WorkflowPromoteError(
          `${label}: browser_steps 需要 args.steps|playbook|playbookPath（W6）`,
        );
      }
      break;
    }
    case 'run_node': {
      const hasDag = args['dag'] != null;
      const hasPath = typeof args['dagPath'] === 'string' && Boolean(args['dagPath'].trim());
      if (!hasDag && !hasPath) {
        throw new WorkflowPromoteError(`${label}: run_node 需要 args.dag|dagPath（W6）`);
      }
      break;
    }
    case 'kpi_charter': {
      const charter = typeof args['charter'] === 'string' ? args['charter'].trim() : '';
      if (!charter) {
        throw new WorkflowPromoteError(`${label}: kpi_charter 需要 args.charter（W6）`);
      }
      break;
    }
    case 'assert':
    case 'skill_step':
      break;
    default:
      break;
  }
}

/** 收集 step 内所有字符串（args + expect），供 W8 扫描 */
export function collectStepStrings(step: WorkflowStep): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      out.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (v && typeof v === 'object') {
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
    }
  };
  walk(step.args);
  walk(step.expect);
  return out;
}

/**
 * W8：拒绝对外 workspace 绝对路径 / 非相对 file 路径。
 * 典型坏例：`cd /data/workspaces/task-ib-…`（微博粉丝快照 v15）。
 */
export function assertStepPortability(step: WorkflowStep, index: number): void {
  const label = `step[${index}] ${step.id}`;
  const blobs = collectStepStrings(step);

  for (const s of blobs) {
    if (/[/\\]data[/\\]workspaces[/\\]/i.test(s) || /[/\\]workspaces[/\\]task-ib-/i.test(s)) {
      throw new WorkflowPromoteError(
        `${label}: 禁止写死其它/历史 workspace 路径（W8；shell cwd 已是当前 workDir，用相对路径如 workspace/… 或 .run/ew/…）`,
      );
    }
    if (/\btask-ib-[a-z0-9]+-[a-z0-9]+\b/i.test(s) && /[/\\]/.test(s)) {
      throw new WorkflowPromoteError(
        `${label}: 禁止在路径中写死 task-ib-* workspace id（W8；契约须可移植到新 burst）`,
      );
    }
  }

  const fe = step.expect?.fileExists?.trim();
  if (fe && (path.isAbsolute(fe) || /^[a-zA-Z]:[\\/]/.test(fe))) {
    throw new WorkflowPromoteError(
      `${label}: expect.fileExists 必须相对 workDir（W8），收到绝对路径 "${fe}"`,
    );
  }

  const args = step.args ?? {};
  for (const key of ['playbookPath', 'dagPath', 'touch'] as const) {
    const p = typeof args[key] === 'string' ? String(args[key]).trim() : '';
    if (p && (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p))) {
      throw new WorkflowPromoteError(
        `${label}: args.${key} 必须相对 workDir（W8），收到 "${p}"`,
      );
    }
  }
}

/** 从 shell 命令中抽出 `$VAR` / `${VAR}`（忽略 `$?` `$1` `$#` 等） */
export function extractShellVarRefs(command: string): string[] {
  const names = new Set<string>();
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const name = (m[1] ?? m[2] ?? '').trim();
    if (name) names.add(name);
  }
  return [...names];
}

/** 同一步内 `VAR=…` / `export VAR=…` 赋值名 */
export function extractShellAssignments(command: string): Set<string> {
  const names = new Set<string>();
  const re = /(?:^|[;&|]\s*|\n\s*)(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const name = (m[1] ?? '').trim();
    if (name) names.add(name);
  }
  return names;
}

/**
 * W9：每步 shell 独立进程 — 引用的自定义变量必须在同一步内赋值，或来自 W11 secretRefs。
 * 跨步中间态写相对文件（推荐 `.run/ew/`），不要靠 `$SUB` 传 cookie。
 */
export function assertStepStateLocality(step: WorkflowStep, index: number): void {
  if (step.action !== 'shell') return;
  const cmd = typeof step.args?.['command'] === 'string' ? String(step.args['command']) : '';
  if (!cmd.trim()) return;

  const label = `step[${index}] ${step.id}`;
  const assigned = extractShellAssignments(cmd);
  const fromSecrets = new Set(
    Object.keys(step.secretRefs ?? {}).map((k) => k.trim()).filter(Boolean),
  );
  const refs = extractShellVarRefs(cmd);
  const missing = refs.filter(
    (n) => !SHELL_ENV_ALLOWLIST.has(n) && !assigned.has(n) && !fromSecrets.has(n),
  );
  if (missing.length > 0) {
    throw new WorkflowPromoteError(
      `${label}: shell 引用了本步未赋值的变量 ${missing.map((n) => `$${n}`).join(', ')}（W9；步间状态请写入相对文件如 .run/ew/state.json，凭据用 secretRefs，勿依赖上一步环境变量）`,
    );
  }
}

/**
 * W10 结构预检：相对路径不得 `..` 逃出 workDir（若提供）。
 * 不做网络/真跑；真跑仍走 execute。
 */
export function assertPromoteShadowPaths(
  input: PromoteWorkflowInput,
  workDir?: string,
): void {
  if (!workDir?.trim()) return;
  const root = path.resolve(workDir);
  const checkRel = (rel: string, where: string): void => {
    const t = rel.trim();
    if (!t || path.isAbsolute(t) || /^[a-zA-Z]:[\\/]/.test(t)) return;
    const resolved = path.resolve(root, t);
    const relToRoot = path.relative(root, resolved);
    if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
      throw new WorkflowPromoteError(`${where}: 路径逃出 workDir（W10 shadow）：${t}`);
    }
  };

  input.steps.forEach((step, index) => {
    const label = `step[${index}] ${step.id}`;
    if (step.expect?.fileExists) checkRel(step.expect.fileExists, `${label} fileExists`);
    const args = step.args ?? {};
    for (const key of ['playbookPath', 'dagPath', 'touch'] as const) {
      if (typeof args[key] === 'string') checkRel(String(args[key]), `${label} ${key}`);
    }
  });
}

/** W3 + W5 + W6 + W8 + W9 + W11 */
export function assertStepExpect(step: WorkflowStep, index: number): void {
  if (!step?.id?.trim()) {
    throw new WorkflowPromoteError(`step[${index}]: id required`);
  }
  assertStepAction(step, index);
  assertStepArgs(step, index);
  const e = step.expect;
  if (!e || typeof e !== 'object') {
    throw new WorkflowPromoteError(`step[${index}] ${step.id}: expect required (W3)`);
  }
  if (!hasMechanicalExpect(e)) {
    throw new WorkflowPromoteError(
      `step[${index}] ${step.id}: expect must include exitCode | fileExists | stdoutContains (W3)`,
    );
  }
  assertStepPortability(step, index);
  assertStepStateLocality(step, index);
  assertNoPlaintextSecrets(step, index);
}

/**
 * W11：契约禁止 Cookie/Token/密码明文；用 secretRefs → keychain。
 * 典型坏例：X GraphQL steps_json 内嵌 auth_token=…; ct0=…
 */
const SECRET_LITERAL_PATTERNS: RegExp[] = [
  /\bauth_token\s*=\s*[A-Za-z0-9_%-]{16,}/i,
  /\bct0\s*=\s*[a-f0-9]{32,}/i,
  /\bguest_id\s*=\s*v1%3A[0-9]+/i,
  /\bSUB(?:P)?\s*=\s*[A-Za-z0-9_%+/=-]{20,}/,
  /Cookie\s*:\s*[^\n\r]{40,}/i,
  /\bBearer\s+[A-Za-z0-9._\-]{20,}/,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*['"]?[A-Za-z0-9_\-.]{16,}/i,
  /\bsk-[A-Za-z0-9]{20,}/,
  /-----BEGIN (?:RSA )?PRIVATE KEY-----/,
];

export function assertNoPlaintextSecrets(step: WorkflowStep, index: number): void {
  const label = `step[${index}] ${step.id}`;
  for (const s of collectStepStrings(step)) {
    for (const re of SECRET_LITERAL_PATTERNS) {
      if (re.test(s)) {
        throw new WorkflowPromoteError(
          `${label}: 禁止在 EW 契约写入明文凭据（W11；先 keychain_put，再 secretRefs 如 {"AUTH_TOKEN":"x_auth"}，execute 时注入）`,
        );
      }
    }
  }
  const refs = step.secretRefs;
  if (refs && typeof refs === 'object') {
    for (const [envName, key] of Object.entries(refs)) {
      if (!String(envName).trim() || !String(key ?? '').trim()) {
        throw new WorkflowPromoteError(
          `${label}: secretRefs 项须为非空 env名→keychain key（W11）`,
        );
      }
    }
  }
}

export function validatePromoteDraft(
  input: PromoteWorkflowInput,
  opts?: { workDir?: string },
): void {
  if (!input.id?.trim()) throw new WorkflowPromoteError('id required');
  if (!WORKFLOW_KINDS.includes(input.kind)) {
    throw new WorkflowPromoteError(`unknown kind ${input.kind}`);
  }
  if (!input.title?.trim()) throw new WorkflowPromoteError('title required');
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new WorkflowPromoteError('steps must be non-empty');
  }
  const steps = normalizePromoteSteps(input.steps);
  steps.forEach((s, i) => assertStepExpect(s, i));
  assertPromoteShadowPaths({ ...input, steps }, opts?.workDir); // W10
  try {
    assertScriptsBundled(steps, input.assets); // W13（无 workDir 收集时须已带 assets）
  } catch (e) {
    wrapAssetErr(e);
  }
}

/**
 * 审计已入库 EW 是否仍可执行（用于 pause 空壳）。
 * @returns 问题列表；空 = 可跑
 */
export function auditWorkflowSteps(wf: ExecutableWorkflow): string[] {
  const problems: string[] = [];
  try {
    validatePromoteDraft({
      id: wf.id,
      kind: wf.kind,
      title: wf.title,
      steps: wf.steps,
      assets: wf.assets,
    });
  } catch (e) {
    problems.push(e instanceof Error ? e.message : String(e));
  }
  return problems;
}

export interface PromoteWorkflowOptions {
  /** 可选：晋升后同步 drive9 /workflows/shared/ */
  drive9?: WorkflowDrive9Store | null;
  /** 可选：当前 workspace，用于 W10 shadow + W13 自动打包脚本 */
  workDir?: string;
}

/**
 * 校验并写入新 version（不可变旧版）。返回冻结后的 EW。
 */
export function promoteWorkflow(
  store: ExecutableWorkflowStore,
  input: PromoteWorkflowInput,
  opts?: PromoteWorkflowOptions,
): ExecutableWorkflow {
  const steps = normalizePromoteSteps(input.steps);
  let assets = input.assets ? [...input.assets] : undefined;
  if (opts?.workDir?.trim()) {
    try {
      assets = collectWorkflowAssetsFromWorkDir(steps, opts.workDir, assets);
    } catch (e) {
      wrapAssetErr(e);
    }
  }
  const normalized: PromoteWorkflowInput = { ...input, steps, assets };
  validatePromoteDraft(normalized, { workDir: opts?.workDir });

  const meta = store.getMeta(input.id);
  const version = nextIntegerVersion(meta?.latestVersion);
  const now = new Date().toISOString();
  const wf: ExecutableWorkflow = {
    id: input.id.trim(),
    version,
    kind: input.kind,
    title: input.title.trim(),
    tags: [...(input.tags ?? [])],
    entry: (input.entry ?? steps[0]!.id).trim(),
    steps: steps.map((s) => ({
      id: s.id.trim(),
      action: s.action,
      args: s.args ? { ...s.args } : undefined,
      expect: { ...s.expect },
      ...(s.secretRefs && Object.keys(s.secretRefs).length > 0
        ? {
            secretRefs: Object.fromEntries(
              Object.entries(s.secretRefs).map(([k, v]) => [k.trim(), String(v).trim()]),
            ),
          }
        : {}),
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
    ...(assets && assets.length > 0 ? { assets } : {}),
  };
  store.put(wf);
  opts?.drive9?.storeShared(wf);
  return wf;
}

/**
 * 扫描本地 store：对审计失败且未 pause 的 EW 执行 pause。
 * @returns paused ids
 */
export function pauseInvalidWorkflows(store: ExecutableWorkflowStore): string[] {
  const paused: string[] = [];
  for (const meta of store.list()) {
    if (meta.paused) continue;
    const wf = store.getLatest(meta.id);
    if (!wf) continue;
    const problems = auditWorkflowSteps(wf);
    if (problems.length === 0) continue;
    store.setPaused(meta.id, true);
    paused.push(meta.id);
  }
  return paused;
}
