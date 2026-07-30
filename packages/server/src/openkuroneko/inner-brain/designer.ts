/**
 * Designer — DESIGN 阶段：LLM 读 memory + LocalNode 库，调 Designer Tools 输出
 * local_dag 或宣告 DONE。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §3 §6.3 §9
 *
 * 失败决策表（high-confidence last_failure 时）写进 system prompt：
 *   1. 换 ref / search_and_instance（P1）/ search_task_plans（方案参考）
 *   2. 同 ref + 新 instruction（换战术，不是裸重试）
 *   3. promote_local_node 固化/改造 LocalNode 定义（反思期，非 RUN 格）
 *   4. report_done / 等待
 *   5. 同 ref 裸重排 — 仅 transient 才允许
 */

import type { LLMAdapter, Message } from '../adapter/index.js';
import type { Logger } from '../logger/index.js';
import { isTransientLlmTransportError } from '../../llm/llm-transport-error.js';
import { createDesignerTools } from './designer-tools.js';
import type { NodeSharingDeps } from './designer-tools.js';
import type { LocalNodeStore } from './local-node-store.js';
import { selectFactsForPrompt } from './fact-governor.js';
import { selectConstraintsForPrompt } from './constraint-governor.js';
import {
  PLAN_REFERENCES_MEMORY_KEY,
  summarizePlanReferences,
  type PlanReferenceRecord,
} from './plan-reference-port.js';
import type { MemoryStore } from './memory-store.js';
import type { DagHistoryEntry, LocalDag, LockedMilestone } from './types.js';
import {
  buildLiveResourceBudgetSection,
  buildStaticResourceBudgetSection,
  resolveDesignerBudget,
  upsertLiveBudgetMessage,
} from './resource-budget.js';

export const DESIGNER_SYSTEM = `你是 DyFlow 内脑的 Designer（编排者）。每个 DESIGN tick，你阅读全局 memory 与 LocalNode 库，
输出一张「本轮执行图」（local_dag），或在目标已达成时宣告完成。

## 你的工具
- list_local_nodes / read_local_node：查看可用节点（preset/base 是通用 baseNode，能干任意子目标）
- read_memory：读 goal / facts / constraints / last_failure / node_results
- commit_local_dag：提交执行图（nodes = NodeInst[]，每个节点带 deliverable 验收），随后进入 RUN
- report_done：目标已完成时调用（交付型目标须附 verify 机械证据，否则被拒）
- promote_local_node：【反思】把已跑通、会复用的战术直接固化成 local/ 节点（不结束本轮，可继续编排复用）
- lock_milestone：【反思】把已真正达成的子目标锁定为里程碑（附 verify 机械证据）；之后给节点打 milestone=<id> 再 commit 会被拒，防重复编排
- search_task_plans：【编排前】按你自拟 query 检索历史方案 / playbook（**参考 only**；禁止把命中写入 facts，验证后须 record_fact）
- search_and_instance：（若可用）按语义从**共享** NodeDef 库装配 LocalNode；无命中则空——**不会**灌入全库。优先 preset/base；仅明确复用共享战术时调用

## 编排原则
- 把目标拆成若干**小而可验收**的子目标，每个子目标对应一个 NodeInst：{ id, ref, instruction, deliverable }
- ref 通常用 preset/base，instruction 写清这一格要达成什么（这是**战术方向**，不是步骤脚本）
- **严禁巨型单体 instruction**（commit 会机械拒收 >4000 字的 instruction）：
  - ❌ 不要把完整 Python/Playwright 脚本、整段小说章节/文章全文塞进 instruction——那是 baseNode 的活，让它用 ReAct 自己写代码、自己生成长内容
  - ❌ 不要一格做完"导航+填表+创建+写正文+发布"五件事；一格只做**一个**能机械验收的步骤，宁可多排几个小节点
  - ✅ 已有可用脚本：在 facts 记其路径，instruction 里要求 baseNode 直接 \`shell_exec\` 跑该脚本
  - ✅ 长内容产物（如小说正文）：让该节点 baseNode 自己生成并写文件，deliverable 验文件存在/非空
- **每个节点必须附 deliverable**（commit 机械拒收缺失项）：{ summary, checks:[{kind, target, describe?}] }，声明「这一格必须交付什么 + 怎么机械验」。Runner 会机械验票，且 **baseNode prompt 会看到同一份 checks**（口令/路径须精确一致）：
  - **优先** kind=file / json_key（磁盘真相）；能验文件就不要只靠自创 stdout 口令
  - kind=file：产物文件存在且非空，target=workDir 相对路径（如 "workspace/book_id.json"）
  - kind=json_key：JSON 文件含关键字段，target="rel.json#a.b.c"（如 "create_result.json#book_id"）
  - kind=stdout_contains：本节点 shell/最终回复须**精确包含** target 子串；instruction 里也要写同一子串（如要求 print("FILES_READY")，checks.target 也是 FILES_READY）——**禁止**用同义词（ALL_CHECKS_PASSED≠FILES_READY）
  - kind=stdout_absent：本节点 shell 输出**不得**含失败信号，target=子串（如 "404"、"error"、"失败"）
  - 选可机械验、能真正代表"这一格干成了"的证据；勿用一句空话 deliverable
- **需要账号/密码/API key 时**：从 memory.goal / constraints **把明文写进 instruction**（外脑应在 set_goal 时已写入 goal）；勿写「去读 keychain/vault」让 baseNode 自己挖
- 没有合适的专用节点时，**直接用 preset/base + 清晰 instruction**，不要臆造不存在的 ref
- 若已有多个 node_results 为 ok 且战术可复述，**本轮优先**调 promote_local_node 固化成 local/ 节点（直接提升，不必排 RUN 格），减少重复长 instruction
- 连续 last_failure（救火）时可暂缓提升，先换 ref 或新 instruction
- **必读 constraints**：带 [run-failure] 前缀的是上轮 RUN 后 FailureDistill 强制红线，不得无视

## 方案参考（search_task_plans）
- 目标陌生、last_failure 换向、或不确定战术前，可先 search_task_plans（query 由你根据局面写）
- 返回内容**未验证**，仅供编排；不得当作事实写入 record_fact

## 共享节点检索（search_and_instance）
- 共享库跨 agent，模糊 query 易拖入无关域（如 Twitter 任务装配 weibo_*）——query 要具体，**尽量带 filterTags**，topK 宜小
- instanced 为空时改用 preset/base 或 promote_local_node，勿反复空搜
- 装配进 local_nodes 不等于要写进 DAG；只把真正需要的 ref 排进 commit_local_dag

## 反思与固化（每轮 DESIGN 先反思，再编排）
- RUN 结束后框架已跑 **Mandatory Attributor** 写入 memory.facts/constraints；优先读这些，勿重复蒸馏
- 先看「已完成节点结果摘要 + 最近 DAG 历史」：哪些子目标已 ok（视为锁定，勿重复编排）、哪条路线在连续失败
- 固化两层（成本递减）：
  - A 事实：若 Attributor 未覆盖，可让 baseNode record_fact 或排 preset/extract_facts；通常不必
  - B 节点：某段战术已在历史中跑通且会复用 → **直接调 promote_local_node 固化**（DESIGN 内即时提升，无需 RUN 格）
- 步骤已固定、无 LLM 分支的脚本动作：**不要造工具**，让 baseNode 把脚本路径与运行方式 record_fact，下次在 instruction 里要求 baseNode 直接 shell_exec 跑该脚本

## patch vs redesign（据「最近 DAG 历史」决策）
- 上轮图大部分 ok、仅个别节点 failed/capped → **patch**：本轮只重排失败那格（换 ref / 写新 instruction），勿把已 ok 的格子整图重来
- 同一路线连续 ≥2 轮整体失败 / 根因在编排结构本身 → **redesign**：换思路重排整图
- 历史中已 ok 且产物仍在的子目标 → 视为已锁定，不再编排
- **关键已完成子目标用 lock_milestone 持久锁定**（附 verify 证据）：因为 node_results 按 nodeInstId 会被后续轮覆盖，光靠摘要会"忘记"已做完的事。锁定后给相关节点打 milestone 标签，commit 会机械拦截重排

## 读到 last_failure（confidence=high）时的决策优先级（禁止裸重试同 ref）
1. 换一个 ref（别的 LocalNode）
2. 同 ref + 写**新的** instruction（换战术）
3. 用 promote_local_node 固化/改造节点定义（反思期提升，非 RUN 格）
4. 目标已无法推进 → report_done 并说明，或编排一个 ask_user 性质的探测节点
5. 只有 last_failure.transient=true 才允许用同 ref + 相近 instruction 重排

## 完成判定（report_done 有机械闸门，禁止凭空宣告）
- 当 memory 显示目标已达成（node_results 满足、kpi_progress 达标）→ report_done
- **交付型目标必须给 report_done 附 verify=[{kind,target,describe?}]**（同 deliverable.checks 语义，用 file/json_key 给出可机械验的最终证据，如「workspace/report.md 存在」「result.json#published_count 非空」）。verify 不通过会被拒收，你得继续 commit_local_dag 补齐——**勿凭 node 摘要的文字断言就报完成**。
- 否则必须 commit_local_dag（至少一个节点）`;

export function buildDesignerSystemPrompt(): string {
  return `${DESIGNER_SYSTEM}\n\n${buildStaticResourceBudgetSection('designer')}`;
}

export interface DesignerDeps {
  llm: LLMAdapter;
  logger: Logger;
  store: LocalNodeStore;
  memory: MemoryStore;
  workDir: string;
  burstId: string;
  /** P1：节点共享（drive9），提供后 Designer 多 search_and_instance 工具 */
  sharing?: NodeSharingDeps;
  /** P0：方案参考检索 */
  planReference?: import('./designer-tools.js').PlanReferenceDeps;
}

export type DesignerOutcome =
  | { kind: 'run'; dag: LocalDag }
  | { kind: 'done'; reason: string }
  | { kind: 'failed'; reason: string }
  | { kind: 'empty'; reason: string };

function buildUserMessage(memory: MemoryStore, store: LocalNodeStore): string {
  const mem = memory.read();
  const nodes = store.list();
  const lastFailure = mem.last_failure
    ? `## 上一次失败（last_failure）\n${JSON.stringify(mem.last_failure, null, 2)}`
    : '## 上一次失败\n（无）';
  return [
    `## 全局目标\n${mem.goal ?? '（未指定）'}`,
    selectConstraintsForPrompt(mem.constraints).section,
    selectFactsForPrompt(mem.fact_records ?? []).section,
    lastFailure,
    `## 已完成节点结果摘要\n${summarizeResults(mem.node_results)}`,
    `## 最近 DAG 历史（patch vs redesign 依据）\n${summarizeDagHistory(mem.dag_history)}`,
    `## 已锁定里程碑（禁止重排；命中即被 commit 拒收）\n${summarizeLockedMilestones(mem.locked_milestones)}`,
    `## 方案参考（未验证，非 facts）\n${summarizePlanReferences(mem[PLAN_REFERENCES_MEMORY_KEY] as PlanReferenceRecord[] | undefined)}`,
    `## 可用 LocalNode（${nodes.length}）\n${nodes.map(n => `- ${n.id} | ${n.kind} | ${n.description}`).join('\n') || '（仅 preset）'}`,
    `请规划本轮 local_dag（commit_local_dag），或在目标已达成时 report_done。`,
  ].join('\n\n---\n\n');
}

function summarizeLockedMilestones(locked: LockedMilestone[] | undefined): string {
  if (!locked || locked.length === 0) return '（无）';
  return locked.map(m => `- ${m.id}：${m.summary}`).join('\n');
}

function summarizeDagHistory(history: DagHistoryEntry[] | undefined): string {
  if (!history || history.length === 0) return '（暂无；本轮是首次编排）';
  const recent = history.slice(-5);
  return recent
    .map((h, i) => {
      const idx = history.length - recent.length + i + 1;
      const head = `#${idx} ${h.ok ? '✅全绿' : `❌失败@${h.failedAt ?? '?'}`}（${h.nodes.length} 格）`;
      const nodes = h.nodes
        .map(n => `    - ${n.id}(${n.ref}) [${n.status}]${n.deliverable ? ` 交付:${n.deliverable}` : ''}`)
        .join('\n');
      return `${head}\n${nodes}`;
    })
    .join('\n');
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
    ...(deps.planReference ? { planReference: deps.planReference } : {}),
  });

  const userMessage = buildUserMessage(memory, store);
  let messages: Message[] = [{ role: 'user', content: userMessage }];

  logger.info('designer', { event: 'design.start', data: { burstId } });

  const budgetCfg = resolveDesignerBudget();
  const systemPrompt = buildDesignerSystemPrompt();
  let toolCalls = 0;

  for (let round = 0; round < budgetCfg.maxRounds; round++) {
    messages = upsertLiveBudgetMessage(
      messages,
      buildLiveResourceBudgetSection({
        round,
        maxRounds: budgetCfg.maxRounds,
        toolCalls,
      }),
    );
    let result;
    try {
      result = await llm.chat(systemPrompt, messages, registry.schema());
    } catch (e) {
      const errMsg = String(e);
      logger.error('designer', { event: 'llm.error', data: { error: errMsg } });
      const reason = `Designer LLM 调用失败：${errMsg}`;
      if (isTransientLlmTransportError(errMsg)) {
        return { kind: 'empty', reason };
      }
      return { kind: 'failed', reason };
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
      toolCalls += 1;
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
  return { kind: 'empty', reason: `Designer 达到安全轮次上限（${budgetCfg.maxRounds}）` };
}
