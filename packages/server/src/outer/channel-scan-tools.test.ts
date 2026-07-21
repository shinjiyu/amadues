/**
 * ADL: channelConnectionRegistry · 扫码接入工具（P4a/P4b）
 * path: packages/server/src/outer/channel-scan-tools.ts
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §6.6
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  ChatAssetStore,
  FanInChatIRChannel,
  type ChatIRChannel,
  type ChatIROutboundBody,
} from '@utlra/chat-ir';
import { ChannelConnectionRegistry } from './channel-connection-registry.js';
import { CHANNEL_SCAN_TOOL_DEFS, dispatchChannelScanTool } from './channel-scan-tools.js';
import { OUTER_TOOL_DEFS, type OuterToolContext } from './outer-tools.js';

class FakeChannel implements ChatIRChannel {
  start(): void {}
  destroy(): void {}
  async postMessage(_t: string, _b: ChatIROutboundBody): Promise<void> {}
}

function flush(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const qrTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-tools-qr-'));
afterAll(() => fs.rmSync(qrTmpDir, { recursive: true, force: true }));

function harness(opts?: {
  actor?: string;
  admins?: string[];
  scan?: OuterToolContext['channelScan'];
  threadId?: string;
}) {
  const fanIn = new FanInChatIRChannel({ onAgentMessage: async () => {} });
  fanIn.start();
  const secrets = new Map<string, string>();
  const registry = new ChannelConnectionRegistry({
    persistPath: null,
    fanIn,
    connectors: {
      feishu: {
        async connect(record) {
          return { channel: new FakeChannel(), botNativeId: `bot_${record.app_id}` };
        },
      },
      wechat: {
        async connect(record) {
          return { channel: new FakeChannel(), botNativeId: record.app_id };
        },
      },
    },
    getSecret: async (ref) => secrets.get(ref) ?? null,
    agentSid: 'idp:agent:assistant',
  });
  const posted: string[] = [];
  const postedBodies: ChatIROutboundBody[] = [];
  const ctx = {
    threadId: opts?.threadId ?? `t:scan-${Math.random().toString(36).slice(2)}`,
    agentSid: 'idp:agent:assistant',
    assetStore: new ChatAssetStore(qrTmpDir),
    imClient: {
      start() {},
      destroy() {},
      async postMessage(_tid: string, body: ChatIROutboundBody) {
        posted.push(body.text ?? '');
        postedBodies.push(body);
      },
    },
    memoryBlockStore: {
      async put(_block: string, key: string, payload: Record<string, unknown>) {
        secrets.set(key, String(payload['value']));
        return payload;
      },
    },
    channelConnectionRegistry: registry,
    channelAdminSids: new Set(opts?.admins ?? ['idp:user:root']),
    inboundHumanSid: opts?.actor ?? 'idp:user:root',
    bindingIndex: null,
    channelScan: opts?.scan,
  } as unknown as OuterToolContext;
  return { ctx, registry, posted, postedBodies, secrets };
}

function hasQrAttachment(bodies: ChatIROutboundBody[], urlFragment: string): boolean {
  return bodies.some((b) => {
    if (!(b.text ?? '').includes(urlFragment)) return false;
    const parts = (b.parts ?? []) as Array<{ type: string; asset_ref?: { mime?: string } }>;
    return parts.some((p) => p.type === 'attachment' && p.asset_ref?.mime === 'image/png');
  });
}

describe('channel-scan-tools', () => {
  it('tool defs are registered in OUTER_TOOL_DEFS', () => {
    const names = OUTER_TOOL_DEFS.map((d) => d.function.name);
    for (const def of CHANNEL_SCAN_TOOL_DEFS) {
      expect(names).toContain(def.function.name);
    }
  });

  it('feishu_channel_scan_add：URL 发 thread → 完成后自动 keychain+add+通知', async () => {
    const h = harness({
      scan: {
        scanRegisterFeishu: async ({ onUrlReady }) => {
          onUrlReady({ url: 'https://open.feishu.cn/launcher?user_code=X', expireIn: 600 });
          return { appId: 'cli_scan1', appSecret: 'sec1' };
        },
      },
    });
    const res = await dispatchChannelScanTool('feishu_channel_scan_add', {}, h.ctx);
    expect(res!.output).toContain('已启动');
    // URL 消息经异步二维码生成后才发出，全量跑测时留足余量
    await flush(400);

    expect(h.posted.some((t) => t.includes('user_code=X'))).toBe(true);
    expect(hasQrAttachment(h.postedBodies, 'user_code=X')).toBe(true);
    expect(h.posted.some((t) => t.includes('已创建并接入'))).toBe(true);
    expect(h.secrets.get('feishu_app_secret_cli_scan1')).toBe('sec1');
    const rec = h.registry.list()[0]!;
    expect(rec.kind).toBe('feishu');
    expect(rec.app_id).toBe('cli_scan1');
    expect(rec.status).toBe('up');
  });

  it('feishu 扫码失败（拒绝/过期）→ thread 收到失败通知，不留记录', async () => {
    const h = harness({
      scan: {
        scanRegisterFeishu: async () => {
          throw new Error('expired_token');
        },
      },
    });
    await dispatchChannelScanTool('feishu_channel_scan_add', {}, h.ctx);
    await flush();
    expect(h.posted.some((t) => t.includes('未完成') && t.includes('expired_token'))).toBe(true);
    expect(h.registry.list()).toHaveLength(0);
  });

  it('wechat_channel_add：二维码 URL 发 thread → confirmed → 凭证 JSON 入 keychain → add', async () => {
    let polls = 0;
    const h = harness({
      scan: {
        wechatPollIntervalMs: 0,
        wechatLogin: {
          fetchQrcode: async () => ({ qrcode: 'qrc_1', qrcodeUrl: 'https://weixin.qq.com/x/abc' }),
          pollStatus: async () => {
            polls += 1;
            if (polls === 1) return { status: 'wait' };
            if (polls === 2) return { status: 'scaned' };
            return {
              status: 'confirmed',
              botToken: 'ilinkbot_tok',
              botId: 'e06@im.bot',
              userId: 'owner@im.wechat',
              baseUrl: 'https://ilinkai.weixin.qq.com',
            };
          },
        },
      },
    });
    const res = await dispatchChannelScanTool('wechat_channel_add', {}, h.ctx);
    expect(res!.output).toContain('已启动');
    await flush(50);

    expect(h.posted.some((t) => t.includes('weixin.qq.com/x/abc'))).toBe(true);
    expect(hasQrAttachment(h.postedBodies, 'weixin.qq.com/x/abc')).toBe(true);
    expect(h.posted.some((t) => t.includes('已扫码'))).toBe(true);
    expect(h.posted.some((t) => t.includes('已接入'))).toBe(true);

    const stored = h.secrets.get('wechat_bot_token_e06_im.bot');
    expect(stored).toBeTruthy();
    const creds = JSON.parse(stored!) as Record<string, unknown>;
    expect(creds['token']).toBe('ilinkbot_tok');
    expect(creds['accountId']).toBe('e06@im.bot');

    const rec = h.registry.list()[0]!;
    expect(rec.kind).toBe('wechat');
    expect(rec.app_id).toBe('e06@im.bot');
    expect(rec.status).toBe('up');
  });

  it('wechat 二维码过期 → 通知并结束', async () => {
    const h = harness({
      scan: {
        wechatPollIntervalMs: 0,
        wechatLogin: {
          fetchQrcode: async () => ({ qrcode: 'q', qrcodeUrl: 'u' }),
          pollStatus: async () => ({ status: 'expired' }),
        },
      },
    });
    await dispatchChannelScanTool('wechat_channel_add', {}, h.ctx);
    await flush();
    expect(h.posted.some((t) => t.includes('过期'))).toBe(true);
    expect(h.registry.list()).toHaveLength(0);
  });

  it('非管理员 → 拒绝', async () => {
    const h = harness({ actor: 'idp:user:stranger', admins: ['idp:user:root'] });
    const res = await dispatchChannelScanTool('feishu_channel_scan_add', {}, h.ctx);
    expect(res!.output).toContain('白名单');
    const res2 = await dispatchChannelScanTool('wechat_channel_add', {}, h.ctx);
    expect(res2!.output).toContain('白名单');
  });

  it('同 thread 并发闸：进行中时再次调用被拒', async () => {
    let release: (() => void) | null = null;
    const h = harness({
      threadId: 't:concurrent',
      scan: {
        scanRegisterFeishu: () =>
          new Promise((resolve) => {
            release = () => resolve({ appId: 'cli_c', appSecret: 's' });
          }),
      },
    });
    await dispatchChannelScanTool('feishu_channel_scan_add', {}, h.ctx);
    const second = await dispatchChannelScanTool('feishu_channel_scan_add', {}, h.ctx);
    expect(second!.output).toContain('进行中');
    release!();
    await flush();
  });

  it('unknown tool name returns null', async () => {
    const h = harness();
    expect(await dispatchChannelScanTool('reply_to_user', {}, h.ctx)).toBeNull();
  });
});
