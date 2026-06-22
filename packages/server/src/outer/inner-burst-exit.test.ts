import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import {
  detectBurstGoalGaps,
  isDyflowBurstFailure,
  resolveInnerBurstFinalStatus,
} from './inner-burst-exit.js';

describe('inner-burst-exit', () => {
  let root = '';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'burst-exit-'));
    fs.mkdirSync(path.join(root, '.brain'), { recursive: true });
  });

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('isDyflowBurstFailure: ERROR mode', () => {
    fs.writeFileSync(
      path.join(root, '.brain', 'dyflow-state.json'),
      JSON.stringify({ mode: 'ERROR', reason: 'Designer LLM 调用失败：503', updatedAt: '' }),
      'utf8',
    );
    expect(isDyflowBurstFailure(root)).toEqual({
      failed: true,
      reason: 'Designer LLM 调用失败：503',
    });
  });

  it('isDyflowBurstFailure: legacy DONE + 空转 reason', () => {
    fs.writeFileSync(
      path.join(root, '.brain', 'dyflow-state.json'),
      JSON.stringify({
        mode: 'DONE',
        reason: 'Designer 连续 3 次空转，无法推进：LLM 调用失败',
        updatedAt: '',
      }),
      'utf8',
    );
    expect(isDyflowBurstFailure(root).failed).toBe(true);
  });

  it('isDyflowBurstFailure: success DONE', () => {
    fs.writeFileSync(
      path.join(root, '.brain', 'dyflow-state.json'),
      JSON.stringify({ mode: 'DONE', reason: 'goal achieved', updatedAt: '' }),
      'utf8',
    );
    expect(isDyflowBurstFailure(root).failed).toBe(false);
  });

  it('resolveInnerBurstFinalStatus maps dyflow failure to ERROR on exit 0', () => {
    fs.writeFileSync(
      path.join(root, '.brain', 'dyflow-state.json'),
      JSON.stringify({ mode: 'ERROR', reason: 'LLM 503', updatedAt: '' }),
      'utf8',
    );
    const r = resolveInnerBurstFinalStatus({
      workDir: root,
      exitCode: 0,
      signal: null,
      stoppedBy: 'idle',
    });
    expect(r.finalStatus).toBe('ERROR');
    expect(r.errorMessage).toContain('LLM 503');
  });

  it('resolveInnerBurstFinalStatus keeps success DONE', () => {
    fs.writeFileSync(
      path.join(root, '.brain', 'dyflow-state.json'),
      JSON.stringify({ mode: 'DONE', reason: 'all good', updatedAt: '' }),
      'utf8',
    );
    expect(
      resolveInnerBurstFinalStatus({
        workDir: root,
        exitCode: 0,
        signal: null,
        stoppedBy: 'idle',
      }).finalStatus,
    ).toBe('DONE');
  });

  it('resolveInnerBurstFinalStatus maps Windows crash exit to readable ERROR', () => {
    const r = resolveInnerBurstFinalStatus({
      workDir: root,
      exitCode: 3221226505,
      signal: null,
      stoppedBy: 'exit',
    });
    expect(r.finalStatus).toBe('ERROR');
    expect(r.errorMessage).toContain('0xC0000409');
  });

  it('detectBurstGoalGaps: deploy goal + [BLOCKED] fact → hasGap', () => {
    fs.writeFileSync(
      path.join(root, '.brain', 'goal.md'),
      '搭建网站并部署到 onlyclaws.world，SSH 到 43.159.57.96',
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, '.brain', 'memory.json'),
      JSON.stringify({
        facts: [
          '[BLOCKED] 沙箱出站 SSH 被安全组阻断，项目本地完整但未远程部署。',
        ],
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, '.brain', 'dyflow-state.json'),
      JSON.stringify({ mode: 'DONE', reason: '本地代码完成', updatedAt: '' }),
      'utf8',
    );
    const gaps = detectBurstGoalGaps(root);
    expect(gaps.hasGap).toBe(true);
    expect(gaps.blocked).toBe(true);
    expect(gaps.issues[0]).toContain('SSH');
  });

  it('resolveInnerBurstFinalStatus: DONE dyflow + deploy blocked → ERROR partial', () => {
    fs.writeFileSync(
      path.join(root, '.brain', 'goal.md'),
      '部署到 onlyclaws.world',
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, '.brain', 'memory.json'),
      JSON.stringify({
        facts: ['chronicle-app 完整但未远程部署（沙箱 SSH 受限）。'],
      }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, '.brain', 'dyflow-state.json'),
      JSON.stringify({
        mode: 'DONE',
        reason: '远程部署限制：沙箱 SSH 被阻断',
        updatedAt: '',
      }),
      'utf8',
    );
    const r = resolveInnerBurstFinalStatus({
      workDir: root,
      exitCode: 0,
      signal: null,
      stoppedBy: 'idle',
    });
    expect(r.finalStatus).toBe('ERROR');
    expect(r.partialWithDeliverables).toBe(true);
    expect(r.errorMessage).toContain('未达成的目标');
    expect(r.errorMessage).toContain('需要你协助');
  });

  it('detectBurstGoalGaps: no deploy goal → no gap even with BLOCKED fact', () => {
    fs.writeFileSync(path.join(root, '.brain', 'goal.md'), '写一份本地报告', 'utf8');
    fs.writeFileSync(
      path.join(root, '.brain', 'memory.json'),
      JSON.stringify({ facts: ['[BLOCKED] something'] }),
      'utf8',
    );
    expect(detectBurstGoalGaps(root).hasGap).toBe(false);
  });
});
