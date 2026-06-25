/**
 * ADL component: completionNotify — 工作区 → IM 完成通知正文
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  buildCompletionMessageFromWorkspace,
  readLastCompleteEvent,
} from './completion-notify.js';

describe('component: completionNotify', () => {
  let tmp = '';

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('readLastCompleteEvent 取最后 COMPLETE（主路径）', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-comp-'));
    const runDir = path.join(tmp, '.run', 'pi-mono');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'output'),
      [
        JSON.stringify({ type: 'COMPLETE', message: 'done', deliverables: ['r.md'] }),
        JSON.stringify({ type: 'PROGRESS', message: 'noise' }),
      ].join('\n') + '\n',
      'utf8',
    );
    const ev = readLastCompleteEvent(tmp);
    expect(ev?.type).toBe('COMPLETE');
    expect(ev?.deliverables).toEqual(['r.md']);
  });

  it('buildCompletionMessageFromWorkspace IM 正文：结果优先（取 COMPLETE 结论）、不含里程碑过程/记忆事实', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-comp-'));
    const brain = path.join(tmp, '.brain');
    fs.mkdirSync(brain, { recursive: true });
    fs.writeFileSync(path.join(brain, 'goal.md'), '目标', 'utf8');
    fs.writeFileSync(
      path.join(brain, 'milestones.md'),
      '[M1] [Completed] 报告 — 描述\n> 输入范围：不应出现',
      'utf8',
    );
    // ADL §4.1：IM 结论来自 COMPLETE.message（priority 2），不读 knowledge/facts
    fs.writeFileSync(path.join(brain, 'knowledge.md'), '[事实] seed 记忆不应出现', 'utf8');
    const runDir = path.join(tmp, '.run', 'pi-mono');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'output'),
      JSON.stringify({ type: 'COMPLETE', message: '结论 9 分' }) + '\n',
      'utf8',
    );
    const { message } = buildCompletionMessageFromWorkspace(tmp);
    expect(message).toMatch(/## 结果|## 产出文件/);
    expect(message).toContain('结论 9 分');
    expect(message).not.toContain('seed 记忆不应出现');
    expect(message).not.toContain('输入范围');
    expect(message).not.toContain('## 里程碑进度');
  });
});
