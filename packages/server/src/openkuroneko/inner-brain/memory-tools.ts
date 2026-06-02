/**
 * Memory 工具 — 让 baseNode 把发现的事实/约束写回全局 memory。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §11 / INNER-NODE-LIFECYCLE.md §5（extract_facts）
 *
 * 由 runner 在派发 baseNode 时注入（合并进 allowlist 过滤前的工具集）。
 * preset/extract_facts 用 record_fact 持久化环境事实。
 */

import type { Tool } from '../tools/index.js';
import type { MemoryStore } from './memory-store.js';

export function createRecordFactTool(memory: MemoryStore): Tool {
  return {
    name: 'record_fact',
    description: '把一条稳定、可复用的环境事实写入全局 memory.facts（去重）。事实应是客观、跨 burst 仍成立的陈述。',
    parameters: { fact: { type: 'string', description: '一条事实陈述' } },
    required: ['fact'],
    async call(args) {
      const fact = String(args['fact'] ?? '').trim();
      if (!fact) return { ok: false, output: 'record_fact: fact 不能为空' };
      memory.appendFact(fact);
      return { ok: true, output: `recorded fact` };
    },
  };
}

export function createRecordConstraintTool(memory: MemoryStore): Tool {
  return {
    name: 'record_constraint',
    description: '把一条必须长期遵守的红线/约束写入全局 memory.constraints（去重）。',
    parameters: { constraint: { type: 'string', description: '一条约束/红线' } },
    required: ['constraint'],
    async call(args) {
      const constraint = String(args['constraint'] ?? '').trim();
      if (!constraint) return { ok: false, output: 'record_constraint: constraint 不能为空' };
      memory.appendConstraint(constraint);
      return { ok: true, output: `recorded constraint` };
    },
  };
}

/** baseNode 通用 memory 工具集合 */
export function createMemoryTools(memory: MemoryStore): Tool[] {
  return [createRecordFactTool(memory), createRecordConstraintTool(memory)];
}
