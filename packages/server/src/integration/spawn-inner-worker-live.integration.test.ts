/**
 * F 可选：真实 spawnInnerBrainWorker 子进程烟测（默认 skip）。
 *
 * 启用：UTLRA_TEST_SPAWN_INNER=1 + 根 .env LLM key
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { spawnInnerBrainWorker, readWorkerStatus } from '../pi-mono/inner-brain-spawner.js';
import { createTestDataRoot } from '../testing/temp-data-root.js';
import { shouldRunSpawnInnerE2e, spawnInnerE2eSkipReason } from '../testing/require-spawn-inner.js';

function waitChildExit(
  child: import('node:child_process').ChildProcess,
  timeoutMs: number,
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`inner-worker did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(t);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

describe.skipIf(!shouldRunSpawnInnerE2e())('integration: spawn inner worker (live subprocess)', () => {
  let cleanup: () => void;

  afterEach(() => {
    cleanup?.();
  });

  it(
    '子进程启动 → 至少 1 tick → status.json 落盘',
    async () => {
      const root = createTestDataRoot('spawn-live-');
      cleanup = root.cleanup;
      const workspaceId = 'ws-spawn-live';
      const workDir = path.join(root.workspacesDir, workspaceId);
      fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });
      fs.writeFileSync(
        path.join(workDir, '.brain', 'goal.md'),
        '写一份极简测试摘要到 summary.md，完成后结束。\n',
        'utf8',
      );

      const instanceId = `ib-live-${Date.now()}`;
      const { child } = spawnInnerBrainWorker({
        instanceId,
        workspaceId,
        workDir,
        maxTicks: 40,
      });

      const exitCode = await waitChildExit(child, 180_000);
      expect(exitCode).not.toBe(2);

      const st = readWorkerStatus(workDir);
      expect(st).not.toBeNull();
      expect(st!.instanceId).toBe(instanceId);
      expect(st!.ticks).toBeGreaterThan(0);
      expect(['done', 'error', 'running']).toContain(st!.phase);
    },
    200_000,
  );
});

describe('integration: spawn inner worker gate', () => {
  it('未启用 UTLRA_TEST_SPAWN_INNER 时跳过 live 套件（文档化原因）', () => {
    if (shouldRunSpawnInnerE2e()) return;
    expect(spawnInnerE2eSkipReason()).toMatch(/UTLRA_TEST_SPAWN_INNER|LLM env/);
  });
});
