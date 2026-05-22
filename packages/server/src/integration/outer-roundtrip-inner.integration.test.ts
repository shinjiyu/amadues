/**
 * F 装配加深：runOuterRoundtrip + runInner:true（注入 spawn，不启真实子进程）。
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { IdentityRegistry } from '@utlra/chat-ir';
import { ChatAssetStore } from '@utlra/chat-ir';
import {
  FilesystemRepositoryStore,
  FilesystemWorkspaceStore,
  InnerBrainEngine,
} from '../workspace-kit/index.js';
import { runOuterRoundtrip } from '../outer/orchestrator.js';
import { createTestDataRoot } from '../testing/temp-data-root.js';
import { writeSyntheticWorkspace } from '../testing/workspace-factory.js';

describe('integration: outer roundtrip inner (injected spawn)', () => {
  let cleanup: () => void;

  afterEach(() => {
    cleanup?.();
  });

  it('runInner=true + mock spawn → exit=0 且回复提及 burst', async () => {
    const root = createTestDataRoot('roundtrip-inner-');
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

    const workspaceId = 'ws-roundtrip-inner';
    const threadId = 'thread:roundtrip-inner';
    const senderSid = 'human:dave';

    const result = await runOuterRoundtrip(
      {
        dataRoot: root.dataRoot,
        registry,
        getEngine: (ws) => new InnerBrainEngine(workspaceStore, ws),
        loadThreads,
        saveThreads,
        workspaceStore,
        repoStore,
        assetStore,
        spawnInnerBurst: async (_workspaceId, workDir) => {
          writeSyntheticWorkspace(workDir, {
            goal: '写 summary.md',
            deliverables: ['summary.md'],
            postComplete: true,
            reflexion: { verdict: 'success' },
          });
          return { code: 0, stdout: 'COMPLETE\n', stderr: '' };
        },
      },
      {
        workspaceId,
        threadId,
        senderSid,
        userText: '请完成一页摘要',
        runInner: true,
        outerLlmReply: false,
        skipParticipationCheck: true,
        threadKind: 'dm',
        isMentionAgent: true,
        maxTicks: 5,
      },
    );

    expect(result.runInner).toBe(true);
    expect(result.workerExitCode).toBe(0);
    expect(result.reply.text).toMatch(/内脑 burst 已结束/);
    expect(result.skipped).toBeFalsy();
    const msgs = threads.messages[threadId];
    expect(msgs?.length).toBeGreaterThan(0);
  });
});
