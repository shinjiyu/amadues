/**
 * 人类工具化 — ADL doc/structurizr/AGENT-SUBJECT-DESIGN.md §3 人类工具化
 *
 * subject 模式下，每个登记过的人类是 agent 工具表里的一条工具，元数据与 MCP 工具同构：
 * 能力 / 渠道 / 可靠性 / 成本。agent 通过 human_query / human_request / human_notify 调用他们，
 * 调用是异步的：消息即时发出并记录为一条 pending 请求，人类的回复作为未来的入站信号回流。
 *
 * 账本 outer/human-requests.jsonl 只追加：请求记录 + 结案记录（answered）。
 * 关联规则是启发式的：被请求人在同一 thread 再次发言 → 视为对其最早一条未结 query/request 的回应。
 * 超过 timeoutMs 未结 → 视为超时。可靠性 = 历史回应率（带先验），覆盖文件可显式指定。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { IdentityRegistry } from '@utlra/chat-ir';
import type { ToolDef } from './outer-tools.js';

export type HumanToolCost = 'free' | 'favor' | 'paid';

export interface HumanToolProfile {
  sid: string;
  displayName: string;
  /** 'physical_action' | 'payment' | 'approval' | 'domain:<x>' ... 自由标签 */
  capabilities: string[];
  channel: string;
  /** 历史完成率 [0,1]；无数据时给中性默认 */
  reliability: number;
  cost: HumanToolCost;
}

export type HumanToolKind = 'human_query' | 'human_request' | 'human_notify';

export interface HumanRequestRecord {
  id: string;
  at: string;
  kind: HumanToolKind;
  targetSid: string;
  targetName: string;
  content: string;
  threadId: string;
  timeoutMs: number;
  status: 'pending';
}

export interface HumanResolutionRecord {
  type: 'resolution';
  requestId: string;
  at: string;
  outcome: 'answered';
  replyExcerpt: string;
}

type LedgerEntry = HumanRequestRecord | HumanResolutionRecord;

const OVERRIDES_FILE = 'human-tools.json';
const REQUESTS_FILE = 'human-requests.jsonl';
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6h
export const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;
const RELIABILITY_PRIOR = 0.7;
const RELIABILITY_PRIOR_WEIGHT = 2;

function isResolution(e: LedgerEntry): e is HumanResolutionRecord {
  return (e as HumanResolutionRecord).type === 'resolution';
}

export function loadHumanLedger(dataRoot: string): LedgerEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(dataRoot, 'outer', REQUESTS_FILE), 'utf8');
  } catch {
    return [];
  }
  const out: LedgerEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LedgerEntry);
    } catch {
      // 跳过坏行
    }
  }
  return out;
}

export type RequestState = 'pending' | 'answered' | 'timed_out';

export interface RequestView {
  record: HumanRequestRecord;
  state: RequestState;
}

/** 由只追加账本推导每条请求的当前状态。 */
export function deriveRequestStates(ledger: LedgerEntry[], now: number): RequestView[] {
  const answered = new Set(ledger.filter(isResolution).map((r) => r.requestId));
  return ledger
    .filter((e): e is HumanRequestRecord => !isResolution(e))
    .map((record) => {
      if (answered.has(record.id)) return { record, state: 'answered' as const };
      if (record.kind === 'human_notify') return { record, state: 'answered' as const };
      const expired = Date.parse(record.at) + record.timeoutMs <= now;
      return { record, state: expired ? ('timed_out' as const) : ('pending' as const) };
    });
}

/**
 * 防骚扰闸门：对同一人已有未结 query/request 时不再发新的 query/request；
 * notify 对同一人有冷却期。返回阻挡原因，null 表示放行。
 */
export function checkHumanCallAllowed(
  ledger: LedgerEntry[],
  kind: HumanToolKind,
  targetSid: string,
  now: number,
): string | null {
  const views = deriveRequestStates(ledger, now).filter((v) => v.record.targetSid === targetSid);
  if (kind === 'human_notify') {
    const recent = views.find(
      (v) => v.record.kind === 'human_notify' && now - Date.parse(v.record.at) < NOTIFY_COOLDOWN_MS,
    );
    return recent ? `30 分钟内已通知过对方（${recent.record.id}）` : null;
  }
  const open = views.find((v) => v.state === 'pending' && v.record.kind !== 'human_notify');
  return open ? `对方还有一条未结请求（${open.record.id}：${open.record.content.slice(0, 40)}）` : null;
}

/**
 * 被请求人发言 → 结案其最早一条未结 query/request（同 thread）。返回被结案的请求。
 */
export function resolvePendingForSender(input: {
  dataRoot: string;
  senderSid: string;
  threadId: string;
  replyText: string;
  now?: number;
}): HumanRequestRecord | null {
  const now = input.now ?? Date.now();
  const ledger = loadHumanLedger(input.dataRoot);
  const pending = deriveRequestStates(ledger, now)
    .filter(
      (v) =>
        v.state === 'pending' &&
        v.record.targetSid === input.senderSid &&
        v.record.threadId === input.threadId,
    )
    .sort((a, b) => Date.parse(a.record.at) - Date.parse(b.record.at));
  const first = pending[0]?.record;
  if (!first) return null;
  const resolution: HumanResolutionRecord = {
    type: 'resolution',
    requestId: first.id,
    at: new Date(now).toISOString(),
    outcome: 'answered',
    replyExcerpt: input.replyText.trim().slice(0, 200),
  };
  appendLedger(input.dataRoot, resolution);
  return first;
}

/** 历史回应率（带先验）。只统计已结案或已超时的 query/request。 */
export function computeReliability(ledger: LedgerEntry[], sid: string, now: number): number {
  let answered = 0;
  let closed = 0;
  for (const v of deriveRequestStates(ledger, now)) {
    if (v.record.targetSid !== sid || v.record.kind === 'human_notify') continue;
    if (v.state === 'pending') continue;
    closed++;
    if (v.state === 'answered') answered++;
  }
  return (answered + RELIABILITY_PRIOR * RELIABILITY_PRIOR_WEIGHT) / (closed + RELIABILITY_PRIOR_WEIGHT);
}

function appendLedger(dataRoot: string, entry: LedgerEntry): void {
  try {
    const dir = path.join(dataRoot, 'outer');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, REQUESTS_FILE), JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // 落盘失败不致命
  }
}

export function channelFromSid(sid: string): string {
  const m = /^(?:idp:)?([a-z0-9]+):/i.exec(sid);
  return m ? m[1]!.toLowerCase() : 'unknown';
}

function loadOverrides(dataRoot: string): Record<string, Partial<HumanToolProfile>> {
  try {
    const raw = fs.readFileSync(path.join(dataRoot, 'outer', OVERRIDES_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, Partial<HumanToolProfile>>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function isHuman(sid: string, registry: IdentityRegistry): boolean {
  if (/^(?:idp:)?agent:/i.test(sid)) return false;
  const rec = registry.get(sid);
  if (rec?.kind && rec.kind !== 'human') return false;
  return true;
}

export interface BuildHumanToolRegistryInput {
  registry: IdentityRegistry;
  agentSid: string;
  /** 本 thread 出现过的 sid（候选人类来源） */
  candidateSids: string[];
  /** 覆盖文件内容（缺省从 dataRoot 读） */
  overrides?: Record<string, Partial<HumanToolProfile>>;
  dataRoot?: string;
}

/**
 * 只把"登记过的人"纳入工具表：出现在 thread 里且不是 agent 的 sid，叠加覆盖文件。
 * 陌生人（未在 registry、无覆盖）只作为信号源，不进工具表。
 */
export function buildHumanToolRegistry(input: BuildHumanToolRegistryInput): HumanToolProfile[] {
  const overrides =
    input.overrides ?? (input.dataRoot ? loadOverrides(input.dataRoot) : {});
  const sids = new Set<string>();
  for (const sid of input.candidateSids) {
    if (sid && sid !== input.agentSid && isHuman(sid, input.registry)) sids.add(sid);
  }
  // 覆盖文件里显式登记的人也纳入（即便本 thread 没出现）
  for (const sid of Object.keys(overrides)) {
    if (sid !== input.agentSid) sids.add(sid);
  }

  const ledger = input.dataRoot ? loadHumanLedger(input.dataRoot) : [];
  const now = Date.now();
  const profiles: HumanToolProfile[] = [];
  for (const sid of sids) {
    const ov = overrides[sid] ?? {};
    const rec = input.registry.get(sid);
    profiles.push({
      sid,
      displayName: ov.displayName ?? rec?.display_name ?? sid,
      capabilities: ov.capabilities ?? ['domain:general', 'physical_action', 'approval'],
      channel: ov.channel ?? channelFromSid(sid),
      reliability:
        typeof ov.reliability === 'number' ? ov.reliability : computeReliability(ledger, sid, now),
      cost: ov.cost ?? 'favor',
    });
  }
  return profiles.sort((a, b) => b.reliability - a.reliability);
}

/** 渲染工具表供 subject 系统提示注入。 */
export function renderHumanToolRoster(profiles: HumanToolProfile[]): string {
  if (profiles.length === 0) {
    return '（当前没有登记在册的人类工具。陌生人只是信号源，不可调用。）';
  }
  const lines = profiles.map(
    (p) =>
      `- ${p.displayName}｜能力：${p.capabilities.join('/')}｜渠道：${p.channel}｜` +
      `可靠性：${(p.reliability * 100).toFixed(0)}%｜成本：${p.cost}`,
  );
  return (
    '这些人类是你工具表里的工具（和 MCP 工具同构）。需要他们做你做不到的事时，' +
    '用 human_query / human_request / human_notify 调用，按能力和可靠性挑人，接受被拒绝：\n' +
    lines.join('\n')
  );
}

export function resolveHumanTarget(
  profiles: HumanToolProfile[],
  target: string,
): HumanToolProfile | null {
  const t = target.trim();
  if (!t) return null;
  const bySid = profiles.find((p) => p.sid === t);
  if (bySid) return bySid;
  const byName = profiles.find((p) => p.displayName === t || p.displayName.includes(t));
  return byName ?? null;
}

export function recordHumanRequest(dataRoot: string, record: HumanRequestRecord): void {
  appendLedger(dataRoot, record);
}

export function makeHumanRequestRecord(input: {
  kind: HumanToolKind;
  target: HumanToolProfile;
  content: string;
  threadId: string;
  now?: number;
  timeoutMs?: number;
}): HumanRequestRecord {
  const now = input.now ?? Date.now();
  return {
    id: `hreq-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    at: new Date(now).toISOString(),
    kind: input.kind,
    targetSid: input.target.sid,
    targetName: input.target.displayName,
    content: input.content,
    threadId: input.threadId,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    status: 'pending',
  };
}

export const HUMAN_TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'human_query',
      description:
        '向一个登记在册的人类询问信息（异步）。用于你拿不到、只有人知道的事实。按工具表的能力/可靠性挑人。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '目标人类的显示名或 sid（取自工具表）' },
          content: { type: 'string', description: '你要问的问题' },
        },
        required: ['target', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'human_request',
      description:
        '请一个登记在册的人类替你做一件你做不到的事（异步）：物理操作、付款、审批、接线上电等。接受被拒绝。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '目标人类的显示名或 sid（取自工具表）' },
          content: { type: 'string', description: '你请对方做的具体事情与验收标准' },
        },
        required: ['target', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'human_notify',
      description: '通知一个登记在册的人类一件事，不要求回复（异步、单向）。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: '目标人类的显示名或 sid（取自工具表）' },
          content: { type: 'string', description: '通知内容' },
        },
        required: ['target', 'content'],
      },
    },
  },
];

const KIND_PREFIX: Record<HumanToolKind, string> = {
  human_query: '【询问】',
  human_request: '【请求协助】',
  human_notify: '【通知】',
};

/** 渲染发给人类的消息文本（带 @mention 与类别前缀）。 */
export function renderHumanToolMessage(
  kind: HumanToolKind,
  target: HumanToolProfile,
  content: string,
): string {
  return `@${target.displayName} ${KIND_PREFIX[kind]}${content.trim()}`;
}
