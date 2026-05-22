import { afterEach, describe, expect, it, vi } from 'vitest';
import { kimiProviderChatCompletion } from './kimi.js';

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe('kimiProviderChatCompletion', () => {
  it('forces temperature=0.6 for kimi-k2.6', async () => {
    let capturedBody = '';
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedBody = String(init?.body ?? '');
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
        }),
      } as Response;
    }) as typeof fetch;

    const r = await kimiProviderChatCompletion({
      apiKey: 'k',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'kimi-k2.6',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 32,
      temperature: 0.1,
      thinking: 'disabled',
    });

    expect(r.content).toBe('ok');
    const body = JSON.parse(capturedBody) as { temperature?: number };
    expect(body.temperature).toBe(0.6);
  });

  it('preserves requested temperature for non-k2.6 models', async () => {
    let capturedBody = '';
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedBody = String(init?.body ?? '');
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'ok' } }],
        }),
      } as Response;
    }) as typeof fetch;

    await kimiProviderChatCompletion({
      apiKey: 'k',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'moonshot-v1-128k',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 32,
      temperature: 0.2,
      thinking: 'disabled',
    });

    const body = JSON.parse(capturedBody) as { temperature?: number };
    expect(body.temperature).toBe(0.2);
  });
});
