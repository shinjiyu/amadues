import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureAllowlistedEwDeliverables } from './ew-deliverable-allowlist.js';

describe('ensureAllowlistedEwDeliverables', () => {
  let tmp = '';

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('registers existing summary files without scanning whole tree', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-allow-'));
    const ws = path.join(tmp, 'workspace');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'tweets_summary.html'), '<html>hi</html>\n', 'utf8');
    fs.writeFileSync(path.join(ws, 'tweets_summary.md'), '# hi\n', 'utf8');
    fs.writeFileSync(path.join(ws, 'tweets_summary.json'), '[]', 'utf8');
    fs.writeFileSync(path.join(tmp, 'secret-notes.txt'), 'nope', 'utf8');

    const got = ensureAllowlistedEwDeliverables(tmp);
    expect(got).toEqual(
      expect.arrayContaining([
        'workspace/tweets_summary.html',
        'workspace/tweets_summary.md',
        'workspace/tweets_summary.json',
      ]),
    );
    expect(got).not.toContain('secret-notes.txt');

    const disk = JSON.parse(
      fs.readFileSync(path.join(tmp, '.run', 'pi-mono', 'deliverables.json'), 'utf8'),
    );
    expect(disk).toEqual(got);
  });

  it('merges with existing deliverables.json', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-allow-m-'));
    const run = path.join(tmp, '.run', 'pi-mono');
    const ws = path.join(tmp, 'workspace');
    fs.mkdirSync(run, { recursive: true });
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(run, 'deliverables.json'), JSON.stringify(['workspace/report.md']), 'utf8');
    fs.writeFileSync(path.join(ws, 'tweets_summary.md'), 'x', 'utf8');

    const got = ensureAllowlistedEwDeliverables(tmp);
    expect(got).toContain('workspace/report.md');
    expect(got).toContain('workspace/tweets_summary.md');
  });
});
