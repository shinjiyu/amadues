/**
 * 单元测试：inner workspace retention + history list cap
 * ADL：doc/structurizr/INNER-WORKSPACE-RETENTION.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InnerBrainRegistry, type TaskRecord } from './inner-brain-registry.js';
import {
  isSafeWorkspaceDir,
  runInnerWorkspaceRetention,
  selectInnerStatusListRows,
} from './inner-workspace-retention.js';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ib-ret-'));
}

function baseRecord(root: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  const id = overrides.instanceId ?? 'ib-test-0001';
  const workDir = overrides.workDir ?? path.join(root, 'workspaces', `task-${id}`);
  return {
    instanceId: id,
    workspaceId: `task-${id}`,
    workDir,
    goal: 'g',
    originUser: 'u',
    status: 'DONE',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T01:00:00.000Z',
    ...overrides,
  };
}

describe('selectInnerStatusListRows', () => {
  it('caps include_history rows and sets truncated', () => {
    const all: TaskRecord[] = Array.from({ length: 10 }, (_, i) =>
      baseRecord('/tmp', {
        instanceId: `ib-${i}`,
        startedAt: `2026-07-${String(10 - i).padStart(2, '0')}T00:00:00.000Z`,
        status: 'DONE',
      }),
    );
    const got = selectInnerStatusListRows(all, { includeHistory: true, historyCap: 3 });
    expect(got.scope).toBe('all');
    expect(got.truncated).toBe(true);
    expect(got.rows).toHaveLength(3);
    expect(got.rows[0]?.instanceId).toBe('ib-0');
    expect(got.registryTotal).toBe(10);
    expect(got.historyCap).toBe(3);
  });

  it('live path ignores historyCap and only returns live', () => {
    const all = [
      baseRecord('/tmp', { instanceId: 'ib-live', status: 'RUNNING' }),
      baseRecord('/tmp', { instanceId: 'ib-done', status: 'DONE' }),
    ];
    const got = selectInnerStatusListRows(all, { includeHistory: false, historyCap: 1 });
    expect(got.scope).toBe('live');
    expect(got.truncated).toBe(false);
    expect(got.rows.map((r) => r.instanceId)).toEqual(['ib-live']);
  });
});

describe('isSafeWorkspaceDir', () => {
  it('accepts only paths under dataRoot/workspaces', () => {
    const root = makeRoot();
    expect(isSafeWorkspaceDir(path.join(root, 'workspaces', 'task-a'), root)).toBe(true);
    expect(isSafeWorkspaceDir(path.join(root, 'other', 'task-a'), root)).toBe(false);
    expect(isSafeWorkspaceDir(root, root)).toBe(false);
  });
});

describe('runInnerWorkspaceRetention', () => {
  it('never removes live statuses', () => {
    const root = makeRoot();
    const reg = new InnerBrainRegistry(root);
    for (const status of ['RUNNING', 'AWAITING', 'BLOCKED'] as const) {
      const id = `ib-${status.toLowerCase()}`;
      const workDir = path.join(root, 'workspaces', `task-${id}`);
      fs.mkdirSync(workDir, { recursive: true });
      reg.register(
        baseRecord(root, {
          instanceId: id,
          status,
          workDir,
          startedAt: '2020-01-01T00:00:00.000Z',
          finishedAt: undefined,
        }),
      );
    }
    const r = runInnerWorkspaceRetention(reg, {
      dataRoot: root,
      coldDays: 1,
      maxTerminal: 1,
      now: new Date('2026-07-28T00:00:00.000Z'),
    });
    expect(r.removed).toHaveLength(0);
    expect(reg.list()).toHaveLength(3);
  });

  it('cold-evicts old terminal and deletes workDir', () => {
    const root = makeRoot();
    const reg = new InnerBrainRegistry(root);
    const oldDir = path.join(root, 'workspaces', 'task-ib-old');
    const newDir = path.join(root, 'workspaces', 'task-ib-new');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'marker.txt'), 'x');
    reg.register(
      baseRecord(root, {
        instanceId: 'ib-old',
        workDir: oldDir,
        status: 'DONE',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-02T00:00:00.000Z',
      }),
    );
    reg.register(
      baseRecord(root, {
        instanceId: 'ib-new',
        workDir: newDir,
        status: 'DONE',
        startedAt: '2026-07-20T00:00:00.000Z',
        finishedAt: '2026-07-20T01:00:00.000Z',
      }),
    );

    const r = runInnerWorkspaceRetention(reg, {
      dataRoot: root,
      coldDays: 30,
      maxTerminal: 400,
      now: new Date('2026-07-28T00:00:00.000Z'),
    });

    expect(r.removed.map((x) => x.instanceId)).toEqual(['ib-old']);
    expect(r.removed[0]?.reason).toBe('cold');
    expect(r.removed[0]?.workDirDeleted).toBe(true);
    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(newDir)).toBe(true);
    expect(reg.get('ib-old')).toBeUndefined();
    expect(reg.get('ib-new')).toBeDefined();
  });

  it('quota-evicts oldest terminal down to headroom floor', () => {
    const root = makeRoot();
    const reg = new InnerBrainRegistry(root);
    for (let i = 0; i < 5; i++) {
      const id = `ib-q${i}`;
      const workDir = path.join(root, 'workspaces', `task-${id}`);
      fs.mkdirSync(workDir, { recursive: true });
      reg.register(
        baseRecord(root, {
          instanceId: id,
          workDir,
          status: 'DONE',
          startedAt: `2026-07-0${i + 1}T00:00:00.000Z`,
          finishedAt: `2026-07-0${i + 1}T01:00:00.000Z`,
        }),
      );
    }
    // max=4, headroom=0.5 → target floor(4*0.5)=2 → remove 3 oldest
    const r = runInnerWorkspaceRetention(reg, {
      dataRoot: root,
      maxTerminal: 4,
      headroomRatio: 0.5,
      coldDays: 3650,
      maxRemovePerRun: 100,
      now: new Date('2026-07-28T00:00:00.000Z'),
    });
    expect(r.removed).toHaveLength(3);
    expect(r.removed.every((x) => x.reason === 'quota')).toBe(true);
    expect(r.remainingTerminal).toBe(2);
    expect(reg.list().map((x) => x.instanceId).sort()).toEqual(['ib-q3', 'ib-q4']);
  });

  it('caps removals per run so one tick cannot wipe hundreds of dirs', () => {
    const root = makeRoot();
    const reg = new InnerBrainRegistry(root);
    for (let i = 0; i < 10; i++) {
      const id = `ib-b${i}`;
      const workDir = path.join(root, 'workspaces', `task-${id}`);
      fs.mkdirSync(workDir, { recursive: true });
      reg.register(
        baseRecord(root, {
          instanceId: id,
          workDir,
          status: 'DONE',
          startedAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
          finishedAt: `2026-01-${String(i + 1).padStart(2, '0')}T01:00:00.000Z`,
        }),
      );
    }
    const r = runInnerWorkspaceRetention(reg, {
      dataRoot: root,
      coldDays: 1,
      maxTerminal: 400,
      maxRemovePerRun: 3,
      now: new Date('2026-07-28T00:00:00.000Z'),
    });
    expect(r.removed).toHaveLength(3);
    expect(r.remainingTerminal).toBe(7);
  });
});

describe('InnerBrainRegistry.remove', () => {
  it('persists removal across reload', () => {
    const root = makeRoot();
    const a = new InnerBrainRegistry(root);
    a.register(baseRecord(root, { instanceId: 'ib-rm', status: 'DONE' }));
    expect(a.remove('ib-rm')).toBe(true);
    expect(a.remove('ib-missing')).toBe(false);
    const b = new InnerBrainRegistry(root);
    expect(b.get('ib-rm')).toBeUndefined();
  });
});
