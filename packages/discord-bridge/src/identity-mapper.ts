/**
 * Discord user ↔ chat IR identity 映射 + 自动 upsert 到注入的 `IdentityRegistry`。
 *
 * 命名约定：
 *   sid = `discord:user:<discord_user_id>`              普通用户（kind=human）
 *   sid = `idp:agent:discord-bot:<discord_user_id>`     其他 bot（kind=agent）
 *
 * 对方 bot：以 `agent` 注册，OuterBrain 已识别 `/^(idp:)?agent:/i` 为 agent，
 * 因此我们用 `idp:agent:discord-bot:<id>` 这种格式落 sid，让正则命中。
 */
import { resolvePrimaryAgentSid, type IdentityRegistry } from '@utlra/chat-ir';

export interface DiscordUserShape {
  id: string;
  username: string;
  globalName?: string | null;
  bot?: boolean;
  guildNickname?: string | null;
}

export function discordUserToSid(user: DiscordUserShape): string {
  if (user.bot) return `idp:agent:discord-bot:${user.id}`;
  return `discord:user:${user.id}`;
}

export function discordUserDisplayName(user: DiscordUserShape): string {
  return (
    user.guildNickname?.trim() ||
    user.globalName?.trim() ||
    user.username?.trim() ||
    user.id
  );
}

/**
 * 把 Discord 用户写进 `IdentityRegistry`（直接进程内调用，不走 HTTP）。
 * 失败不致命（只打日志）。
 */
export function upsertDiscordIdentity(
  registry: IdentityRegistry,
  user: DiscordUserShape,
  guildId?: string,
): string {
  const sid = discordUserToSid(user);
  const displayName = discordUserDisplayName(user);
  try {
    const prev = registry.get(sid);
    const binding = {
      channel: 'discord',
      native_user_id: user.id,
      ...(guildId ? { native_union_id: guildId } : {}),
    };
    const bindings = mergeBindings(prev?.bindings ?? [], binding);
    registry.upsert({
      schema: 'identity.v1',
      sid,
      kind: user.bot ? 'agent' : 'human',
      display_name: displayName,
      aliases: prev?.aliases ?? [],
      roles_in_tenant: prev?.roles_in_tenant ?? (user.bot ? ['bot'] : ['member']),
      bindings,
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[discord-bridge] upsert identity failed', sid, e);
  }
  return sid;
}

function mergeBindings(
  existing: Array<{ channel: string; native_user_id: string; native_union_id?: string }>,
  next: { channel: string; native_user_id: string; native_union_id?: string },
): Array<{ channel: string; native_user_id: string; native_union_id?: string }> {
  const idx = existing.findIndex(
    (b) =>
      b.channel === next.channel &&
      b.native_user_id === next.native_user_id &&
      (b.native_union_id ?? null) === (next.native_union_id ?? null),
  );
  if (idx >= 0) return existing;
  return [...existing, next];
}

/**
 * 回写时（agent → Discord）若 mention 的 target_sid 在 IdentityRegistry 的 bindings
 * 中有 `channel: 'discord'` 记录，返回其 `native_user_id`；否则回退到正则从 SID 字符串提取。
 *
 * 提供了 registry 时会优先查 bindings（支持非标准 SID 格式的身份），未命中再走正则。
 * 不提供 registry 时行为与改造前完全一致（纯正则）。
 */
export function sidToDiscordUserId(
  sid: string,
  registry?: IdentityRegistry,
): string | null {
  // 1. 优先从 IdentityRegistry bindings 查询
  if (registry) {
    const rec = registry.get(sid);
    if (rec) {
      const binding = rec.bindings.find((b) => b.channel === 'discord');
      if (binding) return binding.native_user_id;
    }
  }
  // 2. 回退：正则从 SID 字符串提取（保持向后兼容）
  const m1 = /^discord:user:(\d+)$/.exec(sid);
  if (m1) return m1[1] ?? null;
  const m2 = /^idp:agent:discord-bot:(\d+)$/.exec(sid);
  if (m2) return m2[1] ?? null;
  return null;
}

/** 主助手 sid（用于过滤自己发的消息） */
export function getAgentSid(): string {
  return process.env['UTLRA_AGENT_IM_SID']?.trim() || resolvePrimaryAgentSid();
}
