/**
 * 微信 iLink user ↔ chat IR identity。
 *
 * 身份键（ADL IDENTITY-CROSS-CHANNEL.md §6.6）：
 * - `channel_key.native_user_id` = ilink 用户 id（`...@im.wechat`，对该微信号稳定）；
 * - `channel_key.scope = bot_id`（不同微信号 bot 看到的用户 id 空间独立，防碰撞——
 *   与飞书 scope=app_id 同理；resolve-inbound-sender 已把 wechat 列入「不折叠」渠道）。
 */
import type { ChannelKey, IdentityRegistry } from '@utlra/chat-ir';

export function wechatUserToSid(userId: string): string {
  return `wechat:user:${userId}`;
}

export function wechatChannelKey(botId: string, userId: string): ChannelKey | null {
  if (!userId) return null;
  return { channel: 'wechat', native_user_id: userId, scope: botId };
}

export function upsertWechatIdentity(
  registry: IdentityRegistry,
  userId: string,
  displayName: string,
  tenant: string,
  kind: 'human' | 'agent' = 'human',
): string {
  const sid = wechatUserToSid(userId);
  try {
    const prev = registry.get(sid);
    const binding = { channel: 'wechat', native_user_id: userId };
    const bindings = prev?.bindings?.some(
      (b) => b.channel === 'wechat' && b.native_user_id === userId,
    )
      ? prev.bindings
      : [...(prev?.bindings ?? []), binding];
    const finalKind: 'human' | 'agent' = prev?.kind === 'agent' ? 'agent' : kind;
    registry.upsert({
      schema: 'identity.v1',
      sid,
      kind: finalKind,
      display_name: displayName || userId,
      aliases: prev?.aliases ?? [],
      roles_in_tenant: prev?.roles_in_tenant ?? ['member'],
      bindings,
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[wechat-bridge] upsert identity failed', sid, e);
  }
  return sid;
}
