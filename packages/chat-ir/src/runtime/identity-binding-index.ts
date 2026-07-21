/**
 * ADL: identityBindingIndex
 * path: packages/chat-ir/src/runtime/identity-binding-index.ts
 * horizon.in:  channel_key resolve/bind/unbind/listKeys/linkMerge
 * horizon.out: internal_sid | error
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §2 §4.1
 *
 * 纯映射表：channel_key → internal_sid。不依赖 IdentityRegistry / agentServer，可单独单测。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ChannelKey {
  channel: string;
  native_user_id: string;
  /** 飞书 app_id 等，避免跨 app open_id 碰撞 */
  scope?: string;
}

export type IdentityBindingIndexSnapshot = Record<string, string>;

export class ChannelKeyConflictError extends Error {
  readonly code = 'channel_key_conflict' as const;
  constructor(
    readonly channelKey: string,
    readonly existingSid: string,
    readonly attemptedSid: string,
  ) {
    super(
      `channel_key ${channelKey} already bound to ${existingSid}, cannot bind ${attemptedSid}`,
    );
    this.name = 'ChannelKeyConflictError';
  }
}

export function normalizeChannelKey(key: ChannelKey): ChannelKey {
  const channel = key.channel.trim().toLowerCase();
  const native_user_id = key.native_user_id.trim();
  const scope = key.scope?.trim();
  if (!channel) throw new Error('channel_key.channel required');
  if (!native_user_id) throw new Error('channel_key.native_user_id required');
  return scope ? { channel, native_user_id, scope } : { channel, native_user_id };
}

/** 稳定序列化：`channel[:scope]:native_user_id` */
export function serializeChannelKey(key: ChannelKey): string {
  const k = normalizeChannelKey(key);
  return k.scope ? `${k.channel}:${k.scope}:${k.native_user_id}` : `${k.channel}:${k.native_user_id}`;
}

export function parseChannelKey(serialized: string): ChannelKey {
  const parts = serialized.split(':');
  if (parts.length < 2) throw new Error(`invalid channel_key: ${serialized}`);
  if (parts.length === 2) {
    return { channel: parts[0]!, native_user_id: parts[1]! };
  }
  const channel = parts[0]!;
  const native_user_id = parts[parts.length - 1]!;
  const scope = parts.slice(1, -1).join(':');
  return { channel, native_user_id, scope };
}

/** 新人内部 sid（渠道无关） */
export function mintInternalUserSid(): string {
  return `idp:user:${randomUUID()}`;
}

export interface IdentityBindingIndexOptions {
  /** 落盘路径；`null` = 仅内存（单测友好） */
  persistPath?: string | null;
}

/**
 * 跨渠道身份映射索引。权威写入面；IdentityRecord.bindings 仅为派生视图。
 */
export class IdentityBindingIndex {
  private readonly byKey = new Map<string, string>();
  private readonly persistPath: string | null;

  constructor(opts: IdentityBindingIndexOptions = {}) {
    this.persistPath = opts.persistPath ?? null;
    this.load();
  }

  resolve(key: ChannelKey): string | null {
    const ser = serializeChannelKey(key);
    return this.byKey.get(ser) ?? null;
  }

  resolveSerialized(serialized: string): string | null {
    return this.byKey.get(serialized) ?? null;
  }

  /**
   * 绑定。幂等：已指向同一 sid → ok。
   * 已指向其他 sid → ChannelKeyConflictError。
   */
  bind(key: ChannelKey, sid: string): void {
    const target = sid.trim();
    if (!target) throw new Error('sid required');
    const ser = serializeChannelKey(key);
    const existing = this.byKey.get(ser);
    if (existing && existing !== target) {
      throw new ChannelKeyConflictError(ser, existing, target);
    }
    if (existing === target) return;
    this.byKey.set(ser, target);
    this.save();
  }

  unbind(key: ChannelKey): boolean {
    const ser = serializeChannelKey(key);
    const ok = this.byKey.delete(ser);
    if (ok) this.save();
    return ok;
  }

  listKeys(sid: string): ChannelKey[] {
    const out: ChannelKey[] = [];
    for (const [ser, bound] of this.byKey) {
      if (bound === sid) out.push(parseChannelKey(ser));
    }
    return out;
  }

  /**
   * 将 sourceSid 上全部 channel_key 改挂到 targetSid。
   * 仅应由 identityLinkService 在 confirmed / adminForce 后调用。
   */
  linkMerge(sourceSid: string, targetSid: string): number {
    const src = sourceSid.trim();
    const tgt = targetSid.trim();
    if (!src || !tgt) throw new Error('sourceSid and targetSid required');
    if (src === tgt) return 0;
    let n = 0;
    for (const [ser, bound] of this.byKey) {
      if (bound === src) {
        this.byKey.set(ser, tgt);
        n += 1;
      }
    }
    if (n > 0) this.save();
    return n;
  }

  /** 入站便捷：已绑定则返回；否则 mint + bind */
  resolveOrProvision(key: ChannelKey, mintSid: () => string = mintInternalUserSid): string {
    const existing = this.resolve(key);
    if (existing) return existing;
    const sid = mintSid();
    this.bind(key, sid);
    return sid;
  }

  snapshot(): IdentityBindingIndexSnapshot {
    return Object.fromEntries(this.byKey);
  }

  size(): number {
    return this.byKey.size;
  }

  private load(): void {
    if (!this.persistPath || !fs.existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.persistPath, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) this.byKey.set(k, v.trim());
      }
    } catch {
      /* ignore corrupt */
    }
  }

  private save(): void {
    if (!this.persistPath) return;
    fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
    fs.writeFileSync(this.persistPath, JSON.stringify(this.snapshot(), null, 2), 'utf8');
  }
}
