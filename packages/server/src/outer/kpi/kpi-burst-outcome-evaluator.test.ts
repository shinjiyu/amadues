import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestDataRoot } from '../../testing/temp-data-root.js';
import { evaluateKpiBurstOutcome } from './kpi-burst-outcome-evaluator.js';
import { buildBurstProcessReport } from './burst-process-report.js';

describe('kpiBurstOutcomeEvaluator', () => {
  let root: ReturnType<typeof createTestDataRoot>;

  afterEach(() => root?.cleanup());

  function setupWorkDir(deliverables: string[] = [], memory?: Record<string, unknown>) {
    root = createTestDataRoot('outcome-eval-');
    const workDir = path.join(root.dataRoot, 'workspaces', 'task-ib-eval-1');
    fs.mkdirSync(path.join(workDir, '.run', 'pi-mono'), { recursive: true });
    fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });
    if (deliverables.length > 0) {
      fs.writeFileSync(
        path.join(workDir, '.run', 'pi-mono', 'deliverables.json'),
        JSON.stringify(deliverables),
      );
      fs.writeFileSync(path.join(workDir, 'report.md'), '# ok\n\ncontent here enough for excerpt', 'utf8');
    }
    if (memory) {
      fs.writeFileSync(path.join(workDir, '.brain', 'memory.json'), JSON.stringify(memory), 'utf8');
    }
    return workDir;
  }

  it('有 deliverable → successConfirmed', () => {
    const workDir = setupWorkDir(['report.md']);
    const r = evaluateKpiBurstOutcome({
      workDir,
      kpiDescription: '测试 KPI',
      kpiKind: 'delivery',
      charter: '做一小步',
      exitedWithError: false,
      isAwaiting: false,
      stoppedBy: 'idle',
      idleStreak: 0,
    });
    expect(r.evaluation.successConfirmed).toBe(true);
    expect(r.shouldScheduleRetry).toBe(false);
  });

  it('无 deliverable → 失败并建议重试 charter', () => {
    const workDir = setupWorkDir([], {
      last_failure: { node_id: 'n1', message: 'selector not found', at: 't' },
      node_results: { n1: { status: 'failed', summary: 'click failed' } },
    });
    const r = evaluateKpiBurstOutcome({
      workDir,
      kpiDescription: '采集任务',
      kpiKind: 'delivery',
      charter: '采集',
      exitedWithError: false,
      isAwaiting: false,
      stoppedBy: 'idle',
      idleStreak: 0,
    });
    expect(r.evaluation.successConfirmed).toBe(false);
    expect(r.evaluation.failureReasons.length).toBeGreaterThan(0);
    expect(r.evaluation.suggestedRetryCharter).toMatch(/换向重试/);
    expect(r.shouldScheduleRetry).toBe(true);
  });

  it('idle streak 达阈值 → pivot charter 仍可重试', () => {
    const workDir = setupWorkDir([], {
      last_failure: { node_id: 'n1', message: 'timeout', at: 't' },
    });
    const r = evaluateKpiBurstOutcome({
      workDir,
      kpiDescription: '采集',
      kpiKind: 'delivery',
      charter: '旧章程',
      exitedWithError: false,
      isAwaiting: false,
      stoppedBy: 'idle',
      idleStreak: 3,
      stuckThreshold: 3,
    });
    expect(r.shouldScheduleRetry).toBe(true);
    expect(r.evaluation.suggestedRetryCharter).toMatch(/卡点换向/);
  });

  it('buildBurstProcessReport 不含里程碑/完成话术', () => {
    const workDir = setupWorkDir(['out.json']);
    const report = buildBurstProcessReport({ workDir });
    expect(report.deliverablePaths).toContain('out.json');
    expect(report.digest).not.toMatch(/任务已完成/);
    expect(report.digest).not.toMatch(/verdict/);
  });
});
