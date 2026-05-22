/**
 * Pendings 文件 I/O — .brain/pendings.json
 *
 * 设计文档：doc/agent-data-state-machine.md §6（ChangeWatcher 与 pendings）
 *
 * 这是 agent 数据本体的一部分；所有读写都走原子文件操作。
 * Controller / Tools / ChangeWatcher 都通过本模块访问。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  PENDINGS_FILENAME,
  type PendingItem,
  type PendingKind,
  type PendingStatus,
  type PendingIntent,
  type AskUserSpec,
  type TimerSpec,
  type SignalSpec,
  type OnTimeoutSpec,
} from './types.js';

// ── 路径定位 ──────────────────────────────────────────────────────────────────

function pendingsPath(brainDir: string): string {
  return path.join(brainDir, PENDINGS_FILENAME);
}

// ── 读 / 写 ───────────────────────────────────────────────────────────────────

export function readPendings(brainDir: string): PendingItem[] {
  const fp = pendingsPath(brainDir);
  if (!fs.existsSync(fp)) return [];
  try {
    const raw = fs.readFileSync(fp, 'utf8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPendingItem);
  } catch {
    return [];
  }
}

export function writePendings(brainDir: string, items: PendingItem[]): void {
  fs.mkdirSync(brainDir, { recursive: true });
  const fp = pendingsPath(brainDir);
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf8');
  fs.renameSync(tmp, fp);
}

// ── 增 / 删 / 改 ──────────────────────────────────────────────────────────────

export interface AddPendingInput {
  kind: PendingKind;
  spec: AskUserSpec | TimerSpec | SignalSpec;
  ctxRef?: string;
  deadline?: string;
  on_timeout?: OnTimeoutSpec;
  source?: string;
  /** 拟人意图(可选)——LLM 创建 pending 时留下的内心独白,唤醒时回注 */
  intent?: PendingIntent;
}

export function addPending(brainDir: string, input: AddPendingInput): PendingItem {
  const all = readPendings(brainDir);
  const now = new Date().toISOString();
  const item: PendingItem = {
    id: 'pend-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'),
    kind: input.kind,
    spec: input.spec,
    ...(input.ctxRef ? { ctxRef: input.ctxRef } : {}),
    ...(input.deadline ? { deadline: input.deadline } : {}),
    ...(input.on_timeout ? { on_timeout: input.on_timeout } : {}),
    ...(input.source ? { source: input.source } : {}),
    ...(input.intent ? { intent: input.intent } : {}),
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  all.push(item);
  writePendings(brainDir, all);
  return item;
}

export interface ResolveInput {
  result?: unknown;
  status?: Extract<PendingStatus, 'resolved' | 'timed_out' | 'cancelled'>;
}

export function resolvePending(
  brainDir: string,
  id: string,
  input: ResolveInput = {},
): PendingItem | null {
  const all = readPendings(brainDir);
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) return null;
  const item = all[idx]!;
  if (item.status !== 'pending') return item;

  const next: PendingItem = {
    ...item,
    status: input.status ?? 'resolved',
    updatedAt: new Date().toISOString(),
  };
  if (input.result !== undefined) next.result = input.result;
  all[idx] = next;
  writePendings(brainDir, all);
  return next;
}

/** 标记 resolved/timed_out 项目已被 executor 消费 */
export function markConsumed(brainDir: string, ids: string[]): void {
  if (ids.length === 0) return;
  const set = new Set(ids);
  const all = readPendings(brainDir);
  let changed = false;
  for (let i = 0; i < all.length; i++) {
    const it = all[i]!;
    if (set.has(it.id) && !it.consumed) {
      all[i] = { ...it, consumed: true, updatedAt: new Date().toISOString() };
      changed = true;
    }
  }
  if (changed) writePendings(brainDir, all);
}

/** 删除已消费且 N 分钟前 resolved 的项（避免文件无限增长） */
export function gcPendings(brainDir: string, retentionMs = 24 * 3600 * 1000): number {
  const all = readPendings(brainDir);
  const cutoff = Date.now() - retentionMs;
  const next = all.filter((p) => {
    if (p.status === 'pending') return true;
    if (!p.consumed) return true;
    const t = Date.parse(p.updatedAt);
    return isFinite(t) && t > cutoff;
  });
  if (next.length !== all.length) {
    writePendings(brainDir, next);
  }
  return all.length - next.length;
}

// ── 查询辅助 ──────────────────────────────────────────────────────────────────

export function listActivePendings(brainDir: string): PendingItem[] {
  return readPendings(brainDir).filter((p) => p.status === 'pending');
}

export function listUnconsumedResolved(brainDir: string): PendingItem[] {
  return readPendings(brainDir).filter(
    (p) => (p.status === 'resolved' || p.status === 'timed_out') && !p.consumed,
  );
}

export function findByCtxRef(brainDir: string, ctxRef: string): PendingItem | null {
  return readPendings(brainDir).find((p) => p.ctxRef === ctxRef) ?? null;
}

export function findById(brainDir: string, id: string): PendingItem | null {
  return readPendings(brainDir).find((p) => p.id === id) ?? null;
}

// ── 超时扫描（ChangeWatcher 与 controller 入口都会用） ────────────────────────

/**
 * 把所有 deadline 已过的 pending 标记为 timed_out 或按 on_timeout 处理。
 *
 * 返回处理的 id 列表；调用方用来决定是否需要 spawn 一轮 tick。
 */
export function expireOverduePendings(brainDir: string, now = Date.now()): string[] {
  const all = readPendings(brainDir);
  let changed = false;
  const expired: string[] = [];

  for (let i = 0; i < all.length; i++) {
    const it = all[i]!;
    if (it.status !== 'pending') continue;
    if (!it.deadline) continue;
    const t = Date.parse(it.deadline);
    if (!isFinite(t) || t > now) continue;

    const action = it.on_timeout?.action ?? 'block';
    const updatedAt = new Date(now).toISOString();
    if (action === 'resolve_with_default') {
      all[i] = {
        ...it,
        status: 'resolved',
        result: it.on_timeout?.default_result ?? null,
        updatedAt,
      };
    } else if (action === 'cancel') {
      all[i] = { ...it, status: 'cancelled', updatedAt };
    } else {
      all[i] = { ...it, status: 'timed_out', updatedAt };
    }
    changed = true;
    expired.push(it.id);
  }

  if (changed) writePendings(brainDir, all);
  return expired;
}

/**
 * 计算下一个 deadline 距离 now 的毫秒数（用于 ChangeWatcher 排定 setTimeout）。
 * 没有任何 pending 时返回 null。
 */
export function nextDeadlineMs(brainDir: string, now = Date.now()): number | null {
  let best: number | null = null;
  for (const p of readPendings(brainDir)) {
    if (p.status !== 'pending') continue;
    // timer kind 用 spec.execute_at 也算 deadline
    let t: number = NaN;
    if (p.kind === 'timer') {
      t = Date.parse((p.spec as TimerSpec).execute_at);
    } else if (p.deadline) {
      t = Date.parse(p.deadline);
    }
    if (!isFinite(t)) continue;
    const delta = Math.max(0, t - now);
    if (best === null || delta < best) best = delta;
  }
  return best;
}

/**
 * 把所有 timer kind 且 execute_at 已到的 pending 自动 resolve。
 * 与 deadline 不同：timer 的 execute_at 本身就是"该醒了"的语义。
 */
export function resolveDueTimers(brainDir: string, now = Date.now()): string[] {
  const all = readPendings(brainDir);
  let changed = false;
  const fired: string[] = [];

  for (let i = 0; i < all.length; i++) {
    const it = all[i]!;
    if (it.status !== 'pending') continue;
    if (it.kind !== 'timer') continue;
    const t = Date.parse((it.spec as TimerSpec).execute_at);
    if (!isFinite(t) || t > now) continue;

    const updatedAt = new Date(now).toISOString();
    all[i] = {
      ...it,
      status: 'resolved',
      result: { fired_at: updatedAt, planned_at: (it.spec as TimerSpec).execute_at },
      updatedAt,
    };
    changed = true;
    fired.push(it.id);
  }

  if (changed) writePendings(brainDir, all);
  return fired;
}

// ── 类型守卫 ──────────────────────────────────────────────────────────────────

function isPendingItem(x: unknown): x is PendingItem {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o['id'] === 'string'
    && typeof o['kind'] === 'string'
    && typeof o['status'] === 'string'
    && typeof o['createdAt'] === 'string'
    && typeof o['updatedAt'] === 'string'
    && o['spec'] !== undefined;
}
