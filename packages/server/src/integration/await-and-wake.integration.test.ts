/**
 * E.1：ChangeWatcher 唤醒 — timer 到期；resolved 未消费 → spawn。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ChangeWatcher } from '../pi-mono/change-watcher.js';
import {
  addPending,
  readPendings,
  resolvePending,
  type PendingItem,
} from '../openkuroneko/pendings/index.js';
import type { TaskRecord } from '../outer/inner-brain-registry.js';

class FakeRegistry {
  tasks = new Map<string, TaskRecord>();
  put(t: TaskRecord): void {
    this.tasks.set(t.instanceId, t);
  }
  list(): TaskRecord[] {
    return Array.from(this.tasks.values());
  }
  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }
  update(id: string, patch: Partial<TaskRecord>): void {
    const t = this.tasks.get(id);
    if (t) Object.assign(t, patch);
  }
}

function tmpWorkspace(): { workDir: string; brainDir: string } {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'await-wake-'));
  const brainDir = path.join(workDir, '.brain');
  fs.mkdirSync(brainDir, { recursive: true });
  return { workDir, brainDir };
}

function mkTask(workDir: string): TaskRecord {
  return {
    instanceId: 'ib-await-' + Math.random().toString(36).slice(2, 8),
    workspaceId: 'ws-await',
    workDir,
    goal: 'wait timer test',
    originUser: 'u1',
    status: 'AWAITING',
    startedAt: new Date().toISOString(),
  };
}

describe('integration: await-and-wake', () => {
  it('wait_timer 到期 → spawnTask', async () => {
    const { workDir, brainDir } = tmpWorkspace();
    const reg = new FakeRegistry();
    reg.put(mkTask(workDir));

    addPending(brainDir, {
      kind: 'timer',
      spec: { execute_at: new Date(Date.now() - 2000).toISOString() },
    });

    const spawns: string[] = [];
    const w = new ChangeWatcher({
      registry: reg as unknown as import('../outer/inner-brain-registry.js').InnerBrainRegistry,
      spawnTask: (t) => {
        spawns.push(t.instanceId);
        return { ok: true };
      },
    });
    await (w as unknown as { tick: () => Promise<void> }).tick();
    expect(spawns.length).toBe(1);
    expect((readPendings(brainDir) as PendingItem[])[0]?.status).toBe('resolved');
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('resolved 未消费（无 active pending）→ spawnTask', async () => {
    const { workDir, brainDir } = tmpWorkspace();
    const reg = new FakeRegistry();
    const task = mkTask(workDir);
    reg.put(task);

    const p = addPending(brainDir, {
      kind: 'signal',
      spec: { signal_name: 'payment_ok' },
    });
    resolvePending(brainDir, p.id, { result: { paid: true } });

    const spawns: string[] = [];
    const w = new ChangeWatcher({
      registry: reg as unknown as import('../outer/inner-brain-registry.js').InnerBrainRegistry,
      spawnTask: (t) => {
        spawns.push(t.instanceId);
        return { ok: true };
      },
    });
    await (w as unknown as { tick: () => Promise<void> }).tick();
    expect(spawns).toEqual([task.instanceId]);
    fs.rmSync(workDir, { recursive: true, force: true });
  });
});
