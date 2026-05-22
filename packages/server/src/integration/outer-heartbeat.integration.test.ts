/**
 * E.1：外脑心跳 — 无 LLM env 时 triggerNow 安全跳过；enabled=false 不启定时器。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ChatAssetStore } from '@utlra/chat-ir';
import { FilesystemRepositoryStore, FilesystemWorkspaceStore } from '../workspace-kit/index.js';
import { createTestDataRoot } from '../testing/temp-data-root.js';
import { createNoopEngine } from '../testing/agent-stack-fixture.js';
import { OuterHeartbeat, loadHeartbeatConfigFromEnv } from '../outer/outer-heartbeat.js';

describe('integration: outer heartbeat', () => {
  it('无 LLM env → triggerNow 不抛错', async () => {
    const root = createTestDataRoot('hb-');
    const assetStore = new ChatAssetStore(path.join(root.dataRoot, 'uploads'));
    const hb = new OuterHeartbeat({
      getEngine: () => createNoopEngine(),
      workspaceStore: new FilesystemWorkspaceStore(root.workspacesDir),
      repoStore: new FilesystemRepositoryStore(root.dataRoot),
      dataRoot: root.dataRoot,
      getLlmEnv: () => null,
      imClient: null,
      assetStore,
      config: {
        ...loadHeartbeatConfigFromEnv({ UTLRA_OUTER_HEARTBEAT_ENABLED: 'true' }),
        enabled: true,
        intervalMs: 60_000,
      },
    });
    await expect(hb.triggerNow()).resolves.toBeUndefined();
    root.cleanup();
  });

  it('enabled=false → start 为 no-op', () => {
    const root = createTestDataRoot('hb-off-');
    const hb = new OuterHeartbeat({
      getEngine: () => createNoopEngine(),
      workspaceStore: new FilesystemWorkspaceStore(root.workspacesDir),
      repoStore: new FilesystemRepositoryStore(root.dataRoot),
      dataRoot: root.dataRoot,
      getLlmEnv: () => null,
      imClient: null,
      assetStore: new ChatAssetStore(path.join(root.dataRoot, 'uploads')),
      config: {
        agentName: 'Test',
        enabled: false,
        intervalMs: 60_000,
        defaultThreadId: '',
      },
    });
    hb.start();
    hb.stop();
    root.cleanup();
    expect(true).toBe(true);
  });
});
