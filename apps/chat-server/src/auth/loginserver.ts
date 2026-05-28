/**
 * loginserver（Flask）HTTP 客户端，与 `D:/UGit/remote-console` 复用同样的 API：
 *
 *   POST /api/auth/login   { email, password } -> { success, data: { access_token, refresh_token, user } }
 *   GET  /api/auth/verify  Authorization: Bearer <token> -> { success, data: { user_id, email, type, exp, iat } }
 *   POST /api/auth/refresh { refresh_token } -> { success, data: { access_token } }
 *
 * 不做缓存/重试；上层若超时可降级匿名（见 middleware）。
 */

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

export class LoginServerClient {
  constructor(private readonly baseUrl: string) {
    if (!baseUrl) {
      throw new Error('LoginServerClient: baseUrl is required');
    }
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
