import { describe, expect, it } from 'vitest';
import {
  ChatIRSeenTracker,
  IdentityBindingIndex,
  IdentityRegistry,
  type ChatIRInboundEvent,
  type LooseThreadStore,
} from '@utlra/chat-ir';
import { createFeishuConnector } from './connector.js';
import type { FeishuEventSource } from './feishu-channel.js';

const AGENT_SID = 'idp:agent:kuro';

function okFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) throw new Error(`no route ${url}`);
    return { json: async () => hit[1] } as Response;
  }) as typeof fetch;
}

function makeDeps(fetchImpl: typeof fetch) {
  const store: LooseThreadStore = { threads: [], messages: {} };
  const inboundByConn: Record<string, ChatIRInboundEvent[]> = {};
  const fakeSource: FeishuEventSource = { start() {}, stop() {} };
  return {
    deps: {
      agentSid: AGENT_SID,
      registry: new IdentityRegistry(null),
      bindingIndex: new IdentityBindingIndex(),
      seenTracker: new ChatIRSeenTracker({ selfAgentSid: AGENT_SID }),
      loadThreads: () => store,
      saveThreads: () => {},
      makeInboundHandler: (connectionId: string) => async (ev: ChatIRInboundEvent) => {
        (inboundByConn[connectionId] ??= []).push(ev);
      },
      eventSourceFactory: async () => fakeSource,
      fetchImpl,
    },
    inboundByConn,
  };
}

describe('createFeishuConnector', () => {
  it('connect：探测 token + bot info，返回 channel 和 botNativeId', async () => {
    const { deps } = makeDeps(
      okFetch({
        tenant_access_token: { code: 0, msg: 'ok', tenant_access_token: 't', expire: 7200 },
        '/bot/v3/info': { code: 0, msg: 'ok', data: { bot: { open_id: 'ou_bot9' } } },
      }),
    );
    const connector = createFeishuConnector(deps);
    const res = await connector.connect({ connection_id: 'conn-1', app_id: 'cli_a' }, 's3cret');
    expect(res.botNativeId).toBe('ou_bot9');
    expect(typeof res.channel.start).toBe('function');
    expect(typeof res.channel.postMessage).toBe('function');
  });

  it('凭证错误 → connect 抛异常（registry add 据此回滚）', async () => {
    const { deps } = makeDeps(
      okFetch({
        tenant_access_token: { code: 10003, msg: 'invalid app_secret' },
      }),
    );
    const connector = createFeishuConnector(deps);
    await expect(
      connector.connect({ connection_id: 'conn-1', app_id: 'cli_a' }, 'wrong'),
    ).rejects.toThrow(/invalid app_secret/);
  });

  it('入站回调走 makeInboundHandler(connection_id)（fan-in 路由约定）', async () => {
    const { deps } = makeDeps(
      okFetch({
        tenant_access_token: { code: 0, msg: 'ok', tenant_access_token: 't', expire: 7200 },
        '/bot/v3/info': { code: 0, msg: 'ok', data: { bot: { open_id: 'ou_bot' } } },
      }),
    );
    let captured: ((ev: never) => Promise<void>) | null = null;
    deps.eventSourceFactory = async () =>
      ({
        start(onEvent: (ev: never) => Promise<void>) {
          captured = onEvent;
        },
        stop() {},
      }) as FeishuEventSource;

    const connector = createFeishuConnector(deps);
    const { channel } = await connector.connect(
      { connection_id: 'conn-7', app_id: 'cli_a' },
      's',
    );
    channel.start();
    expect(captured).not.toBeNull();
  });
});
