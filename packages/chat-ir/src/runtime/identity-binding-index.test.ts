/**
 * ADL: identityBindingIndex
 * path: packages/chat-ir/src/runtime/identity-binding-index.ts
 * horizon.in:  channel_key + sid ops
 * horizon.out: resolve / conflict / linkMerge
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ChannelKeyConflictError,
  IdentityBindingIndex,
  mintInternalUserSid,
  serializeChannelKey,
} from './identity-binding-index.js';

describe('component: identityBindingIndex', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('serializeChannelKey includes scope for feishu multi-app', () => {
    expect(
      serializeChannelKey({
        channel: 'Feishu',
        native_user_id: ' ou_1 ',
        scope: ' cli_a ',
      }),
    ).toBe('feishu:cli_a:ou_1');
    expect(
      serializeChannelKey({ channel: 'discord', native_user_id: '42' }),
    ).toBe('discord:42');
  });

  it('resolve returns null until bind', () => {
    const idx = new IdentityBindingIndex({ persistPath: null });
    const key = { channel: 'webchat', native_user_id: 'alice' };
    expect(idx.resolve(key)).toBeNull();
    idx.bind(key, 'idp:user:alice');
    expect(idx.resolve(key)).toBe('idp:user:alice');
  });

  it('bind is idempotent for same sid; conflicts on other sid', () => {
    const idx = new IdentityBindingIndex({ persistPath: null });
    const key = { channel: 'discord', native_user_id: '9' };
    idx.bind(key, 'idp:user:a');
    idx.bind(key, 'idp:user:a');
    expect(() => idx.bind(key, 'idp:user:b')).toThrow(ChannelKeyConflictError);
  });

  it('two channel keys can map to the same internal sid', () => {
    const idx = new IdentityBindingIndex({ persistPath: null });
    idx.bind({ channel: 'webchat', native_user_id: 'a' }, 'idp:user:1');
    idx.bind({ channel: 'feishu', native_user_id: 'ou_x', scope: 'cli_1' }, 'idp:user:1');
    expect(idx.listKeys('idp:user:1')).toHaveLength(2);
  });

  it('linkMerge remaps all keys from source to target', () => {
    const idx = new IdentityBindingIndex({ persistPath: null });
    idx.bind({ channel: 'webchat', native_user_id: 'a' }, 'idp:user:src');
    idx.bind({ channel: 'feishu', native_user_id: 'ou', scope: 'app' }, 'idp:user:src');
    idx.bind({ channel: 'discord', native_user_id: '1' }, 'idp:user:tgt');
    expect(idx.linkMerge('idp:user:src', 'idp:user:tgt')).toBe(2);
    expect(idx.resolve({ channel: 'webchat', native_user_id: 'a' })).toBe('idp:user:tgt');
    expect(idx.listKeys('idp:user:src')).toHaveLength(0);
  });

  it('persist and reload from disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibi-'));
    dirs.push(dir);
    const file = path.join(dir, 'channel-bindings.json');
    const idx = new IdentityBindingIndex({ persistPath: file });
    idx.bind({ channel: 'webchat', native_user_id: 'bob' }, 'idp:user:bob');
    const idx2 = new IdentityBindingIndex({ persistPath: file });
    expect(idx2.resolve({ channel: 'webchat', native_user_id: 'bob' })).toBe('idp:user:bob');
  });

  it('resolveOrProvision mints idp:user sid once', () => {
    const idx = new IdentityBindingIndex({ persistPath: null });
    const key = { channel: 'feishu', native_user_id: 'ou_new', scope: 'cli_x' };
    const a = idx.resolveOrProvision(key);
    const b = idx.resolveOrProvision(key);
    expect(a).toBe(b);
    expect(a.startsWith('idp:user:')).toBe(true);
    expect(mintInternalUserSid().startsWith('idp:user:')).toBe(true);
  });

  it('unbind removes mapping', () => {
    const idx = new IdentityBindingIndex({ persistPath: null });
    const key = { channel: 'webchat', native_user_id: 'x' };
    idx.bind(key, 'idp:user:x');
    expect(idx.unbind(key)).toBe(true);
    expect(idx.resolve(key)).toBeNull();
  });
});
