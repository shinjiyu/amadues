/**
 * 研究类里程碑 → Attributor 强制 write_skill 蒸馏（R1）
 * @see doc/todo/cross-agent-research-and-keychain.md §问题1
 */
import type { Milestone } from '../brain/index.js';

export type ControlFlag = 'CONTINUE' | 'SUCCESS_AND_NEXT' | 'REPLAN' | 'BLOCK' | 'CYCLE_DONE';

const RESEARCH_HINT =
  /write_skill|跨\s*[Aa]gent|跨Agent|蒸馏|研究|调研|\bresearch\b/i;

export function isResearchMilestone(milestone: Milestone, contractText = ''): boolean {
  const hay = [
    milestone.title,
    milestone.description,
    contractText,
    milestone.outputsContract ?? '',
    milestone.inputsScope ?? '',
  ].join('\n');
  return RESEARCH_HINT.test(hay);
}

export const ATTRIBUTOR_RESEARCH_SKILL_SECTION = `
【研究类里程碑 · 任务 3 优先规则】（当契约/标题含 write_skill、跨Agent、研究、调研、蒸馏时，**替换**下方普通任务 3 决策树）

目标：把可复用研究结论写入技能库（drive9 /skills/shared/），供其他 Agent set_goal 时 seed 检索；**禁止**在 IM 贴全文、禁止把整份报告 paste 进 write_skill content。

在输出 SUCCESS_AND_NEXT 或 CYCLE_DONE **之前**，必须至少调用 **1 次 write_skill**（可按子主题多条）：
  ✅ tags **必须**含 \`research\` + 主题关键词 + 源 agent（若可知，如 shiro）
  ✅ category 建议 web 或 general
  ✅ content 结构：
      场景：<本研究回答什么问题>
      结论摘要：- 要点…
      方法 / 步骤：1. … 2. …
      验证：<如何确认仍成立>
      附件（按需 read_file，禁止整份写入 skill）：- <workDir 相对路径>
  ✅ 单条约 1–3k 字；长文只列路径
  ✅ 若「已有相关技能」中有相似条目 → **merge 更新** write_skill，补充新结论，不要跳过
  ❌ 禁止因「≥3 步机械操作」门槛而跳过（研究类放宽该门槛）

若里程碑实质已完成但本轮 **未** 调用 write_skill → CONTROL 必须为 **CONTINUE**，REASON 写明须先完成技能蒸馏。
`.trim();

const ATTRIBUTOR_TASK3_STANDARD = `
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
`.trim();

const ATTRIBUTOR_SYSTEM_HEAD = `你是一个强制归因器（Mandatory Attributor）。每次执行结束后，
你必须按顺序完成以下五项任务：

【任务 1 — 归因分析】（内部推理）
分析执行日志，找出「进展/停滞/成功/失败」的根本原因。

【任务 2 — 约束提取】（可选，失败时优先）
如果发现了应该永久避免的操作模式，调用 write_constraint 工具。
格式："[红线] <禁止行为> — <原因>"
      "[避坑] <注意事项> — <适用场景>"`;

const ATTRIBUTOR_SYSTEM_TAIL = `
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

/** 默认 Attributor 系统提示（非研究里程碑） */
export const ATTRIBUTOR_SYSTEM = [
  ATTRIBUTOR_SYSTEM_HEAD,
  ATTRIBUTOR_TASK3_STANDARD,
  ATTRIBUTOR_SYSTEM_TAIL,
].join('\n\n');

export function buildAttributorSystemPrompt(isResearch: boolean): string {
  if (!isResearch) return ATTRIBUTOR_SYSTEM;
  return [ATTRIBUTOR_SYSTEM_HEAD, ATTRIBUTOR_RESEARCH_SKILL_SECTION, ATTRIBUTOR_SYSTEM_TAIL].join('\n\n');
}

export function buildResearchMilestoneReminder(): string {
  return [
    '## 研究类里程碑提醒',
    '本里程碑须通过 **write_skill** 蒸馏可复用结论（tags 含 research + 主题词）。',
    'SUCCESS_AND_NEXT / CYCLE_DONE 前至少 1 次 write_skill；长报告只列 workDir 相对路径，禁止 paste 全文。',
  ].join('\n');
}

export function applyResearchWriteSkillGate(
  parsed: { flag: ControlFlag; reason: string },
  writeSkillCount: number,
  isResearch: boolean,
): { flag: ControlFlag; reason: string; gated: boolean } {
  if (!isResearch || writeSkillCount > 0) {
    return { ...parsed, gated: false };
  }
  if (parsed.flag !== 'SUCCESS_AND_NEXT' && parsed.flag !== 'CYCLE_DONE') {
    return { ...parsed, gated: false };
  }
  return {
    flag: 'CONTINUE',
    reason:
      `研究类里程碑须先 write_skill 蒸馏（本轮 write_skill=0）。` +
      (parsed.reason ? ` 原决策：${parsed.reason}` : ''),
    gated: true,
  };
}

export function countWriteSkillToolCalls(toolNames: string[]): number {
  return toolNames.filter((n) => n === 'write_skill').length;
}

/** 契约明确要求 write_skill / 跨Agent 共享（比 isResearchMilestone 更严，用于 R2 兜底） */
export function contractRequiresWriteSkill(milestone: Milestone, contractText = ''): boolean {
  const hay = [contractText, milestone.outputsContract ?? ''].join('\n');
  return /write_skill|跨\s*[Aa]gent|跨Agent/i.test(hay);
}

export function buildWriteSkillMissedRetryReminder(): string {
  return [
    '## 【框架提醒 — 须立即 write_skill】',
    '本里程碑契约要求技能蒸馏，但你尚未调用 write_skill。',
    '请**现在**至少调用 1 次 write_skill（tags 含 research + 主题词；长报告只列 workDir 相对路径）。',
    '完成后再输出 CONTROL；若仍跳过，框架将 BLOCK 并通知外脑。',
  ].join('\n');
}

/** R2：重试 Attributor 仅-蒸馏 pass 前 */
export function shouldRetryResearchWriteSkillPass(
  writeSkillCount: number,
  requiresWriteSkill: boolean,
  flag: ControlFlag,
  gated: boolean,
): boolean {
  if (!requiresWriteSkill || writeSkillCount > 0) return false;
  if (gated) return true;
  return flag === 'SUCCESS_AND_NEXT' || flag === 'CYCLE_DONE';
}

/** R2：重试后仍缺 write_skill → 外脑 BLOCK */
export function shouldBlockForMissingWriteSkill(
  writeSkillCount: number,
  requiresWriteSkill: boolean,
  flag: ControlFlag,
  gated: boolean,
): boolean {
  if (!requiresWriteSkill || writeSkillCount > 0) return false;
  if (gated) return true;
  return flag === 'SUCCESS_AND_NEXT' || flag === 'CYCLE_DONE';
}

export const OUTER_RESEARCH_KPI_GOAL_LINE =
  '研究类 KPI：交付 = workDir 报告 + 内脑 write_skill 蒸馏；群聊只许一行摘要，禁止贴全文。';
