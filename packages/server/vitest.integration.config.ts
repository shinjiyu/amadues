import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { defineConfig } from 'vitest/config';

/** 集成测试：临时 dataRoot + 多模块编排（默认无真实 LLM / 子进程） */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const envPath = resolve(repoRoot, '.env');
const envLocal = resolve(repoRoot, '.env.local');

if (existsSync(envPath)) dotenv.config({ path: envPath });
if (existsSync(envLocal)) dotenv.config({ path: envLocal, override: true });

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: [
      'src/integration/**/*.test.ts',
      'src/**/*.component.integration.test.ts',
    ],
    exclude: ['src/**/*.prompt.test.ts'],
  },
});
