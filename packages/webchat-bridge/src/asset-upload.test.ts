import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatAssetStore } from '@utlra/chat-ir';
import type { MessagePart } from '@utlra/chat-ir';

import { ensureWebChatAttachmentUploads } from './asset-upload.js';
import type { WebChatRestClient } from './rest-client.js';

describe('ensureWebChatAttachmentUploads', () => {
  let tmp = '';

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('uploads asset: uri via ChatAssetStore + rest.uploadFile', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-upload-'));
    const store = new ChatAssetStore(path.join(tmp, 'uploads'));
    const meta = store.save(Buffer.from('hello'), 'text/plain', 'note.txt');
    const uri = `asset:${meta.id}`;
    const uploaded = new Map<string, string>();
    const uploadFile = vi.fn().mockResolvedValue({
      asset_id: 'cs-1',
      url: '/uploads/cs-1',
      mime: 'text/plain',
      name: 'note.txt',
      size: 5,
    });
    const rest = { uploadFile } as unknown as WebChatRestClient;

    const parts: MessagePart[] = [
      {
        type: 'attachment',
        asset_ref: { kind: 'file', uri, mime: 'text/plain', name: 'note.txt' },
      },
    ];

    const failed = await ensureWebChatAttachmentUploads(parts, {
      assetStore: store,
      rest,
      uploadedAssetByUri: uploaded,
    });

    expect(failed).toEqual([]);
    expect(uploadFile).toHaveBeenCalledOnce();
    expect(uploaded.get(uri)).toBe('cs-1');
  });

  it('skips upload when uri already mapped', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-upload-'));
    const store = new ChatAssetStore(path.join(tmp, 'uploads'));
    const uploaded = new Map([['asset:cached', 'cs-cached']]);
    const uploadFile = vi.fn();
    const rest = { uploadFile } as unknown as WebChatRestClient;

    const failed = await ensureWebChatAttachmentUploads(
      [
        {
          type: 'attachment',
          asset_ref: { kind: 'file', uri: 'asset:cached', mime: 'text/plain', name: 'x' },
        },
      ],
      { assetStore: store, rest, uploadedAssetByUri: uploaded },
    );

    expect(failed).toEqual([]);
    expect(uploadFile).not.toHaveBeenCalled();
  });
});
