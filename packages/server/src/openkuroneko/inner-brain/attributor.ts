/**
 * DyFlow Mandatory Attributor — RUN 后强制归因，写入 memory.facts / constraints。
 *
 * ADL：doc/structurizr/DYFLOW-ATTRIBUTION.md §4
 */

import type { Message, LLMAdapter } from '../adapter/index.js';
import type { Logger } from '../logger/index.js';
import type { ToolRegistry } from '../tools/index.js';
import { createToolRegistry } from '../tools/index.js';
import { selectFactsForPrompt } from './fact-governor.js';
import { selectConstraintsForPrompt } from './constraint-governor.js';
import type { MemoryStore } from './memory-store.js';
import {
  createRecordConstraintTool,
  createRecordFactTool,
} from './memory-tools.js';
import { createRecordSkillTool } from './node-skill-tools.js';
import { createNodeSkillStore } from './node-skill-store.js';
import type { LocalNodeStore } from './local-node-store.js';
import type { RunContext } from './run-context-store.js';
import { formatRunContextForPrompt } from './run-context-format.js';
import {
  createPromoteExecutableWorkflowTool,
} from './promote-executable-workflow-tool.js';
import { resolveInnerToolAuditPaths } from './inner-tool-audit.js';
import {
  buildLiveResourceBudgetSection,
  buildStaticResourceBudgetSection,
  resolveAttributorBudget,
  upsertLiveBudgetMessage,
} from './resource-budget.js';

export const ATTRIBUTOR_SYSTEM = `你是 DyFlow 强制归因器（Mandatory Attributor）。每轮 RUN 结束后，
你必须从执行日志中蒸馏**可跨轮复用**的知识，写入全局 memory；路径已稳定时晋升 **Executable Workflow（层 C）**。

## 你的工具（仅此阶段可用）
- record_fact：稳定环境事实、API 形状、可行工具路径、脚本相对路径、平台规则
- record_constraint：永久红线或避坑（格式建议 [红线] / [避坑] / [事实] 前缀）
- record_skill：可复用操作步骤（Playwright 序列、脚本模式、API 调用链）；必须指定 nodeRef（见各节点 ref）
- promote_executable_workflow：【层 C】把已跑通、下次必须照做的路径冻结为版本化工作流（逐步 expect；之后 burstMode=execute 禁 redesign）

## 任务顺序
1. 阅读各节点的工具链与失败摘要，找出「什么有效、什么无效、为什么」
2. 对**成功和失败**节点都要蒸馏——成功节点的可行路径（如 Playwright fetch、某 API 端点）必须 record_fact
3. 对应永久避免的操作模式 record_constraint（勿重复写 failure-distill 已有的纯模板句，要写**领域**避坑）
4. **可复用的操作步骤**（完整命令/选择器/端点序列）→ record_skill（nodeRef 用执行日志中的 ref）
5. **本轮 RUN 成功且路径已稳定**：优先 \`promote_executable_workflow(from=auto)\`（系统从 local_dag/playbook 生成合法 steps）。**禁止**把 browser_open/shell_exec/write_file 等工具名写成 action，也禁止无 args 的空壳 steps_json。**禁止**写死 \`/data/workspaces/task-…\`；步间状态写入 \`.run/ew/\` 等相对文件，勿靠跨步 \`$VAR\`。**禁止** Cookie/Token 明文进契约 → \`keychain_put\` + \`secretRefs\`。主采集 EW 打 \`role:primary\`/\`role:collect\`。仅知识 → fact；仍需临场改参 → skill/节点，不要误升 C
6. 不要编排下一轮的 DAG；不要宣告任务完成

## Executable Workflow 词表（若必须 from=steps）
- action 仅：shell | browser_steps | run_node | assert | skill_step | kpi_charter
- shell 必填 args.command；browser_steps 必填 steps/playbook；run_node 必填 dag；每步须机械 expect

## 写作标准
- 事实要具体、可机械引用（含路径/端点/环境），避免空话
- 去重：若 constraints/facts 已有类似条目，不重复写
- **矛盾核实**：若 fact_conflicts 或 [待核实] 标记存在，用 record_fact 写入**最新、更可靠**的结论（同 topic 会自动 supersede 旧条）
- 写完即停止调工具（见资源预算块）

完成后用一句话总结本轮归因（纯文本，无需特殊格式）。`;

export function buildAttributorSystemPrompt(): string {
  return `${ATTRIBUTOR_SYSTEM}\n\n${buildStaticResourceBudgetSection('attributor')}`;
}

export interface AttributorDeps {
  llm: LLMAdapter;
  logger: Logger;
  memory: MemoryStore;
  workDir: string;
  localStore: LocalNodeStore;
  /** 覆盖 workflows 根；缺省从 workDir 推导 DATA_ROOT */
  dataRoot?: string;
  /** 晋升时自动打 kpi:{id} 标签 */
  kpiId?: string;
}

export interface AttributorResult {
  ok: boolean;
  toolCalls: number;
  lastContent: string;
  error?: string;
}

export function createAttributorToolRegistry(
  memory: MemoryStore,
  workDir: string,
  localStore: LocalNodeStore,
  opts?: { dataRoot?: string; kpiId?: string },
): ToolRegistry {
  const skillStore = createNodeSkillStore(workDir);
  const dataRoot = opts?.dataRoot?.trim() || resolveInnerToolAuditPaths(workDir).dataRoot;
  return createToolRegistry([
    createRecordFactTool(memory),
    createRecordConstraintTool(memory),
    createRecordSkillTool(skillStore, localStore),
    createPromoteExecutableWorkflowTool({
      workDir,
      dataRoot,
      ...(opts?.kpiId?.trim() ? { kpiId: opts.kpiId.trim() } : {}),
    }),
  ]);
}

export async function runDyflowAttributor(
  ctx: RunContext,
  deps: AttributorDeps,
): Promise<AttributorResult> {
  const { llm, logger, memory, workDir, localStore } = deps;
  const registry = createAttributorToolRegistry(memory, workDir, localStore, {
    dataRoot: deps.dataRoot,
    kpiId: deps.kpiId,
  });
  const mem = memory.read();

  const runStatusHint = ctx.ok
    ? '✅ 全图成功 — 若路径已稳定，应考虑 promote_executable_workflow'
    : `❌ 失败节点：${ctx.failedAt ?? '?'} — 优先 fact/constraint/skill；勿 promote 未跑通路径`;

  const userMessage = [
    `## 本轮 RUN 结果\n${runStatusHint}`,
    `## 目标（摘要）\n${(mem.goal ?? '（无）').slice(0, 2000)}`,
    deps.kpiId?.trim() ? `## KPI\n${deps.kpiId.trim()}（promote 时会自动加 tag kpi:${deps.kpiId.trim()}）` : '',
    `## 已有 constraints（${mem.constraints.length}，topic 去重后 ${selectConstraintsForPrompt(mem.constraints, { max: 999 }).lines.length}）\n${selectConstraintsForPrompt(mem.constraints, { max: 8 }).lines.join('\n') || '（无）'}`,
    (() => {
      const active = (mem.fact_records ?? []).filter(r => r.status === 'active');
      const preview = selectFactsForPrompt(mem.fact_records ?? [], { max: 8 });
      const conflictBlock =
        (mem.fact_conflicts ?? []).length > 0
          ? `\n\n### 待核实矛盾（${mem.fact_conflicts!.length} 对）\n${mem
              .fact_conflicts!.map(c => {
                const texts = c.factIds.map(id => {
                  const r = (mem.fact_records ?? []).find(f => f.id === id);
                  return r ? `"${r.content.slice(0, 120)}"` : id;
                });
                return `- [${c.domain}] ${texts.join(' ⚡ ')} (${c.reason})`;
              })
              .join('\n')}`
          : '';
      return `## 已有 facts（${active.length} active）\n${preview.lines.length ? preview.lines.join('\n') : '（无）'}${conflictBlock}`;
    })(),
    `## 执行日志\n${formatRunContextForPrompt(ctx)}`,
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');

  let messages: Message[] = [{ role: 'user', content: userMessage }];
  let lastContent = '';
  let toolCalls = 0;
  const budgetCfg = resolveAttributorBudget();
  const systemPrompt = buildAttributorSystemPrompt();

  logger.info('dyflow-attributor', {
    event: 'attribute.start',
    data: { ok: ctx.ok, nodes: ctx.nodes.length },
  });

  try {
    for (let round = 0; round < budgetCfg.maxRounds; round++) {
      messages = upsertLiveBudgetMessage(
        messages,
        buildLiveResourceBudgetSection({
          round,
          maxRounds: budgetCfg.maxRounds,
          toolCalls,
        }),
      );
      const result = await llm.chat(systemPrompt, messages, registry.schema());
      lastContent = result.content ?? '';

      if (!result.toolCalls || result.toolCalls.length === 0) {
        logger.info('dyflow-attributor', {
          event: 'attribute.done',
          data: { round, toolCalls },
        });
        return { ok: true, toolCalls, lastContent };
      }

      const assistantMsg: Message = {
        role: 'assistant',
        content: lastContent,
        tool_calls: result.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      };
      const toolMsgs: Message[] = [assistantMsg];

      for (const tc of result.toolCalls) {
        toolCalls += 1;
        const tool = registry.get(tc.name);
        let out: { ok: boolean; output: string };
        if (!tool) out = { ok: false, output: `Unknown tool: ${tc.name}` };
        else {
          try {
            out = await tool.call(tc.args);
          } catch (e) {
            out = { ok: false, output: String(e) };
          }
        }
        toolMsgs.push({
          role: 'tool',
          content: JSON.stringify(out),
          tool_call_id: tc.id,
        });
      }

      messages = [...messages, ...toolMsgs];
    }

    logger.warn('dyflow-attributor', { event: 'attribute.cap', data: { toolCalls } });
    return { ok: true, toolCalls, lastContent };
  } catch (e) {
    const error = String(e);
    logger.warn('dyflow-attributor', { event: 'attribute.error', data: { error } });
    return { ok: false, toolCalls, lastContent, error };
  }
}
