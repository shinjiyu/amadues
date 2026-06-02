/**
 * loginserver（Flask）HTTP 客户端，与 `D:/UGit/loginserver` 复用同样的 API：
 *
 *   POST /api/auth/login   { email, password } -> { success, data: { access_token, refresh_token, user } }
 *   GET  /api/auth/verify  Authorization: Bearer <token> -> { success, data: { user_id, email, type, exp, iat } }
 *   POST /api/auth/refresh { refresh_token } -> { success, data: { access_token } }
 *
 * `verify()`：配置了 `WEBCHAT_LOGIN_JWT_SECRET`（= loginserver `JWT_SECRET_KEY`）时 **本地 HS256 验签**，
 * 不再 HTTP 调 `/api/auth/verify`。未配置密钥时回退远程 verify（兼容旧部署）。
 *
 * `refresh()` 仍走 HTTP（需 loginserver 签发新 access token）。
 */
import { verifyAccessTokenLocally } from './jwt-local.js';

export interface LoginUser {
  id: string;
  email: string;
  username?: string;
  [k: string]: unknown;
}

export interface LoginSuccess {
  access_token: string;
  refresh_token: string;
  user: LoginUser;
}

export interface VerifiedPayload {
  user_id: string;
  email: string;
  type: 'access' | 'refresh';
  exp: number;
  iat: number;
}

export class LoginServerError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly serverMessage?: string,
  ) {
    super(message);
  }
}

export interface LoginServerClientOptions {
  /** 与 loginserver `JWT_SECRET_KEY` 相同；有则 verify 走本地 HS256。 */
  jwtSecret?: string | null;
}

export class LoginServerClient {
  private readonly jwtSecret: string | null;

  constructor(
    private readonly baseUrl: string,
    opts: LoginServerClientOptions = {},
  ) {
    if (!baseUrl) {
      throw new Error('LoginServerClient: baseUrl is required');
    }
    const raw = opts.jwtSecret?.trim();
    this.jwtSecret = raw && raw.length > 0 ? raw : null;
  }

  /** true = access token 本地验签，不依赖 loginserver HTTP。 */
  usesLocalJwtVerify(): boolean {
    return this.jwtSecret !== null;
  }

  async login(email: string, password: string): Promise<LoginSuccess> {
    const res = await this.post('/api/auth/login', { email, password });
    if (res.status === 401) {
      throw new LoginServerError('invalid credentials', 401, await readMessage(res));
    }
    if (!res.ok) {
      throw new LoginServerError(`loginserver error: ${res.status}`, res.status, await readMessage(res));
    }
    const body = (await res.json()) as { success?: boolean; data?: LoginSuccess; message?: string };
    if (!body.success || !body.data) {
      throw new LoginServerError(body.message || 'loginserver did not return data', res.status);
    }
    return body.data;
  }

  async verify(accessToken: string): Promise<VerifiedPayload | null> {
    if (this.jwtSecret) {
      return verifyAccessTokenLocally(accessToken, this.jwtSecret);
    }
    return this.verifyRemote(accessToken);
  }

  private async verifyRemote(accessToken: string): Promise<VerifiedPayload | null> {
    const res = await fetch(joinUrl(this.baseUrl, '/api/auth/verify'), {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 401) return null;
    if (!res.ok) {
      throw new LoginServerError(`verify failed: ${res.status}`, res.status, await readMessage(res));
    }
    const body = (await res.json()) as { success?: boolean; data?: VerifiedPayload };
    if (!body.success || !body.data) return null;
    if (body.data.type !== 'access') return null;
    return body.data;
  }

  async refresh(refreshToken: string): Promise<{ access_token: string } | null> {
    const res = await this.post('/api/auth/refresh', { refresh_token: refreshToken });
    if (res.status === 401) return null;
    if (!res.ok) {
      throw new LoginServerError(`refresh failed: ${res.status}`, res.status, await readMessage(res));
    }
    const body = (await res.json()) as { success?: boolean; data?: { access_token: string } };
    if (!body.success || !body.data?.access_token) return null;
    return body.data;
  }

  private post(pathname: string, body: unknown): Promise<Response> {
    return fetch(joinUrl(this.baseUrl, pathname), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}

function joinUrl(base: string, p: string): string {
  let b = base;
  if (b.endsWith('/')) b = b.slice(0, -1);
  const path = p.startsWith('/') ? p : `/${p}`;
  return `${b}${path}`;
}

async function readMessage(res: Response): Promise<string | undefined> {
  try {
    const data = (await res.json()) as { message?: string };
    return data?.message;
  } catch {
    return undefined;
  }
}
