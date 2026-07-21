/**
 * ADL: identityLinkService
 * path: packages/server/src/outer/identity-link-service.ts
 * horizon.in:  identity_link_request；confirm/reject（channel_key 鉴权）；adminForce
 * horizon.out: pending；committed 映射（经 identityBindingIndex）
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §3 §4.2
 *
 * 双边确认状态机。可注入 index / 时钟 / 投递回调，不依赖 OuterBrain，可单独组件测。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ChannelKeyConflictError,
  normalizeChannelKey,
  serializeChannelKey,
  type ChannelKey,
  type IdentityBindingIndex,
} from '@utlra/chat-ir';

export type LinkPendingStatus = 'pending' | 'committed' | 'rejected' | 'expired';

export interface IdentityLinkPending {
  pending_id: string;
  status: LinkPendingStatus;
  initiator_sid: string;
  target_sid: string;
  initiator_key: ChannelKey;
  counterpart_key: ChannelKey;
  created_at: string;
  expires_at: string;
  created_by_sid: string;
  committed_at?: string;
  rejected_at?: string;
  reject_reason?: string;
}

export interface RequestLinkInput {
  /** 当前消息已 resolve 的发起人 */
  initiatorSid: string;
  /** 发起人所在渠道键（用于审计与可选 bind 校验） */
  initiatorKey: ChannelKey;
  /** 要绑定的对端渠道键 */
  counterpartKey: ChannelKey;
  /** 合并目标，默认 = initiatorSid */
  targetSid?: string;
  /** TTL ms，默认 24h */
  ttlMs?: number;
}

export type RequestLinkResult =
  | { ok: true; pending: IdentityLinkPending; delivered: boolean }
  | { ok: false; reason: string };

export type ConfirmLinkResult =
  | { ok: true; pending: IdentityLinkPending; targetSid: string }
  | { ok: false; reason: string };

export interface IdentityLinkServiceDeps {
  index: IdentityBindingIndex;
  /** pending 目录；null = 仅内存 */
  pendingDir?: string | null;
  now?: () => Date;
  defaultTtlMs?: number;
  /** 白名单可 adminForce */
  adminSids?: ReadonlySet<string> | readonly string[];
  /** 向对端投递确认（IM）；失败不阻止 pending 创建，delivered=false */
  deliverConfirm?: (pending: IdentityLinkPending) => Promise<void> | void;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

function asAdminSet(v: IdentityLinkServiceDeps['adminSids']): Set<string> {
  if (!v) return new Set();
  return v instanceof Set ? v : new Set(v);
}

export class IdentityLinkService {
  private readonly memory = new Map<string, IdentityLinkPending>();
  private readonly pendingDir: string | null;
  private readonly now: () => Date;
  private readonly defaultTtlMs: number;
  private readonly adminSids: Set<string>;
  private readonly deliverConfirm?: IdentityLinkServiceDeps['deliverConfirm'];

  constructor(private readonly deps: IdentityLinkServiceDeps) {
    this.pendingDir = deps.pendingDir ?? null;
    this.now = deps.now ?? (() => new Date());
    this.defaultTtlMs = deps.defaultTtlMs ?? DEFAULT_TTL_MS;
    this.adminSids = asAdminSet(deps.adminSids);
    this.deliverConfirm = deps.deliverConfirm;
    this.loadAll();
  }

  getPending(pendingId: string): IdentityLinkPending | undefined {
    this.expireIfNeeded(pendingId);
    return this.memory.get(pendingId);
  }

  /** 全部 pending 记录（含终态；status 已按需过期刷新） */
  list(): IdentityLinkPending[] {
    for (const id of this.memory.keys()) this.expireIfNeeded(id);
    return [...this.memory.values()];
  }

  async requestLink(input: RequestLinkInput): Promise<RequestLinkResult> {
    const initiatorSid = input.initiatorSid.trim();
    const targetSid = (input.targetSid ?? initiatorSid).trim();
    if (!initiatorSid || !targetSid) {
      return { ok: false, reason: 'initiator_sid_required' };
    }

    const initiatorKey = input.initiatorKey;
    const counterpartKey = input.counterpartKey;
    const initSer = serializeChannelKey(initiatorKey);
    const counterSer = serializeChannelKey(counterpartKey);
    if (initSer === counterSer) {
      return { ok: false, reason: 'counterpart_same_as_initiator' };
    }

    const boundInitiator = this.deps.index.resolve(initiatorKey);
    if (boundInitiator && boundInitiator !== initiatorSid) {
      return { ok: false, reason: 'initiator_key_bound_to_other_sid' };
    }

    const boundCounterpart = this.deps.index.resolve(counterpartKey);
    if (boundCounterpart === targetSid) {
      return { ok: false, reason: 'already_linked' };
    }
    // 对端发过言就会被自动 provision 绑到自己的 sid——这是常态而非冲突。
    // 只要对端 sid 上挂的 key 全是「同一渠道账号」（scope 变体也算），
    // 就视为孤立自身份，放行；confirm 后 commitBindings 会 linkMerge 并入 target。
    // 反之（sid 已含其它账号的 key = 已与他人合并的真身份）才拒绝。
    if (boundCounterpart && !this.isLoneSelfIdentity(boundCounterpart, counterpartKey)) {
      return { ok: false, reason: 'counterpart_key_already_bound' };
    }

    const created = this.now();
    const ttl = input.ttlMs ?? this.defaultTtlMs;
    const pending: IdentityLinkPending = {
      pending_id: randomUUID(),
      status: 'pending',
      initiator_sid: initiatorSid,
      target_sid: targetSid,
      initiator_key: { ...initiatorKey },
      counterpart_key: { ...counterpartKey },
      created_at: created.toISOString(),
      expires_at: new Date(created.getTime() + ttl).toISOString(),
      created_by_sid: initiatorSid,
    };

    this.persist(pending);

    let delivered = false;
    if (this.deliverConfirm) {
      try {
        await this.deliverConfirm(pending);
        delivered = true;
      } catch {
        delivered = false;
      }
    }

    return { ok: true, pending, delivered };
  }

  async confirm(pendingId: string, actorKey: ChannelKey): Promise<ConfirmLinkResult> {
    const pending = this.getPending(pendingId);
    if (!pending) return { ok: false, reason: 'pending_not_found' };
    if (pending.status === 'expired') return { ok: false, reason: 'pending_expired' };
    if (pending.status !== 'pending') return { ok: false, reason: `pending_${pending.status}` };

    const actorSer = serializeChannelKey(actorKey);
    const expectSer = serializeChannelKey(pending.counterpart_key);
    if (actorSer !== expectSer) {
      return { ok: false, reason: 'actor_not_counterpart' };
    }

    try {
      this.commitBindings(pending);
    } catch (e) {
      if (e instanceof ChannelKeyConflictError) {
        return { ok: false, reason: 'channel_key_conflict' };
      }
      throw e;
    }

    const committed: IdentityLinkPending = {
      ...pending,
      status: 'committed',
      committed_at: this.now().toISOString(),
    };
    this.persist(committed);
    return { ok: true, pending: committed, targetSid: pending.target_sid };
  }

  rejectPending(pendingId: string, reason = 'rejected'): { ok: true } | { ok: false; reason: string } {
    const pending = this.getPending(pendingId);
    if (!pending) return { ok: false, reason: 'pending_not_found' };
    if (pending.status !== 'pending') return { ok: false, reason: `pending_${pending.status}` };
    this.persist({
      ...pending,
      status: 'rejected',
      rejected_at: this.now().toISOString(),
      reject_reason: reason,
    });
    return { ok: true };
  }

  /**
   * 运维旁路：跳过 pending，直接把两条 key 挂到 targetSid（必要时 linkMerge）。
   */
  adminForceLink(input: {
    actorSid: string;
    keyA: ChannelKey;
    keyB: ChannelKey;
    targetSid: string;
  }): { ok: true; targetSid: string } | { ok: false; reason: string } {
    if (!this.adminSids.has(input.actorSid)) {
      return { ok: false, reason: 'not_admin' };
    }
    const targetSid = input.targetSid.trim();
    const fake: IdentityLinkPending = {
      pending_id: 'admin-force',
      status: 'pending',
      initiator_sid: targetSid,
      target_sid: targetSid,
      initiator_key: input.keyA,
      counterpart_key: input.keyB,
      created_at: this.now().toISOString(),
      expires_at: this.now().toISOString(),
      created_by_sid: input.actorSid,
    };
    try {
      this.commitBindings(fake);
    } catch (e) {
      if (e instanceof ChannelKeyConflictError) {
        return { ok: false, reason: 'channel_key_conflict' };
      }
      throw e;
    }
    return { ok: true, targetSid };
  }

  /** sid 上所有 key 均为同一渠道账号（scope 变体视为同账号）→ 孤立自身份 */
  private isLoneSelfIdentity(sid: string, counterpartKey: ChannelKey): boolean {
    const ck = normalizeChannelKey(counterpartKey);
    return this.deps.index.listKeys(sid).every((k) => {
      const n = normalizeChannelKey(k);
      return n.channel === ck.channel && n.native_user_id === ck.native_user_id;
    });
  }

  private commitBindings(pending: IdentityLinkPending): void {
    const target = pending.target_sid;
    const idx = this.deps.index;

    const ensureKey = (key: ChannelKey) => {
      const existing = idx.resolve(key);
      if (!existing) {
        idx.bind(key, target);
        return;
      }
      if (existing === target) return;
      idx.linkMerge(existing, target);
    };

    ensureKey(pending.initiator_key);
    ensureKey(pending.counterpart_key);
  }

  private expireIfNeeded(pendingId: string): void {
    const p = this.memory.get(pendingId);
    if (!p || p.status !== 'pending') return;
    if (this.now().getTime() <= Date.parse(p.expires_at)) return;
    const expired: IdentityLinkPending = { ...p, status: 'expired' };
    this.persist(expired);
  }

  private persist(pending: IdentityLinkPending): void {
    this.memory.set(pending.pending_id, pending);
    if (!this.pendingDir) return;
    fs.mkdirSync(this.pendingDir, { recursive: true });
    const file = path.join(this.pendingDir, `${pending.pending_id}.json`);
    fs.writeFileSync(file, JSON.stringify(pending, null, 2), 'utf8');
  }

  private loadAll(): void {
    if (!this.pendingDir || !fs.existsSync(this.pendingDir)) return;
    for (const name of fs.readdirSync(this.pendingDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(
          fs.readFileSync(path.join(this.pendingDir, name), 'utf8'),
        ) as IdentityLinkPending;
        if (raw?.pending_id) this.memory.set(raw.pending_id, raw);
      } catch {
        /* skip */
      }
    }
  }
}

export function createIdentityLinkService(deps: IdentityLinkServiceDeps): IdentityLinkService {
  return new IdentityLinkService(deps);
}
