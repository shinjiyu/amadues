/**
 * GLM（智谱）适配器 — 多模态仅在 GLM 内实现
 *
 * 智谱有两类端点：
 * - Coding：api/coding/paas/v4，适用 glm-5 等编码模型，不支持多模态；可用「视觉理解 MCP」将图转文再走 Coding
 * - 通用 PaaS：api/paas/v4，支持 GLM-4V 等视觉模型（image_url 格式与 OpenAI 一致）
 *
 * 当请求含图时：若 useVisionMcp 且为 Coding 端点，则先调视觉 MCP 将图转文字再走 textAdapter；否则用 paas + 视觉模型。
 * 参考：https://docs.bigmodel.cn/cn/coding-plan/mcp/vision-mcp-server
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { LLMAdapter, Message, ContentBlock } from './index.js';
import { createOpenAIAdapter } from './openai.js';
import { analyzeImageWithMcp } from './glm-vision-mcp.js';

/** 是否智谱 bigmodel 域名（用于决定是否启用本适配器的多模态路由） */
function isGLMBaseUrl(url: string): boolean {
  return url.includes('bigmodel.cn');
}

/** 是否 Coding 端点（用于优先走视觉 MCP 用套餐额度） */
function isCodingEndpoint(url: string): boolean {
  return url.includes('coding');
}

/**
 * 请求中是否包含 user 消息的 image_url block
 */
function hasImageInMessages(messages: Message[]): boolean {
  return messages.some((m) => {
    if (m.role !== 'user' || !Array.isArray(m.content)) return false;
    return (m.content as ContentBlock[]).some((b) => b.type === 'image_url');
  });
}

const VISION_MCP_DEFAULT_PROMPT = '描述这张图片的内容，便于后续对话理解。';

/**
 * 将 data URL 写入临时文件，返回路径；非 data URL 返回原 url（MCP 支持远程 URL）
 */
async function dataUrlToTempFile(dataUrl: string, index: number): Promise<{ path: string; cleanup: () => void } | null> {
  if (!dataUrl.startsWith('data:')) return null;
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  const ext = m[1]!.includes('png') ? 'png' : m[1]!.includes('gif') ? 'gif' : 'jpg';
  const tmpDir = process.env['OPENKURONEKO_TMP'] ?? os.tmpdir();
  const filePath = path.join(tmpDir, `vision-mcp-${Date.now()}-${index}.${ext}`);
  const b64 = m[2]!;
  fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
  return {
    path: filePath,
    cleanup: () => {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    },
  };
}

/**
 * 将 messages 中所有 user 的 image_url 块通过视觉 MCP 转为文字，返回新 messages（纯文本，可走 Coding）
 */
async function replaceImagesWithMcpDescriptions(
  apiKey: string,
  messages: Message[],
): Promise<Message[]> {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) {
      out.push(m);
      continue;
    }
    const blocks = m.content as ContentBlock[];
    const textParts: string[] = [];
    for (const b of blocks) {
      if (b.type === 'text') textParts.push(b.text);
    }
    const userPrompt = textParts.join(' ').trim() || VISION_MCP_DEFAULT_PROMPT;
    const newParts: string[] = [];
    let imageIndex = 0;
    for (const b of blocks) {
      if (b.type === 'text') {
        newParts.push(b.text);
        continue;
      }
      if (b.type === 'image_url' && b.image_url?.url) {
        const url = b.image_url.url;
        let source: string;
        let cleanup: (() => void) | undefined;
        if (url.startsWith('data:')) {
          const tmp = await dataUrlToTempFile(url, imageIndex++);
          if (!tmp) {
            newParts.push('[图片]');
            continue;
          }
          source = tmp.path;
          cleanup = tmp.cleanup;
        } else {
          source = url;
        }
        try {
          const desc = await analyzeImageWithMcp(apiKey, source, userPrompt);
          newParts.push(`[图片分析]：\n${desc}`);
        } catch {
          newParts.push('[图片]（分析失败，请用文字描述）');
        } finally {
          cleanup?.();
        }
      }
    }
    out.push({ ...m, content: newParts.join('\n').trim() || '[图片]' });
  }
  return out;
}

export function createGLMAdapter(options?: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /**
   * 含图时是否优先用「视觉理解 MCP」将图转文再走 Coding（用套餐额度）。
   * 默认：Coding 端点时为 true，否则 false。
   */
  useVisionMcp?: boolean;
  /**
   * 多模态请求使用的 baseUrl（未用 MCP 时含图请求）。
   * 默认智谱通用 PaaS：https://open.bigmodel.cn/api/paas/v4
   */
  visionBaseUrl?: string;
  /**
   * 多模态请求使用的模型（未用 MCP 时含图请求）。
   * 默认 glm-4v-flash（免费）；可改为 glm-4.5v 等。
   */
  visionModel?: string;
  toolWireFormat?: 'openai' | 'minimal';
  extraBody?: Record<string, unknown>;
}): LLMAdapter {
  const apiKey = options?.apiKey ?? readEnvTrimmed('KIMI_API_KEY') ?? readEnvTrimmed('OPENAI_API_KEY') ?? '';
  const baseUrl = options?.baseUrl ?? readEnvTrimmed('KIMI_BASE_URL') ?? readEnvTrimmed('OPENAI_BASE_URL') ?? '';
  const model = options?.model ?? readEnvTrimmed('KIMI_MODEL') ?? readEnvTrimmed('OPENAI_MODEL') ?? 'gpt-4o';
  const visionBaseUrl = options?.visionBaseUrl ?? 'https://open.bigmodel.cn/api/paas/v4';
  const visionModel = options?.visionModel ?? process.env['GLM_VISION_MODEL'] ?? 'glm-4v-flash';
  const useVisionMcp = options?.useVisionMcp ?? (baseUrl.includes('bigmodel') && baseUrl.includes('coding'));

  const textWireFormat = options?.toolWireFormat ?? (baseUrl.includes('bigmodel') ? 'minimal' : undefined);
  const textAdapter = createOpenAIAdapter({
    apiKey,
    baseUrl,
    model,
    ...(textWireFormat !== undefined ? { toolWireFormat: textWireFormat } : {}),
    extraBody: options?.extraBody ?? {},
  });

  const visionAdapter = createOpenAIAdapter({
    apiKey,
    baseUrl: visionBaseUrl,
    model: visionModel,
    toolWireFormat: 'minimal',
    extraBody: options?.extraBody ?? {},
  });

  return {
    async chat(systemPrompt: string, messages: Message[], tools?: object[]) {
      if (!isGLMBaseUrl(baseUrl) || !hasImageInMessages(messages)) {
        return textAdapter.chat(systemPrompt, messages, tools);
      }
      if (useVisionMcp && isCodingEndpoint(baseUrl)) {
        const textOnly = await replaceImagesWithMcpDescriptions(apiKey, messages);
        return textAdapter.chat(systemPrompt, textOnly, tools);
      }
      return visionAdapter.chat(systemPrompt, messages, tools);
    },
    async stream(systemPrompt: string, messages: Message[], onChunk) {
      if (!isGLMBaseUrl(baseUrl) || !hasImageInMessages(messages)) {
        return textAdapter.stream!(systemPrompt, messages, onChunk);
      }
      if (useVisionMcp && isCodingEndpoint(baseUrl)) {
        const textOnly = await replaceImagesWithMcpDescriptions(apiKey, messages);
        return textAdapter.stream!(systemPrompt, textOnly, onChunk);
      }
      return visionAdapter.stream!(systemPrompt, messages, onChunk);
    },
  };
}

function readEnvTrimmed(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}
