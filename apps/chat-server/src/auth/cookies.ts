/**
 * Cookie 读写工具。
 *
 * - HTTP（Hono）侧：用 `hono/cookie` 的 helper。
 * - WS upgrade 侧：拿到的是 raw Node `IncomingMessage`，自行解析 `Cookie` header。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';

export const COOKIE_ACCESS = 'wc_token';
export const COOKIE_REFRESH = 'wc_refresh';

export interface CookieOptions {
  /** true 时设置 Secure；nginx 已 TLS 时一般 auto 即可。 */
  secure: boolean;
  /** 显式 domain（如 `kuroneko.chat`）。省略则浏览器按当前 host 设。 */
  domain?: string;
}

export function setAuthCookiesHono(
  c: Context,
  tokens: { access: string; refresh?: string },
  opts: CookieOptions,
): void {
  setCookie(c, COOKIE_ACCESS, tokens.access, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: opts.secure,
    path: '/',
    domain: opts.domain,
    maxAge: 60 * 60,
  });
  if (tokens.refresh) {
    setCookie(c, COOKIE_REFRESH, tokens.refresh, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: opts.secure,
      path: '/',
      domain: opts.domain,
      maxAge: 7 * 24 * 60 * 60,
    });
  }
}

export function clearAuthCookiesHono(c: Context, opts: CookieOptions): void {
  const common = { path: '/', domain: opts.domain, secure: opts.secure } as const;
  deleteCookie(c, COOKIE_ACCESS, common);
  deleteCookie(c, COOKIE_REFRESH, common);
}

/** WS upgrade 处理时用的原生 cookie 解析（不依赖 cookie npm 包）。 */
export function readCookiesFromRequest(req: IncomingMessage): Record<string, string> {
  const header = req.headers['cookie'];
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** nginx 终止 TLS 时通过 `X-Forwarded-Proto` 判定原始协议。 */
export function isRequestSecure(req: Pick<IncomingMessage, 'headers' | 'socket'>): boolean {
  const sock = req.socket as unknown as { encrypted?: boolean } | undefined;
  if (sock?.encrypted) return true;
  const proto = req.headers['x-forwarded-proto'];
  if (!proto) return false;
  const v = Array.isArray(proto) ? proto[0] : proto.split(',')[0]?.trim();
  return v === 'https';
}

/** Hono Context 适配（c.req.raw 是 Fetch Request，没有 IncomingMessage.headers 的 record 形态）。 */
export function isHonoRequestSecure(c: Context): boolean {
  const proto = c.req.header('x-forwarded-proto');
  if (proto) {
    const v = proto.split(',')[0]?.trim();
    if (v === 'https') return true;
  }
  // Hono 在 @hono/node-server 下：c.env?.incoming 是 IncomingMessage
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
  if (incoming) return isRequestSecure(incoming);
  return false;
}

/** 写 Set-Cookie 到 raw http ServerResponse（暂未使用，留作 upgrade 期间刷新 token 用）。 */
export function appendSetCookie(res: ServerResponse, cookies: string[]): void {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookies);
    return;
  }
  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, ...cookies]);
    return;
  }
  res.setHeader('Set-Cookie', [String(existing), ...cookies]);
}
