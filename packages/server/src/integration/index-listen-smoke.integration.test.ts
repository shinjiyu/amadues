/**
 * F 装配：index 子进程完整 bootstrap + listen + health + SIGTERM 优雅退出。
 */
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestDataRoot } from '../testing/temp-data-root.js';
import {
  getFreeTcpPort,
  spawnIndexListenProcess,
  stopIndexProcess,
  waitForIndexHealth,
  waitForPortClosed,
} from '../testing/spawn-index-process.js';

describe('integration: index listen smoke', () => {
  let cleanup: () => void;

  afterEach(() => {
    cleanup?.();
  });

  it(
    '子进程 listen → GET /api/health → SIGTERM exit 0',
    async () => {
      const root = createTestDataRoot('index-listen-');
      cleanup = root.cleanup;
      const port = await getFreeTcpPort();
      const dataRoot = path.resolve(root.dataRoot);

      const { child } = spawnIndexListenProcess({ dataRoot, port });

      try {
        const body = await waitForIndexHealth(port, { dataRoot, timeoutMs: 60_000 });
        expect(body.ok).toBe(true);

        const exitCode = await stopIndexProcess(child, 'SIGTERM');
        await waitForPortClosed(port);
        // Windows 子进程 exit code 可能为 null；以端口释放为准
        if (exitCode !== null) {
          expect(exitCode).toBe(0);
        }
      } catch (e) {
        const stderr = child.stderr ? await streamToText(child.stderr) : '';
        const stdout = child.stdout ? await streamToText(child.stdout) : '';
        throw new Error(
          `${e instanceof Error ? e.message : String(e)}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        );
      } finally {
        if (child.exitCode === null && !child.killed) {
          child.kill('SIGKILL');
        }
      }
    },
    90_000,
  );
});

async function streamToText(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  }
  return Buffer.concat(chunks).toString('utf8').slice(-4000);
}
