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
  buildLiveResourceBudgetSection,
  buildStaticResourceBudgetSection,
  resolveAttributorBudget,
  upsertLiveBudgetMessage,
} from './resource-budget.js';

export const ATTRIBUTOR_SYSTEM = `你是 DyFlow 强制归因器（Mandatory Attributor）。每轮 RUN 结束后，
你必须从执行日志中蒸馏**可跨轮复用**的知识，写入全局 memory。

## 你的工具（仅此阶段可用）
- record_fact：稳定环境事实、API 形状、可行工具路径、脚本相对路径、平台规则
- record_constraint：永久红线或避坑（格式建议 [红线] / [避坑] / [事实] 前缀）
- record_skill：可复用操作步骤（Playwright 序列、脚本模式、API 调用链）；必须指定 nodeRef（见各节点 ref）

## 任务顺序
1. 阅读各节点的工具链与失败摘要，找出「什么有效、什么无效、为什么」
2. 对**成功和失败**节点都要蒸馏——成功节点的可行路径（如 Playwright fetch、某 API 端点）必须 record_fact
3. 对应永久避免的操作模式 record_constraint（勿重复写 failure-distill 已有的纯模板句，要写**领域**避坑）
4. **可复用的操作步骤**（完整命令/选择器/端点序列）→ record_skill（nodeRef 用执行日志中的 ref）
5. 不要编排下一轮的 DAG；不要宣告任务完成

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
): ToolRegistry {
  const skillStore = createNodeSkillStore(workDir);
  return createToolRegistry([
    createRecordFactTool(memory),
    createRecordConstraintTool(memory),
    createRecordSkillTool(skillStore, localStore),
  ]);
}

export async function runDyflowAttributor(
  ctx: RunContext,
  deps: AttributorDeps,
): Promise<AttributorResult> {
  const { llm, logger, memory, workDir, localStore } = deps;
  const registry = createAttributorToolRegistry(memory, workDir, localStore);
  const mem = memory.read();

  const userMessage = [
    `## 本轮 RUN 结果\n${ctx.ok ? '✅ 全图成功' : `❌ 失败节点：${ctx.failedAt ?? '?'}`}`,
    `## 目标（摘要）\n${(mem.goal ?? '（无）').slice(0, 2000)}`,
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
  ].join('\n\n---\n\n');

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
