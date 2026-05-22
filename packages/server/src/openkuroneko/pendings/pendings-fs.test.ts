import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  addPending,
  expireOverduePendings,
  findByCtxRef,
  gcPendings,
  listActivePendings,
  listUnconsumedResolved,
  markConsumed,
  nextDeadlineMs,
  readPendings,
  resolveDueTimers,
  resolvePending,
  writePendings,
} from './pendings-fs.js';

function tmpBrain(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pendings-test-'));
  const brain = path.join(dir, '.brain');
  fs.mkdirSync(brain, { recursive: true });
  return brain;
}

describe('pendings-fs', () => {
  let brain: string;
  beforeEach(() => { brain = tmpBrain(); });

  it('read empty workspace returns []', () => {
    expect(readPendings(brain)).toEqual([]);
  });

  it('add then read round-trips fields', () => {
    const item = addPending(brain, {
      kind: 'ask_user',
      ctxRef: 'tc_xyz',
      spec: { prompt: '需要 OAuth token' },
      deadline: new Date(Date.now() + 3600_000).toISOString(),
      on_timeout: { action: 'block', reason: '无 token 无法继续' },
      source: 'attributor',
    });
    expect(item.id).toMatch(/^pend-/);
    expect(item.status).toBe('pending');
    const all = readPendings(brain);
    expect(all.length).toBe(1);
    expect(all[0]?.ctxRef).toBe('tc_xyz');
    expect(all[0]?.source).toBe('attributor');
  });

  it('resolvePending writes result and updates status', () => {
    const item = addPending(brain, { kind: 'ask_user', spec: { prompt: 'q?' } });
    const resolved = resolvePending(brain, item.id, { result: { reply: 'ok' } });
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.result).toEqual({ reply: 'ok' });
    expect(listUnconsumedResolved(brain).length).toBe(1);
    expect(listActivePendings(brain).length).toBe(0);
  });

  it('resolvePending of unknown id returns null', () => {
    expect(resolvePending(brain, 'not-exist')).toBeNull();
  });

  it('resolvePending on already resolved is no-op', () => {
    const item = addPending(brain, { kind: 'signal', spec: { signal_name: 's' } });
    resolvePending(brain, item.id, { result: 1 });
    const again = resolvePending(brain, item.id, { result: 2 });
    expect(again?.result).toBe(1);
  });

  it('markConsumed flips consumed=true', () => {
    const item = addPending(brain, { kind: 'ask_user', spec: { prompt: 'q?' } });
    resolvePending(brain, item.id, { result: 'r' });
    markConsumed(brain, [item.id]);
    expect(listUnconsumedResolved(brain).length).toBe(0);
    expect(readPendings(brain)[0]?.consumed).toBe(true);
  });

  it('findByCtxRef locates the right item', () => {
    addPending(brain, { kind: 'ask_user', ctxRef: 'a', spec: { prompt: '?' } });
    const b = addPending(brain, { kind: 'ask_user', ctxRef: 'b', spec: { prompt: '?' } });
    expect(findByCtxRef(brain, 'b')?.id).toBe(b.id);
    expect(findByCtxRef(brain, 'nope')).toBeNull();
  });

  it('expireOverduePendings honors on_timeout action', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const block = addPending(brain, {
      kind: 'ask_user', spec: { prompt: 'q' }, deadline: past,
      on_timeout: { action: 'block', reason: 'gave up' },
    });
    const def = addPending(brain, {
      kind: 'ask_user', spec: { prompt: 'q' }, deadline: past,
      on_timeout: { action: 'resolve_with_default', default_result: 'auto' },
    });
    const cancel = addPending(brain, {
      kind: 'ask_user', spec: { prompt: 'q' }, deadline: past,
      on_timeout: { action: 'cancel' },
    });
    const future = addPending(brain, {
      kind: 'ask_user', spec: { prompt: 'q' },
      deadline: new Date(Date.now() + 3600_000).toISOString(),
    });

    const expired = expireOverduePendings(brain);
    expect(expired.sort()).toEqual([block.id, def.id, cancel.id].sort());

    const all = readPendings(brain);
    expect(all.find(p => p.id === block.id)?.status).toBe('timed_out');
    expect(all.find(p => p.id === def.id)?.status).toBe('resolved');
    expect(all.find(p => p.id === def.id)?.result).toBe('auto');
    expect(all.find(p => p.id === cancel.id)?.status).toBe('cancelled');
    expect(all.find(p => p.id === future.id)?.status).toBe('pending');
  });

  it('resolveDueTimers fires past execute_at timers', () => {
    const past = new Date(Date.now() - 5000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const a = addPending(brain, { kind: 'timer', spec: { execute_at: past } });
    addPending(brain, { kind: 'timer', spec: { execute_at: future } });
    const fired = resolveDueTimers(brain);
    expect(fired).toEqual([a.id]);
    expect(readPendings(brain).find(p => p.id === a.id)?.status).toBe('resolved');
  });

  it('nextDeadlineMs picks the earliest among timer and deadline', () => {
    const ts5s = new Date(Date.now() + 5000).toISOString();
    const ts60s = new Date(Date.now() + 60_000).toISOString();
    addPending(brain, { kind: 'timer', spec: { execute_at: ts60s } });
    addPending(brain, { kind: 'ask_user', spec: { prompt: 'q' }, deadline: ts5s });
    const ms = nextDeadlineMs(brain);
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(4000);
    expect(ms!).toBeLessThanOrEqual(5000);
  });

  it('addPending persists intent verbatim and survives round-trip', () => {
    const item = addPending(brain, {
      kind: 'timer',
      spec: { execute_at: new Date(Date.now() + 60_000).toISOString() },
      intent: {
        expectation: '估计 Shiro 10 分钟跑完编译',
        success_signal: 'tick 数 > 上次记录',
        fallback: '连续 3 次未推进 → ask_user',
      },
    });
    expect(item.intent?.expectation).toContain('Shiro');
    const all = readPendings(brain);
    expect(all[0]?.intent).toEqual({
      expectation: '估计 Shiro 10 分钟跑完编译',
      success_signal: 'tick 数 > 上次记录',
      fallback: '连续 3 次未推进 → ask_user',
    });
  });

  it('addPending without intent stores no intent field', () => {
    const item = addPending(brain, { kind: 'ask_user', spec: { prompt: 'q?' } });
    expect(item.intent).toBeUndefined();
    expect(readPendings(brain)[0]?.intent).toBeUndefined();
  });

  it('intent survives resolvePending and is preserved through markConsumed', () => {
    const item = addPending(brain, {
      kind: 'ask_user',
      spec: { prompt: '需要 OAuth token' },
      intent: { expectation: '用户给 sk- 开头的 token' },
    });
    const resolved = resolvePending(brain, item.id, { result: { reply: 'sk-foo' } });
    expect(resolved?.intent?.expectation).toBe('用户给 sk- 开头的 token');
    markConsumed(brain, [item.id]);
    expect(readPendings(brain)[0]?.intent?.expectation).toBe('用户给 sk- 开头的 token');
  });

  it('gcPendings removes old consumed items', () => {
    const item = addPending(brain, { kind: 'signal', spec: { signal_name: 's' } });
    resolvePending(brain, item.id, { result: 'ok' });
    markConsumed(brain, [item.id]);
    // Make updatedAt very old
    const all = readPendings(brain);
    all[0]!.updatedAt = new Date(Date.now() - 48 * 3600_000).toISOString();
    writePendings(brain, all);

    const removed = gcPendings(brain, 24 * 3600 * 1000);
    expect(removed).toBe(1);
    expect(readPendings(brain).length).toBe(0);
  });

  // ────────────────────────────────────────────────────────────────────────────
  // 边界用例（D 阶段补：timer 翻牌 / 过期路径）
  // ────────────────────────────────────────────────────────────────────────────

  it('resolveDueTimers: 没有 timer 时返回空数组', () => {
    addPending(brain, { kind: 'ask_user', spec: { prompt: 'q' } });
    expect(resolveDueTimers(brain)).toEqual([]);
  });

  it('resolveDueTimers: 未到点的 timer 保持 pending', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const item = addPending(brain, { kind: 'timer', spec: { execute_at: future } });
    expect(resolveDueTimers(brain)).toEqual([]);
    expect(readPendings(brain).find((p) => p.id === item.id)?.status).toBe('pending');
  });

  it('resolveDueTimers: now 参数注入过去时间 → 不触发未来 timer', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    addPending(brain, { kind: 'timer', spec: { execute_at: future } });
    expect(resolveDueTimers(brain, Date.now() - 1000)).toEqual([]);
  });

  it('resolveDueTimers: 多个到点 timer 一次性全部翻牌（顺序无关）', () => {
    const past1 = new Date(Date.now() - 30_000).toISOString();
    const past2 = new Date(Date.now() - 10_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const a = addPending(brain, { kind: 'timer', spec: { execute_at: past1 } });
    const b = addPending(brain, { kind: 'timer', spec: { execute_at: past2 } });
    addPending(brain, { kind: 'timer', spec: { execute_at: future } });

    const fired = resolveDueTimers(brain);
    expect(fired.sort()).toEqual([a.id, b.id].sort());

    const all = readPendings(brain);
    expect(all.filter((p) => p.status === 'resolved').length).toBe(2);
    expect(all.filter((p) => p.status === 'pending').length).toBe(1);
  });

  it('resolveDueTimers: 翻牌后写入 result.fired_at / planned_at', () => {
    const past = new Date(Date.now() - 5000).toISOString();
    const item = addPending(brain, { kind: 'timer', spec: { execute_at: past } });
    resolveDueTimers(brain);
    const result = readPendings(brain).find((p) => p.id === item.id)?.result as
      | { fired_at: string; planned_at: string }
      | undefined;
    expect(result?.planned_at).toBe(past);
    expect(result?.fired_at).toMatch(/^\d{4}-/);
  });

  it('nextDeadlineMs: 完全无 active pending → null', () => {
    expect(nextDeadlineMs(brain)).toBeNull();

    addPending(brain, { kind: 'ask_user', spec: { prompt: 'q' } }); // 无 deadline
    expect(nextDeadlineMs(brain)).toBeNull();
  });

  it('nextDeadlineMs: 仅 resolved 的 timer 不计入', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const item = addPending(brain, { kind: 'timer', spec: { execute_at: past } });
    resolvePending(brain, item.id, { result: { ok: true } });
    expect(nextDeadlineMs(brain)).toBeNull();
  });

  it('expireOverduePendings: 默认 on_timeout=block', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const item = addPending(brain, {
      kind: 'ask_user',
      spec: { prompt: 'q' },
      deadline: past,
      // 故意不传 on_timeout
    });
    const expired = expireOverduePendings(brain);
    expect(expired).toEqual([item.id]);
    expect(readPendings(brain).find((p) => p.id === item.id)?.status).toBe('timed_out');
  });

  it('expireOverduePendings: 已 resolved 的 pending 不会被重新过期', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const item = addPending(brain, {
      kind: 'ask_user',
      spec: { prompt: 'q' },
      deadline: past,
    });
    resolvePending(brain, item.id, { result: 'manual' });
    const expired = expireOverduePendings(brain);
    expect(expired).toEqual([]);
    expect(readPendings(brain).find((p) => p.id === item.id)?.status).toBe('resolved');
  });

  it('expireOverduePendings: deadline 无效 ISO 字符串 → 跳过不抛错', () => {
    addPending(brain, { kind: 'ask_user', spec: { prompt: 'q' }, deadline: 'not-a-date' });
    expect(() => expireOverduePendings(brain)).not.toThrow();
    expect(readPendings(brain)[0]?.status).toBe('pending');
  });
});
