/**
 * playwright 引擎 —— Chromium 无头浏览器
 *
 * 每次调用独立启动 / 关闭，保持无状态。
 * 需要预先安装：npx playwright install chromium
 */

import { formatResults, parseDDGResults, truncatePage } from './html-parser.js';

const DDG_HTML_URL = 'https://html.duckduckgo.com/html/';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPage = any;

async function withBrowser<T>(fn: (page: AnyPage) => Promise<T>): Promise<T> {
  // Dynamic import so missing playwright doesn't crash at startup
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pw: any;
  try {
    pw = await import('playwright');
  } catch {
    throw new Error(
      'playwright not installed. Run: npx playwright install chromium'
    );
  }

  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; openKuroneko/1.0)',
  });
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await browser.close();
  }
}

export async function playwrightSearch(query: string, maxResults: number): Promise<string> {
  return withBrowser(async (page: AnyPage) => {
    const url = `${DDG_HTML_URL}?q=${encodeURIComponent(query)}&b=&kl=wt-wt`;
    await page.goto(url, { timeout: 20_000, waitUntil: 'domcontentloaded' });
    const html: string = await page.content();
    const results = parseDDGResults(html, maxResults);
    return formatResults(results);
  });
}

export async function playwrightFetch(url: string): Promise<string> {
  return withBrowser(async (page: AnyPage) => {
    await page.goto(url, { timeout: 20_000, waitUntil: 'domcontentloaded' });
    const text: string = await page.innerText('body');
    return truncatePage(text.replace(/\s+/g, ' ').trim());
  });
}
