/**
 * Inner Brain Worker — CLI 进程入口
 *
 * 每个内脑任务对应一个此进程实例，由外脑 server 通过 spawnInnerBrainWorker() 自动启动。
 * 也可以直接手动运行（调试用途）：
 *
 *   INNER_INSTANCE_ID=test-001 \
 *   INNER_WORKSPACE_ID=default \
 *   INNER_WORK_DIR=/absolute/path/to/workspace \
 *   INNER_MAX_TICKS=500 \
 *   npm run inner-brain -w @utlra/server
 *
 * 或直接用 node：
 *
 *   INNER_INSTANCE_ID=test-001 INNER_WORKSPACE_ID=default \
 *   INNER_WORK_DIR=/path/to/workspace \
 *   node --import tsx/esm packages/server/src/pi-mono/inner-brain-worker.ts
 *
 * 进程隔离带来的好处：
 *   - 内脑崩溃不影响外脑 server
 *   - 内脑 CPU 密集操作不卡外脑事件循环
 *   - 多个内脑可真正并发（各自独立进程）
 *
 * 状态完全持久化到磁盘（Pi-mono 每 tick 读写 .brain/），
 * 进程随时可以 kill 并重启，从上一次完成的 tick 后继续。
 *
 * 参数（环境变量）：
 *   INNER_INSTANCE_ID   — 注册表实例 ID（必须）
 *   INNER_WORKSPACE_ID  — workspace 逻辑 ID（必须）
 *   INNER_WORK_DIR      — workspace 绝对路径（必须）
 *   INNER_MAX_TICKS     — Pi-mono 最大 tick 数（默认 500）
 *
 * 输出：
 *   <workDir>/.run/inner-worker-status.json — 每 tick 更新，供外脑轮询 liveness
 *   <workDir>/.run/pi-mono/output           — BLOCK/PROGRESS/COMPLETE 事件，供 PushLoop 消费
 *
 * 退出码：
 *   0 — 正常结束（DONE 或 STOPPED）
 *   1 — 运行时错误
 *   2 — 参数错误（缺少必要 env var）
 */

import path from 'node:path';
import fs from 'node:fs';
import { configureLlmUsageTracker } from '../outer/llm-usage-tracker.js';
import { runOpenKuronekoPiMonoAuto } from './run-tick.js';

const instanceId  = process.env['INNER_INSTANCE_ID']  ?? '';
const workspaceId = process.env['INNER_WORKSPACE_ID'] ?? '';
const workDir     = process.env['INNER_WORK_DIR']     ?? '';
const maxTicks    = parseInt(process.env['INNER_MAX_TICKS'] ?? '500', 10);

if (!instanceId || !workspaceId || !workDir) {
  const missing = [
    !instanceId  && 'INNER_INSTANCE_ID',
    !workspaceId && 'INNER_WORKSPACE_ID',
    !workDir     && 'INNER_WORK_DIR',
  ].filter(Boolean).join(', ');
  process.stderr.write(
    `[inner-brain-worker] 缺少必要的环境变量: ${missing}\n\n` +
    `用法:\n` +
    `  INNER_INSTANCE_ID=<id> \\\n` +
    `  INNER_WORKSPACE_ID=<workspace-id> \\\n` +
    `  INNER_WORK_DIR=/absolute/path/to/workspace \\\n` +
    `  [INNER_MAX_TICKS=500] \\\n` +
    `  npm run inner-brain -w @utlra/server\n\n` +
    `退出码: 0=正常 1=运行时错误 2=参数错误\n`,
  );
  process.exit(2);
}

const dataRoot = process.env['UTLRA_DATA_ROOT']?.trim();
if (dataRoot) {
  const agentId =
    process.env['UTLRA_AGENT_NAME']?.trim() ||
    process.env['UTLRA_AGENT_IM_SID']?.trim() ||
    'unknown';
  configureLlmUsageTracker({ dataRoot, agentId });
}

export type WorkerStatusPhase = 'starting' | 'running' | 'done' | 'error';

export interface WorkerStatus {
  phase:        WorkerStatusPhase;
  instanceId:   string;
  workspaceId:  string;
  ticks:        number;
  lastTickAt?:  string;
  stoppedBy?:   'idle' | 'max_ticks' | 'stop_signal';
  error?:       string;
  updatedAt:    string;
}

const statusFile = path.join(workDir, '.run', 'inner-worker-status.json');

function writeStatus(data: Omit<WorkerStatus, 'updatedAt' | 'instanceId' | 'workspaceId'>): void {
  try {
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    const out: WorkerStatus = {
      ...data,
      instanceId,
      workspaceId,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(statusFile, JSON.stringify(out, null, 2), 'utf8');
  } catch {
    // 写失败不致命
  }
}

process.stdout.write(`[inner-brain-worker] ${instanceId} 启动 workDir=${workDir} maxTicks=${maxTicks}\n`);
writeStatus({ phase: 'starting', ticks: 0 });

const result = await runOpenKuronekoPiMonoAuto({
  workspaceId,
  workDir,
  maxTicks,
  onTick: (ticks, tickAt) => {
    writeStatus({ phase: 'running', ticks, lastTickAt: tickAt });
  },
});

if (result.ok) {
  writeStatus({
    phase:      'done',
    ticks:      result.ticks,
    stoppedBy:  result.stoppedBy,
    lastTickAt: new Date().toISOString(),
  });
  process.stdout.write(
    `[inner-brain-worker] ${instanceId} 完成: ticks=${result.ticks} stoppedBy=${result.stoppedBy}\n`,
  );
  process.exit(0);
} else {
  writeStatus({ phase: 'error', ticks: 0, error: result.error });
  process.stderr.write(`[inner-brain-worker] ${instanceId} 错误: ${result.error}\n`);
  process.exit(1);
}
