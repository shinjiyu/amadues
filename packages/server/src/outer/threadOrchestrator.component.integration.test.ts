/**
 * ADL component: threadOrchestrator — 同 thread 串行 + freshCheck
 */
import { describe, expect, it } from 'vitest';

import { ThreadOrchestrator, makeFreshCheck } from './thread-orchestrator.js';

describe('component: threadOrchestrator', () => {
  it('同 thread 两次 schedule 串行执行', async () => {
    const orch = new ThreadOrchestrator({ jitterMinMs: 0, jitterMaxMs: 0 });
    const order: number[] = [];
    await orch.schedule('t-serial', async () => {
      order.push(1);
    });
    await orch.schedule('t-serial', async () => {
      order.push(2);
    });
    expect(order).toEqual([1, 2]);
  });

  it('makeFreshCheck：无抢先回复 → false（可发送）', async () => {
    const fresh = makeFreshCheck(
      { hasAnotherAgentRepliedAfter: () => false },
      'thread:fresh',
      'msg-trigger',
    );
    expect(await fresh()).toBe(false);
  });

  it('makeFreshCheck：已有抢先 → true（应跳过发送）', async () => {
    const fresh = makeFreshCheck(
      { hasAnotherAgentRepliedAfter: () => true },
      'thread:fresh',
      'msg-trigger',
    );
    expect(await fresh()).toBe(true);
  });
});
