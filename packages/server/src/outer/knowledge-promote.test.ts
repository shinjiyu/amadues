import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseBrainFactEntries,
  redactSecretsInFact,
  shouldSkipFactPromotion,
  factEntryToRecord,
  truncateFact,
  createDrive9FactSyncSink,
  seedDrive9FactsToMemory,
} from './knowledge-promote.js';
import type { KnowledgeDrive9Store, KnowledgeRecord } from '../drive9/knowledge-drive9-store.js';
import type { FactRecord } from '../openkuroneko/inner-brain/types.js';

describe('knowledge-promote', () => {
  it('parseBrainFactEntries 解析时间戳与 [事实]', () => {
    const raw = `
<!-- 2026-05-28T08:58:16.611Z -->
[事实] Cocos Store API GetListByPayed 返回 142 条

<!-- 2026-05-28T09:00:00.000Z -->
[事实] 另一条
`;
    const entries = parseBrainFactEntries(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.ts).toContain('2026-05-28');
    expect(entries[0]?.content).toContain('GetListByPayed');
  });

  it('redactSecretsInFact 脱敏 API Key 与 session', () => {
    const line = '[事实] key=sk-abcdefghijklmnopqrstuvwxyz cocos_session=secret123';
    const out = redactSecretsInFact(line);
    expect(out).toContain('sk-<redacted>');
    expect(out).toContain('cocos_session=<keychain>');
    expect(out).not.toContain('secret123');
  });

  it('shouldSkipFactPromotion 跳过纯密钥行', () => {
    expect(shouldSkipFactPromotion('sk-<redacted>')).toBe(true);
  });

  it('factEntryToRecord 生成稳定 id 与 tags', () => {
    const rec = factEntryToRecord(
      { ts: '2026-05-28T00:00:00.000Z', content: '[事实] store.cocos.com /api/production/GetListByPayed' },
      { sourceAgentId: 'idp:agent:assistant', workspaceId: 'task-ib-test' },
    );
    expect(rec).not.toBeNull();
    expect(rec!.id).toMatch(/^kn-[a-f0-9]{12}$/);
    expect(rec!.tags).toContain('fact');
    expect(rec!.tags.some((t) => t.includes('cocos'))).toBe(true);
  });

  it('truncateFact 超长截断', () => {
    const long = 'x'.repeat(3000);
    expect(truncateFact(long).length).toBeLessThan(2100);
    expect(truncateFact(long)).toContain('截断');
  });

  describe('createDrive9FactSyncSink', () => {
    it('active fact → storeShared', () => {
      const stored: KnowledgeRecord[] = [];
      const store = { storeShared: (r: KnowledgeRecord) => { stored.push(r); } } as KnowledgeDrive9Store;
      const sink = createDrive9FactSyncSink(store, 'agent-1', 'task-ws');
      const fact: FactRecord = {
        id: 'kn-abc123def456',
        topic: 'test.api',
        content: '[事实] API /api/foo 可用',
        status: 'active',
        confidence: 'verified',
        source: { at: '2026-06-07T00:00:00.000Z', via: 'record_fact' },
        citeCount: 0,
        tags: [],
      };
      sink(fact);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.id).toBe('kn-abc123def456');
    });

    it('superseded fact 不同步', () => {
      const stored: KnowledgeRecord[] = [];
      const store = { storeShared: (r: KnowledgeRecord) => { stored.push(r); } } as KnowledgeDrive9Store;
      const sink = createDrive9FactSyncSink(store, 'agent-1', 'task-ws');
      sink({
        id: 'kn-x',
        topic: 't',
        content: 'old',
        status: 'superseded',
        confidence: 'obsolete',
        source: { at: 't', via: 'record_fact' },
        citeCount: 0,
        tags: [],
      });
      expect(stored).toHaveLength(0);
    });
  });

  describe('seedDrive9FactsToMemory', () => {
    const tmpDirs: string[] = [];

    afterEach(() => {
      for (const d of tmpDirs) {
        fs.rmSync(d, { recursive: true, force: true });
      }
      tmpDirs.length = 0;
    });

    it('drive9 检索结果写入 memory.json', async () => {
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kn-seed-'));
      tmpDirs.push(workDir);

      const store = {
        searchShared: vi.fn(async () => [{
          id: 'kn-seed001',
          title: 'foo',
          tags: ['fact', 'api'],
          content: '[事实] 端点 /api/bar 返回 JSON',
          ts: '2026-06-07T00:00:00.000Z',
        }]),
      } as unknown as KnowledgeDrive9Store;

      const n = await seedDrive9FactsToMemory(store, workDir, 'api bar', 5);
      expect(n).toBe(1);

      const mem = JSON.parse(
        fs.readFileSync(path.join(workDir, '.brain', 'memory.json'), 'utf8'),
      ) as { fact_records: FactRecord[] };
      expect(mem.fact_records.some((r) => r.topic === 'drive9.kn-seed001')).toBe(true);
    });
  });
});
