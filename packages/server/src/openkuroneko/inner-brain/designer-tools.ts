/**
 * Designer Tool Registry — DESIGN 阶段专用工具集（与 baseNode tools 隔离）。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §9
 *
 * P0 工具：
 *   list_local_nodes / read_local_node / read_memory / commit_local_dag / report_done
 * P1：search_and_instance（drive9 → Assembler）。
 *
 * 工具调用结果汇总到 DesignSession，供 designer driver 判定 DESIGN 终态。
 */

import type { LLMAdapter } from '../adapter/index.js';
import type { Logger } from '../logger/index.js';
import type { Tool, ToolRegistry } from '../tools/index.js';
import { createToolRegistry } from '../tools/index.js';
import type { NodeDefDrive9Store } from '../../drive9/node-def-drive9-store.js';
import type { LocalNodeStore } from './local-node-store.js';
import type { MemoryStore } from './memory-store.js';
import { assembleNodeDef } from './node-assembler.js';
import type { EnvSnapshot } from './node-abstractor.js';
import { writeLocalDag } from './local-dag-store.js';
import type { LocalDag, NodeInst } from './types.js';

export interface DesignSession {
  /** Designer 提交的图（commit_local_dag） */
  committedDag?: LocalDag;
  /** Designer 自报完成（report_done） */
  doneReason?: string;
}

/** P1：节点共享（drive9）注入；缺省时不注册 search_and_instance */
export interface NodeSharingDeps {
  defStore: NodeDefDrive9Store;
  llm: LLMAdapter;
  logger: Logger;
  env?: EnvSnapshot;
}

export interface DesignerToolDeps {
  store: LocalNodeStore;
  memory: MemoryStore;
  workDir: string;
  burstId: string;
  /** P1：提供后 Designer 多一个 search_and_instance 工具 */
  sharing?: NodeSharingDeps;
}

export interface DesignerTools {
  registry: ToolRegistry;
  session: DesignSession;
}

function normalizeNodeInst(raw: unknown, idx: number): NodeInst | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const ref = typeof o['ref'] === 'string' ? o['ref'] : '';
  if (!ref) return null;
  const id = typeof o['id'] === 'string' && o['id'].trim() ? o['id'] : `n${idx + 1}`;
  const inst: NodeInst = { id, ref };
  if (typeof o['instruction'] === 'string') inst.instruction = o['instruction'];
  if (o['params'] && typeof o['params'] === 'object') inst.params = o['params'] as Record<string, unknown>;
  if (Array.isArray(o['memoryIn'])) inst.memoryIn = (o['memoryIn'] as unknown[]).map(String);
  if (Array.isArray(o['memoryOut'])) inst.memoryOut = (o['memoryOut'] as unknown[]).map(String);
  return inst;
}

export function createDesignerTools(deps: DesignerToolDeps): DesignerTools {
  const { store, memory, workDir, burstId, sharing } = deps;
  const session: DesignSession = {};

  const listTool: Tool = {
    name: 'list_local_nodes',
    description: '列出本工作区所有可用 LocalNode 的摘要（id / description / tags / kind），用于编排时选用。',
    async call() {
      return { ok: true, output: JSON.stringify(store.list(), null, 2) };
    },
  };

  const readNodeTool: Tool = {
    name: 'read_local_node',
    description: '读取单个 LocalNode 的完整定义（含 interface / body）。',
    parameters: { id: { type: 'string', description: 'LocalNode id' } },
    required: ['id'],
    async call(args) {
      const node = store.read(String(args['id'] ?? ''));
      if (!node) return { ok: false, output: `LocalNode ${String(args['id'])} 不存在` };
      return { ok: true, output: JSON.stringify(node, null, 2) };
    },
  };

  const readMemoryTool: Tool = {
    name: 'read_memory',
    description: '读取全局 memory。不传 key 返回全部；传 key 返回单值（支持点路径，如 node_results.n1）。',
    parameters: { key: { type: 'string', description: '可选 memory key / 点路径' } },
    async call(args) {
      const key = args['key'];
      if (typeof key === 'string' && key.trim()) {
        return { ok: true, output: JSON.stringify(memory.get(key) ?? null, null, 2) };
      }
      return { ok: true, output: JSON.stringify(memory.read(), null, 2) };
    },
  };

  const commitDagTool: Tool = {
    name: 'commit_local_dag',
    description:
      '提交本轮执行图：nodes 是 NodeInst 数组，每个 {id, ref(LocalNode id), instruction?(本轮子目标), params?}。提交后进入 RUN 阶段。',
    parameters: {
      nodes: { type: 'array', description: 'NodeInst 数组：[{id, ref, instruction?, params?}]' },
      notes: { type: 'string', description: '可选：设计备注' },
    },
    required: ['nodes'],
    async call(args) {
      const rawNodes = Array.isArray(args['nodes']) ? (args['nodes'] as unknown[]) : [];
      const nodes = rawNodes.map((n, i) => normalizeNodeInst(n, i)).filter((n): n is NodeInst => n !== null);
      if (nodes.length === 0) return { ok: false, output: 'commit_local_dag: nodes 为空或全部缺少 ref' };
      // 校验 ref 存在
      const missing = nodes.filter(n => !store.has(n.ref)).map(n => n.ref);
      if (missing.length > 0) {
        return { ok: false, output: `以下 ref 不存在，请先用 list_local_nodes 确认或改用 preset/base：${[...new Set(missing)].join(', ')}` };
      }
      const dag: LocalDag = {
        burstId,
        designedAt: new Date().toISOString(),
        nodes,
        ...(typeof args['notes'] === 'string' ? { notes: args['notes'] } : {}),
      };
      writeLocalDag(workDir, dag);
      session.committedDag = dag;
      return { ok: true, output: `local_dag committed with ${nodes.length} node(s)` };
    },
  };

  const reportDoneTool: Tool = {
    name: 'report_done',
    description: '当全局目标已经达成、无需再编排任何节点时调用，结束本 burst。',
    parameters: { reason: { type: 'string', description: '完成理由（可选）' } },
    async call(args) {
      session.doneReason = typeof args['reason'] === 'string' ? args['reason'] : '目标已完成';
      return { ok: true, output: 'marked done' };
    },
  };

  const tools: Tool[] = [listTool, readNodeTool, readMemoryTool, commitDagTool, reportDoneTool];

  if (sharing) {
    const searchTool: Tool = {
      name: 'search_and_instance',
      description:
        '在共享节点库（drive9）按语义检索 NodeDef，并批量装配成本地可用 LocalNode。返回成功装配的 localId，可直接作为 commit_local_dag 里 NodeInst.ref 使用。',
      parameters: {
        query: { type: 'string', description: '检索语义（描述你需要的能力）' },
        topK: { type: 'number', description: '返回上限（默认 20）' },
        filterTags: { type: 'array', description: '限定标签（字符串数组）' },
        bindingHints: { type: 'object', description: '账号/路径等绑定线索（可选）' },
      },
      required: ['query'],
      async call(args) {
        const query = String(args['query'] ?? '').trim();
        if (!query) return { ok: false, output: 'search_and_instance: query 必填' };
        const topK = typeof args['topK'] === 'number' ? (args['topK'] as number) : undefined;
        const filterTags = Array.isArray(args['filterTags']) ? (args['filterTags'] as unknown[]).map(String) : undefined;
        const bindingHints =
          args['bindingHints'] && typeof args['bindingHints'] === 'object'
            ? (args['bindingHints'] as Record<string, string>)
            : undefined;

        const defs = await sharing.defStore.search(query, {
          ...(topK ? { topK } : {}),
          ...(filterTags ? { filterTags } : {}),
        });
        const instanced: { localId: string; defId: string; version: string }[] = [];
        const failed: { defId: string; reason: string }[] = [];
        for (const def of defs) {
          const r = await assembleNodeDef(
            def,
            workDir,
            { llm: sharing.llm, logger: sharing.logger, defStore: sharing.defStore, localStore: store },
            { ...(sharing.env ? { env: sharing.env } : {}), ...(bindingHints ? { bindingHints } : {}) },
          );
          if (r.ok && r.localId) instanced.push({ localId: r.localId, defId: def.id, version: def.version });
          else failed.push({ defId: def.id, reason: r.reason ?? 'unknown' });
        }
        return { ok: true, output: JSON.stringify({ instanced, failed }, null, 2) };
      },
    };
    tools.push(searchTool);
  }

  const registry = createToolRegistry(tools);
  return { registry, session };
}
