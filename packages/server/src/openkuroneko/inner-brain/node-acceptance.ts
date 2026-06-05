/**
 * baseNode 完成验票 — 机械校验 interface.outputs + shell 假成功检测。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §6.7
 */

import fs from 'node:fs';
import path from 'node:path';

import type { ExecutionEntry } from '../brain/index.js';
import type { LocalNode, NodeAcceptance, NodeInst, NodeOutputSpec } from './types.js';

export interface NodeEvidence {
  /** workDir 相对路径 → 绝对路径 */
  filePaths: Set<string>;
  /** 最近一次 shell_exec 原始输出（验票用） */
  lastShellOutput?: string;
}

export interface NodeCompletionResult {
  status: 'ok' | 'failed';
  outputs: Record<string, unknown>;
  missing: string[];
}

/** shell_exec 返回 ok:true 但输出含失败信号 → 降为失败（通用，非案例定制） */
export function shellOutputLooksFailed(output: string): boolean {
  const text = output.slice(0, 8000);
  if (/HTTP\/[12](?:\.\d)?\s+404\b/i.test(text)) return true;
  if (/\b404\b/.test(text) && /\b(curl|wget|fetch|http)\b/i.test(text)) return true;
  if (/exit code:\s*[1-9]\d*/i.test(text)) return true;
  if (/command failed|error:\s*not found/i.test(text)) return true;
  return false;
}

export function gatherEvidence(workDir: string, log: ExecutionEntry[]): NodeEvidence {
  const filePaths = new Set<string>();
  let lastShellOutput: string | undefined;

  for (const entry of log) {
    if (!entry.result.ok) continue;
    const out = entry.result.output ?? '';
    if (entry.toolName === 'shell_exec') {
      lastShellOutput = out;
    }
    if (entry.toolName === 'write_file' || entry.toolName === 'edit_file') {
      const p = entry.args['path'] ?? entry.args['file_path'];
      if (typeof p === 'string' && p.trim()) {
        filePaths.add(resolveWorkPath(workDir, p.trim()));
      }
    }
    if (entry.toolName === 'read_file' || entry.toolName === 'read_peer_file') {
      const p = entry.args['path'] ?? entry.args['file_path'];
      if (typeof p === 'string' && p.trim()) {
        filePaths.add(resolveWorkPath(workDir, p.trim()));
      }
    }
    for (const m of out.matchAll(/(?:^|\s)([\w./-]+\.(?:json|csv|txt|log|md|mjs|js|ts))(?:\s|$)/gi)) {
      const rel = m[1];
      if (rel && !rel.includes('..')) {
        filePaths.add(resolveWorkPath(workDir, rel));
      }
    }
  }

  return { filePaths, lastShellOutput };
}

function resolveWorkPath(workDir: string, rel: string): string {
  const abs = path.isAbsolute(rel) ? path.normalize(rel) : path.normalize(path.join(workDir, rel));
  const root = path.normalize(workDir);
  if (!abs.startsWith(root)) return abs;
  return abs;
}

function parseJsonFile(absPath: string): { ok: boolean; data?: unknown; reason?: string } {
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    const data = JSON.parse(raw) as unknown;
    return { ok: true, data };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

function checkOutputSpec(
  spec: NodeOutputSpec,
  ctx: {
    workDir: string;
    lastContent: string;
    evidence: NodeEvidence;
    outputs: Record<string, unknown>;
  },
): { ok: boolean; reason?: string } {
  const type = spec.type.toLowerCase();
  if (type === 'file' || type === 'json') {
    const candidate = pickFileForOutput(spec.key, ctx);
    if (!candidate) {
      return { ok: false, reason: `未找到可验证的文件产物（key=${spec.key}）` };
    }
    if (!fs.existsSync(candidate)) {
      return { ok: false, reason: `文件不存在：${candidate}` };
    }
    if (type === 'json') {
      const parsed = parseJsonFile(candidate);
      if (!parsed.ok) return { ok: false, reason: parsed.reason ?? 'JSON 解析失败' };
      ctx.outputs[spec.key] = parsed.data;
      return { ok: true };
    }
    ctx.outputs[spec.key] = candidate;
    return { ok: true };
  }

  // string / 默认
  const summary = ctx.lastContent.trim();
  if (summary.length >= 8) {
    ctx.outputs[spec.key] = summary;
    return { ok: true };
  }
  if (ctx.evidence.filePaths.size > 0 || (ctx.evidence.lastShellOutput?.trim().length ?? 0) > 20) {
    ctx.outputs[spec.key] = summary || ctx.evidence.lastShellOutput?.slice(0, 2000) || '(evidence-only)';
    return { ok: true };
  }
  return { ok: false, reason: `缺少有效文本产出（key=${spec.key}）` };
}

function pickFileForOutput(
  key: string,
  ctx: { workDir: string; lastContent: string; evidence: NodeEvidence },
): string | null {
  const keyHint = key.replace(/[^a-zA-Z0-9._-]/g, '');
  for (const abs of ctx.evidence.filePaths) {
    if (keyHint && path.basename(abs).includes(keyHint)) return abs;
  }
  const fromContent = ctx.lastContent.match(
    new RegExp(`["']?([\\w./-]*${keyHint}[\\w./-]*\\.(?:json|csv|txt|log|md|mjs|js))["']?`, 'i'),
  );
  if (fromContent?.[1]) {
    const abs = resolveWorkPath(ctx.workDir, fromContent[1]);
    if (fs.existsSync(abs)) return abs;
  }
  const first = [...ctx.evidence.filePaths][0];
  return first ?? null;
}

export function validateNodeCompletion(opts: {
  node: LocalNode;
  inst: NodeInst;
  workDir: string;
  lastContent: string;
  executionLog: ExecutionEntry[];
}): NodeCompletionResult {
  const { node, inst, workDir, lastContent, executionLog } = opts;
  const acceptance: NodeAcceptance = inst.acceptance ?? {};
  const specs = node.interface.outputs;
  const evidence = gatherEvidence(workDir, executionLog);
  const outputs: Record<string, unknown> = {};
  const missing: string[] = [];

  if (specs.length === 0) {
    if (lastContent.trim().length > 0 || evidence.filePaths.size > 0) {
      outputs['result'] = lastContent.trim() || [...evidence.filePaths][0];
      return { status: 'ok', outputs, missing: [] };
    }
    return { status: 'failed', outputs: {}, missing: ['result'] };
  }

  const required =
    acceptance.minOutputs && acceptance.minOutputs.length > 0 && acceptance.requireAllOutputs === false
      ? specs.filter(s => acceptance.minOutputs!.includes(s.key))
      : specs;

  for (const spec of required) {
    const check = checkOutputSpec(spec, { workDir, lastContent, evidence, outputs });
    if (!check.ok) missing.push(`${spec.key}: ${check.reason ?? '未满足'}`);
  }

  if (missing.length > 0) {
    return { status: 'failed', outputs, missing };
  }
  return { status: 'ok', outputs, missing: [] };
}
