/**
 * 模式 C — 强制归因器（Mandatory Attributor）
 *
 * 输入：activeMilestone + preState + executionLog + postState
 * 工具：write_constraint / write_skill / write_knowledge
 * 输出：从 result.content 末尾解析 CONTROL flag + REASON
 */

import type { Message, LLMAdapter } from '../adapter/index.js';
import type { Logger } from '../logger/index.js';
import type { ToolRegistry } from '../tools/index.js';
import type { Milestone, ExecutionEntry } from '../brain/index.js';
import { BrainFS, formatMilestoneContractForPrompt } from '../brain/index.js';
import {
  applyResearchWriteSkillGate,
  buildAttributorSystemPrompt,
  buildResearchMilestoneReminder,
  buildWriteSkillMissedRetryReminder,
  contractRequiresWriteSkill,
  countWriteSkillToolCalls,
  isResearchMilestone,
  shouldBlockForMissingWriteSkill,
  shouldRetryResearchWriteSkillPass,
  type ControlFlag,
} from './research-skill-policy.js';

/** Attributor 中单条工具结果的最大内联字符数（Executor 已压缩，此处做二次保底截断） */
const ATTR_RESULT_MAX  = 2000;
/** Attributor 中 preState / postState 的最大字符数 */
const ATTR_STATE_MAX   = 3000;
/** Attributor 中错误摘要单条最大字符数 */
const ATTR_ERROR_MAX   = 500;

export { ATTRIBUTOR_SYSTEM } from './research-skill-policy.js';
export type { ControlFlag } from './research-skill-policy.js';

export interface AttributeResult {
  flag: ControlFlag;
  reason: string;
  rawContent: string;
  /** R1：研究里程碑因缺 write_skill 被框架降级 */
  researchWriteSkillGated?: boolean;
  /** R2：契约要求 write_skill 但重试后仍缺失 → 外脑 BLOCK */
  researchWriteSkillBlocked?: boolean;
}

/** 归因时注入的相关技能索引条目上限 */
const ATTR_SKILL_TOP_K = 8;

export async function runAttributor(
  activeMilestone: Milestone,
  preState: string,
  executionLog: ExecutionEntry[],
  postState: string,
  attributorToolRegistry: ToolRegistry,
  llm: LLMAdapter,
  logger: Logger,
  brain?: BrainFS,
): Promise<AttributeResult> {
  // Build execution log text（对每条 result.output 做保底截断，Executor 已压缩过一次）
  const logSections = executionLog.length === 0
    ? '（无工具调用）'
    : executionLog.map((e, i) => {
        const resultStr = JSON.stringify(e.result);
        const resultDisplay = resultStr.length > ATTR_RESULT_MAX
          ? resultStr.slice(0, ATTR_RESULT_MAX) + `…（已截断，完整长度 ${resultStr.length} 字符）`
          : resultStr;
        return [
          `### 操作 ${i + 1}`,
          `工具：${e.toolName}`,
          `参数：${JSON.stringify(e.args, null, 2)}`,
          `结果：${resultDisplay}`,
          e.error ? `错误：${e.error}` : '',
        ].filter(Boolean).join('\n');
      }).join('\n\n');

  // Collect errors from log（错误摘要单条截断）
  const errors = executionLog
    .filter(e => !e.result.ok || e.error)
    .map(e => {
      const msg = e.error ?? e.result.output;
      return `- ${e.toolName}: ${msg.length > ATTR_ERROR_MAX ? msg.slice(0, ATTR_ERROR_MAX) + '…' : msg}`;
    })
    .join('\n');

  const milestoneText = `[${activeMilestone.id}] [Active] ${activeMilestone.title} — ${activeMilestone.description}`;

  const contractBlock = formatMilestoneContractForPrompt(activeMilestone);
  const contractSection = contractBlock
    ? `## 本里程碑契约（评估是否背离）\n${contractBlock}`
    : '';

  const isResearch = isResearchMilestone(activeMilestone, contractBlock);
  const systemPrompt = buildAttributorSystemPrompt(isResearch);

  // preState / postState 也做截断（environment snapshot 可能很大）
  const preDisplay  = preState  ? preState.slice(0, ATTR_STATE_MAX)  + (preState.length  > ATTR_STATE_MAX  ? '…（已截断）' : '') : '（无快照）';
  const postDisplay = postState ? postState.slice(0, ATTR_STATE_MAX) + (postState.length > ATTR_STATE_MAX  ? '…（已截断）' : '') : '（无快照）';

  // 检索与当前里程碑相关的已有技能索引，注入归因上下文（只注入索引行，不读全文）
  let existingSkillsSection = '';
  if (brain) {
    const skillQuery = `${activeMilestone.title} ${activeMilestone.description}`;
    const matched = brain.searchSkills(skillQuery, ATTR_SKILL_TOP_K);
    if (matched.length > 0) {
      const lines = matched.map(e =>
        `- 【${e.category}】《${e.title}》 | 标签: ${e.tags.join(', ') || '(无)'} | id: ${e.id}`,
      );
      existingSkillsSection =
        `## 已有相关技能（仅索引，供任务3决策用）\n` +
        `（共 ${matched.length} 条，按相关度排序）\n\n` +
        lines.join('\n');
    } else {
      existingSkillsSection = '## 已有相关技能（仅索引，供任务3决策用）\n（暂无相关技能）';
    }
  }

  const userMessage = [
    `## 目标里程碑\n${milestoneText}`,
    contractSection,
    isResearch ? buildResearchMilestoneReminder() : '',
    `## 执行前状态（Pre-State）\n${preDisplay}`,
    `## 执行日志\n${logSections}`,
    `## 执行后状态（Post-State）\n${postDisplay}`,
    errors ? `## 错误摘要\n${errors}` : '',
    existingSkillsSection,
  ].filter(Boolean).join('\n\n---\n\n');

  logger.info('attributor', {
    event: 'attribute.start',
    data: { milestoneId: activeMilestone.id, logEntries: executionLog.length },
  });

  /** 单次 Attributor pass 最多工具调用轮次 */
  const MAX_ATTR_ROUNDS = 20;

  async function runAttributorPass(userContent: string): Promise<{ lastContent: string; toolNames: string[] }> {
    let passMessages: Message[] = [{ role: 'user', content: userContent }];
    let passLastContent = '';
    const passToolNames: string[] = [];

    for (let round = 0; round < MAX_ATTR_ROUNDS; round++) {
      if (round === MAX_ATTR_ROUNDS - 1) {
        logger.warn('attributor', { event: 'llm.max_rounds', data: { round, pass: 'attributor' } });
      }
      logger.info('attributor', { event: 'llm.call', data: { round } });

      let result;
      try {
        result = await llm.chat(systemPrompt, passMessages, attributorToolRegistry.schema());
      } catch (e) {
        logger.error('attributor', { event: 'llm.error', data: { error: String(e) } });
        throw e;
      }

      passLastContent = result.content ?? '';

      if (!result.toolCalls || result.toolCalls.length === 0) {
        logger.info('attributor', { event: 'llm.done', data: { round, contentLen: passLastContent.length } });
        break;
      }

      const assistantMsg: Message = {
        role: 'assistant',
        content: passLastContent,
        tool_calls: result.toolCalls!.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.args) },
        })),
      };
      const toolResultMsgs: Message[] = [assistantMsg];

      for (const tc of result.toolCalls) {
        passToolNames.push(tc.name);
        const tool = attributorToolRegistry.get(tc.name);
        if (!tool) {
          toolResultMsgs.push({
            role: 'tool',
            content: JSON.stringify({ ok: false, output: `Unknown tool: ${tc.name}` }),
            tool_call_id: tc.id,
          });
          continue;
        }

        const argsSummary = Object.fromEntries(
          Object.entries(tc.args ?? {}).map(([k, v]) => {
            const s = String(v);
            return [k, s.length > 120 ? s.slice(0, 120) + '…' : s];
          }),
        );
        logger.info('attributor', { event: 'tool.call', data: { name: tc.name, args: argsSummary } });
        const toolResult = await tool.call(tc.args);
        const outputPreview = toolResult.output.length > 120
          ? toolResult.output.slice(0, 120) + '…'
          : toolResult.output;
        logger.info('attributor', { event: 'tool.result', data: { name: tc.name, ok: toolResult.ok, preview: outputPreview } });

        toolResultMsgs.push({
          role: 'tool',
          content: JSON.stringify({ ok: toolResult.ok, output: toolResult.output }),
          tool_call_id: tc.id,
        });
      }

      passMessages = [...passMessages, ...toolResultMsgs];
    }

    return { lastContent: passLastContent, toolNames: passToolNames };
  }

  let lastContent = '';
  const attributorToolNames: string[] = [];
  const requiresWriteSkill = contractRequiresWriteSkill(activeMilestone, contractBlock);

  try {
    const firstPass = await runAttributorPass(userMessage);
    lastContent = firstPass.lastContent;
    attributorToolNames.push(...firstPass.toolNames);
  } catch (e) {
    return { flag: 'REPLAN', reason: `Attributor LLM 调用失败: ${String(e)}`, rawContent: '' };
  }

  // Parse CONTROL flag and REASON from the end of content
  let parsed = parseControlFlag(lastContent);
  let writeSkillCount = countWriteSkillToolCalls(attributorToolNames);
  let gated = applyResearchWriteSkillGate(parsed, writeSkillCount, isResearch);

  if (shouldRetryResearchWriteSkillPass(writeSkillCount, requiresWriteSkill, parsed.flag, gated.gated)) {
    logger.warn('attributor', {
      event: 'research.write_skill_retry',
      data: { writeSkillCount, originalFlag: parsed.flag },
    });
    try {
      const retryPass = await runAttributorPass(
        `${userMessage}\n\n---\n\n${buildWriteSkillMissedRetryReminder()}`,
      );
      lastContent = retryPass.lastContent;
      attributorToolNames.push(...retryPass.toolNames);
      parsed = parseControlFlag(lastContent);
      writeSkillCount = countWriteSkillToolCalls(attributorToolNames);
      gated = applyResearchWriteSkillGate(parsed, writeSkillCount, isResearch);
    } catch (e) {
      return { flag: 'REPLAN', reason: `Attributor 重试 LLM 失败: ${String(e)}`, rawContent: lastContent };
    }
  }

  if (shouldBlockForMissingWriteSkill(writeSkillCount, requiresWriteSkill, gated.flag, gated.gated)) {
    logger.warn('attributor', {
      event: 'research.write_skill_block',
      data: { writeSkillCount, flag: gated.flag },
    });
    return {
      flag: 'BLOCK',
      reason:
        '研究里程碑契约要求 write_skill 蒸馏，Attributor 重试后仍未调用 write_skill。' +
        '请外脑协助完成技能写入，或在内脑下一轮仅执行 write_skill。',
      rawContent: lastContent,
      researchWriteSkillBlocked: true,
    };
  }

  if (gated.gated) {
    logger.warn('attributor', {
      event: 'research.write_skill_gate',
      data: { writeSkillCount, originalFlag: parsed.flag },
    });
  }

  if (gated.flag === 'REPLAN' && gated.reason.includes('无法解析')) {
    // 记录实际输出末尾（方便排查 LLM 输出格式问题）
    logger.warn('attributor', {
      event: 'control.parse_fail',
      data: { contentLen: lastContent.length, tail: lastContent.slice(-300) },
    });
  }

  logger.info('attributor', {
    event: 'attribute.done',
    data: { flag: gated.flag, reason: gated.reason, isResearch, writeSkillCount },
  });

  return {
    flag: gated.flag,
    reason: gated.reason,
    rawContent: lastContent,
    ...(gated.gated ? { researchWriteSkillGated: true } : {}),
  };
}

/**
 * 从文本中提取 CONTROL flag 和 REASON，失败时默认 REPLAN。
 *
 * 兼容 LLM 常见的输出变体：
 *   - 中文全角冒号 "CONTROL：CONTINUE"
 *   - Markdown 加粗 "**CONTROL**: CONTINUE"
 *   - 反引号包裹 "`CONTINUE`"
 *   - 大小写混用（已有 /i flag）
 *   - 前后多余空白
 */
export function parseControlFlag(content: string): { flag: ControlFlag; reason: string } {
  // 清洗：去掉 markdown 加粗/斜体/反引号包裹，统一全角冒号为半角
  const cleaned = content
    .replace(/\*{1,2}(CONTROL|REASON)\*{1,2}/gi, '$1') // **CONTROL** → CONTROL
    .replace(/[：]/g, ':')                               // 全角冒号 → 半角
    .replace(/`([^`]+)`/g, '$1');                        // `CONTINUE` → CONTINUE

  const VALID_FLAGS = ['CONTINUE', 'SUCCESS_AND_NEXT', 'REPLAN', 'BLOCK', 'CYCLE_DONE'] as const;
  const flagPattern = VALID_FLAGS.join('|');

  const controlMatch = cleaned.match(new RegExp(`CONTROL\\s*:\\s*(${flagPattern})`, 'i'));
  const reasonMatch  = cleaned.match(/REASON\s*:\s*(.+)/i);

  if (!controlMatch?.[1]) {
    // 最后一次尝试：扫描末尾 500 字符，找独立出现的 flag 关键词
    const tail     = cleaned.slice(-500).toUpperCase();
    const fallback = VALID_FLAGS.find((f) => tail.includes(f));
    if (fallback) {
      return {
        flag:   fallback,
        reason: (reasonMatch?.[1] ?? '').trim() || '（从末尾关键词推断）',
      };
    }
    return { flag: 'REPLAN', reason: 'Attributor 输出无法解析 CONTROL flag，保守降级为 REPLAN' };
  }

  return {
    flag:   controlMatch[1].toUpperCase() as ControlFlag,
    reason: (reasonMatch?.[1] ?? '').trim() || '（无原因说明）',
  };
}
