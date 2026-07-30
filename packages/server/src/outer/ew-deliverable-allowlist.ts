/**
 * EW execute 常漏写 COMPLETE/deliverables.json。
 * 仅按固定 allowlist 补登记（非全目录扫描，对齐 R4.6）。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 已知采集/报告相对路径（workDir 相对） */
export const EW_REPORT_ALLOWLIST = [
  'workspace/tweets_summary.html',
  'workspace/tweets_summary.md',
  'workspace/tweets_summary.json',
  'workspace/report.md',
  'report.md',
  'tweets_summary.html',
  'tweets_summary.md',
  'tweets_summary.json',
] as const;

function deliverablesJsonPath(workDir: string): string {
  return path.join(workDir, '.run', 'pi-mono', 'deliverables.json');
}

function readExisting(workDir: string): string[] {
  const fp = deliverablesJsonPath(workDir);
  if (!fs.existsSync(fp)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf8')) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string' && !!x.trim())
      : [];
  } catch {
    return [];
  }
}

/**
 * 若 allowlist 文件存在且未登记，则写入/合并 `.run/pi-mono/deliverables.json`。
 * @returns 最终登记路径列表
 */
export function ensureAllowlistedEwDeliverables(workDir: string): string[] {
  const existing = readExisting(workDir);
  const found: string[] = [];
  for (const rel of EW_REPORT_ALLOWLIST) {
    const abs = path.join(workDir, rel);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile() && fs.statSync(abs).size > 0) {
        found.push(rel);
      }
    } catch {
      /* skip */
    }
  }
  const merged = [...new Set([...existing, ...found])];
  if (merged.length === 0) return [];
  const out = deliverablesJsonPath(workDir);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}
