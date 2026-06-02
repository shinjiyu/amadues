/**
 * 外脑 LLM：仅允许输出 **JSON**，解析为 `StructuredReplyLlmPayload`，再合并为 `reply.v1`。
 */
import {
  StructuredReplyLlmPayloadSchema,
  parseJsonObjectFromLlmText,
  type StructuredReplyLlmPayload,
} from '@utlra/chat-ir';
import { llmChatCompletion } from '../llm/client.js';
import type { InnerLlmEnv } from '../llm/inner-llm-step.js';

const JSON_SCHEMA_HINT = `你必须只输出一个 JSON 对象（不要 markdown、不要代码围栏外多余文字），字段如下：
{
  "text": "string（必填，面向用户的主文案，中文）",
  "mention_sids": ["string"]（可选，只能使用 Identity Pack 里出现过的 sid）,
  "reply_to_message_id": "string | 省略",
  "attach_asset_ids": ["string"]（可选；裸 UUID 列表，不带 asset: 前缀。系统会自动展开为附件）,
  "parts": [ MessagePart 数组，与入站相同形状，可选；可为空数组或省略 ]
}
MessagePart 类型：{ "type":"text","text":"..." } | { "type":"mention","target_sid":"...","label":"..." } | { "type":"quote",... } | { "type":"attachment", "asset_ref": { "kind":"image"|"video"|"audio"|"file", "uri":"...", "mime":"...", "name":"..." } }

附件使用约定（见 doc/protocols/inner-brain-deliverables.md §6）：
- 优先用 attach_asset_ids 语法糖（裸 UUID），无需手写完整 attachment part。
- 引用的 asset id 必须来自：内脑 deliverables、本 thread 入站消息、当次任务上下文。未知 id 会被静默剔除。
- 若需精确控制顺序/穿插，仍可用 parts[] 直接写 attachment。`;

/**
 * 调用当前 provider 的文本模型，解析为结构化载荷；失败时抛错（由编排层回退模板）。
 */
export async function draftOuterStructuredReplyPayload(
  env: InnerLlmEnv,
  input: {
    identityPack: string;
    threadHistoryPrefix: string;
    burstStdout: string;
    burstStderr: string;
    innerPhase: string;
    innerLast: string;
    templateReply: string;
  },
): Promise<StructuredReplyLlmPayload> {
  const sys =
    '你是「外脑」助手。根据下方上下文生成对用户的回复。' +
    '必须依据「内脑状态」与「子进程输出」如实填写 text；不要编造未出现的数字或状态。' +
    JSON_SCHEMA_HINT;

  const user = [
    '## Identity Pack（mention_sids 只能引用此处参与者 sid）\n',
    input.identityPack.slice(0, 14_000),
    '\n## 线程历史（goal 前缀摘要）\n',
    (input.threadHistoryPrefix || '（无）').slice(0, 24_000),
    '\n## 内脑状态\n',
    `phase=${input.innerPhase}\nlastAction=${input.innerLast}`,
    '\n## inner-worker stdout\n',
    (input.burstStdout || '（空）').slice(0, 12_000),
    '\n## inner-worker stderr\n',
    (input.burstStderr || '（空）').slice(0, 4000),
    '\n## 参考模板（可压缩进 text，但输出必须是合法 JSON）\n',
    input.templateReply.slice(0, 8000),
  ].join('');

  const { content } = await llmChatCompletion({
    provider: env.provider,
    apiKey: env.apiKey,
    baseUrl: env.baseUrl,
    model: env.textModel,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user.slice(0, 100_000) },
    ],
    maxTokens: 4096,
    temperature: 0.25,
    thinking: env.thinking,
    usageMeta: { source: 'outer_conversation', model: env.textModel, provider: env.provider },
  });

  let parsed: unknown;
  try {
    parsed = parseJsonObjectFromLlmText(content);
  } catch (e) {
    throw new Error(`outer LLM: JSON parse failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const r = StructuredReplyLlmPayloadSchema.safeParse(parsed);
  if (!r.success) {
    throw new Error(`outer LLM: schema: ${r.error.message}`);
  }
  return r.data;
}
