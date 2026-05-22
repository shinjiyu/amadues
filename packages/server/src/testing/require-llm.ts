/**
 * Prompt 测试用：要求 process.env 中至少配置一个 LLM provider key，否则**直接抛错**让测试 fail。
 *
 * 设计依据（doc/testing-strategy.md §S3、§7 E）：
 *   - 测 prompt 效果的用例必须打真实 LLM；
 *   - 缺 key 时**不能静默 skip**，否则会让 prompt 退化失去验证（用户拍板，Q2=B）。
 *
 * 用法：
 * ```ts
 * import { requireLlmEnvForPrompt } from '../testing/require-llm.js';
 *
 * describe('foo.prompt', () => {
 *   const env = requireLlmEnvForPrompt();
 *   it('LLM 能产出 SPEAK/SILENT', async () => { ... });
 * });
 * ```
 *
 * helper 在测试文件顶层（describe 外）调用即可——`loadInnerLlmEnvFromProcess` 拿不到时直接抛，
 * vitest 会把该测试文件全部标红，符合「缺 key 直接失败」约束。
 */
import { loadInnerLlmEnvFromProcess, type InnerLlmEnv } from '../llm/inner-llm-step.js';

const HINT = [
  '[prompt-test] LLM env not configured.',
  '请在仓库根的 .env（或 .env.local）配置以下任一 provider key：',
  '  - ZHIPU_API_KEY  (推荐，主链路 provider)',
  '  - KIMI_API_KEY',
  '  - LOCALMODULE_API_KEY',
  '已配置后请用 `node --env-file=../../.env ...` 或 vitest 自身的 env 加载。',
  '若想在本机临时跳过 prompt 套件，请运行 `npm run test:unit` 与 `npm run test:integration`。',
].join('\n');

/**
 * 加载真实 LLM env；缺 key 时**抛错**（让该测试文件整体 fail）。
 *
 * 注意：调用方应在 `describe` 顶层或文件顶层调用，
 * 这样 vitest 在收集阶段就能给出清晰失败信息。
 */
export function requireLlmEnvForPrompt(): InnerLlmEnv {
  const env = loadInnerLlmEnvFromProcess();
  if (!env) throw new Error(HINT);
  return env;
}

/**
 * 弱版：仅检测是否有任一 key，不抛错。用于在 `describe.skipIf(...)` 中条件性 skip
 * **某些**（非主路径）prompt 用例。Q2=B 原则下不推荐——主路径应该用 `requireLlmEnvForPrompt`。
 */
export function hasLlmEnv(): boolean {
  return loadInnerLlmEnvFromProcess() !== null;
}
