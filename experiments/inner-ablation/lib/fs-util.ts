import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}

export function sha256File(file: string): string | null {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

export function hashFiles(root: string, rels: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const rel of rels) out[rel] = sha256File(path.join(root, rel));
  return out;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>(resolve => {
      const sock = net.connect({ port, host: '127.0.0.1' });
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => resolve(false));
    });
    if (ok) return true;
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

/** 杀掉在本机监听该端口的所有进程（判分后清理 agent 留下的常驻服务） */
export function killPortListeners(port: number): number[] {
  let pids: number[] = [];
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    pids = out.split('\n').map(s => Number(s.trim())).filter(n => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch { /* already gone */ }
  }
  return pids;
}
