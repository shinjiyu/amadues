/**
 * 单元测试：innerBrainStartupResume（ADL innerBrainStartupResume）
 * @see doc/structurizr/INNER-BRAIN-RESUME.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InnerBrainRegistry, type TaskRecord } from './inner-brain-registry.js';
import {
  autoResumeStaleTasks,
  parseAutoResumeConfig,
  type SpawnWorkerFn,
} from './inner-brain-startup-resume.js';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ibresume-'));
}

function baseRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    instanceId: 'ib-resume-01',
    workspaceId: 'task-ib-resume-01',
    workDir: '/tmp/task-ib-resume-01',
    goal: 'goal',
    originUser: 'user-x',
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('parseAutoResumeConfig', () => {
  it('defaults: enabled + maxResumes=3', () => {
    expect(parseAutoResumeConfig({})).toEqual({ enabled: true, maxResumes: 3 });
  });

  it('UTLRA_INNER_AUTO_RESUME=0 disables', () => {
    expect(parseAutoResumeConfig({ UTLRA_INNER_AUTO_RESUME: '0' })).toEqual({
      enabled: false,
      maxResumes: 3,
    });
  });

  it('UTLRA_INNER_MAX_AUTO_RESUME clamps negative to 0', () => {
    expect(parseAutoResumeConfig({ UTLRA_INNER_MAX_AUTO_RESUME: '-1' })).toEqual({
      enabled: true,
      maxResumes: 0,
    });
  });
});

describe('autoResumeStaleTasks', () => {
  let root: string;
  let reg: InnerBrainRegistry;
  let spawnCalls: Array<{ id: string; increment: boolean }>;
  let spawn: SpawnWorkerFn;

  beforeEach(() => {
    root = makeRoot();
    reg = new InnerBrainRegistry(root);
    spawnCalls = [];
    spawn = vi.fn((record, opts) => {
      spawnCalls.push({
        id: record.instanceId,
        increment: opts.incrementResumeCount === true,
      });
      reg.update(record.instanceId, {
        status: 'RUNNING',
        resumeCount: (record.resumeCount ?? 0) + (opts.incrementResumeCount ? 1 : 0),
      });
      return { ok: true, pid: 42_001 };
    });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('no RUNNING rows → no spawn', () => {
    reg.register(baseRecord({ instanceId: 'ib-done', status: 'DONE' }));
    autoResumeStaleTasks(reg, spawn, { enabled: true, maxResumes: 3 });
    expect(spawn).not.toHaveBeenCalled();
    expect(reg.get('ib-done')?.status).toBe('DONE');
  });

  it('marks RUNNING as STOPPED then spawns each stale with incrementResumeCount', () => {
    reg.register(baseRecord({ instanceId: 'ib-a', status: 'RUNNING' }));
    reg.register(baseRecord({ instanceId: 'ib-b', status: 'RUNNING', resumeCount: 1 }));

    autoResumeStaleTasks(reg, spawn, { enabled: true, maxResumes: 3 });

    expect(spawnCalls.map((c) => c.id).sort()).toEqual(['ib-a', 'ib-b']);
    expect(spawnCalls.every((c) => c.increment)).toBe(true);
    expect(reg.get('ib-a')?.status).toBe('RUNNING');
    expect(reg.get('ib-b')?.resumeCount).toBe(2);
  });

  it('auto_resume off: STOPPED only, no spawn', () => {
    reg.register(baseRecord({ instanceId: 'ib-off', status: 'RUNNING' }));
    autoResumeStaleTasks(reg, spawn, { enabled: false, maxResumes: 3 });

    expect(spawn).not.toHaveBeenCalled();
    expect(reg.get('ib-off')?.status).toBe('STOPPED');
    expect(reg.get('ib-off')?.errorMessage).toMatch(/server 重启/);
  });

  it('skips spawn when resumeCount >= maxResumes', () => {
    reg.register(
      baseRecord({ instanceId: 'ib-max', status: 'RUNNING', resumeCount: 3 }),
    );
    autoResumeStaleTasks(reg, spawn, { enabled: true, maxResumes: 3 });

    expect(spawn).not.toHaveBeenCalled();
    expect(reg.get('ib-max')?.status).toBe('STOPPED');
    expect(reg.get('ib-max')?.errorMessage).toMatch(/已达自动 resume 上限/);
  });

  it('maxResumes=0 skips all spawns', () => {
    reg.register(baseRecord({ instanceId: 'ib-zero', status: 'RUNNING' }));
    autoResumeStaleTasks(reg, spawn, { enabled: true, maxResumes: 0 });

    expect(spawn).not.toHaveBeenCalled();
    expect(reg.get('ib-zero')?.errorMessage).toMatch(/已达自动 resume 上限 0/);
  });

  it('spawn failure leaves registry as caller updated (no throw)', () => {
    reg.register(baseRecord({ instanceId: 'ib-fail', status: 'RUNNING' }));
    const failSpawn: SpawnWorkerFn = () => ({ ok: false, error: 'mock spawn error' });

    expect(() =>
      autoResumeStaleTasks(reg, failSpawn, { enabled: true, maxResumes: 3 }),
    ).not.toThrow();

    expect(reg.get('ib-fail')?.status).toBe('STOPPED');
  });

  it('AWAITING rows are not touched by markStale', () => {
    reg.register(baseRecord({ instanceId: 'ib-wait', status: 'AWAITING' }));
    autoResumeStaleTasks(reg, spawn, { enabled: true, maxResumes: 3 });
    expect(spawn).not.toHaveBeenCalled();
    expect(reg.get('ib-wait')?.status).toBe('AWAITING');
  });
});
