import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatAssetStore } from '@utlra/chat-ir';
import { FilesystemRepositoryStore, FilesystemWorkspaceStore } from '../workspace-kit/index.js';
import { createTestDataRoot, type TestDataRoot } from '../testing/temp-data-root.js';
import { InnerBrainRegistry } from './inner-brain-registry.js';
import { KpiRegistry } from './kpi-registry.js';
import { OuterHeartbeat } from './outer-heartbeat.js';

describe('component: outerHeartbeat digital employee fallback', () => {
  let root: TestDataRoot;

  afterEach(() => root?.cleanup());

  it('triggers the shared loop even when no heartbeat LLM is configured', async () => {
    root = createTestDataRoot('heartbeat-digital-employee-');
    const triggerDigitalEmployee = vi.fn().mockResolvedValue(undefined);
    const heartbeat = new OuterHeartbeat({
      getEngine: vi.fn() as never,
      workspaceStore: new FilesystemWorkspaceStore(root.workspacesDir),
      repoStore: new FilesystemRepositoryStore(root.dataRoot),
      dataRoot: root.dataRoot,
      getLlmEnv: () => null,
      imClient: null,
      assetStore: new ChatAssetStore(path.join(root.dataRoot, 'uploads')),
      innerBrainRegistry: new InnerBrainRegistry(root.dataRoot),
      kpiRegistry: new KpiRegistry(root.dataRoot),
      triggerDigitalEmployee,
      config: {
        agentName: 'test',
        enabled: true,
        intervalMs: 60_000,
        defaultThreadId: 'thread-1',
      },
    });

    await heartbeat.triggerNow();
    expect(triggerDigitalEmployee).toHaveBeenCalledOnce();
  });
});
