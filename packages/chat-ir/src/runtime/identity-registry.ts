/**
 * `IdentityRegistry` —— chat IR 身份的进程内运行时存储。
 *
 * 职责：
 * - 加载 / 持久化 `identities.json`（`IdentityRecord[]`）
 * - 自动 seed 主助手（除非 `UTLRA_IM_OPEN_DEMO=1`）
 * - 解析 mention token（按 sid → display_name → alias 顺序匹配，给歧义提示）
 * - 构造 `IdentityContextPack`（喂给外脑 LLM 的固定身份块）
 *
 * 注意：这层依赖 `node:fs` / `node:path`，**仅 Node 进程可用**。
 * 浏览器/Edge 等纯 JS 环境只用 `@utlra/chat-ir/schemas` 即可。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  IdentityRecordSchema,
  type IdentityRecord,
} from '../schemas/identity.js';
import { resolvePrimaryAgentSid } from '../agent-sid.js';
import type { IdentityContextPack } from '../serialize.js';
import { isImOpenDemo } from '../internal/env.js';

const LEGACY_PRIMARY_AGENT_SID = 'idp:agent:self' as const;

/** 历史默认 sid，若存在 `UTLRA_PRIMARY_AGENT_SID` 且与默认不同，旧文件里可能仍有此键 */
const LEGACY_DEFAULT_PRIMARY_SID = 'idp:agent:assistant' as const;

export interface MentionResolutionOptions {
  participantSids?: string[];
  preferredChannels?: string[];
}

function narrowMentionCandidates(
  candidates: IdentityRecord[],
  opts?: MentionResolutionOptions,
): IdentityRecord[] {
  if (candidates.length <= 1) return candidates;

  let narrowed = candidates;
  const participantSet = new Set(
    (opts?.participantSids ?? []).map((sid) => sid.trim()).filter(Boolean),
  );
  if (participantSet.size > 0) {
    const scoped = narrowed.filter((rec) => participantSet.has(rec.sid));
    if (scoped.length > 0) narrowed = scoped;
  }

  const preferredChannels = new Set(
    (opts?.preferredChannels ?? []).map((channel) => channel.trim().toLowerCase()).filter(Boolean),
  );
  if (preferredChannels.size > 0) {
    const scoped = narrowed.filter((rec) =>
      rec.bindings.some((binding) => preferredChannels.has(binding.channel.toLowerCase())),
    );
    if (scoped.length > 0) narrowed = scoped;
  }

  return narrowed;
}

function ephemeralPrimaryRecord(primarySid: string): IdentityRecord {
  const now = new Date().toISOString();
  return {
    schema: 'identity.v1',
    sid: primarySid,
    kind: 'agent',
    display_name: 'Assistant',
    aliases: ['助手'],
    roles_in_tenant: ['assistant', 'bot'],
    bindings: [],
    updated_at: now,
  };
}

export class IdentityRegistry {
  private bySid = new Map<string, IdentityRecord>();

  constructor(private readonly persistPath: string | null = null) {
    if (persistPath && fs.existsSync(persistPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(persistPath, 'utf8')) as unknown;
        const arr = Array.isArray(raw) ? raw : [];
        for (const r of arr) {
          const p = IdentityRecordSchema.safeParse(r);
          if (p.success) this.bySid.set(p.data.sid, p.data);
        }
      } catch {
        /* ignore */
      }
    }
    this.migrateLegacyPrimaryAgentSid();
    this.seedDefaults();
  }

  /**
   * 将历史 `idp:agent:self` 迁到当前 `resolvePrimaryAgentSid()`；
   * 若配置了自定义主 sid 且仅有旧默认 `idp:agent:assistant` 记录，则合并到自定义 sid 并删旧键。
   */
  private migrateLegacyPrimaryAgentSid(): void {
    const primary = resolvePrimaryAgentSid();
    const legacySelf = this.bySid.get(LEGACY_PRIMARY_AGENT_SID);
    if (legacySelf) {
      if (!this.bySid.has(primary)) {
        const now = new Date().toISOString();
        this.bySid.set(primary, {
          ...legacySelf,
          sid: primary,
          updated_at: now,
        });
      }
      this.bySid.delete(LEGACY_PRIMARY_AGENT_SID);
    }
    if (primary !== LEGACY_DEFAULT_PRIMARY_SID) {
      const oldAssistant = this.bySid.get(LEGACY_DEFAULT_PRIMARY_SID);
      if (oldAssistant && !this.bySid.has(primary)) {
        const now = new Date().toISOString();
        this.bySid.set(primary, {
          ...oldAssistant,
          sid: primary,
          updated_at: now,
        });
      }
      if (this.bySid.has(LEGACY_DEFAULT_PRIMARY_SID) && this.bySid.has(primary)) {
        this.bySid.delete(LEGACY_DEFAULT_PRIMARY_SID);
      }
    }
    if (this.persistPath && (legacySelf || primary !== LEGACY_DEFAULT_PRIMARY_SID)) this.save();
  }

  private seedDefaults(): void {
    if (isImOpenDemo()) return;
    const now = new Date().toISOString();
    const primary = resolvePrimaryAgentSid();
    if (!this.bySid.has(primary)) {
      this.bySid.set(primary, {
        schema: 'identity.v1',
        sid: primary,
        kind: 'agent',
        display_name: 'Assistant',
        aliases: ['助手'],
        roles_in_tenant: ['assistant', 'bot'],
        bindings: [],
        updated_at: now,
      });
    }
    this.seedOptionalDemoUser(now);
  }

  /**
   * 仅开发/回归用：真实部署中「他人」身份应由渠道接入 upsert / 自动学习，不预置假用户。
   * 设置 `UTLRA_SEED_DEMO_USER=1` 时恢复历史 `idp:user:demo`。
   */
  private seedOptionalDemoUser(now: string): void {
    try {
      if (process.env['UTLRA_SEED_DEMO_USER']?.trim() !== '1') return;
    } catch {
      return;
    }
    if (!this.bySid.has('idp:user:demo')) {
      this.bySid.set('idp:user:demo', {
        schema: 'identity.v1',
        sid: 'idp:user:demo',
        kind: 'human',
        display_name: 'Demo User',
        aliases: ['用户'],
        roles_in_tenant: ['member'],
        bindings: [{ channel: 'web', native_user_id: 'demo' }],
        updated_at: now,
      });
    }
  }

  save(): void {
    if (!this.persistPath) return;
    fs.mkdirSync(path.dirname(this.persistPath), { recursive: true });
    fs.writeFileSync(
      this.persistPath,
      JSON.stringify([...this.bySid.values()], null, 2),
      'utf8',
    );
  }

  get(sid: string): IdentityRecord | undefined {
    return this.bySid.get(sid);
  }

  upsert(rec: IdentityRecord): void {
    this.bySid.set(rec.sid, { ...rec, updated_at: new Date().toISOString() });
    this.save();
  }

  list(): IdentityRecord[] {
    return [...this.bySid.values()];
  }

  demoPack(threadId = 'thread:demo'): IdentityContextPack {
    return this.packForThread(threadId, 'default', 'dm', [resolvePrimaryAgentSid()]);
  }

  /**
   * 按线程参与者构造 Pack（去重；始终包含主助手 `resolvePrimaryAgentSid()`）。
   */
  packForThread(
    threadId: string,
    tenantId: string,
    kind: 'dm' | 'group',
    participantSids: string[],
  ): IdentityContextPack {
    const primary = resolvePrimaryAgentSid();
    const self = this.bySid.get(primary) ?? ephemeralPrimaryRecord(primary);
    const participants: IdentityRecord[] = [];
    const seen = new Set<string>();
    for (const sid of participantSids) {
      const r = this.get(sid);
      if (r && !seen.has(r.sid)) {
        seen.add(r.sid);
        participants.push(r);
      }
    }
    if (!participants.some((p) => p.sid === self.sid)) {
      participants.unshift(self);
    }
    return {
      self,
      participants,
      threadSummary: { thread_id: threadId, tenant_id: tenantId, kind },
    };
  }

  /**
   * 将展示名 / 别名 / 完整 sid 解析为身份（歧义时返回多条，由调用方决定降级策略）。
   */
  resolveMentionToken(token: string, opts?: MentionResolutionOptions):
    | { kind: 'unique'; sid: string; record: IdentityRecord }
    | { kind: 'ambiguous'; candidates: IdentityRecord[] }
    | { kind: 'none' } {
    const raw = token.trim();
    if (!raw) return { kind: 'none' };
    const lower = raw.toLowerCase();
    const bySid: IdentityRecord[] = [];
    const byName: IdentityRecord[] = [];
    for (const r of this.bySid.values()) {
      if (r.sid === raw || r.sid.toLowerCase() === lower) {
        bySid.push(r);
      } else if (r.display_name.toLowerCase() === lower) {
        byName.push(r);
      } else if (r.aliases.some((a) => a.toLowerCase() === lower)) {
        byName.push(r);
      }
    }
    if (bySid.length === 1) return { kind: 'unique', sid: bySid[0]!.sid, record: bySid[0]! };
    if (bySid.length > 1) return { kind: 'ambiguous', candidates: bySid };
    const narrowedByName = narrowMentionCandidates(byName, opts);
    if (narrowedByName.length === 1) {
      return { kind: 'unique', sid: narrowedByName[0]!.sid, record: narrowedByName[0]! };
    }
    if (narrowedByName.length > 1) return { kind: 'ambiguous', candidates: narrowedByName };
    return { kind: 'none' };
  }
}
