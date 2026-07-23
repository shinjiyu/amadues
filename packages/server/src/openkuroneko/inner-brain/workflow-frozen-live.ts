/**
 * EW frozen_dag 真跑：物化后调 DyFlow `runLocalDag`（execute 默认注入）。
 * `UTLRA_EW_FROZEN_LIVE=0` 关闭（单测 / 仅物化）。
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md P4
 */
import fs from 'node:fs';
import path from 'node:path';

import { createLocalModuleAdapter, createOpenAIAdapter } from '../adapter/index.js';
import { createLogger } from '../logger/index.js';
import { createToolRegistry } from '../tools/index.js';
import * as toolsDefs from '../tools/definitions/index.js';
import { createObSkillProvider } from '../skills/provider.js';
import { loadInnerLlmEnvFromProcess } from '../../llm/inner-llm-step.js';
import { createLocalNodeStore } from './local-node-store.js';
import { createMemoryStore } from './memory-store.js';
import { seedPresetNodes } from './preset-seeder.js';
import { createMemoryTools } from './memory-tools.js';
import { createKeychainTools } from './keychain-tools.js';
import { runLocalDag, type RunnerDeps } from './runner.js';
import type { LocalDag } from './types.js';
import type { AdapterResult, RunLocalDagFn } from './workflow-adapters.js';

export type RunnerDepsFactory = (workDir: string, dag: LocalDag) => RunnerDeps;

export function isFrozenLiveEnabled(): boolean {
  return process.env['UTLRA_EW_FROZEN_LIVE'] !== '0';
}

export function asWorkflowRunLocalDag(factory: RunnerDepsFactory): RunLocalDagFn {
  return async (dag, workDir): Promise<AdapterResult> => {
    const res = await runLocalDag(dag, factory(workDir, dag));
    return {
      ok: res.ok,
      detail: res.ok
        ? `frozen dag ran ${res.completed.length}/${dag.nodes.length} nodes`
        : `frozen dag failed at ${res.failedAt ?? '?'}`,
      exitCode: res.ok ? 0 : 1,
      stdout: `frozen_nodes=${dag.nodes.length};completed=${res.completed.length};ok=${res.ok ? 1 : 0}`,
    };
  };
}

function readEnvTrimmed(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

function buildLlmAdapter(): RunnerDeps['llm'] | null {
  const primaryLlm = loadInnerLlmEnvFromProcess();
  const apiKey = primaryLlm?.apiKey ?? readEnvTrimmed('OPENAI_API_KEY') ?? '';
  if (!apiKey) return null;
  if (primaryLlm?.provider === 'localmodule') {
    return createLocalModuleAdapter({
      apiKey: primaryLlm.apiKey,
      baseUrl: primaryLlm.baseUrl,
      model: primaryLlm.textModel,
    });
  }
  const baseUrl =
    primaryLlm?.baseUrl ??
    readEnvTrimmed('OPENAI_BASE_URL') ??
    'https://open.bigmodel.cn/api/coding/paas/v4';
  const model = primaryLlm?.textModel ?? readEnvTrimmed('OPENAI_MODEL') ?? 'glm-5.1';
  const thinkingEnabled = (primaryLlm?.thinking ?? 'disabled') === 'enabled';
  return createOpenAIAdapter({
    apiKey,
    baseUrl,
    model,
    toolWireFormat: 'minimal',
    extraBody: { thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' } },
  });
}

/**
 * 生产默认：为 workDir 装配最小 RunnerDeps 并跑 frozen dag。
 * 无 LLM 配置时返回失败（不假装物化即成功）。
 */
export function createDefaultEwFrozenRunLocalDag(): RunLocalDagFn {
  return async (dag, workDir): Promise<AdapterResult> => {
    const llm = buildLlmAdapter();
    if (!llm) {
      return {
        ok: false,
        detail: 'frozen live: LLM not configured (set INNER_LLM_* / OPENAI_API_KEY or UTLRA_EW_FROZEN_LIVE=0)',
        exitCode: 1,
        stdout: `frozen_nodes=${dag.nodes.length};ok=0`,
      };
    }

    const tempDir = path.join(workDir, '.run', 'ew-frozen');
    fs.mkdirSync(tempDir, { recursive: true });
    toolsDefs.setWorkDirGuard(workDir, tempDir, []);
    toolsDefs.setCapabilityGapTempDir(tempDir);
    toolsDefs.setDeliverablesTempDir(tempDir);
    toolsDefs.setAsyncWaitBrainDir(toolsDefs.brainDirFromWorkDir(workDir));

    const store = createLocalNodeStore(workDir);
    seedPresetNodes(workDir, { store });
    const memory = createMemoryStore(workDir);
    const skillProvider = createObSkillProvider(process.env['OPENKURONEKO_OB_SKILL_POOL']);
    const logger = createLogger(path.basename(workDir) || 'ew-frozen', tempDir);

    const toolRegistry = createToolRegistry([
      ...createMemoryTools(memory),
      ...createKeychainTools({
        ...(process.env['UTLRA_DATA_ROOT']?.trim()
          ? { dataRoot: process.env['UTLRA_DATA_ROOT']!.trim() }
          : {}),
      }),
      toolsDefs.readFileTool,
      toolsDefs.writeFileTool,
      toolsDefs.editFileTool,
      toolsDefs.searchFilesTool,
      toolsDefs.shellExecTool,
      toolsDefs.shellProbeTool,
      toolsDefs.browserOpenTool,
      toolsDefs.browserActTool,
      toolsDefs.browserCloseTool,
      toolsDefs.browserListTool,
      toolsDefs.browserRunStepsTool,
      toolsDefs.getTimeTool,
      toolsDefs.createQueryAvailableSkillsTool(skillProvider),
      toolsDefs.getSkillContentTool,
      toolsDefs.registerDeliverableTool,
    ]);

    const res = await runLocalDag(dag, {
      llm,
      toolRegistry,
      store,
      memory,
      logger,
      workDir,
      skillProvider,
    });
    return {
      ok: res.ok,
      detail: res.ok
        ? `frozen dag ran ${res.completed.length}/${dag.nodes.length} nodes`
        : `frozen dag failed at ${res.failedAt ?? '?'}`,
      exitCode: res.ok ? 0 : 1,
      stdout: `frozen_nodes=${dag.nodes.length};completed=${res.completed.length};ok=${res.ok ? 1 : 0}`,
    };
  };
}
