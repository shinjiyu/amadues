/**
 * 扫描 goal Markdown 中的本地图片 `![](相对路径)`，调用当前 provider 的视觉模型生成一句摘要，
 * 追加到 goal 末尾，便于 Pi-mono 仅读文本也能获得图像语义。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadInnerLlmEnvFromProcess, runInnerLlmStep, type InnerLlmEnv } from '../llm/inner-llm-step.js';

/** Markdown 图片：`![](path)` */
const IMG_MD = /!\[([^\]]*)]\(([^)]+)\)/g;
const MAX_IMAGES = 5;
const MAX_BYTES = 6 * 1024 * 1024;

function mimeFromExt(ext: string): string {
  const e = ext.toLowerCase();
  if (e === '.png') return 'image/png';
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.webp') return 'image/webp';
  if (e === '.gif') return 'image/gif';
  return 'image/png';
}

export async function enrichGoalMarkdownWithVision(
  workDir: string,
  goalMd: string,
  env?: InnerLlmEnv | null,
): Promise<{ text: string; imagesProcessed: number }> {
  const llm = env ?? loadInnerLlmEnvFromProcess();
  if (!llm) return { text: goalMd, imagesProcessed: 0 };

  const root = path.resolve(workDir);
  const lines: string[] = [];
  let n = 0;

  for (const m of goalMd.matchAll(IMG_MD)) {
    if (n >= MAX_IMAGES) break;
    const raw = m[2]!.trim();
    if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:')) continue;

    const full = path.resolve(root, raw);
    if (!full.startsWith(root)) continue;
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;

    const ext = path.extname(full);
    if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext.toLowerCase())) continue;

    const buf = fs.readFileSync(full);
    if (buf.length > MAX_BYTES) continue;

    const b64 = buf.toString('base64');
    const mime = mimeFromExt(ext);
    const r = await runInnerLlmStep(llm, {
      goalMarkdown:
        '图中信息与用户任务相关。请用 2～4 句中文客观描述图中可见的关键内容（勿编造图中没有的信息）。',
      imageBase64: b64,
      imageMime: mime,
    });
    lines.push(`- \`${raw}\`: ${r.assistantText}`);
    n++;
  }

  if (lines.length === 0) return { text: goalMd, imagesProcessed: 0 };

  const appendix =
    '\n\n## 附图摘要（外脑自动视觉，供仅文本管线使用）\n' + lines.join('\n') + '\n';
  return { text: goalMd + appendix, imagesProcessed: lines.length };
}
