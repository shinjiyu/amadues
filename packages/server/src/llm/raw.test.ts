import { afterEach, describe, expect, it, vi } from 'vitest';
import { llmRawChatCompletion } from './raw.js';

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe('llmRawChatCompletion', () => {
  it('forces temperature=0.6 for kimi-k2.6 raw calls', async () => {
    let capturedBody = '';
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedBody = String(init?.body ?? '');
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      } as Response;
    }) as typeof fetch;

    const result = await llmRawChatCompletion({
      provider: 'kimi',
      apiKey: 'k',
      baseUrl: 'https://api.moonshot.cn/v1',
      body: {
        model: 'kimi-k2.6',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.1,
      },
    });

    expect(result.status).toBe(200);
    const body = JSON.parse(capturedBody) as { temperature?: number };
    expect(body.temperature).toBe(0.6);
  });

  it('keeps non-kimi requests unchanged', async () => {
    let capturedBody = '';
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedBody = String(init?.body ?? '');
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      } as Response;
    }) as typeof fetch;

    await llmRawChatCompletion({
      provider: 'zhipu',
      apiKey: 'z',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      body: {
        model: 'glm-5.1',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.2,
      },
    });

    const body = JSON.parse(capturedBody) as { temperature?: number };
    expect(body.temperature).toBe(0.2);
  });

  it('localmodule: 将字符串 thinking 规整为 { type } 透传给 GLM 网关', async () => {
    let capturedBody = '';
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedBody = String(init?.body ?? '');
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      } as Response;
    }) as typeof fetch;

    await llmRawChatCompletion({
      provider: 'localmodule',
      apiKey: 'lm',
      baseUrl: 'https://ai.pocketcity.com/v1',
      body: {
        model: 'GLM-5.1-FP8',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 32,
        thinking: 'disabled',
      },
    });

    const body = JSON.parse(capturedBody) as { thinking?: unknown; max_tokens?: number };
    expect(body.thinking).toEqual({ type: 'disabled' });
    expect(body.max_tokens).toBe(32);
  });

  it('localmodule: 已是对象形态的 thinking 保持原样不被覆写', async () => {
    let capturedBody = '';
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedBody = String(init?.body ?? '');
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      } as Response;
    }) as typeof fetch;

    await llmRawChatCompletion({
      provider: 'localmodule',
      apiKey: 'lm',
      baseUrl: 'https://ai.pocketcity.com/v1',
      body: {
        model: 'GLM-5.1-FP8',
        messages: [{ role: 'user', content: 'hi' }],
        thinking: { type: 'enabled', budget: 4096 },
      },
    });

    const body = JSON.parse(capturedBody) as { thinking?: unknown };
    expect(body.thinking).toEqual({ type: 'enabled', budget: 4096 });
  });

  it('localmodule: 缺省 thinking 时不引入新字段（保持兼容）', async () => {
    let capturedBody = '';
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedBody = String(init?.body ?? '');
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      } as Response;
    }) as typeof fetch;

    await llmRawChatCompletion({
      provider: 'localmodule',
      apiKey: 'lm',
      baseUrl: 'https://ai.pocketcity.com/v1',
      body: {
        model: 'GLM-5.1-FP8',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    const body = JSON.parse(capturedBody) as Record<string, unknown>;
    expect('thinking' in body).toBe(false);
  });
});
