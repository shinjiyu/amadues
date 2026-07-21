/**
 * ADL: outerToolRegistry · view_image
 * path: packages/server/src/outer/vision-tools.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ChatAssetStore } from '@utlra/chat-ir';
import { VISION_TOOL_DEFS, dispatchVisionTool, execViewImage } from './vision-tools.js';
import { OUTER_TOOL_DEFS, type OuterToolContext } from './outer-tools.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-tools-'));
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function harness() {
  const assetStore = new ChatAssetStore(tmpDir);
  const seen: Array<{ absPath: string; prompt?: string; existed: boolean }> = [];
  const ctx = {
    assetStore,
    visionDescribe: async (absPath: string, _rel: string, opts: { prompt?: string }) => {
      seen.push({ absPath, ...(opts.prompt ? { prompt: opts.prompt } : {}), existed: fs.existsSync(absPath) });
      return { ok: true as const, output: '一张测试图片', visionModel: 'mock', bytes: PNG.length, relPath: _rel };
    },
  } as unknown as OuterToolContext;
  return { ctx, assetStore, seen };
}

describe('vision-tools · view_image', () => {
  it('tool defs are registered in OUTER_TOOL_DEFS', () => {
    const names = OUTER_TOOL_DEFS.map((d) => d.function.name);
    for (const def of VISION_TOOL_DEFS) expect(names).toContain(def.function.name);
  });

  it('asset → 临时文件 → describe → 描述文本；临时文件事后清理', async () => {
    const { ctx, assetStore, seen } = harness();
    const meta = assetStore.save(PNG, 'image/png', 'photo.png');
    const res = await dispatchVisionTool('view_image', { asset_id: `asset:${meta.id}`, prompt: '图里有什么' }, ctx);
    expect(res!.output).toBe('一张测试图片');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.prompt).toBe('图里有什么');
    expect(seen[0]!.existed).toBe(true);
    expect(fs.existsSync(seen[0]!.absPath)).toBe(false); // 已清理
  });

  it('asset 不存在 / 非图片 / 空 id → 明确错误', async () => {
    const { ctx, assetStore } = harness();
    const missing = await execViewImage({ asset_id: '00000000-0000-4000-8000-000000000000' }, ctx);
    expect(missing.output).toContain('不存在');

    const doc = assetStore.save(Buffer.from('text'), 'text/markdown', 'a.md');
    const notImage = await execViewImage({ asset_id: doc.id }, ctx);
    expect(notImage.output).toContain('不是图片');

    const empty = await execViewImage({}, ctx);
    expect(empty.output).toContain('为空');
  });

  it('unknown tool name returns null', async () => {
    const { ctx } = harness();
    expect(await dispatchVisionTool('reply_to_user', {}, ctx)).toBeNull();
  });
});
