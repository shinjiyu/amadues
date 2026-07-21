/**
 * ADL: outerToolRegistry · qr_generate
 * path: packages/server/src/outer/qr-tools.ts
 * horizon.intention: URL/文本 → 二维码 PNG（ChatAssetStore 资产）→ 发到当前 thread。
 *   通道扫码流（channel-scan-tools P4a/P4b）复用 generateQrPng 自动附图。
 * horizon.in:  LLM tool call qr_generate；channel-scan-tools 内部调用
 * horizon.out: asset:<uuid>（image/png）+ imClient.postMessage attachment
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §6.6
 */
import QRCode from 'qrcode';
import type { OuterToolContext, ToolCallResult, ToolDef } from './outer-tools.js';

export const QR_TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'qr_generate',
      description:
        '把 URL 或文本生成二维码 PNG 并发送到当前对话（webchat 内联显示，手机可直接扫）。' +
        '返回 asset id，可再用 reply_to_user 的 attach_asset_ids 复用。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '要编码的 URL 或文本（≤2000 字符）' },
          caption: { type: 'string', description: '（可选）随图发送的说明文字' },
        },
        required: ['content'],
      },
    },
  },
];

/** 文本 → 二维码 PNG buffer（margin/纠错取扫码友好的默认值） */
export async function generateQrPng(text: string): Promise<Buffer> {
  return QRCode.toBuffer(text, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 360,
  });
}

export async function execQrGenerate(
  args: { content?: string; caption?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const content = args.content?.trim() ?? '';
  if (!content) return { replied: false, output: '（content 为空）' };
  if (content.length > 2000) return { replied: false, output: '（content 超过 2000 字符，二维码容量不够）' };

  let png: Buffer;
  try {
    png = await generateQrPng(content);
  } catch (e) {
    return { replied: false, output: `二维码生成失败：${e instanceof Error ? e.message : String(e)}` };
  }

  const meta = ctx.assetStore.save(png, 'image/png', 'qrcode.png');
  const caption = args.caption?.trim() || `二维码：${content.length > 80 ? `${content.slice(0, 80)}…` : content}`;
  await ctx.imClient.postMessage(ctx.threadId, {
    sender_sid: ctx.agentSid,
    text: caption,
    parts: [
      { type: 'text', text: caption },
      {
        type: 'attachment',
        asset_ref: { kind: 'image', uri: `asset:${meta.id}`, mime: 'image/png', name: 'qrcode.png' },
      },
    ],
  });
  return {
    replied: true,
    output: `二维码已发送（asset:${meta.id}，${png.length} bytes）`,
  };
}

export async function dispatchQrTool(
  name: string,
  args: Record<string, unknown>,
  ctx: OuterToolContext,
): Promise<ToolCallResult | null> {
  if (name === 'qr_generate') return execQrGenerate(args as { content?: string; caption?: string }, ctx);
  return null;
}
