/**
 * ADL: identityLinkService · 入站确认/拒绝解析（P1）
 * path: packages/server/src/outer/identity-link-inbound.ts
 * horizon.in:  human IM text（确认绑定/拒绝绑定 + pending_id）+ senderSid
 * horizon.out: handled + 回复文案；commit 仍全部走 IdentityLinkService
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §3.2 投递/确认
 *
 * 确定性解析，不走 LLM；对端身份校验 = 「pending.counterpart_key ∈ 发送者已绑定 keys」。
 */
import {
  serializeChannelKey,
  type IdentityBindingIndex,
} from '@utlra/chat-ir';
import type { IdentityLinkService } from './identity-link-service.js';

export interface IdentityLinkInboundDeps {
  service: IdentityLinkService;
  index: IdentityBindingIndex;
}

export type IdentityLinkInboundResult =
  | { handled: false }
  | { handled: true; reply: string; committed: boolean };

const CONFIRM_RE = /(?:确认绑定|confirm\s+link)\s+([A-Za-z0-9-]{6,})/i;
const REJECT_RE = /(?:拒绝绑定|reject\s+link)\s+([A-Za-z0-9-]{6,})/i;

/**
 * 尝试把入站人类消息解析为 identity link 确认/拒绝。
 * 未命中口令 → { handled: false }，主流程继续。
 */
export async function tryHandleIdentityLinkInbound(
  deps: IdentityLinkInboundDeps,
  senderSid: string,
  content: string,
): Promise<IdentityLinkInboundResult> {
  const text = content.trim();
  if (!text) return { handled: false };

  const confirm = CONFIRM_RE.exec(text);
  const reject = confirm ? null : REJECT_RE.exec(text);
  const pendingId = (confirm ?? reject)?.[1];
  if (!pendingId) return { handled: false };

  const pending = deps.service.getPending(pendingId);
  if (!pending) {
    return { handled: true, committed: false, reply: `绑定请求 ${pendingId} 不存在或已失效。` };
  }

  if (reject) {
    const r = deps.service.rejectPending(pendingId, `rejected_by:${senderSid}`);
    return {
      handled: true,
      committed: false,
      reply: r.ok ? `已拒绝绑定请求 ${pendingId}，身份映射保持不变。` : `无法拒绝：${r.reason}`,
    };
  }

  // 对端校验：发送者当前绑定的 channel_key 里必须有 counterpart_key
  const counterSer = serializeChannelKey(pending.counterpart_key);
  const senderKeys = deps.index.listKeys(senderSid);
  const matched = senderKeys.find((k) => serializeChannelKey(k) === counterSer);
  if (!matched) {
    return {
      handled: true,
      committed: false,
      reply:
        `你不是绑定请求 ${pendingId} 的确认方。` +
        `请在 ${pending.counterpart_key.channel} 渠道以被绑定的账号发送：确认绑定 ${pendingId}`,
    };
  }

  const res = await deps.service.confirm(pendingId, matched);
  if (!res.ok) {
    return { handled: true, committed: false, reply: `绑定确认失败：${res.reason}` };
  }
  return {
    handled: true,
    committed: true,
    reply: `绑定完成：两个渠道的身份已合并（sid=${res.targetSid}）。之后我在任一渠道都会认出你。`,
  };
}
