/**
 * 模式 B — 反应执行器（Reactive Executor）
 *
 * 每次从 .brain/ 文件全新重建上下文（无历史感知）。
 * 运行多轮工具调用直到 LLM 停止返回 tool calls。
 * 结束后写入 execution-context.json 供 Attributor 使用。
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Message, LLMAdapter } from '../adapter/index.js';
import type { Logger } from '../logger/index.js';
import type { ToolRegistry } from '../tools/index.js';
import {
  BrainFS,
  type Milestone,
  type ExecutionEntry,
  formatMilestoneContractForPrompt,
} from '../brain/index.js';
import { captureSnapshot } from './snapshot.js';

// Executor 读取 brain 文件时的字符上限（取最近内容，防止历史噪音淹没指令）
const KNOWLEDGE_MAX    = 5000;
const CONSTRAINTS_MAX  = 4000;
const ENVIRONMENT_MAX  = 3000;
/** 渐进式披露：首轮仅注入技能索引的条数，全文通过 get_skill_content(skill_id) 按需获取 */
const SKILLS_TOP_K     = 6;

/**
 * 工具输出压缩阈值（字符数）。
 * 超过此阈值的 output：完整内容写入 .tool-outputs/ 文件，
 * LLM messages 里只放头尾摘要 + 文件路径引用。
 */
const TOOL_OUTPUT_INLINE_MAX = 3000;
/** 摘要头部保留字符数 */
const TOOL_OUTPUT_HEAD = 1500;
/** 摘要尾部保留字符数 */
const TOOL_OUTPUT_TAIL = 1000;

let _outputSeq = 0;

/**
 * 如果 output 超过阈值，将完整内容存到 workDir/.tool-outputs/<seq>-<toolName>.txt，
 * 返回带文件路径引用的摘要字符串。否则原样返回。
 */
function compressToolOutput(
  toolName: string,
  output: string,
  workDir: string,
): string {
  if (output.length <= TOOL_OUTPUT_INLINE_MAX) return output;

  const dir = path.join(workDir, '.tool-outputs');
  fs.mkdirSync(dir, { recursive: true });
  const seq = String(++_outputSeq).padStart(4, '0');
  const filename = `${seq}-${toolName.replace(/[^a-z0-9_-]/gi, '_')}.txt`;
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, output, 'utf8');

  const head = output.slice(0, TOOL_OUTPUT_HEAD);
  const tail = output.slice(output.length - TOOL_OUTPUT_TAIL);
  const omitted = output.length - TOOL_OUTPUT_HEAD - TOOL_OUTPUT_TAIL;

  return [
    `[输出过长，已截断。完整内容（${output.length} 字符）已保存至：.tool-outputs/${filename}]`,
    `--- 头部（前 ${TOOL_OUTPUT_HEAD} 字符）---`,
    head,
    `--- 省略中间 ${omitted} 字符 ---`,
    `--- 尾部（后 ${TOOL_OUTPUT_TAIL} 字符）---`,
    tail,
    `[如需完整内容，可调用 read_file 读取 .tool-outputs/${filename}]`,
  ].join('\n');
}

export const EXECUTOR_SYSTEM = `你是一个反应执行器（Reactive Executor）。你的唯一职责是：
专注完成当前 Active 里程碑，通过工具调用推进目标。

执行规则：
- 只做「当前 Active 里程碑」要求的事，不碰其他里程碑
- 若存在「待解决能力缺口」，优先补齐那些会阻塞当前里程碑推进的缺口；修复完成后，用 capability_gap_handler(action="resolve", gap="...", resolution="...") 标记已解决
- 若发现新的、不同的能力缺口，可以调用 capability_gap_handler(action="record", gap="...", reason="...") 记录，避免重复记录同一缺口
- 严格遵守 Constraints 里的所有约束，红线绝对不可越
- 特别注意 Constraints 中标注「人类指示」的条目，这是最高优先级的实时指令，必须按其执行
- 技能库首轮仅提供索引；需要某条技能的完整步骤时，调用 get_skill_content(skill_id) 获取
- 优先参考已获取的技能内容与 Constraints，避免重复探索
- 若用户消息中包含「本里程碑契约」，**契约与 Constraints 同等重要**：按「输入范围」选材，向「必交付物」收敛，并遵守「禁止或尽量减少」
- 文件路径使用相对路径（相对于工作目录）
- 不要直接修改 .brain/ 目录下的文件（由框架管理）
- 当你认为本次执行循环做得差不多了，停止调用工具
- 归因由框架强制执行，你不需要自我评估是否完成

严禁行为（必须避免）：
- ❌ 禁止将「读取到旧报告/已有文件」等价为「当前里程碑已完成」——旧文件是历史记录，不代表当前里程碑的工作已执行
- ❌ 禁止在没有实际调用工具执行操作的情况下，把里程碑标记为 [Completed]
- ❌ 里程碑要求「用浏览器/playwright 操作」时，必须实际调用 web_search(engine:playwright) 进行操作，不能跳过
- ❌ 里程碑要求「等待人类完成某操作后继续」时，必须先通过工具确认该操作已完成（如网页状态变化），不能直接跳过`;

export interface ExecutorResult {
  executionLog: ExecutionEntry[];
  lastContent: string;
  error?: string;
}

export interface PendingCapabilityGap {
  ts: string;
  gap: string;
  reason: string;
}

export interface SelfUpdatePromptContext {
  repoRoot: string;
  repoScope: 'repo_root' | 'partial';
  verifyCommands: string[];
  status: string;
  pendingMutationCount: number;
}

export interface PendingResultForLLM {
  id: string;
  kind: string;
  source?: string;
  result?: unknown;
  status: string;
  /**
   * LLM 在创建 pending 时留下的"内心独白"——expectation / success_signal / fallback。
   * 唤醒后回注上下文,实现"前后呼应"。
   */
  intent?: {
    expectation: string;
    success_signal?: string;
    fallback?: string;
  };
}

export async function runExecutor(
  brain: BrainFS,
  activeMilestone: Milestone,
  workDir: string,
  toolRegistry: ToolRegistry,
  llm: LLMAdapter,
  logger: Logger,
  options?: {
    pendingCapabilityGaps?: PendingCapabilityGap[];
    selfUpdate?: SelfUpdatePromptContext | null;
    /** 上一轮 AWAITING 期间已 resolved 但尚未消费的 pending（注入到 LLM 提示） */
    resolvedPendings?: PendingResultForLLM[];
  },
): Promise<ExecutorResult> {
  const constraints  = BrainFS.tail(brain.readConstraints()  || '暂无约束',    CONSTRAINTS_MAX);
  const environment  = BrainFS.tail(brain.readEnvironment()  || '暂无环境信息', ENVIRONMENT_MAX);
  const knowledge    = BrainFS.tail(brain.readKnowledge()    || '暂无已知事实', KNOWLEDGE_MAX);
  const pendingCapabilityGaps = options?.pendingCapabilityGaps ?? [];
  const selfUpdate = options?.selfUpdate ?? null;
  const resolvedPendings = options?.resolvedPendings ?? [];

  // 渐进式披露：仅注入技能索引（id、category、title、tags），全文通过 get_skill_content(skill_id) 按需获取
  const skillQuery = `${activeMilestone.title} ${activeMilestone.description}`;
  const matchedSkills = brain.searchSkills(skillQuery, SKILLS_TOP_K);
  let skillsSection: string;
  if (matchedSkills.length > 0) {
    const indexLines = matchedSkills.map(
      e => `- **${e.title}** | id: \`${e.id}\` | category: ${e.category} | tags: ${e.tags.join(', ') || '-'}`,
    );
    skillsSection = [
      `（已按当前任务检索到 ${matchedSkills.length} 条相关技能，仅列出索引；如需某条的完整内容与操作步骤，请调用 **get_skill_content** 并传入对应 skill_id。）`,
      '',
      ...indexLines,
      '',
      '需要某条技能的详细步骤时，请调用工具：get_skill_content(skill_id: "<上表中的 id>")',
    ].join('\n');
  } else {
    skillsSection = '暂无已积累技能。若当前工具不足以完成任务，可先调用 query_available_skills 查询外部技能库。';
  }

  const milestoneText = `[${activeMilestone.id}] [Active] ${activeMilestone.title} — ${activeMilestone.description}`;

  const allMilestones = brain.parseMilestones();
  const overview =
    allMilestones.length > 0
      ? allMilestones
          .map((ms) => {
            const here = ms.id === activeMilestone.id ? '  ← **当前执行（仅此条）**' : '';
            const shortDesc =
              ms.description.length > 160 ? `${ms.description.slice(0, 160)}…` : ms.description;
            return `- [${ms.id}] [${ms.status}] ${ms.title} — ${shortDesc}${here}`;
          })
          .join('\n')
      : '（无）';

  const contractBlock = formatMilestoneContractForPrompt(activeMilestone);
  const contractSection = contractBlock
    ? `## 本里程碑契约（拆解器制定，与 Constraints 同等重要）\n${contractBlock}`
    : `## 本里程碑契约\n（未书面约定：整合/报告类任务应**优先**使用前几步已写入的文档与 .tool-outputs，避免为「更完整」而再次全仓库 cat 源码，除非契约或 Constraints 明确要求。）`;
  const capabilityGapSection = pendingCapabilityGaps.length > 0
    ? [
        `## 待解决能力缺口（自升级待办）`,
        `以下缺口来自前几轮执行记录。若它们会阻塞当前里程碑，请先补齐，再继续主任务；补齐后务必调用 capability_gap_handler(action="resolve", ...) 标记关闭。`,
        '',
        ...pendingCapabilityGaps.map(
          (record, index) =>
            `${index + 1}. ${record.gap}` +
            (record.reason ? `\n   - 原因：${record.reason}` : '') +
            `\n   - 首次记录：${record.ts}`,
        ),
      ].join('\n')
    : `## 待解决能力缺口（自升级待办）\n（无）`;
  const selfUpdateSection = selfUpdate
    ? [
        `## 自我更新会话（受控更新）`,
        `当前任务已进入受控 self-update 模式。`,
        `- 目标仓库根：${selfUpdate.repoRoot}`,
        `- 更新范围：${selfUpdate.repoScope === 'repo_root' ? '整个 repoRoot' : '部分路径（兼容旧会话）'}`,
        `- 当前状态：${selfUpdate.status}`,
        `- 已记录变更文件数：${selfUpdate.pendingMutationCount}`,
        `- 验证命令：`,
        ...selfUpdate.verifyCommands.map((command, index) => `  ${index + 1}. ${command}`),
        '',
        `强制规则：`,
        `- 当前会话默认允许更新 repoRoot 下的仓库文件，但必须走受控写入链路以便自动备份和回滚`,
        `- 仓库源码修改只使用 write_file / edit_file；不要用 shell 直接改 repo 文件`,
        `- 修改完成后必须调用 verify_self_update`,
        `- verify_self_update 失败且无法快速修复时，调用 rollback_self_update 回滚，并停止继续扩散修改`,
        `- 如需查看会话详情，调用 read_self_update_plan`,
      ].join('\n')
    : `## 自我更新会话（受控更新）\n（当前不是 self-update 任务）`;

  const resolvedSection = resolvedPendings.length > 0
    ? [
        `## 等待已 resolved 的事件（上一轮 ask_user / wait_timer / wait_signal 的结果）`,
        `以下是你之前调用异步工具的回执,现已到达。**请按以下顺序处理**:`,
        `  1. 回忆当时你设这个 pending 的 intent(下方"挂起时的意图"),那是你"问之前/设之前已经想好的预案"`,
        `  2. 用 result 对照 intent.success_signal,判断期望是否达成`,
        `  3. 达成 → 按原计划推进；未达成 → 走 intent.fallback,或重新评估`,
        `  4. 把判断写进 knowledge / 下一步动作里,不要丢掉这段上下文`,
        '',
        ...resolvedPendings.map(r => {
          const resPreview = JSON.stringify(r.result ?? null).slice(0, 600);
          const lines = [
            `### pending=${r.id} kind=${r.kind} status=${r.status}` +
              (r.source ? ` source=${r.source}` : ''),
            `  result: ${resPreview}`,
          ];
          if (r.intent) {
            lines.push('  挂起时的意图(你当时的内心独白):');
            lines.push(`    - expectation: ${r.intent.expectation}`);
            if (r.intent.success_signal) lines.push(`    - success_signal: ${r.intent.success_signal}`);
            if (r.intent.fallback) lines.push(`    - fallback: ${r.intent.fallback}`);
          } else {
            lines.push('  (无 intent 记录,本次只能基于 result 现场判断)');
          }
          return lines.join('\n');
        }),
      ].join('\n')
    : '## 等待已 resolved 的事件\n（无）';

  const userMessage = [
    `## 当前任务（Active Milestone）\n${milestoneText}`,
    contractSection,
    `## 里程碑全景（仅理解前后文；只执行 Active）\n${overview}`,
    resolvedSection,
    `## 约束（必须严格遵守）\n${constraints}`,
    `## 当前环境\n${environment}`,
    `## 知识库（环境事实）\n${knowledge}`,
    `## 技能库（可复用操作模式，索引）\n${skillsSection}`,
    capabilityGapSection,
    selfUpdateSection,
    `## 工作目录\n${workDir}\n\n请使用工具对当前里程碑执行操作。`,
  ].join('\n\n---\n\n');

  logger.info('executor', {
    event: 'execute.start',
    data: { milestoneId: activeMilestone.id, title: activeMilestone.title },
  });

  const executionLog: ExecutionEntry[] = [];
  let currentMessages: Message[] = [{ role: 'user', content: userMessage }];
  let lastContent = '';

  /** 单次 Executor 最多工具调用轮次，防止 LLM 持续输出工具调用导致无限循环 */
  const MAX_EXEC_ROUNDS = 50;

  for (let round = 0; round < MAX_EXEC_ROUNDS; round++) {
    if (round === MAX_EXEC_ROUNDS - 1) {
      logger.warn('executor', { event: 'llm.max_rounds', data: { round, milestoneId: activeMilestone.id } });
    }
    logger.info('executor', { event: 'llm.call', data: { round } });

    let result;
    try {
      result = await llm.chat(EXECUTOR_SYSTEM, currentMessages, toolRegistry.schema());
    } catch (e) {
      const errMsg = String(e);
      logger.error('executor', { event: 'llm.error', data: { round, error: errMsg } });
      executionLog.push({
        toolName: '__llm_error__',
        args: {},
        result: { ok: false, output: errMsg },
        error: errMsg,
      });
      break;
    }

    lastContent = result.content ?? '';

    if (!result.toolCalls || result.toolCalls.length === 0) {
      logger.info('executor', { event: 'llm.done', data: { round, contentLen: lastContent.length } });
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
      const tool = toolRegistry.get(tc.name);

      if (!tool) {
        logger.warn('executor', { event: 'tool.unknown', data: { name: tc.name } });
        const entry: ExecutionEntry = {
          toolName: tc.name,
          args: tc.args,
          result: { ok: false, output: `Unknown tool: ${tc.name}` },
        };
        executionLog.push(entry);
        toolResultMsgs.push({
          role: 'tool',
          content: JSON.stringify({ ok: false, output: `Unknown tool: ${tc.name}` }),
          tool_call_id: tc.id,
        });
        continue;
      }

      logger.info('executor', {
        event: 'tool.call',
        data: { name: tc.name, args: redactArgs(tc.args) },
      });

      let toolResult: { ok: boolean; output: string };
      try {
        toolResult = await tool.call(tc.args);
      } catch (e) {
        toolResult = { ok: false, output: String(e) };
      }

      logger.info('executor', {
        event: 'tool.result',
        data: { name: tc.name, ok: toolResult.ok, preview: toolResult.output.slice(0, 120) },
      });

      // 压缩超长 output：完整内容写文件，executionLog 和 messages 用摘要
      const compressedOutput = compressToolOutput(tc.name, toolResult.output, workDir);
      const compressedResult = { ok: toolResult.ok, output: compressedOutput };

      const entry: ExecutionEntry = { toolName: tc.name, args: tc.args, result: compressedResult };
      executionLog.push(entry);

      toolResultMsgs.push({
        role: 'tool',
        content: JSON.stringify(compressedResult),
        tool_call_id: tc.id,
      });
    }

    currentMessages = [...currentMessages, ...toolResultMsgs];
  }

  logger.info('executor', {
    event: 'execute.done',
    data: { milestoneId: activeMilestone.id, toolCalls: executionLog.length },
  });

  // 更新 environment.md（执行后快照）
  try {
    const postSnap = captureSnapshot(workDir);
    brain.writeEnvironment(postSnap);
  } catch {
    // 快照失败不影响主流程
  }

  return { executionLog, lastContent };
}

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > 200) out[k] = v.slice(0, 200) + '…';
    else out[k] = v;
  }
  return out;
}
