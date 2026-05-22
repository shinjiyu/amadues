/**
 * WebChat user ↔ chat IR identity 映射 + 自动 upsert。
 *
 * 命名约定（与 discord-bridge 同构）：
 *   sid = `webchat:user:<user_id>`     普通人类用户（kind=human）
 *
 * Agent 自身的 sid 由调用方传入（通常是 `resolvePrimaryAgentSid()`），
 * 与 chat-server 端配置的 `WEBCHAT_AGENT_USER_ID` 不直接挂钩——
 * 出站时通过 `agent_secret` 在 chat-server 端伪装为该 user_id 即可。
 */
import type { IdentityRegistry } from '@utlra/chat-ir';

export function webChatUserToSid(userId: string): string {
  return `webchat:user:${userId}`;
}

/**
 * Upsert WebChat 用户身份到 IR registry。
 *
 * `kind` 默认 `'human'`；当被传入 `'agent'` 时（例如对方是 peer agent），
 * IR 会把它当 agent 处理——下游 senderIsAgent 判定、agent 链限流、
 * agent-self-flooding 兜底闸都依赖这个 kind。
 *
 * **kind 一旦升级为 agent，不会被回退到 human**：避免后续没带 `kind` 的
 * upsert 误将其覆盖为 human。
 */
export function upsertWebChatIdentity(
  registry: IdentityRegistry,
  userId: string,
  displayName: string,
  tenant: string,
  kind: 'human' | 'agent' = 'human',
): string {
  const sid = webChatUserToSid(userId);
  try {
    const prev = registry.get(sid);
    const binding = {
      channel: 'webchat',
      native_user_id: userId,
      ...(tenant ? { native_union_id: tenant } : {}),
    };
    const bindings = mergeBindings(prev?.bindings ?? [], binding);
    // 不允许从 agent 退回 human（防止误覆盖）
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
    console.error('[webchat-bridge] upsert identity failed', sid, e);
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
 * 反向：给定 IR sid，找回它在 WebChat 的 user_id。
 *
 * 优先查 registry bindings；未命中走 sid 前缀正则。
 */
export function sidToWebChatUserId(
  sid: string,
  registry?: IdentityRegistry,
): string | null {
  if (registry) {
    const rec = registry.get(sid);
    if (rec) {
      const b = rec.bindings.find((x) => x.channel === 'webchat');
      if (b) return b.native_user_id;
    }
  }
  const m = /^webchat:user:(.+)$/.exec(sid);
  return m ? (m[1] ?? null) : null;
}
