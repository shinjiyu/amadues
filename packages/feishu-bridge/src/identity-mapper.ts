/**
 * 飞书 user ↔ chat IR identity。
 *
 * 身份键选择（ADL IDENTITY-CROSS-CHANNEL.md §5.1）：
 * - `channel_key.native_user_id` 优先 **union_id**（跨 app 稳定），退化 open_id；
 * - `channel_key.scope = app_id`（open_id 是 per-app 的，防碰撞）；
 * - IdentityRecord.bindings 里 native_user_id 存 **open_id**（出站 at 标签要用），
 *   native_union_id 存 union_id。
 */
import type { ChannelKey, IdentityRegistry } from '@utlra/chat-ir';

export interface FeishuSenderIds {
  open_id?: string;
  union_id?: string;
  user_id?: string;
}

/** union_id 优先的稳定人键；全缺 → null（系统消息等） */
export function stableFeishuUserKey(ids: FeishuSenderIds): string | null {
  return ids.union_id ?? ids.user_id ?? ids.open_id ?? null;
}

export function feishuUserToSid(stableKey: string): string {
  return `feishu:user:${stableKey}`;
}

export function feishuChannelKey(appId: string, ids: FeishuSenderIds): ChannelKey | null {
  const stable = stableFeishuUserKey(ids);
  if (!stable) return null;
  return { channel: 'feishu', native_user_id: stable, scope: appId };
}

export function upsertFeishuIdentity(
  registry: IdentityRegistry,
  ids: FeishuSenderIds,
  displayName: string,
  tenant: string,
  kind: 'human' | 'agent' = 'human',
): string {
  const stable = stableFeishuUserKey(ids);
  if (!stable) throw new Error('feishu sender has no id');
  const sid = feishuUserToSid(stable);
  try {
    const prev = registry.get(sid);
    const binding = {
      channel: 'feishu',
      // 出站 at 标签需要 open_id；没有 open_id 时退化 stable key
      native_user_id: ids.open_id ?? stable,
      ...(ids.union_id ? { native_union_id: ids.union_id } : {}),
    };
    const bindings = mergeBindings(prev?.bindings ?? [], binding);
    const finalKind: 'human' | 'agent' = prev?.kind === 'agent' ? 'agent' : kind;
    registry.upsert({
      schema: 'identity.v1',
      sid,
      kind: finalKind,
      display_name: displayName || stable,
      aliases: prev?.aliases ?? [],
      roles_in_tenant: prev?.roles_in_tenant ?? ['member'],
      bindings,
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[feishu-bridge] upsert identity failed', sid, e);
  }
  return sid;
}

/** 出站 mention：IR sid → 飞书 open_id（查 registry bindings） */
export function sidToFeishuOpenId(sid: string, registry?: IdentityRegistry): string | null {
  if (registry) {
    const rec = registry.get(sid);
    if (rec) {
      const b = rec.bindings.find((x) => x.channel === 'feishu');
      if (b) return b.native_user_id;
    }
  }
  const m = /^feishu:user:(.+)$/.exec(sid);
  return m ? (m[1] ?? null) : null;
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
