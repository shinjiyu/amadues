import { describe, expect, it, vi } from 'vitest';

import * as llmRaw from '../../llm/raw.js';
import {
  buildAwaitingReviewLlmCaller,
  buildAwaitingReviewPrompt,
  parseAwaitingReviewLlmResponse,
  resolveAwaitingReviewLlmCaller,
} from './kpi-awaiting-review-llm.js';
import type { TaskRecord } from '../inner-brain-registry.js';

describe('kpi-awaiting-review-llm', () => {
  it('parseAwaitingReviewLlmResponse 解析 JSON', () => {
    expect(
      parseAwaitingReviewLlmResponse('{"reasonable":false,"reason":"空转无 pending"}'),
    ).toEqual({ reasonable: false, reason: '空转无 pending' });
    expect(parseAwaitingReviewLlmResponse('not json')).toBeNull();
  });

  it('buildAwaitingReviewPrompt 含 burst 上下文', () => {
    const rec: TaskRecord = {
      instanceId: 'ib-1',
      workspaceId: 'task-ib-1',
      workDir: '/tmp/w',
      goal: 'collect intel',
      originUser: 'u',
      status: 'AWAITING',
      startedAt: new Date().toISOString(),
    };
    const prompt = buildAwaitingReviewPrompt(rec, {
      controller: { mode: 'AWAITING', awaiting_reason: null, blocked_reason: null, cycle_count: null },
      active_pendings: [],
      next_wake_at: null,
      is_async_waiting: true,
      is_post_complete: false,
      has_ask_user_pending: false,
    });
    expect(prompt).toContain('ib-1');
    expect(prompt).toContain('collect intel');
    expect(prompt).toContain('"reasonable"');
  });

  it('buildAwaitingReviewLlmCaller 调 LLM 并返回正文', async () => {
    vi.spyOn(llmRaw, 'llmRawChatCompletion').mockResolvedValue({
      raw: { choices: [{ message: { content: '{"reasonable":true}' } }] },
      status: 200,
    });
    const caller = buildAwaitingReviewLlmCaller({
      provider: 'kimi',
      apiKey: 'k',
      baseUrl: 'http://localhost',
      textModel: 'm',
    });
    const text = await caller('prompt');
    expect(text).toContain('reasonable');
    vi.restoreAllMocks();
  });

  it('resolveAwaitingReviewLlmCaller 无 env → undefined', () => {
    expect(resolveAwaitingReviewLlmCaller(() => null)).toBeUndefined();
  });
});
