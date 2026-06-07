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
    description:
      '把一条稳定、可复用的环境事实写入全局 memory（同 topic 自动取代旧事实；全文相同仅 bump 引用）。事实应是客观、跨 burst 仍成立的陈述。',
    parameters: {
      fact: { type: 'string', description: '一条事实陈述' },
      topic: { type: 'string', description: '可选：合并主题键，覆盖自动推导' },
      confidence: {
        type: 'string',
        description: '可选：verified | hypothesis | obsolete（默认 hypothesis）',
      },
      tags: { type: 'string', description: '可选：逗号分隔标签，如 fanqie,api' },
    },
    required: ['fact'],
    async call(args) {
      const fact = String(args['fact'] ?? '').trim();
      if (!fact) return { ok: false, output: 'record_fact: fact 不能为空' };
      const confRaw = String(args['confidence'] ?? '').trim().toLowerCase();
      const confidence =
        confRaw === 'verified' || confRaw === 'hypothesis' || confRaw === 'obsolete'
          ? confRaw
          : undefined;
      const tagsRaw = String(args['tags'] ?? '').trim();
      const tags = tagsRaw ? tagsRaw.split(/[,;]/).map(t => t.trim()).filter(Boolean) : undefined;
      const topic = String(args['topic'] ?? '').trim() || undefined;
      const result = memory.recordFact({
        content: fact,
        topic,
        confidence,
        tags,
        source: { via: 'record_fact', at: new Date().toISOString() },
      });
      if (result.action === 'skipped') {
        return { ok: false, output: 'record_fact: fact 不能为空' };
      }
      return {
        ok: true,
        output: `recorded fact (${result.action}${result.record ? ` topic=${result.record.topic}` : ''})`,
      };
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
