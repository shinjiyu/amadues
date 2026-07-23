/**
 * Execute 路径默认 runner 依赖：browser / frozen_dag 真跑。
 * - `UTLRA_EW_BROWSER_LIVE=0` 关闭 browser
 * - `UTLRA_EW_FROZEN_LIVE=0` 关闭 frozen（仅物化）
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md P3–P4
 */
import type { WorkflowRunnerDeps } from './workflow-runner.js';
import { runBrowserPlaybookLive } from './workflow-browser-live.js';
import {
  createDefaultEwFrozenRunLocalDag,
  isFrozenLiveEnabled,
} from './workflow-frozen-live.js';
import type { RunLocalDagFn } from './workflow-adapters.js';

export function isBrowserLiveEnabled(): boolean {
  return process.env['UTLRA_EW_BROWSER_LIVE'] !== '0';
}

export function defaultExecutableWorkflowRunnerDeps(
  workDir: string,
  extra?: { runLocalDag?: RunLocalDagFn },
): WorkflowRunnerDeps {
  const runLocalDag =
    extra?.runLocalDag ??
    (isFrozenLiveEnabled() ? createDefaultEwFrozenRunLocalDag() : undefined);
  return {
    workDir,
    ...(isBrowserLiveEnabled() ? { runBrowserSteps: runBrowserPlaybookLive } : {}),
    ...(runLocalDag ? { runLocalDag } : {}),
  };
}
