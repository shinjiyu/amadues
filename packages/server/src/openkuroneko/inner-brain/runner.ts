/**
 * Runner — RUN 阶段：解析 local_dag，按 NodeInst 顺序派发 baseNode / nodeCreator，
 * 把结果写入 memory（node_results / last_failure / last_pack_error）。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §5 §6 §8
 *
 * Runner 不做 LLM 决策；terminal failure 上交 Designer（写 memory.last_failure
 * 后停止本图剩余节点）。compound（graph body）inline 展开执行，共享父图 memory，
 * 按 exports 暴露顶层 key。
 */

import type { Logger } from '../logger/index.js';
import type { LLMAdapter } from '../adapter/index.js';
import type { ToolRegistry } from '../tools/index.js';
import { createToolRegistry } from '../tools/index.js';
import { createMemoryTools } from './memory-tools.js';
import {
  materializeWorkspaceScriptTools,
  createRegisterWorkspaceScriptToolTool,
} from './workspace-script-tools.js';
import { runBaseNode } from './base-node-executor.js';
import { runNodeCreator } from './node-creator-executor.js';
import type { AutoExportDeps } from './node-creator-executor.js';
import type { LocalNodeStore } from './local-node-store.js';
import type { MemoryStore } from './memory-store.js';
import type {
  FailureSummary,
  LocalDag,
  LocalNode,
  NodeInst,
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
  /** P1：creator commit 后自动导出到 drive9 */
  autoExport?: AutoExportDeps;
}

export interface RunnerResult {
  ok: boolean;
  completed: string[];
  failedAt?: string;
  results: NodeResult[];
}

interface DispatchOutcome {
  ok: boolean;
  outputs?: Record<string, unknown>;
  failure?: FailureSummary;
}

export function isCreatorNode(node: LocalNode): boolean {
  if (node.id === 'preset/node_creator') return true;
  if (node.tags?.includes('creator')) return true;
  return (
    node.body.kind === 'executor' &&
    node.body.tools.length === 1 &&
    node.body.tools[0] === 'commit_local_node'
  );
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

export async function runLocalDag(dag: LocalDag, deps: RunnerDeps): Promise<RunnerResult> {
  const { store, memory, logger } = deps;
  const completed: string[] = [];
  const results: NodeResult[] = [];

  logger.info('runner', { event: 'run.start', data: { burstId: dag.burstId, nodes: dag.nodes.length } });

  for (const inst of orderedNodes(dag)) {
    const node = store.read(inst.ref);
    if (!node) {
      const failure = missingRefFailure(inst);
      const nr: NodeResult = { nodeInstId: inst.id, ref: inst.ref, ok: false, failure, at: failure.at };
      memory.recordNodeResult(nr);
      results.push(nr);
      logger.warn('runner', { event: 'ref.missing', data: { nodeInstId: inst.id, ref: inst.ref } });
      return { ok: false, completed, failedAt: inst.id, results };
    }

    const outcome = await dispatchNode(inst, node, deps);
    const nr: NodeResult = {
      nodeInstId: inst.id,
      ref: node.id,
      ok: outcome.ok,
      ...(outcome.outputs ? { outputs: outcome.outputs } : {}),
      ...(outcome.failure ? { failure: outcome.failure } : {}),
      at: new Date().toISOString(),
    };
    memory.recordNodeResult(nr);
    results.push(nr);

    if (!outcome.ok) {
      logger.info('runner', { event: 'run.failed', data: { nodeInstId: inst.id, ref: node.id } });
      return { ok: false, completed, failedAt: inst.id, results };
    }
    completed.push(inst.id);
  }

  logger.info('runner', { event: 'run.done', data: { burstId: dag.burstId, completed: completed.length } });
  return { ok: true, completed, results };
}

async function dispatchNode(inst: NodeInst, node: LocalNode, deps: RunnerDeps): Promise<DispatchOutcome> {
  const { llm, toolRegistry, store, memory, logger, workDir } = deps;
  const memSnapshot = memory.read();

  if (isCreatorNode(node)) {
    const out = await runNodeCreator(
      { node, inst, memory: memSnapshot, workDir },
      { llm, logger, store, ...(deps.autoExport ? { autoExport: deps.autoExport } : {}) },
    );
    if (!out.ok && out.packError) memory.patch('last_pack_error', out.packError);
    return { ok: out.ok, ...(out.outputs ? { outputs: out.outputs } : {}), ...(out.failure ? { failure: out.failure } : {}) };
  }

  if (node.body.kind === 'graph') {
    return runGraph(inst, node, deps);
  }

  // baseNode 注入：memory 工具（固化事实）+ workspace 脚本工具（T0 已晋升能力）+ 注册工具
  // 顺序：核心工具 → ws_* 工具（前缀保证不覆盖核心）→ register 工具
  const augmented = createToolRegistry([
    ...toolRegistry.list(),
    ...createMemoryTools(memory),
    ...materializeWorkspaceScriptTools(workDir),
    createRegisterWorkspaceScriptToolTool(workDir),
  ]);
  const out = await runBaseNode(
    { node, inst, memory: memSnapshot, workDir },
    { llm, toolRegistry: augmented, logger },
  );
  return { ok: out.ok, ...(out.outputs ? { outputs: out.outputs } : {}), ...(out.failure ? { failure: out.failure } : {}) };
}

/** compound 节点：inline 展开子图，共享父图 memory，按 exports 暴露顶层 key */
async function runGraph(inst: NodeInst, node: LocalNode, deps: RunnerDeps): Promise<DispatchOutcome> {
  if (node.body.kind !== 'graph') throw new Error('runGraph called on non-graph node');
  const { store, memory, logger } = deps;
  const subResults: Record<string, NodeResult> = {};

  for (const child of node.body.nodes) {
    const childNode = store.read(child.ref);
    if (!childNode) {
      return { ok: false, failure: missingRefFailure(child) };
    }
    const outcome = await dispatchNode(child, childNode, deps);
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
