/**
 * Memory Store — .brain/memory.json 全局 memory 读写
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §11 / INNER-NODE-LIFECYCLE.md §11
 * 事实治理：doc/structurizr/FACTS-KNOWLEDGE-GOVERNANCE.md
 *
 * 替代 legacy 的 .brain/knowledge.md / constraints.md / execution-context.json。
 * 承载 DyFlow 全局 memory：goal / constraints / facts / fact_records / last_failure /
 * node_results / kpi_progress + 自由扩展键。
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  compactFactRecords,
  migrateLegacyFacts,
  recordFactGoverned,
  sweepFacts,
  syncLegacyFactsArray,
  type RecordFactInput,
  type RecordFactResult,
  type SweepFactsResult,
} from './fact-governor.js';
import {
  recordConstraintGoverned,
  sweepConstraints,
  type SweepConstraintsResult,
} from './constraint-governor.js';
import type {
  DagHistoryEntry,
  FactRecord,
  FailureSummary,
  InnerMemory,
  LockedMilestone,
  NodeResult,
} from './types.js';

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
  /** @deprecated 请用 recordFact；保留兼容 record_fact 工具 */
  appendFact(fact: string): void;
  /** 治理写入：topic 合并 + hash 去重 */
  recordFact(input: RecordFactInput): RecordFactResult;
  /** ATTRIBUTE 后 quota + cold 淘汰 */
  sweepFacts(): SweepFactsResult;
  /** ATTRIBUTE 后 constraint topic 去重 + 总量截断 */
  sweepConstraints(): SweepConstraintsResult;
  appendConstraint(constraint: string): void;
  readonly filePath: string;
}

function defaultMemory(): InnerMemory {
  return { constraints: [], facts: [], fact_records: [], node_results: {}, last_failure: null };
}

function ensureFactRecords(mem: InnerMemory): InnerMemory {
  let records = Array.isArray(mem.fact_records) ? [...mem.fact_records] : [];
  if (records.length === 0 && mem.facts.length > 0) {
    records = migrateLegacyFacts(mem.facts);
  }
  const facts = syncLegacyFactsArray(records);
  return { ...mem, fact_records: records, facts };
}

export interface CreateMemoryStoreOptions {
  /** 事实写入 memory 后回调（供外脑同步 drive9，不 import drive9） */
  onFactRecorded?: (record: FactRecord, result: RecordFactResult) => void;
}

export function createMemoryStore(workDir: string, opts?: CreateMemoryStoreOptions): MemoryStore {
  const brainDir = path.join(workDir, '.brain');
  const filePath = path.join(brainDir, 'memory.json');

  function read(): InnerMemory {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<InnerMemory>;
      const base: InnerMemory = {
        ...defaultMemory(),
        ...parsed,
        constraints: Array.isArray(parsed.constraints) ? parsed.constraints : [],
        facts: Array.isArray(parsed.facts) ? parsed.facts : [],
        fact_records: Array.isArray(parsed.fact_records) ? parsed.fact_records : [],
        node_results:
          parsed.node_results && typeof parsed.node_results === 'object'
            ? parsed.node_results
            : {},
      };
      return ensureFactRecords(base);
    } catch {
      return defaultMemory();
    }
  }

  function write(mem: InnerMemory): void {
    const synced = ensureFactRecords(mem);
    fs.mkdirSync(brainDir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(synced, null, 2), 'utf8');
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

    recordFact(input: RecordFactInput): RecordFactResult {
      const mem = read();
      const records = Array.isArray(mem.fact_records) ? [...mem.fact_records] : [];
      const result = recordFactGoverned(records, input);
      mem.fact_records = result.records;
      mem.facts = syncLegacyFactsArray(result.records);
      write(mem);
      if (result.record && result.action !== 'skipped') {
        opts?.onFactRecorded?.(result.record, result);
      }
      return result;
    },

    sweepFacts(): SweepFactsResult {
      const mem = read();
      const records = Array.isArray(mem.fact_records) ? [...mem.fact_records] : [];
      const { records: swept, result } = sweepFacts(records);
      const compacted = compactFactRecords(swept);
      mem.fact_records = compacted;
      mem.facts = syncLegacyFactsArray(compacted);
      mem.fact_conflicts = result.conflicts.length > 0 ? result.conflicts : undefined;
      write(mem);
      return result;
    },

    sweepConstraints(): SweepConstraintsResult {
      const mem = read();
      const { constraints, result } = sweepConstraints(mem.constraints);
      mem.constraints = constraints;
      write(mem);
      return result;
    },

    appendFact(fact: string): void {
      this.recordFact({ content: fact, source: { via: 'record_fact', at: new Date().toISOString() } });
    },

    appendConstraint(constraint: string): void {
      const mem = read();
      const result = recordConstraintGoverned(mem.constraints, constraint);
      mem.constraints = result.constraints;
      write(mem);
    },
  };
}
