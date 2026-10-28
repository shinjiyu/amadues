import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  formatWorkshopRemainder,
  readWorkshopRemainder,
  releaseWorkshopHolder,
  releaseWorkshopResource,
  resetWorkshopLedger,
  resetWorkshopLedgerForTests,
  tryGrantWorkshopResource,
  upsertWorkshopRemainderMessage,
  useWorkshopLedger,
  WORKSHOP_REMAINDER_MARKER,
} from './resource-ledger.js';

describe('workshop ledger', () => {
  const dirs: string[] = [];
  const previousCapacity = process.env['WORKSHOP_BROWSER_CAPACITY'];

  afterEach(() => {
    resetWorkshopLedgerForTests();
    if (previousCapacity === undefined) delete process.env['WORKSHOP_BROWSER_CAPACITY'];
    else process.env['WORKSHOP_BROWSER_CAPACITY'] = previousCapacity;
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  function root(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-ledger-'));
    dirs.push(dir);
    useWorkshopLedger(dir);
    return dir;
  }

  it('grants until the pool is full, then refuses', () => {
    process.env['WORKSHOP_BROWSER_CAPACITY'] = '1';
    root();
    expect(tryGrantWorkshopResource({ kind: 'browser', holder: '/bench-a', grantId: 'a' }).ok).toBe(true);
    const refused = tryGrantWorkshopResource({ kind: 'browser', holder: '/bench-b', grantId: 'b' });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain('已满');
    const remainder = readWorkshopRemainder('/bench-a');
    expect(remainder).toMatchObject({ free: 0, held: 1, heldHere: 1, capacity: 1 });
  });

  it('release returns the seat to the pool', () => {
    process.env['WORKSHOP_BROWSER_CAPACITY'] = '1';
    root();
    tryGrantWorkshopResource({ kind: 'browser', holder: '/bench-a', grantId: 'a' });
    releaseWorkshopResource('a');
    expect(readWorkshopRemainder('/bench-a')).toMatchObject({ free: 1, held: 0 });
    expect(tryGrantWorkshopResource({ kind: 'browser', holder: '/bench-b', grantId: 'b' }).ok).toBe(true);
  });

  it('a worker exit releases only that bench', () => {
    process.env['WORKSHOP_BROWSER_CAPACITY'] = '2';
    const dataRoot = root();
    tryGrantWorkshopResource({ kind: 'browser', holder: '/bench-a', grantId: 'a' });
    tryGrantWorkshopResource({ kind: 'browser', holder: '/bench-b', grantId: 'b' });
    releaseWorkshopHolder(dataRoot, '/bench-a');
    expect(readWorkshopRemainder('/bench-b')).toMatchObject({ free: 1, held: 1, heldHere: 1 });
  });

  it('boot reset clears leftover grants', () => {
    process.env['WORKSHOP_BROWSER_CAPACITY'] = '4';
    const dataRoot = root();
    tryGrantWorkshopResource({ kind: 'browser', holder: '/bench-a', grantId: 'a' });
    resetWorkshopLedger(dataRoot);
    expect(readWorkshopRemainder()).toMatchObject({ held: 0, free: 4 });
  });

  it('each round replaces the remainder block', () => {
    process.env['WORKSHOP_BROWSER_CAPACITY'] = '2';
    root();
    tryGrantWorkshopResource({ kind: 'browser', holder: '/bench-a', grantId: 'a' });
    const first = upsertWorkshopRemainderMessage(
      [{ role: 'user', content: '去做' }],
      '/bench-a',
    );
    expect(first[0]?.content).toContain('空闲 1 / 共 2');
    tryGrantWorkshopResource({ kind: 'browser', holder: '/bench-b', grantId: 'b' });
    const second = upsertWorkshopRemainderMessage(first, '/bench-a');
    const text = String(second[0]?.content);
    expect(text.indexOf(WORKSHOP_REMAINDER_MARKER)).toBe(text.lastIndexOf(WORKSHOP_REMAINDER_MARKER));
    expect(text).toContain('空闲 0 / 共 2');
    expect(text).toContain('去做');
    expect(formatWorkshopRemainder('/bench-a')).toContain('本台占用 1');
  });

  it('does not account when the ledger is off', () => {
    expect(tryGrantWorkshopResource({ kind: 'browser', holder: '/bench-a', grantId: 'a' }).ok).toBe(true);
    expect(formatWorkshopRemainder('/bench-a')).toContain('未记账');
  });
});
