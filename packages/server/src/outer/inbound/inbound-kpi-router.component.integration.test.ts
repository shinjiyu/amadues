/**
 * ADL component: inboundContextAssembler — IM 入站只读上下文 + hint
 * （IM-INBOUND-INTENT-ROUTING.md §4 方案一：前置层不派发，只装配上下文注入对话环）
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestDataRoot } from '../../testing/temp-data-root.js';
import { InnerBrainRegistry } from '../inner-brain-registry.js';
import { KpiRegistry } from '../kpi-registry.js';
import { assembleInboundContext, renderInboundHint } from './inbound-kpi-router.js';

describe('component: inboundContextAssembler', () => {
  let root: ReturnType<typeof createTestDataRoot>;

  afterEach(() => {
    root?.cleanup();
  });

  function buildDeps() {
    root = createTestDataRoot('inbound-ctx-');
    const kpiRegistry = new KpiRegistry(root.dataRoot);
    const innerBrainRegistry = new InnerBrainRegistry(root.dataRoot);
    return {
      kpiRegistry,
      innerBrainRegistry,
      defaultThreadId: 'thread-im',
      originUser: 'human:alice',
    };
  }

  it('无 KPI / burst → 空上下文；hint 含「（无）」+ 决策指引', () => {
    const deps = buildDeps();
    const ctx = assembleInboundContext(deps);
    expect(ctx.activeKpis).toEqual([]);
    expect(ctx.liveBursts).toEqual([]);
    const hint = renderInboundHint(ctx);
    expect(hint).toContain('入站上下文');
    expect(hint).toContain('（无）');
    expect(hint).toContain('切忌为闲聊新建 KPI');
  });

  it('只收本人 active KPI（过滤他人）；hint 含 kpiId', () => {
    const deps = buildDeps();
    const mine = deps.kpiRegistry.create({
      description: '台湾情报常态收集，每天汇报',
      createdBy: 'human:alice',
      kind: 'ongoing',
    });
    deps.kpiRegistry.create({
      description: '别人的 KPI',
      createdBy: 'human:bob',
      kind: 'ongoing',
    });

    const ctx = assembleInboundContext(deps);
    expect(ctx.activeKpis.map((k) => k.kpiId)).toEqual([mine.kpiId]);

    const hint = renderInboundHint(ctx);
    expect(hint).toContain(mine.kpiId);
    expect(hint).toContain('台湾情报常态收集');
    expect(hint).not.toContain('别人的 KPI');
  });

  it('在跑 burst 进入上下文；hint 含 instanceId + 状态', () => {
    const deps = buildDeps();
    deps.innerBrainRegistry.register({
      instanceId: 'ib-live-1',
      workspaceId: 'task-ib-live-1',
      workDir: path.join(root.dataRoot, 'workspaces', 'task-ib-live-1'),
      goal: '下载并启动项目',
      originUser: 'human:alice',
      originThread: 'thread-im',
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });

    const ctx = assembleInboundContext(deps);
    expect(ctx.liveBursts.map((b) => b.instanceId)).toEqual(['ib-live-1']);

    const hint = renderInboundHint(ctx);
    expect(hint).toContain('ib-live-1');
    expect(hint).toContain('RUNNING');
    expect(hint).toContain('下载并启动项目');
  });

  it('零副作用：装配上下文不新建 KPI、不派发 burst', () => {
    const deps = buildDeps();
    deps.kpiRegistry.create({
      description: '已存在 KPI',
      createdBy: 'human:alice',
      kind: 'ongoing',
    });
    const kpiBefore = deps.kpiRegistry.list().length;
    const burstBefore = deps.innerBrainRegistry.list().length;

    // 多次装配/渲染（即使是「长期/一次性杂活」类文本也与本层无关——本层不读消息）
    for (let i = 0; i < 3; i++) {
      renderInboundHint(assembleInboundContext(deps));
    }

    expect(deps.kpiRegistry.list().length).toBe(kpiBefore);
    expect(deps.innerBrainRegistry.list().length).toBe(burstBefore);
  });
});
