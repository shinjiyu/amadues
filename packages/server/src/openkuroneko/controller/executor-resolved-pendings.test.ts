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

  it('credential_ref stays inline with path hint (no secret in prompt)', () => {
    workDir = tempWorkDir();
    const ref = {
      kind: 'credential_ref' as const,
      block_id: 'keychain' as const,
      slot: 'weibo',
      path: '.brain/secrets/weibo.json',
      byteLength: 900,
      credential_kind: 'cookie_header',
    };
    const out = formatResolvedPendingResultForPrompt('pend-cred', ref, workDir);
    expect(out).toContain('credential_ref');
    expect(out).toContain('.brain/secrets/weibo.json');
    expect(out).not.toContain('SUB=');
    expect(fs.existsSync(path.join(workDir, '.brain', 'inbound', 'pending-results'))).toBe(false);
  });
});
