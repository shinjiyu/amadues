/**
 * 内脑任务完成报告正文（IM / COMPLETE 事件共用）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { BrainFS } from '../brain/brain-fs.js';

const REPORT_DELIVERABLE_EXCERPT_MAX = 2800;
const REPORT_DELIVERABLE_EXCERPT_IM_MAX = 2200;
const REPORT_KNOWLEDGE_MAX = 2000;
const REPORT_KNOWLEDGE_IM_MAX = 900;
const REPORT_LAST_CONTENT_MAX = 600;
const REPORT_LAST_CONTENT_IM_MAX = 450;
const REPORT_GOAL_MAX = 400;
const REPORT_IM_MAX_TOTAL = 3200;
const REPORT_IM_MAX_DELIVERABLE_LINES = 8;

/** `im` = 用户 IM 通知（结果优先、去过程噪音）；`verbose` = 外脑记忆/排障（保留完整章节） */
export type CompletionReportAudience = 'im' | 'verbose';

/** 里程碑只保留一行标题，去掉「输入范围/必交付物」等过程约束 */
export function shortenMilestonesForReport(milestonesMd: string): string {
  const lines = milestonesMd.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^\[M(\d+)\]\s*\[([^\]]+)\]\s*(.+)$/);
    if (m) {
      const title = m[3]!.split('—')[0]!.split(' - ')[0]!.trim();
      out.push(`- [M${m[1]}] [${m[2]}] ${title.slice(0, 120)}`);
      continue;
    }
    if (t.startsWith('>') || t.startsWith('#')) continue;
  }
  return out.length > 0 ? out.join('\n') : milestonesMd.trim().slice(0, 800);
}

/** 从登记产物中选取主报告文件并截取摘要 */
export function pickDeliverableExcerpt(workDir: string, deliverablePaths: string[]): string | null {
  if (!deliverablePaths.length) return null;

  const score = (p: string): number => {
    const base = path.basename(p).toLowerCase();
    if (/report|评估|画像|总结/.test(base)) return 100;
    if (/evaluation|contributor/.test(base)) return 90;
    if (base.endsWith('.md')) return 50;
    if (base.endsWith('.json')) return 10;
    return 20;
  };

  const sorted = [...deliverablePaths].sort((a, b) => score(b) - score(a));
  for (const rel of sorted) {
    if (!rel.toLowerCase().endsWith('.md')) continue;
    const abs = path.join(workDir, rel);
    try {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      const raw = fs.readFileSync(abs, 'utf8').trim();
      if (raw.length < 40) continue;
      const excerpt =
        raw.length > REPORT_DELIVERABLE_EXCERPT_MAX
          ? raw.slice(0, REPORT_DELIVERABLE_EXCERPT_MAX) + '\n\n…（全文见附件或工作区文件）'
          : raw;
      return `（摘自 \`${rel}\`）\n\n${excerpt}`;
    } catch {
      continue;
    }
  }
  return null;
}

export function buildCompletionReport(
  input: {
    goal: string;
    milestones: string;
    knowledge: string | null;
    lastExecLog: import('../brain/index.js').ExecutionEntry[] | null;
    reflexion: {
      verdict: string;
      hardFailures: string[];
      softFailures: string[];
      nextStrategy: string;
    } | null;
    deliverables: string[];
    /** 主产物文件摘要（报告类 .md） */
    resultExcerpt?: string | null;
  },
  options?: { audience?: CompletionReportAudience },
): string {
  if ((options?.audience ?? 'im') === 'im') {
    return buildImCompletionReport(input);
  }
  return buildVerboseCompletionReport(input);
}

function buildVerboseCompletionReport(input: {
  goal: string;
  milestones: string;
  knowledge: string | null;
  lastExecLog: import('../brain/index.js').ExecutionEntry[] | null;
  reflexion: {
    verdict: string;
    hardFailures: string[];
    softFailures: string[];
    nextStrategy: string;
  } | null;
  deliverables: string[];
  resultExcerpt?: string | null;
}): string {
  const sections: string[] = [];
  sections.push('所有里程碑已完成。');

  const knowledgeText = (input.knowledge ?? '').trim();
  const lastContent = pickLastAssistantContent(input.lastExecLog);
  const excerpt = (input.resultExcerpt ?? '').trim();

  if (excerpt) {
    sections.push('');
    sections.push('## 核心结论（产物摘要）');
    sections.push(excerpt);
  } else if (knowledgeText) {
    sections.push('');
    sections.push('## 核心结论');
    sections.push(BrainFS.tail(knowledgeText, 900));
  } else if (lastContent) {
    sections.push('');
    sections.push('## 核心结论');
    const clip =
      lastContent.length > REPORT_LAST_CONTENT_MAX
        ? lastContent.slice(0, REPORT_LAST_CONTENT_MAX) + '…'
        : lastContent;
    sections.push(clip);
  }

  if (knowledgeText && excerpt) {
    sections.push('');
    sections.push('## 关键事实');
    sections.push(BrainFS.tail(knowledgeText, REPORT_KNOWLEDGE_MAX));
  } else if (knowledgeText && !excerpt) {
    sections.push('');
    sections.push('## 关键事实');
    sections.push(BrainFS.tail(knowledgeText, REPORT_KNOWLEDGE_MAX));
  }

  if (input.deliverables.length > 0) {
    sections.push('');
    sections.push('## 产出文件');
    for (const p of input.deliverables) sections.push(`- ${p}`);
  }

  if (lastContent) {
    sections.push('');
    sections.push('## 执行器末轮总结');
    const max = excerpt || knowledgeText ? REPORT_LAST_CONTENT_MAX : 800;
    sections.push(
      lastContent.length > max ? lastContent.slice(0, max) + '…' : lastContent,
    );
  }

  if (input.reflexion) {
    const r = input.reflexion;
    sections.push('');
    sections.push('## 执行评估');
    sections.push(`- verdict: ${r.verdict}`);
    if (r.nextStrategy) sections.push(`- nextStrategy: ${r.nextStrategy}`);
    if (r.hardFailures.length > 0) sections.push(`- 硬失败:\n  - ${r.hardFailures.join('\n  - ')}`);
    if (r.softFailures.length > 0) sections.push(`- 软失败:\n  - ${r.softFailures.join('\n  - ')}`);
  }

  const goalShort = input.goal.trim();
  if (goalShort) {
    sections.push('');
    sections.push('## 任务目标（摘要）');
    sections.push(
      goalShort.length > REPORT_GOAL_MAX
        ? goalShort.slice(0, REPORT_GOAL_MAX) + '…'
        : goalShort,
    );
  }

  sections.push('');
  sections.push('## 里程碑进度');
  sections.push(input.milestones.trim() || '（无）');

  return sections.join('\n');
}

/** 用户 IM：只保留结论 + 产出列表 + 硬失败；不重复 milestones / reflexion 软噪音 */
function buildImCompletionReport(input: {
  goal: string;
  milestones: string;
  knowledge: string | null;
  lastExecLog: import('../brain/index.js').ExecutionEntry[] | null;
  reflexion: {
    verdict: string;
    hardFailures: string[];
    softFailures: string[];
    nextStrategy: string;
  } | null;
  deliverables: string[];
  resultExcerpt?: string | null;
}): string {
  const sections: string[] = [];
  const excerpt = (input.resultExcerpt ?? '').trim();
  const knowledgeText = (input.knowledge ?? '').trim();
  const lastContent = pickLastAssistantContent(input.lastExecLog);

  if (excerpt) {
    sections.push('## 结果');
    sections.push(stripExcerptPreamble(excerpt, REPORT_DELIVERABLE_EXCERPT_IM_MAX));
  } else if (knowledgeText) {
    sections.push('## 结果');
    sections.push(BrainFS.tail(knowledgeText, REPORT_KNOWLEDGE_IM_MAX));
  } else if (lastContent) {
    sections.push('## 结果');
    const clip =
      lastContent.length > REPORT_LAST_CONTENT_IM_MAX
        ? lastContent.slice(0, REPORT_LAST_CONTENT_IM_MAX) + '…'
        : lastContent;
    sections.push(clip);
  } else {
    sections.push('内脑已完成全部里程碑，详见产出文件或工作区。');
  }

  if (input.deliverables.length > 0) {
    sections.push('');
    sections.push('## 产出文件');
    const shown = input.deliverables.slice(0, REPORT_IM_MAX_DELIVERABLE_LINES);
    for (const p of shown) sections.push(`- \`${p}\``);
    if (input.deliverables.length > shown.length) {
      sections.push(`- …另有 ${input.deliverables.length - shown.length} 个文件`);
    }
  }

  const hard = input.reflexion?.hardFailures.filter((s) => s.trim()) ?? [];
  if (hard.length > 0) {
    sections.push('');
    sections.push('## 需注意');
    for (const h of hard.slice(0, 5)) sections.push(`- ${h.trim()}`);
    if (hard.length > 5) sections.push(`- …另有 ${hard.length - 5} 条`);
  }

  let text = sections.join('\n').trim();
  if (text.length > REPORT_IM_MAX_TOTAL) {
    text = text.slice(0, REPORT_IM_MAX_TOTAL) + '\n\n…（内容已截断，完整报告见附件或工作区文件）';
  }
  return text;
}

/** 去掉「（摘自 `path`）」行，IM 里附件已单独发送 */
function stripExcerptPreamble(excerpt: string, maxLen: number): string {
  const lines = excerpt.split('\n');
  const body =
    lines[0]?.startsWith('（摘自') && lines.length > 1
      ? lines.slice(1).join('\n').trim()
      : excerpt.trim();
  if (body.length <= maxLen) return body;
  return body.slice(0, maxLen) + '\n\n…（全文见附件）';
}

/** IM 通知首行摘要（列表预览用） */
export function pickImSummary(reportBody: string): string {
  const lines = reportBody
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('- ') && !l.startsWith('…'));
  const first = lines.find((l) => l.length > 8) ?? '内脑任务已完成';
  const one = first.replace(/\s+/g, ' ').slice(0, 120);
  return one.length < first.length ? `${one}…` : one;
}

function pickLastAssistantContent(
  log: import('../brain/index.js').ExecutionEntry[] | null,
): string | null {
  if (!log || log.length === 0) return null;
  for (let i = log.length - 1; i >= 0; i--) {
    const entry = log[i];
    if (!entry) continue;
    const out = entry.result?.output;
    if (typeof out === 'string' && out.trim()) return out.trim();
  }
  return null;
}
