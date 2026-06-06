/**
 * 节点级交付物机械验票引擎（DYFLOW-INNER-EXECUTOR.md §6.7a）。
 *
 * 被两处复用：
 *   - node-acceptance.ts：校验 NodeInst.deliverable（节点完成验票）
 *   - designer-tools.ts report_done：目标级闸门 verify（§9a）
 *
 * 设计：纯函数 + 文件系统读，无 LLM、无网络。stdout 由调用方聚合传入。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { DeliverableCheck } from './types.js';

export interface DeliverableCheckResult {
  check: DeliverableCheck;
  ok: boolean;
  reason?: string;
}

export interface DeliverableCheckReport {
  ok: boolean;
  results: DeliverableCheckResult[];
  /** 失败 check 的人类可读描述（describe || kind:target） */
  missing: string[];
}

/** 解析 workDir 相对路径，拒绝越界（.. / 绝对路径指向 workDir 外） */
function resolveInside(workDir: string, rel: string): string | null {
  const root = path.resolve(workDir);
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function label(check: DeliverableCheck): string {
  return check.describe?.trim() || `${check.kind}:${check.target}`;
}

/** 点路径取值：'a.b.c' / 'items.0.id'；任意层缺失返回 undefined */
function getByPath(data: unknown, dotPath: string): unknown {
  const keys = dotPath.split('.').map(k => k.trim()).filter(Boolean);
  let cur: unknown = data;
  for (const k of keys) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(k);
      if (!Number.isInteger(idx)) return undefined;
      cur = cur[idx];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return undefined;
    }
  }
  return cur;
}

function isNonEmpty(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function checkFile(workDir: string, target: string): DeliverableCheckResult['reason'] | null {
  const abs = resolveInside(workDir, target);
  if (!abs) return `路径越界：${target}`;
  if (!fs.existsSync(abs)) return `文件不存在：${target}`;
  const st = fs.statSync(abs);
  if (!st.isFile()) return `不是文件：${target}`;
  if (st.size <= 0) return `文件为空：${target}`;
  return null;
}

function checkJsonKey(workDir: string, target: string): string | null {
  const hashIdx = target.indexOf('#');
  if (hashIdx < 0) return `json_key 缺少 "#keyPath"：${target}`;
  const rel = target.slice(0, hashIdx).trim();
  const dotPath = target.slice(hashIdx + 1).trim();
  if (!rel || !dotPath) return `json_key 格式应为 "rel.json#a.b.c"：${target}`;
  const fileErr = checkFile(workDir, rel);
  if (fileErr) return fileErr;
  const abs = resolveInside(workDir, rel)!;
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (e) {
    return `JSON 解析失败（${rel}）：${String(e)}`;
  }
  const value = getByPath(data, dotPath);
  if (!isNonEmpty(value)) return `JSON 键缺失或为空：${rel}#${dotPath}`;
  return null;
}

/** 单条 check */
export function runDeliverableCheck(
  workDir: string,
  check: DeliverableCheck,
  stdout: string,
): DeliverableCheckResult {
  const fail = (reason: string): DeliverableCheckResult => ({ check, ok: false, reason });
  const pass = (): DeliverableCheckResult => ({ check, ok: true });
  const target = (check.target ?? '').trim();
  if (!target) return fail(`${check.kind}: target 为空`);

  switch (check.kind) {
    case 'file': {
      const err = checkFile(workDir, target);
      return err ? fail(err) : pass();
    }
    case 'json_key': {
      const err = checkJsonKey(workDir, target);
      return err ? fail(err) : pass();
    }
    case 'stdout_contains':
      return stdout.includes(target) ? pass() : fail(`stdout 未包含「${target}」`);
    case 'stdout_absent':
      return stdout.includes(target) ? fail(`stdout 含失败信号「${target}」`) : pass();
    default:
      return fail(`未知 check.kind：${String((check as DeliverableCheck).kind)}`);
  }
}

/** 一组 check：全部通过才 ok */
export function runDeliverableChecks(
  workDir: string,
  checks: DeliverableCheck[],
  stdout = '',
): DeliverableCheckReport {
  const results = checks.map(c => runDeliverableCheck(workDir, c, stdout));
  const missing = results.filter(r => !r.ok).map(r => `${label(r.check)} — ${r.reason ?? '未通过'}`);
  return { ok: missing.length === 0, results, missing };
}
