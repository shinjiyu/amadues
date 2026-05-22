import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

import dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';

/**
 * Prompt 效果测试：**真实 LLM**。
 *
 * 设计依据（doc/testing-strategy.md §S3 / §7 E）：
 * - 凡测「prompt 设计能否让 LLM 产出预期格式 / 类别」的用例归此。
 * - 缺 LLM key 时**直接 fail**（由 `requireLlmEnvForPrompt()` 抛错），不静默 skip。
 * - 单次断言用语义匹配（包含 / 不包含某 token）而非精确字符串。
 *
 * env 加载顺序（仅当对应变量**尚未**在 process.env 中时才覆写，遵循 dotenv 默认）：
 *   1. 仓库根 `.env`
 *   2. 仓库根 `.env.local`（若存在，本机覆盖）
 *
 * timeout 拉大到 120s 以容忍冷启动与首 token 等待。
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const envPath = resolve(repoRoot, '.env');
const envLocal = resolve(repoRoot, '.env.local');

if (existsSync(envPath)) dotenv.config({ path: envPath });
if (existsSync(envLocal)) dotenv.config({ path: envLocal, override: true });

// Prompt 套件：缩短流式空闲超时与重试，避免单测挂到 120s 才失败
if (!process.env['LLM_STREAM_IDLE_MS']?.trim()) {
  process.env['LLM_STREAM_IDLE_MS'] = '90000';
}
if (!process.env['LLM_MAX_RETRIES']?.trim()) {
  process.env['LLM_MAX_RETRIES'] = '2';
}

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 30_000,
    include: ['src/**/*.prompt.test.ts'],
    sequence: { concurrent: false },
  },
});
