/**
 * ADL: channelConnectionRegistry · 扫码接入工具（P4a 飞书 / P4b 微信）
 * path: packages/server/src/outer/channel-scan-tools.ts
 * horizon.in:  LLM tool calls（feishu_channel_scan_add / wechat_channel_add）
 * horizon.out: 异步扫码流（URL 发 thread → keychain.put → registry.add → 通知）
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §6.6
 *
 * 两个工具都是**异步流**：立即返回「已启动」，验证 URL/二维码经 imClient 发到
 * 当前 thread；用户扫码确认后后台自动完成 keychain + registry.add 并通知成败。
 * 既有手填流程（feishu_channel_add）不受影响。
 */
import type { OuterToolContext, ToolCallResult, ToolDef } from './outer-tools.js';
import { requireChannelAdmin } from './channel-connection-tools.js';

export const CHANNEL_SCAN_TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'feishu_channel_scan_add',
      description:
        '飞书扫码一键建应用并接入（OAuth Device Flow）：无需用户手动进开发者后台。' +
        '调用后我会把验证链接发到当前对话，用户在飞书中打开/扫码并确认；完成后自动' +
        '存凭证（keychain）并热插连接。仅管理员白名单 SID 可调用。与 feishu_channel_add' +
        '（手填 app_id/secret）并存。',
      parameters: {
        type: 'object',
        properties: {
          app_id: {
            type: 'string',
            description: '（可选）已有应用 App ID（cli_ 开头）：改为更新该应用配置而非新建',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wechat_channel_add',
      description:
        '微信 iLink ClawBot 扫码接入：调用后我会把登录二维码链接发到当前对话，' +
        '用户用**手机微信**扫码确认（该微信号即成为 bot 身份，一号一连接、基本仅私聊）。' +
        '完成后自动存凭证（keychain）并热插连接。仅管理员白名单 SID 可调用。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

/** 可注入实现（生产 = 桥包动态 import；单测注入 fake） */
export interface ChannelScanDeps {
  scanRegisterFeishu?: (opts: {
    onUrlReady: (info: { url: string; expireIn: number }) => void;
    appId?: string;
  }) => Promise<{ appId: string; appSecret: string }>;
  wechatLogin?: {
    fetchQrcode(): Promise<{ qrcode: string; qrcodeUrl: string }>;
    pollStatus(qrcode: string): Promise<
      | { status: 'wait' | 'scaned' | 'expired' }
      | { status: 'confirmed'; botToken: string; botId: string; userId: string; baseUrl: string }
    >;
  };
  /** 微信扫码状态轮询间隔（测试注入 0） */
  wechatPollIntervalMs?: number;
  /** 微信扫码整体超时 */
  wechatTimeoutMs?: number;
}

async function defaultScanRegisterFeishu(opts: {
  onUrlReady: (info: { url: string; expireIn: number }) => void;
  appId?: string;
}): Promise<{ appId: string; appSecret: string }> {
  const mod = await import('@utlra/feishu-bridge');
  return mod.scanRegisterFeishuApp({
    onUrlReady: opts.onUrlReady,
    ...(opts.appId ? { appId: opts.appId } : {}),
  });
}

async function defaultWechatLogin(): Promise<NonNullable<ChannelScanDeps['wechatLogin']>> {
  const mod = await import('@utlra/wechat-bridge');
  return {
    fetchQrcode: () => mod.fetchLoginQrcode(),
    pollStatus: (qrcode: string) => mod.pollQrcodeStatus(qrcode),
  };
}

/** thread 级并发闸：同一对话同时只允许一个进行中的扫码流 */
const inflightScans = new Set<string>();

function keychainSafeRef(prefix: string, id: string): string {
  return `${prefix}${id.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

function postToThread(ctx: OuterToolContext, text: string): void {
  void ctx.imClient
    .postMessage(ctx.threadId, { sender_sid: ctx.agentSid, text })
    .catch((e) => console.error('[channel-scan] notify failed', e));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function execFeishuChannelScanAdd(
  args: { app_id?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const registry = ctx.channelConnectionRegistry;
  if (!registry) return { replied: false, output: '（通道连接注册表未启用）' };
  if (!ctx.memoryBlockStore) return { replied: false, output: '（keychain 未启用）' };
  const denied = requireChannelAdmin(ctx);
  if (denied) return { replied: false, output: denied };

  const flowKey = `${ctx.threadId}:feishu-scan`;
  if (inflightScans.has(flowKey)) {
    return { replied: false, output: '（本对话已有进行中的飞书扫码流程，请先完成或等它过期）' };
  }
  inflightScans.add(flowKey);

  const impl = ctx.channelScan?.scanRegisterFeishu ?? defaultScanRegisterFeishu;
  const actorSid = ctx.inboundHumanSid!;
  const existingAppId = args.app_id?.trim();
  const memoryBlockStore = ctx.memoryBlockStore;

  void (async () => {
    try {
      const { appId, appSecret } = await impl({
        onUrlReady: (info) =>
          postToThread(
            ctx,
            `请在飞书中打开以下链接（或转成二维码扫码）授权${existingAppId ? '更新应用配置' : '创建应用'}，` +
              `${info.expireIn} 秒内有效：\n${info.url}`,
          ),
        ...(existingAppId ? { appId: existingAppId } : {}),
      });
      const secretRef = keychainSafeRef('feishu_app_secret_', appId);
      await memoryBlockStore.put(
        'keychain',
        secretRef,
        { kind: 'feishu_app_secret', value: appSecret },
        actorSid,
      );
      const res = await registry.add({ kind: 'feishu', appId, secretRef, addedBySid: actorSid });
      postToThread(
        ctx,
        res.ok
          ? `飞书应用 ${appId} 已创建并接入 ✅（connection: ${res.record.connection_id}）`
          : `飞书应用 ${appId} 已创建、凭证已入 keychain（${secretRef}），但接入失败：${res.reason}。` +
              `可稍后用 feishu_channel_add 重试。`,
      );
    } catch (e) {
      postToThread(ctx, `飞书扫码建应用未完成：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      inflightScans.delete(flowKey);
    }
  })();

  return {
    replied: false,
    output:
      '飞书扫码流程已启动：验证链接稍后会发到本对话（默认 600 秒有效）。' +
      '用户确认后我会自动完成接入并在这里通知结果。',
  };
}

export async function execWechatChannelAdd(ctx: OuterToolContext): Promise<ToolCallResult> {
  const registry = ctx.channelConnectionRegistry;
  if (!registry) return { replied: false, output: '（通道连接注册表未启用）' };
  if (!ctx.memoryBlockStore) return { replied: false, output: '（keychain 未启用）' };
  const denied = requireChannelAdmin(ctx);
  if (denied) return { replied: false, output: denied };

  const flowKey = `${ctx.threadId}:wechat-scan`;
  if (inflightScans.has(flowKey)) {
    return { replied: false, output: '（本对话已有进行中的微信扫码流程，请先完成或等它过期）' };
  }
  inflightScans.add(flowKey);

  const actorSid = ctx.inboundHumanSid!;
  const pollInterval = ctx.channelScan?.wechatPollIntervalMs ?? 2000;
  const timeoutMs = ctx.channelScan?.wechatTimeoutMs ?? 5 * 60_000;
  const memoryBlockStore = ctx.memoryBlockStore;

  void (async () => {
    try {
      const login = ctx.channelScan?.wechatLogin ?? (await defaultWechatLogin());
      const qr = await login.fetchQrcode();
      postToThread(
        ctx,
        `请用**手机微信**扫码登录 Bot（打开链接后展示二维码）：\n${qr.qrcodeUrl}\n` +
          `注意：扫码的微信号将成为 bot 身份（一号一连接，基本仅私聊）。`,
      );
      const deadline = Date.now() + timeoutMs;
      let notifiedScaned = false;
      for (;;) {
        if (Date.now() > deadline) {
          postToThread(ctx, '微信扫码登录超时，已取消。可重新调用 wechat_channel_add。');
          return;
        }
        const st = await login.pollStatus(qr.qrcode);
        if (st.status === 'confirmed') {
          const creds = {
            token: st.botToken,
            baseUrl: st.baseUrl,
            accountId: st.botId,
            userId: st.userId,
            savedAt: new Date().toISOString(),
          };
          const secretRef = keychainSafeRef('wechat_bot_token_', st.botId);
          await memoryBlockStore.put(
            'keychain',
            secretRef,
            { kind: 'wechat_bot_token', value: JSON.stringify(creds) },
            actorSid,
          );
          const res = await registry.add({
            kind: 'wechat',
            appId: st.botId,
            secretRef,
            addedBySid: actorSid,
          });
          postToThread(
            ctx,
            res.ok
              ? `微信 Bot ${st.botId} 已接入 ✅（connection: ${res.record.connection_id}）。私聊该微信号即可对话。`
              : `微信登录成功、凭证已入 keychain（${secretRef}），但接入失败：${res.reason}`,
          );
          return;
        }
        if (st.status === 'expired') {
          postToThread(ctx, '微信登录二维码已过期，请重新调用 wechat_channel_add。');
          return;
        }
        if (st.status === 'scaned' && !notifiedScaned) {
          notifiedScaned = true;
          postToThread(ctx, '已扫码，请在手机上确认登录…');
        }
        await sleep(pollInterval);
      }
    } catch (e) {
      postToThread(ctx, `微信扫码接入未完成：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      inflightScans.delete(flowKey);
    }
  })();

  return {
    replied: false,
    output: '微信扫码流程已启动：登录二维码链接稍后会发到本对话（5 分钟内有效）。扫码确认后我会自动完成接入并通知结果。',
  };
}

export async function dispatchChannelScanTool(
  name: string,
  args: Record<string, unknown>,
  ctx: OuterToolContext,
): Promise<ToolCallResult | null> {
  switch (name) {
    case 'feishu_channel_scan_add':
      return execFeishuChannelScanAdd(args as { app_id?: string }, ctx);
    case 'wechat_channel_add':
      return execWechatChannelAdd(ctx);
    default:
      return null;
  }
}
