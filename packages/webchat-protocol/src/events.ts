/**
 * WebSocket 事件 schema —— 服务端/客户端/适配器共用。
 *
 * 双向都是 JSON 对象，`type` 字段做 discriminated union。
 * 任何收到的 payload 都应先用 {@link ClientEventSchema} / {@link ServerEventSchema} parse。
 */
import { z } from 'zod';
import { MessageSchema, UserPresenceSchema } from './rest-types.js';

export const ClientHelloSchema = z.object({
  type: z.literal('hello'),
  user_id: z.string().min(1),
  display_name: z.string().min(1),
  /**
   * 可选。当 user_id 是 chat-server 配置的保留 agent_user_id 时，必须提供
   * 与服务端配置一致的 secret，否则被拒。普通用户可省略。
   */
  agent_secret: z.string().optional(),
});
export type ClientHello = z.infer<typeof ClientHelloSchema>;

export const ClientSubscribeSchema = z.object({
  type: z.literal('subscribe'),
  thread_id: z.string().min(1),
});
export type ClientSubscribe = z.infer<typeof ClientSubscribeSchema>;

export const ClientSinceSchema = z.object({
  type: z.literal('since'),
  thread_id: z.string().min(1),
  /** 客户端记得的最后一条 message_id；null 表示从头取（不建议，仅用于诊断） */
  cursor: z.string().nullable(),
});
export type ClientSince = z.infer<typeof ClientSinceSchema>;

export const ClientTypingSchema = z.object({
  type: z.literal('typing'),
  thread_id: z.string().min(1),
  /**
   * 输入活动状态。`start` = 开始/仍在输入（前端应配合超时自动消退），
   * `stop` = 明确停止（发送完成 / 清空输入框 / 失焦）。省略视为 `start`（向后兼容）。
   */
  state: z.enum(['start', 'stop']).optional(),
});
export type ClientTyping = z.infer<typeof ClientTypingSchema>;

export const ClientEventSchema = z.discriminatedUnion('type', [
  ClientHelloSchema,
  ClientSubscribeSchema,
  ClientSinceSchema,
  ClientTypingSchema,
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;

export const PresenceSyncSchema = z.object({
  type: z.literal('presence.sync'),
  users: z.array(UserPresenceSchema),
});
export type PresenceSync = z.infer<typeof PresenceSyncSchema>;

export const PresenceUpdateSchema = z.object({
  type: z.literal('presence.update'),
  user_id: z.string().min(1),
  display_name: z.string().min(1),
  online: z.boolean(),
});
export type PresenceUpdate = z.infer<typeof PresenceUpdateSchema>;

export const MessageNewSchema = z.object({
  type: z.literal('message.new'),
  thread_id: z.string().min(1),
  message: MessageSchema,
});
export type MessageNew = z.infer<typeof MessageNewSchema>;

export const MessageAckSchema = z.object({
  type: z.literal('message.ack'),
  client_msg_id: z.string(),
  message_id: z.string(),
  thread_id: z.string(),
});
export type MessageAck = z.infer<typeof MessageAckSchema>;

export const MessagesClearedSchema = z.object({
  type: z.literal('messages.cleared'),
  thread_id: z.string().min(1),
  cleared_by_user_id: z.string().min(1),
  deleted_count: z.number().int().nonnegative(),
});
export type MessagesCleared = z.infer<typeof MessagesClearedSchema>;

export const TypingRelaySchema = z.object({
  type: z.literal('typing.relay'),
  thread_id: z.string().min(1),
  user_id: z.string().min(1),
  /** 该用户当前是否在输入；`stop` 表示明确停止。省略/默认 `start`。 */
  state: z.enum(['start', 'stop']).default('start'),
  /** 发送者显示名（便于前端无需查 presence 即可渲染「X 正在输入…」）。 */
  display_name: z.string().optional(),
});
export type TypingRelay = z.infer<typeof TypingRelaySchema>;

export const ServerErrorSchema = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
});
export type ServerError = z.infer<typeof ServerErrorSchema>;

/** 服务端推送的「就绪」事件（hello 成功的回执），紧跟 presence.sync 之前。 */
export const ServerReadySchema = z.object({
  type: z.literal('ready'),
  user_id: z.string(),
  display_name: z.string(),
});
export type ServerReady = z.infer<typeof ServerReadySchema>;

export const ServerEventSchema = z.discriminatedUnion('type', [
  ServerReadySchema,
  PresenceSyncSchema,
  PresenceUpdateSchema,
  MessageNewSchema,
  MessageAckSchema,
  MessagesClearedSchema,
  TypingRelaySchema,
  ServerErrorSchema,
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
