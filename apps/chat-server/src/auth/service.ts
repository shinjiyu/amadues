/**
 * AuthService —— 把 cookie/loginserver/whitelist 三件套粘到一起，给中间件/路由/WS 复用。
 */
import type { IncomingMessage } from 'node:http';

import { LoginServerClient } from './loginserver.js';
import { AuthStore } from './store.js';
import { COOKIE_ACCESS, COOKIE_REFRESH, readCookiesFromRequest } from './cookies.js';
import type { UserPrincipal } from './types.js';

export interface AuthServiceConfig {
  cookieSecure: 'auto' | 'always' | 'never';
  cookieDomain?: string;
}

export class AuthService {
  constructor(
    public readonly store: AuthStore,
    public readonly login: LoginServerClient,
    private readonly config: AuthServiceConfig,
  ) {}

  cookieOptsFor(secure: boolean): { secure: boolean; domain?: string } {
    const s =
      this.config.cookieSecure === 'always'
        ? true
        : this.config.cookieSecure === 'never'
        ? false
        : secure;
    const out: { secure: boolean; domain?: string } = { secure: s };
    if (this.config.cookieDomain) out.domain = this.config.cookieDomain;
    return out;
  }

  /**
   * 从 cookie 解出 UserPrincipal。
   * - access token 有效 → 直接返回
   * - access 失败、refresh 有效 → 走 refresh 拿新 access（**不**就地写回 cookie；
   *   交给上层 Hono 中间件用 `refreshIfNeeded` 显式写）
   * - 都失败 → null
   */
  async authenticateFromCookies(
    cookies: Record<string, string>,
  ): Promise<{ principal: UserPrincipal | null; newAccessToken?: string }> {
    const access = cookies[COOKIE_ACCESS];
    if (access) {
      const verified = await this.login.verify(access);
      if (verified) {
        const principal = await this.upsertPrincipal(verified.email, verified.user_id);
        return { principal };
      }
    }
    const refresh = cookies[COOKIE_REFRESH];
    if (refresh) {
      const refreshed = await this.login.refresh(refresh);
      if (refreshed) {
        const verified = await this.login.verify(refreshed.access_token);
        if (verified) {
          const principal = await this.upsertPrincipal(verified.email, verified.user_id);
          return { principal, newAccessToken: refreshed.access_token };
        }
      }
    }
    return { principal: null };
  }

  /** Convenience wrapper for raw http upgrade requests (cookie 只读，不刷新)。 */
  async authenticateUpgrade(req: IncomingMessage): Promise<UserPrincipal | null> {
    const cookies = readCookiesFromRequest(req);
    const r = await this.authenticateFromCookies(cookies);
    return r.principal;
  }

  /** 登录成功后调用：把 loginserver 信息回写到白名单条目（保留 userId/displayName）。 */
  async onLoginSuccess(
    email: string,
    userId: string,
    username?: string,
  ): Promise<UserPrincipal | null> {
    const norm = AuthStore.normalizeEmail(email);
    const entry = this.store.getEntryByEmail(norm);
    if (!entry || entry.status !== 'active') return null;
    const displayName = username?.trim() || entry.displayName || norm.split('@')[0]!;
    const updated = await this.store.upsert({
      email: norm,
      addedBy: entry.addedBy,
      role: entry.role,
      status: entry.status,
      displayName,
      userId,
    });
    return {
      kind: 'user',
      userId: updated.userId ?? userId,
      email: norm,
      displayName: updated.displayName,
      role: updated.role,
    };
  }

  /** 启动时种子 admin（来自 `WEBCHAT_ADMIN_EMAILS`），不动 displayName/userId。 */
  async seedAdmins(emails: readonly string[]): Promise<void> {
    for (const raw of emails) {
      const email = AuthStore.normalizeEmail(raw);
      if (!email) continue;
      const existing = this.store.getEntryByEmail(email);
      await this.store.upsert({
        email,
        role: 'admin',
        status: 'active',
        addedBy: 'seed',
        ...(existing ? {} : { displayName: email.split('@')[0]! }),
      });
    }
  }

  private async upsertPrincipal(email: string, userId: string): Promise<UserPrincipal | null> {
    const norm = AuthStore.normalizeEmail(email);
    const entry = this.store.getEntryByEmail(norm);
    if (!entry || entry.status !== 'active') return null;
    // 首次拿到 userId 时回填到磁盘
    if (entry.userId !== userId) {
      await this.store.upsert({
        email: norm,
        addedBy: entry.addedBy,
        role: entry.role,
        status: entry.status,
        displayName: entry.displayName,
        userId,
      });
    }
    return {
      kind: 'user',
      userId,
      email: norm,
      displayName: entry.displayName,
      role: entry.role,
    };
  }
}
