/**
 * commit_local_node 工具 — newNodeCreator 的唯一工具。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §7 / INNER-NODE-LIFECYCLE.md §2
 *
 * LLM 用扁平字段描述一个 executor LocalNode；工具组装成完整 LocalNode 并
 * 写入 store（强制 origin=creator）。返回提交的 id，供 creator 自身的
 * outputs.localNodeId 使用。
 */

import type { Tool } from '../tools/index.js';
import type { LocalNodeStore } from './local-node-store.js';
import type {
  LocalNode,
  NodeInputSpec,
  NodeOutputSpec,
} from './types.js';

export interface CommitLocalNodeTool extends Tool {
  /** 已成功提交的 LocalNode id（最后一个） */
  readonly committedIds: string[];
}

export interface CommitToolOptions {
  /** 打包来源（provenance） */
  sourceNodeIds?: string[];
  fromBurst?: string;
}

function asSpecArray(v: unknown, fallbackType: string): NodeInputSpec[] | NodeOutputSpec[] {
  if (!Array.isArray(v)) return [];
  return v
    .map(item => {
      if (typeof item === 'string') return { key: item, type: fallbackType };
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        if (typeof o['key'] === 'string') {
          return { key: o['key'], type: typeof o['type'] === 'string' ? (o['type'] as string) : fallbackType };
        }
      }
      return null;
    })
    .filter((x): x is { key: string; type: string } => x !== null);
}

export function createCommitLocalNodeTool(
  store: LocalNodeStore,
  opts: CommitToolOptions = {},
): CommitLocalNodeTool {
  const committedIds: string[] = [];

  const tool: CommitLocalNodeTool = {
    name: 'commit_local_node',
    description:
      '把一段已跑通的战术固化成可复用的 LocalNode（executor 类型）。提供 id（语义名，自动加 local/ 前缀）、description、promptTemplate（含完整操作步骤）、tools（工具 allowlist）、outputs（产出契约）。',
    parameters: {
      id: { type: 'string', description: '语义名，如 ps_open_battle；自动加 local/ 前缀' },
      displayName: { type: 'string', description: '人类可读名' },
      description: { type: 'string', description: '一句话说明这个节点做什么，供 Designer 选用' },
      tags: { type: 'array', description: '检索标签（字符串数组）' },
      promptTemplate: { type: 'string', description: 'baseNode system prompt：固化的操作步骤，可含 ${{ params.x }} 占位' },
      tools: { type: 'array', description: '工具 allowlist（字符串数组）；用 ["*"] 表示全部' },
      inputs: { type: 'array', description: 'inputs 契约：[{key,type}]' },
      outputs: { type: 'array', description: 'outputs 契约：[{key,type}]，baseNode 必须产出' },
    },
    required: ['id', 'description', 'promptTemplate', 'tools'],

    get committedIds() {
      return committedIds;
    },

    async call(args: Record<string, unknown>) {
      try {
        const rawId = String(args['id'] ?? '').trim();
        if (!rawId) return { ok: false, output: 'commit_local_node: id 必填' };
        const id = rawId.includes('/') ? rawId : `local/${rawId}`;

        const promptTemplate = String(args['promptTemplate'] ?? '').trim();
        if (!promptTemplate) return { ok: false, output: 'commit_local_node: promptTemplate 必填' };

        const tools = Array.isArray(args['tools'])
          ? (args['tools'] as unknown[]).map(String).filter(Boolean)
          : [];
        if (tools.length === 0) return { ok: false, output: 'commit_local_node: tools 不能为空（用 ["*"] 表示全部）' };

        const inputs = asSpecArray(args['inputs'], 'string') as NodeInputSpec[];
        const outputs = asSpecArray(args['outputs'], 'string') as NodeOutputSpec[];

        const node: LocalNode = {
          id,
          version: '1.0.0',
          displayName: String(args['displayName'] ?? rawId),
          description: String(args['description'] ?? ''),
          tags: Array.isArray(args['tags']) ? (args['tags'] as unknown[]).map(String) : [],
          interface: {
            inputs,
            outputs: outputs.length ? outputs : [{ key: 'result', type: 'string' }],
          },
          body: { kind: 'executor', promptTemplate, tools },
          metadata: {
            origin: 'creator',
            export: true,
            ...(opts.sourceNodeIds || opts.fromBurst
              ? {
                  provenance: {
                    ...(opts.sourceNodeIds ? { fromNodeInsts: opts.sourceNodeIds } : {}),
                    ...(opts.fromBurst ? { fromBurst: opts.fromBurst } : {}),
                  },
                }
              : {}),
            createdAt: '',
            updatedAt: '',
          },
        };

        const saved = store.commit(node);
        committedIds.push(saved.id);
        return { ok: true, output: `committed LocalNode ${saved.id}@${saved.version}` };
      } catch (e) {
        return { ok: false, output: `commit_local_node 失败：${String(e)}` };
      }
    },
  };

  return tool;
}
