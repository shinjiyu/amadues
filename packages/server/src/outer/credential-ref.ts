/**
 * IM 凭证回复 → keychain + bind → credential_ref（B2）
 * @see doc/structurizr/MEMORY-BLOCKS.md · doc/todo/cross-agent-research-and-keychain.md §问题2
 */
import type { MemoryBlockStore } from './memory-block-store.js';
import { pathSafeKey } from './memory-block-strategies.js';

export interface CredentialRefResult {
  kind: 'credential_ref';
  block_id: 'keychain';
  slot: string;
  path: string;
  byteLength: number;
  credential_kind: string;
}

export function isCredentialRefResult(result: unknown): result is CredentialRefResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as CredentialRefResult).kind === 'credential_ref' &&
    typeof (result as CredentialRefResult).slot === 'string'
  );
}

/** 启发式：人类 IM 粘贴的 Cookie / Token 等长凭证 */
export function looksLikeCredential(text: string): boolean {
  const t = text.trim();
  if (t.length < 40) return false;

  if (/^(SUB|SUBP|WBPSESS|sessionid|sid)=/i.test(t)) return true;
  if (/Cookie:/i.test(t)) return true;
  if (/^Bearer\s+\S{20,}/i.test(t)) return true;

  if (t.startsWith('[') && t.includes('"name"') && t.includes('"value"')) {
    try {
      const arr = JSON.parse(t) as unknown;
      if (Array.isArray(arr) && arr.length > 0) {
        const first = arr[0] as Record<string, unknown>;
        if (typeof first.name === 'string' && first.value != null) return true;
      }
    } catch {
      /* not json */
    }
  }

  const pairs = t.split(';').filter((p) => p.includes('='));
  if (pairs.length >= 3 && t.length >= 80) return true;

  return false;
}

export function inferCredentialKind(text: string): string {
  const t = text.trim();
  if (t.startsWith('[')) return 'cookie_json';
  if (/^Bearer/i.test(t)) return 'bearer_token';
  return 'cookie_header';
}

const SLOT_HINTS: Array<{ pattern: RegExp; slot: string }> = [
  { pattern: /weibo|微博|WBPSESS|SUBP=/i, slot: 'weibo' },
  { pattern: /github/i, slot: 'github' },
  { pattern: /cnki|知网/i, slot: 'cnki' },
  { pattern: /twitter|x\.com/i, slot: 'twitter' },
];

export function inferCredentialSlot(askPrompt: string, replyText: string): string {
  const hay = `${askPrompt}\n${replyText}`;
  for (const { pattern, slot } of SLOT_HINTS) {
    if (pattern.test(hay)) return slot;
  }
  return 'inbound-credential';
}

export async function vaultCredentialReply(
  store: MemoryBlockStore,
  workDir: string,
  replyText: string,
  askPrompt: string,
  updatedBy: string,
): Promise<CredentialRefResult> {
  const slot = inferCredentialSlot(askPrompt, replyText);
  const credentialKind = inferCredentialKind(replyText);
  await store.put('keychain', slot, { kind: credentialKind, value: replyText }, updatedBy);
  const paths = await store.bind('keychain', [slot], workDir);
  const safe = pathSafeKey(slot);
  const bindPath = paths[0] ?? `.brain/secrets/${safe}.json`;
  return {
    kind: 'credential_ref',
    block_id: 'keychain',
    slot,
    path: bindPath,
    byteLength: Buffer.byteLength(replyText, 'utf8'),
    credential_kind: credentialKind,
  };
}
