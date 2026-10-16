/**
 * 消融基线入口：用与 run-tick 相同的运行时依赖跑单节点基线。
 *
 * ADL：doc/structurizr/INNER-ABLATION.md §2 §9
 */

import { runSingleNodeBaseline } from '../openkuroneko/inner-brain/single-node-baseline.js';
import type { SingleNodeBaselineResult } from '../openkuroneko/inner-brain/single-node-baseline.js';
import { createInnerRuntime } from './inner-runtime.js';

export async function runSingleNodeBaselineInWorkDir(params: {
  workspaceId: string;
  workDir: string;
}): Promise<SingleNodeBaselineResult> {
  const rt = createInnerRuntime(params);
  return runSingleNodeBaseline(
    { workDir: params.workDir, burstId: rt.burstId },
    {
      llm: rt.llm,
      toolRegistry: rt.toolRegistry,
      logger: rt.logger,
      skillProvider: rt.skillProvider,
    },
  );
}
