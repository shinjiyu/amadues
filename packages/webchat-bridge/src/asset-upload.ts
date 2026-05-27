/**
 * 出站附件：`asset:<uuid>` / http(s) → chat-server `POST /uploads` → `attachment_ids`。
 */
import type { ChatAssetStore, MessagePart } from '@utlra/chat-ir';
import type { WebChatRestClient } from './rest-client.js';

export interface EnsureWebChatUploadsDeps {
  assetStore: ChatAssetStore;
  rest: WebChatRestClient;
  /** IR `asset_ref.uri` → chat-server `asset_id`（命中则跳过上传） */
  uploadedAssetByUri: Map<string, string>;
  /** 可选：拉取外链附件（默认用 global fetch） */
  fetchImpl?: typeof fetch;
}

/** 上传 parts 中的附件，填充 `uploadedAssetByUri`。返回未能上传的 URI 列表。 */
export async function ensureWebChatAttachmentUploads(
  parts: MessagePart[],
  deps: EnsureWebChatUploadsDeps,
): Promise<string[]> {
  const failed: string[] = [];
  const fetchFn = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);

  for (const p of parts) {
    if (p.type !== 'attachment') continue;
    const uri = p.asset_ref.uri;
    if (deps.uploadedAssetByUri.has(uri)) continue;

    const assetMatch = /^asset:(.+)$/.exec(uri);
    if (assetMatch) {
      const got = deps.assetStore.get(assetMatch[1]!);
      if (!got) {
        failed.push(uri);
        continue;
      }
      try {
        const up = await deps.rest.uploadFile(
          got.buffer,
          p.asset_ref.mime ?? got.meta.mime,
          p.asset_ref.name ?? got.meta.name,
        );
        deps.uploadedAssetByUri.set(uri, up.asset_id);
      } catch (e) {
        console.warn('[webchat-bridge] upload ChatAssetStore asset failed', uri, e);
        failed.push(uri);
      }
      continue;
    }

    if (/^https?:\/\//i.test(uri)) {
      try {
        const res = await fetchFn(uri);
        if (!res.ok) {
          failed.push(uri);
          continue;
        }
        const ab = await res.arrayBuffer();
        const bytes = Buffer.from(ab);
        const mime =
          p.asset_ref.mime ??
          res.headers.get('content-type')?.split(';')[0]?.trim() ??
          'application/octet-stream';
        const up = await deps.rest.uploadFile(
          bytes,
          mime,
          p.asset_ref.name ?? 'file',
        );
        deps.uploadedAssetByUri.set(uri, up.asset_id);
      } catch (e) {
        console.warn('[webchat-bridge] upload http(s) asset failed', uri, e);
        failed.push(uri);
      }
      continue;
    }

    failed.push(uri);
  }

  return failed;
}
