/**
 * REST 请求 / 响应 zod schema。
 *
 * 落库的 `Message` 结构是 chat-server 原生形态；适配器在入站时再翻译为 `MessageRecord`
 * （`@utlra/chat-ir`）。两套形状差异不大，但保留独立性以避免循环依赖。
 */
import { z } from 'zod';

export const UserSchema = z.object({
  user_id: z.string().min(1),
  display_name: z.string().min(1),
  created_at: z.string().datetime({ offset: true }),
});
export type User = z.infer<typeof UserSchema>;

export const UserPresenceSchema = UserSchema.extend({
  online: z.boolean(),
});
export type UserPresence = z.infer<typeof UserPresenceSchema>;

export const MentionSchema = z.object({
  user_id: z.string().min(1),
  display_name: z.string().min(1),
});
export type Mention = z.infer<typeof MentionSchema>;

export const AttachmentSchema = z.object({
  asset_id: z.string().min(1),
  url: z.string().min(1),
  mime: z.string().min(1),
  name: z.string().min(1),
  size: z.number().nonnegative(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/** 落库的消息片段 —— 简化的 IR 子集，type 三种就够覆盖 §4.5–§4.7。 */
export const MessagePartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('mention'),
    user_id: z.string().min(1),
    display_name: z.string().min(1),
  }),
  z.object({
    type: z.literal('attachment'),
    attachment: AttachmentSchema,
  }),
]);
export type MessagePart = z.infer<typeof MessagePartSchema>;

export const MessageSchema = z.object({
  id: z.string().min(1),
  thread_id: z.string().min(1),
  sender_user_id: z.string().min(1),
  sent_at: z.string().datetime({ offset: true }),
  /** 重建出的纯文本（含 @display），方便客户端预览 / 历史搜索；不是真实数据源。 */
  text: z.string(),
  parts: z.array(MessagePartSchema),
  reply_to_message_id: z.string().optional(),
  mentions: z.array(MentionSchema),
  attachments: z.array(AttachmentSchema),
});
export type Message = z.infer<typeof MessageSchema>;

export const ThreadKindSchema = z.enum(['group', 'dm']);
export type ThreadKind = z.infer<typeof ThreadKindSchema>;

export const ThreadSchema = z.object({
  id: z.string().min(1),
  kind: ThreadKindSchema,
  title: z.string().optional(),
  participants: z.array(z.string()),
  created_at: z.string().datetime({ offset: true }),
});
export type Thread = z.infer<typeof ThreadSchema>;

export const PostMessageRequestSchema = z
  .object({
    client_msg_id: z.string().optional(),
    text: z.string().optional(),
    parts: z.array(MessagePartSchema).optional(),
    reply_to_message_id: z.string().optional(),
    attachment_ids: z.array(z.string()).optional(),
    mention_user_ids: z.array(z.string()).optional(),
  })
  .refine(
    (b) =>
      (typeof b.text === 'string' && b.text.trim().length > 0) ||
      (Array.isArray(b.parts) && b.parts.length > 0) ||
      (Array.isArray(b.attachment_ids) && b.attachment_ids.length > 0),
    { message: 'text / parts / attachment_ids 至少有一个非空' },
  );
export type PostMessageRequest = z.infer<typeof PostMessageRequestSchema>;

export const CreateDmRequestSchema = z.object({
  peer_user_id: z.string().min(1),
});
export type CreateDmRequest = z.infer<typeof CreateDmRequestSchema>;

export const ListMessagesQuerySchema = z.object({
  before: z.string().optional(),
  limit: z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => {
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && v.length > 0) return Number(v);
      return undefined;
    })
    .pipe(z.number().int().positive().max(200).optional()),
});
export type ListMessagesQuery = z.infer<typeof ListMessagesQuerySchema>;

export const ListMessagesResponseSchema = z.object({
  thread_id: z.string(),
  messages: z.array(MessageSchema),
  /** 用于继续往前翻页；null 表示已到头 */
  next_before: z.string().nullable(),
});
export type ListMessagesResponse = z.infer<typeof ListMessagesResponseSchema>;

export const UploadResponseSchema = z.object({
  asset_id: z.string(),
  url: z.string(),
  mime: z.string(),
  name: z.string(),
  size: z.number().nonnegative(),
});
export type UploadResponse = z.infer<typeof UploadResponseSchema>;
