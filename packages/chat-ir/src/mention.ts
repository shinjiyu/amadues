import type { MessagePart } from './schemas/message.js';
import type { IdentityRegistry, MentionResolutionOptions } from './runtime/identity-registry.js';

function mergeAdjacentText(parts: MessagePart[]): MessagePart[] {
  const out: MessagePart[] = [];
  for (const p of parts) {
    if (p.type === 'text' && out.length > 0 && out[out.length - 1]!.type === 'text') {
      (out[out.length - 1] as { type: 'text'; text: string }).text += p.text;
    } else {
      out.push(p);
    }
  }
  return out;
}

/**
 * 将纯文本中的 `@token` 解析为 `mention` part（token 为展示名、别名或 sid）。
 * 无法解析或歧义时保留原文字片段。
 */
export function plainTextToPartsWithMentions(
  text: string,
  registry: IdentityRegistry,
  opts?: MentionResolutionOptions,
): MessagePart[] {
  const parts: MessagePart[] = [];
  const re = /@([^\s@]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parts.push({ type: 'text', text: text.slice(last, m.index) });
    }
    const token = m[1]!;
    const res = registry.resolveMentionToken(token, opts);
    if (res.kind === 'unique') {
      parts.push({ type: 'mention', target_sid: res.sid, label: res.record.display_name });
    } else {
      parts.push({ type: 'text', text: m[0]! });
    }
    last = m.index + m[0]!.length;
  }
  if (last < text.length) {
    parts.push({ type: 'text', text: text.slice(last) });
  }
  if (parts.length === 0) {
    parts.push({ type: 'text', text });
  }
  return mergeAdjacentText(parts);
}
