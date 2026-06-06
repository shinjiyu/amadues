/**
 * 内脑识图：workDir 内栅格图 → 文字描述 → 进 ReAct 工具输出。
 * 默认走智谱 Vision MCP（ZHIPU_API_KEY）；无 Key 时回退 runInnerLlmStep 多模态。
 * ADL: doc/structurizr/INNER-VISION-TOOL.md
 */
import fs from 'node:fs';
import path from 'node:path';

import { analyzeImageWithMcp } from '../../adapter/glm-vision-mcp.js';
import {
  loadInnerLlmEnvFromProcess,
  runInnerLlmStep,
  type InnerLlmEnv,
  type InnerLlmStepInput,
  type InnerLlmStepResult,
} from '../../../llm/inner-llm-step.js';
import type { Tool } from '../index.js';
import { getWorkDir, isPathReadable, pathSecurityError } from './workdir-guard.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const DEFAULT_MAX_BYTES = 6 * 1024 * 1024;

/** describe_image 固定走智谱 MCP 时的输出头模型名 */
export const ZHIPU_VISION_MCP_LABEL = 'zhipu-vision-mcp';

export const DEFAULT_DESCRIBE_IMAGE_PROMPT =
  '客观描述图中可见的关键内容（文字、布局、UI 状态、错误信息等）。2～6 句中文；勿编造图中没有的信息。';

function mimeFromExt(ext: string): string {
  const e = ext.toLowerCase();
  if (e === '.png') return 'image/png';
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.webp') return 'image/webp';
  if (e === '.gif') return 'image/gif';
  return 'image/png';
}

/** 识图专用：有 ZHIPU_API_KEY 即走智谱，不受 UTLRA_INNER_LLM_PROVIDER 影响。 */
export function resolveZhipuApiKeyForDescribeImage(): string | null {
  const v = process.env['ZHIPU_API_KEY']?.trim();
  return v ? v : null;
}

export interface DescribeImageFileOpts {
  prompt?: string;
  maxBytes?: number;
  loadEnv?: () => InnerLlmEnv | null;
  describe?: (env: InnerLlmEnv, input: InnerLlmStepInput) => Promise<InnerLlmStepResult>;
  resolveZhipuKey?: () => string | null;
  mcpDescribe?: (apiKey: string, imagePath: string, prompt: string) => Promise<string>;
}

export type DescribeImageFileResult =
  | { ok: true; output: string; visionModel: string; bytes: number; relPath: string }
  | { ok: false; output: string };

/**
 * 对绝对路径栅格图调用 vision；供单测注入 mock。
 */
export async function describeImageFile(
  absPath: string,
  relPath: string,
  opts: DescribeImageFileOpts = {},
): Promise<DescribeImageFileResult> {
  const ext = path.extname(absPath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      output: `Not a supported image (${ext || 'no extension'}); use .png .jpg .jpeg .webp .gif`,
    };
  }

  let st: fs.Stats;
  try {
    st = fs.statSync(absPath);
  } catch (e) {
    return { ok: false, output: String(e) };
  }
  if (!st.isFile()) return { ok: false, output: `Not a file: ${relPath}` };

  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  if (st.size > maxBytes) {
    return {
      ok: false,
      output: `Image too large (${st.size} bytes); max ${maxBytes}.`,
    };
  }
  if (st.size === 0) return { ok: false, output: 'Image file is empty.' };

  const prompt = opts.prompt?.trim() || DEFAULT_DESCRIBE_IMAGE_PROMPT;

  const zhipuKey = (opts.resolveZhipuKey ?? resolveZhipuApiKeyForDescribeImage)();
  if (zhipuKey && !opts.describe) {
    const mcp = opts.mcpDescribe ?? analyzeImageWithMcp;
    try {
      const text = (await mcp(zhipuKey, absPath, prompt)).trim() || '（视觉 MCP 未返回描述）';
      const header = `[describe_image: ${ZHIPU_VISION_MCP_LABEL}, ${st.size} bytes, ${relPath}]`;
      return {
        ok: true,
        output: `${header}\n${text}`,
        visionModel: ZHIPU_VISION_MCP_LABEL,
        bytes: st.size,
        relPath,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, output: `Vision MCP error: ${msg}` };
    }
  }

  const llm = (opts.loadEnv ?? loadInnerLlmEnvFromProcess)();
  if (!llm) {
    return {
      ok: false,
      output:
        'Vision API 未配置：describe_image 需要 ZHIPU_API_KEY（智谱 Vision MCP），或配置 LOCALMODULE/KIMI 多模态回退。',
    };
  }

  const buf = fs.readFileSync(absPath);
  const b64 = buf.toString('base64');
  const mime = mimeFromExt(ext);
  const describe = opts.describe ?? ((env, input) => runInnerLlmStep(env, input));

  try {
    const result = await describe(llm, {
      goalMarkdown: prompt,
      imageBase64: b64,
      imageMime: mime,
    });
    const header = `[describe_image: ${llm.visionModel}, ${st.size} bytes, ${relPath}]`;
    const body = result.assistantText.trim() || '（视觉模型未返回描述）';
    return {
      ok: true,
      output: `${header}\n${body}`,
      visionModel: llm.visionModel,
      bytes: st.size,
      relPath,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, output: `Vision API error: ${msg}` };
  }
}

export const describeImageTool: Tool = {
  name: 'describe_image',
  description:
    'Describe a raster image in the workspace using Zhipu Vision MCP (requires ZHIPU_API_KEY). ' +
    'Use when read_file rejects binary or after Playwright/shell saves a screenshot. Returns Chinese text summary.',
  parameters: {
    path: { type: 'string', description: 'Image path relative to workDir (e.g. .run/screenshot.png)' },
    prompt: {
      type: 'string',
      description: 'Optional question about the image (OCR, captcha, UI state, errors). Default: objective scene description.',
    },
  },
  required: ['path'],
  async call(args): Promise<{ ok: boolean; output: string }> {
    const rel = String(args['path'] ?? '').trim();
    if (!rel) return { ok: false, output: 'Missing required argument: path' };

    const abs = path.isAbsolute(rel) ? path.normalize(rel) : path.join(getWorkDir(), rel);
    if (!isPathReadable(abs)) return { ok: false, output: pathSecurityError(abs) };

    const displayRel = path.isAbsolute(rel) ? path.relative(getWorkDir(), abs).replace(/\\/g, '/') : rel.replace(/\\/g, '/');
    const result = await describeImageFile(abs, displayRel, {
      prompt: typeof args['prompt'] === 'string' ? args['prompt'] : undefined,
    });
    return { ok: result.ok, output: result.output };
  },
};
