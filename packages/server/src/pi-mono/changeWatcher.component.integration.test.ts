/**
 * ADL component: changeWatcher — AWAITING + pendings → spawnTask
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { ChangeWatcher } from './change-watcher.js';
import { addPending } from '../openkuroneko/pendings/index.js';
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

describe('component: changeWatcher', () => {
  let reg: FakeRegistry;

  beforeEach(() => {
    reg = new FakeRegistry();
  });

  it('timer 到期 → spawnTask（主路径）', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-comp-'));
    const brainDir = path.join(workDir, '.brain');
    fs.mkdirSync(brainDir, { recursive: true });
    const task: TaskRecord = {
      instanceId: 'ib-cw-1',
      workspaceId: 'ws',
      workDir,
      goal: 'test',
      originUser: 'u1',
      status: 'AWAITING',
      startedAt: new Date().toISOString(),
    };
    reg.put(task);
    addPending(brainDir, {
      kind: 'timer',
      spec: { execute_at: new Date(Date.now() - 1000).toISOString() },
    });

    const spawned: TaskRecord[] = [];
    const w = new ChangeWatcher({
      registry: reg as unknown as import('../outer/inner-brain-registry.js').InnerBrainRegistry,
      spawnTask: (t) => {
        spawned.push(t);
        return { ok: true };
      },
    });
    await (w as unknown as { tick: () => Promise<void> }).tick();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.instanceId).toBe('ib-cw-1');
    fs.rmSync(workDir, { recursive: true, force: true });
  });
});
