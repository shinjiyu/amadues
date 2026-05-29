import { describe, expect, it } from 'vitest';
import { extractBearerToken, resolveAgentPrincipal } from './agent-bypass.js';

const SECRET = 'test-agent-secret';

describe('extractBearerToken', () => {
  it('parses Bearer token', () => {
    expect(extractBearerToken('Bearer abc')).toBe('abc');
    expect(extractBearerToken('bearer abc')).toBe('abc');
  });

  it('returns undefined for missing or invalid header', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken('Basic abc')).toBeUndefined();
    expect(extractBearerToken('Bearer ')).toBeUndefined();
  });
});

describe('resolveAgentPrincipal', () => {
  const base = {
    agentSecret: SECRET,
    agentUserIds: new Set<string>(),
    claimedUserId: 'aoi',
    providedSecret: SECRET,
  };

  it('accepts any user_id when allowlist is empty', () => {
    expect(resolveAgentPrincipal(base)).toEqual({ kind: 'agent', userId: 'aoi' });
    expect(resolveAgentPrincipal({ ...base, claimedUserId: 'new-bot' })).toEqual({
      kind: 'agent',
      userId: 'new-bot',
    });
  });

  it('rejects wrong secret or missing user_id', () => {
    expect(resolveAgentPrincipal({ ...base, providedSecret: 'wrong' })).toBeNull();
    expect(resolveAgentPrincipal({ ...base, agentSecret: null })).toBeNull();
    expect(resolveAgentPrincipal({ ...base, claimedUserId: '' })).toBeNull();
    expect(resolveAgentPrincipal({ ...base, claimedUserId: undefined })).toBeNull();
  });

  it('enforces optional allowlist when configured', () => {
    const allowlist = new Set(['kuroneko', 'shiro']);
    expect(
      resolveAgentPrincipal({ ...base, agentUserIds: allowlist, claimedUserId: 'kuroneko' }),
    ).toEqual({ kind: 'agent', userId: 'kuroneko' });
    expect(
      resolveAgentPrincipal({ ...base, agentUserIds: allowlist, claimedUserId: 'aoi' }),
    ).toBeNull();
  });
});
