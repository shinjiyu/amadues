import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { serve } from '@hono/node-server';

const __serverDir = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(__serverDir, '../../../.env') });
loadEnv({ path: path.join(process.cwd(), '.env') });

// 全局兜底：第三方桥（Discord 等）抛出的 unhandledRejection / uncaughtException
// 不应把整个 agent 拖死。只记录、不退出。真正致命的错误仍可通过日志排查。
process.on('unhandledRejection', (reason) => {
  console.error('[utlra] unhandledRejection（已忽略，agent 继续运行）:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[utlra] uncaughtException（已忽略，agent 继续运行）:', err);
});
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  FilesystemWorkspaceStore,
  FilesystemRepositoryStore,
  InnerBrainEngine,
  type CommitSessionInput,
  type RetrieveInput,
} from './workspace-kit/index.js';
import {
  ChatAssetStore,
  ChatIRSeenTracker,
  IdentityRegistry,
  MessagePartSchema,
  MessageRecordSchema,
  resolvePrimaryAgentSid,
  serializeIdentityPack,
  serializeMessageForLlm,
  StructuredReplySchema,
  renderMockChannel,
  validateReplyMentions,
  ensureThreadShell,
  type ChatIRChannel,
  type ChatIRInboundEvent,
  type ChatIROutboundBody,
  type MessagePart,
} from '@utlra/chat-ir';
import { runOuterRoundtrip } from './outer/orchestrator.js';
import {
  runPromoteThenShutdown,
  suggestGoalCompleteForShutdown,
} from './outer/inner-lifecycle.js';
import { OuterBrain } from './outer/outer-brain.js';
import { createMemoryStore, type OuterMemoryStore } from './outer/outer-memory.js';
import { createMemoryBlockStore } from './outer/memory-block-store.js';
import { initSkillMemoryStore, type SkillMemoryStore } from './mem9/skill-memory-store.js';
import { Mem9Client } from './mem9/mem9-client.js';
import { initSkillDrive9Store, type SkillDrive9Store } from './drive9/skill-drive9-store.js';
import { initKnowledgeDrive9Store, type KnowledgeDrive9Store } from './drive9/knowledge-drive9-store.js';
import { getDrive9Client, resolveDrive9Config } from './drive9/drive9-client.js';
import { InnerBrainRegistry, type TaskRecord, type TaskStatus } from './outer/inner-brain-registry.js';
import { KpiRegistry, formatKpiReflexionBlock } from './outer/kpi-registry.js';
import { processBurstExitForKpi } from './outer/kpi-burst-hooks.js';
import { readWorkerStatus, isPidAlive, spawnInnerBrainWorker } from './pi-mono/inner-brain-spawner.js';
import { isInnerBrainStoppable, stopInnerBrainInstance } from './outer/stop-inner-brain.js';
import { createChangeWatcher, type ChangeWatcher } from './pi-mono/change-watcher.js';
import { registryLifecycleReconcile, startRegistryLifecycleReconcileInterval } from './outer/registry-lifecycle-reconcile.js';
import { isBrainAwaitingAsync } from './outer/brain-async-snapshot.js';
import { notifyInnerBrainTaskComplete, type CompletionNotifyDeps } from './outer/completion-notify.js';
import { PushLoop } from './outer/push-loop.js';
import { OuterHeartbeat, loadHeartbeatConfigFromEnv } from './outer/outer-heartbeat.js';
import { loadInnerLlmEnvFromProcess, runInnerLlmStep } from './llm/inner-llm-step.js';
import { llmRawChatCompletion } from './llm/raw.js';
import {
  PI_MONO_RUNTIME_LABEL,
  runOpenKuronekoPiMonoAuto,
  runOpenKuronekoPiMonoTick,
} from './pi-mono/run-tick.js';
import { buildBrainInspectorPayload } from './pi-mono/brain-snapshot.js';
import {
  buildWorkspaceArtifactsPayload,
  revealWorkspaceAllowed,
} from './workspace-artifacts.js';
import { promoteWorkspaceManifestToRepository } from './repository/promote-from-workspace.js';
import { DiscordChannel, loadDiscordBridgeConfig } from '@utlra/discord-bridge';
import { WebChatChannel, loadWebChatBridgeConfig } from '@utlra/webchat-bridge';
import { PerformanceGoalEngine } from './performance-goals/engine.js';
import { renderPerformanceDashboard } from './performance-goals/dashboard.js';
import { registerHealthRoute } from './api/health-route.js';
import { registerParticipationLabRoutes } from './api/participation-lab-route.js';

import { resolveDataRoot } from './data-root.js';

// repo root = packages/server/src → ../../..
const REPO_ROOT = path.resolve(__serverDir, '..', '..', '..');
const DATA_ROOT = resolveDataRoot(REPO_ROOT, __serverDir, process.env['UTLRA_DATA_ROOT']);
const WORKSPACES = path.join(DATA_ROOT, 'workspaces');
const IDENTITY_FILE = path.join(DATA_ROOT, 'identities.json');
const CHAT_DIR = path.join(DATA_ROOT, 'chat');
const UPLOADS_DIR = path.join(CHAT_DIR, 'uploads');

fs.mkdirSync(WORKSPACES, { recursive: true });
fs.mkdirSync(CHAT_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const store = new FilesystemWorkspaceStore(WORKSPACES);
fs.mkdirSync(path.dirname(IDENTITY_FILE), { recursive: true });
const registry = new IdentityRegistry(IDENTITY_FILE);
registry.save();

const assetStore = new ChatAssetStore(UPLOADS_DIR);

/**
 * 无 Chat IR channel 时的 fallback 实现：postMessage 仅打日志。
 * HTTP `/api/outer/roundtrip` 仍可正常工作（不依赖 channel 出站）。
 *
 * 反 loop / 新鲜度查询通过共享的 `ChatIRSeenTracker` 实例完成，不在本类。
 */
class NullChatIRChannel implements ChatIRChannel {
  start(): void {}
  destroy(): void {}
  async postMessage(threadId: string, body: ChatIROutboundBody): Promise<void> {
    console.warn(
      `[utlra] (null-channel) drop postMessage thread=${threadId} sender=${body.sender_sid} text=${body.text?.slice(0, 80) ?? '(parts)'}`,
    );
  }
}

const engines = new Map<string, InnerBrainEngine>();

const repoStore = new FilesystemRepositoryStore(DATA_ROOT);

// 外脑记忆层（模块级引用，供 API 路由访问；在 serve 回调内初始化后赋值）
let globalMemoryStore: OuterMemoryStore | null = null;
let globalMemoryBlockStore: import('./outer/memory-block-store.js').MemoryBlockStore | null = null;
const performanceGoalEngine = new PerformanceGoalEngine(DATA_ROOT);
const innerBrainRegistry = new InnerBrainRegistry(DATA_ROOT);
const kpiRegistry = new KpiRegistry(DATA_ROOT);

/** 在 channel 就绪后注入，供 spawnAndAttachWorker onExit 发完成通知 */
let completionNotifyDeps: CompletionNotifyDeps | null = null;

function getEngine(workspaceId: string): InnerBrainEngine {
  let e = engines.get(workspaceId);
  if (!e) {
    e = new InnerBrainEngine(store, workspaceId);
    engines.set(workspaceId, e);
  }
  return e;
}

/**
 * 启动 / 重启一个内脑任务的 worker 子进程。
 *
 * 抽出来供：
 *   - HTTP `POST /api/inner-brains/:id/restart`（用户手动 restart）
 *   - 启动时自动 resume（detection: status=RUNNING 但进程已死）
 *
 * 行为：
 *   1. 清掉残留 stop-signal
 *   2. registry.update 把状态设为 RUNNING（清掉 finishedAt / pid / errorMessage / lastTickAt）
 *      - 如果 `incrementResumeCount=true`，同时把 resumeCount + 1（用于自动 resume 防永动机；
 *        手动 restart 不增加）
 *   3. spawnInnerBrainWorker，挂 onExit 回调把状态写回 registry + sync 引擎
 *   4. 返回 { ok, pid? | error? }
 */
/**
 * 检查 burst 退出后 workspace 是否处于 AWAITING：
 * - controller-state.json 里 mode === 'AWAITING'
 * - 或 pendings.json 里仍有 status='pending' 的项
 */
function detectAwaitingFromBrain(workDir: string): boolean {
  return isBrainAwaitingAsync(workDir);
}

function spawnAndAttachWorker(
  record: TaskRecord,
  opts: { incrementResumeCount?: boolean } = {},
): { ok: true; pid: number } | { ok: false; error: string } {
  try { fs.unlinkSync(path.join(record.workDir, '.stop-signal')); } catch { /* */ }

  const baseMaxTicks = Math.min(10_000, Math.max(1, Number(process.env['UTLRA_PI_AUTO_MAX_TICKS'] ?? 500)));
  // 反思 burst（progress detector 自动派发）用短 max_ticks，避免它自己也陷入死循环
  const reflexionMaxTicks = Math.max(1, Number(process.env['UTLRA_KPI_REFLEXION_MAX_TICKS'] ?? 20));
  const maxTicks = record.isReflexionBurst ? reflexionMaxTicks : baseMaxTicks;
  const id = record.instanceId;
  const eng = getEngine(record.workspaceId);

  const patch: Partial<TaskRecord> = {
    status:       'RUNNING',
    finishedAt:   undefined,
    pid:          undefined,
    errorMessage: undefined,
    lastTickAt:   undefined,
  };
  if (opts.incrementResumeCount) {
    patch.resumeCount = (record.resumeCount ?? 0) + 1;
  }
  innerBrainRegistry.update(id, patch);

  try {
    const { pid } = spawnInnerBrainWorker({
      instanceId:  record.instanceId,
      workspaceId: record.workspaceId,
      workDir:     record.workDir,
      maxTicks,
      kpiId:       record.kpiId,
      onExit: (exitCode, signal) => {
        const workerStatus = readWorkerStatus(record.workDir);
        const ticks = workerStatus?.ticks ?? 0;
        const stoppedBy = workerStatus?.stoppedBy ?? (signal ? 'stop_signal' : 'idle');
        const isError = exitCode !== 0 && signal == null;
        const isAwaiting = detectAwaitingFromBrain(record.workDir);

        // 跑 KPI hook：读 deliverables / reflexion，更新 KPI streak，可能触发反思 burst
        const kpiOutcome = processBurstExitForKpi(
          {
            instanceId: id,
            kpiId: record.kpiId,
            isReflexionBurst: record.isReflexionBurst,
            workDir: record.workDir,
            stoppedBy,
            exitedWithError: isError,
            isAwaiting,
          },
          { kpiRegistry, innerBrainRegistry, scheduleReflexionBurst, scheduleNextKpiBurst },
        );

        if (isError) {
          innerBrainRegistry.update(id, {
            status:           'ERROR',
            finishedAt:       new Date().toISOString(),
            ticks,
            deliverableCount: kpiOutcome.deliverableCount,
            errorMessage:     workerStatus?.error ?? `子进程退出码 ${String(exitCode)}`,
          });
          return;
        }

        const finalStatus: TaskStatus =
          (signal != null || stoppedBy === 'stop_signal') ? 'STOPPED'
          : isAwaiting ? 'AWAITING'
          : 'DONE';
        eng.syncAfterPiMonoAuto({
          ticks,
          lastHadWork: stoppedBy !== 'idle',
          stoppedBy: stoppedBy as 'idle' | 'max_ticks' | 'stop_signal',
        });
        innerBrainRegistry.update(id, {
          status:           finalStatus,
          finishedAt:       finalStatus === 'AWAITING' ? undefined : new Date().toISOString(),
          ticks,
          deliverableCount: kpiOutcome.deliverableCount,
          pid:              undefined,
        });

        if (finalStatus === 'DONE' && record.originThread && completionNotifyDeps) {
          void notifyInnerBrainTaskComplete(completionNotifyDeps, {
            instanceId: id,
            workspaceId: record.workspaceId,
            workDir: record.workDir,
            originThread: record.originThread,
          }).catch((e: unknown) =>
            console.error('[utlra][inner-brain] completion notify failed:', e),
          );
        }

        console.log(
          `[utlra][inner-brain] burst done (${id}): finalStatus=${finalStatus} ticks=${ticks}` +
          ` deliverables=${kpiOutcome.deliverableCount} kpi=${record.kpiId ?? '-'}` +
          ` verdict=${kpiOutcome.reflexion?.verdict ?? '-'}` +
          (kpiOutcome.reflexionBurstId ? ` → 派发反思 burst ${kpiOutcome.reflexionBurstId}` : '') +
          (kpiOutcome.nextKpiBurstId ? ` → 自动续跑 burst ${kpiOutcome.nextKpiBurstId}` : ''),
        );
      },
    });
    innerBrainRegistry.update(id, { pid });
    return { ok: true, pid };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    innerBrainRegistry.update(id, {
      status:       'ERROR',
      finishedAt:   new Date().toISOString(),
      errorMessage: `spawn 失败: ${msg}`,
    });
    return { ok: false, error: msg };
  }
}

/**
 * 派发一个针对 KPI 的"反思 burst"——progress detector 在 idle streak 达阈值时调用。
 *
 * 反思 burst 与普通 burst 的区别：
 *   - goal.md 是 meta 级的："请评估 KPI 卡死原因 / 提出换向策略 / 必要时建议 abandon"
 *   - max_ticks 短（UTLRA_KPI_REFLEXION_MAX_TICKS，默认 20）
 *   - 不算入 KPI 的 idleStreak（防止"反思失败 → 又触发反思"死循环）
 *   - 仍然挂在 KPI 上（kpi.bursts 会记录），但 isReflexionBurst=true
 *
 * 反思 burst 跑出的 reflexion.json 会被这个 burst 自己的 onExit 写入 kpi.reflexionTrail，
 * 下一次"真"burst 的 decomposer 会读到这份 meta 反思（同 KPI 检索路径）。
 *
 * 返回新 burst 的 instanceId；失败返回 null。
 */
function scheduleReflexionBurst(kpiId: string): string | null {
  const kpi = kpiRegistry.get(kpiId);
  if (!kpi) return null;

  // 用 KpiRegistry 自带 ID 生成器避免和 inner-brain instanceId 撞
  const instanceId = innerBrainRegistry.generateInstanceId();
  const workspaceId = `task-${instanceId}`;
  const workDir = path.join(DATA_ROOT, 'workspaces', workspaceId);
  fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });

  // 反思 burst 的 goal：让 agent 自己评估 KPI 卡点
  const recentReflexions = kpiRegistry.recentReflexions(kpiId, 5);
  const trailDigest = recentReflexions.length === 0
    ? '（暂无 reflexion 记录）'
    : recentReflexions.map((r, i) => {
        const lines = [
          `### 第 ${recentReflexions.length - i} 次（${r.ts.slice(0, 16)}, verdict=${r.verdict}）`,
          r.hardFailures.length > 0 ? `- 硬失败：\n${r.hardFailures.map((f) => `  - ${f}`).join('\n')}` : '',
          r.softFailures.length > 0 ? `- 软失败：\n${r.softFailures.map((f) => `  - ${f}`).join('\n')}` : '',
          r.nextStrategy ? `- 上轮建议：${r.nextStrategy}` : '',
        ].filter(Boolean);
        return lines.join('\n');
      }).join('\n\n');

  const goal = `# KPI 卡点反思（meta-burst）

origin_user: ${kpi.createdBy}

## KPI
${kpi.description}

## 状态
- 已连续 ${kpi.consecutiveIdleBursts} 次 burst idle 且无产出
- 已派发 ${kpi.bursts.length} 个 burst
- 已记录 ${kpi.reflexionTrail.length} 条反思

## 历次反思摘要（最近 5 条）
${trailDigest}

## 你的任务
**不要再执行 KPI 本身**——这是一次 meta 反思 burst。
请评估：
1. 这个 KPI 是否已陷入"重复撞墙"模式？哪些方向已经死了？
2. 还有什么**手段层面未尝试**的方向？（社工 / 内部渠道 / 公开数据拼接 / 侧信道 / ...）
3. 这个 KPI 是否**根本不可达**？如果是，建议直接放弃，不要再耗资源。

请将分析结论写入 knowledge.md / constraints.md；burst 结束时会由 runReflexion 写入
.brain/reflexion.json 并进入 KPI reflexionTrail（见 kpi-reflexion-design.md）。

输出格式约束：保持原样输出 markdown，不要包 markdown 代码块。`;

  fs.writeFileSync(path.join(workDir, '.brain', 'goal.md'), goal, 'utf8');

  // 注册到 inner-brain registry
  const record: TaskRecord = {
    instanceId,
    workspaceId,
    workDir,
    goal,
    originUser: kpi.createdBy,
    originThread: undefined,
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    kpiId,
    isReflexionBurst: true,
  };
  innerBrainRegistry.register(record);
  kpiRegistry.attachBurst(kpiId, instanceId);

  const res = spawnAndAttachWorker(record);
  if (!res.ok) {
    innerBrainRegistry.update(instanceId, {
      status: 'ERROR',
      finishedAt: new Date().toISOString(),
      errorMessage: `反思 burst spawn 失败: ${res.error}`,
    });
    return null;
  }
  return instanceId;
}

/**
 * meta 反思 burst 结束后（且 UTLRA_KPI_AUTO_NEXT_BURST=1）自动派下一发**真任务** burst。
 * goal 注入 KPI 描述 + reflexionTrail，并重置 idle streak。
 */
function scheduleNextKpiBurst(kpiId: string): string | null {
  const kpi = kpiRegistry.get(kpiId);
  if (!kpi || kpi.status !== 'active') return null;

  const instanceId = innerBrainRegistry.generateInstanceId();
  const workspaceId = `task-${instanceId}`;
  const workDir = path.join(DATA_ROOT, 'workspaces', workspaceId);
  fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });

  const trailBlock = formatKpiReflexionBlock(kpiRegistry.recentReflexions(kpiId, 5));
  const goal =
    `# KPI 续跑（自动派发）\n\n` +
    `origin_user: ${kpi.createdBy}\n\n` +
    `## KPI\n${kpi.description}\n` +
    (trailBlock || '\n（暂无 reflexion trail，请根据 KPI 描述规划）\n');

  fs.writeFileSync(path.join(workDir, '.brain', 'goal.md'), goal, 'utf8');

  const record: TaskRecord = {
    instanceId,
    workspaceId,
    workDir,
    goal,
    originUser: kpi.createdBy,
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
    kpiId,
    isReflexionBurst: false,
  };
  innerBrainRegistry.register(record);
  kpiRegistry.attachBurst(kpiId, instanceId);
  kpiRegistry.resetIdle(kpiId);

  const res = spawnAndAttachWorker(record);
  if (!res.ok) {
    innerBrainRegistry.update(instanceId, {
      status: 'ERROR',
      finishedAt: new Date().toISOString(),
      errorMessage: `自动续跑 spawn 失败: ${res.error}`,
    });
    return null;
  }
  console.log(`[utlra][kpi] auto next burst ${instanceId} for ${kpiId}`);
  return instanceId;
}

/**
 * 进程启动时自动 resume 上次被中断的内脑任务。
 *
 * 触发条件：
 *   - registry 里有 status='RUNNING' 的任务（实际上 server 已重启，该子进程已死）
 *   - 任务的 resumeCount < UTLRA_INNER_MAX_AUTO_RESUME（默认 3）
 *   - UTLRA_INNER_AUTO_RESUME != '0'（默认开启）
 *
 * 不满足 resume 条件的任务仍会被 mark 为 STOPPED（保留中断状态记录）。
 */
function autoResumeStaleTasks(): void {
  const enabled = (process.env['UTLRA_INNER_AUTO_RESUME'] ?? '1') !== '0';
  const maxResumes = Math.max(0, Number(process.env['UTLRA_INNER_MAX_AUTO_RESUME'] ?? 3));

  const stale = innerBrainRegistry.markStaleRunningAsStopped();
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
      console.log(`[utlra][inner-brain]   - ${r.instanceId} (auto_resume 关闭) → 仅标记 STOPPED`);
    }
    return;
  }

  for (const r of stale) {
    const count = r.resumeCount ?? 0;
    if (count >= maxResumes) {
      const note = `已达自动 resume 上限 ${maxResumes}（防永动机），用户可手动 /restart`;
      innerBrainRegistry.update(r.instanceId, { errorMessage: `(server 重启，任务中断；${note})` });
      console.log(`[utlra][inner-brain]   - ${r.instanceId} 跳过：${note}`);
      continue;
    }
    const res = spawnAndAttachWorker(r, { incrementResumeCount: true });
    if (res.ok) {
      console.log(
        `[utlra][inner-brain]   - ${r.instanceId} auto-resumed (#${count + 1})  pid=${res.pid}`,
      );
    } else {
      console.error(`[utlra][inner-brain]   - ${r.instanceId} auto-resume 失败: ${res.error}`);
    }
  }
}

// 进程重启时，检测被中断的内脑任务并自动 resume（受 UTLRA_INNER_AUTO_RESUME 控制）
autoResumeStaleTasks();

const threadsPath = () => path.join(CHAT_DIR, 'threads.json');

function loadThreads(): { threads: unknown[]; messages: Record<string, unknown[]> } {
  if (!fs.existsSync(threadsPath())) return { threads: [], messages: {} };
  return JSON.parse(fs.readFileSync(threadsPath(), 'utf8')) as {
    threads: unknown[];
    messages: Record<string, unknown[]>;
  };
}

function saveThreads(data: { threads: unknown[]; messages: Record<string, unknown[]> }): void {
  fs.mkdirSync(CHAT_DIR, { recursive: true });
  fs.writeFileSync(threadsPath(), JSON.stringify(data, null, 2), 'utf8');
}

const app = new Hono();

app.use(
  '/*',
  cors({
    origin: [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:5174',
      'http://127.0.0.1:5174',
      'http://localhost:5175',
      'http://127.0.0.1:5175',
      // ops-console（KPI 面板需要跨 origin 调多个 agent 实例的 /api/kpis）
      'http://localhost:7777',
      'http://127.0.0.1:7777',
    ],
  }),
);

/** agent 进程存活。 */
registerHealthRoute(app, DATA_ROOT);
registerParticipationLabRoutes(app);

app.get('/api/workspaces', (c) => {
  if (!fs.existsSync(WORKSPACES)) return c.json({ workspaces: [] });
  const ids = fs
    .readdirSync(WORKSPACES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  return c.json({ workspaces: ids.length ? ids : ['default'] });
});

app.post('/api/workspaces/:id/init', (c) => {
  const id = c.req.param('id');
  store.ensureWorkspace(id);
  return c.json({ ok: true, workspaceId: id });
});

app.get('/api/workspaces/:id/manifest', (c) => {
  const id = c.req.param('id');
  store.ensureWorkspace(id);
  return c.json(store.readManifest(id));
});

app.get('/api/workspaces/:id/tree', (c) => {
  const id = c.req.param('id');
  store.ensureWorkspace(id);
  const sub = c.req.query('path') ?? '.run';
  return c.json({ entries: store.listRunTree(id, sub) });
});

app.get('/api/workspaces/:id/file', (c) => {
  const id = c.req.param('id');
  const rel = c.req.query('path');
  if (!rel) return c.json({ error: 'missing path' }, 400);
  const text = store.readTextFile(id, rel);
  if (text === null) return c.json({ error: 'not found' }, 404);
  return c.json({ path: rel, content: text });
});

/** 内脑 / Pi-mono 相关产出摘要：根目录报告、.run/pi-mono 树、工具输出抽样、当日日志跨度 */
app.get('/api/workspaces/:id/artifacts', (c) => {
  const id = c.req.param('id');
  return c.json(buildWorkspaceArtifactsPayload(id, store));
});

/**
 * 在系统文件管理器中打开 workspace 目录（本机开发用）。
 * 生产或共享环境请设置 UTLRA_DISABLE_WORKSPACE_REVEAL=1 关闭。
 */
app.post('/api/workspaces/:id/reveal', (c) => {
  if (!revealWorkspaceAllowed()) {
    return c.json({ ok: false, error: 'reveal disabled (UTLRA_DISABLE_WORKSPACE_REVEAL)' }, 403);
  }
  const id = c.req.param('id');
  store.ensureWorkspace(id);
  const wd = store.resolveWorkDir(id);
  if (!fs.existsSync(wd)) return c.json({ ok: false, error: 'workspace not found' }, 404);
  try {
    const platform = process.platform;
    if (platform === 'darwin') execFileSync('open', [wd], { stdio: 'ignore' });
    else if (platform === 'win32') execFileSync('explorer.exe', [wd], { stdio: 'ignore' });
    else execFileSync('xdg-open', [wd], { stdio: 'ignore' });
  } catch (e) {
    return c.json({ ok: false, error: String(e) }, 500);
  }
  return c.json({ ok: true, workDir: wd });
});

app.get('/api/inner/:ws/status', (c) => {
  const ws = c.req.param('ws');
  const eng = getEngine(ws);
  const st = eng.readStatus();
  return c.json({
    status: st ?? {
      schema: 'inner-status.v1',
      workspaceId: ws,
      phase: 'idle',
      goalSummary: '',
      tickCount: 0,
      lastAction: null,
      lastError: null,
      updatedAt: new Date().toISOString(),
    },
  });
});

app.post('/api/inner/:ws/goal', async (c) => {
  const ws = c.req.param('ws');
  const body = (await c.req.json()) as { goal?: string };
  if (!body.goal?.trim()) return c.json({ error: 'goal required' }, 400);
  const eng = getEngine(ws);
  eng.setGoal(body.goal);
  return c.json({ ok: true, status: eng.readStatus() });
});

/** Pi-mono 运行时内嵌于本包（`src/openkuroneko/`），无需并列 openKuroneko dist */
app.get('/api/inner/:ws/pi-mono', (c) => {
  void c.req.param('ws');
  return c.json({
    ready: true,
    dist: PI_MONO_RUNTIME_LABEL,
    hint: null as string | null,
  });
});

/**
 * openKuroneko Pi-mono：单次 `Controller.tick()`（一次「宏步」，见 README）。
 */
app.post('/api/inner/:ws/pi-tick', async (c) => {
  const ws = c.req.param('ws');
  store.ensureWorkspace(ws);
  const workDir = store.resolveWorkDir(ws);
  const eng = getEngine(ws);
  const r = await runOpenKuronekoPiMonoTick({ workspaceId: ws, workDir });
  if (!r.ok) {
    return c.json({ ok: false, error: r.error, dist: r.dist }, 503);
  }
  const status = eng.syncAfterPiMonoTick({ hadWork: r.hadWork });
  const suggestPromoteShutdown = suggestGoalCompleteForShutdown(workDir);
  return c.json({ ok: true, hadWork: r.hadWork, dist: r.dist, status, suggestPromoteShutdown });
});

/**
 * Pi-mono Auto：同一进程内连续 tick，直到 `hadWork=false` 或达到 maxTicks（一次 HTTP 请求跑完一整段「有活」）。
 * body: `{ maxTicks?: number }`，默认 `UTLRA_PI_AUTO_MAX_TICKS` 或 500。
 */
app.post('/api/inner/:ws/pi-auto', async (c) => {
  const ws = c.req.param('ws');
  const body = (await c.req.json().catch(() => ({}))) as { maxTicks?: number };
  const maxTicks =
    body.maxTicks ??
    Math.min(10_000, Math.max(1, Number(process.env['UTLRA_PI_AUTO_MAX_TICKS'] ?? 500)));
  store.ensureWorkspace(ws);
  const workDir = store.resolveWorkDir(ws);
  const eng = getEngine(ws);
  const r = await runOpenKuronekoPiMonoAuto({ workspaceId: ws, workDir, maxTicks });
  if (!r.ok) {
    return c.json({ ok: false, error: r.error, dist: r.dist, ticks: r.ticks }, 503);
  }
  const status = eng.syncAfterPiMonoAuto({
    ticks: r.ticks,
    lastHadWork: r.lastHadWork,
    stoppedBy: r.stoppedBy,
  });
  const suggestPromoteShutdown = suggestGoalCompleteForShutdown(workDir);
  return c.json({ ...r, status, suggestPromoteShutdown });
});

app.post('/api/inner/:ws/reset', (c) => {
  const ws = c.req.param('ws');
  store.ensureWorkspace(ws);
  const eng = getEngine(ws);
  const status = eng.fullResetForRetest();
  return c.json({ ok: true, status });
});

/** 关闭内脑：controller-state → SLEEPING（远期唤醒），删 execution-context */
app.post('/api/inner/:ws/brain-shutdown', (c) => {
  const ws = c.req.param('ws');
  store.ensureWorkspace(ws);
  const eng = getEngine(ws);
  const status = eng.brainShutdown();
  return c.json({ ok: true, status });
});

/**
 * 任务收尾：先把 manifest 中登记的 K/S/P/交付物 晋升到 Repository，再关闭内脑（SLEEPING）。
 * body: { tenant_id?: string, realm?: string }
 */
app.post('/api/inner/:ws/promote-and-shutdown', async (c) => {
  const ws = c.req.param('ws');
  const body = (await c.req.json().catch(() => ({}))) as {
    tenant_id?: string;
    realm?: string;
  };
  store.ensureWorkspace(ws);
  const eng = getEngine(ws);
  const r = runPromoteThenShutdown(repoStore, store, eng, ws, {
    tenantId: body.tenant_id,
    realm: body.realm,
  });
  return c.json({
    ok: true,
    promoted: r.promoted.added,
    skippedPaths: r.promoted.skipped,
    status: r.status,
  });
});

/** 清空知识：knowledge.md、skills.md、.brain/skills/*.md 置空 */
app.post('/api/inner/:ws/clear-knowledge', (c) => {
  const ws = c.req.param('ws');
  store.ensureWorkspace(ws);
  const eng = getEngine(ws);
  const { status, cleared } = eng.clearKnowledgeFiles();
  return c.json({ ok: true, status, cleared });
});

app.get('/api/inner/:ws/telemetry', (c) => {
  const ws = c.req.param('ws');
  const eng = getEngine(ws);
  const lines = eng.readTelemetryTail(80);
  return c.json({ lines });
});

/** 读取 .brain 快照 + execution-context 摘要 + 从 Pi-mono 日志提取最近归因等，供 Dashboard 对齐 Monitor */
app.get('/api/inner/:ws/brain-inspector', (c) => {
  const ws = c.req.param('ws');
  store.ensureWorkspace(ws);
  const wd = store.resolveWorkDir(ws);
  return c.json(buildBrainInspectorPayload(ws, store, wd));
});

/** Pi-mono 写入的 JSONL 日志（tempDir/logs），含 llm.call / tool.call 等事件 */
app.get('/api/inner/:ws/pi-logs', (c) => {
  const ws = c.req.param('ws');
  const limit = Math.min(400, Math.max(5, Number(c.req.query('limit') ?? 120)));
  const wd = store.resolveWorkDir(ws);
  const logsDir = path.join(wd, '.run', 'pi-mono', 'logs');

  if (!fs.existsSync(logsDir)) {
    return c.json({
      entries: [] as unknown[],
      source: null as string | null,
      hint: '尚无 Pi-mono 日志目录（运行至少一次 Pi-mono tick 后会出现）',
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  let filePath: string | null = path.join(logsDir, `${today}.jsonl`);
  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf8');
  } else {
    const files = fs
      .readdirSync(logsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .reverse();
    if (files[0]) {
      filePath = path.join(logsDir, files[0]!);
      content = fs.readFileSync(filePath, 'utf8');
    } else {
      filePath = null;
    }
  }

  const lines = content.trim().split('\n').filter(Boolean);
  const sliced = lines.slice(-limit);
  const entries = sliced.map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return { _raw: line, _parseError: true as const };
    }
  });

  return c.json({ entries, source: filePath, count: entries.length });
});

/** 当前 LLM 配置探测（不含 API Key） */
app.get('/api/llm/config', (c) => {
  const env = loadInnerLlmEnvFromProcess();
  if (!env) {
    return c.json({
      configured: false,
      hint: '在仓库根目录创建 .env，设置 ZHIPU_API_KEY 或 KIMI_API_KEY（勿提交 Git）',
    });
  }
  return c.json({
    configured: true,
    provider: env.provider,
    textModel: env.textModel,
    visionModel: env.visionModel,
    thinking: env.thinking,
    maxTokensText: env.maxTokensText,
    maxTokensMultimodal: env.maxTokensMultimodal,
    baseUrl: env.baseUrl,
  });
});

/**
 * 模型探针：对指定模型发一条简短请求，返回延迟、回复内容。
 * body: { model: string, prompt?: string, maxTokens?: number }
 */
app.post('/api/models/probe', async (c) => {
  const body = (await c.req.json()) as { model?: string; prompt?: string; maxTokens?: number };
  const model = (body.model ?? '').trim();
  if (!model) return c.json({ error: 'model is required' }, 400);

  const env = loadInnerLlmEnvFromProcess();
  if (!env) return c.json({ error: 'LLM API key not configured' }, 500);

  const prompt = body.prompt ?? '用一句话介绍你自己';
  const maxTokens = body.maxTokens ?? 2048;

  const startMs = Date.now();
  try {
    const { raw: data, status } = await llmRawChatCompletion<{
      choices?: Array<{ message?: { content?: string; reasoning_content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string; code?: string };
    }>({
      provider: env.provider,
      apiKey: env.apiKey,
      baseUrl: env.baseUrl,
      body: {
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        thinking: { type: env.thinking },
      },
    });
    const ms = Date.now() - startMs;

    const choice = data.choices?.[0];
    const rawContent: unknown = choice?.message?.content;
    let content = '';
    if (typeof rawContent === 'string') content = rawContent;
    else if (Array.isArray(rawContent)) content = (rawContent as Array<{ text?: string }>).map((p) => p.text ?? '').join('');

    // glm-z1 puts thinking inside <think>...</think> tags in content
    const thinkMatch = content.match(/^[\s\S]*?<\/think>\s*/);
    const cleanContent = thinkMatch ? content.slice(thinkMatch[0].length) : content;

    const reasoning = choice?.message?.reasoning_content ?? '';

    return c.json({
      model, ms, ok: true,
      httpStatus: status,
      finishReason: choice?.finish_reason,
      content: cleanContent.slice(0, 200),
      hasThinking: !!(reasoning || thinkMatch),
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
    });
  } catch (e) {
    return c.json({ model, ms: Date.now() - startMs, ok: false, error: String(e) }, 500);
  }
});

/**
 * 内脑 LLM step：无图走 textModel；有图走 visionModel。
 * body: { userHint?, imageBase64?, mimeType? }
 */
app.post('/api/inner/:ws/llm-step', async (c) => {
  const llmEnv = loadInnerLlmEnvFromProcess();
  if (!llmEnv) {
    return c.json(
      {
        error: 'LLM API Key 未配置',
        hint: '复制 .env.example 为 .env 并填入 ZHIPU_API_KEY 或 KIMI_API_KEY',
      },
      503,
    );
  }
  const ws = c.req.param('ws');
  const body = (await c.req.json()) as {
    userHint?: string;
    imageBase64?: string;
    mimeType?: string;
  };
  const eng = getEngine(ws);
  const goal = eng.readGoal();
  if (!goal.trim()) {
    return c.json({ error: '请先设置 Goal' }, 400);
  }
  try {
    const result = await runInnerLlmStep(llmEnv, {
      goalMarkdown: goal,
      userHint: body.userHint,
      imageBase64: body.imageBase64,
      imageMime: body.mimeType,
    });
    const status = eng.noteLlmRound({
      assistantText: result.assistantText,
      model: llmEnv.textModel,
      usedVision: result.usedVision,
      visionModel: result.usedVision ? llmEnv.visionModel : undefined,
      userHint: body.userHint,
    });
    return c.json({ ok: true, result, status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = eng.noteLlmError(msg);
    return c.json({ ok: false, error: msg, status }, 502);
  }
});

app.get('/api/identity/pack-demo', (c) => {
  const pack = registry.demoPack();
  return c.json({ pack, serialized: serializeIdentityPack(pack) });
});

app.get('/api/chat/threads', (c) => {
  const data = loadThreads();
  return c.json(data);
});

/** M5 RepositoryStore：会话提交（K/S/P 条目写入执行轨或交互轨索引） */
app.post('/api/repository/:tenant/commit', async (c) => {
  const tenant = c.req.param('tenant');
  const body = (await c.req.json()) as CommitSessionInput;
  if (!body.session_id?.trim() || !body.items?.length) {
    return c.json({ error: 'session_id and items required' }, 400);
  }
  const added = repoStore.commitSession(tenant, body);
  return c.json({ ok: true, added });
});

/** M5 检索：关键词粗排，rerank 接口由服务端后续接模型时扩展 */
app.post('/api/repository/:tenant/retrieve', async (c) => {
  const tenant = c.req.param('tenant');
  const body = (await c.req.json()) as RetrieveInput;
  if (!body.query?.trim()) return c.json({ error: 'query required' }, 400);
  const hits = repoStore.retrieve(tenant, body);
  return c.json({ ok: true, hits });
});

/** 知识库可视化：列举执行轨 / 交互轨索引条目 */
app.get('/api/repository/:tenant/records', (c) => {
  const tenant = c.req.param('tenant');
  const laneRaw = c.req.query('lane');
  const lane =
    laneRaw === 'execution' || laneRaw === 'interaction'
      ? laneRaw
      : undefined;
  const limit = Math.min(2000, Math.max(1, Number(c.req.query('limit') ?? 500)));
  const records = repoStore.listRecords(tenant, { lane, limit });
  return c.json({ ok: true, records });
});

/** 仅晋升：manifest → Repository（不关闭内脑） */
app.post('/api/repository/:tenant/promote-from-workspace/:ws', async (c) => {
  const tenant = c.req.param('tenant');
  const ws = c.req.param('ws');
  const body = (await c.req.json().catch(() => ({}))) as {
    realm?: string;
    session_id?: string;
  };
  store.ensureWorkspace(ws);
  const realm = body.realm?.trim() || `workspace:${ws}`;
  const sessionId = body.session_id?.trim() || `promote-${Date.now()}`;
  const pr = promoteWorkspaceManifestToRepository(repoStore, store, tenant, ws, {
    realm,
    sessionId,
    lane: 'execution',
  });
  return c.json({ ok: true, promoted: pr.added, skippedPaths: pr.skipped });
});

// ── 外脑记忆层 API ──────────────────────────────────────────────────────────

/** 读取外脑记忆（daily-log + tasks） */
app.get('/api/outer/memory', async (c) => {
  const store = globalMemoryStore;
  if (!store) return c.json({ dailyLog: '', tasks: '' });
  const [dailyLog, tasks] = await Promise.all([
    store.readChatLog(200),
    Promise.resolve(store.readTasksRaw()),
  ]);
  return c.json({ dailyLog, tasks, mem9Enabled: !!store.mem9 });
});

/** 更新任务状态（覆写 tasks.md） */
app.post('/api/outer/memory/tasks', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { tasks_markdown?: string };
  const content = body.tasks_markdown?.trim() ?? '';
  if (!content) return c.json({ error: 'tasks_markdown required' }, 400);
  if (globalMemoryStore) globalMemoryStore.writeTasks(content);
  return c.json({ ok: true });
});

/** Memory Block 列表（Dashboard / 运维只读；secret 块不返回 entry 明文） */
app.get('/api/memory/blocks', async (c) => {
  const store = globalMemoryBlockStore;
  if (!store) return c.json({ ok: true, blocks: [] });
  const blocks = store.listBlocks();
  const enriched = await Promise.all(
    blocks.map(async (b) => ({
      ...b,
      entry_count: (await store.listEntryKeys(b.blockId).catch(() => [])).length,
    })),
  );
  return c.json({ ok: true, blocks: enriched });
});

/** 某块的 entry 列表（metadata；keychain 无 value） */
app.get('/api/memory/blocks/:blockId/entries', async (c) => {
  const store = globalMemoryBlockStore;
  if (!store) return c.json({ ok: true, entries: [] });
  const blockId = c.req.param('blockId');
  try {
    const keys = await store.listEntryKeys(blockId);
    const entries = await Promise.all(
      keys.map(async (key) => {
        const meta = await store.get(blockId, key);
        return { key, meta };
      }),
    );
    return c.json({ ok: true, block_id: blockId, entries });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

app.get('/api/performance/goals', (c) => {
  const includeArchived = c.req.query('includeArchived') === 'true';
  return c.json({
    ok: true,
    goals: performanceGoalEngine.listGoalStates({ includeArchived }),
  });
});

app.get('/api/performance/goals/dashboard', (c) => {
  const includeArchived = c.req.query('includeArchived') === 'true';
  return c.json({
    ok: true,
    dashboard: performanceGoalEngine.getDashboardSnapshot({ includeArchived }),
  });
});

app.post('/api/performance/goals', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    title?: string;
    goalText?: string;
    type?: 'relationship_goal';
    targetSids?: string[];
    targetThreadId?: string;
    priority?: number;
    reviewIntervalMs?: number;
    minActionCooldownMs?: number;
    metadata?: Record<string, unknown>;
  };
  const goalText = body.goalText?.trim() ?? '';
  if (!goalText) return c.json({ error: 'goalText required' }, 400);
  const goal = performanceGoalEngine.createGoal({
    title: body.title,
    goalText,
    type: body.type,
    targetSids: Array.isArray(body.targetSids) ? body.targetSids : [],
    targetThreadId: body.targetThreadId,
    priority: body.priority,
    reviewIntervalMs: body.reviewIntervalMs,
    minActionCooldownMs: body.minActionCooldownMs,
    metadata: body.metadata,
  });
  return c.json({ ok: true, goal });
});

app.patch('/api/performance/goals/:goalId', async (c) => {
  const goalId = c.req.param('goalId');
  const body = (await c.req.json().catch(() => ({}))) as {
    title?: string;
    goalText?: string;
    targetSids?: string[];
    targetThreadId?: string | null;
    status?: 'active' | 'paused' | 'completed' | 'archived';
    priority?: number;
    reviewIntervalMs?: number;
    minActionCooldownMs?: number;
    metadata?: Record<string, unknown>;
  };
  const goal = performanceGoalEngine.updateGoal(goalId, {
    title: body.title,
    goalText: body.goalText,
    targetSids: Array.isArray(body.targetSids) ? body.targetSids : undefined,
    targetThreadId: body.targetThreadId,
    status: body.status,
    priority: body.priority,
    reviewIntervalMs: body.reviewIntervalMs,
    minActionCooldownMs: body.minActionCooldownMs,
    metadata: body.metadata,
  });
  if (!goal) return c.json({ error: 'goal not found' }, 404);
  return c.json({ ok: true, goal });
});

app.delete('/api/performance/goals/:goalId', (c) => {
  const goalId = c.req.param('goalId');
  const deleted = performanceGoalEngine.deleteGoal(goalId);
  if (!deleted) return c.json({ error: 'goal not found' }, 404);
  return c.json({ ok: true, goalId });
});

app.get('/performance/goals', (c) => {
  return c.html(renderPerformanceDashboard(performanceGoalEngine));
});

/** M6：只读观察内脑 status.json（与子进程写入共享 workspace） */
app.get('/api/outer/inner-status/:ws', (c) => {
  const ws = c.req.param('ws');
  store.ensureWorkspace(ws);
  const eng = getEngine(ws);
  return c.json({ status: eng.readStatus() });
});

/**
 * M6 外脑 roundtrip：追加 thread 消息 → 设 Goal → 子进程 Pi-mono Auto → 拼 StructuredReply。
 * burst 结束后可按 **正式规则** 自动晋升并关闭内脑，见 `doc/inner-outer-protocol.md`。
 *
 * body: {
 *   text?, parts?, thread_id?, workspace_id?, sender_sid（必填：渠道解析后的发送者 sid）, max_ticks?,
 *   after_burst?, tenant_id?, realm?,
 *   history_limit? (0=关闭), history_max_chars?,
 *   enrich_goal_vision? (true/false，默认读 UTLRA_GOAL_VISION_ENRICH),
 *   outer_llm_reply? (true/false，默认读 UTLRA_OUTER_REPLY_LLM),
 *   thread_kind?: 'dm' | 'group'（默认 dm；群聊需配合 is_mention / 参与决策），
 *   is_mention?: boolean（群聊是否 @ 本 agent；省略时 dm=true、group=false）,
 *   mentions_others?: boolean（是否 @ 他人）,
 *   skip_participation_check?: boolean,
 *   run_inner?: boolean（是否跑内脑 burst；默认读 UTLRA_OUTER_RUN_INNER，未设则为 true）
 *   user_message_persisted?: boolean（IM 已写入本条时可 true，与 text/parts 二选一）
 * }
 * `text` 与 `parts`（`message.v1` 的 MessagePart[]）至少其一；若同时提供，将 **text 作为首段 text part** 再接 `parts`。
 * `user_message_persisted: true` 时可不传 text/parts（以线程最后一条为准）。
 * 图片可用 `attachment` + `data:image/...;base64,...` URI，会落盘到 workspace `.run/outer-task-media/` 并写入 goal.md。
 * **线程历史**：将本 thread 已落库消息（不含本轮）经 `serializeMessageForLlm` 拼入 goal 前缀，见 `UTLRA_OUTER_THREAD_HISTORY_*`。
 * 环境变量 `UTLRA_OUTER_AFTER_BURST=promote_and_shutdown_if_complete` 与 `after_burst: 'inherit'` 等价。
 */
app.post('/api/outer/roundtrip', async (c) => {
  const body = (await c.req.json()) as {
    text?: string;
    parts?: unknown[];
    thread_id?: string;
    workspace_id?: string;
    sender_sid?: string;
    max_ticks?: number;
    after_burst?: 'inherit' | 'none' | 'promote_and_shutdown_if_complete';
    tenant_id?: string;
    realm?: string;
    history_limit?: number;
    history_max_chars?: number;
    enrich_goal_vision?: boolean;
    outer_llm_reply?: boolean;
    thread_kind?: 'dm' | 'group';
    is_mention?: boolean;
    mentions_others?: boolean;
    skip_participation_check?: boolean;
    run_inner?: boolean;
    user_message_persisted?: boolean;
  };
  const userPersisted = body.user_message_persisted === true;
  const hasText = !!body.text?.trim();
  const hasParts = Array.isArray(body.parts) && body.parts.length > 0;
  if (!userPersisted && !hasText && !hasParts) {
    return c.json({ error: 'text or parts required' }, 400);
  }

  let messageParts: MessagePart[] | undefined;
  if (!userPersisted && hasParts) {
    const parsed = body.parts!.map((x) => MessagePartSchema.parse(x));
    messageParts = hasText ? [{ type: 'text', text: body.text!.trim() }, ...parsed] : parsed;
  }

  const threadId = body.thread_id ?? 'thread:outer';
  const workspaceId = body.workspace_id ?? 'default';
  const senderSid = body.sender_sid?.trim();
  if (!senderSid) {
    return c.json(
      {
        error: 'sender_sid required',
        hint: '本条消息的发送者 sid（渠道解析后的真实角色）；预置身份仅含本数字员工，请传入对方或 upsert 后的 sid',
      },
      400,
    );
  }
  try {
    const result = await runOuterRoundtrip(
      {
        dataRoot: DATA_ROOT,
        registry,
        getEngine,
        loadThreads,
        saveThreads,
        workspaceStore: store,
        repoStore,
        assetStore,
      },
      {
        threadId,
        userText: userPersisted ? undefined : messageParts ? undefined : body.text!.trim(),
        messageParts: userPersisted ? undefined : messageParts,
        workspaceId,
        senderSid,
        maxTicks: body.max_ticks,
        afterBurst: body.after_burst,
        tenantId: body.tenant_id,
        realm: body.realm,
        historyLimit: body.history_limit,
        historyMaxChars: body.history_max_chars,
        enrichGoalVision:
          body.enrich_goal_vision === undefined ? 'inherit' : body.enrich_goal_vision,
        outerLlmReply: body.outer_llm_reply === undefined ? 'inherit' : body.outer_llm_reply,
        threadKind: body.thread_kind,
        isMentionAgent: body.is_mention,
        mentionsOthers: body.mentions_others,
        skipParticipationCheck: body.skip_participation_check,
        runInner: body.run_inner === undefined ? 'inherit' : body.run_inner,
        userMessagePersisted: userPersisted,
      },
    );
    return c.json({ ok: true, ...result });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/**
 * 外脑正式关闭内脑（与 `/api/inner/:ws/brain-shutdown` 行为一致，但命名空间归属外脑编排）。
 * body: { promote_manifest?: boolean, tenant_id?, realm? }
 * - `promote_manifest: true`：先 manifest→Repository，再 SLEEPING（与 promote-and-shutdown 相同）
 * - 省略或 `false`：仅 SLEEPING，不晋升
 */
app.post('/api/outer/workspace/:ws/shutdown', async (c) => {
  const ws = c.req.param('ws');
  const body = (await c.req.json().catch(() => ({}))) as {
    promote_manifest?: boolean;
    tenant_id?: string;
    realm?: string;
  };
  store.ensureWorkspace(ws);
  const eng = getEngine(ws);
  if (body.promote_manifest) {
    const r = runPromoteThenShutdown(repoStore, store, eng, ws, {
      tenantId: body.tenant_id,
      realm: body.realm,
    });
    return c.json({
      ok: true,
      mode: 'promote_then_sleep' as const,
      promoted: r.promoted.added,
      skippedPaths: r.promoted.skipped,
      status: r.status,
    });
  }
  const status = eng.brainShutdown();
  return c.json({ ok: true, mode: 'sleep_only' as const, status });
});

// ── 多内脑实例管理 API ──────────────────────────────────────────────────────

/** 列出所有内脑任务实例 */
app.get('/api/inner-brains', (c) => {
  const all = innerBrainRegistry.list();
  const now = Date.now();
  // RUNNING 任务超过此毫秒数没有 tick 则标记为"可能卡住"
  const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 分钟

  const result = all.map((r) => {
    // 读取 workspace 运行时状态
    let phase: string | null = null;
    let lastAction: string | null = null;
    let tickCount: number | null = null;
    try {
      const st = getEngine(r.workspaceId).readStatus();
      phase = st?.phase ?? null;
      lastAction = st?.lastAction ?? null;
      tickCount = st?.tickCount ?? null;
    } catch { /* workspace 可能还未初始化 */ }

    // 从 worker 状态文件获取实时进度（比注册表更新鲜）
    const workerStatus = r.status === 'RUNNING' ? readWorkerStatus(r.workDir) : null;
    const lastTickAt = workerStatus?.lastTickAt ?? r.lastTickAt ?? null;
    const liveTicks = workerStatus?.ticks ?? r.ticks ?? null;
    const workerPhase = workerStatus?.phase ?? null;

    // pid 存活检测（仅对 RUNNING 有意义）
    const pidAlive = (r.status === 'RUNNING' && r.pid != null) ? isPidAlive(r.pid) : null;

    // 计算 liveness
    let liveness: 'active' | 'stuck' | 'dead' | null = null;
    if (r.status === 'RUNNING') {
      if (pidAlive === false) {
        // 子进程已死但注册表还是 RUNNING（异常状态，exit handler 未触发）
        liveness = 'dead';
      } else {
        const anchor = lastTickAt ?? r.startedAt;
        const sinceAnchor = now - new Date(anchor).getTime();
        liveness = sinceAnchor > STUCK_THRESHOLD_MS ? 'stuck' : 'active';
      }
    }

    return {
      instance_id:     r.instanceId,
      workspace_id:    r.workspaceId,
      registry_status: r.status,
      liveness,
      pid:             r.pid ?? null,
      pid_alive:       pidAlive,
      worker_phase:    workerPhase,
      last_tick_at:    lastTickAt,
      phase,
      lastAction,
      tickCount,
      goal:            r.goal.slice(0, 200),
      origin_user:     r.originUser,
      origin_thread:   r.originThread ?? null,
      started_at:      r.startedAt,
      finished_at:     r.finishedAt ?? null,
      ticks:           liveTicks,
      error:           r.errorMessage ?? null,
    };
  });
  return c.json({ instances: result });
});

/** 查询指定实例详情 */
app.get('/api/inner-brains/:id', (c) => {
  const id = c.req.param('id');
  const record = innerBrainRegistry.get(id);
  if (!record) return c.json({ error: `实例 ${id} 不存在` }, 404);

  let status = null;
  try { status = getEngine(record.workspaceId).readStatus(); } catch { /* */ }

  return c.json({ ...record, runtimeStatus: status });
});

/** 停止指定实例 */
app.post('/api/inner-brains/:id/stop', (c) => {
  const id = c.req.param('id');
  const record = innerBrainRegistry.get(id);
  if (!record) return c.json({ error: `实例 ${id} 不存在` }, 404);
  const res = stopInnerBrainInstance(record, innerBrainRegistry);
  if (!res.ok) {
    return c.json({ ok: false, message: res.message }, 400);
  }

  console.log(`[utlra][stop-inner-brain] api ${id} prior=${res.priorStatus} actions=${res.actions.join(',')}`);
  return c.json({
    ok: true,
    message: `已停止实例 ${id}（原状态 ${res.priorStatus}）`,
    actions: res.actions,
  });
});

/**
 * 重启指定实例 — 利用 Pi-mono 的磁盘持久化特性，从上一次成功 tick 后继续。
 * 只有非 RUNNING 状态的实例可以重启。
 */
app.post('/api/inner-brains/:id/restart', async (c) => {
  const id = c.req.param('id');
  const record = innerBrainRegistry.get(id);
  if (!record) return c.json({ error: `实例 ${id} 不存在` }, 404);
  if (record.status === 'RUNNING') {
    return c.json({ error: `实例 ${id} 正在运行中，无需重启` }, 409);
  }

  // 手动 restart 不算 auto-resume，不增加 resumeCount
  const res = spawnAndAttachWorker(record, { incrementResumeCount: false });
  if (!res.ok) return c.json({ error: `重启失败: ${res.error}` }, 500);

  console.log(`[utlra] inner brain restarted (manual): ${id} pid=${res.pid}`);
  return c.json({ ok: true, message: `实例 ${id} 已重启`, pid: res.pid });
});

// ── KPI 注册表 API ────────────────────────────────────────────────────────────
//
// KPI 是长期挂着的"用一切手段达成"型目标。同一 KPI 的多个 burst 共享反思 / 失败记忆，
// 由 progress detector 在 idle streak 达阈值时自动派发反思 burst。
//
// 设计取向：
//   - 这套 API 仅做注册表 CRUD，**不自动派发主任务 burst**。需要主任务时仍走外脑
//     set_goal 工具（它会把 kpiId 透传给 inner-brain registry）。
//   - 反思 burst 是例外，由 progress detector 在内部自动触发，不暴露在 API 表面。

app.get('/api/kpis', (c) => {
  const status = c.req.query('status') as 'active' | 'paused' | 'achieved' | 'abandoned' | undefined;
  const kpis = kpiRegistry.list(status ? { status } : undefined);
  return c.json({ kpis });
});

app.get('/api/kpis/:id', (c) => {
  const k = kpiRegistry.get(c.req.param('id'));
  if (!k) return c.json({ error: 'KPI 不存在' }, 404);
  // 附带相关的 inner-brain bursts 详情，方便 UI 一次展示反思链
  const bursts = k.bursts
    .map((bid) => innerBrainRegistry.get(bid))
    .filter((b): b is NonNullable<typeof b> => b !== undefined);
  return c.json({ kpi: k, bursts });
});

app.post('/api/kpis', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    description?: string;
    createdBy?: string;
    notes?: string;
  };
  const description = (body.description ?? '').trim();
  if (!description) return c.json({ error: 'description 必填' }, 400);
  const createdBy = (body.createdBy ?? '').trim() || 'agent:self';
  const kpi = kpiRegistry.create({ description, createdBy, notes: body.notes });
  return c.json({ kpi }, 201);
});

app.post('/api/kpis/:id/abandon', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
  const k = kpiRegistry.get(c.req.param('id'));
  if (!k) return c.json({ error: 'KPI 不存在' }, 404);
  kpiRegistry.abandon(k.kpiId, body.reason);
  return c.json({ ok: true, kpi: kpiRegistry.get(k.kpiId) });
});

app.post('/api/kpis/:id/achieve', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { evidence?: string };
  const k = kpiRegistry.get(c.req.param('id'));
  if (!k) return c.json({ error: 'KPI 不存在' }, 404);
  kpiRegistry.markAchieved(k.kpiId, body.evidence);
  return c.json({ ok: true, kpi: kpiRegistry.get(k.kpiId) });
});

app.post('/api/kpis/:id/pause', (c) => {
  const k = kpiRegistry.get(c.req.param('id'));
  if (!k) return c.json({ error: 'KPI 不存在' }, 404);
  kpiRegistry.pause(k.kpiId);
  return c.json({ ok: true, kpi: kpiRegistry.get(k.kpiId) });
});

app.post('/api/kpis/:id/resume', (c) => {
  const k = kpiRegistry.get(c.req.param('id'));
  if (!k) return c.json({ error: 'KPI 不存在' }, 404);
  kpiRegistry.resume(k.kpiId);
  return c.json({ ok: true, kpi: kpiRegistry.get(k.kpiId) });
});

/**
 * 手动触发一次反思 burst（不等 progress detector 阈值）。
 * 给 ops-console "调试" 按钮用：怀疑 KPI 跑偏时立刻派一个 meta 反思 burst。
 */
app.post('/api/kpis/:id/reflect', (c) => {
  const k = kpiRegistry.get(c.req.param('id'));
  if (!k) return c.json({ error: 'KPI 不存在' }, 404);
  if (k.status !== 'active') return c.json({ error: `KPI 状态为 ${k.status}，不可反思` }, 409);
  const instanceId = scheduleReflexionBurst(k.kpiId);
  if (!instanceId) return c.json({ error: '反思 burst 派发失败' }, 500);
  return c.json({ ok: true, reflexionBurstId: instanceId });
});

app.post('/api/chat/demo-roundtrip', async (c) => {
  const body = (await c.req.json()) as {
    text?: string;
    thread_id?: string;
    sender_sid?: string;
    reply_parts?: unknown[];
    mention_sids?: string[];
  };
  const threadId = body.thread_id ?? 'thread:demo';
  const demoSender = body.sender_sid?.trim() ?? resolvePrimaryAgentSid();
  const data = loadThreads();
  ensureThreadShell(data, threadId, [demoSender]);
  const userMsg = MessageRecordSchema.parse({
    schema: 'message.v1',
    message_id: `msg:${Date.now()}`,
    thread_id: threadId,
    sender_sid: demoSender,
    sent_at: new Date().toISOString(),
    parts: [{ type: 'text', text: body.text ?? 'hello' }],
  });
  const list = data.messages[threadId] ?? [];
  list.push(userMsg);
  data.messages[threadId] = list;
  saveThreads(data);

  const user = registry.get(demoSender);
  const serialized = serializeMessageForLlm(
    userMsg,
    user?.display_name ?? 'user',
    user?.kind ?? 'human',
  );
  const replyParts =
    body.reply_parts?.length && Array.isArray(body.reply_parts)
      ? body.reply_parts.map((x) => MessagePartSchema.parse(x))
      : undefined;
  const reply = StructuredReplySchema.parse({
    schema: 'reply.v1',
    thread_id: threadId,
    text: `echo: ${body.text ?? 'hello'}`,
    mention_sids: body.mention_sids ?? [],
    parts: replyParts,
  });
  const allowed = new Set(registry.list().map((x) => x.sid));
  const v = validateReplyMentions(reply, allowed);
  if (!v.ok) return c.json({ error: v.error }, 400);
  const mock = renderMockChannel(reply);
  return c.json({ serializedUserMessage: serialized, reply, mock });
});

export { app, DATA_ROOT, REPO_ROOT };

const port = Number(process.env['PORT'] ?? 8787);
const AGENT_EXIT_LOG = path.join(DATA_ROOT, 'agent-process.log');

function appendAgentExitLog(event: string, detail?: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      port,
      agent: process.env['UTLRA_AGENT_NAME'] ?? process.env['UTLRA_AGENT_IM_SID'] ?? 'unknown',
      event,
      ...detail,
    });
    fs.appendFileSync(AGENT_EXIT_LOG, `${line}\n`, 'utf8');
  } catch {
    /* best-effort */
  }
}

if (process.env['UTLRA_SKIP_AGENT_BOOTSTRAP'] === '1') {
  console.log(`[utlra] bootstrap skipped (UTLRA_SKIP_AGENT_BOOTSTRAP=1)  DATA_ROOT=${DATA_ROOT}`);
} else {
  type AgentRuntime = {
    pushLoop: PushLoop;
    changeWatcher: ChangeWatcher;
    heartbeat: OuterHeartbeat;
    channel: ChatIRChannel;
    stopRegistryReconcile?: () => void;
  };

  let agentRuntime: AgentRuntime | null = null;
  let shuttingDown = false;

  const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[utlra] API http://localhost:${info.port}  DATA_ROOT=${DATA_ROOT}`);

  const agentSid = process.env['UTLRA_AGENT_IM_SID']?.trim() || resolvePrimaryAgentSid();

  // forward ref：channel 入站 callback 触发时 outerBrain 已就绪
  let outerBrain: OuterBrain | null = null;
  const onAgentMessage = async (ev: ChatIRInboundEvent): Promise<void> => {
    if (!outerBrain) return;
    try {
      await outerBrain.handleInbound(ev);
    } catch (e) {
      console.error('[utlra] outer-brain handleInbound failed', e);
    }
  };

  // 消息观察 tracker：进程内单例，同时注入给 channel（写）与 OuterBrain（读）。
  // 跟 channel 实现解耦——任何 channel 都用同一份。
  const seenTracker = new ChatIRSeenTracker({
    selfAgentSid: agentSid,
    identityRegistry: registry,
  });

  // Chat IR channel：由 UTLRA_CHAT_CHANNEL 显式选择（**不再**根据 token/api-base 是否存在隐式判断）。
  //
  //   UTLRA_CHAT_CHANNEL=discord  → DiscordChannel；DISCORD_BOT_TOKEN 必须配齐
  //   UTLRA_CHAT_CHANNEL=webchat  → WebChatChannel；WEBCHAT_API_BASE 必须配齐
  //   UTLRA_CHAT_CHANNEL=none     → NullChatIRChannel（默认值；仅 HTTP /api/outer/roundtrip 可用）
  //
  // 设计原因：让 .env 可以**同时保留**所有 adapter 的配置，切换只需改一个开关，不必注释/解注释一大堆。
  // 因此本入口装配处不再做"两套配置同时存在 → 互斥报错"的处理；未选中的 adapter 即使配置齐全也会被忽略。
  const rawChannelKind = (process.env['UTLRA_CHAT_CHANNEL'] ?? 'none').trim().toLowerCase();
  const channelKind: 'discord' | 'webchat' | 'none' = (() => {
    if (rawChannelKind === '' || rawChannelKind === 'none' || rawChannelKind === 'null' || rawChannelKind === 'disabled') {
      return 'none';
    }
    if (rawChannelKind === 'discord' || rawChannelKind === 'webchat') return rawChannelKind;
    console.error(
      `[utlra] UTLRA_CHAT_CHANNEL=${JSON.stringify(rawChannelKind)} 非法；允许：discord | webchat | none。启动失败`,
    );
    process.exit(1);
  })();

  let channel: ChatIRChannel;
  let channelLabel: string;
  if (channelKind === 'discord') {
    const discordCfg = loadDiscordBridgeConfig();
    if (!discordCfg) {
      console.error(
        '[utlra] UTLRA_CHAT_CHANNEL=discord 但 Discord bridge 必填配置缺失（DISCORD_BOT_TOKEN）。启动失败',
      );
      process.exit(1);
    }
    channel = new DiscordChannel({
      config: discordCfg,
      agentSid,
      dataRoot: DATA_ROOT,
      registry,
      assetStore,
      loadThreads,
      saveThreads,
      seenTracker,
      onAgentMessage,
    });
    channelLabel = 'discord';
  } else if (channelKind === 'webchat') {
    const webchatCfg = loadWebChatBridgeConfig();
    if (!webchatCfg) {
      console.error(
        '[utlra] UTLRA_CHAT_CHANNEL=webchat 但 WebChat bridge 必填配置缺失（WEBCHAT_API_BASE）。启动失败',
      );
      process.exit(1);
    }
    channel = new WebChatChannel({
      config: webchatCfg,
      agentSid,
      dataRoot: DATA_ROOT,
      registry,
      assetStore,
      loadThreads,
      saveThreads,
      seenTracker,
      onAgentMessage,
    });
    channelLabel = 'webchat';
  } else {
    channel = new NullChatIRChannel();
    channelLabel = 'null';
    console.log(
      '[utlra] UTLRA_CHAT_CHANNEL=none（默认）；channel=NullChatIRChannel，HTTP /api/outer/roundtrip 仍可用。如需 Discord/WebChat 请设置 UTLRA_CHAT_CHANNEL=discord 或 webchat',
    );
  }

  const memoryStore = createMemoryStore(DATA_ROOT, agentSid);
  globalMemoryStore = memoryStore;
  void memoryStore.init();

  const memoryBlockStore = createMemoryBlockStore(DATA_ROOT, agentSid);
  globalMemoryBlockStore = memoryBlockStore;

  let skillStore: SkillMemoryStore | undefined;
  let skillDrive9Store: SkillDrive9Store | undefined;
  let knowledgeDrive9Store: KnowledgeDrive9Store | undefined;

  const drive9Config = resolveDrive9Config();
  if (drive9Config) {
    skillDrive9Store = initSkillDrive9Store(drive9Config.apiKey, drive9Config.apiUrl);
    knowledgeDrive9Store = initKnowledgeDrive9Store() ?? undefined;
    const sourceNote = drive9Config.source === 'env'
      ? 'DRIVE9_* env'
      : `drive9 ctx (${drive9Config.contextName ?? 'current'})`;
    console.log(`[utlra] SkillDrive9Store 已初始化 → drive9 /skills/shared/ via ${sourceNote}`);
    console.log(`[utlra] KnowledgeDrive9Store 已初始化 → drive9 /knowledge/shared/ via ${sourceNote}`);
  } else {
    const mem9ApiKey = process.env['MEM9_API_KEY'];
    if (mem9ApiKey) {
      skillStore = initSkillMemoryStore(new Mem9Client({ apiKey: mem9ApiKey }));
      console.log(`[utlra] SkillMemoryStore 已初始化 → mem9 shared:skills（降级）`);
    } else {
      console.log(`[utlra] DRIVE9_API_KEY 未设置，技能搜索降级为本地关键词匹配`);
    }
  }

  completionNotifyDeps = {
    imClient: channel,
    agentSid,
    assetStore,
    getEngine,
  };

  outerBrain = new OuterBrain({
    imClient: channel,
    seenTracker,
    assetStore,
    registry,
    getEngine,
    workspaceStore: store,
    repoStore,
    loadThreads,
    dataRoot: DATA_ROOT,
    repoRoot: REPO_ROOT,
    innerBrainRegistry,
    kpiRegistry,
    scheduleReflexionBurst,
    scheduleNextKpiBurst,
    memoryStore,
    memoryBlockStore,
    skillStore,
    skillDrive9Store,
    knowledgeDrive9Store,
  });

  // Push Loop：轮询内脑输出，主动推送 BLOCK/COMPLETE/PROGRESS 事件
  const pushLoop = new PushLoop({
    registry: innerBrainRegistry,
    imClient: channel,
    agentSid,
  });
  pushLoop.start();

  // ChangeWatcher：数据驱动的 agent 引擎——
  // 监听 AWAITING 任务的 pendings.json,触发 timer / deadline / IM 信号 → spawn 新 burst
  registryLifecycleReconcile(innerBrainRegistry);
  const reconcileIntervalMs = Number(process.env['UTLRA_REGISTRY_RECONCILE_INTERVAL_MS'] ?? 60_000);
  const stopRegistryReconcile = startRegistryLifecycleReconcileInterval(innerBrainRegistry, {
    intervalMs: reconcileIntervalMs,
  });
  if (reconcileIntervalMs > 0) {
    console.log(`[utlra][registry-reconcile] periodic every ${reconcileIntervalMs}ms`);
  }
  const changeWatcher = createChangeWatcher({
    registry: innerBrainRegistry,
    spawnTask: (task) => spawnAndAttachWorker(task, { incrementResumeCount: false }),
    reconcileOnBootstrap: () => {
      registryLifecycleReconcile(innerBrainRegistry);
    },
  });
  changeWatcher.start();

  // 外脑心跳：定时自主规划，可主动通过 channel 发消息 / 创建内脑任务
  const heartbeat = new OuterHeartbeat({
    getEngine,
    workspaceStore: store,
    repoStore,
    dataRoot: DATA_ROOT,
    repoRoot: REPO_ROOT,
    getLlmEnv: loadInnerLlmEnvFromProcess,
    imClient: channel,
    assetStore,
    memoryStore,
    outerBrain,
    innerBrainRegistry,
    kpiRegistry,
    scheduleReflexionBurst,
    scheduleNextKpiBurst,
    getOrchestratorStats: () => outerBrain.getOrchestratorStats(),
    config: loadHeartbeatConfigFromEnv(),
  });
  heartbeat.start();

  channel.start();

  agentRuntime = { pushLoop, changeWatcher, heartbeat, channel, stopRegistryReconcile };

  console.log(
    `[utlra] === Agent 就绪 ===  port=${info.port}  sid=${agentSid}  channel=${channelLabel}  workspace=${process.env['UTLRA_OUTER_WORKSPACE_ID'] ?? 'default'}`,
  );
});

  function gracefulShutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    appendAgentExitLog('graceful_shutdown', { signal });
    console.log(`[utlra] ${signal} → graceful shutdown`);
    try {
      agentRuntime?.stopRegistryReconcile?.();
      agentRuntime?.pushLoop.stop();
      agentRuntime?.changeWatcher.stop();
      agentRuntime?.heartbeat.stop();
      agentRuntime?.channel.destroy();
    } catch (e) {
      console.error('[utlra] shutdown hook error', e);
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  }

  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.once('SIGINT', () => gracefulShutdown('SIGINT'));

  process.on('exit', (code) => {
    appendAgentExitLog('process_exit', { code, graceful: shuttingDown });
    if (code !== 0) {
      console.error(`[utlra] process exit code=${code} (see ${AGENT_EXIT_LOG})`);
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[utlra] 端口 ${port} 已被占用。可执行: lsof -nP -iTCP:${port} -sTCP:LISTEN  或换端口: PORT=8788 npm run dev`,
      );
      appendAgentExitLog('listen_error', { code: err.code, message: `port ${port} in use` });
    } else {
      console.error('[utlra] listen error:', err);
      appendAgentExitLog('listen_error', { code: err.code, message: err.message });
    }
    process.exit(1);
  });
}
