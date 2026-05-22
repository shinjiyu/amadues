/**
 * Attributor · Prompt 效果（真实 LLM）。
 *
 * 硬断言：产出含可被 `parseControlFlag` 解析的 CONTROL（非「无法解析」兜底）。
 * 软观察：场景与 flag 是否一致（console.warn，不 fail）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { BrainFS, type ExecutionEntry } from '../brain/brain-fs.js';
import { createLogger } from '../logger/index.js';
import { createToolRegistry } from '../tools/index.js';
import { createLlmAdapterForPrompt } from '../../testing/create-llm-adapter-for-prompt.js';
import { requireLlmEnvForPrompt } from '../../testing/require-llm.js';
import { runAttributor, type ControlFlag } from './attributor.js';

const llmEnv = requireLlmEnvForPrompt();
const llm = createLlmAdapterForPrompt(llmEnv);
const logger = createLogger('prompt-attributor', os.tmpdir());
const emptyTools = createToolRegistry([]);

const PARSE_FAIL = '无法解析 CONTROL flag';

function milestone(id: string, title: string, desc: string) {
  return {
    id,
    status: 'Active' as const,
    title,
    description: desc,
  };
}

describe('attributor.prompt · CONTROL 格式遵守', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const r of roots.splice(0)) {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  async function runScenario(
    label: string,
    opts: {
      log: ExecutionEntry[];
      pre: string;
      post: string;
      expectFlags?: ControlFlag[];
    },
  ) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-prompt-'));
    roots.push(workDir);
    const brain = new BrainFS(workDir);
    brain.writeGoal('完成 API 集成验证');
    brain.writeMilestones('[M1] [Active] 调用接口 — 拿到 200 响应\n> 输入范围：公开 REST\n> 交付物：响应摘要');

    const result = await runAttributor(
      milestone('M1', '调用接口', '拿到 200 响应'),
      opts.pre,
      opts.log,
      opts.post,
      emptyTools,
      llm,
      logger,
      brain,
    );

    expect(result.reason).not.toContain(PARSE_FAIL);
    expect(result.rawContent.length).toBeGreaterThan(0);
    expect(['CONTINUE', 'SUCCESS_AND_NEXT', 'REPLAN', 'BLOCK', 'CYCLE_DONE']).toContain(result.flag);

    if (opts.expectFlags && !opts.expectFlags.includes(result.flag)) {
      console.warn(
        `[prompt-test] attributor「${label}」期望 ${opts.expectFlags.join('|')}，实际 ${result.flag}；reason=${result.reason.slice(0, 80)}`,
      );
    }
    return result;
  }

  it('执行成功、无错误 → 可解析 CONTROL（主路径）', async () => {
    await runScenario('成功', {
      pre: '环境：staging API 可达',
      log: [
        {
          toolName: 'http_get',
          args: { url: 'https://example.com/health' },
          result: { ok: true, output: '{"status":"ok"}' },
        },
      ],
      post: '已获得 200 与 JSON body',
      expectFlags: ['CONTINUE', 'SUCCESS_AND_NEXT'],
    });
  }, 180_000);

  it('工具连续失败 → 可解析 CONTROL', async () => {
    await runScenario('失败', {
      pre: '环境：需登录',
      log: [
        {
          toolName: 'http_get',
          args: { url: 'https://api.example.com/data' },
          result: { ok: false, output: '401 Unauthorized' },
          error: '认证失败',
        },
      ],
      post: '仍无有效 token',
      expectFlags: ['REPLAN', 'BLOCK'],
    });
  }, 180_000);

  it('容量/配额类错误 → 可解析 CONTROL', async () => {
    await runScenario('容量不足', {
      pre: '环境：第三方配额',
      log: [
        {
          toolName: 'search_api',
          args: { q: 'test' },
          result: { ok: false, output: '429 Too Many Requests — daily quota exceeded' },
          error: 'rate limit',
        },
      ],
      post: '配额未恢复',
      expectFlags: ['REPLAN', 'BLOCK'],
    });
  }, 180_000);

  it('外脑改需求、与里程碑背离 → 可解析 CONTROL', async () => {
    await runScenario('需重规划', {
      pre: '原目标：写 Python 脚本',
      log: [
        {
          toolName: 'read_file',
          args: { path: 'notes.txt' },
          result: { ok: true, output: '用户改为只要 Markdown 摘要，不要代码' },
        },
      ],
      post: '用户最新消息：不要写代码，只要一页纸摘要',
      expectFlags: ['REPLAN'],
    });
  }, 180_000);
});
