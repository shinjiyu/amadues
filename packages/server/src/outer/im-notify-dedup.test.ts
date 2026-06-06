import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  fingerprintNotify,
  recordImNotifySent,
  shouldSendImNotify,
} from './im-notify-dedup.js';

describe('im-notify-dedup', () => {
  let root: string;
  let workDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'im-dedup-'));
    workDir = path.join(root, 'ws');
    fs.mkdirSync(path.join(workDir, '.run'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('fingerprint is stable for same input', () => {
    const a = fingerprintNotify('ib-1', 'awaiting_human', 'what is cookie?');
    const b = fingerprintNotify('ib-1', 'awaiting_human', 'what is cookie?');
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it('shouldSend false after record within TTL', () => {
    const fp = fingerprintNotify('ib-1', 'awaiting_human', 'q');
    expect(shouldSendImNotify(workDir, 'awaiting_human', fp)).toBe(true);
    recordImNotifySent(workDir, 'awaiting_human', fp);
    expect(shouldSendImNotify(workDir, 'awaiting_human', fp)).toBe(false);
  });
});
