import type { Mem0Client } from './index.js';

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * fetch with AbortController timeout
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mem0 REST 客户端
 *
 * 全局单实例，各 agent 以 user_id = agent_id 隔离。
 * 协议文档：doc/protocols/memory-interface.md
 *
 * Graceful degrade：Mem0 不可达时 add 静默忽略，search 返回空列表，
 * 不中断 Agent 主循环。
 */
export function createMem0Client(options?: {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
}): Mem0Client {
  const baseUrl   = options?.baseUrl   ?? process.env['MEM0_BASE_URL']  ?? 'http://localhost:8000';
  const apiKey    = options?.apiKey    ?? process.env['MEM0_API_KEY']   ?? '';
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Token ${apiKey}`;

  return {
    async add(content, agentId): Promise<void> {
      try {
        const res = await fetchWithTimeout(
          `${baseUrl}/v1/memories/`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              messages: [{ role: 'user', content }],
              user_id: agentId,
            }),
          },
          timeoutMs
        );
        if (!res.ok) {
          // Log non-200 but don't throw — degrade gracefully
          console.warn(`[mem0] add failed: HTTP ${res.status}`);
        }
      } catch (e) {
        // Network error or timeout — silently ignore
        console.warn(`[mem0] add error (service may be unavailable): ${String(e)}`);
      }
    },

    async search(query, agentId, limit = 5): Promise<string[]> {
      try {
        const res = await fetchWithTimeout(
          `${baseUrl}/v1/memories/search/`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({ query, user_id: agentId, limit }),
          },
          timeoutMs
        );
        if (!res.ok) {
          console.warn(`[mem0] search failed: HTTP ${res.status}`);
          return [];
        }
        const data = (await res.json()) as Array<{ memory: string }>;
        return data.map((d) => d.memory);
      } catch (e) {
        console.warn(`[mem0] search error (service may be unavailable): ${String(e)}`);
        return [];
      }
    },
  };
}
