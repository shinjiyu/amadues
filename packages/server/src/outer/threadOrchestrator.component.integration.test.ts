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

  it('处理中积压多条入站时按 FIFO 全部执行（不丢中间 @）', async () => {
    const orch = new ThreadOrchestrator({ jitterMinMs: 0, jitterMaxMs: 0 });
    const order: number[] = [];
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const first = orch.schedule('t-q', async () => {
      await firstDone;
      order.push(1);
    });
    await new Promise((r) => setTimeout(r, 10));
    void orch.schedule('t-q', async () => {
      order.push(2);
    });
    void orch.schedule('t-q', async () => {
      order.push(3);
    });
    await new Promise((r) => setTimeout(r, 10));
    releaseFirst();
    await first;
    await new Promise((r) => setTimeout(r, 20));
    expect(order).toEqual([1, 2, 3]);
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
