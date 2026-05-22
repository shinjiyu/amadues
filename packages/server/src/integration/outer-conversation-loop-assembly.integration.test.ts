/**
 * F 装配：runOuterConversationLoop + 注入 callLlm → reply_to_user → FakeIm。
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { IdentityRegistry } from '@utlra/chat-ir';
import { ChatAssetStore } from '@utlra/chat-ir';
import { FilesystemRepositoryStore, FilesystemWorkspaceStore } from '../workspace-kit/index.js';
import type { InnerLlmEnv } from '../llm/inner-llm-step.js';
import { runOuterConversationLoop } from '../outer/outer-conversation-loop.js';
import { createTestDataRoot } from '../testing/temp-data-root.js';
import { FakeImChannel } from '../testing/fake-im-channel.js';
import { createNoopEngine } from '../testing/agent-stack-fixture.js';

const fakeEnv: InnerLlmEnv = {
  provider: 'zhipu',
  apiKey: 'fake-key',
  baseUrl: 'https://example.test/v1',
  textModel: 'test',
  visionModel: 'test',
  maxTokensText: 512,
  maxTokensMultimodal: 512,
  thinking: 'disabled',
};

describe('integration: outer conversation loop assembly', () => {
  let cleanup: () => void;

  afterEach(() => {
    cleanup?.();
  });

  it('Fake callLlm 调用 reply_to_user → IM 出站', async () => {
    const im = new FakeImChannel();
    const agentSid = 'agent:loop-assembly';
    const threadId = 'thread:loop-assembly';
    const root = createTestDataRoot('loop-asm-');
    cleanup = root.cleanup;

    const registry = new IdentityRegistry(path.join(root.dataRoot, 'identities.json'));
    registry.upsert({
      schema: 'identity.v1',
      sid: agentSid,
      kind: 'agent',
      display_name: 'LoopBot',
      aliases: [],
      roles_in_tenant: ['agent'],
      bindings: [],
      updated_at: new Date().toISOString(),
    });

    const workspaceStore = new FilesystemWorkspaceStore(root.workspacesDir);
    const repoStore = new FilesystemRepositoryStore(root.dataRoot);
    const assetStore = new ChatAssetStore(path.join(root.dataRoot, 'uploads'));
    workspaceStore.ensureWorkspace('ws-assembly');

    const result = await runOuterConversationLoop({
      env: fakeEnv,
      ctx: {
        threadId,
        agentSid,
        workspaceId: 'ws-assembly',
        imClient: im,
        assetStore,
        getEngine: () => createNoopEngine(),
        workspaceStore,
        repoStore,
        dataRoot: root.dataRoot,
        loadThreads: () => ({ messages: {}, threads: [] }),
      },
      registry,
      threadSids: [agentSid, 'human:bob'],
      userMessage: '请回复装配烟雾',
      knowledgeContext: '',
      soul: '你是测试外脑。',
      longTermGoal: '完成装配验证。',
      config: { agentName: 'LoopBot', maxTokens: 512 },
      callLlm: async () => ({
        content: null,
        tool_calls: [
          {
            id: 'tc-asm-1',
            type: 'function',
            function: {
              name: 'reply_to_user',
              arguments: JSON.stringify({ text: '装配烟雾：外脑已回复。' }),
            },
          },
        ],
        raw: {},
      }),
    });

    expect(result.replied).toBe(true);
    expect(result.toolsUsed).toContain('reply_to_user');
    const out = im.messagesMatching(/装配烟雾/, threadId);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]!.body.text).toContain('装配烟雾');
  });
});
