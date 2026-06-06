/**
 * Memory Store — .brain/memory.json 全局 memory 读写
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §11 / INNER-NODE-LIFECYCLE.md §11
 *
 * 替代 legacy 的 .brain/knowledge.md / constraints.md / execution-context.json。
 * 承载 DyFlow 全局 memory：goal / constraints / facts / last_failure /
 * node_results / kpi_progress + 自由扩展键。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { DagHistoryEntry, FailureSummary, InnerMemory, LockedMilestone, NodeResult } from './types.js';

/** dag_history 环形上限（§6.8） */
const DAG_HISTORY_MAX = Number(process.env['INNER_DAG_HISTORY_MAX'] ?? 20) || 20;

export interface MemoryStore {
  read(): InnerMemory;
  /** 读顶层 key 或点路径（如 "node_results.n1"） */
  get(key: string): unknown;
  /** 写顶层 key（整值覆盖） */
  patch(key: string, value: unknown): void;
  /** 浅合并多个顶层 key */
  merge(partial: Partial<InnerMemory>): void;
  setLastFailure(failure: FailureSummary): void;
  clearLastFailure(): void;
  /** 写 node_results.<id>；失败时镜像写 last_failure */
  recordNodeResult(result: NodeResult): void;
  /** 归档一轮 RUN 的 DAG + 结果（环形，保留最近 DAG_HISTORY_MAX） */
  appendDagHistory(entry: DagHistoryEntry): void;
  /** 锁定一个已完成里程碑（按 id 去重，replace；§9c） */
  lockMilestone(milestone: LockedMilestone): void;
  appendFact(fact: string): void;
  appendConstraint(constraint: string): void;
  readonly filePath: string;
}

function defaultMemory(): InnerMemory {
  return { constraints: [], facts: [], node_results: {}, last_failure: null };
}

export function createMemoryStore(workDir: string): MemoryStore {
  const brainDir = path.join(workDir, '.brain');
  const filePath = path.join(brainDir, 'memory.json');

  function read(): InnerMemory {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<InnerMemory>;
      return {
        ...defaultMemory(),
        ...parsed,
        constraints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
        facts: Array.isArray(parsed.facts) ? parsed.facts : [],
        node_results:
          parsed.node_results && typeof parsed.node_results === 'object'
            ? parsed.node_results
            : {},
      };
    } catch {
      return defaultMemory();
    }
  }

  function write(mem: InnerMemory): void {
    fs.mkdirSync(brainDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(mem, null, 2), 'utf8');
  }

  return {
    filePath,
    read,

    get(key: string): unknown {
      const mem = read() as Record<string, unknown>;
      if (!key.includes('.')) return mem[key];
      let cur: unknown = mem;
      for (const seg of key.split('.')) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[seg];
      }
      return cur;
    },

    patch(key: string, value: unknown): void {
      const mem = read() as Record<string, unknown>;
      mem[key] = value;
      write(mem as InnerMemory);
    },

    merge(partial: Partial<InnerMemory>): void {
      write({ ...read(), ...partial });
    },

    setLastFailure(failure: FailureSummary): void {
      const mem = read();
      mem.last_failure = failure;
      write(mem);
    },

    clearLastFailure(): void {
      const mem = read();
      mem.last_failure = null;
      write(mem);
    },

    recordNodeResult(result: NodeResult): void {
      const mem = read();
      mem.node_results[result.nodeInstId] = result;
      if (!result.ok && result.failure) {
        mem.last_failure = result.failure;
      }
      write(mem);
    },

    appendDagHistory(entry: DagHistoryEntry): void {
      const mem = read();
      const history = Array.isArray(mem.dag_history) ? mem.dag_history : [];
      history.push(entry);
      mem.dag_history = history.slice(-DAG_HISTORY_MAX);
      write(mem);
    },

    lockMilestone(milestone: LockedMilestone): void {
      const mem = read();
      const existing = Array.isArray(mem.locked_milestones) ? mem.locked_milestones : [];
      mem.locked_milestones = [...existing.filter(m => m.id !== milestone.id), milestone];
      write(mem);
    },

    appendFact(fact: string): void {
      const mem = read();
      if (fact.trim() && !mem.facts.includes(fact)) {
        mem.facts.push(fact);
        write(mem);
      }
    },

    appendConstraint(constraint: string): void {
      const mem = read();
      if (constraint.trim() && !mem.constraints.includes(constraint)) {
        mem.constraints.push(constraint);
        write(mem);
      }
    },
  };
}
