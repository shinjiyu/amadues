/**
 * Decomposer · Prompt 效果（真实 LLM）。
 *
 * 硬断言：`runDecomposer` 返回 ok，且 `parseMilestonesFromContent` 至少一条 Active 里程碑。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { BrainFS, parseMilestonesFromContent } from '../brain/brain-fs.js';
import { createLogger } from '../logger/index.js';
import { createLlmAdapterForPrompt } from '../../testing/create-llm-adapter-for-prompt.js';
import { requireLlmEnvForPrompt } from '../../testing/require-llm.js';
import { runDecomposer } from './decomposer.js';

const llmEnv = requireLlmEnvForPrompt();
const llm = createLlmAdapterForPrompt(llmEnv);
const logger = createLogger('prompt-decomposer', os.tmpdir());

describe('decomposer.prompt · milestones 格式遵守', () => {
  let workDir = '';

  afterEach(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('初次规划 → 合格 milestones + 契约行（主路径）', async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decomp-prompt-'));
    const brain = new BrainFS(workDir);
    brain.writeGoal(
      '为开源项目写一份「快速开始」文档：包含安装、配置、运行三步，每步可验证。',
    );
    brain.appendConstraint('[红线] 不编造未提供的命令；不确定处标注待确认');

    const result = await runDecomposer(brain, null, llm, logger);
    expect(result.ok, result.error ?? 'decomposer failed').toBe(true);
    expect(result.milestonesContent).toMatch(/\[M\d+\]\s+\[Active\]/i);

    const parsed = parseMilestonesFromContent(result.milestonesContent);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.some((m) => m.status === 'Active')).toBe(true);

    const hasContract = result.milestonesContent.split('\n').some((l) => /^\s*>/.test(l));
    if (!hasContract) {
      console.warn('[prompt-test] decomposer 缺少 > 契约行（软警告，不 fail）');
    }
  }, 180_000);
});
