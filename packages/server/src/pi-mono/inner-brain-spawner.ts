/**
 * Inner Brain Spawner — 子进程启动工具
 *
 * 将内脑 worker 作为独立子进程启动，实现进程级隔离。
 * 进程间通信：
 *   - 输入：环境变量（参数传递）
 *   - 输出：<workDir>/.run/inner-worker-status.json（progress 轮询）
 *   - 停止：writeStopSignal()（优雅停止）+ SIGTERM（强制终止）
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import type { WorkerStatus } from './inner-brain-worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// entry script 沿用普通路径：Node 对 entry 解析较宽松；
// 反而若传 `file://` URL，tsx loader 会把它当成相对路径再与 cwd 拼接，触发 ERR_MODULE_NOT_FOUND。
const WORKER_SCRIPT_TS = path.join(__dirname, 'inner-brain-worker.ts');
const WORKER_SCRIPT_JS = path.join(__dirname, 'inner-brain-worker.js');

function resolveWorkerLaunch(): string[] {
  if (fs.existsSync(WORKER_SCRIPT_JS)) {
    return [WORKER_SCRIPT_JS];
  }
  return ['--import', TSX_ESM_PATH, WORKER_SCRIPT_TS];
}

/** 解析 tsx/esm loader file:// URL，用于子进程 --import 参数 */
function resolveTsxEsm(): string {
  try {
    const req = createRequire(import.meta.url);
    return pathToFileURL(req.resolve('tsx/esm')).href;
  } catch {
    return 'tsx/esm'; // 回退：bare specifier，由 Node 在子进程的 cwd 解析
  }
}

const TSX_ESM_PATH = resolveTsxEsm();

export interface SpawnedWorker {
  pid: number;
  child: ChildProcess;
}

export interface SpawnInnerBrainParams {
  instanceId:  string;
  workspaceId: string;
  workDir:     string;
  maxTicks:    number;
  /** 关联的 KPI ID（可选，用于 KPI hook） */
  kpiId?:      string;
  /** 子进程退出时的回调（exitCode: 0=正常, 1=错误, null=signal kill） */
  onExit?: (exitCode: number | null, signal: NodeJS.Signals | null) => void;
  /** 可只读访问的其它 workspace id（跨内脑产物协议） */
  peerWorkspaceIds?: string[];
  /** workspaces 根目录，例如 <dataRoot>/workspaces */
  workspacesRoot?: string;
}

/** 读取 worker 写入的状态文件 */
export function readWorkerStatus(workDir: string): WorkerStatus | null {
  const statusFile = path.join(workDir, '.run', 'inner-worker-status.json');
  try {
    if (!fs.existsSync(statusFile)) return null;
    return JSON.parse(fs.readFileSync(statusFile, 'utf8')) as WorkerStatus;
  } catch {
    return null;
  }
}

/**
 * 检查 pid 是否仍然存活。
 * 使用 signal 0（不发送实际信号，仅检测进程是否存在）。
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析子进程 cwd：必须是一个**存在且可写**的本地目录。
 *
 * Windows Sandbox 下，父进程的 cwd 常落在只读映射盘（如 `C:\kuroneko-runtime`，
 * 经 HCS 重定向器暴露）。libuv 用该路径作 `CreateProcessW` 的 lpCurrentDirectory
 * 时会失败并抛 `spawn UNKNOWN`(-4094)。这里强制把 cwd 指向可写的 workDir，
 * 既消除该故障，也让子进程相对路径行为更可预期。
 */
function resolveChildCwd(workDir: string): string {
  try {
    fs.mkdirSync(workDir, { recursive: true });
    return workDir;
  } catch {
    return process.cwd();
  }
}

/** 启动内脑 worker 子进程 */
export function spawnInnerBrainWorker(params: SpawnInnerBrainParams): SpawnedWorker {
  const child = spawn(
    process.execPath,
    resolveWorkerLaunch(),
    {
      cwd: resolveChildCwd(params.workDir),
      env: {
        ...process.env,
        INNER_INSTANCE_ID:  params.instanceId,
        INNER_WORKSPACE_ID: params.workspaceId,
        INNER_WORK_DIR:     params.workDir,
        INNER_MAX_TICKS:    String(params.maxTicks),
        ...(params.kpiId ? { INNER_KPI_ID: params.kpiId } : {}),
        ...(params.peerWorkspaceIds?.length
          ? { INNER_PEER_WORKSPACE_IDS: params.peerWorkspaceIds.join(',') }
          : {}),
        ...(params.workspacesRoot ? { INNER_WORKSPACES_ROOT: params.workspacesRoot } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      windowsHide: true,
    },
  );

  // 将子进程日志转发到父进程（带前缀方便区分）
  const prefix = `[ib:${params.instanceId.slice(-8)}]`;
  child.stdout?.on('data', (d: Buffer) => process.stdout.write(`${prefix} ${d.toString()}`));
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`${prefix} ${d.toString()}`));

  child.on('exit', (code, signal) => {
    params.onExit?.(code, signal);
  });

  if (!child.pid) {
    throw new Error(`[spawner] 无法启动内脑子进程 (instanceId=${params.instanceId})`);
  }

  return { pid: child.pid, child };
}
