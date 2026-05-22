/**
 * 外脑 MessagePart[] → 内脑 goal.md：文本与结构化片段落盘，图片 data URL 写入 workspace 相对路径（与 Pi-mono 读纯文本 goal 对齐）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MessagePart } from '@utlra/chat-ir';

const SUBDIR = '.run/outer-task-media';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

function parseDataUrl(uri: string): { mime: string; buffer: Buffer } | null {
  const b64 = uri.match(/^data:([^;]+);base64,(.+)$/i);
  if (b64) {
    try {
      const buf = Buffer.from(b64[2]!.trim(), 'base64');
      return { mime: b64[1]!.trim(), buffer: buf };
    } catch {
      return null;
    }
  }
  return null;
}

function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'bin';
}

function escapeMdAlt(s: string): string {
  return s.replace(/[\[\]]/g, '');
}

/**
 * 将 parts 展开为写入 `.brain/goal.md` 的 Markdown（经 InnerBrainEngine.setGoal）。
 * - `attachment` + image + data URL：写入 `workDir/.run/outer-task-media/` 并生成 `![](相对路径)`。
 * - 其它 URI：以 Markdown 链接文本形式写入（内脑 LLM 仍只见文本；真正视觉理解需内脑管线支持或外脑先摘要）。
 */
export function persistMessagePartsToGoalMarkdown(workDir: string, parts: MessagePart[]): string {
  const absDir = path.join(workDir, SUBDIR);
  fs.mkdirSync(absDir, { recursive: true });
  const blocks: string[] = [];
  let imgSeq = 0;

  for (const p of parts) {
    if (p.type === 'text') {
      if (p.text.trim()) blocks.push(p.text.trim());
    } else if (p.type === 'mention') {
      blocks.push(`[@sid:${p.target_sid}${p.label ? `|${p.label}` : ''}]`);
    } else if (p.type === 'quote') {
      blocks.push(
        `> 引用 \`${p.quoted_message_id}\`${p.excerpt ? `：${p.excerpt}` : ''}`,
      );
    } else if (p.type === 'attachment') {
      const a = p.asset_ref;
      if (a.kind === 'image' && a.uri.startsWith('data:')) {
        const parsed = parseDataUrl(a.uri);
        if (parsed && parsed.buffer.length > 0 && parsed.buffer.length <= MAX_IMAGE_BYTES) {
          const fn = `outer-${Date.now()}-${imgSeq++}.${extFromMime(parsed.mime)}`;
          fs.writeFileSync(path.join(absDir, fn), parsed.buffer);
          const rel = `${SUBDIR}/${fn}`.replace(/\\/g, '/');
          blocks.push(`![${escapeMdAlt(a.name ?? 'image')}](${rel})`);
        } else {
          blocks.push('（图片 data URL 无效或超过大小上限，已省略）');
        }
      } else {
        blocks.push(`[附件 ${a.kind}: ${a.name ?? 'file'}](${a.uri})`);
      }
    } else if (p.type === 'unknown') {
      blocks.push(`（unknown part: channel=${p.channel}）`);
    }
  }

  const body = blocks.join('\n\n').trim();
  return `<!-- utlra: goal synthesized from outer message parts -->\n\n${body}`;
}
