/**
 * Chat IR 持久化层：`threads.json` 的规范化读写工具（thread.v1 / message.v1）。
 *
 * 这层是 chat IR 数据的**文件存储**辅助，不绑定任何 IM 协议或服务进程。
 * 任何 `ChatIRChannel` 实现都可以直接读写这些 store 类型。
 */
import { randomUUID } from 'node:crypto';
import {
  MessageRecordSchema,
  ThreadRecordSchema,
  type MessageRecord,
  type ThreadRecord,
} from './schemas/message.js';
import { resolvePrimaryAgentSid } from './agent-sid.js';

export type LooseThreadStore = {
  threads: unknown[];
  messages: Record<string, unknown[]>;
};

export function parseStore(data: LooseThreadStore): {
  threads: ThreadRecord[];
  messages: Record<string, MessageRecord[]>;
} {
  const threads = (data.threads ?? []).map((t) => ThreadRecordSchema.parse(t));
  const messages: Record<string, MessageRecord[]> = {};
  for (const [tid, arr] of Object.entries(data.messages ?? {})) {
    messages[tid] = (arr ?? []).map((m) => MessageRecordSchema.parse(m));
  }
  return { threads, messages };
}

export function toLooseStore(parsed: {
  threads: ThreadRecord[];
  messages: Record<string, MessageRecord[]>;
}): LooseThreadStore {
  return {
    threads: parsed.threads,
    messages: Object.fromEntries(
      Object.entries(parsed.messages).map(([k, v]) => [k, v as unknown[]]),
    ),
  };
}

export function createThreadRecord(input: {
  thread_id?: string;
  tenant_id: string;
  channel: string;
  kind: 'dm' | 'group';
  title?: string;
  participant_sids: string[];
}): ThreadRecord {
  const now = new Date().toISOString();
  return ThreadRecordSchema.parse({
    schema: 'thread.v1',
    thread_id: input.thread_id ?? `thread:${randomUUID()}`,
    tenant_id: input.tenant_id,
    channel: input.channel,
    kind: input.kind,
    title: input.title,
    participant_sids: input.participant_sids,
    created_at: now,
  });
}

/** HTTP / 遗留消息：保证 threads[] 有 thread 元数据且 messages[bucket] 存在（默认 kind=group，HTTP 入站会按 thread_id 修正 dm） */
export function ensureThreadShell(
  data: LooseThreadStore,
  threadId: string,
  participantSids: string[],
): void {
  const exists = data.threads.some((t) => {
    const p = ThreadRecordSchema.safeParse(t);
    return p.success && p.data.thread_id === threadId;
  });
  if (!exists) {
    const tr = createThreadRecord({
      thread_id: threadId,
      tenant_id: 'default',
      channel: 'unknown',
      kind: 'group',
      participant_sids: [...new Set([...participantSids, resolvePrimaryAgentSid()])],
    });
    data.threads.push(tr);
  }
  if (!data.messages[threadId]) data.messages[threadId] = [];
}

export function findThread(data: LooseThreadStore, threadId: string): ThreadRecord | undefined {
  for (const t of data.threads) {
    const p = ThreadRecordSchema.safeParse(t);
    if (p.success && p.data.thread_id === threadId) return p.data;
  }
  return undefined;
}

/** Canonical key for an unordered pair of two distinct SIDs (1:1 DM). */
export function dmParticipantPairKey(sids: string[]): string | null {
  const u = [...new Set(sids)];
  if (u.length !== 2) return null;
  const [a, b] = u.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  return `${a}\0${b}`;
}

/** If a DM with the same two participants (order irrelevant) already exists, return it. */
export function findExistingDmThread(
  data: LooseThreadStore,
  tenantId: string,
  channel: string,
  participantSids: string[],
): ThreadRecord | undefined {
  const want = dmParticipantPairKey(participantSids);
  if (!want) return undefined;
  for (const t of data.threads) {
    const p = ThreadRecordSchema.safeParse(t);
    if (!p.success || p.data.kind !== 'dm') continue;
    if (p.data.tenant_id !== tenantId || p.data.channel !== channel) continue;
    if (dmParticipantPairKey(p.data.participant_sids) === want) return p.data;
  }
  return undefined;
}
