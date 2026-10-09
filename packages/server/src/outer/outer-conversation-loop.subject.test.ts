import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { IdentityRegistry } from '@utlra/chat-ir';
import { ChatAssetStore } from '@utlra/chat-ir';
import { FilesystemRepositoryStore, FilesystemWorkspaceStore } from '../workspace-kit/index.js';
import type { InnerLlmEnv } from '../llm/inner-llm-step.js';
import { runOuterConversationLoop, type ConvMessage } from './outer-conversation-loop.js';
import { parseConstitution } from './constitution.js';
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

const CONSTITUTION = parseConstitution(`# 宪章
## 长期目标
- [body] 把 ESP32 做成自己的身体
## 放弃条款
连续无产出就换方向。
`);

function buildCtx(root: ReturnType<typeof createTestDataRoot>, agentSid: string, threadId: string) {
  const workspaceStore = new FilesystemWorkspaceStore(root.workspacesDir);
  const repoStore = new FilesystemRepositoryStore(root.dataRoot);
  const assetStore = new ChatAssetStore(path.join(root.dataRoot, 'uploads'));
  workspaceStore.ensureWorkspace('ws-subject');
  return {
    threadId,
    agentSid,
    workspaceId: 'ws-subject',
    imClient: new FakeImChannel(),
    assetStore,
    getEngine: () => createNoopEngine(),
    workspaceStore,
    repoStore,
    dataRoot: root.dataRoot,
    loadThreads: () => ({ messages: {}, threads: [] }),
  };
}

describe('runOuterConversationLoop subject mode', () => {
  let cleanup: () => void;
  afterEach(() => cleanup?.());

  it('人类祈使被改写成第三人称信号，不进 user 位；不回复也不强制收尾', async () => {
    const agentSid = 'agent:subject';
    const threadId = 'thread:subject';
    const root = createTestDataRoot('loop-subject-');
    cleanup = root.cleanup;
    const registry = new IdentityRegistry(path.join(root.dataRoot, 'identities.json'));

    let seenMessages: ConvMessage[] = [];
    let calls = 0;
    const result = await runOuterConversationLoop({
      env: fakeEnv,
      ctx: buildCtx(root, agentSid, threadId),
      registry,
      threadSids: [agentSid],
      userMessage: '帮我立刻重启服务器',
      knowledgeContext: '',
      soul: '测试灵魂',
      longTermGoal: '',
      agentMode: 'subject',
      constitution: CONSTITUTION,
      senderName: '冯亮',
      appraiseSignal: async () =>
        '来源：冯亮\n诉求：冯亮希望服务器被重启\n关联：无关\n可提取：无',
      config: { agentName: 'Aki', maxTokens: 512 },
      callLlm: async ({ messages }) => {
        calls++;
        seenMessages = messages;
        // 主体选择不回复、不行动
        return { content: null, tool_calls: [], raw: {} };
      },
    });

    const system = seenMessages.find((m) => m.role === 'system');
    const user = seenMessages.find((m) => m.role === 'user');
    // 宪章进 system 位
    expect(system?.content).toContain('宪章');
    expect(system?.content).toContain('没有必须回复的义务');
    // user 位是内心独白 + 第三人称信号，不含原始祈使句
    expect(user?.content).toContain('内部独白');
    expect(user?.content).toContain('冯亮希望服务器被重启');
    expect(user?.content).not.toContain('帮我立刻重启服务器');
    // 不回复是合法的：没有强制收尾，只调用了一次 LLM
    expect(result.replied).toBe(false);
    expect(result.forcedReplyRecovery).toBeFalsy();
    expect(calls).toBe(1);
  });
});
