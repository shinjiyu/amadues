/**
 * ADL: outerToolRegistry · view_image
 * path: packages/server/src/outer/vision-tools.ts
 * horizon.intention: 外脑识图——入站消息里的图片 attachment（`[file:image asset:<uuid>]`）
 *   → ChatAssetStore 取出 → 临时文件 → 复用内脑 describeImageFile（智谱 Vision MCP，
 *   无 Key 回退多模态）→ 文字描述回工具循环。
 * horizon.in:  LLM tool call view_image(asset_id, prompt?)
 * horizon.out: 图片文字描述（不产生 IM 副作用）
 * @see doc/structurizr/INNER-VISION-TOOL.md（内脑同款管线）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  describeImageFile,
  type DescribeImageFileResult,
} from '../openkuroneko/tools/definitions/describe-image.js';
import type { OuterToolContext, ToolCallResult, ToolDef } from './outer-tools.js';

export const VISION_TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'view_image',
      description:
        '查看聊天中的图片内容（识图）。当消息里出现 [file:image asset:<uuid>] 附件时，' +
        '用它的 asset id 调用本工具，返回图片的文字描述。',
      parameters: {
        type: 'object',
        properties: {
          asset_id: { type: 'string', description: '图片 asset id（裸 UUID，可带 asset: 前缀）' },
          prompt: { type: 'string', description: '（可选）针对图片的具体问题，如 OCR、UI 状态' },
        },
        required: ['asset_id'],
      },
    },
  },
];

const EXT_BY_MIME: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

export type ViewImageDescribe = (
  absPath: string,
  relPath: string,
  opts: { prompt?: string },
) => Promise<DescribeImageFileResult>;

export async function execViewImage(
  args: { asset_id?: string; prompt?: string },
  ctx: OuterToolContext,
  describeImpl: ViewImageDescribe = describeImageFile,
): Promise<ToolCallResult> {
  const raw = args.asset_id?.trim() ?? '';
  if (!raw) return { replied: false, output: '（asset_id 为空）' };
  const assetId = raw.startsWith('asset:') ? raw.slice('asset:'.length) : raw;

  const got = ctx.assetStore.get(assetId);
  if (!got) return { replied: false, output: `（asset ${assetId} 不存在或已过期）` };
  const mime = got.meta.mime ?? '';
  if (!mime.startsWith('image/')) {
    return { replied: false, output: `（asset ${assetId} 不是图片：${mime || '未知类型'}）` };
  }

  const ext = EXT_BY_MIME[mime] ?? '.png';
  const tmpPath = path.join(os.tmpdir(), `utlra-view-image-${randomUUID()}${ext}`);
  try {
    fs.writeFileSync(tmpPath, got.buffer);
    const result = await describeImpl(tmpPath, got.meta.name || `asset:${assetId}`, {
      ...(args.prompt?.trim() ? { prompt: args.prompt.trim() } : {}),
    });
    return { replied: false, output: result.output };
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* 临时文件清理失败不影响结果 */
    }
  }
}

export async function dispatchVisionTool(
  name: string,
  args: Record<string, unknown>,
  ctx: OuterToolContext,
): Promise<ToolCallResult | null> {
  if (name === 'view_image') {
    return execViewImage(args as { asset_id?: string; prompt?: string }, ctx, ctx.visionDescribe);
  }
  return null;
}
