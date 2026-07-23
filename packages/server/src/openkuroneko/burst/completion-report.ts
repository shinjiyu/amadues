/**
 * 内脑任务完成报告正文（IM / COMPLETE 事件共用）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { BrainFS } from '../brain/brain-fs.js';

const REPORT_DELIVERABLE_EXCERPT_MAX = 2800;
/** IM 只留短结论；长文看附件（调试期曾用 2200） */
const REPORT_DELIVERABLE_EXCERPT_IM_MAX = 480;
const REPORT_KNOWLEDGE_MAX = 2000;
const REPORT_LAST_CONTENT_MAX = 600;
const REPORT_LAST_CONTENT_IM_MAX = 360;
const REPORT_GOAL_MAX = 400;
const REPORT_IM_MAX_TOTAL = 900;
const REPORT_COMPLETE_MESSAGE_IM_MAX = 480;

/** `im` = 用户 IM 通知（结果优先、去过程噪音）；`verbose` = 外脑记忆/排障（保留完整章节） */
export type CompletionReportAudience = 'im' | 'verbose';

/** 完成报告中的执行评估块（通常来自 memory.json last_failure） */
export interface CompletionAssessment {
  verdict: string;
  hardFailures: string[];
  softFailures: string[];
  nextStrategy: string;
}

export interface CompletionReportInput {
  goal: string;
  milestones: string;
  knowledge: string | null;
  lastExecLog: import('../brain/index.js').ExecutionEntry[] | null;
  completionAssessment: CompletionAssessment | null;
  deliverables: string[];
  /** 主产物文件摘要（报告类 .md） */
  resultExcerpt?: string | null;
  /** pi-mono output 最后一条 COMPLETE.message（IM 优先于 knowledge） */
  completeMessage?: string | null;
}

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
    const abs = path.join(workDir, rel);
    try {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      const raw = fs.readFileSync(abs, 'utf8').trim();
      if (raw.length < 20) continue;
      const lower = rel.toLowerCase();
      if (lower.endsWith('.md')) {
        const excerpt =
          raw.length > REPORT_DELIVERABLE_EXCERPT_MAX
            ? raw.slice(0, REPORT_DELIVERABLE_EXCERPT_MAX) + '\n\n…（全文见附件或工作区文件）'
            : raw;
        return `（摘自 \`${rel}\`）\n\n${excerpt}`;
      }
      if (lower.endsWith('.json')) {
        let body = raw;
        try {
          body = JSON.stringify(JSON.parse(raw), null, 2);
        } catch {
          /* keep raw */
        }
        const clip =
          body.length > REPORT_DELIVERABLE_EXCERPT_MAX
            ? body.slice(0, REPORT_DELIVERABLE_EXCERPT_MAX) + '\n\n…（全文见附件）'
            : body;
        return `（摘自 \`${rel}\`）\n\n\`\`\`json\n${clip}\n\`\`\``;
      }
      if (lower.endsWith('.txt')) {
        const clip =
          raw.length > REPORT_DELIVERABLE_EXCERPT_MAX
            ? raw.slice(0, REPORT_DELIVERABLE_EXCERPT_MAX) + '\n\n…（全文见附件）'
            : raw;
        return `（摘自 \`${rel}\`）\n\n${clip}`;
      }
    } catch {
      continue;
    }
  }
  return null;
}

export function buildCompletionReport(
  input: CompletionReportInput,
  options?: { audience?: CompletionReportAudience },
): string {
  if ((options?.audience ?? 'im') === 'im') {
    return buildImCompletionReport(input);
  }
  return buildVerboseCompletionReport(input);
}

function buildVerboseCompletionReport(input: CompletionReportInput): string {
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

  if (input.completionAssessment) {
    const r = input.completionAssessment;
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

/**
 * 记忆尾巴标记（`BrainFS.tail` 截断提示）。命中即视为「seed facts 记忆堆」，
 * 不得当 IM 结论（ADL INNER-BRAIN-IM-NOTIFY-BOUNDARY §4.2 G1）。
 */
function isMemoryDump(s: string): boolean {
  return /省略前文\s*\d+\s*字符|仅展示最近内容/.test(s);
}

/**
 * 用户 IM：白话短结论，不贴长报告 / 文件清单 / 调试小节。
 * 有附件时正文更短——详情看附件；verbose 仍保留完整排障章节。
 */
function buildImCompletionReport(input: CompletionReportInput): string {
  const hasFiles = input.deliverables.length > 0;
  const completeMessageRaw = (input.completeMessage ?? '').trim();
  const completeMessage =
    completeMessageRaw && !isMemoryDump(completeMessageRaw) ? completeMessageRaw : '';
  const lastRaw = pickLastAssistantContent(input.lastExecLog);
  const lastContent = lastRaw && !isMemoryDump(lastRaw) ? lastRaw : null;
  const excerpt = (input.resultExcerpt ?? '').trim();

  // 有产物附件时：优先 COMPLETE 短结论，绝不把整份报告摘要灌进聊天
  let conclusion = '';
  if (completeMessage) {
    conclusion = clipPlainConclusion(completeMessage, REPORT_COMPLETE_MESSAGE_IM_MAX);
  } else if (lastContent) {
    conclusion = clipPlainConclusion(lastContent, REPORT_LAST_CONTENT_IM_MAX);
  } else if (!hasFiles && excerpt) {
    conclusion = clipPlainConclusion(
      stripExcerptPreamble(excerpt, REPORT_DELIVERABLE_EXCERPT_IM_MAX),
      REPORT_DELIVERABLE_EXCERPT_IM_MAX,
    );
  } else if (hasFiles) {
    conclusion = '做完了，详情看附件。';
  } else {
    conclusion = '做完了。';
  }

  const parts: string[] = [conclusion];

  const hard = input.completionAssessment?.hardFailures.filter((s) => s.trim()) ?? [];
  if (hard.length > 0) {
    const bits = hard.slice(0, 2).map((h) => h.trim());
    parts.push(`另外：${bits.join('；')}${hard.length > 2 ? '…' : ''}`);
  }

  let text = parts.join('\n\n').trim();
  if (text.length > REPORT_IM_MAX_TOTAL) {
    text = text.slice(0, REPORT_IM_MAX_TOTAL) + '…';
  }
  return text;
}

/** 去掉 markdown 标题堆叠，压成适合聊天的一两段白话 */
function clipPlainConclusion(raw: string, maxLen: number): string {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !isSummaryNoiseLine(l) && !/^#{1,6}\s/.test(l));
  let body = lines.join('\n').trim() || raw.trim();
  // 多段时只留前两段，避免过程流水账
  const paras = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paras.length > 2) body = paras.slice(0, 2).join('\n\n');
  if (body.length <= maxLen) return body;
  return body.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
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

/** IM 完成报告的模板小节名（非内容标题，摘要时跳过） */
const IM_TEMPLATE_HEADINGS = new Set(['结果', '产出文件', '需注意', '核心结论', '关键事实']);

/** 摘要噪声行：引用块 / 表格 / 代码 / 列表 / 截断标记 / 表格分隔线（ADL §4.2 G2） */
function isSummaryNoiseLine(l: string): boolean {
  if (!l) return true;
  if (/^[>|`*=—–]/.test(l)) return true;
  if (l.startsWith('- ') || l.startsWith('…') || l.startsWith('（摘自') || l.startsWith('（省略')) {
    return true;
  }
  if (/^[-|:\s]+$/.test(l)) return true; // markdown 表格分隔线
  if (isMemoryDump(l)) return true;
  return false;
}

function clipImSummary(s: string): string {
  const normalized = s.replace(/\s+/g, ' ').trim();
  const one = normalized.slice(0, 120);
  return one.length < normalized.length ? `${one}…` : one;
}

/** IM 通知首行摘要（列表预览用）：优先正文内容标题，否则首句干净散文 */
export function pickImSummary(reportBody: string): string {
  const lines = reportBody.split('\n').map((l) => l.trim());

  // 1) 正文里第一个「内容标题」（跳过模板小节名与过短标题）
  for (const l of lines) {
    const m = l.match(/^#{1,6}\s+(.+)$/);
    if (m) {
      const title = m[1]!.trim();
      if (!IM_TEMPLATE_HEADINGS.has(title) && title.length >= 4 && !isSummaryNoiseLine(title)) {
        return clipImSummary(title);
      }
    }
  }

  // 2) 退而求其次：第一行干净的散文句
  const prose = lines.find((l) => !l.startsWith('#') && !isSummaryNoiseLine(l) && l.length > 8);
  return prose ? clipImSummary(prose) : '内脑任务已完成';
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
