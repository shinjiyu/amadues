/**
 * Chat IR 身份 schema —— 纯 zod，零 node 依赖。
 *
 * 身份是 chat IR 的第一公民。每个能"说话"的实体——人类、agent、bot、service、群组——
 * 都用统一的 `IdentityRecord` 形式表达，并通过稳定的 `sid` 在多渠道之间被追踪。
 * 运行时持久化层见 `runtime/identity-registry.ts`。
 */
import { z } from 'zod';

export const IdentityKindSchema = z.enum(['human', 'agent', 'service', 'group']);
export type IdentityKind = z.infer<typeof IdentityKindSchema>;

export const ChannelBindingSchema = z.object({
  channel: z.string(),
  native_user_id: z.string(),
  native_union_id: z.string().optional(),
});

export const IdentityRecordSchema = z.object({
  schema: z.literal('identity.v1'),
  sid: z.string(),
  kind: IdentityKindSchema,
  display_name: z.string(),
  aliases: z.array(z.string()).default([]),
  /** 租户内角色标签（设计稿 §2.5 [ROLES]） */
  roles_in_tenant: z.array(z.string()).optional().default([]),
  bindings: z.array(ChannelBindingSchema).default([]),
  /** ISO 8601 with timezone offset，同 `MessageRecord.sent_at` 约定。 */
  updated_at: z.string().datetime({ offset: true }),
});

export type IdentityRecord = z.infer<typeof IdentityRecordSchema>;
