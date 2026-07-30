/**
 * @see doc/structurizr/MEMORY-BELIEF-CARD.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Memory, Mem9Client, SearchOptions, StoreResult, UpdateOptions, WriteOptions } from '../mem9/mem9-client.js';
import {
  buildBeliefCardContent,
  deriveBeliefTopic,
  formatCurrentBeliefCards,
  partitionMemoriesForPrompt,
  parseUserBeliefRepairIntent,
  readWorkspaceBeliefEvidence,
  upsertBeliefCard,
  VALIDITY_BELIEF_SUPERSEDED,
} from './memory-belief-card.js';

class FakeMem9 {
  memories: Memory[] = [];
  private seq = 0;

  async store(opts: WriteOptions): Promise<StoreResult> {
    const id = `m${++this.seq}`;
    this.memories.push({
      id,
      content: opts.content,
      agent_id: opts.agentId,
      metadata: { ...(opts.metadata ?? {}) },
      created_at: new Date().toISOString(),
    });
    return { status: 'accepted' };
  }

  async update(id: string, opts: UpdateOptions): Promise<Memory> {
    const m = this.memories.find((x) => x.id === id);
    if (!m) throw new Error(`missing ${id}`);
    if (opts.content != null) m.content = opts.content;
    if (opts.metadata) m.metadata = { ...(m.metadata ?? {}), ...opts.metadata };
    return m;
  }

  async search(opts: SearchOptions = {}): Promise<Memory[]> {
    let list = this.memories.filter((m) => !opts.agentId || m.agent_id === opts.agentId);
    if (opts.query) {
      const q = opts.query.toLowerCase();
      list = list.filter(
        (m) =>
          m.content.toLowerCase().includes(q) ||
          String(m.metadata?.['topic'] ?? '')
            .toLowerCase()
            .includes(q) ||
          String(m.metadata?.['role'] ?? '')
            .toLowerCase()
            .includes(q),
      );
    }
    return list.slice(0, opts.limit ?? 50);
  }
}

describe('deriveBeliefTopic', () => {
  it('prefers kpi then ew then workspace', () => {
    expect(deriveBeliefTopic({ kpiId: 'kpi-1', workflowId: 'ew-a' })).toBe('kpi:kpi-1');
    expect(deriveBeliefTopic({ workflowId: 'ew-a' })).toBe('ew:ew-a');
    expect(deriveBeliefTopic({ workspaceId: 'task-1' })).toBe('workspace:task-1');
  });
});

describe('buildBeliefCardContent', () => {
  it('embeds topic and prior repair note when ok', () => {
    const c = buildBeliefCardContent({
      topic: 'kpi:abc',
      summary: 'kept_count=62',
      polarity: 'ok',
      priorSummary: 'cookie 疑过期空采',
      source: 'test',
    });
    expect(c).toContain('[belief_current][kpi:abc]');
    expect(c).toContain('现行：可用');
    expect(c).toContain('曾出过问题');
  });
});

describe('partitionMemoriesForPrompt', () => {
  it('separates belief cards and drops superseded / same-topic episodic', () => {
    const mems: Memory[] = [
      {
        id: '1',
        content: '[belief_current][kpi:x] 现行：可用 — ok',
        metadata: { role: 'belief_current', topic: 'kpi:x', status: 'active', validity: 1 },
      },
      {
        id: '2',
        content: '旧失败 kpi:x cookie 过期',
        metadata: { validity: 1 },
      },
      {
        id: '3',
        content: '无关闲聊',
        metadata: { validity: 1 },
      },
      {
        id: '4',
        content: '已废',
        metadata: { role: 'belief_current', topic: 'kpi:x', status: 'superseded', validity: 0.2 },
      },
    ];
    const { beliefCards, episodic } = partitionMemoriesForPrompt(mems);
    expect(beliefCards).toHaveLength(1);
    expect(episodic.map((m) => m.id)).toEqual(['3']);
  });
});

describe('parseUserBeliefRepairIntent', () => {
  it('detects 修好了', () => {
    expect(parseUserBeliefRepairIntent('X cookie 修好了')?.matched).toMatch(/修好/);
  });

  it('null for neutral', () => {
    expect(parseUserBeliefRepairIntent('进度如何')).toBeNull();
  });
});

describe('readWorkspaceBeliefEvidence', () => {
  let root: string;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads workflow ok + kept_count as ok', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'belief-ev-'));
    fs.mkdirSync(path.join(root, '.run'), { recursive: true });
    fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.run', 'workflow_run.json'),
      JSON.stringify({ ok: true, workflowId: 'twitter-ew' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, 'workspace', 'tweets_summary.json'),
      JSON.stringify({ kept_count: 62 }),
      'utf8',
    );
    const ev = readWorkspaceBeliefEvidence(root);
    expect(ev.polarity).toBe('ok');
    expect(ev.keptCount).toBe(62);
    expect(ev.summary).toContain('kept_count=62');
  });

  it('reads workflow fail as blocked', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'belief-ev-'));
    fs.mkdirSync(path.join(root, '.run'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.run', 'workflow_run.json'),
      JSON.stringify({ ok: false, steps: [{ ok: false, detail: '401 cookie' }] }),
      'utf8',
    );
    expect(readWorkspaceBeliefEvidence(root).polarity).toBe('blocked');
  });
});

describe('upsertBeliefCard', () => {
  it('supersedes prior card on same topic', async () => {
    const fake = new FakeMem9();
    const mem9 = fake as unknown as Mem9Client;
    const agentId = 'kuro:chat';

    const first = await upsertBeliefCard(mem9, agentId, {
      topic: 'kpi:kpi-1',
      summary: '空采疑 cookie 过期',
      polarity: 'blocked',
      source: 'test',
    });
    expect(first.applied).toBe(true);
    expect(fake.memories).toHaveLength(1);

    const second = await upsertBeliefCard(mem9, agentId, {
      topic: 'kpi:kpi-1',
      summary: 'kept_count=62',
      polarity: 'ok',
      source: 'test',
    });
    expect(second.applied).toBe(true);
    expect(second.supersededIds).toHaveLength(1);
    expect(fake.memories).toHaveLength(2);

    const old = fake.memories.find((m) => m.id === second.supersededIds[0]);
    expect(old?.metadata?.['status']).toBe('superseded');
    expect(old?.metadata?.['validity']).toBe(VALIDITY_BELIEF_SUPERSEDED);

    const active = fake.memories.filter((m) => m.metadata?.['status'] === 'active');
    expect(active).toHaveLength(1);
    expect(active[0]!.content).toContain('现行：可用');
    expect(active[0]!.content).toContain('曾出过问题');

    const formatted = formatCurrentBeliefCards(active);
    expect(formatted).toContain('### 现行信念');
  });
});
