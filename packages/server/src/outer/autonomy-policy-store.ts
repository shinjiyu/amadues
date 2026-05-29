import fs from 'node:fs';
import path from 'node:path';

import type { AutonomyPolicy, AutonomyTaskTypeConfig } from './autonomy-types.js';

const POLICY_DIR = 'autonomy';
const POLICY_FILE = 'policy.json';

const DEFAULT_TASK_TYPES: Record<string, AutonomyTaskTypeConfig> = {
  casual_chat: { enabled: true, cooldownMs: 3_600_000, maxPerDay: 8 },
  kpi_inner_goal: { enabled: true, cooldownMs: 7_200_000, maxPerDay: 3 },
};

export function defaultAutonomyPolicy(now = new Date().toISOString()): AutonomyPolicy {
  const envChatP = process.env['UTLRA_AUTONOMY_ENABLED'];
  return {
    version: 1,
    enabled: envChatP !== '0',
    hardGates: {
      maxRunningInnerBrains: 3,
      maxAwaitingInnerBrains: 3,
      maxLlmInFlight: 2,
      maxTokensPerHour: null,
      minMsSinceLastAutonomousAction: 900_000,
      blockIfOrchestratorQueuedAbove: 2,
      blockIfOuterLoopActive: true,
    },
    taskTypes: { ...DEFAULT_TASK_TYPES },
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
  const out = { ...DEFAULT_TASK_TYPES, ...base };
  for (const key of Object.keys(out)) {
    out[key] = { ...DEFAULT_TASK_TYPES[key], ...out[key] };
  }
  return out;
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
    return {
      ...base,
      ...raw,
      version: 1,
      hardGates: { ...base.hardGates, ...(raw.hardGates ?? {}) },
      taskTypes: mergeTaskTypes(raw.taskTypes ?? {}),
      updatedAt: raw.updatedAt ?? base.updatedAt,
      updatedBy: raw.updatedBy ?? 'system',
    };
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
  saveAutonomyPolicy(dataRoot, next);
  return next;
}

export function markAutonomousAction(dataRoot: string): void {
  const policy = loadAutonomyPolicy(dataRoot);
  policy.lastAutonomousActionAt = new Date().toISOString();
  policy.updatedAt = policy.lastAutonomousActionAt;
  saveAutonomyPolicy(dataRoot, policy);
}
