import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** 执行轨 / 交互轨隔离（M8 会进一步验证） */
export type RepositoryLane = 'execution' | 'interaction';

export interface CommitSessionItem {
  kind: 'knowledge' | 'skill' | 'policy';
  title: string;
  body: string;
  tags?: string[];
}

export interface CommitSessionInput {
  session_id: string;
  realm: string;
  lane: RepositoryLane;
  items: CommitSessionItem[];
}

export interface RepositoryRecord {
  id: string;
  tenant_id: string;
  session_id: string;
  realm: string;
  lane: RepositoryLane;
  kind: 'knowledge' | 'skill' | 'policy';
  title: string;
  body: string;
  tags: string[];
  committed_at: string;
}

export interface RetrieveInput {
  query: string;
  realm?: string;
  lane?: RepositoryLane;
  limit?: number;
}

interface LaneIndexFile {
  schema: 'repository-lane-index.v1';
  tenant_id: string;
  lane: RepositoryLane;
  records: RepositoryRecord[];
}

function emptyIndex(tenant: string, lane: RepositoryLane): LaneIndexFile {
  return { schema: 'repository-lane-index.v1', tenant_id: tenant, lane, records: [] };
}

function tokenize(q: string): string[] {
  const out: string[] = [];
  const s = q.trim();
  if (!s) return out;
  for (const m of s.matchAll(/[\u4e00-\u9fff]{1,2}|[a-zA-Z0-9_]{2,}/g)) {
    out.push(m[0]!.toLowerCase());
  }
  if (out.length === 0) out.push(s.toLowerCase());
  return [...new Set(out)];
}

function scoreRecord(tokens: string[], r: RepositoryRecord): number {
  const hay = `${r.title}\n${r.body}\n${r.tags.join(' ')}`.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (hay.includes(t)) score += 1;
  }
  return score;
}

/**
 * 单机 RepositoryStore：按 tenant + lane 分文件存储，检索为关键词粗排 + 可选 rerank。
 */
export class FilesystemRepositoryStore {
  constructor(private readonly dataRoot: string) {}

  private repoRoot(tenantId: string): string {
    return path.join(this.dataRoot, 'repository', tenantId);
  }

  private lanePath(tenantId: string, lane: RepositoryLane): string {
    return path.join(this.repoRoot(tenantId), lane, 'index.json');
  }

  private readLane(tenantId: string, lane: RepositoryLane): LaneIndexFile {
    const p = this.lanePath(tenantId, lane);
    if (!fs.existsSync(p)) return emptyIndex(tenantId, lane);
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as LaneIndexFile;
      if (raw.schema !== 'repository-lane-index.v1' || !Array.isArray(raw.records)) {
        return emptyIndex(tenantId, lane);
      }
      return raw;
    } catch {
      return emptyIndex(tenantId, lane);
    }
  }

  private writeLane(tenantId: string, index: LaneIndexFile): void {
    const p = this.lanePath(tenantId, index.lane);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(index, null, 2), 'utf8');
  }

  commitSession(tenantId: string, input: CommitSessionInput): RepositoryRecord[] {
    const index = this.readLane(tenantId, input.lane);
    const now = new Date().toISOString();
    const added: RepositoryRecord[] = [];
    for (const it of input.items) {
      const rec: RepositoryRecord = {
        id: randomUUID(),
        tenant_id: tenantId,
        session_id: input.session_id,
        realm: input.realm,
        lane: input.lane,
        kind: it.kind,
        title: it.title,
        body: it.body,
        tags: it.tags ?? [],
        committed_at: now,
      };
      index.records.push(rec);
      added.push(rec);
    }
    this.writeLane(tenantId, index);
    return added;
  }

  /**
   * 关键词粗排；`rerank` 若提供则接收 id 列表，返回重排后的 id 列表（占位扩展点）。
   */
  retrieve(
    tenantId: string,
    input: RetrieveInput,
    rerank?: (ids: string[]) => string[],
  ): RepositoryRecord[] {
    const limit = Math.min(100, Math.max(1, input.limit ?? 20));
    const tokens = tokenize(input.query);
    const lanes: RepositoryLane[] = input.lane ? [input.lane] : ['execution', 'interaction'];

    let candidates: RepositoryRecord[] = [];
    for (const lane of lanes) {
      const idx = this.readLane(tenantId, lane);
      candidates = candidates.concat(idx.records);
    }

    if (input.realm) {
      candidates = candidates.filter((r) => r.realm === input.realm);
    }

    const scored = candidates
      .map((r) => ({ r, s: scoreRecord(tokens, r) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);

    let ordered = scored.map((x) => x.r);
    if (rerank && ordered.length > 0) {
      const ids = rerank(ordered.map((r) => r.id));
      const byId = new Map(ordered.map((r) => [r.id, r] as const));
      ordered = ids.map((id) => byId.get(id)).filter((x): x is RepositoryRecord => x != null);
    }
    return ordered.slice(0, limit);
  }

  /** 全量列举（可视化 / 管理用），按 committed_at 新到旧截断 */
  listRecords(tenantId: string, opts?: { lane?: RepositoryLane; limit?: number }): RepositoryRecord[] {
    const limit = Math.min(2000, Math.max(1, opts?.limit ?? 500));
    const lanes: RepositoryLane[] = opts?.lane ? [opts.lane] : ['execution', 'interaction'];
    const all: RepositoryRecord[] = [];
    for (const lane of lanes) {
      all.push(...this.readLane(tenantId, lane).records);
    }
    all.sort((a, b) => (a.committed_at < b.committed_at ? 1 : -1));
    return all.slice(0, limit);
  }
}
