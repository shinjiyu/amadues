/**
 * ADL component: llmGateway — raw 网关请求形态（temperature 等）
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { llmRawChatCompletion } from './raw.js';

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe('component: llmGateway', () => {
  it('kimi-k2.6 强制 temperature=0.6（主路径）', async () => {
    let body = '';
    globalThis.fetch = vi.fn(async (_url, init) => {
      body = String(init?.body ?? '');
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      } as Response;
    }) as typeof fetch;

    await llmRawChatCompletion({
      provider: 'kimi',
      apiKey: 'k',
      baseUrl: 'https://api.example/v1',
      body: {
        model: 'kimi-k2.6',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.1,
      },
    });

    expect(JSON.parse(body).temperature).toBe(0.6);
  });
});
