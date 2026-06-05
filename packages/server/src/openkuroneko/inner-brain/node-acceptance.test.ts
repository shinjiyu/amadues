import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ExecutionEntry } from '../brain/index.js';
import {
  gatherEvidence,
  shellOutputLooksFailed,
  validateNodeCompletion,
} from './node-acceptance.js';
import type { LocalNode, NodeInst } from './types.js';

function baseNode(outputs: LocalNode['interface']['outputs']): LocalNode {
  return {
    id: 'preset/base',
    version: '1.0.0',
    displayName: 'Base',
    description: 'x',
    tags: [],
    interface: { inputs: [], outputs },
    body: { kind: 'executor', promptTemplate: 'x', tools: ['*'] },
    metadata: { origin: 'preset', createdAt: '', updatedAt: '' },
  };
}

const inst: NodeInst = { id: 'n1', ref: 'preset/base' };

describe('shellOutputLooksFailed', () => {
  it('detects HTTP 404 in curl output', () => {
    expect(shellOutputLooksFailed('HTTP/1.1 404 Not Found')).toBe(true);
  });
  it('allows clean success output', () => {
    expect(shellOutputLooksFailed('{"code":0,"data":[]}')).toBe(false);
  });
});

describe('validateNodeCompletion', () => {
  it('requires non-empty summary when no outputs defined', () => {
    const r = validateNodeCompletion({
      node: baseNode([]),
      inst,
      workDir: '/tmp',
      lastContent: '   ',
      executionLog: [],
    });
    expect(r.status).toBe('failed');
    expect(r.missing).toContain('result');
  });

  it('passes when json file exists from write_file evidence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-'));
    const dataPath = path.join(dir, 'book_list_raw.json');
    fs.writeFileSync(dataPath, JSON.stringify({ code: 0, data: [] }), 'utf8');
    const log: ExecutionEntry[] = [
      {
        toolName: 'write_file',
        args: { path: 'book_list_raw.json' },
        result: { ok: true, output: 'written' },
      },
    ];
    const r = validateNodeCompletion({
      node: baseNode([{ key: 'book_list_raw', type: 'json' }]),
      inst,
      workDir: dir,
      lastContent: 'saved to book_list_raw.json',
      executionLog: log,
    });
    expect(r.status).toBe('ok');
    expect(r.outputs['book_list_raw']).toEqual({ code: 0, data: [] });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fails string output when content too short and no evidence', () => {
    const r = validateNodeCompletion({
      node: baseNode([{ key: 'result', type: 'string' }]),
      inst,
      workDir: '/tmp',
      lastContent: 'ok',
      executionLog: [],
    });
    expect(r.status).toBe('failed');
    expect(r.missing[0]).toMatch(/result/);
  });
});

describe('gatherEvidence', () => {
  it('collects write_file paths', () => {
    const ev = gatherEvidence('/w', [
      { toolName: 'write_file', args: { path: 'out/a.json' }, result: { ok: true, output: 'x' } },
    ]);
    expect([...ev.filePaths][0]).toContain('out');
  });
});
