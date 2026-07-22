/**
 * Designer Tool Registry — DESIGN 阶段专用工具集（与 baseNode tools 隔离）。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §9
 *
 * P0 工具：
 *   list_local_nodes / read_local_node / read_memory / commit_local_dag / report_done
 * P1：search_and_instance（drive9 → Assembler）。
 * P0：search_task_plans（方案参考检索，不写 facts）。
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
import { abstractLocalNode } from './node-abstractor.js';
import type { EnvSnapshot } from './node-abstractor.js';
import { writeLocalDag } from './local-dag-store.js';
import { runDeliverableChecks, deliverableCheckFilePart, isUnsafeRelativePath } from './deliverable-check.js';
import { createCommitLocalNodeTool } from './commit-local-node-tool.js';
import {
  appendPlanReferences,
  formatPlanReferenceHits,
  normalizePlanReferenceSources,
  PLAN_REFERENCES_MEMORY_KEY,
  type PlanReferencePort,
  type PlanReferenceRecord,
  type PlanReferenceSource,
} from './plan-reference-port.js';
import type { DeliverableCheck, LocalDag, LockedMilestone, NodeDeliverable, NodeInst } from './types.js';

/** 单节点 instruction 上限：超过即视为「巨型单体」反模式，commit_local_dag 拒收 */
const MAX_INSTRUCTION_CHARS = 4000;

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
  /** 提供后 promote_local_node 成功提升会自动脱敏导出到 drive9（fire-and-forget） */
  sourceAgent?: string;
}

export interface PlanReferenceDeps {
  port: PlanReferencePort;
  kpiId?: string;
}

export interface DesignerToolDeps {
  store: LocalNodeStore;
  memory: MemoryStore;
  workDir: string;
  burstId: string;
  /** P1：提供后 Designer 多一个 search_and_instance 工具 */
  sharing?: NodeSharingDeps;
  /** P0：提供后 Designer 多一个 search_task_plans 工具 */
  planReference?: PlanReferenceDeps;
}

export interface DesignerTools {
  registry: ToolRegistry;
  session: DesignSession;
}

const CHECK_KINDS = new Set(['file', 'json_key', 'stdout_contains', 'stdout_absent']);

/** 解析 DeliverableCheck[]（容错：丢弃 kind/target 非法项） */
function normalizeChecks(raw: unknown): DeliverableCheck[] {
  if (!Array.isArray(raw)) return [];
  const out: DeliverableCheck[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const kind = typeof o['kind'] === 'string' ? o['kind'] : '';
    const target = typeof o['target'] === 'string' ? o['target'].trim() : '';
    if (!CHECK_KINDS.has(kind) || !target) continue;
    const c: DeliverableCheck = { kind: kind as DeliverableCheck['kind'], target };
    if (typeof o['describe'] === 'string' && o['describe'].trim()) c.describe = o['describe'].trim();
    out.push(c);
  }
  return out;
}

function normalizeDeliverable(raw: unknown): NodeDeliverable | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const checks = normalizeChecks(o['checks']);
  const summary = typeof o['summary'] === 'string' ? o['summary'].trim() : '';
  if (checks.length === 0 && !summary) return null;
  return { summary: summary || '(未填写交付摘要)', checks };
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
  if (typeof o['milestone'] === 'string' && o['milestone'].trim()) inst.milestone = o['milestone'].trim();
  if (o['acceptance'] && typeof o['acceptance'] === 'object') {
    inst.acceptance = o['acceptance'] as NodeInst['acceptance'];
  }
  const deliverable = normalizeDeliverable(o['deliverable']);
  if (deliverable) inst.deliverable = deliverable;
  return inst;
}

export function createDesignerTools(deps: DesignerToolDeps): DesignerTools {
  const { store, memory, workDir, burstId, sharing, planReference } = deps;
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
      '提交本轮执行图：nodes 是 NodeInst 数组，每个 {id, ref(LocalNode id), instruction(本轮子目标，简洁战术), params?, deliverable}。' +
      `【硬约束】① instruction 不得超过 ${MAX_INSTRUCTION_CHARS} 字——勿内嵌完整脚本/长正文，让 baseNode 自己 ReAct 写代码/生成内容；超长会被拒收。` +
      '② 每个节点**必须**附 deliverable={summary, checks:[{kind,target,describe?}]} 声明「必须交付什么 + 怎么机械验」，缺失会被拒收；' +
      'kind: file(workDir相对路径) | json_key("rel.json#a.b.c") | stdout_contains(子串) | stdout_absent(失败信号子串)。' +
      '提交后进入 RUN 阶段，Runner 会机械验票 deliverable，不达标的节点判 failed。',
    parameters: {
      nodes: { type: 'array', description: 'NodeInst 数组：[{id, ref, instruction?, params?, deliverable?:{summary,checks:[{kind,target,describe?}]}, milestone?(服务的里程碑标签，命中已锁定会被拒)}]' },
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
      // §9c：机械拦截已锁定里程碑的重排
      const lockedIds = new Set(
        (memory.read().locked_milestones ?? []).map(m => m.id),
      );
      const relocked = [...new Set(nodes.map(n => n.milestone).filter((m): m is string => !!m && lockedIds.has(m)))];
      if (relocked.length > 0) {
        return {
          ok: false,
          output:
            `以下里程碑已锁定（已完成），禁止重排：${relocked.join(', ')}。` +
            `如确需修补，请给该节点换 milestone 标签，或先确认锁定证据已失效。`,
        };
      }
      // 治本：压制「巨型单体 instruction」——instruction 只写战术 + 关键事实 + 交付物，
      // 完整脚本 / 长正文（小说章节、文章全文）应由 baseNode 自己 ReAct 生成，或在 facts 记脚本路径后 shell_exec 跑
      const oversized = nodes.filter(n => (n.instruction?.length ?? 0) > MAX_INSTRUCTION_CHARS);
      if (oversized.length > 0) {
        return {
          ok: false,
          output:
            `以下节点 instruction 过长（>${MAX_INSTRUCTION_CHARS} 字），属「巨型单体」反模式，拒收：` +
            `${oversized.map(n => `${n.id}(${n.instruction?.length ?? 0}字)`).join(', ')}。\n` +
            `修复：① 不要把完整脚本/长正文塞进 instruction——只写「这一格要达成什么 + 关键事实 + deliverable」，让 baseNode 用 ReAct 自己写代码/生成内容；` +
            `② 已有可用脚本就在 facts 记其路径，instruction 里要求 baseNode 直接 shell_exec 跑；` +
            `③ 一格只做一个可验收的小步骤，必要时拆成多个更小的节点。`,
        };
      }
      // 治本：每个节点必带可机械验的 deliverable（"给目标也要给明确交付要求"）
      const noDeliverable = nodes.filter(n => !n.deliverable || n.deliverable.checks.length === 0);
      if (noDeliverable.length > 0) {
        return {
          ok: false,
          output:
            `以下节点缺少可机械验的 deliverable（必填），拒收：${noDeliverable.map(n => n.id).join(', ')}。\n` +
            `每个节点都要带 deliverable={summary, checks:[{kind,target,describe?}]}，kind ∈ file|json_key|stdout_contains|stdout_absent，` +
            `选能真正代表「这一格干成了」的机械证据（产物文件存在 / JSON 关键字段非空 / stdout 含成功标志或不含 404）。`,
        };
      }
      // P-rel：拒收绝对路径 / ..（与 inner-brain-deliverables R2.4 对齐）
      const unsafePathNodes = nodes.filter(n =>
        (n.deliverable?.checks ?? []).some(c => {
          const filePart = deliverableCheckFilePart(c);
          return filePart != null && isUnsafeRelativePath(filePart);
        }),
      );
      if (unsafePathNodes.length > 0) {
        return {
          ok: false,
          output:
            `以下节点 deliverable.checks 含绝对路径或 \`..\`，拒收：${unsafePathNodes.map(n => n.id).join(', ')}。\n` +
            `file / json_key 的 target 必须是 workDir 相对路径（可用 workspace/ 前缀），禁止 /tmp/... 与盘符绝对路径。`,
        };
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
    description:
      '当全局目标已经达成、无需再编排任何节点时调用，结束本 burst。' +
      '交付型目标**必须**附 verify=[{kind,target,describe?}]（同 deliverable.checks 语义）给出可机械验的完成证据；' +
      'verify 任一项不通过则拒收，你需继续 commit_local_dag 补齐缺口后再报完成。',
    parameters: {
      reason: { type: 'string', description: '完成理由（可选）' },
      verify: {
        type: 'array',
        description: '目标级完成证据 DeliverableCheck[]：[{kind:file|json_key|stdout_contains|stdout_absent, target, describe?}]',
      },
    },
    async call(args) {
      const reason = typeof args['reason'] === 'string' ? args['reason'] : '目标已完成';
      const verify = normalizeChecks(args['verify']);
      if (verify.length > 0) {
        // stdout 在 DESIGN 阶段无执行日志，仅做 file/json_key 这类持久化证据校验
        const report = runDeliverableChecks(workDir, verify, '');
        if (!report.ok) {
          return {
            ok: false,
            output:
              `report_done 被拒：以下完成证据未通过，请勿宣告完成，继续 commit_local_dag 把缺口补齐：\n` +
              report.missing.map(m => `- ${m}`).join('\n'),
          };
        }
      }
      session.doneReason = reason;
      return { ok: true, output: verify.length > 0 ? `marked done（${verify.length} 项证据已验证）` : 'marked done' };
    },
  };

  // 反思期节点提升（§9b）：Designer 在 DESIGN 阶段直接固化跑通的战术，无需排 RUN 节点。
  // 复用 commit_local_node 组装逻辑，但作为 Designer 副作用工具（不构成 DESIGN 终态）。
  const promoteTool: Tool = (() => {
    return {
      name: 'promote_local_node',
      description:
        '【反思】把一段已跑通、未来会复用的战术直接固化成可复用 LocalNode（origin=creator），供后续 commit_local_dag 以 ref 引用。' +
        '仅当某战术已在 node_results/dag_history 中验证成功且可复述时调用；调用后不结束本轮，可继续编排。' +
        '入参：id(语义名,自动加 local/) / description / promptTemplate(固化步骤,可含 ${{params.x}}) / tools(allowlist,["*"]全部) / sourceRef?(拷贝绑定技能) / inputs? / outputs? / tags?。',
      parameters: {
        id: { type: 'string', description: '语义名，如 ps_open_battle；自动加 local/ 前缀' },
        description: { type: 'string', description: '一句话说明这个节点做什么，供 Designer 选用' },
        promptTemplate: { type: 'string', description: 'baseNode system prompt：固化的操作步骤，可含 ${{ params.x }} 占位' },
        tools: { type: 'array', description: '工具 allowlist（字符串数组）；用 ["*"] 表示全部' },
        sourceRef: { type: 'string', description: '可选：源 LocalNode id，拷贝其绑定技能到新节点（如 preset/base）' },
        displayName: { type: 'string', description: '人类可读名（可选）' },
        tags: { type: 'array', description: '检索标签（字符串数组，可选）' },
        inputs: { type: 'array', description: 'inputs 契约：[{key,type}]（可选）' },
        outputs: { type: 'array', description: 'outputs 契约：[{key,type}]，baseNode 必须产出（可选）' },
      },
      required: ['id', 'description', 'promptTemplate', 'tools'],
      async call(args) {
        const inner = createCommitLocalNodeTool(store, { fromBurst: burstId, workDir });
        const res = await inner.call(args);
        // 迁移自旧 node_creator 的 auto-export：提升成功且配置了 drive9 → 脱敏导出（fire-and-forget）
        if (res.ok && sharing?.defStore && sharing.sourceAgent) {
          const id = inner.committedIds[inner.committedIds.length - 1];
          const node = id ? store.read(id) : null;
          if (node) {
            void abstractLocalNode(
              node,
              { llm: sharing.llm, logger: sharing.logger, store: sharing.defStore },
              { sourceAgent: sharing.sourceAgent, workDir, ...(sharing.env ? { env: sharing.env } : {}) },
            ).catch(() => { /* 导出失败不影响提升 */ });
          }
        }
        return res;
      },
    };
  })();

  // 里程碑锁定（§9c）：把已完成子目标持久化，commit 时机械拦截重排，免被 node_results 覆盖丢失。
  const lockMilestoneTool: Tool = {
    name: 'lock_milestone',
    description:
      '【反思】把一个**已真正达成**的子目标锁定为里程碑：之后给节点打 milestone=<id> 标签再 commit_local_dag 会被拒收，防止重复编排已完成的事（如重复登录/重复建书）。' +
      '强烈建议附 verify=[{kind,target,describe?}] 给机械证据，证据不通过则拒锁。调用后不结束本轮。',
    parameters: {
      id: { type: 'string', description: '里程碑语义 id（与后续 NodeInst.milestone 对应）' },
      summary: { type: 'string', description: '这个里程碑达成了什么' },
      verify: {
        type: 'array',
        description: '机械证据 DeliverableCheck[]：[{kind:file|json_key|stdout_contains|stdout_absent, target, describe?}]',
      },
    },
    required: ['id', 'summary'],
    async call(args) {
      const id = typeof args['id'] === 'string' ? args['id'].trim() : '';
      if (!id) return { ok: false, output: 'lock_milestone: id 必填' };
      const summary = typeof args['summary'] === 'string' ? args['summary'].trim() : '';
      if (!summary) return { ok: false, output: 'lock_milestone: summary 必填' };
      const verify = normalizeChecks(args['verify']);
      if (verify.length > 0) {
        const report = runDeliverableChecks(workDir, verify, '');
        if (!report.ok) {
          return {
            ok: false,
            output:
              `lock_milestone 被拒：里程碑证据未通过，未锁定（请勿锁定未达成的里程碑）：\n` +
              report.missing.map(m => `- ${m}`).join('\n'),
          };
        }
      }
      const milestone: LockedMilestone = {
        id,
        summary,
        lockedAt: new Date().toISOString(),
        ...(verify.length > 0 ? { evidence: verify } : {}),
      };
      memory.lockMilestone(milestone);
      return {
        ok: true,
        output: `已锁定里程碑 ${id}${verify.length > 0 ? `（${verify.length} 项证据已验证）` : '（无证据，建议补 verify）'}`,
      };
    },
  };

  const tools: Tool[] = [listTool, readNodeTool, readMemoryTool, commitDagTool, reportDoneTool, promoteTool, lockMilestoneTool];

  if (planReference) {
    const planSearchTool: Tool = {
      name: 'search_task_plans',
      description:
        '按语义检索历史任务方案 / playbook / 同 KPI peer 经验（参考 only，禁止写入 facts）。' +
        '在目标陌生、last_failure 换向、或编排前需要借鉴时使用；query 由你根据当前局面自拟。',
      parameters: {
        query: { type: 'string', description: '检索 query（描述你想找的方案线索）' },
        sources: {
          type: 'array',
          description: '数据源：archive（历史 burst）/ repository（晋升 KSP）/ peer（同 KPI sibling）；默认全选',
        },
        topK: { type: 'number', description: '返回条数上限（默认 5）' },
      },
      required: ['query'],
      async call(args) {
        const query = String(args['query'] ?? '').trim();
        if (!query) return { ok: false, output: 'search_task_plans: query 必填' };
        const rawSources = Array.isArray(args['sources'])
          ? (args['sources'] as unknown[]).map(String)
          : undefined;
        const sources = rawSources
          ? normalizePlanReferenceSources(rawSources as PlanReferenceSource[])
          : undefined;
        const topK = typeof args['topK'] === 'number' ? (args['topK'] as number) : undefined;
        const hits = await planReference.port.search({
          query,
          ...(planReference.kpiId ? { kpiId: planReference.kpiId } : {}),
          ...(sources ? { sources } : {}),
          ...(topK != null ? { topK } : {}),
        });
        const mem = memory.read();
        const merged = appendPlanReferences(
          mem[PLAN_REFERENCES_MEMORY_KEY] as PlanReferenceRecord[] | undefined,
          query,
          hits,
        );
        memory.patch(PLAN_REFERENCES_MEMORY_KEY, merged);
        return { ok: true, output: formatPlanReferenceHits(hits) };
      },
    };
    tools.push(planSearchTool);
  }

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
