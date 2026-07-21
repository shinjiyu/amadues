/**
 * ADL: wechatBridge · 媒体加解密（CDN AES-128-ECB）
 * path: packages/wechat-bridge/src/media-crypto.ts
 * horizon.intention: iLink CDN 媒体的 AES-128-ECB(PKCS7) 加解密与 key 编码兼容。
 *   key 有三种在野格式：base64(raw 16B) / base64(hex string) / 直接 32 位 hex。
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §6.6 P4b-media
 */
import crypto from 'node:crypto';

export const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

const HEX32_RE = /^[0-9a-f]{32}$/i;

/**
 * 解出 16 字节 AES key。
 * - `aeskeyHex`（image_item.aeskey）：32 位 hex，优先。
 * - `aesKeyB64`（CDNMedia.aes_key）：base64 后可能是 raw 16B，也可能是 32 字节 hex ASCII。
 */
export function decodeIlinkAesKey(
  aesKeyB64?: string | null,
  aeskeyHex?: string | null,
): Buffer | null {
  const hex = aeskeyHex?.trim();
  if (hex && HEX32_RE.test(hex)) return Buffer.from(hex, 'hex');

  const b64 = aesKeyB64?.trim();
  if (!b64) return null;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32) {
    const asText = decoded.toString('utf8');
    if (HEX32_RE.test(asText)) return Buffer.from(asText, 'hex');
  }
  return null;
}

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** 随机 16 字节 key，hex 形式（getuploadurl.aeskey 要求 hex） */
export function randomAesKeyHex(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** 官方 openclaw 出站 media.aes_key 的编码：base64(hex string) */
export function aesKeyHexToB64(hex: string): string {
  return Buffer.from(hex, 'utf8').toString('base64');
}

/** PKCS7 密文大小：ceil((rawsize+1)/16)*16 */
export function cipherSizeOf(rawSize: number): number {
  return Math.ceil((rawSize + 1) / 16) * 16;
}

/** 简单图片签名嗅探（inbound 落 asset 时定 mime） */
export function sniffImageMime(buf: Buffer): string {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 6 && buf.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return 'image/jpeg';
}
