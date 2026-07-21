/**
 * 文件尾部读取工具 —— 从文件末尾按块回读，只取最后 N 行，
 * 避免把可能很大的 append-only 日志（pi-mono/logs、trace.jsonl）整份载入内存。
 *
 * 动机：Dashboard 轮询 brain-inspector / pi-logs / telemetry 时原先 `readFileSync` 全文件
 * 再 `slice(-N)`，单任务跑久后日志变大即线性变慢。改为真 tail 后成本与文件大小解耦。
 */
import fs from 'node:fs';
import path from 'node:path';

const CHUNK_SIZE = 64 * 1024;

/**
 * 读取文本文件最后 `maxLines` 行（按 `\n` 分隔，丢弃空行），保持原文件顺序（旧→新）。
 * 从文件尾按 64KB 块回读，读够 `maxLines+1` 个换行或到文件头即停。
 */
export function tailFileLines(filePath: string, maxLines: number): string[] {
  if (maxLines <= 0) return [];
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return [];
  }
  try {
    let pos = fs.fstatSync(fd).size;
    if (pos === 0) return [];
    let buffer = Buffer.alloc(0);
    let newlineCount = 0;
    while (pos > 0 && newlineCount <= maxLines) {
      const readSize = Math.min(CHUNK_SIZE, pos);
      pos -= readSize;
      const chunk = Buffer.alloc(readSize);
      fs.readSync(fd, chunk, 0, readSize, pos);
      buffer = Buffer.concat([chunk, buffer]);
      for (let i = 0; i < readSize; i++) {
        if (chunk[i] === 0x0a) newlineCount++;
      }
    }
    const lines = buffer
      .toString('utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    return lines.slice(-maxLines);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 解析某 workDir 下应展示的 pi-mono 日志文件路径：优先当天 `<YYYY-MM-DD>.jsonl`，
 * 否则取目录里字典序最新的 `.jsonl`。无目录/无文件时返回 null。
 */
export function resolveLatestPiMonoLog(workDir: string): string | null {
  const logsDir = path.join(workDir, '.run', 'pi-mono', 'logs');
  if (!fs.existsSync(logsDir)) return null;
  const today = path.join(logsDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  if (fs.existsSync(today)) return today;
  let latest: string | null = null;
  try {
    const files = fs
      .readdirSync(logsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
    if (files.length > 0) latest = path.join(logsDir, files[files.length - 1]!);
  } catch {
    return null;
  }
  return latest;
}
