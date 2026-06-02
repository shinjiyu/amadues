import { describe, expect, it } from 'vitest';

import {
  evaluateInnerBrainRestart,
  restartEligibilityErrorMessage,
} from './inner-brain-restart-policy.js';
import type { TaskRecord } from './inner-brain-registry.js';

function row(partial: Partial<TaskRecord> & Pick<TaskRecord, 'status'>): TaskRecord {
  return {
    instanceId: 'ib-test-0001',
    workspaceId: 'task-ib-test-0001',
    workDir: '/tmp/w',
    goal: 'g',
    originUser: 'u',
    startedAt: new Date().toISOString(),
    ...partial,
  } as TaskRecord;
}

describe('evaluateInnerBrainRestart', () => {
  it('rejects RUNNING with alive pid', () => {
    const el = evaluateInnerBrainRestart(row({ status: 'RUNNING', pid: process.pid }));
    expect(el.allowed).toBe(false);
    if (!el.allowed) expect(el.reason).toBe('alive_running');
  });

  it('allows RUNNING when pid is dead', () => {
    const el = evaluateInnerBrainRestart(row({ status: 'RUNNING', pid: 2_147_483_647 }));
    expect(el).toEqual({ allowed: true, reason: 'dead_running' });
  });

  it('allows RUNNING without pid', () => {
    const el = evaluateInnerBrainRestart(row({ status: 'RUNNING', pid: undefined }));
    expect(el).toEqual({ allowed: true, reason: 'dead_running' });
  });

  it('allows STOPPED', () => {
    expect(evaluateInnerBrainRestart(row({ status: 'STOPPED' }))).toEqual({
      allowed: true,
      reason: 'stopped',
    });
  });

  it('rejects DONE', () => {
    const el = evaluateInnerBrainRestart(row({ status: 'DONE' }));
    expect(el.allowed).toBe(false);
  });

  it('error message for alive running', () => {
    const el = evaluateInnerBrainRestart(row({ status: 'RUNNING', pid: process.pid }));
    if (!el.allowed) {
      expect(restartEligibilityErrorMessage('ib-x', el)).toContain('正在运行中');
    }
  });
});
