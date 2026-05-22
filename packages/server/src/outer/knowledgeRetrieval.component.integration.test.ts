/**
 * ADL component: knowledgeRetrieval — query → context + sources
 */
import { describe, expect, it } from 'vitest';

import type { FilesystemRepositoryStore } from '../workspace-kit/index.js';
import type { IdentityRegistry, LooseThreadStore } from '@utlra/chat-ir';

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
    expect(r.sources).toEqual({ repo: 0, currentThread: 0, crossThread: 0 });
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
