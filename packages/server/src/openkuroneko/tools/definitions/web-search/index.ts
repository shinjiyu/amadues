/**
 * web_search 工具 — curl / playwright 双引擎
 *
 * 协议文档：doc/protocols/web-search.md
 *
 * action=search : 搜索 DuckDuckGo，返回结构化结果列表
 * action=fetch  : 抓取指定 URL 的纯文本内容
 *
 * 引擎选择（优先级）：
 *   1. 工具参数 engine
 *   2. 环境变量 OPENKURONEKO_SEARCH_ENGINE
 *   3. 默认 'curl'
 */

import type { Tool } from '../../index.js';
import { curlFetch, curlSearch } from './engine-curl.js';
import { playwrightFetch, playwrightSearch } from './engine-playwright.js';

type Engine = 'curl' | 'playwright';

function resolveEngine(override?: unknown): Engine {
  if (override === 'playwright') return 'playwright';
  if (override === 'curl') return 'curl';
  const env = process.env['OPENKURONEKO_SEARCH_ENGINE'];
  if (env === 'playwright') return 'playwright';
  return 'curl';
}

export const webSearchTool: Tool = {
  name: 'web_search',
  description: 'Search the web or fetch a URL.',
  parameters: {
    action:      { type: 'string', description: '"search" to query DuckDuckGo, "fetch" to retrieve a URL as plain text', enum: ['search', 'fetch'] },
    query:       { type: 'string', description: 'Search query (required when action="search")' },
    url:         { type: 'string', description: 'URL to fetch (required when action="fetch")' },
    engine:      { type: 'string', description: '"curl" (default) or "playwright"', enum: ['curl', 'playwright'] },
    max_results: { type: 'number', description: 'Max results to return (default 5, max 10)' },
  },
  required: ['action'],

  async call(args): Promise<{ ok: boolean; output: string }> {
    const action     = String(args['action'] ?? 'search');
    const engine     = resolveEngine(args['engine']);
    const maxResults = Math.min(Number(args['max_results'] ?? 5), 10);

    try {
      if (action === 'search') {
        const query = String(args['query'] ?? '').trim();
        if (!query) return { ok: false, output: 'Missing required argument: query' };

        const output = engine === 'playwright'
          ? await playwrightSearch(query, maxResults)
          : curlSearch(query, maxResults);

        return { ok: true, output };
      }

      if (action === 'fetch') {
        const url = String(args['url'] ?? '').trim();
        if (!url) return { ok: false, output: 'Missing required argument: url' };

        const output = engine === 'playwright'
          ? await playwrightFetch(url)
          : curlFetch(url);

        return { ok: true, output };
      }

      return { ok: false, output: `Unknown action: ${action}. Use "search" or "fetch".` };

    } catch (e: unknown) {
      return { ok: false, output: String(e instanceof Error ? e.message : e) };
    }
  },
};
