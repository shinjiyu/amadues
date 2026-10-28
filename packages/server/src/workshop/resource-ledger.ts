/**
 * 车间余量账本。工人每轮读空闲数，实际领取时才准许或拒绝。
 * ADL: doc/structurizr/WORKSHOP.md §4
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Message } from '../openkuroneko/adapter/index.js';

export type WorkshopResourceKind = 'browser';

export const WORKSHOP_REMAINDER_MARKER = '## 车间余量（本轮）';

const DEFAULT_BROWSER_CAPACITY = 4;

interface Grant {
  id: string;
  kind: WorkshopResourceKind;
  holder: string;
  at: string;
}

interface LedgerFile {
  grants: Grant[];
}

let ledgerRoot: string | null = null;

export function useWorkshopLedger(dataRoot: string | undefined): void {
  const trimmed = dataRoot?.trim();
  ledgerRoot = trimmed ? trimmed : null;
}

export function workshopLedgerRoot(): string | null {
  return ledgerRoot;
}

export function resetWorkshopLedgerForTests(): void {
  ledgerRoot = null;
}

function browserCapacity(): number {
  const raw = process.env['WORKSHOP_BROWSER_CAPACITY']?.trim();
  if (!raw) return DEFAULT_BROWSER_CAPACITY;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_BROWSER_CAPACITY;
}

function ledgerPath(dataRoot: string): string {
  return path.join(dataRoot, 'workshop', 'resource-ledger.json');
}

function lockPath(dataRoot: string): string {
  return path.join(dataRoot, 'workshop', 'ledger.lock');
}

function withLock<T>(dataRoot: string, fn: () => T): T {
  const lock = lockPath(dataRoot);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > 5_000) fs.rmdirSync(lock);
      } catch {
        /* another process holds or already removed the lock */
      }
      if (Date.now() - started > 8_000) {
        throw new Error('workshop ledger lock timeout');
      }
      const until = Date.now() + 15;
      while (Date.now() < until) {
        /* short wait */
      }
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {
      /* already gone */
    }
  }
}

function readFile(dataRoot: string): LedgerFile {
  const file = ledgerPath(dataRoot);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as LedgerFile;
    return { grants: Array.isArray(parsed.grants) ? parsed.grants : [] };
  } catch {
    return { grants: [] };
  }
}

function writeFile(dataRoot: string, ledger: LedgerFile): void {
  const file = ledgerPath(dataRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ledger, null, 2));
}

export interface ResourceRemainder {
  kind: WorkshopResourceKind;
  capacity: number;
  held: number;
  free: number;
  heldHere: number;
}

export function readWorkshopRemainder(holder?: string): ResourceRemainder | null {
  if (!ledgerRoot) return null;
  const ledger = readFile(ledgerRoot);
  const capacity = browserCapacity();
  const mine = ledger.grants.filter((grant) => grant.kind === 'browser');
  const heldHere = holder ? mine.filter((grant) => grant.holder === holder).length : 0;
  return {
    kind: 'browser',
    capacity,
    held: mine.length,
    free: Math.max(0, capacity - mine.length),
    heldHere,
  };
}

export function tryGrantWorkshopResource(opts: {
  kind: WorkshopResourceKind;
  holder: string;
  grantId: string;
}): { ok: true } | { ok: false; reason: string } {
  if (!ledgerRoot) return { ok: true };
  return withLock(ledgerRoot, () => {
    const ledger = readFile(ledgerRoot!);
    const capacity = browserCapacity();
    const held = ledger.grants.filter((grant) => grant.kind === opts.kind).length;
    if (held >= capacity) {
      return {
        ok: false as const,
        reason: `车间浏览器已满（${held}/${capacity}）。先关掉一个，或改用不占浏览器的做法。`,
      };
    }
    ledger.grants.push({
      id: opts.grantId,
      kind: opts.kind,
      holder: opts.holder,
      at: new Date().toISOString(),
    });
    writeFile(ledgerRoot!, ledger);
    return { ok: true as const };
  });
}

export function releaseWorkshopResource(grantId: string): void {
  if (!ledgerRoot) return;
  withLock(ledgerRoot, () => {
    const ledger = readFile(ledgerRoot!);
    ledger.grants = ledger.grants.filter((grant) => grant.id !== grantId);
    writeFile(ledgerRoot!, ledger);
  });
}

export function releaseWorkshopHolder(dataRoot: string, holder: string): void {
  const root = dataRoot.trim();
  if (!root || !holder) return;
  withLock(root, () => {
    const ledger = readFile(root);
    ledger.grants = ledger.grants.filter((grant) => grant.holder !== holder);
    writeFile(root, ledger);
  });
}

export function resetWorkshopLedger(dataRoot: string): void {
  const root = dataRoot.trim();
  if (!root) return;
  withLock(root, () => {
    writeFile(root, { grants: [] });
  });
}

export function formatWorkshopRemainder(holder?: string): string {
  const remainder = readWorkshopRemainder(holder);
  if (!remainder) {
    return [WORKSHOP_REMAINDER_MARKER, '- 浏览器实例：未记账'].join('\n');
  }
  return [
    WORKSHOP_REMAINDER_MARKER,
    `- 浏览器实例：空闲 ${remainder.free} / 共 ${remainder.capacity}（本台占用 ${remainder.heldHere}）`,
    '实际打开时才领取。空闲为 0 就不要再开新的浏览器。',
  ].join('\n');
}

function stripMarkedSection(text: string, marker: string): string {
  const markerIdx = text.indexOf(marker);
  if (markerIdx < 0) return text;
  const sep = '\n\n---\n\n';
  const sepIdx = text.indexOf(sep, markerIdx);
  if (sepIdx < 0) return text.slice(0, markerIdx);
  return text.slice(0, markerIdx) + text.slice(sepIdx + sep.length);
}

/** 每轮覆盖首条 user 消息里的余量块。 */
export function upsertWorkshopRemainderMessage(messages: Message[], holder?: string): Message[] {
  const section = formatWorkshopRemainder(holder);
  const prefix = `${section}\n\n---\n\n`;
  const firstUserIdx = messages.findIndex((message) => message.role === 'user');
  if (firstUserIdx < 0) return [{ role: 'user', content: section }];
  return messages.map((message, index) => {
    if (index !== firstUserIdx || typeof message.content !== 'string') return message;
    const body = stripMarkedSection(message.content, WORKSHOP_REMAINDER_MARKER);
    return { ...message, content: `${prefix}${body}` };
  });
}
