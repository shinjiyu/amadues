/**
 * @see doc/todo/executor-resolved-pendings-truncation.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { formatResolvedPendingResultForPrompt } from './executor.js';

describe('formatResolvedPendingResultForPrompt', () => {
  let workDir = '';

  afterEach(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('small result stays inline (no spill file)', () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-res-'));
    const result = { reply: 'short ok' };
    const out = formatResolvedPendingResultForPrompt('pend-short', result, workDir);
    expect(out).toBe(JSON.stringify(result));
    expect(fs.existsSync(path.join(workDir, '.brain/inbound/pending-results/pend-short.json'))).toBe(false);
  });

  it('large result spills to .brain/inbound/pending-results/ with full JSON on disk', () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-res-'));
    const cookie = 'SUB=' + 'x'.repeat(5000);
    const result = { reply: cookie };
    const serialized = JSON.stringify(result);

    const out = formatResolvedPendingResultForPrompt('pend-mpo4pfk5-9ee9be', result, workDir);

    expect(out).toContain('pending-results/pend-mpo4pfk5-9ee9be.json');
    expect(out).toContain('read_file');
    expect(out.length).toBeLessThan(serialized.length);

    const spillPath = path.join(workDir, '.brain/inbound/pending-results/pend-mpo4pfk5-9ee9be.json');
    expect(fs.readFileSync(spillPath, 'utf8')).toBe(serialized);
    expect(JSON.parse(fs.readFileSync(spillPath, 'utf8')).reply).toBe(cookie);
  });

  it('does not hard-cap at 600 characters in preview', () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-res-'));
    const result = { reply: 'a'.repeat(800) };
    const out = formatResolvedPendingResultForPrompt('pend-800', result, workDir);
    expect(out).toBe(JSON.stringify(result));
    expect(out.length).toBeGreaterThan(600);
  });
});
