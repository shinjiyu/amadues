/**
 * Reflexion · Prompt 效果（真实 LLM）。
 *
 * 硬断言：`runReflexion` 产出可解析 JSON（非 LLM 失败兜底文案）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { BrainFS } from '../brain/brain-fs.js';
import { createLogger } from '../logger/index.js';
import { createLlmAdapterForPrompt } from '../../testing/create-llm-adapter-for-prompt.js';
import { requireLlmEnvForPrompt } from '../../testing/require-llm.js';
import { parseReflexionJson, runReflexion } from './reflexion.js';

const llmEnv = requireLlmEnvForPrompt();
const llm = createLlmAdapterForPrompt(llmEnv);
const logger = createLogger('prompt-reflexion', os.tmpdir());

const FALLBACK_MARK = '反思 LLM 失败';

function writeBrain(workDir: string, opts: { verdict?: string; blocked?: boolean }): BrainFS {
  const brain = new BrainFS(workDir);
  brain.writeGoal('查询某公司公开财报并写一页摘要');
  brain.writeMilestones(
    opts.blocked
      ? '[M1] [Active] 抓取数据 — API 拒绝\n'
      : '[M1] [Completed] 抓取数据 — 已拿到 CSV\n[M2] [Completed] 写摘要 — 已落盘 summary.md\n',
  );
  if (opts.verdict) {
    brain.appendConstraint('[红线] 不使用非公开数据源');
    brain.appendKnowledge('[事实] 公开 API 返回 403');
  }
  return brain;
}

describe('reflexion.prompt · reasoning JSON 格式遵守', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const r of roots.splice(0)) {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  it('BLOCK 退出 → verdict 字段可解析（主路径）', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refl-prompt-'));
    roots.push(workDir);
    const brain = writeBrain(workDir, { blocked: true });

    const result = await runReflexion({
      brain,
      trigger: 'BLOCK',
      triggerReason: '公开 API 403，需要用户提供授权',
      llm,
      logger,
    });

    expect(['success', 'partial', 'failed']).toContain(result.verdict);
    expect(result.hardFailures.every((h) => !h.includes(FALLBACK_MARK))).toBe(true);
    const reparsed = parseReflexionJson(result.rawContent || '{}');
    expect(reparsed).not.toBeNull();
    if (result.verdict === 'success') {
      console.warn('[prompt-test] BLOCK 场景 reflexion 返回 success（软警告）');
    }
  }, 180_000);

  it('COMPLETE 退出 → verdict 字段可解析', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'refl-prompt-'));
    roots.push(workDir);
    const brain = writeBrain(workDir, {});

    const result = await runReflexion({
      brain,
      trigger: 'COMPLETE',
      triggerReason: '里程碑均 Completed，产出 summary.md',
      llm,
      logger,
    });

    expect(['success', 'partial', 'failed']).toContain(result.verdict);
    expect(result.hardFailures.every((h) => !h.includes(FALLBACK_MARK))).toBe(true);
    expect(parseReflexionJson(result.rawContent || '{}')).not.toBeNull();
    if (result.verdict !== 'success' && result.verdict !== 'partial') {
      console.warn(`[prompt-test] COMPLETE 场景期望 success/partial，实际 ${result.verdict}`);
    }
  }, 180_000);
});
