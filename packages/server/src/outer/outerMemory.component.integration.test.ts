/**
 * ADL component: outerMemory + belief reconcile + Belief Card
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Memory, Mem9Client, SearchOptions, StoreResult, UpdateOptions, WriteOptions } from '../mem9/mem9-client.js';
import { OuterMemoryStore } from './outer-memory.js';

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

  async ingest(): Promise<{ status: 'accepted' }> {
    return { status: 'accepted' };
  }
}

describe('component: outerMemory', () => {
  let root: string;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('无 mem9 时 readChatLog 返回提示（主路径）', async () => {
    const store = new OuterMemoryStore(null, 'kuro');
    const log = await store.readChatLog();
    expect(log).toContain('MEM9');
  });

  it('writeTasks / readTasks 内存往返', () => {
    const store = new OuterMemoryStore(null, 'kuro');
    store.writeTasks('- [ ] 任务 A');
    expect(store.readTasks()).toContain('任务 A');
  });

  it('reconcileFromUserMessage 更新 tasks 并持久化 belief', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'om-belief-'));
    const store = new OuterMemoryStore(null, 'kuro', root);
    store.writeTasks('- [ ] 微博调研');
    const r = store.reconcileFromUserMessage('微博调研不要做了', 'human:u1');
    expect(r.applied).toBe(true);
    expect(store.readTasks()).toContain('[cancelled]');
    const beliefFile = path.join(root, 'belief', 'kuro.json');
    expect(fs.existsSync(beliefFile)).toBe(true);
  });

  it('Belief Card supersede + formatMemoryForLlm 现行信念专段', async () => {
    const fake = new FakeMem9();
    const store = new OuterMemoryStore(fake as unknown as Mem9Client, 'kuro');

    await store.upsertBeliefCard({
      topic: 'kpi:kpi-ms',
      summary: '空采疑 cookie',
      polarity: 'blocked',
      source: 'test',
    });
    await store.upsertBeliefCard({
      topic: 'kpi:kpi-ms',
      summary: 'kept_count=62',
      polarity: 'ok',
      source: 'test',
    });

    const ctx = await store.readMemoryContext();
    expect(ctx.beliefCards).toContain('### 现行信念');
    expect(ctx.beliefCards).toContain('现行：可用');
    expect(ctx.beliefCards).toContain('曾出过问题');

    const formatted = store.formatMemoryForLlm(ctx);
    expect(formatted).toContain('### 现行信念');
    expect(formatted.indexOf('现行信念')).toBeLessThan(
      formatted.includes('最近对话日志') ? formatted.indexOf('最近对话日志') : formatted.length,
    );

    const active = fake.memories.filter((m) => m.metadata?.['status'] === 'active');
    expect(active).toHaveLength(1);
  });

  it('reconcileBeliefFromWorkspace 读 EW 证据写 ok 卡', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'om-ws-'));
    fs.mkdirSync(path.join(root, '.run'), { recursive: true });
    fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.run', 'workflow_run.json'),
      JSON.stringify({ ok: true, workflowId: 'twitter-ew' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, 'workspace', 'tweets_summary.json'),
      JSON.stringify({ kept_count: 12 }),
      'utf8',
    );

    const fake = new FakeMem9();
    const store = new OuterMemoryStore(fake as unknown as Mem9Client, 'yuanbao');
    const r = await store.reconcileBeliefFromWorkspace(root, {
      kpiId: 'kpi-ms2q5xh4-256d',
      workflowId: 'twitter-ew',
      source: 'ew_settle',
    });
    expect(r.applied).toBe(true);
    expect(r.topic).toBe('kpi:kpi-ms2q5xh4-256d');
    expect(fake.memories[0]!.metadata?.['polarity']).toBe('ok');
    expect(fake.memories[0]!.content).toContain('kept_count=12');
  });

  it('用户修好了 → Belief Card ok', async () => {
    const fake = new FakeMem9();
    const store = new OuterMemoryStore(fake as unknown as Mem9Client, 'kuro');
    await store.upsertBeliefCard({
      topic: 'kpi:kpi-1',
      summary: 'blocked',
      polarity: 'blocked',
      source: 'test',
    });
    const r = store.reconcileFromUserMessage('kpi-1 cookie 修好了', 'human:u1');
    expect(r.applied).toBe(true);
    expect(r.reason).toBe('user_repair');
    // fire-and-forget upsert — wait briefly
    await new Promise((resolve) => setTimeout(resolve, 30));
    const active = fake.memories.filter((m) => m.metadata?.['status'] === 'active');
    expect(active.some((m) => m.metadata?.['polarity'] === 'ok')).toBe(true);
    expect(active.some((m) => m.metadata?.['topic'] === 'kpi:kpi-1')).toBe(true);
  });
});
