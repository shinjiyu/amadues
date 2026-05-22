import { defineConfig } from 'vitest/config';

/** 单元测试：单模块 / 纯函数 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['src/**/*.test.ts'],
    exclude: [
      'src/integration/**',
      'src/**/*.component.integration.test.ts',
      // 依赖外部 mem9 服务；本地/CI 用 test:integration 或单独 mock
      'src/mem9/mem9-client.test.ts',
      // Prompt 效果测试（真实 LLM）走 vitest.prompt.config.ts
      'src/**/*.prompt.test.ts',
    ],
  },
});
