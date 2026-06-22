/**
 * PlanReferencePort 实现 — archive / repository / peer 方案参考检索。
 *
 * ADL: doc/structurizr/TASK-PLAN-REFERENCE.md
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createFilesystemStore } from '../openkuroneko/archive/index.js';
import type { RetrievedSession } from '../openkuroneko/archive/types.js';
import {
  normalizePlanReferenceSources,
  type PlanReferenceHit,
  type PlanReferencePort,
  type PlanReferenceSearchInput,
  type PlanReferenceSource,
} from '../openkuroneko/inner-brain/plan-reference-port.js';
import { buildPeerWorkspaceEntries } from '../openkuroneko/tools/peer-workspace.js';
import { FilesystemRepositoryStore } from '../workspace-kit/index.js';

const DEFAULT_TOP_K = 5;
const MAX_SNIPPET_CHARS = 900;

export interface PlanReferencePortConfig {
  dataRoot?: string;
  archiveDir?: string;
  tenantId?: string;
  workspacesRoot?: string;
  peerWorkspaceIds?: string[];
}

function tokenize(q: string): string[] {
  const out: string[] = [];
  const s = q.trim().toLowerCase();
  if (!s) return out;
  for (const m of s.matchAll(/[\u4e00-\u9fff]{1,2}|[a-zA-Z0-9_]{2,}/g)) {
    out.push(m[0]!);
  }
  if (out.length === 0) out.push(s);
  return [...new Set(out)];
}

function scoreText(text: string, tokens: string[]): number {
  if (!text.trim() || tokens.length === 0) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (lower.includes(t)) score += 1;
  }
  return score;
}

function clip(text: string, max = MAX_SNIPPET_CHARS): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + `…（共 ${t.length} 字符，已截断）`;
}

function resolveArchiveDir(cfg: PlanReferencePortConfig): string {
  if (cfg.archiveDir?.trim()) return path.resolve(cfg.archiveDir.trim());
  if (cfg.dataRoot?.trim()) {
    return path.join(path.resolve(cfg.dataRoot.trim()), 'knowledge-archive');
  }
  return path.join(os.homedir(), '.openkuroneko', 'knowledge-base');
}

function sessionToHit(s: RetrievedSession): PlanReferenceHit {
  const parts: string[] = [];
  if (s.meta.burstOutcome) {
    const o = s.meta.burstOutcome;
    parts.push(`verdict=${o.verdict}`);
    if (o.hardFailures.length) parts.push(`硬失败：${o.hardFailures.join('；')}`);
    if (o.nextStrategy) parts.push(`换向：${o.nextStrategy}`);
  }
  if (s.constraints.trim()) parts.push(`约束：${s.constraints}`);
  if (s.knowledge.trim()) parts.push(`知识：${s.knowledge}`);
  if (s.skills.trim()) parts.push(`技能：${s.skills}`);
  const snippet = clip(parts.join('\n') || s.meta.goalSummary);
  return {
    source: 'archive',
    title: s.meta.goalSummary.slice(0, 80) || s.meta.sessionId,
    snippet,
    score: s.score,
  };
}

async function searchArchive(
  archiveDir: string,
  query: string,
  kpiId: string | undefined,
  topK: number,
): Promise<PlanReferenceHit[]> {
  const store = createFilesystemStore(archiveDir);
  const sessions = await store.retrieve(query, {
    kpiId,
    maxSessions: topK,
    maxCharsPerType: 400,
  });
  if (sessions.length === 0) return [];
  const context = store.buildContext(sessions);
  if (context.trim()) {
    const head: PlanReferenceHit = {
      source: 'archive',
      title: `归档检索（${sessions.length} 条 session）`,
      snippet: clip(context),
      score: sessions[0]?.score,
    };
    return [head, ...sessions.slice(1, topK).map(sessionToHit)].slice(0, topK);
  }
  return sessions.slice(0, topK).map(sessionToHit);
}

function searchRepository(
  dataRoot: string,
  tenantId: string,
  query: string,
  topK: number,
): PlanReferenceHit[] {
  const repo = new FilesystemRepositoryStore(dataRoot);
  const hits = repo.retrieve(tenantId, { query, lane: 'execution', limit: topK * 2 });
  const tokens = tokenize(query);
  return hits
    .map((r) => {
      const body = `${r.title}\n${r.body}`.trim();
      return {
        source: 'repository' as const,
        title: `[${r.kind}] ${r.title}`.slice(0, 100),
        snippet: clip(body),
        score: scoreText(body, tokens),
      };
    })
    .filter((h) => h.snippet.length > 0)
    .slice(0, topK);
}

function safeReadUtf8(filePath: string, maxChars: number): string {
  try {
    if (!fs.existsSync(filePath)) return '';
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    return raw.length > maxChars ? raw.slice(0, maxChars) + '…' : raw;
  } catch {
    return '';
  }
}

function searchPeers(
  workspacesRoot: string | undefined,
  peerWorkspaceIds: string[] | undefined,
  query: string,
  topK: number,
): PlanReferenceHit[] {
  if (!workspacesRoot?.trim() || !peerWorkspaceIds?.length) return [];
  const tokens = tokenize(query);
  const entries = buildPeerWorkspaceEntries(workspacesRoot, peerWorkspaceIds);
  const scored: PlanReferenceHit[] = [];

  for (const peer of entries) {
    const goal = safeReadUtf8(path.join(peer.workDir, '.brain', 'goal.md'), 1200);
    let lastFailure = '';
    try {
      const memPath = path.join(peer.workDir, '.brain', 'memory.json');
      if (fs.existsSync(memPath)) {
        const mem = JSON.parse(fs.readFileSync(memPath, 'utf8')) as {
          last_failure?: { summary?: string };
        };
        if (mem.last_failure?.summary) {
          lastFailure = mem.last_failure.summary;
        }
      }
    } catch {
      // ignore
    }
    const blob = [goal, lastFailure].filter(Boolean).join('\n');
    const score = scoreText(blob, tokens);
    if (score <= 0 && tokens.length > 0) continue;
    const parts: string[] = [];
    if (goal) parts.push(`goal：${goal}`);
    if (lastFailure) parts.push(`last_failure：${lastFailure}`);
    scored.push({
      source: 'peer',
      title: peer.workspaceId,
      snippet: clip(parts.join('\n\n') || '（peer workspace 无摘要）'),
      score,
    });
  }

  scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return scored.slice(0, topK);
}

export function createPlanReferencePort(cfg: PlanReferencePortConfig = {}): PlanReferencePort {
  const tenantId = cfg.tenantId?.trim() || 'default';
  const archiveDir = resolveArchiveDir(cfg);
  const dataRoot = cfg.dataRoot?.trim();

  return {
    async search(input: PlanReferenceSearchInput): Promise<PlanReferenceHit[]> {
      const query = input.query.trim();
      if (!query) return [];

      const sources = normalizePlanReferenceSources(input.sources);
      const topK = Math.min(10, Math.max(1, input.topK ?? DEFAULT_TOP_K));
      const perSource = Math.max(1, Math.ceil(topK / sources.length));
      const hits: PlanReferenceHit[] = [];

      for (const source of sources) {
        if (source === 'archive') {
          hits.push(...(await searchArchive(archiveDir, query, input.kpiId, perSource)));
        } else if (source === 'repository') {
          if (dataRoot) {
            hits.push(...searchRepository(dataRoot, tenantId, query, perSource));
          }
        } else if (source === 'peer') {
          hits.push(
            ...searchPeers(cfg.workspacesRoot, cfg.peerWorkspaceIds, query, perSource),
          );
        }
      }

      hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const seen = new Set<string>();
      const deduped: PlanReferenceHit[] = [];
      for (const h of hits) {
        const key = `${h.source}:${h.title}:${h.snippet.slice(0, 80)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(h);
        if (deduped.length >= topK) break;
      }
      return deduped;
    },
  };
}
