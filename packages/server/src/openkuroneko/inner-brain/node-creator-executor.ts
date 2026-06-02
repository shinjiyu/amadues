/**
 * NodeCreator Executor — newNodeCreator 节点执行（pack / specialize）。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §7
 *
 * 复用 baseNode 的 ReAct loop，只是注入 commit_local_node 作为唯一工具。
 * 成功提交 → outputs.localNodeId；未提交（PACK_ABORT）→ failure +
 * memory.last_pack_error（由 runner 写 memory）。
 *
 * 修复（repair）不作为独立 mode：Designer 通过 NodeInst.instruction 写战术，
 * 必要时再让 Creator pack 成新版本（见 ADL §7）。
 */

import type { Logger } from '../logger/index.js';
import type { LLMAdapter } from '../adapter/index.js';
import { createToolRegistry } from '../tools/index.js';
import { runBaseNode } from './base-node-executor.js';
import type { BaseNodeOutcome } from './base-node-executor.js';
import { createCommitLocalNodeTool } from './commit-local-node-tool.js';
import { abstractLocalNode } from './node-abstractor.js';
import type { AbstractorResult, EnvSnapshot } from './node-abstractor.js';
import type { NodeDefDrive9Store } from '../../drive9/node-def-drive9-store.js';
import type { LocalNodeStore } from './local-node-store.js';
import type { InnerMemory, LocalNode, NodeInst } from './types.js';

/** P1：commit 成功后自动导出到 drive9（fire-and-forget） */
export interface AutoExportDeps {
  defStore: NodeDefDrive9Store;
  sourceAgent: string;
  env?: EnvSnapshot;
}

export interface NodeCreatorDeps {
  llm: LLMAdapter;
  logger: Logger;
  store: LocalNodeStore;
  /** 提供后，commit 成功的 creator 节点会自动脱敏导出到 drive9 */
  autoExport?: AutoExportDeps;
}

export interface NodeCreatorRunContext {
  /** preset/node_creator（或其特化版本） */
  node: LocalNode;
  inst: NodeInst;
  memory: InnerMemory;
  workDir: string;
}

export interface NodeCreatorOutcome extends BaseNodeOutcome {
  /** 成功提交的 LocalNode id */
  committedId?: string;
  /** 失败时的可读原因（runner 写 memory.last_pack_error） */
  packError?: string;
  /** P1：自动导出 promise（fire-and-forget；测试可 await） */
  exportPromise?: Promise<AbstractorResult>;
}

export async function runNodeCreator(
  ctx: NodeCreatorRunContext,
  deps: NodeCreatorDeps,
): Promise<NodeCreatorOutcome> {
  const { node, inst, memory, workDir } = ctx;
  const { llm, logger, store } = deps;

  const sourceNodeIds = Array.isArray(inst.params?.['source_node_ids'])
    ? (inst.params!['source_node_ids'] as unknown[]).map(String)
    : undefined;
  const fromBurst = typeof inst.params?.['fromBurst'] === 'string' ? (inst.params!['fromBurst'] as string) : undefined;

  const commitTool = createCommitLocalNodeTool(store, {
    ...(sourceNodeIds ? { sourceNodeIds } : {}),
    ...(fromBurst ? { fromBurst } : {}),
  });
  const registry = createToolRegistry([commitTool]);

  const outcome = await runBaseNode(
    { node, inst, memory, workDir },
    { llm, toolRegistry: registry, logger },
  );

  const committedId = commitTool.committedIds[commitTool.committedIds.length - 1];

  if (committedId) {
    logger.info('node-creator', { event: 'packed', data: { nodeInstId: inst.id, localNodeId: committedId } });

    // P1：fire-and-forget 自动导出（脱敏 → drive9）。失败不影响 creator 成功。
    let exportPromise: Promise<AbstractorResult> | undefined;
    if (deps.autoExport) {
      const committed = store.read(committedId);
      if (committed) {
        exportPromise = abstractLocalNode(
          committed,
          { llm, logger, store: deps.autoExport.defStore },
          { sourceAgent: deps.autoExport.sourceAgent, ...(deps.autoExport.env ? { env: deps.autoExport.env } : {}) },
        ).catch((e): AbstractorResult => {
          logger.warn('node-creator', { event: 'auto_export.error', data: { localNodeId: committedId, error: String(e) } });
          return { ok: false, reason: String(e) };
        });
      }
    }

    return {
      ...outcome,
      ok: true,
      outputs: { localNodeId: committedId },
      committedId,
      ...(exportPromise ? { exportPromise } : {}),
    };
  }

  // 没有提交任何节点 → 视作打包失败
  const packError =
    outcome.failure?.summary || `newNodeCreator 未提交任何 LocalNode（content: ${outcome.lastContent.slice(0, 200)}）`;
  logger.warn('node-creator', { event: 'pack_abort', data: { nodeInstId: inst.id, packError } });
  return {
    ...outcome,
    ok: false,
    packError,
    failure:
      outcome.failure ?? {
        nodeInstId: inst.id,
        localRef: node.id,
        summary: packError,
        attempted: ['commit_local_node'],
        confidence: 'high',
        transient: false,
        at: new Date().toISOString(),
      },
  };
}
