/**
 * FakeLLM — 脚本化的 `LLMAdapter` 替身，用于单元 / 模块测试。
 *
 * 设计要点（对齐 doc/testing-strategy.md §S3）：
 * 1. 任何业务代码只要依赖 `LLMAdapter`（chat/stream），单测就能塞这个替身进去，
 *    完全不发起网络请求。
 * 2. 脚本（reply）按入参顺序匹配；用 `RegExp` 或字符串子串匹配 systemPrompt + last user message。
 * 3. 默认 `unmatched: 'throw'` —— 没命中脚本的调用直接抛错（暴露用例没考虑到的路径），
 *    显式 opt-in 才允许沉默返回兜底字符串。
 * 4. 每次调用都会写入 `calls[]`，方便断言「调用了几次 / 传了哪些 tools / 最终给 LLM 看的 prompt」。
 *
 * 仅供测试目录引用；业务代码禁止 import。
 */
import type {
  LLMAdapter,
  LLMResult,
  Message,
  StreamChunk,
} from '../openkuroneko/adapter/index.js';

export interface FakeLLMCall {
  systemPrompt: string;
  messages: Message[];
  tools?: object[];
  /** 命中的脚本 index；未命中为 -1 */
  matchedIndex: number;
  /** 命中规则的友好名（match.label 优先，否则用规则索引） */
  matchedLabel: string;
}

/** 单条脚本匹配规则。多个字段同时给出时按 AND 关系组合。 */
export interface FakeLLMScript {
  /** 给规则一个语义化的名字，断言时打印用 */
  label?: string;
  /**
   * 命中规则。任一返回 true 即视为命中：
   * - 字符串：系统 prompt 或最后一条 user 消息包含该子串
   * - 正则：同上
   * - 函数：完整入参传入，自行决定是否命中
   *
   * 不指定 = 通配（仅当其它规则都未命中时兜底）。
   */
  match?:
    | string
    | RegExp
    | ((args: { systemPrompt: string; messages: Message[]; tools?: object[] }) => boolean);
  /** 命中后返回的 `LLMResult`；可写成对象或工厂函数（拿到入参） */
  reply:
    | LLMResult
    | ((args: { systemPrompt: string; messages: Message[]; tools?: object[] }) => LLMResult);
}

export interface FakeLLMOptions {
  /** 未命中时的行为：抛错（默认）或返回兜底字符串 */
  unmatched?: 'throw' | 'silent';
  /** unmatched='silent' 时返回的 content；默认 '' */
  silentReply?: string;
  /** 命中后是否消耗脚本（默认 false：可重复命中同一条规则） */
  consumeOnMatch?: boolean;
}

export interface FakeLLM extends LLMAdapter {
  readonly calls: FakeLLMCall[];
  /** 重置 calls 与脚本状态（如果 consumeOnMatch=true） */
  reset(): void;
  /** 当前未消耗的脚本数（只在 consumeOnMatch=true 时变化） */
  remaining(): number;
}

function extractLastUserText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    const text = m.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    return text;
  }
  return '';
}

function matchScript(
  rule: FakeLLMScript['match'],
  args: { systemPrompt: string; messages: Message[]; tools?: object[] },
): boolean {
  if (rule === undefined) return true;
  if (typeof rule === 'function') return rule(args);
  const haystack = `${args.systemPrompt}\n${extractLastUserText(args.messages)}`;
  if (rule instanceof RegExp) return rule.test(haystack);
  return haystack.includes(rule);
}

export function createFakeLLM(
  scripts: FakeLLMScript[] = [],
  options: FakeLLMOptions = {},
): FakeLLM {
  const calls: FakeLLMCall[] = [];
  const consume = options.consumeOnMatch ?? false;
  const consumed = new Set<number>();

  function resolveScript(args: {
    systemPrompt: string;
    messages: Message[];
    tools?: object[];
  }): { index: number; reply: LLMResult; label: string } | null {
    let fallbackIndex: number = -1;
    for (let i = 0; i < scripts.length; i++) {
      if (consume && consumed.has(i)) continue;
      const s = scripts[i]!;
      if (s.match === undefined) {
        if (fallbackIndex === -1) fallbackIndex = i;
        continue;
      }
      if (matchScript(s.match, args)) {
        if (consume) consumed.add(i);
        return {
          index: i,
          reply: typeof s.reply === 'function' ? s.reply(args) : s.reply,
          label: s.label ?? `rule#${i}`,
        };
      }
    }
    if (fallbackIndex !== -1) {
      const s = scripts[fallbackIndex]!;
      if (consume) consumed.add(fallbackIndex);
      return {
        index: fallbackIndex,
        reply: typeof s.reply === 'function' ? s.reply(args) : s.reply,
        label: s.label ?? `fallback#${fallbackIndex}`,
      };
    }
    return null;
  }

  function handleUnmatched(args: {
    systemPrompt: string;
    messages: Message[];
  }): LLMResult {
    if (options.unmatched === 'silent') {
      return { content: options.silentReply ?? '' };
    }
    const preview = extractLastUserText(args.messages).slice(0, 120);
    throw new Error(
      `[fake-llm] no script matched. system="${args.systemPrompt.slice(
        0,
        80,
      )}..." last user="${preview}"`,
    );
  }

  return {
    calls,
    async chat(
      systemPrompt: string,
      messages: Message[],
      tools?: object[],
    ): Promise<LLMResult> {
      const args = { systemPrompt, messages, tools };
      const hit = resolveScript(args);
      if (!hit) {
        calls.push({
          systemPrompt,
          messages,
          tools,
          matchedIndex: -1,
          matchedLabel: 'unmatched',
        });
        return handleUnmatched(args);
      }
      calls.push({
        systemPrompt,
        messages,
        tools,
        matchedIndex: hit.index,
        matchedLabel: hit.label,
      });
      return hit.reply;
    },
    async stream(
      systemPrompt: string,
      messages: Message[],
      onChunk: (chunk: StreamChunk) => void,
    ): Promise<LLMResult> {
      const result = await this.chat(systemPrompt, messages);
      onChunk({ delta: result.content, done: true });
      return result;
    },
    reset(): void {
      calls.length = 0;
      consumed.clear();
    },
    remaining(): number {
      if (!consume) return scripts.length;
      return scripts.length - consumed.size;
    },
  };
}

/** 便捷：一次性脚本，always 返回同一段文本（适合最简单单测） */
export function constLLM(content: string, toolCalls?: LLMResult['toolCalls']): FakeLLM {
  return createFakeLLM([{ label: 'const', reply: { content, toolCalls } }]);
}
