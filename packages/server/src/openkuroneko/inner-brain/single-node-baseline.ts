/**
 * 消融基线：把整个目标交给一个 preset/base 节点，由 Runner 执行一次。
 *
 * 与 DyFlow 共用 Runner 的 baseNode 派发（memory/keychain 工具扩充、技能加载、§6.7 验票），
 * 去掉 Designer、多节点 DAG、Attributor、失败蒸馏、重设计循环与 Harness-RSI。
 * 仅供实验；生产不调用。
 *
 * ADL：doc/structurizr/INNER-ABLATION.md §2
 */

import fs from 'node:fs';
import path from 'node:path';

import type { LLMAdapter } from '../adapter/index.js';
import type { Logger } from '../logger/index.js';
import type { SkillProvider } from '../skills/provider.js';
import type { ToolRegistry } from '../tools/index.js';
import { seedGoalIntoMemory } from './controller.js';
import { createLocalNodeStore } from './local-node-store.js';
import type { LocalNodeStore } from './local-node-store.js';
import { createMemoryStore } from './memory-store.js';
import type { MemoryStore } from './memory-store.js';
import { seedPresetNodes } from './preset-seeder.js';
import { runLocalDag } from './runner.js';
import type { LocalDag, NodeOutcomeStatus } from './types.js';

export const SINGLE_NODE_BASELINE_RESULT_FILE = path.join('.run', 'single-node-baseline.json');
export const SINGLE_NODE_INST_ID = 'single';

export interface SingleNodeBaselineContext {
  workDir: string;
  burstId: string;
}

export interface SingleNodeBaselineDeps {
  llm: LLMAdapter;
  toolRegistry: ToolRegistry;
  logger: Logger;
  skillProvider?: SkillProvider;
  store?: LocalNodeStore;
  memory?: MemoryStore;
}

export interface SingleNodeBaselineResult {
  ok: boolean;
  status: NodeOutcomeStatus | 'no_goal';
  burstId: string;
  toolCalls: number;
  failureSummary?: string;
  startedAt: string;
  finishedAt: string;
}

export async function runSingleNodeBaseline(
  ctx: SingleNodeBaselineContext,
  deps: SingleNodeBaselineDeps,
): Promise<SingleNodeBaselineResult> {
  const startedAt = new Date().toISOString();
  const store = deps.store ?? createLocalNodeStore(ctx.workDir);
  const memory = deps.memory ?? createMemoryStore(ctx.workDir);
  seedPresetNodes(ctx.workDir, { store });
  seedGoalIntoMemory(ctx.workDir, memory);

  const goal = memory.read().goal?.trim();
  if (!goal) {
    return persist(ctx.workDir, {
      ok: false,
      status: 'no_goal',
      burstId: ctx.burstId,
      toolCalls: 0,
      failureSummary: 'memory.goal 为空（缺 .brain/goal.md）',
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  }

  const dag: LocalDag = {
    burstId: ctx.burstId,
    designedAt: startedAt,
    nodes: [{ id: SINGLE_NODE_INST_ID, ref: 'preset/base', instruction: goal }],
  };

  const res = await runLocalDag(dag, {
    llm: deps.llm,
    toolRegistry: deps.toolRegistry,
    store,
    memory,
    logger: deps.logger,
    workDir: ctx.workDir,
    ...(deps.skillProvider ? { skillProvider: deps.skillProvider } : {}),
  });

  const nodeResult = res.results.find(r => r.nodeInstId === SINGLE_NODE_INST_ID);
  const record = res.executionRecords.find(r => r.nodeInstId === SINGLE_NODE_INST_ID);
  const failureSummary = nodeResult?.failure?.summary ?? record?.failureSummary;

  return persist(ctx.workDir, {
    ok: res.ok,
    status: nodeResult?.status ?? (res.ok ? 'ok' : 'failed'),
    burstId: ctx.burstId,
    toolCalls: record?.executionLog.length ?? 0,
    ...(failureSummary ? { failureSummary } : {}),
    startedAt,
    finishedAt: new Date().toISOString(),
  });
}

function persist(workDir: string, result: SingleNodeBaselineResult): SingleNodeBaselineResult {
  const file = path.join(workDir, SINGLE_NODE_BASELINE_RESULT_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(result, null, 2), 'utf8');
  return result;
}
