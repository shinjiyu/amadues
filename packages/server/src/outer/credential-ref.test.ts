/**
 * @see doc/todo/memory-blocks-framework.md B2
 */
import { describe, expect, it } from 'vitest';

import {
  inferCredentialSlot,
  isCredentialRefResult,
  looksLikeCredential,
} from './credential-ref.js';

describe('credential-ref', () => {
  it('looksLikeCredential detects long cookie header', () => {
    const cookie = 'SUB=abc123456789012345678901234567890; SUBP=xyz987654321098765432109876543210; WBPSESS=token';
    expect(looksLikeCredential(cookie)).toBe(true);
  });

  it('looksLikeCredential rejects short non-credential text', () => {
    expect(looksLikeCredential('yes')).toBe(false);
    expect(looksLikeCredential('SUB=short')).toBe(false);
  });

  it('inferCredentialSlot picks weibo from ask prompt', () => {
    expect(inferCredentialSlot('请粘贴微博 Cookie', 'SUB=...')).toBe('weibo');
  });

  it('isCredentialRefResult type guard', () => {
    expect(
      isCredentialRefResult({
        kind: 'credential_ref',
        block_id: 'keychain',
        slot: 'weibo',
        path: '.brain/secrets/weibo.json',
        byteLength: 100,
        credential_kind: 'cookie_header',
      }),
    ).toBe(true);
    expect(isCredentialRefResult({ reply: 'x' })).toBe(false);
  });
});
