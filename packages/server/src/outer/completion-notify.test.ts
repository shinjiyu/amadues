import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';

import {
  buildCompletionMessageFromWorkspace,
  readLastCompleteEvent,
  shouldNotifyUserOnBurstExit,
} from './completion-notify.js';

describe('completion-notify', () => {
  let tmp = '';

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('readLastCompleteEvent ignores trailing PROGRESS after COMPLETE', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-notify-'));
    const runDir = path.join(tmp, '.run', 'pi-mono');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'output'),
      [
        JSON.stringify({ type: 'COMPLETE', message: 'done with results', deliverables: ['r.md'] }),
        JSON.stringify({ type: 'PROGRESS', message: 'still working...' }),
      ].join('\n') + '\n',
      'utf8',
    );
    const ev = readLastCompleteEvent(tmp);
    expect(ev?.type).toBe('COMPLETE');
    expect(ev?.message).toContain('results');
    expect(ev?.deliverables).toEqual(['r.md']);
  });

  it('buildCompletionMessageFromWorkspace includes knowledge and report excerpt', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-notify-'));
    const brain = path.join(tmp, '.brain');
    const runDir = path.join(tmp, '.run', 'pi-mono');
    fs.mkdirSync(brain, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(brain, 'goal.md'), '测试目标', 'utf8');
    fs.writeFileSync(
      path.join(brain, 'milestones.md'),
      '[M1] [Completed] 写报告 — 很长描述\n> 输入范围：xxx',
      'utf8',
    );
    fs.writeFileSync(path.join(brain, 'knowledge.md'), '[事实] 用户 A 得分 9 分', 'utf8');
    fs.writeFileSync(
      path.join(tmp, 'final_report.md'),
      '## 总结\n完成了评估。\n\n' + '细节行。\n'.repeat(20),
      'utf8',
    );
    fs.writeFileSync(
      path.join(runDir, 'output'),
      JSON.stringify({
        type: 'COMPLETE',
        message: '所有里程碑已完成。\n\n## 最终目标\n测试\n\n## 完成的里程碑\n很长过程…',
        deliverables: ['final_report.md'],
      }) + '\n',
      'utf8',
    );

    const { message } = buildCompletionMessageFromWorkspace(tmp);
    expect(message).toContain('## 结果');
    expect(message).toContain('完成了评估');
    expect(message).not.toContain('## 里程碑进度');
    expect(message).not.toContain('输入范围');
    expect(message).not.toContain('## 任务目标');
    expect(message).not.toContain('## 自评');
  });

  it('shouldNotifyUserOnBurstExit：KPI 不通知，ad-hoc 通知', () => {
    expect(shouldNotifyUserOnBurstExit({ kpiId: 'kpi-1' })).toBe(false);
    expect(shouldNotifyUserOnBurstExit({})).toBe(true);
    expect(shouldNotifyUserOnBurstExit({ kpiId: '' })).toBe(true);
  });
});
