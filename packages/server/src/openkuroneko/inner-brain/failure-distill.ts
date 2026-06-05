/**
 * FailureDistill — RUN 失败后、进 DESIGN 前，把失败蒸馏为 memory.constraints。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §7c
 */

import type { MemoryStore } from './memory-store.js';
import type { FailureSummary, NodeResult } from './types.js';

export function distillRunFailures(opts: {
  results: NodeResult[];
  lastFailure?: FailureSummary | null;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  function add(line: string): void {
    const t = line.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  }

  for (const r of opts.results) {
    if (r.ok) continue;
    const summary = r.failure?.summary ?? '未知失败';
    add(
      `[run-failure] 节点 ${r.nodeInstId}（${r.ref}）：${summary}；禁止同 instruction 裸重试`,
    );
    if (/安全轮次|safety_cap|safety cap/i.test(summary) || r.status === 'capped') {
      add(
        `[run-failure] ref ${r.ref} 已达 safety_cap，下轮须换 ref、API 路径或拆分节点`,
      );
    }
  }

  const lf = opts.lastFailure;
  if (lf) {
    const blob = `${lf.summary} ${lf.rawTail ?? ''} ${lf.attempted.join(' ')}`;
    if (/404|not found|Not Found/i.test(blob)) {
      add(
        '[run-failure] HTTP/API 404 不得视为 shell 成功；须核对端点路径、鉴权与 curl -L',
      );
    }
  }

  return out;
}

/** 写入 memory.constraints（去重）；返回新增条数 */
export function applyFailureDistill(memory: MemoryStore, constraints: string[]): number {
  let added = 0;
  for (const c of constraints) {
    const before = memory.read().constraints.length;
    memory.appendConstraint(c);
    if (memory.read().constraints.length > before) added += 1;
  }
  return added;
}
