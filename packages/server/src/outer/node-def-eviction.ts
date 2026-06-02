/**
 * NodeDef Eviction — 外脑 sweep：防止 drive9 `/nodes/shared/` NodeDef 爆炸。
 *
 * ADL：doc/structurizr/INNER-NODE-LIFECYCLE.md §7
 *
 * 与 kpiCompletionJudge / staleBurstReaper 同心跳级别（外脑周期调用）。
 *
 * 规则：
 *   1. cold：importCount==0 && ageDays > coldDays → tombstone
 *   2. quota：active 数 > max → 按 score 升序 tombstone，直到回到 max*(1-headroom)
 *
 * score(def) = w_import*importCount + w_cite*citeCount − w_age*ageDays − w_fail*assembleFailCount
 */

import type {
  NodeDefDrive9Store,
  NodeDefIndexEntry,
} from '../drive9/node-def-drive9-store.js';

export interface EvictionWeights {
  import: number;
  cite: number;
  age: number;
  fail: number;
}

export const DEFAULT_WEIGHTS: EvictionWeights = { import: 5, cite: 2, age: 0.1, fail: 3 };

export interface EvictionOptions {
  /** 每 agent 上限（默认 200） */
  maxActive?: number;
  /** headroom 比例：quota 触发时 evict 到 max*(1-headroom)（默认 0.2） */
  headroomRatio?: number;
  /** cold 阈值天数（默认 30） */
  coldDays?: number;
  weights?: EvictionWeights;
  /** 注入「现在」便于测试 */
  now?: Date;
}

export interface EvictionResult {
  tombstoned: { id: string; version: string; reason: 'cold' | 'quota' }[];
  scanned: number;
  remainingActive: number;
}

function ageDays(createdAt: string, now: Date): number {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (now.getTime() - t) / (24 * 3600 * 1000));
}

export function scoreEntry(
  e: NodeDefIndexEntry,
  now: Date,
  weights: EvictionWeights = DEFAULT_WEIGHTS,
): number {
  return (
    weights.import * e.importCount +
    weights.cite * e.citeCount -
    weights.age * ageDays(e.createdAt, now) -
    weights.fail * e.assembleFailCount
  );
}

export async function runNodeDefEviction(
  store: NodeDefDrive9Store,
  opts: EvictionOptions = {},
): Promise<EvictionResult> {
  const max = opts.maxActive ?? 200;
  const headroom = opts.headroomRatio ?? 0.2;
  const coldDays = opts.coldDays ?? 30;
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const now = opts.now ?? new Date();

  const all = await store.list();
  const active = all.filter(e => e.status === 'active');
  const tombstoned: EvictionResult['tombstoned'] = [];

  // 1. cold sweep
  const cold = new Set<string>();
  for (const e of active) {
    if (e.importCount === 0 && ageDays(e.createdAt, now) > coldDays) {
      await store.tombstone(e.id, e.version);
      tombstoned.push({ id: e.id, version: e.version, reason: 'cold' });
      cold.add(`${e.id}@${e.version}`);
    }
  }

  // 2. quota sweep（在 cold 之后重新计 active 数）
  let remaining = active.filter(e => !cold.has(`${e.id}@${e.version}`));
  if (remaining.length > max) {
    const target = Math.floor(max * (1 - headroom));
    const ranked = [...remaining].sort((a, b) => scoreEntry(a, now, weights) - scoreEntry(b, now, weights));
    const toEvict = remaining.length - target;
    for (let i = 0; i < toEvict && i < ranked.length; i++) {
      const e = ranked[i]!;
      await store.tombstone(e.id, e.version);
      tombstoned.push({ id: e.id, version: e.version, reason: 'quota' });
    }
    remaining = remaining.filter(e => !ranked.slice(0, toEvict).includes(e));
  }

  return { tombstoned, scanned: active.length, remainingActive: remaining.length };
}
