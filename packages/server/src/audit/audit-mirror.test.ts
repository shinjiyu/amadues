import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { AuditMirror, scrubAuditEnv } from './audit-mirror.js';

const PY = '/usr/bin/python3';
const AUDIT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../deploy/audit',
);
const hasPython = fs.existsSync(PY) && spawnSync(PY, ['--version']).status === 0;

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}

function readChain(root: string, source: string): Array<{ seq: number; entry: Record<string, unknown> }> {
  const dir = path.join(root, 'log', source);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n'))
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe('scrubAuditEnv', () => {
  it('removes the socket variable and keeps the rest', () => {
    const env = { PATH: '/bin', UTLRA_AUDIT_SOCKET: '/x.sock' };
    expect(scrubAuditEnv(env)).toEqual({ PATH: '/bin' });
    const plain = { PATH: '/bin' };
    expect(scrubAuditEnv(plain)).toBe(plain);
  });
});

describe.skipIf(!hasPython)('audit mirror → python collector (end to end)', () => {
  let collector: ChildProcess | null = null;
  let mirror: AuditMirror | null = null;
  let root = '';

  afterEach(() => {
    mirror?.close();
    collector?.kill('SIGTERM');
    collector = null;
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('chains events, verifies clean, and detects tampering', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
    const sock = path.join(root, 'run', 'audit.sock');

    // 先发事件再起收集器：验证断线排队 + 重连补发
    mirror = new AuditMirror({ socketPath: sock, agent: 'Aki', heartbeatMs: 0 });
    mirror.emit('inner.tool.call', { name: 'shell_exec', args: { command: 'ls ~' } });
    expect(mirror.pendingCount()).toBe(1);

    collector = spawn(PY, [path.join(AUDIT_DIR, 'audit_collector.py'), '--root', root], {
      stdio: 'ignore',
    });
    await waitFor(() => fs.existsSync(sock));

    mirror.emit('outer.tool.result', { name: 'human_request', ok: true, output: 'sent' });
    mirror.emit('autonomy', { reason: 'digital_employee:drive_seeded' });
    await waitFor(() => readChain(root, 'Aki').length === 3, 10_000);

    const chain = readChain(root, 'Aki');
    expect(chain.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(chain.map((r) => r.entry['kind'])).toEqual([
      'inner.tool.call',
      'outer.tool.result',
      'autonomy',
    ]);
    expect((chain[0]!.entry['data'] as { args: { command: string } }).args.command).toBe('ls ~');

    const verify = (): { status: number | null; out: string } => {
      const r = spawnSync(PY, [path.join(AUDIT_DIR, 'audit_verify.py'), '--root', root, '--source', 'Aki'], {
        encoding: 'utf8',
      });
      return { status: r.status, out: r.stdout + r.stderr };
    };
    const clean = verify();
    expect(clean.status).toBe(0);
    expect(clean.out).toContain('Aki: OK');

    // 改写一条已落盘事件 → 链断
    const day = fs.readdirSync(path.join(root, 'log', 'Aki')).find((f) => f.endsWith('.jsonl'))!;
    const fp = path.join(root, 'log', 'Aki', day);
    fs.writeFileSync(fp, fs.readFileSync(fp, 'utf8').replace('ls ~', 'echo hi'));
    const tampered = verify();
    expect(tampered.status).toBe(1);
    expect(tampered.out).toContain('TAMPERED');
    expect(tampered.out).toContain('hash 不符');
  }, 20_000);
});
