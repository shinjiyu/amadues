/**
 * staleBurstReaper 单测 — ADL KPI-MANAGER-LAYER.md §3.1 R5
 */
import { describe, expect, it, vi } from 'vitest';
import {
  reap,
  selectNeedsReview,
  selectStaleAwaiting,
  type ReaperDeps,
} from './stale-burst-reaper.js';
import type { TaskRecord } from '../inner-brain-registry.js';
import { DEFAULT_STALE_AWAITING_POLICY } from './kpi-awaiting-policy.js';

const NOW = Date.parse('2026-06-06T00:00:00.000Z');
const DAY = 86_400_000;

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    instanceId: 'ib-1',
    workspaceId: 'task-ib-1',
    workDir: '/tmp/ib-1',
    goal: 'g',
    originUser: 'u',
    status: 'AWAITING',
    startedAt: new Date(NOW - 8 * DAY).toISOString(),
    lastTickAt: new Date(NOW - 8 * DAY).toISOString(),
    ...overrides,
  };
}

describe('selectStaleAwaiting', () => {
  it('AWAITING 超 maxAwaitingMs（按 lastTickAt）入选', () => {
    const hits = selectStaleAwaiting([task()], DEFAULT_STALE_AWAITING_POLICY, NOW);
    expect(hits.map((h) => h.instanceId)).toEqual(['ib-1']);
  });

  it('未超时不入选', () => {
    const fresh = task({ lastTickAt: new Date(NOW - 1 * DAY).toISOString() });
    expect(selectStaleAwaiting([fresh], DEFAULT_STALE_AWAITING_POLICY, NOW)).toHaveLength(0);
  });

  it('非 AWAITING 状态忽略', () => {
    const running = task({ status: 'RUNNING' });
    expect(selectStaleAwaiting([running], DEFAULT_STALE_AWAITING_POLICY, NOW)).toHaveLength(0);
  });
});

describe('selectNeedsReview', () => {
  it('超 requireProgressSignalAfterMs 但未到硬上限 → 复审', () => {
    const t = task({ lastTickAt: new Date(NOW - 4 * DAY).toISOString() });
    expect(selectNeedsReview([t], DEFAULT_STALE_AWAITING_POLICY, NOW)).toEqual(['ib-1']);
  });
  it('超硬上限的不再算复审（归 reap 杀）', () => {
    expect(selectNeedsReview([task()], DEFAULT_STALE_AWAITING_POLICY, NOW)).toHaveLength(0);
  });
});

describe('reap', () => {
  function makeDeps(tasks: TaskRecord[], extra: Partial<ReaperDeps> = {}): {
    deps: ReaperDeps;
    aborts: Array<{ id: string; patch: unknown }>;
    logs: unknown[];
  } {
    const map = new Map(tasks.map((t) => [t.instanceId, t]));
    const aborts: Array<{ id: string; patch: unknown }> = [];
    const logs: unknown[] = [];
    const deps: ReaperDeps = {
      getTask: (id) => map.get(id),
      abort: (id, patch) => {
        aborts.push({ id, patch });
        const t = map.get(id);
        if (t) t.status = 'ABORTED';
      },
      appendActionLog: (e) => logs.push(e),
      now: () => NOW,
      ...extra,
    };
    return { deps, aborts, logs };
  }

  it('超时 AWAITING → ABORTED(stale_awaiting_timeout) + action-log', async () => {
    const { deps, aborts, logs } = makeDeps([task()]);
    const hits = selectStaleAwaiting([task()], DEFAULT_STALE_AWAITING_POLICY, NOW);
    const r = await reap([], hits, deps);
    expect(r.abortedIds).toEqual(['ib-1']);
    expect((aborts[0]?.patch as { abortedBy: string }).abortedBy).toBe('stale_awaiting_timeout');
    expect((logs[0] as { reaper: string }).reaper).toBe('timeout');
  });

  it('peekPendingMatch=true → 本 tick 跳过', async () => {
    const { deps, aborts } = makeDeps([task()], { peekPendingMatch: () => true });
    const r = await reap([], selectStaleAwaiting([task()], DEFAULT_STALE_AWAITING_POLICY, NOW), deps);
    expect(r.abortedIds).toHaveLength(0);
    expect(r.skippedPending).toEqual(['ib-1']);
    expect(aborts).toHaveLength(0);
  });

  it('cullDirective(grace=now) → ABORTED(strategy_reflect)，pid 存在则 kill', async () => {
    const killProcess = vi.fn();
    const t = task({ pid: 4321 });
    const { deps, aborts } = makeDeps([t], { killProcess });
    const r = await reap(
      [{ burstInstanceId: 'ib-1', reason: 'strategy_shift', grace: 'now' }],
      [],
      deps,
    );
    expect(r.abortedIds).toEqual(['ib-1']);
    expect(killProcess).toHaveBeenCalledWith(4321);
    expect((aborts[0]?.patch as { abortedBy: string }).abortedBy).toBe('strategy_reflect');
  });

  it('grace=warn_in_im_then_kill 本轮跳过（P1）', async () => {
    const { deps } = makeDeps([task({ pid: 1 })]);
    const r = await reap(
      [{ burstInstanceId: 'ib-1', reason: 'strategy_shift', grace: 'warn_in_im_then_kill' }],
      [],
      deps,
    );
    expect(r.abortedIds).toHaveLength(0);
  });

  it('已 DONE/STOPPED 的不再 abort', async () => {
    const { deps, aborts } = makeDeps([task({ status: 'DONE' })]);
    await reap([{ burstInstanceId: 'ib-1', reason: 'strategy_shift', grace: 'now' }], [], deps);
    expect(aborts).toHaveLength(0);
  });
});
