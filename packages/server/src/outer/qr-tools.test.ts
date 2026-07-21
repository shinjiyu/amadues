/**
 * ADL: outerToolRegistry · qr_generate
 * path: packages/server/src/outer/qr-tools.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ChatAssetStore, type ChatIROutboundBody } from '@utlra/chat-ir';
import { QR_TOOL_DEFS, dispatchQrTool, generateQrPng } from './qr-tools.js';
import { OUTER_TOOL_DEFS, type OuterToolContext } from './outer-tools.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-tools-'));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function harness() {
  const assetStore = new ChatAssetStore(tmpDir);
  const posted: ChatIROutboundBody[] = [];
  const ctx = {
    threadId: 't:qr',
    agentSid: 'idp:agent:assistant',
    assetStore,
    imClient: {
      start() {},
      destroy() {},
      async postMessage(_tid: string, body: ChatIROutboundBody) {
        posted.push(body);
      },
    },
  } as unknown as OuterToolContext;
  return { ctx, posted, assetStore };
}

describe('qr-tools', () => {
  it('tool defs are registered in OUTER_TOOL_DEFS', () => {
    const names = OUTER_TOOL_DEFS.map((d) => d.function.name);
    for (const def of QR_TOOL_DEFS) expect(names).toContain(def.function.name);
  });

  it('generateQrPng → 合法 PNG', async () => {
    const png = await generateQrPng('https://example.com/x');
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.length).toBeGreaterThan(200);
  });

  it('qr_generate：存 asset + 发 attachment 到当前 thread', async () => {
    const { ctx, posted, assetStore } = harness();
    const res = await dispatchQrTool(
      'qr_generate',
      { content: 'https://open.feishu.cn/launcher?user_code=AB', caption: '扫这个' },
      ctx,
    );
    expect(res!.replied).toBe(true);
    expect(res!.output).toMatch(/asset:[0-9a-f-]{36}/);

    expect(posted).toHaveLength(1);
    const parts = posted[0]!.parts as Array<{ type: string; asset_ref?: { uri: string; mime: string } }>;
    const attach = parts.find((p) => p.type === 'attachment');
    expect(attach!.asset_ref!.mime).toBe('image/png');
    const id = attach!.asset_ref!.uri.replace('asset:', '');
    expect(assetStore.get(id)!.buffer.subarray(1, 4).toString()).toBe('PNG');
    expect(posted[0]!.text).toBe('扫这个');
  });

  it('content 为空 / 超长 → 拒绝', async () => {
    const { ctx } = harness();
    const empty = await dispatchQrTool('qr_generate', {}, ctx);
    expect(empty!.output).toContain('为空');
    const long = await dispatchQrTool('qr_generate', { content: 'x'.repeat(2001) }, ctx);
    expect(long!.output).toContain('2000');
  });

  it('unknown tool name returns null', async () => {
    const { ctx } = harness();
    expect(await dispatchQrTool('reply_to_user', {}, ctx)).toBeNull();
  });
});
