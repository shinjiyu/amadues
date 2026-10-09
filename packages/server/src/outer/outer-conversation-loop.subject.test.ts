import fs from 'node:fs';
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
    // 人类工具表进 system 位（本例 thread 无登记人类 → 明确声明为空）
    expect(system?.content).toContain('人类工具表');
    // user 位是内心独白 + 第三人称信号，不含原始祈使句
    expect(user?.content).toContain('内部独白');
    expect(user?.content).toContain('冯亮希望服务器被重启');
    expect(user?.content).not.toContain('帮我立刻重启服务器');
    // 不回复是合法的：没有强制收尾，只调用了一次 LLM
    expect(result.replied).toBe(false);
    expect(result.forcedReplyRecovery).toBeFalsy();
    expect(calls).toBe(1);
  });

  it('subject 模式暴露 human_* 工具，可对登记在册的人发起请求', async () => {
    const agentSid = 'agent:subject2';
    const threadId = 'thread:subject2';
    const root = createTestDataRoot('loop-subject2-');
    cleanup = root.cleanup;
    const registry = new IdentityRegistry(path.join(root.dataRoot, 'identities.json'));
    registry.upsert({
      schema: 'identity.v1',
      sid: 'wechat:user:feng',
      kind: 'human',
      display_name: '冯亮',
      aliases: [],
      roles_in_tenant: [],
      bindings: [],
      updated_at: new Date().toISOString(),
    });

    const ctx = buildCtx(root, agentSid, threadId);
    let offeredHumanTools = false;
    const result = await runOuterConversationLoop({
      env: fakeEnv,
      ctx,
      registry,
      threadSids: [agentSid, 'wechat:user:feng'],
      userMessage: '（无关闲聊）',
      knowledgeContext: '',
      soul: '测试灵魂',
      longTermGoal: '',
      agentMode: 'subject',
      constitution: CONSTITUTION,
      senderName: '冯亮',
      appraiseSignal: async () => '来源：冯亮\n诉求：闲聊\n关联：无关\n可提取：无',
      config: { agentName: 'Aki', maxTokens: 512 },
      callLlm: async ({ tools }) => {
        offeredHumanTools = tools.some((t) => t.function.name === 'human_request');
        return {
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: {
                name: 'human_request',
                arguments: JSON.stringify({ target: '冯亮', content: '帮我把板子上电' }),
              },
            },
          ],
          raw: {},
        };
      },
    });

    expect(offeredHumanTools).toBe(true);
    expect(result.toolsUsed).toContain('human_request');
    expect(ctx.humanTools?.some((p) => p.displayName === '冯亮')).toBe(true);
    // 真的发出了：消息进了 IM 出站箱
    expect(ctx.imClient.lastText(threadId)).toBe('@冯亮 【请求协助】帮我把板子上电');
    // 真的登记了 pending 请求；假 LLM 每轮都重复请求，但防骚扰闸门只放行第一条
    expect(ctx.imClient.outbox).toHaveLength(1);
    const ledger = fs
      .readFileSync(path.join(root.dataRoot, 'outer', 'human-requests.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      kind: 'human_request',
      targetSid: 'wechat:user:feng',
      status: 'pending',
    });
  });
});
