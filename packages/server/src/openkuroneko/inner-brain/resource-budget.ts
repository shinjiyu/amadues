/**
 * DyFlow 内脑资源预算 — 统一 env 配置 + LLM 披露（上限 + 当前用量）。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §6.1d
 */

import type { Message } from '../adapter/index.js';

export const LIVE_BUDGET_MARKER = '## 资源预算（框架实时）';

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface ResourceBudgetConfig {
  maxRounds: number;
  failFastStreak?: number;
}

export function resolveBaseNodeBudget(): ResourceBudgetConfig {
  return {
    maxRounds: readPositiveIntEnv('INNER_BASE_NODE_MAX_ROUNDS', 50),
    failFastStreak: readPositiveIntEnv('INNER_BASE_NODE_FAIL_FAST_STREAK', 5),
  };
}

export function resolveDesignerBudget(): ResourceBudgetConfig {
  return {
    maxRounds: readPositiveIntEnv('INNER_DESIGNER_MAX_ROUNDS', 20),
  };
}

export function resolveAttributorBudget(): ResourceBudgetConfig {
  return {
    maxRounds: readPositiveIntEnv('INNER_ATTRIBUTOR_MAX_ROUNDS', 20),
  };
}

export interface LiveBudgetInput {
  /** 0-based，即将执行的 ReAct 轮次 */
  round: number;
  maxRounds: number;
  toolCalls: number;
  noProgressStreak?: number;
  failFastStreak?: number;
}

export function buildLiveResourceBudgetSection(input: LiveBudgetInput): string {
  const roundDisplay = input.round + 1;
  const pct = Math.min(100, Math.round((roundDisplay / input.maxRounds) * 100));
  const lines = [
    LIVE_BUDGET_MARKER,
    `- ReAct 轮次：**${roundDisplay} / ${input.maxRounds}**（${pct}%，硬上限触顶强制上交）`,
    `- 本阶段工具调用：**${input.toolCalls}** 次`,
  ];
  if (input.failFastStreak != null && input.noProgressStreak != null) {
    lines.push(
      `- 连续无进展：**${input.noProgressStreak} / ${input.failFastStreak}**（触顶 fail-fast 上交 Designer）`,
    );
  }
  if (pct >= 90) {
    lines.push(
      '',
      '**紧急**：预算已用尽九成，必须立即收束——写入交付文件 / record_fact / 自然结束或 `CANNOT_CONTINUE(transient):`',
    );
  } else if (pct >= 80) {
    lines.push('', '**提醒**：预算已用八成，应收敛探索、沉淀结论，避免继续试探性调用。');
  } else if (pct >= 60) {
    lines.push('', '**提示**：过半预算已用，优先完成子目标产出，勿开新探索支线。');
  }
  return lines.join('\n');
}

export function buildStaticResourceBudgetSection(
  role: 'baseNode' | 'designer' | 'attributor',
): string {
  if (role === 'baseNode') {
    const cfg = resolveBaseNodeBudget();
    return [
      '## 资源预算（框架硬上限）',
      `- 本节点 ReAct 最多 **${cfg.maxRounds}** 轮（\`INNER_BASE_NODE_MAX_ROUNDS\`）`,
      `- 连续 **${cfg.failFastStreak ?? 5}** 轮工具均无 ok:true → fail-fast 上交 Designer`,
      '- 每轮会注入「当前用量」；达上限未收敛 → safety_cap',
      '- ≥80% 时应收束：写交付 / record_fact / CANNOT_CONTINUE(transient)',
      '- 禁止为试探性调用耗尽预算；已有事实优先复用 memory.facts',
    ].join('\n');
  }
  if (role === 'designer') {
    const self = resolveDesignerBudget();
    const base = resolveBaseNodeBudget();
    return [
      '## 资源预算（框架硬上限）',
      `- 本 DESIGN tick 最多 **${self.maxRounds}** 轮工具（\`INNER_DESIGNER_MAX_ROUNDS\`）`,
      `- 每个 preset/base 节点预算约 **${base.maxRounds}** 轮 ReAct；拆小节点，勿巨型探路 instruction`,
      '- 每轮会注入「当前用量」；编排时考虑单格预算，避免一格吃完 50 轮仍无交付',
    ].join('\n');
  }
  const cfg = resolveAttributorBudget();
  return [
    '## 资源预算（框架硬上限）',
    `- 本 ATTRIBUTE 阶段最多 **${cfg.maxRounds}** 轮工具（\`INNER_ATTRIBUTOR_MAX_ROUNDS\`）`,
    '- 每轮会注入「当前用量」；写完 facts/constraints 即停止调工具',
  ].join('\n');
}

function stripLiveBudgetPrefix(text: string): string {
  const markerIdx = text.indexOf(LIVE_BUDGET_MARKER);
  if (markerIdx < 0) return text;
  const sep = '\n\n---\n\n';
  const sepIdx = text.indexOf(sep, markerIdx);
  if (sepIdx < 0) return text;
  return text.slice(sepIdx + sep.length);
}

/**
 * 每轮把 live 预算写入**首条** user 消息前缀（覆盖旧块），不追加独立消息。
 * 保证任务正文仍在同一条 user 里，且 ReAct 历史长度不因预算块膨胀。
 */
export function upsertLiveBudgetMessage(messages: Message[], section: string): Message[] {
  const budgetPrefix = `${section}\n\n---\n\n`;
  const firstUserIdx = messages.findIndex(m => m.role === 'user');
  if (firstUserIdx < 0) {
    return [{ role: 'user', content: section }];
  }
  return messages.map((msg, i) => {
    if (i !== firstUserIdx || typeof msg.content !== 'string') return msg;
    const body = stripLiveBudgetPrefix(msg.content);
    return { ...msg, content: `${budgetPrefix}${body}` };
  });
}
