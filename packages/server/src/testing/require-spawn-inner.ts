/**
 * 可选「真实内脑子进程」集成烟测门控。
 *
 * 默认 CI / 日常 `test:integration` **不跑**（避免慢、耗 token、环境依赖）。
 * 本机验收时：
 *
 *   UTLRA_TEST_SPAWN_INNER=1 npm run test:integration -w @utlra/server
 *
 * 并确保根 `.env` 已配置 LLM key（子进程继承 process.env）。
 */
import { loadInnerLlmEnvFromProcess } from '../llm/inner-llm-step.js';

export function shouldRunSpawnInnerE2e(): boolean {
  return (
    process.env['UTLRA_TEST_SPAWN_INNER']?.trim() === '1' &&
    loadInnerLlmEnvFromProcess() !== null
  );
}

export function spawnInnerE2eSkipReason(): string {
  if (process.env['UTLRA_TEST_SPAWN_INNER']?.trim() !== '1') {
    return 'set UTLRA_TEST_SPAWN_INNER=1 to enable live inner-worker spawn tests';
  }
  if (!loadInnerLlmEnvFromProcess()) {
    return 'LLM env missing (ZHIPU_API_KEY / KIMI_API_KEY / LOCALMODULE_API_KEY)';
  }
  return '';
}
