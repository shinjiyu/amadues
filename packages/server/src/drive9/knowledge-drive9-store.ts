/**
 * KnowledgeDrive9Store — drive9 共享事实库（方案 B）
 *
 *   /knowledge/shared/{id}.md — 跨 agent / 跨 burst 可检索的环境事实
 *
 * 与 SkillDrive9Store 对称：原文存储 + grep 语义检索，不经 LLM 改写。
 */

import type { Drive9Client } from './drive9-client.js';
import { getDrive9Client, initDrive9Client } from './drive9-client.js';

export interface KnowledgeRecord {
  id: string;
  title: string;
  tags: string[];
  /** 事实正文（通常含 [事实] 前缀） */
  content: string;
  ts: string;
  sourceAgentId?: string;
  workspaceId?: string;
}

export const SHARED_KNOWLEDGE_DIR = '/knowledge/shared';

export function knowledgePath(id: string, agentSid?: string): string {
  const dir = agentSid ? `/knowledge/${agentSid}` : SHARED_KNOWLEDGE_DIR;
  return `${dir}/${id}.md`;
}

export function serializeKnowledge(record: KnowledgeRecord): string {
  return [
    `# ${record.title}`,
    ``,
    `<!-- meta`,
    `id: ${record.id}`,
    `tags: ${record.tags.join(', ')}`,
    `ts: ${record.ts}`,
    `source: ${record.sourceAgentId ?? 'unknown'}`,
    `workspace: ${record.workspaceId ?? ''}`,
    `-->`,
    ``,
    record.content,
  ].join('\n');
}

export function deserializeKnowledge(content: string, fallbackId: string): KnowledgeRecord {
  const lines = content.split('\n');
  const title = lines[0]?.replace(/^#\s*/, '').trim() ?? '';

  const metaStart = lines.findIndex((l) => l.trim() === '<!-- meta');
  const metaEnd = lines.findIndex((l, i) => i > metaStart && l.trim() === '-->');

  let id = fallbackId;
  let tags: string[] = [];
  let ts = new Date().toISOString();
  let source = 'unknown';
  let workspaceId = '';

  if (metaStart >= 0 && metaEnd > metaStart) {
    for (let i = metaStart + 1; i < metaEnd; i++) {
      const [key, ...rest] = (lines[i] ?? '').split(':');
      const val = rest.join(':').trim();
      switch (key?.trim()) {
        case 'id':        id = val; break;
        case 'tags':      tags = val.split(',').map((t) => t.trim()).filter(Boolean); break;
        case 'ts':        ts = val; break;
        case 'source':    source = val; break;
        case 'workspace': workspaceId = val; break;
      }
    }
  }

  const contentStart = metaEnd >= 0 ? metaEnd + 1 : 2;
  const body = lines.slice(contentStart).join('\n').trim();

  return {
    id,
    title,
    tags,
    content: body,
    ts,
    sourceAgentId: source,
    workspaceId: workspaceId || undefined,
  };
}

export class KnowledgeDrive9Store {
  constructor(private readonly drive9: Drive9Client) {}

  storeShared(record: KnowledgeRecord): void {
    const path = knowledgePath(record.id);
    const body = serializeKnowledge(record);
    void this.drive9
      .write(path, body)
      .catch((e: unknown) =>
        console.warn('[drive9-knowledge] storeShared failed:', (e as Error).message),
      );
  }

  async searchShared(query: string, limit = 8): Promise<KnowledgeRecord[]> {
    try {
      const results = await this.drive9.grep(query, SHARED_KNOWLEDGE_DIR, limit);
      if (!results.length) return [];

      const records = await Promise.all(
        results.map(async (r) => {
          try {
            const raw = await this.drive9.read(r.path);
            const id = r.name.replace(/\.md$/, '');
            return deserializeKnowledge(raw, id);
          } catch {
            return null;
          }
        }),
      );
      return records.filter((r): r is KnowledgeRecord => r !== null);
    } catch (e) {
      console.warn('[drive9-knowledge] searchShared failed:', (e as Error).message);
      return [];
    }
  }
}

let _instance: KnowledgeDrive9Store | null | undefined;

export function getKnowledgeDrive9Store(): KnowledgeDrive9Store | null {
  if (_instance !== undefined) return _instance;
  const client = getDrive9Client();
  _instance = client ? new KnowledgeDrive9Store(client) : null;
  return _instance;
}

/** 在 initSkillDrive9Store 之后调用，复用同一 Drive9Client。 */
export function initKnowledgeDrive9Store(): KnowledgeDrive9Store | null {
  const client = getDrive9Client();
  if (!client) {
    _instance = null;
    return null;
  }
  _instance = new KnowledgeDrive9Store(client);
  return _instance;
}

export function initKnowledgeDrive9StoreWithKey(apiKey: string, apiUrl?: string): KnowledgeDrive9Store {
  const client = getDrive9Client() ?? initDrive9Client(apiKey, apiUrl);
  _instance = new KnowledgeDrive9Store(client);
  return _instance;
}
