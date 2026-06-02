import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readTextFilePaginated } from './read-file-lines.js';

describe('readTextFilePaginated', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  function writeTmp(lines: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-file-lines-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'sample.txt');
    fs.writeFileSync(file, lines.join('\n'), 'utf8');
    return file;
  }

  it('returns whole small file when under wholeMaxBytes', () => {
    const file = writeTmp(['a', 'b', 'c']);
    const r = readTextFilePaginated(file, { wholeMaxBytes: 64 * 1024 });
    expect(r.ok).toBe(true);
    expect(r.output).toBe('a\nb\nc');
  });

  it('paginates with line numbers and footer hint', () => {
    const file = writeTmp(Array.from({ length: 10 }, (_, i) => `line-${i + 1}`));
    const r = readTextFilePaginated(file, { offsetLine: 3, limitLines: 2 });
    expect(r.ok).toBe(true);
    expect(r.output).toContain('[lines 3-4 of 10 total');
    expect(r.output).toContain('003| line-3');
    expect(r.output).toContain('offset_line=5');
  });

  it('forces pagination for large files without explicit window', () => {
    const bigLine = 'x'.repeat(200);
    const file = writeTmp(Array.from({ length: 400 }, () => bigLine));
    const r = readTextFilePaginated(file, { wholeMaxBytes: 1024, defaultLimitLines: 5 });
    expect(r.ok).toBe(true);
    expect(r.output).toContain('[lines 1-5 of 400 total');
    expect(r.output).toContain('offset_line=6');
  });

  it('rejects binary files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-file-lines-bin-'));
    tmpDirs.push(dir);
    const file = path.join(dir, 'bin.dat');
    fs.writeFileSync(file, Buffer.from([0x48, 0x00, 0x69]));
    const r = readTextFilePaginated(file);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('Binary');
  });

  it('errors when offset beyond end', () => {
    const file = writeTmp(['only']);
    const r = readTextFilePaginated(file, { offsetLine: 99 });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('beyond end');
  });
});
