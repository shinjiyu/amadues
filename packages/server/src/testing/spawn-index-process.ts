/**
 * 在子进程中启动 `src/index.ts`（完整 bootstrap + listen），供装配烟测使用。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __testingDir = path.dirname(fileURLToPath(import.meta.url));
const serverPkg = path.resolve(__testingDir, '..', '..');
const indexEntry = path.join(serverPkg, 'src', 'index.ts');

function resolveTsxEsm(): string {
  try {
    const req = createRequire(import.meta.url);
    return pathToFileURL(req.resolve('tsx/esm')).href;
  } catch {
    return 'tsx/esm';
  }
}

export async function getFreeTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export interface SpawnedIndexProcess {
  child: ChildProcess;
  port: number;
  dataRoot: string;
}

export function spawnIndexListenProcess(opts: {
  dataRoot: string;
  port: number;
  extraEnv?: Record<string, string>;
}): SpawnedIndexProcess {
  const child = spawn(
    process.execPath,
    ['--import', resolveTsxEsm(), indexEntry],
    {
      cwd: serverPkg,
      env: {
        ...process.env,
        PORT: String(opts.port),
        UTLRA_DATA_ROOT: opts.dataRoot,
        UTLRA_CHAT_CHANNEL: 'none',
        UTLRA_OUTER_HEARTBEAT_ENABLED: 'false',
        ...opts.extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return { child, port: opts.port, dataRoot: opts.dataRoot };
}

export async function waitForIndexHealth(
  port: number,
  opts?: { timeoutMs?: number; dataRoot?: string },
): Promise<{ ok: boolean; dataRoot: string }> {
  const timeoutMs = opts?.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) {
        const body = (await res.json()) as { ok: boolean; dataRoot: string };
        if (opts?.dataRoot && body.dataRoot !== opts.dataRoot) {
          throw new Error(`health dataRoot mismatch: ${body.dataRoot} !== ${opts.dataRoot}`);
        }
        return body;
      }
      lastErr = new Error(`health status ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`index health timeout after ${timeoutMs}ms: ${String(lastErr)}`);
}

export function stopIndexProcess(
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGTERM',
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('index process did not exit after signal')), 20_000);
    child.once('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
    child.once('exit', (code) => {
      clearTimeout(t);
      resolve(code);
    });
    if (child.exitCode !== null) {
      clearTimeout(t);
      resolve(child.exitCode);
      return;
    }
    if (child.killed) {
      clearTimeout(t);
      resolve(null);
      return;
    }
    // Windows 上对子进程 SIGTERM 行为不一致，用默认 kill 触发 Node 退出链
    if (process.platform === 'win32') {
      child.kill();
    } else {
      child.kill(signal);
    }
  });
}

export async function waitForPortClosed(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`port ${port} still accepting connections after ${timeoutMs}ms`);
}
