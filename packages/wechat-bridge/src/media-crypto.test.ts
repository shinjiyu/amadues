import { describe, expect, it } from 'vitest';
import {
  aesKeyHexToB64,
  cipherSizeOf,
  decodeIlinkAesKey,
  decryptAesEcb,
  encryptAesEcb,
  randomAesKeyHex,
  sniffImageMime,
} from './media-crypto.js';

const KEY_HEX = '00112233445566778899aabbccddeeff';
const KEY_RAW = Buffer.from(KEY_HEX, 'hex');

describe('decodeIlinkAesKey', () => {
  it('格式 A：base64(raw 16B)', () => {
    const b64 = KEY_RAW.toString('base64'); // ABEiM0RVZneImaq7zN3u/w==
    expect(decodeIlinkAesKey(b64)).toEqual(KEY_RAW);
  });

  it('格式 B：base64(hex string)', () => {
    const b64 = Buffer.from(KEY_HEX, 'utf8').toString('base64');
    expect(decodeIlinkAesKey(b64)).toEqual(KEY_RAW);
  });

  it('格式 C：image_item.aeskey 直接 32 位 hex，优先于 media.aes_key', () => {
    const otherB64 = Buffer.from('ffeeddccbbaa99887766554433221100', 'hex').toString('base64');
    expect(decodeIlinkAesKey(otherB64, KEY_HEX)).toEqual(KEY_RAW);
  });

  it('无 key / 非法 → null', () => {
    expect(decodeIlinkAesKey(undefined)).toBeNull();
    expect(decodeIlinkAesKey('')).toBeNull();
    expect(decodeIlinkAesKey(Buffer.from('short').toString('base64'))).toBeNull();
  });
});

describe('AES-128-ECB 往返', () => {
  it('encrypt → decrypt 还原；密文大小符合 PKCS7 公式', () => {
    const plain = Buffer.from('hello wechat media 你好', 'utf8');
    const cipher = encryptAesEcb(plain, KEY_RAW);
    expect(cipher.length).toBe(cipherSizeOf(plain.length));
    expect(decryptAesEcb(cipher, KEY_RAW)).toEqual(plain);
  });

  it('randomAesKeyHex → 32 位 hex；aesKeyHexToB64 = base64(hex string)', () => {
    const hex = randomAesKeyHex();
    expect(hex).toMatch(/^[0-9a-f]{32}$/);
    const b64 = aesKeyHexToB64(hex);
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(hex);
    expect(decodeIlinkAesKey(b64)).toEqual(Buffer.from(hex, 'hex'));
  });
});

describe('sniffImageMime', () => {
  it('png/jpeg/gif/webp/兜底', () => {
    expect(sniffImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from('GIF89a'))).toBe('image/gif');
    expect(sniffImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe(
      'image/webp',
    );
    expect(sniffImageMime(Buffer.from('unknown'))).toBe('image/jpeg');
  });
});
