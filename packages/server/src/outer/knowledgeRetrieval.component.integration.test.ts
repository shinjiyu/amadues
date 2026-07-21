/**
 * ADL component: knowledgeRetrieval — query → context + sources
 * P3 按人跨会话记忆：IDENTITY-CROSS-CHANNEL.md §6.5
 */
import { describe, expect, it } from 'vitest';

import type { FilesystemRepositoryStore } from '../workspace-kit/index.js';
import { IdentityBindingIndex, type IdentityRegistry, type LooseThreadStore } from '@utlra/chat-ir';

import { retrieveComprehensiveKnowledge } from './knowledge-retrieval.js';

describe('component: knowledgeRetrieval', () => {
  const emptyRepo = {
    retrieve: () => [],
  } as unknown as FilesystemRepositoryStore;

  const loadThreads = (): LooseThreadStore => ({
    messages: {},
    threads: {},
  });

  const registry = {} as IdentityRegistry;

  it('无命中 → 空 context（主路径）', () => {
    const r = retrieveComprehensiveKnowledge({
      query: '   ',
      threadId: 'thread:empty',
      workspaceId: 'ws-1',
      repoStore: emptyRepo,
      loadThreads,
      registry,
    });
    expect(r.context).toBe('');
    expect(r.sources).toEqual({ repo: 0, currentThread: 0, crossThread: 0, person: 0 });
  });

  it('P3：sender 在其它渠道 thread 的发言注入「关于此人」块', () => {
    const currentThread = 'feishu:cli_1:chat:oc_now';
    const dmThread = 'webchat:dm:alice';
    const now = new Date().toISOString();
    const load = (): LooseThreadStore => ({
      threads: [
        {
          schema: 'thread.v1',
          thread_id: dmThread,
          tenant_id: 'default',
          channel: 'webchat',
          kind: 'dm',
          participant_sids: ['webchat:user:alice'],
          created_at: now,
        },
      ],
      messages: {
        [currentThread]: [
          {
            schema: 'message.v1',
            message_id: 'm-now',
            thread_id: currentThread,
            sender_sid: 'idp:user:alice',
            sent_at: now,
            parts: [{ type: 'text', text: '还记得我说过什么吗' }],
          },
        ],
        [dmThread]: [
          {
            schema: 'message.v1',
            message_id: 'm-dm',
            thread_id: dmThread,
            sender_sid: 'webchat:user:alice',
            sent_at: now,
            parts: [{ type: 'text', text: '我最喜欢的编辑器是 neovim' }],
          },
        ],
      },
    });
    // 双边确认后：webchat + feishu 都并到 idp:user:alice
    const index = new IdentityBindingIndex({ persistPath: null });
    index.bind({ channel: 'webchat', native_user_id: 'alice' }, 'idp:user:alice');
    index.bind({ channel: 'feishu', native_user_id: 'on_a', scope: 'cli_1' }, 'idp:user:alice');

    const r = retrieveComprehensiveKnowledge({
      query: '还记得我说过什么吗',
      threadId: currentThread,
      workspaceId: 'ws-1',
      repoStore: emptyRepo,
      loadThreads: load,
      registry,
      senderSid: 'idp:user:alice',
      bindingIndex: index,
    });
    expect(r.context).toContain('关于此人');
    expect(r.context).toContain('neovim');
    expect(r.sources.person).toBeGreaterThan(0);
  });

  it('P3：无 senderSid（或 agent 自己）→ 不注入 person 块', () => {
    const r = retrieveComprehensiveKnowledge({
      query: '你好',
      threadId: 'thread:empty',
      workspaceId: 'ws-1',
      repoStore: emptyRepo,
      loadThreads,
      registry,
      senderSid: 'idp:agent:shiro',
      bindingIndex: new IdentityBindingIndex({ persistPath: null }),
    });
    expect(r.context).not.toContain('关于此人');
    expect(r.sources.person).toBe(0);
  });

  it('当前线程有消息 → sources.currentThread > 0', () => {
    const threadId = 'thread:has-msg';
    const load = (): LooseThreadStore => ({
      threads: { [threadId]: { thread_id: threadId, participant_sids: ['u1', 'agent'] } },
      messages: {
        [threadId]: [
          {
            message_id: 'm1',
            thread_id: threadId,
            sender_sid: 'u1',
            parts: [{ type: 'text', text: '你好' }],
            created_at: new Date().toISOString(),
          },
        ],
      },
    });
    const r = retrieveComprehensiveKnowledge({
      query: '你好',
      threadId,
      workspaceId: 'ws-1',
      repoStore: emptyRepo,
      loadThreads: load,
      registry,
    });
    expect(r.context).toContain('背景知识');
    expect(r.sources.currentThread).toBeGreaterThan(0);
  });
});
