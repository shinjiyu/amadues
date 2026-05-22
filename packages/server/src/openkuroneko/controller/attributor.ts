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

/** Attributor 中单条工具结果的最大内联字符数（Executor 已压缩，此处做二次保底截断） */
const ATTR_RESULT_MAX  = 2000;
/** Attributor 中 preState / postState 的最大字符数 */
const ATTR_STATE_MAX   = 3000;
/** Attributor 中错误摘要单条最大字符数 */
const ATTR_ERROR_MAX   = 500;

export type ControlFlag = 'CONTINUE' | 'SUCCESS_AND_NEXT' | 'REPLAN' | 'BLOCK' | 'CYCLE_DONE';

export interface AttributeResult {
  flag: ControlFlag;
  reason: string;
  rawContent: string;
}

export const ATTRIBUTOR_SYSTEM = `你是一个强制归因器（Mandatory Attributor）。每次执行结束后，
你必须按顺序完成以下五项任务：

【任务 1 — 归因分析】（内部推理）
分析执行日志，找出「进展/停滞/成功/失败」的根本原因。

【任务 2 — 约束提取】（可选，失败时优先）
如果发现了应该永久避免的操作模式，调用 write_constraint 工具。
格式："[红线] <禁止行为> — <原因>"
      "[避坑] <注意事项> — <适用场景>"

【任务 3 — 技能提取】（严格可选，决策树如下）
用户消息末尾会附上「已有相关技能列表」。请先查阅：

  ① 技能列表中已有高度相似的技能（标题/标签吻合）
    → **不要调用 write_skill**
    → 若本次执行中 Executor 明显没有利用该已有技能（重复犯同样错误）：
        调用 write_constraint："[红线] 执行「<里程碑标题>」类任务时，必须参考技能库中的「<技能标题>」(id: <id>)"
    → 否则直接跳过任务 3

  ② 技能列表中没有类似技能，且满足以下**全部**新增条件：
    ✅ 本次执行完成了一个非平凡目标（不是仅读文件、仅扫目录、仅同步状态等）
    ✅ 解决方案含有至少 3 步操作且包含决策逻辑，而非单一工具调用
    ✅ 该模式可以"原样复用"于未来不同任务，不含具体路径/文件名
    ❌ 禁止写入：「读取文件/扫描目录」「更新/同步里程碑」「创建目录」等机械性单步操作
    → **调用 write_skill** 写入新技能
    格式：
      场景：<通用场景描述，不含具体文件名>
      步骤：<有效操作序列，至少 3 步>
      验证：<如何确认成功>

【任务 4 — 知识提取】（可选）
如果发现了关于环境/项目的新客观事实，调用 write_knowledge 工具。
格式："[事实] <内容>"

【任务 5 — 控制决策】（必做，最后输出）
最后两行必须是：
CONTROL: <CONTINUE|SUCCESS_AND_NEXT|REPLAN|BLOCK|CYCLE_DONE>
REASON: <一句话说明原因>

判断标准：
- CONTINUE：有实质进展但里程碑未完成，继续执行
- SUCCESS_AND_NEXT：里程碑目标已达成（含循环里程碑的终止条件满足）
- REPLAN：遇到根本性障碍，当前计划不可行，且无人类协助需求，需要重新规划
- BLOCK：无法独立解决，需要外脑或人类介入（Human-in-the-loop）
- CYCLE_DONE：**仅用于 [cyclic:N] 标签的循环里程碑**，本轮循环工作已完成，
  目标终止条件尚未满足，等待下一个周期再继续。
  REASON 中必须写明：本轮做了什么 + 下一轮应从何处继续。

【Human-in-the-loop 优先】以下情况必须使用 BLOCK，不要用 REPLAN：
- 目标需要登录/认证才能访问（如微博、需登录的网站、API 需 key），且当前无法自动登录
- 需要人类提供数据、文件、链接或手工执行某操作（如授权、确认、粘贴内容）后才能继续
- 执行日志中出现「需登录」「Sina Visitor System」「无法获取公开数据」「permission denied」等且无程序化替代方案
BLOCK 时 REASON 必须写清：需要人类具体做什么（例如：请提供 steph808 的公开信息摘要 / 请登录微博后告知继续 / 请将 XXX 文件放入工作目录后回复「已放入」）。

硬性规则（优先于其他判断）：
- 执行日志为空（没有任何工具调用）→ 必须 REPLAN
- 连续两次完全相同的工具调用均失败、且不属于上述「需人类协助」情形 → REPLAN
- 属于「需人类协助」情形 → 必须 BLOCK
- 无法判断是否有进展且不涉及人类协助 → 倾向 REPLAN，而非 CONTINUE

【里程碑契约】若用户消息含「本里程碑契约」且执行日志明显违背其中的「输入范围」或「禁止或尽量减少」（例如约定只读文档却大量 cat 源码），应在 REASON 中点名；除非已达成「必交付物」，否则一般返回 CONTINUE 并提示下一轮回归契约。`;

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

  let currentMessages: Message[] = [{ role: 'user', content: userMessage }];
  let lastContent = '';

  /** 单次 Attributor 最多工具调用轮次（write_constraint/skill/knowledge），防止无限循环 */
  const MAX_ATTR_ROUNDS = 20;

  // Attributor tool call loop (write_constraint / write_skill / write_knowledge)
  for (let round = 0; round < MAX_ATTR_ROUNDS; round++) {
    if (round === MAX_ATTR_ROUNDS - 1) {
      logger.warn('attributor', { event: 'llm.max_rounds', data: { round } });
    }
    logger.info('attributor', { event: 'llm.call', data: { round } });

    let result;
    try {
      result = await llm.chat(ATTRIBUTOR_SYSTEM, currentMessages, attributorToolRegistry.schema());
    } catch (e) {
      logger.error('attributor', { event: 'llm.error', data: { error: String(e) } });
      return { flag: 'REPLAN', reason: `Attributor LLM 调用失败: ${String(e)}`, rawContent: '' };
    }

    lastContent = result.content ?? '';

    if (!result.toolCalls || result.toolCalls.length === 0) {
      logger.info('attributor', { event: 'llm.done', data: { round, contentLen: lastContent.length } });
      break;
    }

    const assistantMsg: Message = {
      role: 'assistant',
      content: lastContent,
      tool_calls: result.toolCalls!.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })),
    };
    const toolResultMsgs: Message[] = [assistantMsg];

    for (const tc of result.toolCalls) {
      const tool = attributorToolRegistry.get(tc.name);
      if (!tool) {
        toolResultMsgs.push({
          role: 'tool',
          content: JSON.stringify({ ok: false, output: `Unknown tool: ${tc.name}` }),
          tool_call_id: tc.id,
        });
        continue;
      }

      // 对 args 做摘要（截断长字段，防止日志过大）
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

    currentMessages = [...currentMessages, ...toolResultMsgs];
  }

  // Parse CONTROL flag and REASON from the end of content
  const parsed = parseControlFlag(lastContent);

  if (parsed.flag === 'REPLAN' && parsed.reason.includes('无法解析')) {
    // 记录实际输出末尾（方便排查 LLM 输出格式问题）
    logger.warn('attributor', {
      event: 'control.parse_fail',
      data: { contentLen: lastContent.length, tail: lastContent.slice(-300) },
    });
  }

  logger.info('attributor', {
    event: 'attribute.done',
    data: { flag: parsed.flag, reason: parsed.reason },
  });

  return { ...parsed, rawContent: lastContent };
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
