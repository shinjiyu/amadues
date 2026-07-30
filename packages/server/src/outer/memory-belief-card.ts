/**
 * mem9 Belief Card — 同 topic 现行结论 supersede-on-write（非删除）。
 * @see doc/structurizr/MEMORY-BELIEF-CARD.md
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Memory, Mem9Client } from '../mem9/mem9-client.js';
import { DEFAULT_READ_MIN_VALIDITY, filterMemoriesByValidity, memoryValidity } from './memory-belief-reconcile.js';

export const BELIEF_ROLE_CURRENT = 'belief_current';
export const VALIDITY_BELIEF_ACTIVE = 1;
export const VALIDITY_BELIEF_SUPERSEDED = 0.2;

export type BeliefPolarity = 'ok' | 'blocked' | 'unknown';

export interface BeliefCardInput {
  topic: string;
  summary: string;
  polarity: BeliefPolarity;
  priorSummary?: string;
  source: string;
  evidenceAt?: string;
}

export interface UpsertBeliefCardResult {
  applied: boolean;
  topic: string;
  supersededIds: string[];
  reason?: string;
}

export interface WorkspaceBeliefEvidence {
  polarity: BeliefPolarity;
  summary: string;
  priorHint?: string;
  workflowId?: string;
  keptCount?: number;
  workflowOk?: boolean;
}

/** 稳定 topic 键 */
export function deriveBeliefTopic(opts: {
  kpiId?: string;
  workflowId?: string;
  credentialKey?: string;
  workspaceId?: string;
}): string {
  const kpi = opts.kpiId?.trim();
  if (kpi) return `kpi:${kpi}`;
  const cred = opts.credentialKey?.trim();
  if (cred) return `credential:${cred}`;
  const ew = opts.workflowId?.trim();
  if (ew) return `ew:${ew}`;
  const ws = opts.workspaceId?.trim();
  if (ws) return `workspace:${ws}`;
  return 'general';
}

export function normalizeBeliefTopic(topic: string): string {
  return topic.trim().toLowerCase().slice(0, 160);
}

export function buildBeliefCardContent(input: BeliefCardInput): string {
  const topic = normalizeBeliefTopic(input.topic);
  const prior = input.priorSummary?.trim();
  const polarityLabel =
    input.polarity === 'ok' ? '可用' : input.polarity === 'blocked' ? '阻塞' : '未知';
  const priorPart = prior
    ? input.polarity === 'ok'
      ? `；曾出过问题：${prior.slice(0, 80)}（已修订）`
      : `；背景：${prior.slice(0, 80)}`
    : '';
  return `[belief_current][${topic}] 现行：${polarityLabel} — ${input.summary.slice(0, 200)}${priorPart}`;
}

export function isActiveBeliefCard(mem: Memory, minValidity = DEFAULT_READ_MIN_VALIDITY): boolean {
  const meta = mem.metadata ?? {};
  if (meta['role'] !== BELIEF_ROLE_CURRENT) return false;
  if (meta['status'] === 'superseded') return false;
  return memoryValidity(mem) >= minValidity;
}

export function beliefCardTopic(mem: Memory): string | undefined {
  const t = mem.metadata?.['topic'];
  return typeof t === 'string' && t.trim() ? normalizeBeliefTopic(t) : undefined;
}

/** 读侧：现行卡 vs 情节；情节排除 belief_current / superseded */
export function partitionMemoriesForPrompt(memories: Memory[]): {
  beliefCards: Memory[];
  episodic: Memory[];
} {
  const valid = filterMemoriesByValidity(memories);
  const beliefCards: Memory[] = [];
  const episodic: Memory[] = [];
  const activeTopics = new Set<string>();

  for (const m of valid) {
    if (isActiveBeliefCard(m)) {
      beliefCards.push(m);
      const t = beliefCardTopic(m);
      if (t) activeTopics.add(t);
      continue;
    }
    const meta = m.metadata ?? {};
    if (meta['role'] === BELIEF_ROLE_CURRENT) continue;
    if (meta['status'] === 'superseded') continue;
    episodic.push(m);
  }

  // 抑制与现行 topic 明显撞车的情节句（同 topic 元数据或 content 含 topic 键）
  const filteredEpisodic = episodic.filter((m) => {
    const t = beliefCardTopic(m);
    if (t && activeTopics.has(t)) return false;
    const c = m.content.toLowerCase();
    for (const topic of activeTopics) {
      if (topic.length >= 4 && c.includes(topic)) return false;
    }
    return true;
  });

  return { beliefCards, episodic: filteredEpisodic };
}

export function formatCurrentBeliefCards(cards: Memory[]): string {
  if (cards.length === 0) return '';
  const lines = cards.map((m) => `- ${m.content.replace(/^\[belief_current\]\[[^\]]+\]\s*/, '')}`);
  return ['### 现行信念（优先采信；同 topic 旧结论已降权）', ...lines].join('\n');
}

const REPAIR_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /修好了|已修复|修复好了|可用了|恢复正常|已经好了|不阻塞了/i, label: 'repair-zh' },
  { re: /\b(?:fixed|repaired|unblocked)\b/i, label: 'repair-en' },
];

export function parseUserBeliefRepairIntent(text: string): { matched: string } | null {
  const t = text.trim();
  if (!t) return null;
  for (const { re, label } of REPAIR_PATTERNS) {
    const m = t.match(re);
    if (m) return { matched: m[0] ?? label };
  }
  return null;
}

export function extractRepairTopic(text: string, matched: string): string {
  let rest = text.trim().replace(matched, '').trim();
  rest = rest.replace(/^[：:，,。.!！?？\s]+/, '').trim();
  if (rest.length >= 4) return rest.slice(0, 120);
  return text.trim().slice(0, 80);
}

function readKeptCount(workDir: string): number | undefined {
  const candidates = [
    path.join(workDir, 'workspace', 'tweets_summary.json'),
    path.join(workDir, 'tweets_summary.json'),
  ];
  for (const fp of candidates) {
    if (!fs.existsSync(fp)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf8')) as unknown;
      if (Array.isArray(parsed)) return parsed.length;
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as { kept_count?: unknown; tweets?: unknown };
        if (typeof obj.kept_count === 'number') return obj.kept_count;
        if (Array.isArray(obj.tweets)) return obj.tweets.length;
      }
    } catch {
      /* skip */
    }
  }
  return undefined;
}

function readWorkflowRunLite(workDir: string): {
  ok?: boolean;
  workflowId?: string;
  abortedAt?: string;
  failDetail?: string;
} | null {
  const fp = path.join(workDir, '.run', 'workflow_run.json');
  if (!fs.existsSync(fp)) return null;
  try {
    const run = JSON.parse(fs.readFileSync(fp, 'utf8')) as {
      ok?: boolean;
      workflowId?: string;
      abortedAt?: string;
      steps?: Array<{ ok?: boolean; detail?: string }>;
    };
    const failed = (run.steps ?? []).find((s) => s.ok === false);
    return {
      ok: run.ok,
      workflowId: run.workflowId,
      abortedAt: run.abortedAt,
      failDetail: failed?.detail,
    };
  } catch {
    return null;
  }
}

/** 从工作区机械证据推导 polarity（不读同伴 IM） */
export function readWorkspaceBeliefEvidence(
  workDir: string,
  opts?: { burstOk?: boolean; workflowId?: string },
): WorkspaceBeliefEvidence {
  const run = readWorkflowRunLite(workDir);
  const keptCount = readKeptCount(workDir);
  const workflowId = opts?.workflowId ?? run?.workflowId;

  if (run) {
    if (run.ok === true) {
      const keptPart =
        keptCount != null ? `kept_count=${keptCount}` : 'workflow_run.ok=true';
      return {
        polarity: 'ok',
        summary: `本地 EW 成功（${keptPart}）`,
        priorHint: undefined,
        workflowId,
        keptCount,
        workflowOk: true,
      };
    }
    const detail = (run.failDetail ?? run.abortedAt ?? 'workflow_run.ok=false').slice(0, 120);
    return {
      polarity: 'blocked',
      summary: `本地 EW 失败：${detail}`,
      workflowId,
      keptCount,
      workflowOk: false,
    };
  }

  if (opts?.burstOk === true) {
    const keptPart = keptCount != null ? `；kept_count=${keptCount}` : '';
    return {
      polarity: 'ok',
      summary: `内脑 DONE${keptPart}`,
      keptCount,
    };
  }
  if (opts?.burstOk === false) {
    return {
      polarity: 'blocked',
      summary: '内脑非成功结束',
      keptCount,
    };
  }

  return {
    polarity: 'unknown',
    summary: '无足够本地证据',
    keptCount,
    workflowId,
  };
}

function priorFromOldCards(olds: Memory[]): string | undefined {
  const blocked = olds.find((m) => m.metadata?.['polarity'] === 'blocked');
  if (blocked) {
    const prior = blocked.metadata?.['prior_summary'];
    if (typeof prior === 'string' && prior.trim()) return prior.trim().slice(0, 120);
    return blocked.content.replace(/^\[belief_current\]\[[^\]]+\]\s*/, '').slice(0, 120);
  }
  if (olds[0]) {
    return olds[0]!.content.replace(/^\[belief_current\]\[[^\]]+\]\s*/, '').slice(0, 120);
  }
  return undefined;
}

/**
 * 同 topic supersede：降权旧 belief_current，store 新现行条。
 * 使用 store/update（非 ingest smart）。
 */
export async function upsertBeliefCard(
  mem9: Mem9Client,
  agentId: string,
  input: BeliefCardInput,
): Promise<UpsertBeliefCardResult> {
  const topic = normalizeBeliefTopic(input.topic);
  if (!topic) {
    return { applied: false, topic: '', supersededIds: [], reason: 'empty_topic' };
  }

  const evidenceAt = input.evidenceAt ?? new Date().toISOString();
  let hits: Memory[] = [];
  try {
    hits = await mem9.search({ agentId, query: topic, limit: 40 });
  } catch (e) {
    return {
      applied: false,
      topic,
      supersededIds: [],
      reason: `search_failed:${(e as Error).message}`,
    };
  }

  const activeSameTopic = hits.filter((m) => {
    if (!isActiveBeliefCard(m, 0)) return false;
    return beliefCardTopic(m) === topic;
  });

  const priorSummary = input.priorSummary?.trim() || priorFromOldCards(activeSameTopic);
  const content = buildBeliefCardContent({
    ...input,
    topic,
    priorSummary,
  });

  const supersededIds: string[] = [];
  for (const old of activeSameTopic) {
    try {
      await mem9.update(old.id, {
        metadata: {
          ...(old.metadata ?? {}),
          role: BELIEF_ROLE_CURRENT,
          topic,
          status: 'superseded',
          validity: VALIDITY_BELIEF_SUPERSEDED,
          revised_at: evidenceAt,
        },
      });
      supersededIds.push(old.id);
    } catch {
      /* 单条失败不阻断新卡 */
    }
  }

  try {
    await mem9.store({
      content,
      agentId,
      metadata: {
        role: BELIEF_ROLE_CURRENT,
        topic,
        status: 'active',
        validity: VALIDITY_BELIEF_ACTIVE,
        polarity: input.polarity,
        prior_summary: priorSummary ?? '',
        evidence_at: evidenceAt,
        source: input.source,
        supersedes: supersededIds,
        ts: evidenceAt,
      },
    });
  } catch (e) {
    return {
      applied: false,
      topic,
      supersededIds,
      reason: `store_failed:${(e as Error).message}`,
    };
  }

  return { applied: true, topic, supersededIds };
}
