/**
 * loginserver JWT 本地校验（与 `D:/UGit/loginserver/backend/utils/jwt_helper.py` 对齐）。
 *
 * - 算法：HS256
 * - access payload：`user_id`, `email`, `type: 'access'`, `exp`, `iat`
 * - 密钥：`WEBCHAT_LOGIN_JWT_SECRET`（与 loginserver `JWT_SECRET_KEY` 相同）
 *
 * 配置密钥后，chat-server 不再对每个请求 HTTP 调 `/api/auth/verify`；
 * refresh 仍走 loginserver `/api/auth/refresh`（需签发新 access token）。
 */
import { jwtVerify } from 'jose';

import type { VerifiedPayload } from './loginserver.js';

const ALGORITHM = 'HS256';

function toVerifiedPayload(payload: Record<string, unknown>): VerifiedPayload | null {
  const userId = payload['user_id'];
  const email = payload['email'];
  const type = payload['type'];
  const exp = payload['exp'];
  const iat = payload['iat'];
  if (typeof userId !== 'string' || typeof email !== 'string') return null;
  if (type !== 'access') return null;
  if (typeof exp !== 'number' || typeof iat !== 'number') return null;
  return {
    user_id: userId,
    email,
    type: 'access',
    exp,
    iat,
  };
}

/** 本地 HS256 验签 + exp；无效/过期/非 access → null。 */
export async function verifyAccessTokenLocally(
  accessToken: string,
  secret: string,
): Promise<VerifiedPayload | null> {
  if (!secret.trim()) return null;
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(accessToken, key, { algorithms: [ALGORITHM] });
    return toVerifiedPayload(payload as Record<string, unknown>);
  } catch {
    return null;
  }
}
