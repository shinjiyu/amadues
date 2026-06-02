/**
 * 超大 tool 输出落盘（OpenCode truncate 思路），上下文只保留预览 + 路径。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §6.5
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface SpillContext {
  workDir: string;
  round: number;
  toolName: string;
  toolCallId: string;
}

export function toolOutputDir(workDir: string): string {
  return path.join(workDir, '.run', 'tool-output');
}

/** 将完整 tool 输出写入 workDir/.run/tool-output/，返回 workDir 相对路径 */
export function spillToolOutput(fullText: string, ctx: SpillContext): string {
  const dir = toolOutputDir(ctx.workDir);
  fs.mkdirSync(dir, { recursive: true });
  const slug = ctx.toolName.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 32);
  const id = crypto.randomBytes(4).toString('hex');
  const fileName = `r${ctx.round}-${slug}-${id}.txt`;
  const abs = path.join(dir, fileName);
  fs.writeFileSync(abs, fullText, 'utf8');
  return path.relative(ctx.workDir, abs).replace(/\\/g, '/');
}

export interface CompressToolOutputOptions {
  inlineMax?: number;
  headChars?: number;
  tailChars?: number;
  spill?: SpillContext | null;
}

/**
 * 压缩 tool 输出供 ReAct 上下文；超限时可选落盘并附相对路径。
 */
export function compressToolOutputForContext(
  output: string,
  opts: CompressToolOutputOptions = {},
): string {
  const inlineMax = opts.inlineMax ?? readPositiveIntEnv('INNER_TOOL_OUTPUT_INLINE_MAX', 3000);
  const headChars = opts.headChars ?? 1800;
  const tailChars = opts.tailChars ?? 800;

  if (output.length <= inlineMax) return output;

  const spillPath =
    opts.spill && output.length > inlineMax ? spillToolOutput(output, opts.spill) : null;

  const head = output.slice(0, headChars);
  const tail = output.slice(output.length - tailChars);
  const removed = output.length - headChars - tailChars;
  const spillHint = spillPath
    ? `\n[全文 ${output.length} 字符已写入 ${spillPath}，可用 read_file 分页查看]\n`
    : '';
  return `${head}${spillHint}…[截断 ${removed} 字符]…\n${tail}`;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
