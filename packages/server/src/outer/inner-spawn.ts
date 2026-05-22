/**
 * 内脑子进程 burst 启动（供外脑工具 set_goal 调用）。
 * 与 orchestrator 中的 spawnInnerBurst 共享同一逻辑，抽取为独立模块避免循环依赖。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function resolveInnerWorkerCommand(): { command: string; argsPrefix: string[] } {
  const base = path.dirname(fileURLToPath(import.meta.url));
  const js = path.join(base, '..', 'inner-worker.js');
  if (fs.existsSync(js)) {
    return { command: process.execPath, argsPrefix: [js] };
  }
  const ts = path.join(base, '..', 'inner-worker.ts');
  return { command: 'npx', argsPrefix: ['tsx', ts] };
}

export function spawnInnerWorker(
  dataRoot: string,
  workspaceId: string,
  maxTicks = 200,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { command, argsPrefix } = resolveInnerWorkerCommand();
  const args = [...argsPrefix, workspaceId, String(maxTicks)];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, UTLRA_DATA_ROOT: dataRoot },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => { resolve({ code: code ?? 1, stdout, stderr }); });
  });
}
