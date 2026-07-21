/**
 * 单元测试：tail-file（真 tail 读取 + pi-mono 日志路径解析）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveLatestPiMonoLog, tailFileLines } from './tail-file.js';

const tmpRoots: string[] = [];
function makeDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tailf-'));
  tmpRoots.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpRoots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('tailFileLines', () => {
  it('returns last N non-empty lines in original order', () => {
    const dir = makeDir();
    const f = path.join(dir, 'log.jsonl');
    fs.writeFileSync(f, Array.from({ length: 1000 }, (_, i) => `line-${i}`).join('\n') + '\n');
    const tail = tailFileLines(f, 3);
    expect(tail).toEqual(['line-997', 'line-998', 'line-999']);
  });

  it('returns all lines when file has fewer than N', () => {
    const dir = makeDir();
    const f = path.join(dir, 'log.jsonl');
    fs.writeFileSync(f, 'a\nb\nc\n');
    expect(tailFileLines(f, 10)).toEqual(['a', 'b', 'c']);
  });

  it('drops empty / whitespace-only lines', () => {
    const dir = makeDir();
    const f = path.join(dir, 'log.jsonl');
    fs.writeFileSync(f, 'a\n\n  \nb\n');
    expect(tailFileLines(f, 10)).toEqual(['a', 'b']);
  });

  it('spans multiple read chunks (>64KB) and stays correct', () => {
    const dir = makeDir();
    const f = path.join(dir, 'big.jsonl');
    // 每行约 200B × 2000 行 ≈ 400KB，跨多个 64KB 块
    const lines = Array.from({ length: 2000 }, (_, i) => `${i}:` + 'x'.repeat(200));
    fs.writeFileSync(f, lines.join('\n') + '\n');
    const tail = tailFileLines(f, 5);
    expect(tail).toEqual(lines.slice(-5));
  });

  it('handles missing file and non-positive maxLines', () => {
    expect(tailFileLines(path.join(makeDir(), 'nope.jsonl'), 5)).toEqual([]);
    const dir = makeDir();
    const f = path.join(dir, 'x.jsonl');
    fs.writeFileSync(f, 'a\nb\n');
    expect(tailFileLines(f, 0)).toEqual([]);
  });

  it('handles empty file', () => {
    const dir = makeDir();
    const f = path.join(dir, 'empty.jsonl');
    fs.writeFileSync(f, '');
    expect(tailFileLines(f, 5)).toEqual([]);
  });
});

describe('resolveLatestPiMonoLog', () => {
  function logsDir(workDir: string): string {
    const d = path.join(workDir, '.run', 'pi-mono', 'logs');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  it('returns null when logs dir is absent', () => {
    expect(resolveLatestPiMonoLog(makeDir())).toBeNull();
  });

  it('prefers today file when present', () => {
    const wd = makeDir();
    const d = logsDir(wd);
    const today = `${new Date().toISOString().slice(0, 10)}.jsonl`;
    fs.writeFileSync(path.join(d, '2020-01-01.jsonl'), 'old\n');
    fs.writeFileSync(path.join(d, today), 'now\n');
    expect(resolveLatestPiMonoLog(wd)).toBe(path.join(d, today));
  });

  it('falls back to lexicographically latest .jsonl when no today file', () => {
    const wd = makeDir();
    const d = logsDir(wd);
    fs.writeFileSync(path.join(d, '2020-01-01.jsonl'), 'a\n');
    fs.writeFileSync(path.join(d, '2020-03-09.jsonl'), 'b\n');
    fs.writeFileSync(path.join(d, '2020-02-02.jsonl'), 'c\n');
    expect(resolveLatestPiMonoLog(wd)).toBe(path.join(d, '2020-03-09.jsonl'));
  });
});
