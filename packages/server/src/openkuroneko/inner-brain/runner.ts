/**
 * Runner — RUN 阶段：解析 local_dag，按 NodeInst 顺序派发 baseNode / graph，
 * 把结果写入 memory（node_results / last_failure）。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §5 §6 §8
 *
 * Runner 不做 LLM 决策；terminal failure 上交 Designer（写 memory.last_failure
 * 后停止本图剩余节点）。compound（graph body）inline 展开执行，共享父图 memory，
 * 按 exports 暴露顶层 key。
 */

import type { ExecutionEntry } from '../brain/index.js';
import type { SkillProvider } from '../skills/provider.js';
import { loadNodeSkills } from './node-skill-loader.js';
import type { Logger } from '../logger/index.js';
import type { LLMAdapter } from '../adapter/index.js';
import type { ToolRegistry } from '../tools/index.js';
import { createToolRegistry } from '../tools/index.js';
import { createKeychainTools } from './keychain-tools.js';
import { createMemoryTools } from './memory-tools.js';
import { runBaseNode } from './base-node-executor.js';
import type { LocalNodeStore } from './local-node-store.js';
import type { MemoryStore } from './memory-store.js';
import type {
  FailureSummary,
  LocalDag,
  LocalNode,
  NodeInst,
  NodeOutcomeStatus,
  NodeResult,
} from './types.js';

export interface RunnerDeps {
  llm: LLMAdapter;
  /** baseNode 可用的全套工具 */
  toolRegistry: ToolRegistry;
  store: LocalNodeStore;
  memory: MemoryStore;
  logger: Logger;
  workDir: string;
  /** 可选：全局技能检索（与节点绑定技能合并加载） */
  skillProvider?: SkillProvider;
}

export interface NodeExecutionRecord {
  nodeInstId: string;
  ref: string;
  ok: boolean;
  status?: NodeOutcomeStatus;
  executionLog: ExecutionEntry[];
  failureSummary?: string;
  rawTail?: string;
}

export interface RunnerResult {
  ok: boolean;
  completed: string[];
  failedAt?: string;
  results: NodeResult[];
  executionRecords: NodeExecutionRecord[];
}

interface DispatchOutcome {
  ok: boolean;
  status?: NodeOutcomeStatus;
  outputs?: Record<string, unknown>;
  failure?: FailureSummary;
  executionLog?: ExecutionEntry[];
}

function orderedNodes(dag: LocalDag): NodeInst[] {
  // P0：按 nodes[] 顺序串行（忽略 edges）；entry 若指定则提前
  if (dag.entry) {
    const entryIdx = dag.nodes.findIndex(n => n.id === dag.entry);
    if (entryIdx > 0) {
      return [dag.nodes[entryIdx]!, ...dag.nodes.filter((_, i) => i !== entryIdx)];
    }
  }
  return dag.nodes;
}

function missingRefFailure(inst: NodeInst): FailureSummary {
  return {
    nodeInstId: inst.id,
    localRef: inst.ref,
    summary: `LocalNode ref "${inst.ref}" 不存在（可能未 seed / 未 import）`,
    attempted: [],
    confidence: 'high',
    transient: false,
    at: new Date().toISOString(),
  };
}

function toExecutionRecord(
  inst: NodeInst,
  ref: string,
  outcome: DispatchOutcome,
  ok: boolean,
  status?: NodeOutcomeStatus,
): NodeExecutionRecord {
  return {
    nodeInstId: inst.id,
    ref,
    ok,
    ...(status ? { status } : {}),
    executionLog: outcome.executionLog ?? [],
    ...(outcome.failure?.summary ? { failureSummary: outcome.failure.summary } : {}),
    ...(outcome.failure?.rawTail ? { rawTail: outcome.failure.rawTail } : {}),
  };
}

export async function runLocalDag(dag: LocalDag, deps: RunnerDeps): Promise<RunnerResult> {
  const { store, memory, logger } = deps;
  const completed: string[] = [];
  const results: NodeResult[] = [];
  const executionRecords: NodeExecutionRecord[] = [];

  logger.info('runner', { event: 'run.start', data: { burstId: dag.burstId, nodes: dag.nodes.length } });

  for (const inst of orderedNodes(dag)) {
    const node = store.read(inst.ref);
    if (!node) {
      const failure = missingRefFailure(inst);
      const nr: NodeResult = { nodeInstId: inst.id, ref: inst.ref, ok: false, failure, at: failure.at };
      memory.recordNodeResult(nr);
      results.push(nr);
      executionRecords.push({
        nodeInstId: inst.id,
        ref: inst.ref,
        ok: false,
        status: 'failed',
        executionLog: [],
        failureSummary: failure.summary,
      });
      logger.warn('runner', { event: 'ref.missing', data: { nodeInstId: inst.id, ref: inst.ref } });
      return { ok: false, completed, failedAt: inst.id, results, executionRecords };
    }

    const outcome = await dispatchNode(inst, node, deps, dag.burstId);
    const status: NodeOutcomeStatus | undefined = outcome.ok ? 'ok' : (outcome.status ?? 'failed');
    const nr: NodeResult = {
      nodeInstId: inst.id,
      ref: node.id,
      ok: outcome.ok,
      status,
      ...(outcome.outputs ? { outputs: outcome.outputs } : {}),
      ...(outcome.failure ? { failure: outcome.failure } : {}),
      at: new Date().toISOString(),
    };
    memory.recordNodeResult(nr);
    results.push(nr);
    executionRecords.push(toExecutionRecord(inst, node.id, outcome, outcome.ok, status));

    if (!outcome.ok) {
      logger.info('runner', { event: 'run.failed', data: { nodeInstId: inst.id, ref: node.id } });
      return { ok: false, completed, failedAt: inst.id, results, executionRecords };
    }
    completed.push(inst.id);
  }

  logger.info('runner', { event: 'run.done', data: { burstId: dag.burstId, completed: completed.length } });
  return { ok: true, completed, results, executionRecords };
}

async function dispatchNode(
  inst: NodeInst,
  node: LocalNode,
  deps: RunnerDeps,
  burstId?: string,
): Promise<DispatchOutcome> {
  const { llm, toolRegistry, store, memory, logger, workDir, skillProvider } = deps;
  const memSnapshot = memory.read();

  if (node.body.kind === 'graph') {
    return runGraph(inst, node, deps, burstId);
  }

  const loaded = await loadNodeSkills({
    node,
    inst,
    workDir,
    ...(skillProvider ? { skillProvider } : {}),
  });
  if (loaded.refs.length > 0) {
    logger.info('runner', {
      event: 'skills.loaded',
      data: { nodeInstId: inst.id, ref: node.id, count: loaded.refs.length },
    });
  }

  // baseNode 注入：核心工具 + memory 工具（固化事实）+ keychain 工具
  // 稳定脚本不再造工具（T0 已移除）：用 record_fact 记路径，下次 shell_exec 直接跑
  const augmented = createToolRegistry([
    ...toolRegistry.list(),
    ...createMemoryTools(memory),
    ...createKeychainTools(),
  ]);
  const out = await runBaseNode(
    {
      node,
      inst,
      memory: memSnapshot,
      workDir,
      ...(burstId ? { burstId } : {}),
      ...(loaded.section ? { skillsSection: loaded.section } : {}),
    },
    { llm, toolRegistry: augmented, logger },
  );
  return {
    ok: out.ok,
    ...(out.status ? { status: out.status } : {}),
    ...(out.outputs ? { outputs: out.outputs } : {}),
    ...(out.failure ? { failure: out.failure } : {}),
    executionLog: out.executionLog,
  };
}

/** compound 节点：inline 展开子图，共享父图 memory，按 exports 暴露顶层 key */
async function runGraph(
  inst: NodeInst,
  node: LocalNode,
  deps: RunnerDeps,
  burstId?: string,
): Promise<DispatchOutcome> {
  if (node.body.kind !== 'graph') throw new Error('runGraph called on non-graph node');
  const { store, memory, logger } = deps;
  const subResults: Record<string, NodeResult> = {};

  for (const child of node.body.nodes) {
    const childNode = store.read(child.ref);
    if (!childNode) {
      return { ok: false, failure: missingRefFailure(child) };
    }
    const outcome = await dispatchNode(child, childNode, deps, burstId);
    const nr: NodeResult = {
      nodeInstId: `${inst.id}.${child.id}`,
      ref: childNode.id,
      ok: outcome.ok,
      ...(outcome.outputs ? { outputs: outcome.outputs } : {}),
      ...(outcome.failure ? { failure: outcome.failure } : {}),
      at: new Date().toISOString(),
    };
    memory.recordNodeResult(nr);
    subResults[child.id] = nr;
    if (!outcome.ok) {
      logger.info('runner', { event: 'graph.child.failed', data: { parent: inst.id, child: child.id } });
      return { ok: false, ...(outcome.failure ? { failure: outcome.failure } : {}) };
    }
  }

  // 按 exports 把子图产出提到顶层 memory + 作为本节点 outputs
  const outputs: Record<string, unknown> = {};
  for (const exp of node.body.exports) {
    const [childId, outputKey] = exp.from.split('.');
    const value = childId && outputKey ? subResults[childId]?.outputs?.[outputKey] : undefined;
    memory.patch(exp.as, value);
    outputs[exp.as] = value;
  }
  return { ok: true, outputs };
}
