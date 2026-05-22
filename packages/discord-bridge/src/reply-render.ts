/**
 * chat IR message parts → Discord 消息载荷。
 *
 * 关键点：
 *   - mention { target_sid } → 反查 `discord:user:<id>` / `idp:agent:discord-bot:<id>` → `<@id>`
 *     找不到 native id → 退化成 `@displayName`
 *   - attachment.uri：
 *       * `asset:<id>` → 从注入的 ChatAssetStore 取数据，multipart 上传 Discord
 *       * `http(s)://` → 直接放进 content（让 Discord 自己抓预览）
 *   - 文本超过 1900 字 → 截断 + 省略提示（避免 Discord 2000 字硬上限）
 *   - 屏蔽 `@everyone` / `@here` 滥用：发送时禁用 mention everyone（依赖 discord.js allowedMentions）
 */
import type { ChatAssetStore, IdentityRegistry } from '@utlra/chat-ir';
import { sidToDiscordUserId } from './identity-mapper.js';

const DISCORD_CONTENT_LIMIT = 1900;

export interface RenderInput {
  parts: Array<{ type: string; [k: string]: unknown }>;
  assetStore: ChatAssetStore;
  /** IdentityRegistry 实例，用于将 SID 解析为 Discord User ID（可选，不传则回退纯正则） */
  registry?: IdentityRegistry;
}

export interface DiscordFile {
  attachment: Buffer;
  name: string;
  contentType?: string;
}

export interface RenderedDiscordPayload {
  content: string;
  files: DiscordFile[];
}

interface MentionPart {
  type: 'mention';
  target_sid: string;
  label?: string;
}

interface TextPart {
  type: 'text';
  text: string;
}

interface AttachmentPart {
  type: 'attachment';
  asset_ref: {
    kind: 'image' | 'video' | 'audio' | 'file';
    uri: string;
    mime?: string;
    name?: string;
  };
}

function isMentionPart(p: { type: string }): p is MentionPart {
  return p.type === 'mention';
}
function isTextPart(p: { type: string }): p is TextPart {
  return p.type === 'text';
}
function isAttachmentPart(p: { type: string }): p is AttachmentPart {
  return p.type === 'attachment';
}

export function renderForDiscord(input: RenderInput): RenderedDiscordPayload {
  const segments: string[] = [];
  const files: DiscordFile[] = [];

  for (const raw of input.parts) {
    if (isMentionPart(raw)) {
      const id = sidToDiscordUserId(raw.target_sid, input.registry);
      if (id) segments.push(`<@${id}>`);
      else segments.push(`@${raw.label ?? raw.target_sid}`);
      continue;
    }
    if (isTextPart(raw)) {
      segments.push(raw.text);
      continue;
    }
    if (isAttachmentPart(raw)) {
      const ar = raw.asset_ref;
      const assetMatch = /^asset:(.+)$/.exec(ar.uri);
      if (assetMatch) {
        const got = input.assetStore.get(assetMatch[1]!);
        if (got) {
          files.push({
            attachment: got.buffer,
            name: ar.name ?? got.meta.name,
            contentType: ar.mime ?? got.meta.mime,
          });
        } else {
          segments.push(`[附件: ${ar.name ?? ar.uri}]`);
        }
      } else {
        segments.push(ar.uri);
      }
      continue;
    }
  }

  let content = segments.join('').trim();
  content = content.replace(/@everyone/gi, '@\u200beveryone').replace(/@here/gi, '@\u200bhere');

  if (content.length > DISCORD_CONTENT_LIMIT) {
    const head = content.slice(0, DISCORD_CONTENT_LIMIT);
    const omitted = content.length - DISCORD_CONTENT_LIMIT;
    content = `${head}\n…（省略 ${omitted} 字符）`;
  }

  return { content, files };
}
