/**
 * 外脑进程启动时恢复被中断的 RUNNING 内脑 burst（ADL: innerBrainStartupResume）。
 * @see doc/structurizr/INNER-BRAIN-RESUME.md
 */
import type { InnerBrainRegistry, TaskRecord } from './inner-brain-registry.js';

export type SpawnWorkerResult =
  | { ok: true; pid: number }
  | { ok: false; error: string };

export type SpawnWorkerFn = (
  record: TaskRecord,
  opts: { incrementResumeCount?: boolean },
) => SpawnWorkerResult;

export type AutoResumeConfig = {
  enabled: boolean;
  maxResumes: number;
};

export function parseAutoResumeConfig(
  env: NodeJS.ProcessEnv = process.env,
): AutoResumeConfig {
  const enabled = (env['UTLRA_INNER_AUTO_RESUME'] ?? '1') !== '0';
  const maxResumes = Math.max(0, Number(env['UTLRA_INNER_MAX_AUTO_RESUME'] ?? 3));
  return { enabled, maxResumes };
}

/**
 * 将 registry 中遗留 RUNNING 标为 STOPPED，并按配置对每条 stale 尝试 spawn。
 */
export function autoResumeStaleTasks(
  registry: InnerBrainRegistry,
  spawn: SpawnWorkerFn,
  config: AutoResumeConfig = parseAutoResumeConfig(),
): void {
  const { enabled, maxResumes } = config;
  const stale = registry.markStaleRunningAsStopped();

  if (stale.length === 0) {
    console.log(
      `[utlra][inner-brain] auto-resume check: no stale RUNNING tasks ` +
        `(auto_resume=${enabled ? 'on' : 'off'} max_resume=${maxResumes})`,
    );
    return;
  }

  console.log(
    `[utlra][inner-brain] 检测到 ${stale.length} 个被中断的内脑任务` +
      `（auto_resume=${enabled ? 'on' : 'off'} max_resume=${maxResumes}）`,
  );

  if (!enabled) {
    for (const r of stale) {
      console.log(
        `[utlra][inner-brain]   - ${r.instanceId} (auto_resume 关闭) → 仅标记 STOPPED`,
      );
    }
    return;
  }

  for (const r of stale) {
    const count = r.resumeCount ?? 0;
    if (count >= maxResumes) {
      const note = `已达自动 resume 上限 ${maxResumes}（防永动机），用户可手动 /restart`;
      registry.update(r.instanceId, {
        errorMessage: `(server 重启，任务中断；${note})`,
      });
      console.log(`[utlra][inner-brain]   - ${r.instanceId} 跳过：${note}`);
      continue;
    }
    const res = spawn(r, { incrementResumeCount: true });
    if (res.ok) {
      console.log(
        `[utlra][inner-brain]   - ${r.instanceId} auto-resumed (#${count + 1})  pid=${res.pid}`,
      );
    } else {
      console.error(
        `[utlra][inner-brain]   - ${r.instanceId} auto-resume 失败: ${res.error}`,
      );
    }
  }
}
