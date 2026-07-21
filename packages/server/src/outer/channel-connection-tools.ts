/**
 * ADL: channelConnectionRegistry · 外脑工具（P2）
 * path: packages/server/src/outer/channel-connection-tools.ts
 * horizon.in:  LLM tool calls（feishu_channel_add / list / remove）
 * horizon.out: 连接热插（经 ChannelConnectionRegistry）；admin 闸
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §5.2 热插场景
 */
import { channelKeyFromProvisionalSid, type IdentityBindingIndex } from '@utlra/chat-ir';
import type { OuterToolContext, ToolCallResult, ToolDef } from './outer-tools.js';
import type { ChannelConnectionRecord } from './channel-connection-registry.js';

export const CHANNEL_CONNECTION_TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'feishu_channel_add',
      description:
        '运行时热插一条飞书机器人连接。前置：用户先把 app_secret 用 keychain_put 存好，' +
        '再用本工具传 app_id + secret_ref（keychain entry key）。仅管理员白名单 SID 可调用。' +
        '探测失败会整体回滚，不留半开连接。**绝不**在聊天里回显 secret 明文。',
      parameters: {
        type: 'object',
        properties: {
          app_id: { type: 'string', description: '飞书应用 app_id（cli_ 开头）' },
          secret_ref: {
            type: 'string',
            description: 'keychain entry key（app_secret 已由 keychain_put 存入）',
          },
        },
        required: ['app_id', 'secret_ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'feishu_channel_list',
      description: '列出全部 IM 通道连接（connection_id / kind / app_id / status）。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'feishu_channel_remove',
      description: '摘除一条 IM 通道连接（断开 client 并删除记录）。仅管理员白名单 SID 可调用。',
      parameters: {
        type: 'object',
        properties: {
          connection_id: { type: 'string', description: '连接 ID（feishu_channel_list 可查）' },
        },
        required: ['connection_id'],
      },
    },
  },
];

function fmtRecord(r: ChannelConnectionRecord): string {
  const bot = r.bot_native_id ? ` bot=${r.bot_native_id}` : '';
  const err = r.last_error ? ` last_error=${r.last_error}` : '';
  return `- ${r.connection_id} [${r.status}] ${r.kind}/${r.app_id}${bot}（by ${r.added_by_sid} @ ${r.added_at}）${err}`;
}

/**
 * 白名单条目 → canonical SID（**只读**，不写索引）：
 * 渠道形式（`webchat:user:x` / `feishu:user:y`）经 bindingIndex.resolve 折叠，
 * 已 canonical / 未绑定则原样。这样同一个人从任意已确认渠道入站都能匹配，
 * `.env` 只需写一次接入时的渠道 SID（跨渠道同人 = ADL IDENTITY-CROSS-CHANNEL §2）。
 */
function canonicalizeAdminEntry(
  index: IdentityBindingIndex | null | undefined,
  entry: string,
): string {
  if (!index) return entry;
  const key = channelKeyFromProvisionalSid(entry);
  if (!key) return entry;
  return index.resolve(key) ?? entry;
}

function requireAdmin(ctx: OuterToolContext): string | null {
  const actor = ctx.inboundHumanSid;
  if (!actor) return '（仅人类 IM 入站对话可管理通道连接）';
  const admins = ctx.channelAdminSids;
  if (admins?.has('*')) return null; // 显式放开（运营自担风险）
  for (const entry of admins ?? []) {
    if (entry === actor) return null;
    if (canonicalizeAdminEntry(ctx.bindingIndex, entry) === actor) return null;
  }
  return `（${actor} 不在通道管理白名单；需在 UTLRA_CHANNEL_ADMIN_SIDS 配置，'*' 为放开）`;
}

export async function execFeishuChannelAdd(
  args: { app_id?: string; secret_ref?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const registry = ctx.channelConnectionRegistry;
  if (!registry) return { replied: false, output: '（通道连接注册表未启用）' };
  const denied = requireAdmin(ctx);
  if (denied) return { replied: false, output: denied };

  const appId = args.app_id?.trim() ?? '';
  const secretRef = args.secret_ref?.trim() ?? '';
  if (!appId || !secretRef) {
    return { replied: false, output: '（app_id / secret_ref 为空）' };
  }

  const res = await registry.add({
    kind: 'feishu',
    appId,
    secretRef,
    addedBySid: ctx.inboundHumanSid!,
  });
  if (!res.ok) {
    return { replied: false, output: `飞书连接失败（已回滚）：${res.reason}` };
  }
  return {
    replied: false,
    output: `飞书连接已建立：\n${fmtRecord(res.record)}\n入站消息将扇入同一外脑。`,
  };
}

export async function execFeishuChannelList(ctx: OuterToolContext): Promise<ToolCallResult> {
  const registry = ctx.channelConnectionRegistry;
  if (!registry) return { replied: false, output: '（通道连接注册表未启用）' };
  const all = registry.list();
  if (all.length === 0) return { replied: false, output: '（无 IM 通道连接记录）' };
  return { replied: false, output: `IM 通道连接（${all.length}）：\n${all.map(fmtRecord).join('\n')}` };
}

export async function execFeishuChannelRemove(
  args: { connection_id?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const registry = ctx.channelConnectionRegistry;
  if (!registry) return { replied: false, output: '（通道连接注册表未启用）' };
  const denied = requireAdmin(ctx);
  if (denied) return { replied: false, output: denied };

  const id = args.connection_id?.trim() ?? '';
  if (!id) return { replied: false, output: '（connection_id 为空）' };
  const ok = await registry.remove(id);
  return {
    replied: false,
    output: ok ? `已摘除连接 ${id}（client 已断开）` : `（连接 ${id} 不存在）`,
  };
}

export async function dispatchChannelConnectionTool(
  name: string,
  args: Record<string, unknown>,
  ctx: OuterToolContext,
): Promise<ToolCallResult | null> {
  switch (name) {
    case 'feishu_channel_add':
      return execFeishuChannelAdd(args as { app_id?: string; secret_ref?: string }, ctx);
    case 'feishu_channel_list':
      return execFeishuChannelList(ctx);
    case 'feishu_channel_remove':
      return execFeishuChannelRemove(args as { connection_id?: string }, ctx);
    default:
      return null;
  }
}
