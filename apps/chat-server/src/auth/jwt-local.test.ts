import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';

import { verifyAccessTokenLocally } from './jwt-local.js';

const SECRET = 'test-jwt-secret-for-unit-tests';

async function mintToken(
  payload: Record<string, unknown>,
  expOffsetSec: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + expOffsetSec)
    .sign(new TextEncoder().encode(SECRET));
}

describe('verifyAccessTokenLocally', () => {
  it('accepts valid access token', async () => {
    const token = await mintToken(
      { user_id: 'user-1', email: 'alice@example.com', type: 'access' },
      3600,
    );
    const verified = await verifyAccessTokenLocally(token, SECRET);
    expect(verified).toMatchObject({
      user_id: 'user-1',
      email: 'alice@example.com',
      type: 'access',
    });
    expect(verified!.exp).toBeGreaterThan(verified!.iat);
  });

  it('rejects refresh token type', async () => {
    const token = await mintToken({ user_id: 'user-1', email: 'x@y.z', type: 'refresh' }, 3600);
    expect(await verifyAccessTokenLocally(token, SECRET)).toBeNull();
  });

  it('rejects expired token', async () => {
    const token = await mintToken(
      { user_id: 'user-1', email: 'alice@example.com', type: 'access' },
      -60,
    );
    expect(await verifyAccessTokenLocally(token, SECRET)).toBeNull();
  });

  it('rejects wrong secret', async () => {
    const token = await mintToken(
      { user_id: 'user-1', email: 'alice@example.com', type: 'access' },
      3600,
    );
    expect(await verifyAccessTokenLocally(token, 'other-secret')).toBeNull();
  });
});
