/**
 * Constraint Governor — topic 合并 + prompt 上限（对齐 FACTS-KNOWLEDGE-GOVERNANCE §6 R5）
 *
 * ADL：doc/structurizr/FACTS-KNOWLEDGE-GOVERNANCE.md §1 constraints 行
 */

import crypto from 'node:crypto';

function norm(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

function constraintPrefix(content: string): string {
  const m = /^\[([^\]]+)\]/.exec(content.trim());
  return m?.[1]?.toLowerCase() ?? 'general';
}

/** 机械推导 constraint topic（同 topic 只保留最新一条） */
export function deriveConstraintTopic(content: string): string {
  const text = norm(content);
  const prefix = constraintPrefix(content);

  if (prefix === 'run-failure') {
    const parenRef = /（([\w/.@-]+)）/.exec(content)?.[1];
    const ref =
      /ref\s+([\w/.@-]+)/i.exec(content)?.[1] ??
      parenRef ??
      /节点\s+(\S+?)（/.exec(content)?.[1] ??
      'unknown';
    const safeRef = ref.replace(/\//g, '.');
    if (/safety_cap|安全轮次上限|safety cap/.test(text)) {
      return `run-failure.cap.${safeRef}`;
    }
    return `run-failure.${safeRef}`;
  }

  const api =
    /\/app\/book\/([a-z0-9_/-]+)/i.exec(content)?.[1] ??
    /\/api\/author\/([a-z0-9_/-]+)/i.exec(content)?.[1];
  if (api) {
    const slug = api.toLowerCase().replace(/\//g, '.').replace(/\.+$/, '');
    return `避坑.api.${slug}`;
  }
  if (/publish_article/i.test(text)) return '避坑.api.publish_article.v0';

  if (/powershell|invoke-webrequest|invoke-restmethod/.test(text) && /curl|中文|utf-8|乱码/.test(text)) {
    return '避坑.powershell.http';
  }
  if (/prosemirror|syl-editor/.test(text)) return '避坑.prosemirror';
  if (/browser_act evaluate|iife|\(function\(\)/.test(text)) return '避坑.browser.evaluate';
  if (/nativeinputvaluesetter|react.*受控|受控组件/.test(text)) return '避坑.react.input';
  if (/arco-modal|pointer events|弹窗/.test(text)) return '避坑.arco.modal';
  if (/clipboardevent|paste.*注入|分块.*paste/.test(text)) return '避坑.clipboard.paste';
  if (/\.cjs|require\(\)|type.*module|esm/.test(text)) return '避坑.node.cjs';
  if (/serial-input|章节序号/.test(text)) return '避坑.fanqie.serial';
  if (/deliverable|契约检查|输出契约/.test(text)) return '避坑.deliverable.path';
  if (/browser_run_steps|playbook/.test(text)) return '避坑.browser.playbook';
  if (/localhost|127\.0\.0\.1|secsdk/.test(text)) return '避坑.browser.localhost';
  if (/base64|atob|textdecoder/.test(text)) return '避坑.browser.b64';
  if (/cookies_file|cookie.*sessionid/.test(text)) return '避坑.fanqie.cookies';
  if (/category-choose|作品标签|分类模态/.test(text)) return '避坑.fanqie.category';

  if (prefix === '红线') {
    const key = api ? api.toLowerCase().replace(/\//g, '.') : text.slice(0, 48).replace(/\W/g, '_');
    return `红线.${key}`;
  }

  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
  return `${prefix}.${hash}`;
}

export type RecordConstraintAction = 'created' | 'replaced' | 'skipped';

export interface RecordConstraintResult {
  constraints: string[];
  action: RecordConstraintAction;
}

export function recordConstraintGoverned(
  constraints: string[],
  incoming: string,
): RecordConstraintResult {
  const content = incoming.replace(/\s+/g, ' ').trim();
  if (!content) return { constraints, action: 'skipped' };

  if (constraints.some(c => c === content)) {
    return { constraints, action: 'skipped' };
  }

  const topic = deriveConstraintTopic(content);
  const idx = constraints.findIndex(c => deriveConstraintTopic(c) === topic);
  if (idx >= 0) {
    const next = [...constraints];
    next[idx] = content;
    return { constraints: next, action: 'replaced' };
  }

  return { constraints: [...constraints, content], action: 'created' };
}

function constraintPriority(content: string): number {
  const p = constraintPrefix(content);
  if (p === '红线') return 0;
  if (p === 'run-failure') return 1;
  if (p === '避坑') return 2;
  if (p === '事实') return 3;
  return 4;
}

export interface SelectConstraintsOptions {
  max?: number;
}

export interface PromptConstraintsResult {
  lines: string[];
  omitted: number;
  section: string;
}

/** Prompt 注入：按 topic 去重（保留最新）+ 优先级排序 + 上限 */
export function selectConstraintsForPrompt(
  constraints: string[],
  opts: SelectConstraintsOptions = {},
): PromptConstraintsResult {
  const max =
    opts.max ?? (Number(process.env['INNER_CONSTRAINTS_PROMPT_MAX'] ?? 16) || 16);

  const byTopic = new Map<string, string>();
  for (const c of constraints) {
    const t = c.trim();
    if (!t) continue;
    byTopic.set(deriveConstraintTopic(t), t);
  }

  const deduped = [...byTopic.values()].sort(
    (a, b) => constraintPriority(a) - constraintPriority(b) || b.length - a.length,
  );

  const picked = deduped.slice(0, max);
  const omitted = Math.max(0, deduped.length - picked.length);
  const lines = picked.map(c => `- ${c}`);

  let section = `## 约束\n${lines.length ? lines.join('\n') : '（无）'}`;
  if (omitted > 0) {
    section += `\n\n（另有 ${omitted} 条约束已省略；用 read_memory key=constraints 查看全量）`;
  }

  return { lines, omitted, section };
}

export interface SweepConstraintsOptions {
  max?: number;
}

export interface SweepConstraintsResult {
  removed: number;
  remaining: number;
}

/** ATTRIBUTE 后：按 topic 去重并截断总量 */
export function sweepConstraints(
  constraints: string[],
  opts: SweepConstraintsOptions = {},
): { constraints: string[]; result: SweepConstraintsResult } {
  const max =
    opts.max ?? (Number(process.env['INNER_CONSTRAINTS_MAX'] ?? 40) || 40);

  const byTopic = new Map<string, string>();
  for (const c of constraints) {
    const t = c.trim();
    if (!t) continue;
    byTopic.set(deriveConstraintTopic(t), t);
  }

  let deduped = [...byTopic.values()].sort(
    (a, b) => constraintPriority(a) - constraintPriority(b) || b.length - a.length,
  );

  const before = constraints.filter(c => c.trim()).length;
  if (deduped.length > max) {
    const keep = deduped.filter(c => constraintPriority(c) <= 2);
    const rest = deduped.filter(c => constraintPriority(c) > 2);
    deduped = [...keep, ...rest].slice(0, max);
  }

  return {
    constraints: deduped,
    result: { removed: before - deduped.length, remaining: deduped.length },
  };
}
