/**
 * ChangeWatcher bootstrap：启动时全表 timer 补单。
 *
 * @see doc/structurizr/INNER-BRAIN-AWAITING-LIFECYCLE.md §5.3
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { addPending, readPendings } from '../openkuroneko/pendings/index.js';
import type { TaskRecord } from '../outer/inner-brain-registry.js';
import { ChangeWatcher } from './change-watcher.js';

class FakeRegistry {
  tasks: Map<string, TaskRecord> = new Map();
  put(t: TaskRecord) {
    this.tasks.set(t.instanceId, t);
  }
  list(): TaskRecord[] {
    return Array.from(this.tasks.values());
  }
  get(id: string) {
    return this.tasks.get(id);
  }
  update(id: string, patch: Partial<TaskRecord>) {
    const t = this.tasks.get(id);
    if (t) Object.assign(t, patch);
  }
}

function tmpWorkspace(): { workDir: string; brainDir: string } {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-boot-'));
  const brainDir = path.join(workDir, '.brain');
  fs.mkdirSync(brainDir, { recursive: true });
  return { workDir, brainDir };
}

function mkTask(workDir: string, status: TaskRecord['status'] = 'AWAITING'): TaskRecord {
  return {
    instanceId: `ib-boot-${Math.random().toString(36).slice(2, 8)}`,
    workspaceId: 'task-x',
    workDir,
    goal: 'test',
    originUser: 'u1',
    status,
    startedAt: new Date().toISOString(),
  };
}

describe('ChangeWatcher.bootstrap', () => {
  let reg: FakeRegistry;

  beforeEach(() => {
    reg = new FakeRegistry();
  });

  it('runs tick once on bootstrap (no registry reconcile)', async () => {
    const spawn = vi.fn(() => ({ ok: true }));
    const w = new ChangeWatcher({
      registry: reg as unknown as import('../outer/inner-brain-registry.js').InnerBrainRegistry,
      spawnTask: spawn,
    });

    await w.bootstrap();

    expect(spawn).not.toHaveBeenCalled();
  });

  it('resolves overdue timers across all AWAITING tasks during bootstrap', async () => {
    const { workDir, brainDir } = tmpWorkspace();
    addPending(brainDir, {
      kind: 'timer',
      spec: { execute_at: new Date(Date.now() - 5000).toISOString() },
    });
    const task = mkTask(workDir);
    reg.put(task);

    const spawn = vi.fn(() => ({ ok: true }));
    const w = new ChangeWatcher({
      registry: reg as unknown as import('../outer/inner-brain-registry.js').InnerBrainRegistry,
      spawnTask: spawn,
    });

    await w.bootstrap();

    const items = readPendings(brainDir);
    expect(items[0]?.status).toBe('resolved');
    expect(spawn).toHaveBeenCalled();
  });
});
