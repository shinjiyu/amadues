/**
 * Chat IR 输出契约 schema —— 纯 zod，零 node 依赖。
 *
 * `reply.v1` 是 agent → channel 的结构化回复格式。LLM 只输出 `StructuredReplyLlmPayload`
 * （不含 `schema` / `thread_id`），运行时再合并为完整 `StructuredReply`。
 *
 * 与 `message.v1` 的对称：`StructuredReply.parts` 与 `MessageRecord.parts` 共享 `MessagePart` schema。
 */
import { z } from 'zod';
import { MessagePartSchema } from './message.js';

export const StructuredReplySchema = z.object({
  schema: z.literal('reply.v1'),
  thread_id: z.string(),
  /** 主文案；可与 `parts` 并存（例如 text 为摘要，parts 带图） */
  text: z.string(),
  /** 顶栏 @ 列表；与 `parts` 内 `mention` 合并校验 */
  mention_sids: z.array(z.string()).default([]),
  reply_to_message_id: z.string().optional(),
  attach_asset_ids: z.array(z.string()).default([]),
  /** 出站富媒体：与入站 `MessagePart` 同形，实现对称 */
  parts: z.array(MessagePartSchema).optional(),
});

export type StructuredReply = z.infer<typeof StructuredReplySchema>;

/**
 * 外脑 LLM 仅输出此 JSON 对象（不含 `schema` / `thread_id`，由运行时注入）。
 * 用于机器解析与下游渠道编排。
 */
export const StructuredReplyLlmPayloadSchema = z.object({
  text: z.string(),
  mention_sids: z.array(z.string()).default([]),
  reply_to_message_id: z.string().optional(),
  attach_asset_ids: z.array(z.string()).default([]),
  parts: z.array(MessagePartSchema).optional(),
});

export type StructuredReplyLlmPayload = z.infer<typeof StructuredReplyLlmPayloadSchema>;
export type StructuredReplyLlmPayloadInput = z.input<typeof StructuredReplyLlmPayloadSchema>;
