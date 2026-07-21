/**
 * ADL: identityBindingIndex · 入站接线（P0b）
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §2 §4.3
 *
 * 桥在 upsert 得到 provisionalSid 后，必须经本函数得到权威 sender_sid。
 * index 未注入时退化返回 provisionalSid（兼容旧测 / Null 渠道）。
 */
import {
  type ChannelKey,
  type IdentityBindingIndex,
  serializeChannelKey,
} from './identity-binding-index.js';

/**
 * channel_key → 已绑定 sid；未命中则 bind(provisionalSid) 并返回之。
 */
export function resolveInboundSenderSid(
  index: IdentityBindingIndex | null | undefined,
  key: ChannelKey,
  provisionalSid: string,
): string {
  const provisional = provisionalSid.trim();
  if (!provisional) throw new Error('provisionalSid required');
  if (!index) return provisional;
  const existing = index.resolve(key);
  if (existing) return existing;
  index.bind(key, provisional);
  return provisional;
}

/**
 * 从过渡期渠道前缀 SID 反推 channel_key（无 scope）。
 * 飞书多 app 应以桥传入的显式 ChannelKey 为准；本函数仅作 Facade / HTTP 兜底。
 */
export function channelKeyFromProvisionalSid(sid: string): ChannelKey | null {
  const raw = sid.trim();
  const m = /^(webchat|discord|feishu|slack|telegram|dingtalk|wechat):user:(.+)$/i.exec(raw);
  if (!m) return null;
  return { channel: m[1]!.toLowerCase(), native_user_id: m[2]! };
}

/**
 * Facade 兜底：若 sender 仍是渠道前缀 SID，经索引折叠为 canonical。
 * 已是 `idp:user:…` / agent 等则原样返回。
 */
export function canonicalizeInboundSenderSid(
  index: IdentityBindingIndex | null | undefined,
  senderSid: string,
): string {
  if (!index) return senderSid;
  const key = channelKeyFromProvisionalSid(senderSid);
  if (!key) return senderSid;
  return resolveInboundSenderSid(index, key, senderSid);
}

export function channelKeyEquals(a: ChannelKey, b: ChannelKey): boolean {
  return serializeChannelKey(a) === serializeChannelKey(b);
}
