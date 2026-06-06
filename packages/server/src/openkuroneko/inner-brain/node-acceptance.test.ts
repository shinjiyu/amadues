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

  it('deliverable AND: fails the node even when interface.outputs would pass', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-d-'));
    // loose interface.outputs (string) would pass on long content alone
    const r = validateNodeCompletion({
      node: baseNode([{ key: 'result', type: 'string' }]),
      inst: {
        id: 'n1',
        ref: 'preset/base',
        deliverable: {
          summary: '番茄建书成功并拿到 book_id',
          checks: [{ kind: 'json_key', target: 'create_result.json#book_id', describe: 'book_id 已生成' }],
        },
      },
      workDir: dir,
      lastContent: '我已经创建成功并发布了 5 章（口头断言，无文件证据）',
      executionLog: [],
    });
    expect(r.status).toBe('failed');
    expect(r.missing.some(m => m.includes('deliverable'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('deliverable AND: passes when checks + outputs both satisfied', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-d2-'));
    fs.writeFileSync(path.join(dir, 'create_result.json'), JSON.stringify({ book_id: '764804' }), 'utf8');
    const log: ExecutionEntry[] = [
      { toolName: 'shell_exec', args: { command: 'python submit_book.py' }, result: { ok: true, output: '番茄小说 创建成功' } },
    ];
    const r = validateNodeCompletion({
      node: baseNode([{ key: 'result', type: 'string' }]),
      inst: {
        id: 'n1',
        ref: 'preset/base',
        deliverable: {
          summary: '建书成功',
          checks: [
            { kind: 'json_key', target: 'create_result.json#book_id' },
            { kind: 'stdout_contains', target: '创建成功' },
            { kind: 'stdout_absent', target: '404' },
          ],
        },
      },
      workDir: dir,
      lastContent: '番茄小说创建成功，book_id 已写入 create_result.json',
      executionLog: log,
    });
    expect(r.status).toBe('ok');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('deliverable stdout_absent catches failure signal from a failed shell call', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-d3-'));
    const log: ExecutionEntry[] = [
      { toolName: 'shell_exec', args: { command: 'curl ...' }, result: { ok: false, output: 'HTTP/1.1 404 Not Found' } },
    ];
    const r = validateNodeCompletion({
      node: baseNode([]),
      inst: {
        id: 'n1',
        ref: 'preset/base',
        deliverable: { summary: '上传章节', checks: [{ kind: 'stdout_absent', target: '404' }] },
      },
      workDir: dir,
      lastContent: '章节已上传',
      executionLog: log,
    });
    expect(r.status).toBe('failed');
    fs.rmSync(dir, { recursive: true, force: true });
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
