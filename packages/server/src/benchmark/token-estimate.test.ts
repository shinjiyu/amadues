/**
 * Token 估算 — 单元测
 */
import { describe, expect, it } from 'vitest';

import type { FakeLLMCall } from '../testing/fake-llm.js';
import {
  estimatePromptTokensForCall,
  estimatePromptTokensFromCalls,
} from './token-estimate.js';

describe('benchmark token-estimate', () => {
  it('empty messages → system-only tokens', () => {
    const call: FakeLLMCall = {
      systemPrompt: 'abcd',
      messages: [],
      matchedIndex: 0,
      matchedLabel: 'test',
    };
    expect(estimatePromptTokensForCall(call)).toBe(1);
  });

  it('sums multiple calls', () => {
    const mk = (text: string): FakeLLMCall => ({
      systemPrompt: text,
      messages: [{ role: 'user', content: text }],
      matchedIndex: 0,
      matchedLabel: 'test',
    });
    const total = estimatePromptTokensFromCalls([mk('aaaa'), mk('bbbb')]);
    expect(total).toBeGreaterThan(0);
  });
});
