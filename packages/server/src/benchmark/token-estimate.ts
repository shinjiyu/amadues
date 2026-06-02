/**
 * Token  proxy：FakeLLM 无真实 tokenizer，用 prompt 字符量估算。
 * @see doc/structurizr/FRAMEWORK-BENCHMARK.md §4
 */
import type { Message } from '../openkuroneko/adapter/index.js';
import type { FakeLLMCall } from '../testing/fake-llm.js';

function messageChars(messages: Message[]): number {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      n += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'text') n += b.text.length;
      }
    }
    if (m.tool_calls) {
      n += JSON.stringify(m.tool_calls).length;
    }
  }
  return n;
}

/** 单次 LLM 调用的估算 prompt token（ceil(chars/4)） */
export function estimatePromptTokensForCall(call: FakeLLMCall): number {
  const chars = call.systemPrompt.length + messageChars(call.messages);
  return Math.ceil(chars / 4);
}

export function estimatePromptTokensFromCalls(calls: FakeLLMCall[]): number {
  return calls.reduce((sum, c) => sum + estimatePromptTokensForCall(c), 0);
}

export function countExecutorLlmCalls(calls: FakeLLMCall[]): number {
  return calls.filter(
    (c) =>
      c.matchedLabel === 'executor' ||
      c.systemPrompt.includes('反应执行器') ||
      c.matchedLabel.startsWith('executor'),
  ).length;
}
