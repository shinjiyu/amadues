/**
 * ADL component: decomposer — runDecomposer + 里程碑格式校验
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { BrainFS } from '../brain/brain-fs.js';
import { createLogger } from '../logger/index.js';
import { createFakeLLM } from '../../testing/fake-llm.js';
import { runDecomposer } from './decomposer.js';

describe('component: decomposer', () => {
  let workDir = '';
  const logger = createLogger('test-agent', '/tmp');

  afterEach(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('LLM 返回合法 milestones → ok（主路径）', async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decomp-'));
    const brain = new BrainFS(workDir);
    brain.writeGoal('完成报告');
    const llm = createFakeLLM([
      {
        match: '战术拆解器',
        reply: {
          content: [
            '[M1] [Active] 起草 — 写初稿',
            '> 输入范围：报告章节',
            '[M2] [Pending] 审阅 — 检查格式',
            '> 交付物：pdf',
          ].join('\n'),
        },
      },
    ]);
    const r = await runDecomposer(brain, null, llm, logger);
    expect(r.ok).toBe(true);
    expect(r.milestonesContent).toContain('[M1]');
  });
});
