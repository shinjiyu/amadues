/**
 * @see doc/structurizr/INNER-BRAIN-AWAITING-LIFECYCLE.md §4
 * @see doc/todo/inner-brain-awaiting-lifecycle.md P0
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addPending } from '../openkuroneko/pendings/index.js';
import { POST_COMPLETE_REASON } from './brain-async-snapshot.js';
import { InnerBrainRegistry, type TaskRecord } from './inner-brain-registry.js';
import { registryLifecycleReconcile } from './registry-lifecycle-reconcile.js';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
}

function mkWorkDir(root: string, id: string): string {
  const workDir = path.join(root, id);
  fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });
  return workDir;
}

function baseRecord(workDir: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  const instanceId = overrides.instanceId ?? 'ib-reconcile-01';
  return {
    instanceId,
    workspaceId: `task-${instanceId}`,
    workDir,
    goal: 'g',
    originUser: 'human:u1',
    originThread: 'thread:lab',
    status: 'AWAITING',
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('registryLifecycleReconcile', () => {
  let root: string;
  let reg: InnerBrainRegistry;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    root = makeRoot();
    reg = new InnerBrainRegistry(root);
  });

  it('AWAITING + is_post_complete (all-complete) → DONE', () => {
    const workDir = mkWorkDir(root, 'post-complete');
    const brainDir = path.join(workDir, '.brain');
    addPending(brainDir, {
      kind: 'ask_user',
      spec: { prompt: POST_COMPLETE_REASON },
      source: 'all-complete',
    });
    fs.writeFileSync(
      path.join(brainDir, 'controller-state.json'),
      JSON.stringify({ mode: 'AWAITING', awaitingReason: POST_COMPLETE_REASON }),
      'utf8',
    );
    reg.register(baseRecord(workDir, { instanceId: 'ib-done-1' }));

    registryLifecycleReconcile(reg);

    expect(reg.get('ib-done-1')?.status).toBe('DONE');
    expect(reg.get('ib-done-1')?.finishedAt).toBeTruthy();
  });

  it('AWAITING + no active pendings and not async waiting → DONE', () => {
    const workDir = mkWorkDir(root, 'idle-done');
    fs.writeFileSync(
      path.join(workDir, '.brain', 'controller-state.json'),
      JSON.stringify({ mode: 'DONE' }),
      'utf8',
    );
    fs.writeFileSync(path.join(workDir, '.brain', 'pendings.json'), '[]', 'utf8');
    reg.register(baseRecord(workDir, { instanceId: 'ib-idle-1' }));

    registryLifecycleReconcile(reg);

    expect(reg.get('ib-idle-1')?.status).toBe('DONE');
  });

  it('AWAITING + pending ask_user → stays AWAITING', () => {
    const workDir = mkWorkDir(root, 'still-wait');
    addPending(path.join(workDir, '.brain'), {
      kind: 'ask_user',
      spec: { prompt: '请提供 Cookie' },
      deadline: new Date(Date.now() + 3600_000).toISOString(),
    });
    fs.writeFileSync(
      path.join(workDir, '.brain', 'controller-state.json'),
      JSON.stringify({ mode: 'AWAITING', awaitingReason: '等用户' }),
      'utf8',
    );
    reg.register(baseRecord(workDir, { instanceId: 'ib-wait-1' }));

    registryLifecycleReconcile(reg);

    expect(reg.get('ib-wait-1')?.status).toBe('AWAITING');
    expect(reg.get('ib-wait-1')?.finishedAt).toBeUndefined();
  });

  it('BLOCKED + is_post_complete → DONE (treat as AWAITING superset)', () => {
    const workDir = mkWorkDir(root, 'blocked-done');
    const brainDir = path.join(workDir, '.brain');
    addPending(brainDir, {
      kind: 'ask_user',
      spec: { prompt: POST_COMPLETE_REASON },
      source: 'all-complete',
    });
    fs.writeFileSync(
      path.join(brainDir, 'controller-state.json'),
      JSON.stringify({ mode: 'AWAITING', awaitingReason: POST_COMPLETE_REASON }),
      'utf8',
    );
    reg.register(baseRecord(workDir, { instanceId: 'ib-blocked-1', status: 'BLOCKED' }));

    registryLifecycleReconcile(reg);

    expect(reg.get('ib-blocked-1')?.status).toBe('DONE');
  });

  it('RUNNING and DONE rows are untouched', () => {
    const workDirRun = mkWorkDir(root, 'running');
    const workDirDone = mkWorkDir(root, 'done');
    reg.register(baseRecord(workDirRun, { instanceId: 'ib-run', status: 'RUNNING', pid: 1 }));
    reg.register(
      baseRecord(workDirDone, {
        instanceId: 'ib-already-done',
        status: 'DONE',
        finishedAt: '2026-01-01T00:00:00.000Z',
      }),
    );

    registryLifecycleReconcile(reg);

    expect(reg.get('ib-run')?.status).toBe('RUNNING');
    expect(reg.get('ib-already-done')?.status).toBe('DONE');
    expect(reg.get('ib-already-done')?.finishedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns a change log entry when status updates', () => {
    const workDir = mkWorkDir(root, 'changelog');
    const brainDir = path.join(workDir, '.brain');
    addPending(brainDir, {
      kind: 'ask_user',
      spec: { prompt: POST_COMPLETE_REASON },
      source: 'all-complete',
    });
    fs.writeFileSync(
      path.join(brainDir, 'controller-state.json'),
      JSON.stringify({ mode: 'AWAITING', awaitingReason: POST_COMPLETE_REASON }),
      'utf8',
    );
    reg.register(baseRecord(workDir, { instanceId: 'ib-log-1' }));

    const changes = registryLifecycleReconcile(reg);

    expect(changes.some((c) => c.instanceId === 'ib-log-1' && c.to === 'DONE')).toBe(true);
  });
});
