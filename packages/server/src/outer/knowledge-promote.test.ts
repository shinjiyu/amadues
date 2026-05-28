import { describe, expect, it } from 'vitest';
import {
  parseBrainFactEntries,
  redactSecretsInFact,
  shouldSkipFactPromotion,
  factEntryToRecord,
  truncateFact,
} from './knowledge-promote.js';

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
});
