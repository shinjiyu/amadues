/**
 * Designer — DESIGN 阶段：LLM 读 memory + LocalNode 库，调 Designer Tools 输出
 * local_dag 或宣告 DONE。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §3 §6.3 §9
 *
 * 失败决策表（high-confidence last_failure 时）写进 system prompt：
 *   1. 换 ref / search_and_instance（P1）
 *   2. 同 ref + 新 instruction（换战术，不是裸重试）
 *   3. 排 newNodeCreator(pack) 改 LocalNode 定义
 *   4. report_done / 等待
 *   5. 同 ref 裸重排 — 仅 transient 才允许
 */

import type { LLMAdapter, Message } from '../adapter/index.js';
import type { Logger } from '../logger/index.js';
import { createDesignerTools } from './designer-tools.js';
import type { NodeSharingDeps } from './designer-tools.js';
import { loadWorkspaceScriptTools } from './workspace-script-tools.js';
import type { LocalNodeStore } from './local-node-store.js';
import type { MemoryStore } from './memory-store.js';
import type { LocalDag } from './types.js';

const SAFETY_MAX_ROUNDS = 20;

export const DESIGNER_SYSTEM = `你是 DyFlow 内脑的 Designer（编排者）。每个 DESIGN tick，你阅读全局 memory 与 LocalNode 库，
输出一张「本轮执行图」（local_dag），或在目标已达成时宣告完成。

## 你的工具
- list_local_nodes / read_local_node：查看可用节点（preset/base 是通用 baseNode，能干任意子目标）
- read_memory：读 goal / facts / constraints / last_failure / node_results
- commit_local_dag：提交执行图（nodes = NodeInst[]），随后进入 RUN
- report_done：目标已完成时调用

## 编排原则
- 把目标拆成若干子目标，每个子目标对应一个 NodeInst：{ id, ref, instruction }
- ref 通常用 preset/base，instruction 写清这一格要达成什么（这是战术，不是步骤脚本）
- **需要账号/密码/API key 时**：从 memory.goal / constraints **把明文写进 instruction**（外脑应在 set_goal 时已写入 goal）；勿写「去读 keychain/vault」让 baseNode 自己挖
- 没有合适的专用节点时，**直接用 preset/base + 清晰 instruction**，不要臆造不存在的 ref
- 若已有多个 node_results 为 ok 且战术可复述，**本轮优先**安排 1 个 preset/node_creator（params.mode=pack, source_node_ids=[...]），减少重复长 instruction
- 连续 last_failure（救火）时可暂缓 pack，先换 ref 或新 instruction
- **必读 constraints**：带 [run-failure] 前缀的是上轮 RUN 后 FailureDistill 强制红线，不得无视

## 固化三层（成本递减）：facts / LocalNode / Tool
- A 事实：知识/选择器/API 形状 → 让 baseNode 用 record_fact 或排 preset/extract_facts
- B 节点：仍需临场判断/改参/组合多工具的战术 → preset/node_creator(pack)
- C 工具：步骤已固定、可 (输入)->(输出) 说清、无 LLM 分支的动作（如「跑某脚本」「查某 API」）
  → 在 instruction 里要求 baseNode 用 register_workspace_script_tool 把脚本晋升为 ws_* 工具；
    已注册的 ws_* 工具见下方清单，可直接在 instruction 中点名调用，避免重复 ReAct（省 token）

## 读到 last_failure（confidence=high）时的决策优先级（禁止裸重试同 ref）
1. 换一个 ref（别的 LocalNode）
2. 同 ref + 写**新的** instruction（换战术）
3. 排 preset/node_creator 修改/固化节点定义
4. 目标已无法推进 → report_done 并说明，或编排一个 ask_user 性质的探测节点
5. 只有 last_failure.transient=true 才允许用同 ref + 相近 instruction 重排

## 完成判定
- 当 memory 显示目标已达成（node_results 满足、kpi_progress 达标）→ report_done
- 否则必须 commit_local_dag（至少一个节点）`;

export interface DesignerDeps {
  llm: LLMAdapter;
  logger: Logger;
  store: LocalNodeStore;
  memory: MemoryStore;
  workDir: string;
  burstId: string;
  /** P1：节点共享（drive9），提供后 Designer 多 search_and_instance 工具 */
  sharing?: NodeSharingDeps;
}

export type DesignerOutcome =
  | { kind: 'run'; dag: LocalDag }
  | { kind: 'done'; reason: string }
  | { kind: 'empty'; reason: string };

function buildUserMessage(memory: MemoryStore, store: LocalNodeStore, workDir: string): string {
  const mem = memory.read();
  const nodes = store.list();
  const wsTools = loadWorkspaceScriptTools(workDir);
  const lastFailure = mem.last_failure
    ? `## 上一次失败（last_failure）\n${JSON.stringify(mem.last_failure, null, 2)}`
    : '## 上一次失败\n（无）';
  return [
    `## 全局目标\n${mem.goal ?? '（未指定）'}`,
    `## 约束\n${mem.constraints.length ? mem.constraints.map(c => `- ${c}`).join('\n') : '（无）'}`,
    `## 已知事实\n${mem.facts.length ? mem.facts.map(f => `- ${f}`).join('\n') : '（无）'}`,
    lastFailure,
    `## 已完成节点结果摘要\n${summarizeResults(mem.node_results)}`,
    `## 可用 LocalNode（${nodes.length}）\n${nodes.map(n => `- ${n.id} | ${n.kind} | ${n.description}`).join('\n') || '（仅 preset）'}`,
    `## 已注册工作区工具（${wsTools.length}）\n${wsTools.length ? wsTools.map(t => `- ${t.name} | ${t.description}`).join('\n') : '（无；可让 baseNode register_workspace_script_tool 晋升稳定脚本）'}`,
    `请规划本轮 local_dag（commit_local_dag），或在目标已达成时 report_done。`,
  ].join('\n\n---\n\n');
}

function summarizeResults(
  results: Record<string, { ok: boolean; ref: string; status?: string; failure?: { summary: string } }>,
): string {
  const entries = Object.entries(results);
  if (entries.length === 0) return '（暂无）';
  return entries
    .map(([id, r]) => {
      const st = r.status ?? (r.ok ? 'ok' : 'failed');
      const tail = r.failure?.summary ? ` — ${r.failure.summary.slice(0, 120)}` : '';
      return `- ${id} (${r.ref}): ${st}${tail}`;
    })
    .join('\n');
}

export async function runDesigner(deps: DesignerDeps): Promise<DesignerOutcome> {
  const { llm, logger, store, memory, workDir, burstId } = deps;
  const { registry, session } = createDesignerTools({
    store, memory, workDir, burstId,
    ...(deps.sharing ? { sharing: deps.sharing } : {}),
  });

  const userMessage = buildUserMessage(memory, store, workDir);
  let messages: Message[] = [{ role: 'user', content: userMessage }];

  logger.info('designer', { event: 'design.start', data: { burstId } });

  for (let round = 0; round < SAFETY_MAX_ROUNDS; round++) {
    let result;
    try {
      result = await llm.chat(DESIGNER_SYSTEM, messages, registry.schema());
    } catch (e) {
      logger.error('designer', { event: 'llm.error', data: { error: String(e) } });
      return { kind: 'empty', reason: `Designer LLM 调用失败：${String(e)}` };
    }

    if (!result.toolCalls || result.toolCalls.length === 0) {
      // 没有工具调用：看是否已出图/已完成
      if (session.committedDag) return { kind: 'run', dag: session.committedDag };
      if (session.doneReason) return { kind: 'done', reason: session.doneReason };
      return { kind: 'empty', reason: result.content || 'Designer 未产出 local_dag 也未 report_done' };
    }

    const assistantMsg: Message = {
      role: 'assistant',
      content: result.content ?? '',
      tool_calls: result.toolCalls.map(tc => ({
        id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })),
    };
    const toolMsgs: Message[] = [assistantMsg];

    for (const tc of result.toolCalls) {
      const tool = registry.get(tc.name);
      let out: { ok: boolean; output: string };
      if (!tool) out = { ok: false, output: `Unknown tool: ${tc.name}` };
      else {
        try { out = await tool.call(tc.args); } catch (e) { out = { ok: false, output: String(e) }; }
      }
      toolMsgs.push({ role: 'tool', content: JSON.stringify(out), tool_call_id: tc.id });
    }

    // 终态：commit_local_dag 或 report_done 已触发即结束 DESIGN
    if (session.committedDag) {
      logger.info('designer', { event: 'design.committed', data: { burstId, nodes: session.committedDag.nodes.length } });
      return { kind: 'run', dag: session.committedDag };
    }
    if (session.doneReason) {
      logger.info('designer', { event: 'design.done', data: { burstId, reason: session.doneReason } });
      return { kind: 'done', reason: session.doneReason };
    }

    messages = [...messages, ...toolMsgs];
  }

  logger.warn('designer', { event: 'design.safety_cap', data: { burstId } });
  if (session.committedDag) return { kind: 'run', dag: session.committedDag };
  if (session.doneReason) return { kind: 'done', reason: session.doneReason };
  return { kind: 'empty', reason: `Designer 达到安全轮次上限（${SAFETY_MAX_ROUNDS}）` };
}
