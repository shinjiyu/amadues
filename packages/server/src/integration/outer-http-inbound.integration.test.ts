/**
 * F 装配：dispatchOuterHttpInbound → OuterBrain.handleInbound（无 LLM → 降级回复）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createOuterBrainFixture, type OuterBrainFixture } from '../testing/outer-brain-fixture.js';
import { createNoopEngine } from '../testing/agent-stack-fixture.js';
import { dispatchOuterHttpInbound } from '../outer/outer-http-inbound.js';

const LLM_ENV_KEYS = [
  'ZHIPU_API_KEY',
  'KIMI_API_KEY',
  'LOCALMODULE_API_KEY',
  'UTLRA_INNER_LLM_PROVIDER',
] as const;

describe('integration: outer http inbound assembly', () => {
  let fx: OuterBrainFixture;
  const envSnapshot: Partial<Record<(typeof LLM_ENV_KEYS)[number], string>> = {};

  beforeEach(() => {
    for (const k of LLM_ENV_KEYS) {
      if (process.env[k] !== undefined) envSnapshot[k] = process.env[k];
      delete process.env[k];
    }
    process.env['UTLRA_OUTER_JITTER_MIN_MS'] = '0';
    process.env['UTLRA_OUTER_JITTER_MAX_MS'] = '0';
    process.env['UTLRA_AGENT_IM_SID'] = 'agent:assembly-http';
    fx = createOuterBrainFixture('agent:assembly-http');
  });

  afterEach(() => {
    fx?.cleanup();
    for (const k of LLM_ENV_KEYS) {
      const v = envSnapshot[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env['UTLRA_OUTER_JITTER_MIN_MS'];
    delete process.env['UTLRA_OUTER_JITTER_MAX_MS'];
    delete process.env['UTLRA_AGENT_IM_SID'];
  });

  it('HTTP 入站、无 LLM key → 捕获降级提示 + threads 落库', async () => {
    const threadId = `thread:dm:http-${Date.now()}`;
    const result = await dispatchOuterHttpInbound(
      {
        imClient: fx.im,
        seenTracker: fx.seenTracker,
        assetStore: fx.assetStore,
        registry: fx.registry,
        getEngine: () => createNoopEngine(),
        workspaceStore: fx.workspaceStore,
        repoStore: fx.repoStore,
        loadThreads: fx.loadThreads,
        dataRoot: fx.dataRoot,
        innerBrainRegistry: fx.innerBrainRegistry,
        kpiRegistry: fx.kpiRegistry,
      },
      { loadThreads: fx.loadThreads, saveThreads: fx.saveThreads },
      {
        threadId,
        senderSid: 'human:alice',
        text: '你好，HTTP 装配烟雾',
      },
    );

    expect(result.replies.length).toBeGreaterThan(0);
    expect(result.replies[0]!.text).toMatch(/外脑未配置 LLM/);
    const msgs = fx.loadThreads().messages[threadId];
    expect(msgs?.length).toBeGreaterThan(0);
  });
});
