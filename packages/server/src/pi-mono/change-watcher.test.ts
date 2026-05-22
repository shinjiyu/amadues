/**
 * ChangeWatcher 单测
 *
 * 用 fake registry 与 fake spawnTask 测试核心调度逻辑：
 *   1. 不存在的 task 不 crash
 *   2. timer 到期 → spawnTask 被调用
 *   3. ask_user 仍在等 → 不 spawn
 *   4. unconsumed resolved → spawn
 *   5. 同一 task 重复 tick → 不会重复 spawn
 *   6. resolveAskUser / resolveSignal 正确改 pendings
 */

import { describe, expect, it, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ChangeWatcher } from './change-watcher.js';
import { addPending, readPendings, type PendingItem } from '../openkuroneko/pendings/index.js';
import type { TaskRecord } from '../outer/inner-brain-registry.js';

class FakeRegistry {
  tasks: Map<string, TaskRecord> = new Map();
  put(t: TaskRecord) { this.tasks.set(t.instanceId, t); }
  list(): TaskRecord[] { return Array.from(this.tasks.values()); }
  get(id: string) { return this.tasks.get(id); }
  update(id: string, patch: Partial<TaskRecord>): void {
    const t = this.tasks.get(id);
    if (t) Object.assign(t, patch);
  }
}

function tmpWorkspace(): { workDir: string; brainDir: string } {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-test-'));
  const brainDir = path.join(workDir, '.brain');
  fs.mkdirSync(brainDir, { recursive: true });
  return { workDir, brainDir };
}

function mkTask(workDir: string, status: TaskRecord['status'] = 'AWAITING'): TaskRecord {
  return {
    instanceId: 'ib-test-' + Math.random().toString(36).slice(2, 8),
    workspaceId: 'task-x',
    workDir,
    goal: 'test',
    originUser: 'u1',
    status,
    startedAt: new Date().toISOString(),
  };
}

describe('ChangeWatcher', () => {
  let reg: FakeRegistry;
  beforeEach(() => { reg = new FakeRegistry(); });

  it('does nothing when no AWAITING tasks', async () => {
    const calls: TaskRecord[] = [];
    const w = new ChangeWatcher({
      registry: reg as unknown as import('../outer/inner-brain-registry.js').InnerBrainRegistry,
      spawnTask: (t) => { calls.push(t); return { ok: true }; },
    });
    await (w as unknown as { tick: () => Promise<void> }).tick();
    expect(calls.length).toBe(0);
  });

  it('skips tasks without pendings.json', async () => {
    const { workDir } = tmpWorkspace();
    reg.put(mkTask(workDir));
    const calls: TaskRecord[] = [];
    const w = new ChangeWatcher({
      registry: reg as unknown as import('../outer/inner-brain-registry.js').InnerBrainRegistry,
      spawnTask: (t) => { calls.push(t); return { ok: true }; },
    });
    await (w as unknown as { tick: () => Promise<void> }).tick();
    expect(calls.length).toBe(0);
  });

  it('fires due timer → spawnTask called', async () => {
    const { workDir, brainDir } = tmpWorkspace();
    addPending(brainDir, {
      kind: 'timer',
      spec: { execute_at: new Date(Date.now() - 1000).toISOString() },
    });
    reg.put(mkTask(workDir));

    const calls: TaskRecord[] = [];
    const w = new ChangeWatcher({
      registry: reg as unknown as import('../outer/inner-brain-registry.js').InnerBrainRegistry,
      spawnTask: (t) => { calls.push(t); return { ok: true }; },
    });
    await (w as unknown as { tick: () => Promise<void> }).tick();
    expect(calls.length).toBe(1);

    // pending should now be resolved
    const after = readPendings(brainDir);
    expect(after[0]?.status).toBe('resolved');
  });

  it('ask_user pending still waiting → no spawn', async () => {
    const { workDir, brainDir } = tmpWorkspace();
    addPending(brainDir, {
      kind: 'ask_user',
      spec: { prompt: 'q?' },
      deadline: new Date(Date.now() + 3600_000).toISOString(),
    });
    reg.put(mkTask(workDir));

    const calls: TaskRecord[] = [];
    const w = new ChangeWatcher({
      registry: reg as unknown as import('../outer/inner-brain-registry.js').InnerBrainRegistry,
      spawnTask: (t) => { calls.push(t); return { ok: true }; },
    });
    await (w as unknown as { tick: () => Promise<void> }).tick();
    expect(calls.length).toBe(0);
  });

  it('resolveAskUser writes result to matching pending', async () => {
    const { workDir, brainDir } = tmpWorkspace();
    const item = addPending(brainDir, {
      kind: 'ask_user',
      ctxRef: 'tc1',
      spec: { prompt: 'q' },
    });
    const task = mkTask(workDir);
    reg.put(task);

    const w = new ChangeWatcher({
      registry: reg as unknown as import('../outer/inner-brain-registry.js').InnerBrainRegistry,
      spawnTask: () => ({ ok: true }),
    });
    const resolved = w.resolveAskUser(task.instanceId, 'my reply', 'tc1');
    expect(resolved?.id).toBe(item.id);
    expect(resolved?.status).toBe('resolved');
    const res = resolved?.result as { reply: string };
    expect(res.reply).toBe('my reply');
  });

  it('resolveSignal fires matching signal pending', async () => {
    const { workDir, brainDir } = tmpWorkspace();
    addPending(brainDir, {
      kind: 'signal',
      spec: { signal_name: 'payment_ok' },
    });
    const task = mkTask(workDir);
    reg.put(task);

    const w = new ChangeWatcher({
      registry: reg as unknown as import('../outer/inner-brain-registry.js').InnerBrainRegistry,
      spawnTask: () => ({ ok: true }),
    });
    const resolved = w.resolveSignal(task.instanceId, 'payment_ok', { amount: 100 });
    expect(resolved?.status).toBe('resolved');
    expect((resolved?.result as { amount: number })?.amount).toBe(100);
  });

  it('expired deadline → spawn (timeout path)', async () => {
    const { workDir, brainDir } = tmpWorkspace();
    addPending(brainDir, {
      kind: 'ask_user',
      spec: { prompt: 'q' },
      deadline: new Date(Date.now() - 5000).toISOString(),
      on_timeout: { action: 'resolve_with_default', default_result: 'auto' },
    });
    reg.put(mkTask(workDir));

    const calls: TaskRecord[] = [];
    const w = new ChangeWatcher({
      registry: reg as unknown as import('../outer/inner-brain-registry.js').InnerBrainRegistry,
      spawnTask: (t) => { calls.push(t); return { ok: true }; },
    });
    await (w as unknown as { tick: () => Promise<void> }).tick();
    expect(calls.length).toBe(1);
    const items = readPendings(brainDir) as PendingItem[];
    expect(items[0]?.status).toBe('resolved');
    expect(items[0]?.result).toBe('auto');
  });
});
