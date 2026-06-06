import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { runDeliverableCheck, runDeliverableChecks } from './deliverable-check.js';
import type { DeliverableCheck } from './types.js';

describe('runDeliverableCheck', () => {
  let dir = '';
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deliv-')); });
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it('file: passes for non-empty file, fails for missing/empty', () => {
    fs.writeFileSync(path.join(dir, 'report.md'), '# hi', 'utf8');
    fs.writeFileSync(path.join(dir, 'empty.txt'), '', 'utf8');
    expect(runDeliverableCheck(dir, { kind: 'file', target: 'report.md' }, '').ok).toBe(true);
    expect(runDeliverableCheck(dir, { kind: 'file', target: 'missing.md' }, '').ok).toBe(false);
    expect(runDeliverableCheck(dir, { kind: 'file', target: 'empty.txt' }, '').ok).toBe(false);
  });

  it('file: rejects path traversal outside workDir', () => {
    const r = runDeliverableCheck(dir, { kind: 'file', target: '../secret.txt' }, '');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/越界/);
  });

  it('json_key: resolves dot path incl. array index', () => {
    fs.writeFileSync(
      path.join(dir, 'create_result.json'),
      JSON.stringify({ book_id: '7648041320111426584', chapters: [{ id: 'c1' }] }),
      'utf8',
    );
    expect(runDeliverableCheck(dir, { kind: 'json_key', target: 'create_result.json#book_id' }, '').ok).toBe(true);
    expect(runDeliverableCheck(dir, { kind: 'json_key', target: 'create_result.json#chapters.0.id' }, '').ok).toBe(true);
    expect(runDeliverableCheck(dir, { kind: 'json_key', target: 'create_result.json#published_count' }, '').ok).toBe(false);
  });

  it('json_key: fails on empty value and bad json', () => {
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ name: '', list: [] }), 'utf8');
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json', 'utf8');
    expect(runDeliverableCheck(dir, { kind: 'json_key', target: 'a.json#name' }, '').ok).toBe(false);
    expect(runDeliverableCheck(dir, { kind: 'json_key', target: 'a.json#list' }, '').ok).toBe(false);
    expect(runDeliverableCheck(dir, { kind: 'json_key', target: 'bad.json#x' }, '').ok).toBe(false);
    expect(runDeliverableCheck(dir, { kind: 'json_key', target: 'a.json' }, '').ok).toBe(false); // missing #
  });

  it('stdout_contains / stdout_absent', () => {
    expect(runDeliverableCheck(dir, { kind: 'stdout_contains', target: '创建成功' }, '番茄 创建成功 0章').ok).toBe(true);
    expect(runDeliverableCheck(dir, { kind: 'stdout_contains', target: '创建成功' }, '失败了').ok).toBe(false);
    expect(runDeliverableCheck(dir, { kind: 'stdout_absent', target: '404' }, 'all good').ok).toBe(true);
    expect(runDeliverableCheck(dir, { kind: 'stdout_absent', target: '404' }, 'HTTP 404 Not Found').ok).toBe(false);
  });

  it('runDeliverableChecks AND-s all and reports missing with describe', () => {
    fs.writeFileSync(path.join(dir, 'ok.json'), JSON.stringify({ id: 1 }), 'utf8');
    const checks: DeliverableCheck[] = [
      { kind: 'json_key', target: 'ok.json#id', describe: '书籍ID已生成' },
      { kind: 'file', target: 'nope.md', describe: '报告已落盘' },
    ];
    const report = runDeliverableChecks(dir, checks, '');
    expect(report.ok).toBe(false);
    expect(report.missing).toHaveLength(1);
    expect(report.missing[0]).toMatch(/报告已落盘/);
  });
});
