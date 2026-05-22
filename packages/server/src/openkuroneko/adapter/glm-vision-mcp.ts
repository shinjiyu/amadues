/**
 * 智谱视觉理解 MCP 客户端 — 仅用于 GLM 适配器内
 *
 * 调用 @z_ai/mcp-server 的 analyze_image 工具，将图片转为文字描述，
 * 便于在 Coding 端点 + glm-5 下使用套餐的「视觉理解 MCP」额度。
 * 文档：https://docs.bigmodel.cn/cn/coding-plan/mcp/vision-mcp-server
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const MCP_SERVER_CMD = 'npx';
const MCP_SERVER_ARGS = ['-y', '@z_ai/mcp-server@latest'];
const MCP_TIMEOUT_MS = 60_000;

interface McpToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

/**
 * 调用视觉 MCP 的 analyze_image，返回图片描述文本。
 * @param apiKey 智谱 API Key（与 OPENAI_API_KEY 同源）
 * @param imageSource 本地文件路径或可访问的图片 URL（data URL 需先写入临时文件再传路径）
 * @param prompt 分析提示，如「描述这张图片的内容，便于后续对话理解。」
 */
export async function analyzeImageWithMcp(
  apiKey: string,
  imageSource: string,
  prompt: string,
): Promise<string> {
  const child = spawn(MCP_SERVER_CMD, MCP_SERVER_ARGS, {
    env: { ...process.env, Z_AI_API_KEY: apiKey, Z_AI_MODE: 'ZHIPU' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const initReq = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'openkuroneko-glm', version: '1.0' },
    },
  };
  const callReq = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'analyze_image', arguments: { image_source: imageSource, prompt } },
  };
  child.stdin!.write(JSON.stringify(initReq) + '\n');
  child.stdin!.write(JSON.stringify(callReq) + '\n');
  child.stdin!.end();

  let text = '';
  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  const timeout = setTimeout(() => {
    child.kill('SIGTERM');
  }, MCP_TIMEOUT_MS);

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as {
          id?: number;
          result?: McpToolCallResult;
          error?: { message: string };
        };
        if (msg.error) throw new Error(msg.error.message || 'Vision MCP error');
        if (msg.id === 2 && msg.result?.content) {
          for (const c of msg.result.content) {
            if (c.type === 'text' && c.text) text += c.text;
          }
          break;
        }
      } catch (e) {
        if (e instanceof Error && e.message === 'Vision MCP error') throw e;
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  return text || '(图片分析无文本结果)';
}
