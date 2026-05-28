/**
 * @see doc/todo/executor-resolved-pendings-truncation.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { formatResolvedPendingResultForPrompt } from './executor.js';

function tempWorkDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'exec-resolved-'));
}

describe('formatResolvedPendingResultForPrompt', () => {
  let workDir: string;

  afterEach(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('inlines small result without truncation', () => {
    workDir = tempWorkDir();
    const out = formatResolvedPendingResultForPrompt('pend-1', { reply: 'ok' }, workDir);
    expect(out).toBe('{"reply":"ok"}');
  });

  it('spills large result to pending-results file', () => {
    workDir = tempWorkDir();
    const big = 'x'.repeat(4000);
    const out = formatResolvedPendingResultForPrompt('pend-big', { reply: big }, workDir);
    expect(out).toContain('.brain/inbound/pending-results/pend-big.json');
    const spill = path.join(workDir, '.brain', 'inbound', 'pending-results', 'pend-big.json');
    expect(fs.existsSync(spill)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(spill, 'utf8')) as { reply: string };
    expect(parsed.reply).toBe(big);
  });

  it('large cookie reply spills like any large JSON result', () => {
    workDir = tempWorkDir();
    const cookie = 'SUB=' + 'a'.repeat(4000);
    const out = formatResolvedPendingResultForPrompt('pend-cookie', { reply: cookie }, workDir);
    expect(out).toContain('.brain/inbound/pending-results/pend-cookie.json');
    expect(out).not.toContain(cookie.slice(0, 100));
  });
});
