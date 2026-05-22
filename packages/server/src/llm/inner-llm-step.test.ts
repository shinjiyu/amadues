import { afterEach, describe, expect, it } from 'vitest';
import { loadInnerLlmEnvFromProcess } from './inner-llm-step.js';

const ENV_KEYS = [
  'ZHIPU_API_KEY',
  'ZHIPU_BASE_URL',
  'ZHIPU_MODEL',
  'ZHIPU_VISION_MODEL',
  'ZHIPU_THINKING',
  'KIMI_API_KEY',
  'KIMI_BASE_URL',
  'KIMI_MODEL',
  'KIMI_VISION_MODEL',
  'KIMI_THINKING',
] as const;

const prevEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    const prev = prevEnv[k];
    if (prev === undefined) delete process.env[k];
    else process.env[k] = prev;
  }
});

describe('loadInnerLlmEnvFromProcess', () => {
  it('returns null when no provider key configured', () => {
    delete process.env.ZHIPU_API_KEY;
    delete process.env.KIMI_API_KEY;
    expect(loadInnerLlmEnvFromProcess()).toBeNull();
  });

  it('prefers zhipu when both zhipu and kimi keys exist', () => {
    process.env.ZHIPU_API_KEY = 'zk';
    process.env.ZHIPU_MODEL = 'glm-5.1';
    process.env.KIMI_API_KEY = 'kk';
    process.env.KIMI_MODEL = 'kimi-k2.6';

    const env = loadInnerLlmEnvFromProcess();
    expect(env?.provider).toBe('zhipu');
    expect(env?.apiKey).toBe('zk');
    expect(env?.textModel).toBe('glm-5.1');
  });

  it('loads kimi when zhipu is absent', () => {
    delete process.env.ZHIPU_API_KEY;
    process.env.KIMI_API_KEY = 'kk';
    process.env.KIMI_BASE_URL = 'https://api.moonshot.cn/v1';
    process.env.KIMI_MODEL = 'kimi-k2.6';
    process.env.KIMI_VISION_MODEL = 'kimi-k2.6-vision';
    process.env.KIMI_THINKING = 'enabled';

    const env = loadInnerLlmEnvFromProcess();
    expect(env).toMatchObject({
      provider: 'kimi',
      apiKey: 'kk',
      baseUrl: 'https://api.moonshot.cn/v1',
      textModel: 'kimi-k2.6',
      visionModel: 'kimi-k2.6-vision',
      thinking: 'enabled',
    });
  });

  it('falls back to default kimi model when KIMI_MODEL is blank', () => {
    delete process.env.ZHIPU_API_KEY;
    process.env.KIMI_API_KEY = 'kk';
    process.env.KIMI_MODEL = '   ';

    const env = loadInnerLlmEnvFromProcess();
    expect(env?.provider).toBe('kimi');
    expect(env?.textModel).toBe('kimi-k2.6');
    expect(env?.visionModel).toBe('kimi-k2.6');
  });
});
