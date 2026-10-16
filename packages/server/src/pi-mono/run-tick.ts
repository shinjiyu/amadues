/**
 * Pi-mono：内嵌 openKuroneko 运行时（源码位于 `src/openkuroneko/`，由本仓库编译，不再动态加载并列 dist）。
 *
 * - 单步：`tick()` 一次（一次「宏步」）。
 * - Auto：同一控制器实例上连续 `tick()`，直到 `hadWork === false` 或达到 `maxTicks`。
 */

import fs from 'node:fs';
import path from 'node:path';

import { createDyflowController } from '../openkuroneko/inner-brain/index.js';
import { projectDyflowStatus } from '../openkuroneko/inner-brain/status-projection.js';
import { createInnerRuntime } from './inner-runtime.js';

let gate: Promise<void> = Promise.resolve();

function withPiMonoLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = gate.then(fn);
  gate = next.then(
    () => {},
    () => {},
  );
  return next;
}

type PiController = { tick: () => Promise<{ hadWork: boolean }> };

/** 与旧 API 兼容：不再指向外部目录，固定为内嵌运行时标识 */
export const PI_MONO_RUNTIME_LABEL = 'embedded';

async function createPiMonoController(params: {
  workspaceId: string;
  workDir: string;
}): Promise<{ controller: PiController }> {
  const rt = createInnerRuntime(params);

  // 内脑引擎：DyFlow（Designer/Runner）。legacy 三件套已删除。
  // ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md
  const controller = createDyflowController(
    {
      workDir: params.workDir,
      workspaceId: params.workspaceId,
      burstId: rt.burstId,
      instanceId: rt.instanceId,
      burstStartedAt: rt.burstStartedAt,
      ...(rt.kpiId ? { kpiId: rt.kpiId } : {}),
    },
    {
      llm: rt.llm,
      toolRegistry: rt.toolRegistry,
      logger: rt.logger,
      ...(rt.nodeSharing ? { nodeSharing: rt.nodeSharing } : {}),
      ...(rt.sharedFactSink ? { sharedFactSink: rt.sharedFactSink } : {}),
      planReference: rt.planReference,
      skillProvider: rt.skillProvider,
      onComplete: async (reason: string) => {
        try {
          const out = rt.ioRegistry.getOutput('default');
          await out?.write(JSON.stringify({ type: 'COMPLETE', message: reason, ts: new Date().toISOString() }));
        } catch { /* non-critical */ }
      },
    },
  );
  return { controller };
}

export type PiMonoTickResult =
  | { ok: true; hadWork: boolean; dist: string }
  | { ok: false; error: string; dist?: string };

export async function runOpenKuronekoPiMonoTick(params: {
  workspaceId: string;
  workDir: string;
}): Promise<PiMonoTickResult> {
  return withPiMonoLock(async () => {
    try {
      const { controller } = await createPiMonoController(params);
      const { hadWork } = await controller.tick();
      return { ok: true, hadWork, dist: PI_MONO_RUNTIME_LABEL };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg, dist: PI_MONO_RUNTIME_LABEL };
    }
  });
}

export type PiMonoAutoResult =
  | { ok: true; ticks: number; lastHadWork: boolean; stoppedBy: 'idle' | 'max_ticks' | 'stop_signal'; dist: string }
  | { ok: false; error: string; ticks: number; dist?: string };

/** 写入停止信号文件，下一个 tick 循环检测到后会提前退出 */
export function writeStopSignal(workDir: string): void {
  try {
    fs.writeFileSync(path.join(workDir, '.stop-signal'), '1', 'utf8');
  } catch {
    // 忽略
  }
}

/** 清除停止信号文件（新任务启动时调用） */
export function clearStopSignal(workDir: string): void {
  try {
    fs.unlinkSync(path.join(workDir, '.stop-signal'));
  } catch {
    // 文件不存在时忽略
  }
}

function isStopSignalSet(workDir: string): boolean {
  return fs.existsSync(path.join(workDir, '.stop-signal'));
}

/**
 * 连续 tick，直到本轮「无活」（hadWork=false）、达到 maxTicks 或收到停止信号。
 * @param onTick 每次 tick 完成后的回调，参数为当前 tick 计数和时间戳，可用于写 lastTickAt 到注册表
 */
export async function runOpenKuronekoPiMonoAuto(params: {
  workspaceId: string;
  workDir: string;
  maxTicks: number;
  onTick?: (ticks: number, tickAt: string) => void;
}): Promise<PiMonoAutoResult> {
  const maxTicks = Math.min(10_000, Math.max(1, params.maxTicks));

  return withPiMonoLock(async () => {
    try {
      const { controller } = await createPiMonoController(params);
      let ticks = 0;

      while (ticks < maxTicks) {
        if (isStopSignalSet(params.workDir)) {
          return { ok: true, ticks, lastHadWork: true, stoppedBy: 'stop_signal' as const, dist: PI_MONO_RUNTIME_LABEL };
        }
        const { hadWork } = await controller.tick();
        ticks++;
        const tickAt = new Date().toISOString();
        projectDyflowStatus({
          workspaceId: params.workspaceId,
          workDir: params.workDir,
          tickCount: ticks,
          hadWork,
          note: 'tick_done',
        });
        params.onTick?.(ticks, tickAt);
        if (!hadWork) {
          return { ok: true, ticks, lastHadWork: false, stoppedBy: 'idle' as const, dist: PI_MONO_RUNTIME_LABEL };
        }
      }

      return { ok: true, ticks, lastHadWork: true, stoppedBy: 'max_ticks' as const, dist: PI_MONO_RUNTIME_LABEL };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg, ticks: 0, dist: PI_MONO_RUNTIME_LABEL };
    }
  });
}
