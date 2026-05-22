/**
 * Chat IR 消息 / 线程 schema —— 纯 zod，零 node 依赖。
 *
 * 这层是 chat IR 的**数据模型契约**：任何渠道（Discord / Lark / Slack / 浏览器扩展…）
 * 落地到本栈的消息都必须先 parse 为 `MessageRecord` 才能进入下游 agent 业务。
 */
import { z } from 'zod';

export const MessagePartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('mention'),
    target_sid: z.string(),
    label: z.string().optional(),
  }),
  z.object({
    type: z.literal('quote'),
    quoted_message_id: z.string(),
    excerpt: z.string().optional(),
  }),
  z.object({
    type: z.literal('attachment'),
    asset_ref: z.object({
      kind: z.enum(['image', 'video', 'audio', 'file']),
      uri: z.string(),
      mime: z.string().optional(),
      name: z.string().optional(),
    }),
  }),
  z.object({ type: z.literal('unknown'), channel: z.string(), opaque: z.unknown() }),
]);

export type MessagePart = z.infer<typeof MessagePartSchema>;

export const MessageRecordSchema = z.object({
  schema: z.literal('message.v1'),
  message_id: z.string(),
  thread_id: z.string(),
  sender_sid: z.string(),
  /**
   * ISO 8601 with timezone offset。约定写入端使用 `new Date().toISOString()`
   * （UTC + `Z`），可比较 / 可排序 / 跨时区可还原。
   * 任何不带 offset 的本地时间字符串（"2024-01-01 12:00:00"）会被 schema 拒绝，
   * 详见 doc/chat-ir-identity-design.md §3.X 时间字段约定。
   */
  sent_at: z.string().datetime({ offset: true }),
  reply_to_message_id: z.string().optional(),
  parts: z.array(MessagePartSchema),
});

export type MessageRecord = z.infer<typeof MessageRecordSchema>;

export const ThreadRecordSchema = z.object({
  schema: z.literal('thread.v1'),
  thread_id: z.string(),
  tenant_id: z.string(),
  channel: z.string(),
  kind: z.enum(['dm', 'group']),
  title: z.string().optional(),
  participant_sids: z.array(z.string()),
  /** ISO 8601 with timezone offset，同 `MessageRecord.sent_at` 约定。 */
  created_at: z.string().datetime({ offset: true }),
});

export type ThreadRecord = z.infer<typeof ThreadRecordSchema>;
