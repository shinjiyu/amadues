/**
 * Pi-mono：内嵌 openKuroneko 运行时（源码位于 `src/openkuroneko/`，由本仓库编译，不再动态加载并列 dist）。
 *
 * - 单步：`tick()` 一次（一次「宏步」）。
 * - Auto：同一控制器实例上连续 `tick()`，直到 `hadWork === false` 或达到 `maxTicks`。
 */

import fs from 'node:fs';
import path from 'node:path';

import { createController } from '../openkuroneko/controller/index.js';
import {
  createIORegistry,
  createFileInputEndpoint,
  createFileOutputEndpoint,
} from '../openkuroneko/io/index.js';
import { createMemoryLayer2 } from '../openkuroneko/memory/index.js';
import { createMem0Client } from '../openkuroneko/mem0/index.js';
import { createLogger } from '../openkuroneko/logger/index.js';
import { createLocalModuleAdapter, createOpenAIAdapter } from '../openkuroneko/adapter/index.js';
import { createToolRegistry } from '../openkuroneko/tools/index.js';
import * as toolsDefs from '../openkuroneko/tools/definitions/index.js';
import { createObSkillProvider } from '../openkuroneko/skills/provider.js';
import { Drive9SkillProvider } from '../openkuroneko/skills/drive9-provider.js';
import { createFilesystemStore } from '../openkuroneko/archive/index.js';
import { loadInnerLlmEnvFromProcess } from '../llm/inner-llm-step.js';
import { getSelfUpdateAllowedDirs } from '../self-update/session.js';
import { resolveDrive9Config } from '../drive9/drive9-client.js';

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
  const tempDir = path.join(params.workDir, '.run', 'pi-mono');
  fs.mkdirSync(tempDir, { recursive: true });

  const configPath = path.join(tempDir, 'agent.config.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ agentPath: params.workDir, utlraWorkspaceId: params.workspaceId }, null, 2),
      'utf8',
    );
  }

  const inputPath = path.join(tempDir, 'input');
  const outputPath = path.join(tempDir, 'output');

  toolsDefs.setWorkDirGuard(params.workDir, tempDir, getSelfUpdateAllowedDirs(params.workDir));
  toolsDefs.setCapabilityGapTempDir(tempDir);
  toolsDefs.setDeliverablesTempDir(tempDir);
  toolsDefs.setAsyncWaitBrainDir(toolsDefs.brainDirFromWorkDir(params.workDir));

  const ioRegistry = createIORegistry();
  ioRegistry.registerInput(createFileInputEndpoint('default', inputPath));
  ioRegistry.registerOutput(createFileOutputEndpoint('default', outputPath));

  const memory = createMemoryLayer2(tempDir);
  const mem0 = createMem0Client();
  const logger = createLogger(params.workspaceId, tempDir);

  const primaryLlm = loadInnerLlmEnvFromProcess();
  const apiKey = primaryLlm?.apiKey ?? readEnvTrimmed('OPENAI_API_KEY') ?? '';
  const baseUrl =
    primaryLlm?.baseUrl ??
    readEnvTrimmed('OPENAI_BASE_URL') ??
    'https://open.bigmodel.cn/api/coding/paas/v4';
  const model = primaryLlm?.textModel ?? readEnvTrimmed('OPENAI_MODEL') ?? 'glm-5.1';
  const thinkingEnabled = (primaryLlm?.thinking ?? 'disabled') === 'enabled';

  const llm =
    primaryLlm?.provider === 'localmodule'
      ? createLocalModuleAdapter({
          apiKey: primaryLlm.apiKey,
          baseUrl: primaryLlm.baseUrl,
          model: primaryLlm.textModel,
        })
      : createOpenAIAdapter({
          apiKey,
          baseUrl,
          model,
          toolWireFormat: 'minimal',
          extraBody: { thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' } },
        });

  // drive9 优先（vector+BM25 语义搜索），本地关键词兜底
  const drive9Config  = resolveDrive9Config();
  const localSkillDir = process.env['OPENKURONEKO_OB_SKILL_POOL']
    ? `${process.env['OPENKURONEKO_OB_SKILL_POOL']}/skills`
    : undefined;
  const skillProvider = drive9Config
    ? new Drive9SkillProvider(drive9Config.apiKey, drive9Config.apiUrl, localSkillDir)
    : createObSkillProvider(process.env['OPENKURONEKO_OB_SKILL_POOL']);

  const executorToolRegistry = createToolRegistry([
    toolsDefs.readFileTool,
    toolsDefs.writeFileTool,
    toolsDefs.editFileTool,
    toolsDefs.shellExecTool,
    toolsDefs.shellExecBgTool,
    toolsDefs.shellReadOutputTool,
    toolsDefs.shellKillTool,
    toolsDefs.webSearchTool,
    toolsDefs.getTimeTool,
    toolsDefs.runAgentTool,
    toolsDefs.capabilityGapTool,
    toolsDefs.createQueryAvailableSkillsTool(skillProvider),
    toolsDefs.getSkillContentTool,
    toolsDefs.registerDeliverableTool,
    toolsDefs.askUserTool,
    toolsDefs.waitTimerTool,
    toolsDefs.waitSignalTool,
    toolsDefs.readSelfUpdatePlanTool,
    toolsDefs.verifySelfUpdateTool,
    toolsDefs.rollbackSelfUpdateTool,
    toolsDefs.listAgentsTool,
    toolsDefs.stopAgentTool,
  ]);

  const attributorToolRegistry = createToolRegistry([
    toolsDefs.writeConstraintTool,
    toolsDefs.writeSkillTool,
    toolsDefs.writeMemoTool,
    toolsDefs.writeKnowledgeTool,
  ]);

  const knowledgeStore = createFilesystemStore();

  const innerKpiId = process.env['INNER_KPI_ID']?.trim() || undefined;

  const controller = createController(
    {
      agentId: params.workspaceId,
      workDir: params.workDir,
      tempDir,
      kpiId: innerKpiId,
    },
    {
      llm,
      ioRegistry,
      executorToolRegistry,
      attributorToolRegistry,
      memory,
      mem0,
      logger,
      knowledgeStore,
    },
  );

  return { controller };
}

function readEnvTrimmed(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
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
        params.onTick?.(ticks, new Date().toISOString());
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
