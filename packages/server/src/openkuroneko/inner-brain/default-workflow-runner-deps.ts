/**
 * Execute 路径默认 runner 依赖：browser / frozen_dag 真跑 + W11 keychain。
 * - `UTLRA_EW_BROWSER_LIVE=0` 关闭 browser
 * - `UTLRA_EW_FROZEN_LIVE=0` 关闭 frozen（仅物化）
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md P3–P4 · W11
 */
import path from 'node:path';
import type { WorkflowRunnerDeps } from './workflow-runner.js';
import { runBrowserPlaybookLive } from './workflow-browser-live.js';
import {
  createDefaultEwFrozenRunLocalDag,
  isFrozenLiveEnabled,
} from './workflow-frozen-live.js';
import type { RunLocalDagFn } from './workflow-adapters.js';
import { createKeychainResolveSecret } from '../../outer/workflow-secret-resolve.js';

export function isBrowserLiveEnabled(): boolean {
  return process.env['UTLRA_EW_BROWSER_LIVE'] !== '0';
}

function resolveDataRootFromWorkDir(workDir: string): string | null {
  const abs = path.resolve(workDir);
  const parent = path.dirname(abs);
  if (path.basename(parent) === 'workspaces') return path.dirname(parent);
  const env = process.env['UTLRA_DATA_ROOT']?.trim();
  return env || null;
}

export function defaultExecutableWorkflowRunnerDeps(
  workDir: string,
  extra?: { runLocalDag?: RunLocalDagFn; dataRoot?: string },
): WorkflowRunnerDeps {
  const runLocalDag =
    extra?.runLocalDag ??
    (isFrozenLiveEnabled() ? createDefaultEwFrozenRunLocalDag() : undefined);
  const dataRoot = extra?.dataRoot?.trim() || resolveDataRootFromWorkDir(workDir);
  return {
    workDir,
    ...(isBrowserLiveEnabled() ? { runBrowserSteps: runBrowserPlaybookLive } : {}),
    ...(runLocalDag ? { runLocalDag } : {}),
    ...(dataRoot
      ? { resolveSecret: createKeychainResolveSecret({ dataRoot }) }
      : {}),
  };
}
