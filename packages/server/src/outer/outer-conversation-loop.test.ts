import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { IdentityRegistry } from '@utlra/chat-ir';
import { ChatAssetStore } from '@utlra/chat-ir';
import { FilesystemRepositoryStore, FilesystemWorkspaceStore } from '../workspace-kit/index.js';
import type { InnerLlmEnv } from '../llm/inner-llm-step.js';
import { runOuterConversationLoop } from './outer-conversation-loop.js';
import { OUTER_REPLY_ONLY_TOOL_DEFS } from './outer-tools.js';
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

describe('runOuterConversationLoop forced reply recovery', () => {
  let cleanup: () => void;

  afterEach(() => {
    cleanup?.();
  });

  it('主循环只调研不回复 → 强制 reply_to_user 轮（其它工具禁用）', async () => {
    const im = new FakeImChannel();
    const agentSid = 'agent:recovery';
    const threadId = 'thread:recovery';
    const root = createTestDataRoot('loop-recovery-');
    cleanup = root.cleanup;

    const registry = new IdentityRegistry(path.join(root.dataRoot, 'identities.json'));
    registry.upsert({
      schema: 'identity.v1',
      sid: agentSid,
      kind: 'agent',
      display_name: 'Kuroneko',
      aliases: [],
      roles_in_tenant: ['agent'],
      bindings: [],
      updated_at: new Date().toISOString(),
    });

    const workspaceStore = new FilesystemWorkspaceStore(root.workspacesDir);
    const repoStore = new FilesystemRepositoryStore(root.dataRoot);
    const assetStore = new ChatAssetStore(path.join(root.dataRoot, 'uploads'));
    workspaceStore.ensureWorkspace('ws-recovery');

    let callCount = 0;
    const result = await runOuterConversationLoop({
      env: fakeEnv,
      ctx: {
        threadId,
        agentSid,
        workspaceId: 'ws-recovery',
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
      userMessage: '介绍一下技术细节',
      knowledgeContext: '',
      soul: '你是测试外脑。',
      longTermGoal: '',
      config: { agentName: 'Kuroneko', maxTokens: 512 },
      callLlm: async ({ tools, toolChoice }) => {
        callCount++;
        const isRecovery =
          tools.length === OUTER_REPLY_ONLY_TOOL_DEFS.length &&
          toolChoice &&
          typeof toolChoice === 'object' &&
          toolChoice.type === 'function' &&
          toolChoice.function.name === 'reply_to_user';

        if (isRecovery) {
          return {
            content: null,
            tool_calls: [
              {
                id: 'tc-recovery',
                type: 'function',
                function: {
                  name: 'reply_to_user',
                  arguments: JSON.stringify({ text: '强制收尾：酒馆渗透报告在这。' }),
                },
              },
            ],
            raw: {},
          };
        }

        return {
          content: null,
          tool_calls: [
            {
              id: `tc-research-${callCount}`,
              type: 'function',
              function: {
                name: 'list_kpis',
                arguments: '{}',
              },
            },
          ],
          raw: {},
        };
      },
    });

    expect(result.replied).toBe(true);
    expect(result.forcedReplyRecovery).toBe(true);
    expect(result.toolsUsed).toContain('reply_to_user');
    const out = im.messagesMatching(/强制收尾/, threadId);
    expect(out.length).toBeGreaterThan(0);
    expect(callCount).toBeGreaterThan(1);
  });

  it('强制收尾 LLM 仍无 tool → 硬编码 fallback 仍发出 reply_to_user', async () => {
    const im = new FakeImChannel();
    const agentSid = 'agent:recovery-fb';
    const threadId = 'thread:recovery-fb';
    const root = createTestDataRoot('loop-recovery-fb-');
    cleanup = root.cleanup;

    const registry = new IdentityRegistry(path.join(root.dataRoot, 'identities.json'));
    const workspaceStore = new FilesystemWorkspaceStore(root.workspacesDir);
    const repoStore = new FilesystemRepositoryStore(root.dataRoot);
    const assetStore = new ChatAssetStore(path.join(root.dataRoot, 'uploads'));
    workspaceStore.ensureWorkspace('ws-fb');

    const result = await runOuterConversationLoop({
      env: fakeEnv,
      ctx: {
        threadId,
        agentSid,
        workspaceId: 'ws-fb',
        imClient: im,
        assetStore,
        getEngine: () => createNoopEngine(),
        workspaceStore,
        repoStore,
        dataRoot: root.dataRoot,
        loadThreads: () => ({ messages: {}, threads: [] }),
      },
      registry,
      threadSids: [agentSid],
      userMessage: '在吗',
      knowledgeContext: '',
      soul: '你是测试外脑。',
      longTermGoal: '',
      config: { agentName: 'Kuroneko', maxTokens: 512 },
      callLlm: async ({ tools, toolChoice }) => {
        const isRecovery =
          tools.length === 1 &&
          toolChoice &&
          typeof toolChoice === 'object' &&
          toolChoice.function?.name === 'reply_to_user';
        if (isRecovery) {
          return { content: null, tool_calls: [], raw: {} };
        }
        return {
          content: null,
          tool_calls: [
            {
              id: 'tc-1',
              type: 'function',
              function: { name: 'read_memory', arguments: '{}' },
            },
          ],
          raw: {},
        };
      },
    });

    expect(result.replied).toBe(true);
    expect(result.forcedReplyRecovery).toBe(true);
    expect(im.messagesMatching(/抱歉，刚才处理久了点/, threadId).length).toBeGreaterThan(0);
  });
});

describe('runOuterConversationLoop empty-promise recovery', () => {
  let cleanup: () => void;

  afterEach(() => {
    cleanup?.();
  });

  it('祈使 + 口头答应 + 未派活 → 纠偏轮；改口确认', async () => {
    const im = new FakeImChannel();
    const agentSid = 'agent:empty-promise';
    const threadId = 'thread:empty-promise';
    const root = createTestDataRoot('loop-empty-promise-');
    cleanup = root.cleanup;

    const registry = new IdentityRegistry(path.join(root.dataRoot, 'identities.json'));
    registry.upsert({
      schema: 'identity.v1',
      sid: agentSid,
      kind: 'agent',
      display_name: 'Kuroneko',
      aliases: [],
      roles_in_tenant: ['agent'],
      bindings: [],
      updated_at: new Date().toISOString(),
    });

    const workspaceStore = new FilesystemWorkspaceStore(root.workspacesDir);
    const repoStore = new FilesystemRepositoryStore(root.dataRoot);
    const assetStore = new ChatAssetStore(path.join(root.dataRoot, 'uploads'));
    workspaceStore.ensureWorkspace('ws-ep');

    let callCount = 0;
    let sawEmptyPromisePrompt = false;
    const result = await runOuterConversationLoop({
      env: fakeEnv,
      ctx: {
        threadId,
        agentSid,
        workspaceId: 'ws-ep',
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
      userMessage: '帮我查一下今天天气',
      knowledgeContext: '',
      soul: '你是测试外脑。',
      longTermGoal: '',
      config: { agentName: 'Kuroneko', maxTokens: 512 },
      callLlm: async ({ messages }) => {
        callCount++;
        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
        const content = typeof lastUser?.content === 'string' ? lastUser.content : '';
        if (content.includes('系统空口对账')) {
          sawEmptyPromisePrompt = true;
          return {
            content: null,
            tool_calls: [
              {
                id: 'tc-retract',
                type: 'function',
                function: {
                  name: 'reply_to_user',
                  arguments: JSON.stringify({ text: '还没派，要我现在开跑吗？' }),
                },
              },
            ],
            raw: {},
          };
        }
        return {
          content: null,
          tool_calls: [
            {
              id: 'tc-promise',
              type: 'function',
              function: {
                name: 'reply_to_user',
                arguments: JSON.stringify({ text: '好的，我去办' }),
              },
            },
          ],
          raw: {},
        };
      },
    });

    expect(result.emptyPromiseRecovery).toBe(true);
    expect(sawEmptyPromisePrompt).toBe(true);
    expect(callCount).toBe(2);
    expect(im.messagesMatching(/还没派/, threadId).length).toBeGreaterThan(0);
  });
});
