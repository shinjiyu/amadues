/**
 * 单元测试：InnerBrainRegistry
 *
 * 重点覆盖自动 resume 相关行为：
 *   - markStaleRunningAsStopped 返回所有曾经 RUNNING 的任务
 *   - resumeCount 持久化往返
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { InnerBrainRegistry, type TaskRecord } from './inner-brain-registry.js';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ibreg-'));
}

function baseRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    instanceId: 'ib-test-0001',
    workspaceId: 'task-ib-test-0001',
    workDir: '/tmp/task-ib-test-0001',
    goal: 'test goal',
    originUser: 'user-x',
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('InnerBrainRegistry.markStaleRunningAsStopped', () => {
  it('returns previously-RUNNING tasks and marks them STOPPED', () => {
    const root = makeRoot();
    const reg = new InnerBrainRegistry(root);

    reg.register(baseRecord({ instanceId: 'ib-a', status: 'RUNNING' }));
    reg.register(baseRecord({ instanceId: 'ib-b', status: 'RUNNING', resumeCount: 2 }));
    reg.register(baseRecord({ instanceId: 'ib-c', status: 'DONE' }));
    reg.register(baseRecord({ instanceId: 'ib-d', status: 'BLOCKED' }));

    const stale = reg.markStaleRunningAsStopped();
    const staleIds = stale.map((r) => r.instanceId).sort();

    expect(staleIds).toEqual(['ib-a', 'ib-b']);
    expect(stale.find((r) => r.instanceId === 'ib-b')?.resumeCount).toBe(2);

    expect(reg.get('ib-a')?.status).toBe('STOPPED');
    expect(reg.get('ib-a')?.errorMessage).toMatch(/server 重启/);
    expect(reg.get('ib-b')?.status).toBe('STOPPED');
    expect(reg.get('ib-c')?.status).toBe('DONE');
    expect(reg.get('ib-d')?.status).toBe('BLOCKED');
  });

  it('returns empty array when nothing was RUNNING', () => {
    const reg = new InnerBrainRegistry(makeRoot());
    reg.register(baseRecord({ instanceId: 'ib-x', status: 'DONE' }));
    expect(reg.markStaleRunningAsStopped()).toEqual([]);
  });
});

describe('InnerBrainRegistry persistence', () => {
  it('round-trips resumeCount across instances', () => {
    const root = makeRoot();
    const a = new InnerBrainRegistry(root);
    a.register(baseRecord({ instanceId: 'ib-rc', status: 'RUNNING' }));
    a.update('ib-rc', { resumeCount: 1 });
    a.update('ib-rc', { resumeCount: 2 });

    const b = new InnerBrainRegistry(root); // 从同一 dataRoot 重新加载
    const reloaded = b.get('ib-rc');
    expect(reloaded?.resumeCount).toBe(2);
  });
});
