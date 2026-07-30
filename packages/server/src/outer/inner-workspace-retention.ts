/**
 * Inner workspace retention — 终态 registry + workDir 淘汰。
 *
 * ADL：doc/structurizr/INNER-WORKSPACE-RETENTION.md
 *
 * 规则：
 *   1. 永不碰 RUNNING | AWAITING | BLOCKED
 *   2. cold：终态年龄 > coldDays → remove
 *   3. quota：终态数 > maxTerminal → 按结束时间升序删到 floor(max*(1-headroom))
 *   4. 单次 sweep 最多 maxRemovePerRun 条（默认同步 rm 不能一次清上千目录）
 */

import fs from 'node:fs';
import path from 'node:path';

import type { InnerBrainRegistry, TaskRecord, TaskStatus } from './inner-brain-registry.js';

export const TERMINAL_STATUSES = new Set<TaskStatus>([
  'DONE',
  'STOPPED',
  'ERROR',
  'ABORTED',
]);

export interface RetentionOptions {
  /** 终态条数上限（默认 400） */
  maxTerminal?: number;
  /** headroom：quota 触发时删到 max*(1-headroom)（默认 0.2） */
  headroomRatio?: number;
  /** cold 天数（默认 45） */
  coldDays?: number;
  /**
   * 单次 sweep 最多删除条数（默认 25）。
   * 必须有上限：同步 rm 上千 workDir 会堵死 Node 事件循环（health/IM 假死）。
   */
  maxRemovePerRun?: number;
  now?: Date;
  /** 是否 rm workDir（默认 true） */
  deleteWorkDir?: boolean;
  /** 必填：用于 workDir 路径守卫 */
  dataRoot: string;
}

export interface RetentionResult {
  removed: { instanceId: string; reason: 'cold' | 'quota'; workDirDeleted: boolean }[];
  scannedTerminal: number;
  remainingTerminal: number;
}

function endedAtMs(r: TaskRecord): number {
  const raw = r.finishedAt ?? r.abortedAt ?? r.startedAt;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? 0 : t;
}

function ageDays(r: TaskRecord, now: Date): number {
  return Math.max(0, (now.getTime() - endedAtMs(r)) / (24 * 3600 * 1000));
}

/** workDir 必须落在 dataRoot/workspaces/ 之下（防误删） */
export function isSafeWorkspaceDir(workDir: string, dataRoot: string): boolean {
  const resolved = path.resolve(workDir);
  const root = path.resolve(dataRoot, 'workspaces');
  const rel = path.relative(root, resolved);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function loadRetentionOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { enabled: boolean } & Omit<RetentionOptions, 'dataRoot'> {
  const flag = (env['UTLRA_INNER_WORKSPACE_RETENTION'] ?? '1').trim().toLowerCase();
  const enabled = flag !== '0' && flag !== 'false' && flag !== 'off';
  const maxTerminal = Math.max(
    1,
    Number.parseInt(env['UTLRA_INNER_WORKSPACE_MAX_TERMINAL'] ?? '400', 10) || 400,
  );
  const coldDays = Math.max(
    1,
    Number.parseInt(env['UTLRA_INNER_WORKSPACE_COLD_DAYS'] ?? '45', 10) || 45,
  );
  const maxRemovePerRun = Math.max(
    1,
    Number.parseInt(env['UTLRA_INNER_WORKSPACE_RETENTION_BATCH'] ?? '25', 10) || 25,
  );
  return {
    enabled,
    maxTerminal,
    coldDays,
    maxRemovePerRun,
    headroomRatio: 0.2,
    deleteWorkDir: true,
  };
}

export function loadHistoryCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1, Number.parseInt(env['UTLRA_INNER_STATUS_HISTORY_CAP'] ?? '50', 10) || 50);
}

/**
 * 选择 read_inner_status 列表行（纯函数，便于单测）。
 * `all` 须已按 startedAt 降序（与 InnerBrainRegistry.list 一致）。
 */
export function selectInnerStatusListRows(
  all: TaskRecord[],
  opts: { includeHistory: boolean; historyCap?: number },
): {
  rows: TaskRecord[];
  scope: 'live' | 'all';
  truncated: boolean;
  historyCap: number;
  registryTotal: number;
} {
  const live = new Set<TaskStatus>(['RUNNING', 'AWAITING', 'BLOCKED']);
  const registryTotal = all.length;
  if (!opts.includeHistory) {
    return {
      rows: all.filter((r) => live.has(r.status)),
      scope: 'live',
      truncated: false,
      historyCap: opts.historyCap ?? loadHistoryCapFromEnv(),
      registryTotal,
    };
  }
  const historyCap = opts.historyCap ?? loadHistoryCapFromEnv();
  const truncated = all.length > historyCap;
  return {
    rows: truncated ? all.slice(0, historyCap) : all,
    scope: 'all',
    truncated,
    historyCap,
    registryTotal,
  };
}

export function runInnerWorkspaceRetention(
  registry: InnerBrainRegistry,
  opts: RetentionOptions,
): RetentionResult {
  const max = opts.maxTerminal ?? 400;
  const headroom = opts.headroomRatio ?? 0.2;
  const coldDays = opts.coldDays ?? 45;
  const maxRemovePerRun = opts.maxRemovePerRun ?? 25;
  const now = opts.now ?? new Date();
  const deleteWorkDir = opts.deleteWorkDir !== false;
  const dataRoot = opts.dataRoot;

  const terminal = registry.list().filter((r) => TERMINAL_STATUSES.has(r.status));
  const removed: RetentionResult['removed'] = [];
  /** 有序：先 cold（更旧优先），再 quota */
  const doomed: { instanceId: string; reason: 'cold' | 'quota'; ended: number }[] = [];

  for (const r of terminal) {
    if (ageDays(r, now) > coldDays) {
      doomed.push({ instanceId: r.instanceId, reason: 'cold', ended: endedAtMs(r) });
    }
  }
  const coldIds = new Set(doomed.map((d) => d.instanceId));

  const remaining = terminal.filter((r) => !coldIds.has(r.instanceId));
  if (remaining.length > max) {
    const target = Math.floor(max * (1 - headroom));
    const ranked = [...remaining].sort((a, b) => endedAtMs(a) - endedAtMs(b));
    const toEvict = remaining.length - target;
    for (let i = 0; i < toEvict && i < ranked.length; i++) {
      const e = ranked[i]!;
      doomed.push({ instanceId: e.instanceId, reason: 'quota', ended: endedAtMs(e) });
    }
  }

  doomed.sort((a, b) => a.ended - b.ended);
  const batch = doomed.slice(0, maxRemovePerRun);

  for (const { instanceId, reason } of batch) {
    const rec = registry.get(instanceId);
    if (!rec || !TERMINAL_STATUSES.has(rec.status)) continue;
    let workDirDeleted = false;
    if (deleteWorkDir && isSafeWorkspaceDir(rec.workDir, dataRoot)) {
      try {
        fs.rmSync(rec.workDir, { recursive: true, force: true });
        workDirDeleted = true;
      } catch {
        // 盘删失败仍摘 registry，避免永久卡死
      }
    }
    registry.remove(instanceId);
    removed.push({ instanceId, reason, workDirDeleted });
  }

  const remainingTerminal = registry.list().filter((r) => TERMINAL_STATUSES.has(r.status)).length;
  return { removed, scannedTerminal: terminal.length, remainingTerminal };
}
