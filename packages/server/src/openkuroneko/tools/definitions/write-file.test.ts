import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { writeFileTool } from './write-file.js';
import { setWorkDirGuard } from './workdir-guard.js';

describe('writeFileTool', () => {
  let root = '';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'write-file-'));
    setWorkDirGuard(root, root, []);
  });

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('rejects slim placeholder content', async () => {
    const r = await writeFileTool.call({
      path: 'ch2.txt',
      content: '[3410 chars omitted; file on disk at workspace/ch2.txt]',
    });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('slim placeholder');
    expect(fs.existsSync(path.join(root, 'ch2.txt'))).toBe(false);
  });

  it('rejects __SLIM_REF__ content', async () => {
    const r = await writeFileTool.call({
      path: 'bot.cjs',
      content: '__SLIM_REF__:bot.cjs',
    });
    expect(r.ok).toBe(false);
  });

  it('append mode adds to existing file', async () => {
    const r1 = await writeFileTool.call({ path: 'log.md', content: 'line1\n', mode: 'overwrite' });
    expect(r1.ok).toBe(true);
    const r2 = await writeFileTool.call({ path: 'log.md', content: 'line2\n', mode: 'append' });
    expect(r2.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, 'log.md'), 'utf8')).toBe('line1\nline2\n');
  });
});
