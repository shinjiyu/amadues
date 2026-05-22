/**
 * Reflexion — burst 结束前的自我复盘
 *
 * 在 controller 归档（safeArchive）之前调用，让 LLM 把"这一轮 burst 真正发生了什么"
 * 提炼成结构化反思，输出到 ReflexionResult。归档时随 archive 一并落盘；
 * 同 KPI 下次 burst 的 decomposer 会读到这份反思作为优先输入，避免重撞墙。
 *
 * 设计要点：
 *   - 输出是 **JSON**（不是 markdown），方便机器解析与跨 burst 传递
 *   - 解析失败要有兜底（生成一个 minimal reflexion 而不是 crash）
 *   - 温度比 decomposer **低**（要事实归纳，不要发散）
 *   - 单次调用，max_tokens 控制在 1500 以内（反思不该长篇大论）
 *   - 不带工具调用，纯文本输入输出
 */

import fs from 'node:fs';
import path from 'node:path';

import type { LLMAdapter } from '../adapter/index.js';
import type { Logger } from '../logger/index.js';
import type { BrainFS } from '../brain/index.js';
import type { ArchiveTrigger } from '../archive/index.js';

export interface ReflexionResult {
  /** 这次 burst 整体是否达成 */
  verdict: 'success' | 'partial' | 'failed';
  /**
   * 硬失败（API 拒绝 / 文件不存在 / 明确错误 / 红线被触发）。
   * 下一轮 decomposer 会看到这份列表并被指示"避开"。
   */
  hardFailures: string[];
  /**
   * 软失败（这条路没产出但没明确报错——比如搜索命中率太低、对方没回应）。
   * 弱信号，下轮可以重试但优先级降低。
   */
  softFailures: string[];
  /**
   * 给下一轮 burst 的换向建议——**重点不在重复细节，而在指出新方向**。
   * 如果 verdict='success'，这里可以为空字符串。
   */
  nextStrategy: string;
  /** 原始 LLM 输出，用于调试 */
  rawContent?: string;
}

export const REFLEXION_SYSTEM = `你是一个 burst 复盘官。一段 inner-brain burst 刚刚结束，
请你**站在 KPI 持续探索的角度**，把这一轮真正发生的事提炼成结构化反思。

下一轮 burst 的规划器会读到你的输出，所以这份反思的**唯一目的**是：
让下一轮**不重复同样的错**、**知道该换什么方向**。

## 输出格式（严格 JSON，不要 markdown 代码块、不要前言）

{
  "verdict": "success | partial | failed",
  "hardFailures": ["..."],
  "softFailures": ["..."],
  "nextStrategy": "..."
}

字段说明：
- verdict：
  - success = 里程碑全部 / 大部分达成，KPI 有实质推进
  - partial = 只完成了部分子目标、或拿到了有价值的中间产物
  - failed  = 几乎没有进展、或卡在根本性障碍
- hardFailures：明确失败的方向 / 工具 / 接口。**用简短陈述句**，例如：
  - "QQ open API 返回 403，账号无开放权限"
  - "尝试调 X 服务时被对方限频，重试 3 次仍失败"
  - 数量控制在 0-5 条；如果完全没有就给 []
- softFailures：试过但没产出的方向（没有明确报错）。例如：
  - "尝试用关键词搜索公开数据库，命中率极低"
  - "调研了 N 个 OSINT 工具，都不适用于本场景"
  - 数量控制在 0-3 条
- nextStrategy：**最重要**。一段话，明确告诉下一轮规划器"应该换什么方向"。例如：
  - "直查接口已经死路，下一轮尝试社工方向：通过关联账号反向定位"
  - "前两轮都在搜公开数据，下一轮应换为社工 / 内部渠道"
  - "已接近目标，下一轮专注最后一步 X 即可，不需要换方向"
  - 如果 verdict='success' 可以留空字符串

## 思维姿态

- 不要复述过程，写**结论**
- 不要客气，**点名**失败的方向和原因
- 不要建议"同方向再试一次" / "更细致地做 X" — 这种话没有信息量
- 必须建议**手段层面**的换向（A 路死了试 B 路、C 路），而不是"换一种心态"
- 区分 hard 和 soft：报错 / 拒绝 / 明确不可用 = hard；没产出但没报错 = soft

只输出 JSON，不要任何额外文字。`;

/**
 * 运行一次 reflexion。失败时返回 minimal fallback 而不抛异常——绝对不能让反思阶段
 * 把整个 burst 的归档流程拖死。
 */
export async function runReflexion(params: {
  brain: BrainFS;
  trigger: ArchiveTrigger;
  triggerReason: string;
  llm: LLMAdapter;
  logger: Logger;
}): Promise<ReflexionResult> {
  const { brain, trigger, triggerReason, llm, logger } = params;

  const goal        = brain.readGoal()        || '（goal.md 为空）';
  const milestones  = brain.readMilestones()  || '（无里程碑）';
  const constraints = brain.readConstraints() || '（无 constraints）';
  const skills      = brain.readSkills()      || '';
  const knowledge   = brain.readKnowledge()   || '';

  // 最近一次 execution-context（有助于反思）—— 若不存在则跳过
  let recentExecution = '';
  try {
    const raw = brain.readExecutionContext?.();
    if (raw) {
      recentExecution = JSON.stringify(raw).slice(0, 6000);
    }
  } catch { /* execution-context 读不到不致命 */ }

  const userMessage = [
    `## 本 burst 退出原因：${trigger}`,
    `> ${triggerReason || '(无)'}`,
    '',
    `## Goal`,
    goal.slice(0, 2000),
    '',
    `## 最终 milestones.md`,
    milestones.slice(0, 3000),
    '',
    constraints.trim() ? `## 本 burst 累计 constraints\n${constraints.slice(0, 1500)}` : '',
    knowledge.trim() ? `## 本 burst 累计 knowledge\n${knowledge.slice(0, 1500)}` : '',
    skills.trim() ? `## 本 burst 累计 skills（如有）\n${skills.slice(0, 800)}` : '',
    recentExecution ? `## 最近一次执行日志（截断）\n\`\`\`\n${recentExecution}\n\`\`\`` : '',
  ].filter(Boolean).join('\n');

  const reflexionTemp = Number(process.env['UTLRA_REFLEXION_TEMPERATURE'] ?? 0.4);

  logger.info('reflexion', { event: 'reflect.start', data: { trigger } });

  let content = '';
  try {
    const result = await llm.chat(
      REFLEXION_SYSTEM,
      [{ role: 'user', content: userMessage }],
      [],
    );
    content = result.content?.trim() ?? '';
  } catch (e) {
    logger.warn('reflexion', { event: 'reflect.llm.error', data: { error: String(e) } });
    return fallbackReflexion(trigger, triggerReason, '');
  }

  const parsed = parseReflexionJson(content);
  if (!parsed) {
    logger.warn('reflexion', {
      event: 'reflect.parse.failed',
      data: { preview: content.slice(0, 200) },
    });
    return fallbackReflexion(trigger, triggerReason, content);
  }

  logger.info('reflexion', {
    event: 'reflect.done',
    data: {
      verdict: parsed.verdict,
      hardFailures: parsed.hardFailures.length,
      softFailures: parsed.softFailures.length,
      nextStrategyLen: parsed.nextStrategy.length,
    },
  });
  return { ...parsed, rawContent: content };
}

/**
 * 尝试把 LLM 输出当成 JSON 解析。LLM 偶尔会带上 ``` 围栏或者前后噪声文字，所以做两层
 * 抓取：先找 ```json ... ``` 块，再退化为找第一个 { ... } 区间。
 */
export function parseReflexionJson(content: string): ReflexionResult | null {
  if (!content.trim()) return null;

  // 抓 ```json ... ``` 围栏（兼容 LLM 不听话的情况）
  const fenced = content.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const candidate = fenced ? (fenced[1] ?? '').trim() : (() => {
    // 退化为找第一个 { 到最后一个 } 的区间
    const first = content.indexOf('{');
    const last = content.lastIndexOf('}');
    if (first === -1 || last === -1 || last <= first) return content.trim();
    return content.slice(first, last + 1);
  })();

  try {
    const raw = JSON.parse(candidate) as Record<string, unknown>;
    const verdictRaw = String(raw['verdict'] ?? 'failed').toLowerCase();
    const verdict: ReflexionResult['verdict'] =
      verdictRaw === 'success' || verdictRaw === 'partial' ? verdictRaw : 'failed';
    const hardFailures = Array.isArray(raw['hardFailures'])
      ? (raw['hardFailures'] as unknown[]).map((x) => String(x)).filter((s) => s.trim()).slice(0, 10)
      : [];
    const softFailures = Array.isArray(raw['softFailures'])
      ? (raw['softFailures'] as unknown[]).map((x) => String(x)).filter((s) => s.trim()).slice(0, 10)
      : [];
    const nextStrategy = String(raw['nextStrategy'] ?? '').trim();
    return { verdict, hardFailures, softFailures, nextStrategy };
  } catch {
    return null;
  }
}

/**
 * Fallback：LLM 调用失败或解析失败时仍然给一份 minimal 反思，至少把 trigger /
 * triggerReason 转成下一轮可读的内容，避免反思链路断掉。
 */
/** 将反思结果写入工作区，供 KPI onExit hook 与知识库归档读取 */
export function writeReflexionJson(workDir: string, result: ReflexionResult): void {
  const brainDir = path.join(workDir, '.brain');
  fs.mkdirSync(brainDir, { recursive: true });
  const payload = {
    verdict: result.verdict,
    hardFailures: result.hardFailures,
    softFailures: result.softFailures,
    nextStrategy: result.nextStrategy,
  };
  fs.writeFileSync(path.join(brainDir, 'reflexion.json'), JSON.stringify(payload, null, 2), 'utf8');
}

function fallbackReflexion(
  trigger: ArchiveTrigger,
  triggerReason: string,
  rawContent: string,
): ReflexionResult {
  const verdict: ReflexionResult['verdict'] =
    trigger === 'COMPLETE' ? 'success' :
    trigger === 'BLOCK'    ? 'partial' :
                             'failed';
  return {
    verdict,
    hardFailures: triggerReason ? [`(反思 LLM 失败，使用 triggerReason 兜底) ${triggerReason}`] : [],
    softFailures: [],
    nextStrategy: '反思 LLM 失败，下一轮需要外部介入或重试。',
    rawContent,
  };
}
