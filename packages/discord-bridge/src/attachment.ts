/**
 * Discord 附件 → `ChatAssetStore` 落地。
 *
 * Discord CDN URL 是带签名过期的（`ex=` / `is=` / `hm=` 参数），几小时后视觉模型读会 404。
 * 默认行为是下载到本地 `ChatAssetStore`，得到 `asset:<id>` URI 写进 attachment.uri。
 *
 * `DISCORD_BRIDGE_DOWNLOAD_ATTACHMENTS=0` 时退化为直接放 CDN URL（仅适合短时调试）。
 */
import { Buffer } from 'node:buffer';
import type { ChatAssetStore } from '@utlra/chat-ir';

export interface DiscordAttachmentShape {
  id: string;
  url: string;
  proxyUrl?: string;
  name?: string;
  contentType?: string | null;
  size?: number;
}

export interface AttachmentUploadResult {
  /** 写进 message.v1 attachment part 的 uri */
  uri: string;
  mime: string;
  name: string;
  size?: number;
  /** 'asset' = 已下载到本地 ChatAssetStore；'cdn' = 直接用 Discord CDN URL */
  via: 'asset' | 'cdn';
}

function inferKind(mime: string): 'image' | 'video' | 'audio' | 'file' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

export function attachmentKindFromMime(mime: string): 'image' | 'video' | 'audio' | 'file' {
  return inferKind(mime || 'application/octet-stream');
}

/**
 * 下载 Discord 附件并保存到本地 `ChatAssetStore`，返回 `asset:<id>` URI。
 * 失败时返回 cdn 版本作降级。
 */
export async function downloadDiscordAttachment(
  assetStore: ChatAssetStore,
  att: DiscordAttachmentShape,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<AttachmentUploadResult> {
  const fallback: AttachmentUploadResult = {
    uri: att.url,
    mime: att.contentType ?? 'application/octet-stream',
    name: att.name ?? `discord-${att.id}`,
    size: att.size,
    via: 'cdn',
  };

  try {
    const r = await fetchImpl(att.url);
    if (!r.ok) {
      console.warn(
        `[discord-bridge] download attachment ${att.id} failed: HTTP ${r.status}`,
      );
      return fallback;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const mime = att.contentType || r.headers.get('content-type') || 'application/octet-stream';
    const name = att.name ?? `discord-${att.id}`;
    const saved = assetStore.save(buf, mime, name);
    return {
      uri: `asset:${saved.id}`,
      mime: saved.mime,
      name: saved.name,
      size: saved.size,
      via: 'asset',
    };
  } catch (e) {
    console.warn('[discord-bridge] attachment download error', e);
    return fallback;
  }
}
