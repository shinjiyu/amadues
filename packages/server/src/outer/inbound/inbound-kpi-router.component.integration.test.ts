/**
 * ADL component: inboundKpiRouter — IM 入站 KPI / ad-hoc 分流（KPI-ADVANCEMENT.md §2）
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatAssetStore } from '@utlra/chat-ir';
import {
  FilesystemRepositoryStore,
  FilesystemWorkspaceStore,
  InnerBrainEngine,
} from '../../workspace-kit/index.js';
import { createTestDataRoot } from '../../testing/temp-data-root.js';
import { InnerBrainRegistry } from '../inner-brain-registry.js';
import { KpiRegistry } from '../kpi-registry.js';
import * as outerTools from '../outer-tools.js';
import { routeInboundKpiOrAdHoc } from './inbound-kpi-router.js';

describe('component: inboundKpiRouter', () => {
  let root: ReturnType<typeof createTestDataRoot>;

  afterEach(() => {
    vi.restoreAllMocks();
    root?.cleanup();
  });

  function buildDeps() {
    root = createTestDataRoot('inbound-kpi-router-');
    const kpiRegistry = new KpiRegistry(root.dataRoot);
    const innerBrainRegistry = new InnerBrainRegistry(root.dataRoot);
    const workspaces = path.join(root.dataRoot, 'workspaces');
    fs.mkdirSync(workspaces, { recursive: true });
    const workspaceStore = new FilesystemWorkspaceStore(workspaces);
    const engines = new Map<string, InnerBrainEngine>();

    const toolCtx = {
      threadId: 'thread-im',
      agentSid: 'agent:test',
      workspaceId: 'default',
      repoRoot: root.dataRoot,
      imClient: { postMessage: async () => {} } as never,
      assetStore: new ChatAssetStore(path.join(root.dataRoot, 'uploads')),
      getEngine: (wsId: string) => {
        let e = engines.get(wsId);
        if (!e) {
          e = new InnerBrainEngine(workspaceStore, wsId);
          engines.set(wsId, e);
        }
        return e;
      },
      workspaceStore,
      repoStore: new FilesystemRepositoryStore(root.dataRoot),
      dataRoot: root.dataRoot,
      innerBrainRegistry,
      kpiRegistry,
      inboundHumanSid: 'human:alice',
    };

    return {
      dataRoot: root.dataRoot,
      kpiRegistry,
      toolCtx,
      workspaceId: 'default',
      defaultThreadId: 'thread-im',
      originUser: 'human:alice',
      innerBrainRegistry,
    };
  }

  it('寒暄 → handled=false，走对话环', async () => {
    const deps = buildDeps();
    const r = await routeInboundKpiOrAdHoc(deps, '你好');
    expect(r.handled).toBe(false);
    expect(r.intent.kind).toBe('chat_only');
    expect(kpiRegistryCount(deps.kpiRegistry)).toBe(0);
  });

  it('长期 KPI 描述 → 建父 KPI + advance（mock spawn）', async () => {
    const deps = buildDeps();
    vi.spyOn(outerTools, 'executeOuterTool').mockResolvedValue({
      replied: false,
      output: '已创建新内脑实例并启动任务 instance_id=ib-kpi-route-1',
    });

    const msg = '建立台湾情报常态收集，每天中午和晚上汇报简报';
    const r = await routeInboundKpiOrAdHoc(deps, msg);

    expect(r.handled).toBe(true);
    expect(r.intent.kind).toBe('kpi_create');
    expect(r.replyText).toMatch(/已登记 KPI/);

    const parents = deps.kpiRegistry.list({ status: 'active' }).filter((k) => !k.isLeaf);
    expect(parents.length).toBe(1);
    expect(parents[0]?.kind).toBe('ongoing');

    const children = parents[0]?.children ?? [];
    expect(children.length).toBeGreaterThanOrEqual(1);

    const outerTool = vi.mocked(outerTools.executeOuterTool);
    expect(outerTool).toHaveBeenCalledWith(
      'set_goal',
      expect.stringContaining('kpi_id'),
      expect.objectContaining({ allowKpiSetGoal: true }),
    );
  });

  it('一次性杂活 → ad-hoc set_goal（无 kpi_id）', async () => {
    const deps = buildDeps();
    const spy = vi.spyOn(outerTools, 'executeOuterTool').mockResolvedValue({
      replied: false,
      output: '已创建新内脑实例并启动任务 instance_id=ib-adhoc-route-1',
    });

    const r = await routeInboundKpiOrAdHoc(deps, '帮我查一下今天东京天气');

    expect(r.handled).toBe(true);
    expect(r.intent.kind).toBe('ad_hoc_task');
    expect(r.replyText).toMatch(/已派发一次性任务/);
    expect(spy).toHaveBeenCalledWith(
      'set_goal',
      expect.not.stringContaining('kpi_id'),
      expect.objectContaining({ inboundHumanSid: 'human:alice' }),
    );
    expect(kpiRegistryCount(deps.kpiRegistry)).toBe(0);
  });
});

function kpiRegistryCount(reg: KpiRegistry): number {
  return reg.list().length;
}
