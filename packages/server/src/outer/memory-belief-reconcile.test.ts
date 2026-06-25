/**
 * @see doc/todo/memory-belief-reconciliation.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { Memory } from '../mem9/mem9-client.js';
import {
  applyTasksBeliefRevision,
  BeliefRevisionStore,
  filterMemoriesByValidity,
  parseUserBeliefIntent,
  reconcileBeliefFromUserMessage,
  VALIDITY_CANCELLED,
} from './memory-belief-reconcile.js';

describe('parseUserBeliefIntent', () => {
  it('detects 取消', () => {
    expect(parseUserBeliefIntent('微博那个任务取消吧')?.status).toBe('cancelled');
  });

  it('detects 已完成', () => {
    expect(parseUserBeliefIntent('调研报告已完成')?.status).toBe('completed');
  });

  it('returns null for neutral chat', () => {
    expect(parseUserBeliefIntent('你好，进展如何？')).toBeNull();
  });
});

describe('applyTasksBeliefRevision', () => {
  it('prepends cancelled line and marks matching task', () => {
    const out = applyTasksBeliefRevision(
      '- [ ] 微博 Cookie 调研\n- [ ] 其他',
      '微博 Cookie',
      'cancelled',
      '2026-05-19T12:00:00.000Z',
    );
    expect(out).toContain('[cancelled]');
    expect(out).toContain('微博 Cookie');
  });
});

describe('filterMemoriesByValidity', () => {
  it('drops low validity memories', () => {
    const mems: Memory[] = [
      { id: '1', content: 'a', metadata: { validity: 0.1 } },
      { id: '2', content: 'b', metadata: { validity: 0.9 } },
    ];
    expect(filterMemoriesByValidity(mems)).toHaveLength(1);
    expect(filterMemoriesByValidity(mems)[0]!.id).toBe('2');
  });
});

describe('reconcileBeliefFromUserMessage', () => {
  let root: string;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('persists revision and updates tasks', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'belief-'));
    const store = new BeliefRevisionStore(root, 'kuro');
    const { result, tasks, revisions } = reconcileBeliefFromUserMessage(
      'WAF 调研不要做了',
      'human:alice',
      store,
      '- [ ] WAF 调研',
    );
    expect(result.applied).toBe(true);
    expect(result.intent).toBe('cancelled');
    expect(tasks).toContain('[cancelled]');
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.validity).toBe(VALIDITY_CANCELLED);
  });

  it('persists with a colon-containing agent sid (Windows-safe path)', () => {
    // Regression: `idp:agent:kuroneko` as a raw filename throws ENOENT on Windows
    // (NTFS treats `:` as an Alternate Data Stream separator).
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'belief-'));
    const store = new BeliefRevisionStore(root, 'idp:agent:kuroneko');
    expect(() =>
      reconcileBeliefFromUserMessage('WAF 调研不要做了', 'human:alice', store, '- [ ] WAF 调研'),
    ).not.toThrow();
    const files = fs.readdirSync(path.join(root, 'belief'));
    expect(files).toContain('idp_agent_kuroneko.json');
    expect(store.read().revisions).toHaveLength(1);
  });
});
