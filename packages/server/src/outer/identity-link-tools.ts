/**
 * ADL: identityLinkService · 外脑工具（P1）
 * path: packages/server/src/outer/identity-link-tools.ts
 * horizon.in:  LLM tool calls（identity_link_request / identity_link_status）
 * horizon.out: pending 创建（经 IdentityLinkService）+ 给用户的确认指引文案
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §3 §4.2
 */
import { serializeChannelKey, type ChannelKey } from '@utlra/chat-ir';
import type { OuterToolContext, ToolCallResult, ToolDef } from './outer-tools.js';

export const IDENTITY_LINK_TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'identity_link_request',
      description:
        '发起跨渠道同人绑定：当前对话的人类声称在另一渠道（webchat/discord/feishu…）也有账号时调用。' +
        '会创建 pending 请求并返回确认口令；**必须**由对端账号在对端渠道发送「确认绑定 <pending_id>」才生效，' +
        '你自己**不能**替用户确认，也不能因用户单方声称就视为同人。',
      parameters: {
        type: 'object',
        properties: {
          counterpart_channel: {
            type: 'string',
            description: '对端渠道名，如 webchat / discord / feishu',
          },
          counterpart_native_id: {
            type: 'string',
            description: '对端渠道内的原生用户 ID（如 discord 用户雪花 ID、飞书 union_id）',
          },
          scope: {
            type: 'string',
            description: '可选；渠道内作用域（如飞书 app_id），同渠道多连接时区分用',
          },
        },
        required: ['counterpart_channel', 'counterpart_native_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'identity_link_status',
      description:
        '查询跨渠道绑定请求状态。传 pending_id 查单条；不传则列出与当前用户相关的全部请求。',
      parameters: {
        type: 'object',
        properties: {
          pending_id: { type: 'string', description: '可选；绑定请求 ID' },
        },
        required: [],
      },
    },
  },
];

function fmtKey(k: ChannelKey): string {
  return serializeChannelKey(k);
}

export async function execIdentityLinkRequest(
  args: { counterpart_channel?: string; counterpart_native_id?: string; scope?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const service = ctx.identityLinkService;
  const index = ctx.bindingIndex;
  if (!service || !index) {
    return { replied: false, output: '（身份绑定服务未启用）' };
  }
  const initiatorSid = ctx.inboundHumanSid;
  if (!initiatorSid) {
    return { replied: false, output: '（仅人类 IM 入站对话可发起绑定；当前无 inbound human）' };
  }
  const channel = args.counterpart_channel?.trim().toLowerCase() ?? '';
  const nativeId = args.counterpart_native_id?.trim() ?? '';
  if (!channel || !nativeId) {
    return { replied: false, output: '（counterpart_channel / counterpart_native_id 为空）' };
  }

  const initiatorKeys = index.listKeys(initiatorSid);
  if (initiatorKeys.length === 0) {
    return {
      replied: false,
      output: `（发起人 ${initiatorSid} 在映射索引里没有任何渠道绑定，无法发起）`,
    };
  }
  const initiatorKey = initiatorKeys[0];
  const counterpartKey: ChannelKey = {
    channel,
    native_user_id: nativeId,
    ...(args.scope?.trim() ? { scope: args.scope.trim() } : {}),
  };

  const res = await service.requestLink({ initiatorSid, initiatorKey, counterpartKey });
  if (!res.ok) {
    const hints: Record<string, string> = {
      already_linked: '这个对端账号已经绑定到当前用户，无需重复绑定。',
      counterpart_key_already_bound: '对端账号已绑定到其他人，出于安全不能覆盖；如确属本人请联系管理员。',
      counterpart_same_as_initiator: '对端和发起方是同一个渠道账号。',
    };
    return {
      replied: false,
      output: `绑定请求失败：${res.reason}${hints[res.reason] ? `\n${hints[res.reason]}` : ''}`,
    };
  }

  const p = res.pending;
  return {
    replied: false,
    output:
      `已创建绑定请求 pending_id=${p.pending_id}（${res.delivered ? '已' : '未'}向对端投递）。\n` +
      `发起方：${fmtKey(p.initiator_key)} → 对端：${fmtKey(p.counterpart_key)}，` +
      `有效期至 ${p.expires_at}。\n` +
      `请告诉用户：用对端渠道（${channel}）的那个账号给我发送——\n` +
      `确认绑定 ${p.pending_id}\n` +
      `（拒绝则发送「拒绝绑定 ${p.pending_id}」。确认必须来自对端账号本人，别人代发无效。）`,
  };
}

export async function execIdentityLinkStatus(
  args: { pending_id?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const service = ctx.identityLinkService;
  if (!service) return { replied: false, output: '（身份绑定服务未启用）' };

  const fmt = (p: {
    pending_id: string;
    status: string;
    initiator_key: ChannelKey;
    counterpart_key: ChannelKey;
    target_sid: string;
    expires_at: string;
  }) =>
    `- ${p.pending_id} [${p.status}] ${fmtKey(p.initiator_key)} ↔ ${fmtKey(p.counterpart_key)} ` +
    `→ ${p.target_sid}（expires ${p.expires_at}）`;

  const id = args.pending_id?.trim();
  if (id) {
    const p = service.getPending(id);
    if (!p) return { replied: false, output: `（绑定请求 ${id} 不存在）` };
    return { replied: false, output: fmt(p) };
  }

  const mine = ctx.inboundHumanSid;
  const all = service
    .list()
    .filter((p) => !mine || p.initiator_sid === mine || p.target_sid === mine);
  if (all.length === 0) return { replied: false, output: '（无绑定请求记录）' };
  return { replied: false, output: `绑定请求（${all.length}）：\n${all.map(fmt).join('\n')}` };
}

export async function dispatchIdentityLinkTool(
  name: string,
  args: Record<string, unknown>,
  ctx: OuterToolContext,
): Promise<ToolCallResult | null> {
  switch (name) {
    case 'identity_link_request':
      return execIdentityLinkRequest(
        args as { counterpart_channel?: string; counterpart_native_id?: string; scope?: string },
        ctx,
      );
    case 'identity_link_status':
      return execIdentityLinkStatus(args as { pending_id?: string }, ctx);
    default:
      return null;
  }
}
