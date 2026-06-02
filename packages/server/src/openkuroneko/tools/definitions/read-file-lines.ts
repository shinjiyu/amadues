/**
 * 分页读文本文件 — read_file / read_peer_file 共享。
 *
 * ADL：doc/structurizr/INNER-FILE-ACCESS.md §3.2
 */

import fs from 'node:fs';

export interface ReadTextFilePaginatedOptions {
  /** 1-based 起始行 */
  offsetLine?: number;
  /** 最大行数 */
  limitLines?: number;
  /** 超过此字节且未缩小 limit 时强制分页（默认 64KiB） */
  wholeMaxBytes?: number;
  defaultLimitLines?: number;
  maxLimitLines?: number;
  /** 拒绝读取超过此大小的文件（防 OOM） */
  maxFileBytes?: number;
}

export interface ReadTextFilePaginatedResult {
  ok: boolean;
  output: string;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function looksBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  return sample.includes(0);
}

function parseLimitArgs(opts: ReadTextFilePaginatedOptions): {
  offsetLine: number;
  limitLines: number;
  wholeMaxBytes: number;
} {
  const maxLimit = opts.maxLimitLines ?? readPositiveIntEnv('UTLRA_READ_FILE_MAX_LINES', 500);
  const defaultLimit = opts.defaultLimitLines ?? readPositiveIntEnv('UTLRA_READ_FILE_DEFAULT_LINES', 200);
  let limitLines = opts.limitLines ?? defaultLimit;
  limitLines = Math.min(Math.max(1, Math.floor(limitLines)), maxLimit);
  const offsetLine = Math.max(1, Math.floor(opts.offsetLine ?? 1));
  const wholeMaxBytes =
    opts.wholeMaxBytes ?? readPositiveIntEnv('UTLRA_READ_FILE_WHOLE_MAX_BYTES', 64 * 1024);
  return { offsetLine, limitLines, wholeMaxBytes };
}

/**
 * 分页读取 UTF-8 文本；超大文件仍可通过 offset/limit 读窗口。
 */
export function readTextFilePaginated(
  absPath: string,
  opts: ReadTextFilePaginatedOptions = {},
): ReadTextFilePaginatedResult {
  const maxFileBytes = opts.maxFileBytes ?? readPositiveIntEnv('UTLRA_READ_FILE_MAX_BYTES', 10 * 1024 * 1024);
  let st: fs.Stats;
  try {
    st = fs.statSync(absPath);
  } catch (e) {
    return { ok: false, output: String(e) };
  }
  if (!st.isFile()) return { ok: false, output: `Not a file: ${absPath}` };
  if (st.size > maxFileBytes) {
    return {
      ok: false,
      output: `File too large (${st.size} bytes); max ${maxFileBytes}. Use search_files or smaller limit_lines windows.`,
    };
  }

  const buf = fs.readFileSync(absPath);
  if (looksBinary(buf)) {
    return {
      ok: false,
      output: 'Binary or non-UTF-8 file; use shell_exec (file/xxd) instead of read_file.',
    };
  }

  const text = buf.toString('utf8');
  const allLines = text.split(/\r?\n/);
  const totalLines = allLines.length;
  const { offsetLine, limitLines, wholeMaxBytes } = parseLimitArgs(opts);

  const userAskedWindow = opts.offsetLine != null || opts.limitLines != null;
  const forcePaginate = st.size > wholeMaxBytes && !userAskedWindow;

  if (!userAskedWindow && !forcePaginate && totalLines <= limitLines) {
    return { ok: true, output: text };
  }

  const startIdx = offsetLine - 1;
  if (startIdx >= totalLines) {
    return {
      ok: false,
      output: `offset_line ${offsetLine} beyond end (file has ${totalLines} lines)`,
    };
  }
  const endIdx = Math.min(startIdx + limitLines, totalLines);
  const slice = allLines.slice(startIdx, endIdx);

  const header = `[lines ${offsetLine}-${endIdx} of ${totalLines} total, ${st.size} bytes]`;
  const body = slice
    .map((line, i) => {
      const n = String(startIdx + i + 1).padStart(3, '0');
      return `${n}| ${line}`;
    })
    .join('\n');
  const footer =
    endIdx < totalLines
      ? `\n(truncated: call read_file with offset_line=${endIdx + 1})`
      : '';
  return { ok: true, output: `${header}\n${body}${footer}` };
}
