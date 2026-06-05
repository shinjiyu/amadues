import { afterEach, describe, expect, it } from 'vitest';
import { createTestDataRoot } from '../testing/temp-data-root.js';
import { InnerBrainRegistry } from './inner-brain-registry.js';
import { KpiRegistry } from './kpi-registry.js';
import { dispatchKpiBurst, type KpiApiDispatchDeps } from './kpi-api-dispatch.js';
import { ChatAssetStore } from '@utlra/chat-ir';
import fs from 'node:fs';
import path from 'node:path';
import {
  FilesystemRepositoryStore,
  FilesystemWorkspaceStore,
  InnerBrainEngine,
} from '../workspace-kit/index.js';

describe('dispatchKpiBurst', () => {
  let root: ReturnType<typeof createTestDataRoot>;
  let deps: KpiApiDispatchDeps;

  afterEach(() => {
    root?.cleanup();
  });

  function setup() {
    root = createTestDataRoot('kpi-api-dispatch-');
    const innerBrainRegistry = new InnerBrainRegistry(root.dataRoot);
    const kpiRegistry = new KpiRegistry(root.dataRoot);
    const workspaces = path.join(root.dataRoot, 'workspaces');
    fs.mkdirSync(workspaces, { recursive: true });
    const store = new FilesystemWorkspaceStore(workspaces);
    const engines = new Map<string, InnerBrainEngine>();
    deps = {
      dataRoot: root.dataRoot,
      repoRoot: root.dataRoot,
      innerBrainRegistry,
      kpiRegistry,
      assetStore: new ChatAssetStore(path.join(root.dataRoot, 'uploads')),
      getEngine: (wsId) => {
        let e = engines.get(wsId);
        if (!e) {
          e = new InnerBrainEngine(store, wsId);
          engines.set(wsId, e);
        }
        return e;
      },
      workspaceStore: store,
      repoStore: new FilesystemRepositoryStore(root.dataRoot),
      defaultThreadId: 'thread:test',
    };
    return kpiRegistry.create({ description: '写 hello.txt', createdBy: 'test' }).kpiId;
  }

  it('active KPI → set_goal 成功并挂 kpiId', async () => {
    const kpiId = setup();
    const r = await dispatchKpiBurst(deps, kpiId, {
      goal: '创建 hello.txt，内容为 hi',
    });
    expect(r.ok).toBe(true);
    expect(r.instanceId).toMatch(/^ib-/);
    const rec = deps.innerBrainRegistry.get(r.instanceId!);
    expect(rec?.kpiId).toBe(kpiId);
    expect(deps.kpiRegistry.get(kpiId)?.bursts).toContain(r.instanceId);
  });

  it('无 burst 的 achieve 场景：abandoned KPI 拒绝派发', async () => {
    const kpiId = setup();
    deps.kpiRegistry.abandon(kpiId, 'test');
    const r = await dispatchKpiBurst(deps, kpiId);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('kpi_status_abandoned');
  });
});
