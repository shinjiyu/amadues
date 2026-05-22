/**
 * ADL component: reflexionModule — parse + write reflexion.json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseReflexionJson, writeReflexionJson } from './reflexion.js';

describe('component: reflexionModule', () => {
  let tmp = '';

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('parseReflexionJson 解析 fenced JSON（主路径）', () => {
    const raw = '```json\n{"verdict":"partial","hardFailures":[],"softFailures":[],"nextStrategy":"重试"}\n```';
    const r = parseReflexionJson(raw);
    expect(r?.verdict).toBe('partial');
    expect(r?.nextStrategy).toBe('重试');
  });

  it('writeReflexionJson → 磁盘可读', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-'));
    writeReflexionJson(tmp, {
      verdict: 'failed',
      hardFailures: ['API 拒绝'],
      softFailures: [],
      nextStrategy: '换源',
    });
    const parsed = JSON.parse(
      fs.readFileSync(path.join(tmp, '.brain', 'reflexion.json'), 'utf8'),
    ) as { verdict: string };
    expect(parsed.verdict).toBe('failed');
  });
});
