/**
 * F 装配：runOuterRoundtrip（runInner=false，不 spawn 子进程）。
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { IdentityRegistry } from '@utlra/chat-ir';
import { ChatAssetStore } from '@utlra/chat-ir';
import { FilesystemRepositoryStore, FilesystemWorkspaceStore } from '../workspace-kit/index.js';
import { runOuterRoundtrip } from '../outer/orchestrator.js';
import { createTestDataRoot } from '../testing/temp-data-root.js';
import { createNoopEngine } from '../testing/agent-stack-fixture.js';

describe('integration: outer roundtrip assembly', () => {
  let cleanup: () => void;

  afterEach(() => {
    cleanup?.();
  });

  it('runInner=false → 模板回复 + threads 落库', async () => {
    const root = createTestDataRoot('roundtrip-asm-');
    cleanup = root.cleanup;

    const registry = new IdentityRegistry(path.join(root.dataRoot, 'identities.json'));
    const workspaceStore = new FilesystemWorkspaceStore(root.workspacesDir);
    const repoStore = new FilesystemRepositoryStore(root.dataRoot);
    const assetStore = new ChatAssetStore(path.join(root.dataRoot, 'uploads'));

    const threads = { messages: {} as Record<string, unknown[]>, threads: [] as unknown[] };
    const loadThreads = () => threads;
    const saveThreads = (d: typeof threads) => {
      Object.assign(threads, d);
    };

    const workspaceId = 'ws-roundtrip-asm';
    const threadId = 'thread:roundtrip-asm';
    const senderSid = 'human:carol';

    const result = await runOuterRoundtrip(
      {
        dataRoot: root.dataRoot,
        registry,
        getEngine: () => createNoopEngine(),
        loadThreads,
        saveThreads,
        workspaceStore,
        repoStore,
        assetStore,
      },
      {
        workspaceId,
        threadId,
        senderSid,
        userText: 'roundtrip 装配烟雾',
        runInner: false,
        outerLlmReply: false,
        skipParticipationCheck: true,
        threadKind: 'dm',
        isMentionAgent: true,
      },
    );

    expect(result.skipped).toBeFalsy();
    expect(result.runInner).toBe(false);
    expect(result.reply.text).toMatch(/未执行内脑 burst/);
    const msgs = threads.messages[threadId];
    expect(msgs?.length).toBeGreaterThan(0);
  });
});
