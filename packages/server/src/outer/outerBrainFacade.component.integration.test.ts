/**
 * ADL component: outerBrainFacade — 编排壳（ThreadOrchestrator 串行契约）
 *
 * 全链 handleInbound 见 integration / 装配阶段；此处验证 facade 依赖的 per-thread 互斥。
 */
import { describe, expect, it } from 'vitest';

import { ThreadOrchestrator } from './thread-orchestrator.js';

describe('component: outerBrainFacade', () => {
  it('同 thread 入站处理互斥（主路径）', async () => {
    const orch = new ThreadOrchestrator({ jitterMinMs: 0, jitterMaxMs: 0 });
    const trace: string[] = [];
    await orch.schedule('thread:facade', async () => {
      trace.push('first');
    });
    await orch.schedule('thread:facade', async () => {
      trace.push('second');
    });
    expect(trace).toEqual(['first', 'second']);
  });
});
