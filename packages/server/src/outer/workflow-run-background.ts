/**
 * 外脑进程内 EW execute：后台跑，禁止 await 堵死对话环。
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md · 事件循环不变量
 */
import type { ExecutableWorkflow } from './executable-workflow-types.js';
import type { InnerBrainRegistry, TaskRecord } from './inner-brain-registry.js';
import {
  runExecutableWorkflow,
  type WorkflowRunResult,
  type WorkflowRunnerDeps,
} from '../openkuroneko/inner-brain/workflow-runner.js';

export interface StartEwBackgroundOpts {
  wf: ExecutableWorkflow;
  workDir: string;
  deps: WorkflowRunnerDeps;
  registry?: InnerBrainRegistry | null;
  /** 已填好的 RUNNING 记录（缺 status 时补 RUNNING） */
  task: TaskRecord;
  onSettled?: (run: WorkflowRunResult) => void;
}

/**
 * 注册 RUNNING 后异步执行；立即返回。错误写入 registry，不抛到外脑对话环。
 */
export function startExecutableWorkflowBackground(opts: StartEwBackgroundOpts): {
  instanceId: string;
  workspaceId: string;
} {
  const { wf, workDir, deps, registry, onSettled } = opts;
  const task: TaskRecord = {
    ...opts.task,
    status: 'RUNNING',
    startedAt: opts.task.startedAt || new Date().toISOString(),
    workDir,
  };
  registry?.register(task);

  void runExecutableWorkflow(wf, deps)
    .then((run) => {
      if (registry) {
        registry.update(task.instanceId, {
          status: run.ok ? 'DONE' : 'ERROR',
          finishedAt: new Date().toISOString(),
          ticks: run.steps.length,
          deliverableCount: run.ok ? 1 : 0,
          ...(run.ok
            ? { errorMessage: undefined }
            : {
                errorMessage: `workflow failed at ${run.abortedAt ?? '?'}: ${
                  run.steps.find((s) => !s.ok)?.detail ?? ''
                }`.slice(0, 500),
              }),
        });
      }
      onSettled?.(run);
    })
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[utlra][ew-bg] ${wf.id}@${wf.version} crashed instance=${task.instanceId}:`,
        msg,
      );
      registry?.update(task.instanceId, {
        status: 'ERROR',
        finishedAt: new Date().toISOString(),
        errorMessage: msg.slice(0, 500),
      });
    });

  return { instanceId: task.instanceId, workspaceId: task.workspaceId };
}
