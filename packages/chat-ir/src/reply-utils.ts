/**
 * Chat IR 输出契约的工具函数：合并、解析、校验、mock 渲染。
 *
 * Schema 定义在 `schemas/reply.ts`；本文件只放纯函数操作，零 fs 依赖，可在任何 JS 环境运行。
 */
import {
  StructuredReplySchema,
  StructuredReplyLlmPayloadSchema,
  type StructuredReply,
  type StructuredReplyLlmPayloadInput,
} from './schemas/reply.js';

/** 将 LLM 载荷与固定字段合并为 `reply.v1` */
export function mergeStructuredReply(
  threadId: string,
  payload: StructuredReplyLlmPayloadInput,
): StructuredReply {
  const p = StructuredReplyLlmPayloadSchema.parse(payload);
  return StructuredReplySchema.parse({
    schema: 'reply.v1',
    thread_id: threadId,
    text: p.text,
    mention_sids: p.mention_sids,
    reply_to_message_id: p.reply_to_message_id,
    attach_asset_ids: p.attach_asset_ids,
    parts: p.parts,
  });
}

/** 从模型原文中提取 JSON（支持 ```json 围栏或裸对象） */
export function parseJsonObjectFromLlmText(raw: string): unknown {
  const trimmed = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(trimmed);
  if (fence) {
    return JSON.parse(fence[1]!.trim()) as unknown;
  }
  const i = trimmed.indexOf('{');
  const j = trimmed.lastIndexOf('}');
  if (i >= 0 && j > i) {
    return JSON.parse(trimmed.slice(i, j + 1)) as unknown;
  }
  return JSON.parse(trimmed) as unknown;
}

/** 收集 `mention_sids` + `parts` 内 mention 的 sid（去重） */
export function collectMentionSidsFromReply(reply: StructuredReply): string[] {
  const sids = new Set<string>(reply.mention_sids);
  for (const p of reply.parts ?? []) {
    if (p.type === 'mention') sids.add(p.target_sid);
  }
  return [...sids];
}

export function validateReplyMentions(
  reply: StructuredReply,
  allowedSids: Set<string>,
): { ok: true } | { ok: false; error: string } {
  for (const sid of collectMentionSidsFromReply(reply)) {
    if (!allowedSids.has(sid)) {
      return { ok: false, error: `unknown mention sid: ${sid}` };
    }
  }
  return { ok: true };
}

export interface MockSendResult {
  wireText: string;
  atUserIds: string[];
  replyToId?: string;
}

function renderPartsSuffix(parts: NonNullable<StructuredReply['parts']>): string {
  const lines: string[] = [];
  for (const p of parts) {
    if (p.type === 'text') lines.push(p.text);
    if (p.type === 'mention') lines.push(`[@${p.target_sid}${p.label ? `|${p.label}` : ''}]`);
    if (p.type === 'quote') lines.push(`[quote ${p.quoted_message_id}]`);
    if (p.type === 'attachment') {
      const a = p.asset_ref;
      lines.push(`[${a.kind}: ${a.name ?? a.uri}]`);
    }
    if (p.type === 'unknown') lines.push(`[unknown:${p.channel}]`);
  }
  return lines.length ? `\n--- parts ---\n${lines.join('\n')}` : '';
}

/** Mock 渠道：把 StructuredReply 打成可读的「wire」供调试/UI 展示 */
export function renderMockChannel(reply: StructuredReply): MockSendResult {
  const atUserIds = collectMentionSidsFromReply(reply);
  let wireText = reply.text.trimEnd();
  for (const sid of reply.mention_sids) {
    wireText = wireText.replace(/\s*$/, '') + ` [@${sid}]`;
  }
  wireText += renderPartsSuffix(reply.parts ?? []);
  return {
    wireText,
    atUserIds,
    replyToId: reply.reply_to_message_id,
  };
}
