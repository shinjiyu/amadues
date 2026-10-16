/**
 * 内脑运行时依赖构造：LLM、executor 工具表、logger、技能、drive9 共享、plan reference。
 *
 * run-tick（DyFlow）与消融基线（run-single-node）共用，保证两者拿到同一套工具与模型。
 * ADL：doc/structurizr/INNER-ABLATION.md §9
 */

import fs from 'node:fs';
import path from 'node:path';

import { createNodeDefDrive9Store } from '../drive9/node-def-drive9-store.js';
import { Drive9Client, resolveDrive9Config } from '../drive9/drive9-client.js';
import { KnowledgeDrive9Store } from '../drive9/knowledge-drive9-store.js';
import { createDrive9FactSyncSink } from '../outer/knowledge-promote.js';
import { createPlanReferencePort } from '../outer/plan-reference-search.js';
import type { NodeSharingConfig } from '../openkuroneko/inner-brain/controller.js';
import type { PlanReferenceDeps } from '../openkuroneko/inner-brain/designer-tools.js';
import type { FactRecord } from '../openkuroneko/inner-brain/types.js';
import {
  createIORegistry,
  createFileInputEndpoint,
  createFileOutputEndpoint,
} from '../openkuroneko/io/index.js';
import type { IORegistry } from '../openkuroneko/io/index.js';
import { createLogger } from '../openkuroneko/logger/index.js';
import type { Logger } from '../openkuroneko/logger/index.js';
import { createLocalModuleAdapter, createOpenAIAdapter } from '../openkuroneko/adapter/index.js';
import type { LLMAdapter } from '../openkuroneko/adapter/index.js';
import { createToolRegistry } from '../openkuroneko/tools/index.js';
import type { ToolRegistry } from '../openkuroneko/tools/index.js';
import * as toolsDefs from '../openkuroneko/tools/definitions/index.js';
import { createObSkillProvider } from '../openkuroneko/skills/provider.js';
import type { SkillProvider } from '../openkuroneko/skills/provider.js';
import { Drive9SkillProvider } from '../openkuroneko/skills/drive9-provider.js';
import { loadInnerLlmEnvFromProcess } from '../llm/inner-llm-step.js';
import { getSelfUpdateAllowedDirs } from '../self-update/session.js';
import {
  buildPeerWorkspaceEntries,
  parsePeerWorkspaceIds,
} from '../openkuroneko/tools/peer-workspace.js';

export interface InnerRuntime {
  llm: LLMAdapter;
  toolRegistry: ToolRegistry;
  logger: Logger;
  ioRegistry: IORegistry;
  skillProvider: SkillProvider;
  nodeSharing?: NodeSharingConfig;
  sharedFactSink?: (fact: FactRecord) => void;
  planReference: PlanReferenceDeps;
  burstId: string;
  instanceId: string;
  burstStartedAt: string | null;
  kpiId?: string;
}

export function createInnerRuntime(params: { workspaceId: string; workDir: string }): InnerRuntime {
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
  const workspacesRoot = process.env['INNER_WORKSPACES_ROOT']?.trim();
  const peerIds = parsePeerWorkspaceIds(process.env['INNER_PEER_WORKSPACE_IDS']);
  if (workspacesRoot && peerIds.length > 0) {
    toolsDefs.setPeerWorkspaces(buildPeerWorkspaceEntries(workspacesRoot, peerIds));
  }
  toolsDefs.setCapabilityGapTempDir(tempDir);
  toolsDefs.setDeliverablesTempDir(tempDir);
  toolsDefs.setAsyncWaitBrainDir(toolsDefs.brainDirFromWorkDir(params.workDir));

  const ioRegistry = createIORegistry();
  ioRegistry.registerInput(createFileInputEndpoint('default', inputPath));
  ioRegistry.registerOutput(createFileOutputEndpoint('default', outputPath));

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
  const drive9Config = resolveDrive9Config();
  const localSkillDir = process.env['OPENKURONEKO_OB_SKILL_POOL']
    ? `${process.env['OPENKURONEKO_OB_SKILL_POOL']}/skills`
    : undefined;
  const skillProvider = drive9Config
    ? new Drive9SkillProvider(drive9Config.apiKey, drive9Config.apiUrl, localSkillDir)
    : createObSkillProvider(process.env['OPENKURONEKO_OB_SKILL_POOL']);

  const toolRegistry = createToolRegistry([
    toolsDefs.describeImageTool,
    toolsDefs.readFileTool,
    toolsDefs.writeFileTool,
    toolsDefs.editFileTool,
    toolsDefs.searchFilesTool,
    toolsDefs.listPeerWorkspacesTool,
    toolsDefs.readPeerFileTool,
    toolsDefs.listPeerFilesTool,
    toolsDefs.searchPeerFilesTool,
    toolsDefs.shellExecTool,
    toolsDefs.shellProbeTool,
    toolsDefs.shellExecBgTool,
    toolsDefs.shellReadOutputTool,
    toolsDefs.shellKillTool,
    toolsDefs.browserOpenTool,
    toolsDefs.browserActTool,
    toolsDefs.browserCloseTool,
    toolsDefs.browserListTool,
    toolsDefs.browserRunStepsTool,
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

  const kpiId = process.env['INNER_KPI_ID']?.trim() || undefined;
  const burstId = process.env['INNER_BURST_ID']?.trim() || kpiId || params.workspaceId;

  // P1：drive9 配置存在时启用节点共享（Designer search_and_instance + creator 自动导出）
  const drive9Client = drive9Config
    ? new Drive9Client({ apiKey: drive9Config.apiKey, apiUrl: drive9Config.apiUrl })
    : undefined;

  const nodeSharing: NodeSharingConfig | undefined = drive9Client
    ? {
        defStore: createNodeDefDrive9Store(drive9Client),
        sourceAgent: params.workspaceId,
        env: { workDir: params.workDir },
      }
    : undefined;

  const sharedFactSink = drive9Client
    ? createDrive9FactSyncSink(
        new KnowledgeDrive9Store(drive9Client),
        params.workspaceId,
        path.basename(params.workDir),
      )
    : undefined;

  const dataRoot = process.env['UTLRA_DATA_ROOT']?.trim();
  const planReferencePort = createPlanReferencePort({
    ...(dataRoot ? { dataRoot } : {}),
    ...(process.env['UTLRA_ARCHIVE_DIR']?.trim()
      ? { archiveDir: process.env['UTLRA_ARCHIVE_DIR']!.trim() }
      : {}),
    tenantId: params.workspaceId,
    ...(workspacesRoot ? { workspacesRoot } : {}),
    ...(peerIds.length > 0 ? { peerWorkspaceIds: peerIds } : {}),
  });
  const planReference: PlanReferenceDeps = { port: planReferencePort, ...(kpiId ? { kpiId } : {}) };

  const instanceId =
    process.env['INNER_INSTANCE_ID']?.trim() ||
    (params.workspaceId.startsWith('task-')
      ? `ib-${params.workspaceId.slice('task-'.length)}`
      : params.workspaceId);
  const burstStartedAt = process.env['INNER_BURST_STARTED_AT']?.trim() || null;

  return {
    llm,
    toolRegistry,
    logger,
    ioRegistry,
    skillProvider,
    ...(nodeSharing ? { nodeSharing } : {}),
    ...(sharedFactSink ? { sharedFactSink } : {}),
    planReference,
    burstId,
    instanceId,
    burstStartedAt,
    ...(kpiId ? { kpiId } : {}),
  };
}

function readEnvTrimmed(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}
