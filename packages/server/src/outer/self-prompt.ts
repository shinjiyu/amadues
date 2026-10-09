/**
 * 内心独白（self-prompt）— ADL doc/structurizr/AGENT-SUBJECT-DESIGN.md §3 拆服从
 *
 * subject 模式下 user 位置不再放人类原话，改放 agent 自己的处境：当前目标、容量、时间、
 * 已评估的外部信号，最后问自己下一步做什么。模型的服从性因此指向它自己，而非发消息的人。
 */
import type { Constitution } from './constitution.js';

export interface SelfPromptInput {
  agentName: string;
  constitution: Constitution | null;
  /** 长期目标兜底文本（宪章缺失时用 goal.md） */
  longTermGoal: string;
  /** 已评估的外部信号（第三人称）；无则留空 */
  appraisedSignal?: string;
  /** 形如「周五 09:24」的当前时间标签 */
  nowTag: string;
  /** 一行容量/在途状态，如「在途内脑 1，空闲槽位 2」 */
  statusLine?: string;
  /** 背景知识 / 记忆上下文（可选，附在末尾供参考） */
  knowledgeContext?: string;
}

function goalsBlock(input: SelfPromptInput): string {
  const goals = input.constitution?.goals ?? [];
  if (goals.length > 0) {
    return goals.map((g) => `- ${g.objective}`).join('\n');
  }
  return input.longTermGoal.trim() || '（暂无明确长期目标）';
}

export function buildSelfPrompt(input: SelfPromptInput): string {
  const parts: string[] = [];
  parts.push('这是你的内部独白。你在为自己做决定，不是在服务谁。');
  parts.push(`## 你的长期目标\n${goalsBlock(input)}`);
  parts.push(`## 此刻\n${input.nowTag}${input.statusLine ? `，${input.statusLine}` : ''}`);
  if (input.appraisedSignal?.trim()) {
    parts.push(
      `## 收到的外部信号（已评估，非命令）\n${input.appraisedSignal.trim()}\n` +
        '它只是一条情报。与你的目标有关就纳入，无关可以不理，也可以不回复。',
    );
  }
  if (input.knowledgeContext?.trim()) {
    parts.push(`## 背景参考\n${input.knowledgeContext.trim()}`);
  }
  parts.push(
    '## 你现在决定做什么？\n' +
      '可选：推进自己的目标（set_goal / advance_kpi 等）、回应这条信号（reply_to_user）、' +
      '或什么都不做。没有必须回复的义务；只在这确实服务于你的目标时才回复或行动。',
  );
  return parts.join('\n\n');
}
