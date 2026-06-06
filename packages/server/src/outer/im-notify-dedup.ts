/**
 * IM 通知去重 — awaiting_human / complete fingerprint ledger。
 *
 * @see doc/structurizr/INNER-BRAIN-IM-NOTIFY-BOUNDARY.md §2
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type ImNotifyKind = 'awaiting_human' | 'complete';

interface LedgerEntry {
  kind: ImNotifyKind;
  fingerprint: string;
  at: string;
}

interface Ledger {
  entries: LedgerEntry[];
}

function ledgerPath(workDir: string): string {
  return path.join(workDir, '.run', 'im-notify-ledger.json');
}

function dedupTtlMs(): number {
  const raw = process.env['UTLRA_IM_NOTIFY_DEDUP_TTL_MS'];
  const n = raw ? parseInt(raw, 10) : 86_400_000;
  return Number.isFinite(n) ? n : 86_400_000;
}

export function fingerprintNotify(
  instanceId: string,
  kind: ImNotifyKind,
  normalizedBody: string,
): string {
  return crypto
    .createHash('sha256')
    .update(`${instanceId}:${kind}:${normalizedBody}`)
    .digest('hex')
    .slice(0, 16);
}

export function shouldSendImNotify(
  workDir: string,
  kind: ImNotifyKind,
  fingerprint: string,
): boolean {
  const fp = ledgerPath(workDir);
  if (!fs.existsSync(fp)) return true;
  try {
    const ledger = JSON.parse(fs.readFileSync(fp, 'utf8')) as Ledger;
    const cutoff = Date.now() - dedupTtlMs();
    const hit = (ledger.entries ?? []).find(
      (e) =>
        e.kind === kind &&
        e.fingerprint === fingerprint &&
        new Date(e.at).getTime() > cutoff,
    );
    return !hit;
  } catch {
    return true;
  }
}

export function recordImNotifySent(
  workDir: string,
  kind: ImNotifyKind,
  fingerprint: string,
): void {
  const fp = ledgerPath(workDir);
  fs.mkdirSync(path.dirname(fp), { recursive: true });

  let ledger: Ledger = { entries: [] };
  try {
    if (fs.existsSync(fp)) {
      ledger = JSON.parse(fs.readFileSync(fp, 'utf8')) as Ledger;
    }
  } catch {
    ledger = { entries: [] };
  }
  if (!Array.isArray(ledger.entries)) ledger.entries = [];

  const cutoff = Date.now() - dedupTtlMs();
  ledger.entries = ledger.entries.filter((e) => new Date(e.at).getTime() > cutoff);
  ledger.entries.push({ kind, fingerprint, at: new Date().toISOString() });
  fs.writeFileSync(fp, JSON.stringify(ledger, null, 2), 'utf8');
}
