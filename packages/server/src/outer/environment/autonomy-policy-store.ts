/**
 * 闲忙规则持久化 — ADL ENVIRONMENT-MODEL.md / DIGITAL-EMPLOYEE-AUTONOMY.md DE-4
 *
 * DE-4：KPI 找活不存在时间配额概念。`kpi_inner_goal` 只有 enabled 开关；
 * `cooldownMs`/`maxPerDay` 仅保留给 IM 输出类任务（casual_chat 防刷屏）。
 * 旧 policy.json 中的 KPI 配额字段与 `minMsSinceLastAutonomousAction` 在 load 时删除并回写。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { AutonomyPolicy, AutonomyTaskTypeConfig } from '../autonomy-types.js';

const POLICY_DIR = 'autonomy';
const POLICY_FILE = 'policy.json';

const DEFAULT_TASK_TYPES: Record<string, AutonomyTaskTypeConfig> = {
  casual_chat: { enabled: true, cooldownMs: 3_600_000, maxPerDay: 8 },
  kpi_inner_goal: { enabled: true },
};

export function defaultAutonomyPolicy(now = new Date().toISOString()): AutonomyPolicy {
  const envChatP = process.env['UTLRA_AUTONOMY_ENABLED'];
  return {
    version: 1,
    enabled: envChatP !== '0',
    hardGates: {
      maxRunningInnerBrains: 3,
      maxAwaitingInnerBrains: 3,
      maxParallelBurstsPerKpi: 1,
      maxLlmInFlight: 2,
      maxTokensPerHour: null,
      blockIfOrchestratorQueuedAbove: 2,
      // 前台对话只走 foregroundReserveSlots 预留，不全停；true 仅兼容 advance 路径。
      blockIfOuterLoopActive: false,
      foregroundReserveSlots: 1,
    },
    taskTypes: structuredClone(DEFAULT_TASK_TYPES),
    lastAutonomousActionAt: null,
    updatedAt: now,
    updatedBy: 'default',
  };
}

function policyPath(dataRoot: string): string {
  return path.join(dataRoot, POLICY_DIR, POLICY_FILE);
}

function mergeTaskTypes(
  base: Record<string, AutonomyTaskTypeConfig>,
): Record<string, AutonomyTaskTypeConfig> {
  const out = { ...structuredClone(DEFAULT_TASK_TYPES), ...base };
  for (const key of Object.keys(out)) {
    out[key] = { ...DEFAULT_TASK_TYPES[key], ...out[key] };
  }
  return out;
}

/**
 * DE-4：从 policy 中**删除**旧心跳节流概念（不是设成中性值）：
 * - `hardGates.minMsSinceLastAutonomousAction` 字段删除
 * - `taskTypes.kpi_inner_goal` 仅保留 `enabled`
 */
export function normalizeDigitalEmployeePolicy(policy: AutonomyPolicy): {
  policy: AutonomyPolicy;
  changed: boolean;
} {
  let changed = false;

  const hardGates = { ...policy.hardGates } as Record<string, unknown>;
  if ('minMsSinceLastAutonomousAction' in hardGates) {
    delete hardGates['minMsSinceLastAutonomousAction'];
    changed = true;
  }

  const taskTypes = { ...policy.taskTypes };
  const kpi = taskTypes.kpi_inner_goal;
  if (!kpi) {
    taskTypes.kpi_inner_goal = { enabled: true };
    changed = true;
  } else if (kpi.cooldownMs !== undefined || kpi.maxPerDay !== undefined) {
    taskTypes.kpi_inner_goal = { enabled: kpi.enabled };
    changed = true;
  }

  if (!changed) return { policy, changed: false };
  return {
    policy: {
      ...policy,
      hardGates: hardGates as unknown as AutonomyPolicy['hardGates'],
      taskTypes,
      updatedAt: new Date().toISOString(),
      updatedBy: 'system',
    },
    changed: true,
  };
}

export function loadAutonomyPolicy(dataRoot: string): AutonomyPolicy {
  const fp = policyPath(dataRoot);
  if (!fs.existsSync(fp)) {
    const policy = defaultAutonomyPolicy();
    saveAutonomyPolicy(dataRoot, policy);
    return policy;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8')) as Partial<AutonomyPolicy>;
    const base = defaultAutonomyPolicy();
    const merged: AutonomyPolicy = {
      ...base,
      ...raw,
      version: 1,
      hardGates: { ...base.hardGates, ...(raw.hardGates ?? {}) },
      taskTypes: mergeTaskTypes(raw.taskTypes ?? {}),
      updatedAt: raw.updatedAt ?? base.updatedAt,
      updatedBy: raw.updatedBy ?? 'system',
    };
    const { policy, changed } = normalizeDigitalEmployeePolicy(merged);
    if (changed) saveAutonomyPolicy(dataRoot, policy);
    return policy;
  } catch {
    return defaultAutonomyPolicy();
  }
}

export function saveAutonomyPolicy(dataRoot: string, policy: AutonomyPolicy): void {
  const dir = path.join(dataRoot, POLICY_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const fp = policyPath(dataRoot);
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(policy, null, 2), 'utf8');
  fs.renameSync(tmp, fp);
}

export function patchAutonomyPolicy(
  dataRoot: string,
  patch: Partial<{
    enabled: boolean;
    hardGates: Partial<AutonomyPolicy['hardGates']>;
    taskTypes: Record<string, Partial<AutonomyTaskTypeConfig>>;
  }>,
): AutonomyPolicy {
  const current = loadAutonomyPolicy(dataRoot);
  const next: AutonomyPolicy = {
    ...current,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    hardGates: patch.hardGates ? { ...current.hardGates, ...patch.hardGates } : current.hardGates,
    taskTypes: patch.taskTypes
      ? mergeTaskTypes({ ...current.taskTypes, ...patch.taskTypes } as Record<string, AutonomyTaskTypeConfig>)
      : current.taskTypes,
    updatedAt: new Date().toISOString(),
    updatedBy: 'system',
  };
  const { policy } = normalizeDigitalEmployeePolicy(next);
  saveAutonomyPolicy(dataRoot, policy);
  return policy;
}

export function markAutonomousAction(dataRoot: string): void {
  const policy = loadAutonomyPolicy(dataRoot);
  policy.lastAutonomousActionAt = new Date().toISOString();
  policy.updatedAt = policy.lastAutonomousActionAt;
  saveAutonomyPolicy(dataRoot, policy);
}
