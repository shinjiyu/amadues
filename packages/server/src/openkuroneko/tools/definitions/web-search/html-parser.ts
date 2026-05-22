/**
 * 解析 DuckDuckGo HTML 接口返回的搜索结果页面
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** HTML entity decode + strip tags */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从 DuckDuckGo HTML 响应中提取搜索结果。
 * DuckDuckGo HTML 结构（POST https://html.duckduckgo.com/html/）：
 *   <div class="result results_links ...">
 *     <h2 class="result__title">
 *       <a class="result__a" href="...">Title</a>
 *     </h2>
 *     <div class="result__body">
 *       <a class="result__url" href="...">url.example.com</a>
 *       <a class="result__snippet" ...>Snippet text</a>
 *     </div>
 *   </div>
 */
export function parseDDGResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // 以 result__title 为锚点，提取每个结果块
  const titleRe = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const urlRe   = /<a[^>]+class="result__url"[^>]*>([\s\S]*?)<\/a>/g;
  const snipRe  = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const titles:   Array<{ href: string; text: string }> = [];
  const urls:     string[] = [];
  const snippets: string[] = [];

  for (const m of html.matchAll(titleRe)) {
    titles.push({ href: m[1] ?? '', text: stripHtml(m[2] ?? '') });
  }
  for (const m of html.matchAll(urlRe)) {
    urls.push(stripHtml(m[1] ?? ''));
  }
  for (const m of html.matchAll(snipRe)) {
    snippets.push(stripHtml(m[1] ?? ''));
  }

  const count = Math.min(titles.length, maxResults);
  for (let i = 0; i < count; i++) {
    const t = titles[i];
    if (!t || !t.text) continue;
    results.push({
      title:   t.text,
      url:     urls[i] ?? t.href,
      snippet: snippets[i] ?? '',
    });
  }

  return results;
}

export function formatResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No results found.';
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    ${r.snippet}`)
    .join('\n\n');
}

export function truncatePage(text: string, maxChars = 8000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n[...truncated]';
}
