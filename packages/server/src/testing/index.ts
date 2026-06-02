/** @utlra/server 测试基建：临时 dataRoot、FakeIm / FakeLLM、AgentStack 场景夹具、可注入时钟。
 *
 * 仅供 `*.test.ts` / `*.integration.test.ts` 使用；业务代码禁止 import。
 * 设计契约见 doc/testing-strategy.md §3 标准与 §5 目录约定。
 */
export { createTestDataRoot, type TestDataRoot } from './temp-data-root.js';
export { FakeImChannel, type RecordedOutbound } from './fake-im-channel.js';
export { writeSyntheticWorkspace, type SyntheticWorkspaceOpts } from './workspace-factory.js';
export {
  createAgentStackFixture,
  createNoopEngine,
  type AgentStackFixture,
} from './agent-stack-fixture.js';
export {
  createFakeLLM,
  constLLM,
  type FakeLLM,
  type FakeLLMScript,
  type FakeLLMOptions,
  type FakeLLMCall,
} from './fake-llm.js';
export {
  createFakeClock,
  realClock,
  type Clock,
  type FakeClock,
} from './clock.js';
export {
  loadFixture,
  loadFixtureJson,
  fixturePath,
  getFixtureRoot,
  setFixtureRoot,
  resetFixtureRoot,
} from './load-fixture.js';
export {
  requireLlmEnvForPrompt,
  hasLlmEnv,
} from './require-llm.js';
export { createLlmAdapterForPrompt } from './create-llm-adapter-for-prompt.js';
export {
  createOuterBrainFixture,
  type OuterBrainFixture,
} from './outer-brain-fixture.js';
export {
  shouldRunSpawnInnerE2e,
  spawnInnerE2eSkipReason,
} from './require-spawn-inner.js';
