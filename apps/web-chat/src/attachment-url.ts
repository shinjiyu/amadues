/** 附件下载/预览 URL：绝对 chat-server 地址归一为同源 `/uploads/...`（走 Vite 代理）。 */
export function resolveAttachmentFetchUrl(url: string): string {
  if (/^https?:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      if (u.pathname.startsWith('/uploads/')) {
        return `${u.pathname}${u.search}`;
      }
    } catch {
      /* ignore */
    }
  }
  return url;
}
