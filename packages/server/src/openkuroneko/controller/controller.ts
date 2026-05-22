/**
 * Pi-mono 演化循环控制器
 *
 * 在三种思维模式之间切换：
 *   DECOMPOSE  → 战术拆解（Decomposer）
 *   EXECUTE    → 反应执行（Executor）
 *   ATTRIBUTE  → 强制归因（Attributor）
 *   BLOCKED    → 等待外脑介入
 *
 * 每次 tick() 执行一个完整阶段，返回 hadWork 供调度器决定退避。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { LLMAdapter } from '../adapter/index.js';
import type { IORegistry } from '../io/index.js';
import type { ToolRegistry } from '../tools/index.js';
import type { MemoryLayer2 } from '../memory/index.js';
import type { Mem0Client } from '../mem0/index.js';
import type { Logger } from '../logger/index.js';
import { BrainFS } from '../brain/index.js';
import type { Milestone, ControllerState } from '../brain/index.js';
import { runDecomposer } from './decomposer.js';
import { runExecutor } from './executor.js';
import { runAttributor } from './attributor.js';
import { resolveBlock } from './block-resolver.js';
import { captureSnapshot } from './snapshot.js';
import type { KnowledgeStore } from '../archive/index.js';
import { readPendingGaps } from '../tools/definitions/capability-gap.js';
import {
  buildCompletionReport,
  pickDeliverableExcerpt,
  shortenMilestonesForReport,
} from './completion-report.js';
import { getSelfUpdatePromptContext } from '../../self-update/session.js';
import { runReflexion, writeReflexionJson } from './reflexion.js';

// ── 类型定义 ──────────────────────────────────────────────────────────────────

export interface ControllerContext {
  agentId: string;
  workDir: string;
  tempDir: string;
  /**
   * 关联的 KPI ID（来自外脑 KpiRegistry），用于 git commit meta、reflexion trail 等。
   * 缺省时仍读 `INNER_KPI_ID` 环境变量（兼容子进程注入路径，见 inner-brain-spawner）。
   * 测试中可直接传 `kpiId: 'kpi-test-x'` 取代环境变量。
   */
  kpiId?: string;
}

export interface ControllerDeps {
  llm: LLMAdapter;
  ioRegistry: IORegistry;
  /** Executor 使用的全套工具 */
  executorToolRegistry: ToolRegistry;
  /** Attributor 使用的专用工具（write_constraint / write_skill / write_knowledge） */
  attributorToolRegistry: ToolRegistry;
  memory: MemoryLayer2;
  mem0: Mem0Client;
  logger: Logger;
  /** 知识归档与复用（可选；未提供时跳过归档） */
  knowledgeStore?: KnowledgeStore;
}

export interface TickResult {
  hadWork: boolean;
}

export interface Controller {
  tick(): Promise<TickResult>;
}

// ── 工厂函数 ──────────────────────────────────────────────────────────────────

export function createController(ctx: ControllerContext, deps: ControllerDeps): Controller {
  const { agentId, workDir, tempDir } = ctx;
  const { llm, ioRegistry, executorToolRegistry, attributorToolRegistry, memory, mem0, logger, knowledgeStore } = deps;

  const brain          = new BrainFS(workDir);
  const statusFile     = path.join(tempDir, 'status');
  const directivesFile = path.join(tempDir, 'directives');
  const kpiId          = ctx.kpiId?.trim() || process.env['INNER_KPI_ID']?.trim() || undefined;

  function syncStatus(): void {
    try {
      const state     = brain.readState();
      const milestone = brain.getActiveMilestone();
      const active    = brain.listActivePendings();
      const status: Record<string, unknown> = {
        ts:               new Date().toISOString(),
        mode:             state.mode,
        milestone:        milestone ? { id: milestone.id, title: milestone.title, cyclic: milestone.cyclic ?? false } : null,
        goal_origin_user: brain.readGoalOriginUser(),
        blocked:          state.mode === 'BLOCKED' || state.mode === 'AWAITING',
        block_reason:     state.blockedReason ?? state.awaitingReason ?? null,
        awaiting:         state.mode === 'AWAITING',
        awaiting_reason:  state.awaitingReason ?? null,
        pending_count:    active.length,
        pendings:         active.map(p => ({
          id: p.id, kind: p.kind, deadline: p.deadline ?? null,
          source: p.source ?? null,
        })),
      };
      if (state.mode === 'SLEEPING') {
        status['sleeping_until'] = state.sleepUntil ?? null;
        status['cycle_count']    = state.cycleCount ?? 0;
      }
      fs.writeFileSync(statusFile, JSON.stringify(status, null, 2), 'utf8');
    } catch { /* non-critical */ }
  }

  /** 写状态 + 自动 commit 一次 git 演化历史 */
  function writeStateAndCommit(state: ControllerState, message: string): void {
    brain.writeState(state);
    void brain.commit(message, {
      mode: state.mode,
      ...(kpiId ? { kpiId } : {}),
    });
  }

  /** 把残留的 BLOCKED / SLEEPING 自动转成 AWAITING + pending（幂等） */
  function migrateLegacyAwait(state: ControllerState): ControllerState {
    if (state.mode === 'BLOCKED' && state.blockedReason) {
      brain.addPending({
        kind: 'ask_user',
        spec: { prompt: state.blockedReason },
        deadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        on_timeout: { action: 'block', reason: '人工兜底超时' },
        source: 'migrate:BLOCKED',
      });
      state = {
        ...state,
        mode: 'AWAITING',
        awaitingReason: state.blockedReason,
        blockedReason: null,
      };
      writeStateAndCommit(state, '[migrate] BLOCKED -> AWAITING(ask_user)');
      logger.info('controller', { event: 'migrate.blocked.to.awaiting', data: { reason: state.awaitingReason } });
    } else if (state.mode === 'SLEEPING' && state.sleepUntil) {
      brain.addPending({
        kind: 'timer',
        spec: { execute_at: state.sleepUntil },
        source: 'migrate:SLEEPING',
      });
      state = {
        ...state,
        mode: 'AWAITING',
        awaitingReason: `cyclic 第 ${state.cycleCount ?? 0} 轮后等待 ${state.sleepUntil}`,
        sleepUntil: null,
      };
      writeStateAndCommit(state, '[migrate] SLEEPING -> AWAITING(timer)');
      logger.info('controller', { event: 'migrate.sleeping.to.awaiting', data: { sleepUntil: state.awaitingReason } });
    }
    return state;
  }

  return {
    async tick(): Promise<TickResult> {
      let state = brain.readState();

      // ── 时间推进（纯数据，不调 LLM）──────────────────────────────────────────
      const firedTimerIds = brain.resolveDueTimers();
      const expiredIds = brain.expireOverduePendings();
      if (firedTimerIds.length + expiredIds.length > 0) {
        void brain.commit(`[pendings] auto-advance: ${firedTimerIds.length} timer / ${expiredIds.length} expired`, { mode: state.mode });
        logger.info('controller', {
          event: 'pendings.advance',
          data: { fired: firedTimerIds.length, expired: expiredIds.length },
        });
      }

      // ── 旧状态自动升级（一次性、幂等）────────────────────────────────────────
      state = migrateLegacyAwait(state);

      // 每轮开始时同步状态供外脑读取
      syncStatus();

      logger.info('controller', {
        event: 'tick.start',
        data: { mode: state.mode, replanCount: state.replanCount, pendings: brain.listActivePendings().length },
      });

      // ── AWAITING 状态：检查 pending 是否已 resolve ──────────────────────────
      if (state.mode === 'AWAITING') {
        const active = brain.listActivePendings();
        const resolved = brain.listUnconsumedResolvedPendings();

        // 外脑 input / directives 也可强制提前唤醒（兼容旧的 [BLOCK解封] 协议）
        const input = await safeReadInput(ioRegistry, logger);
        const directives = readAndClearDirectives(directivesFile, logger);
        const blockResolutionDirective = directives.find(
          d => d.type === 'feedback' && d.content.startsWith('[BLOCK解封]'),
        );

        const hasUnconsumed = resolved.length > 0;
        const hasExternalSignal = !!input || !!blockResolutionDirective;

        if (!hasUnconsumed && !hasExternalSignal) {
          // 仍在等所有 pending → 让 worker idle 退出（数据驱动，进程不留）
          return { hadWork: false };
        }

        // ── 外脑显式干预：把所有 active pending 取消，强制切回 DECOMPOSE/EXECUTE
        if (input) {
          for (const p of active) brain.resolvePending(p.id, { status: 'cancelled' });
          const isPostComplete = state.awaitingReason === '目标已完成，等待新目标';
          const isNewGoalCmd = input.trimStart().startsWith('[NEW_GOAL]');
          if (isPostComplete || isNewGoalCmd) {
            brain.archiveForNewTask();
            brain.writeGoal(input);
            state = {
              ...state,
              mode: 'DECOMPOSE',
              replanCount: 0,
              replanReason: isNewGoalCmd ? `新任务指令：${input.slice(0, 100)}` : `新任务：${input.slice(0, 100)}`,
              awaitingReason: null,
              blockedReason: null,
            };
            writeStateAndCommit(state, '[awake] new task from input');
            return { hadWork: true };
          }
          for (const d of directives) {
            if (d.type === 'constraint' || d.type === 'requirement') {
              brain.appendConstraint(`\n\n<!-- directive ${d.type} ${d.ts} from ${d.from} -->\n[外脑指示] ${d.content}`);
            }
          }
          const decision = await resolveBlock(state.awaitingReason ?? '', input, llm, logger);
          brain.appendConstraint(`\n\n<!-- 外脑解封指令 ${new Date().toISOString()} -->\n[人类指示] ${input}`);
          state = {
            ...state,
            mode: decision === 'CONTINUE' ? 'EXECUTE' : 'DECOMPOSE',
            replanCount: 0,
            replanReason: decision === 'CONTINUE' ? null : `AWAITING 已解除，外脑指示：${input}`,
            awaitingReason: null,
            blockedReason: null,
          };
          writeStateAndCommit(state, `[awake] input -> ${state.mode}`);
          return { hadWork: true };
        }

        // ── 来自 [BLOCK解封] directive 的回复 → 解析为 ask_user pending 的 result
        if (blockResolutionDirective) {
          const replyText = blockResolutionDirective.content.replace('[BLOCK解封] 用户回复：', '');
          let askResolved = 0;
          for (const p of active) {
            if (p.kind === 'ask_user') {
              brain.resolvePending(p.id, { result: { reply: replyText } });
              askResolved += 1;
            }
          }
          for (const d of directives) {
            if (d.type === 'constraint' || d.type === 'requirement') {
              brain.appendConstraint(`\n\n<!-- directive ${d.type} ${d.ts} from ${d.from} -->\n[外脑指示] ${d.content}`);
            }
          }
          logger.info('controller', { event: 'awake.user_reply', data: { askResolved, replyPreview: replyText.slice(0, 80) } });
        }

        // ── 已有 resolved/timed_out 未消费 或所有 pending 都消化完：进 EXECUTE
        if (active.length === 0 || brain.listUnconsumedResolvedPendings().length > 0) {
          state = {
            ...state,
            mode: 'EXECUTE',
            awaitingReason: null,
            blockedReason: null,
          };
          writeStateAndCommit(state, '[awake] pending resolved -> EXECUTE');
          return { hadWork: true };
        }

        return { hadWork: false };
      }

      // ── BLOCKED 状态：等待外脑 input 或 directives ───────────────────────────
      if (state.mode === 'BLOCKED') {
        // 优先读 input（[NEW_GOAL] 指令或外脑直接指令）
        const input = await safeReadInput(ioRegistry, logger);

        // 同时读取 directives（BLOCK 解封回复、约束补充）
        const directives = readAndClearDirectives(directivesFile, logger);
        const blockResolutionDirective = directives.find(
          d => d.type === 'feedback' && d.content.startsWith('[BLOCK解封]'),
        );

        // 如果 input 和 directives 都没有内容，继续等待
        if (!input && !blockResolutionDirective) {
          return { hadWork: false };
        }

        // [NEW_GOAL] 指令或"目标已完成"后的新任务 → 归档旧 brain，重新规划
        // 注意：[NEW_GOAL] 必须优先于 LLM 解封，否则 goal.md 缺失时 REPLAN 路径不写 goal 会死循环
        const isPostComplete = state.blockedReason === '目标已完成，等待新目标';
        const isNewGoalCmd   = !!input?.trimStart().startsWith('[NEW_GOAL]');
        if (input && (isPostComplete || isNewGoalCmd)) {
          brain.archiveForNewTask();
          logger.info('controller', { event: 'brain.archived.for.new.task', data: { preview: input.slice(0, 80) } });
          brain.writeGoal(input);
          state.replanReason = isNewGoalCmd ? `新任务指令：${input.slice(0, 100)}` : `新任务：${input.slice(0, 100)}`;
          state.mode = 'DECOMPOSE';
          state.replanCount = 0;
          state.blockedReason = null;
          brain.writeState(state);
          logger.info('controller', { event: 'new.task.from.input', data: { preview: input.slice(0, 80) } });
          return { hadWork: true };
        }

        // 非新任务 input 或来自 directives 的 BLOCK 解封回复
        // 优先使用 input，其次用 BLOCK 解封 directive
        const resolveContent = input ?? (blockResolutionDirective
          ? blockResolutionDirective.content.replace('[BLOCK解封] 用户回复：', '')
          : '');

        if (!resolveContent) return { hadWork: false };

        // 将 directives 中的约束注入 constraints.md（feedback 类不注入）
        for (const d of directives) {
          if (d.type === 'constraint' || d.type === 'requirement') {
            const note = `\n\n<!-- directive ${d.type} ${d.ts} from ${d.from} -->\n[外脑指示] ${d.content}`;
            brain.appendConstraint(note);
            logger.info('controller', { event: 'directive.applied', data: { type: d.type, preview: d.content.slice(0, 60) } });
          }
        }

        // 方案 C：LLM 判断 CONTINUE vs REPLAN（仅用于真实 BLOCK，非新目标指令）
        const decision = await resolveBlock(state.blockedReason ?? '', resolveContent, llm, logger);

        const humanNote = `\n\n<!-- 外脑解封指令 ${new Date().toISOString()} -->\n[人类指示] ${resolveContent}`;
        brain.appendConstraint(humanNote);
        logger.info('controller', { event: 'block.human.note.written', data: { preview: resolveContent.slice(0, 80) } });

        // 解封后无论走哪条路径都重置 replanCount，
        // 防止因"连续 REPLAN 超限→BLOCKED→解封→立即再 REPLAN 超限"形成死锁。
        state.replanCount = 0;
        if (decision === 'CONTINUE') {
          state.mode = 'EXECUTE';
          state.blockedReason = null;
        } else {
          state.replanReason = `BLOCK 已解除，外脑指示：${resolveContent}`;
          state.mode = 'DECOMPOSE';
          state.blockedReason = null;
        }
        brain.writeState(state);
        return { hadWork: true };
      }

      // ── DECOMPOSE 状态 ────────────────────────────────────────────────────────
      if (state.mode === 'DECOMPOSE') {
        const goal = brain.readGoal();
        if (!goal.trim()) {
          logger.error('controller', { event: 'goal.missing', data: {} });
          await writeBlockOutput(ioRegistry, '.brain/goal.md 不存在或为空，无法启动内脑。请通过 --goal 或 --goal-file 参数指定目标。', null, logger);
          state.mode = 'BLOCKED';
          state.blockedReason = 'goal.md 缺失';
          brain.writeState(state);
          return { hadWork: true };
        }

        const result = await runDecomposer(brain, state.replanReason, llm, logger, knowledgeStore, kpiId);

        if (!result.ok) {
          logger.error('controller', { event: 'decompose.failed', data: { error: result.error } });
          await writeBlockOutput(ioRegistry, `Decomposer 无法生成有效里程碑：${result.error}`, brain.readGoalOriginUser(), logger);
          state.mode = 'BLOCKED';
          state.blockedReason = `Decomposer 失败：${result.error}`;
          brain.writeState(state);
          return { hadWork: true };
        }

        brain.writeMilestones(result.milestonesContent);
        state.mode = 'EXECUTE';
        state.replanReason = null;
        brain.writeState(state);

        logger.info('controller', { event: 'decompose.done', data: { milestones: result.milestonesContent.slice(0, 200) } });
        return { hadWork: true };
      }

      // ── EXECUTE 状态 ──────────────────────────────────────────────────────────
      if (state.mode === 'EXECUTE') {
        // 检查是否有外脑 input（外脑干预 → REPLAN）
        const input = await safeReadInput(ioRegistry, logger);
        if (input) {
          logger.info('controller', { event: 'external.intervention', data: { preview: input.slice(0, 80) } });
          state.replanReason = `外脑干预：${input}`;
          state.mode = 'DECOMPOSE';
          brain.writeState(state);
          return { hadWork: true };
        }

        // 消费 directives（约束/需求 → 注入 constraints.md；feedback 仅记录）
        const execDirectives = readAndClearDirectives(directivesFile, logger);
        for (const d of execDirectives) {
          if (d.type === 'constraint' || d.type === 'requirement') {
            const note = `\n\n<!-- directive ${d.type} ${d.ts} from ${d.from} -->\n[外脑指示] ${d.content}`;
            brain.appendConstraint(note);
            logger.info('controller', { event: 'directive.applied', data: { type: d.type, preview: d.content.slice(0, 60) } });
          } else {
            logger.info('controller', { event: 'directive.feedback', data: { from: d.from, preview: d.content.slice(0, 60) } });
          }
        }

        const activeMilestone = brain.getActiveMilestone((badLine) => {
          logger.warn('controller', { event: 'milestone.parse.failed', data: { line: badLine.slice(0, 120) } });
        });
        if (!activeMilestone) {
          // 没有 Active 里程碑，检查是否全部完成
          if (brain.allMilestonesCompleted()) {
            await handleAllCompleted(brain, ioRegistry, memory, mem0, agentId, tempDir, logger, llm, knowledgeStore, workDir, kpiId);
          } else {
            // 里程碑为空 → 重新规划
            state.replanReason = '没有 Active 里程碑，需要重新规划';
            state.mode = 'DECOMPOSE';
            brain.writeState(state);
          }
          return { hadWork: true };
        }

        // 执行前快照
        const preState = captureSnapshot(workDir);
        brain.writeEnvironment(preState);

        // 把上一轮 AWAITING 期间已 resolved 但未消费的 pending 注入到 LLM
        const unconsumed = brain.listUnconsumedResolvedPendings();
        const resolvedForLLM = unconsumed.map(p => ({
          id: p.id,
          kind: p.kind,
          status: p.status,
          ...(p.source ? { source: p.source } : {}),
          result: p.result,
          ...(p.intent ? { intent: p.intent } : {}),
        }));

        const execResult = await runExecutor(
          brain,
          activeMilestone,
          workDir,
          executorToolRegistry,
          llm,
          logger,
          {
            pendingCapabilityGaps: readPendingGaps(tempDir),
            selfUpdate: getSelfUpdatePromptContext(workDir),
            resolvedPendings: resolvedForLLM,
          },
        );

        // 消费完毕：标记 resolved pending 为已 consumed
        if (unconsumed.length > 0) {
          brain.markPendingsConsumed(unconsumed.map(p => p.id));
        }

        // 执行后快照
        const postState = brain.readEnvironment();

        // 保存 execution context
        brain.writeExecutionContext({
          activeMilestone,
          preState,
          executionLog: execResult.executionLog,
          postState,
        });

        // executor 内若调用了 ask_user / wait_timer：ask_user 需要外脑通知。
        // 但归因仍正常跑(让 attributor 学习本轮工作),归因后若 pending 仍活则进 AWAITING。
        const activeAfterExec = brain.listActivePendings();
        const askUsers = activeAfterExec.filter(p => p.kind === 'ask_user');
        for (const p of askUsers) {
          const spec = p.spec as { prompt?: string };
          await writeBlockOutput(ioRegistry, spec.prompt ?? '需要用户回复', brain.readGoalOriginUser(), logger);
        }

        state.mode = 'ATTRIBUTE';
        brain.writeState(state);

        return { hadWork: true };
      }

      // ── ATTRIBUTE 状态 ────────────────────────────────────────────────────────
      if (state.mode === 'ATTRIBUTE') {
        const execCtx = brain.readExecutionContext();
        if (!execCtx) {
          // 没有执行上下文（可能是重启后遗留），回退到 EXECUTE
          logger.warn('controller', { event: 'attribute.no.context', data: {} });
          state.mode = 'EXECUTE';
          brain.writeState(state);
          return { hadWork: true };
        }

        const attrResult = await runAttributor(
          execCtx.activeMilestone,
          execCtx.preState,
          execCtx.executionLog,
          execCtx.postState,
          attributorToolRegistry,
          llm,
          logger,
          brain,
        );

        // 归因完成 → 丢弃 executionLog
        brain.clearExecutionContext();

        // 将执行摘要存入 Daily Log + mem0（"存入记忆以防万一"）
        const summary = buildExecutionSummary(execCtx.activeMilestone, execCtx.executionLog, attrResult.flag, attrResult.reason);
        memory.appendDailyLog(summary);
        await safeMem0Add(mem0, summary, agentId, logger);

        // 根据 Control Flag 更新状态
        const maxReplan = brain.parseMaxReplan();

        switch (attrResult.flag) {
          case 'CONTINUE':
            state.mode = 'EXECUTE';
            brain.writeState(state);
            break;

          case 'SUCCESS_AND_NEXT': {
            brain.markMilestoneCompleted(execCtx.activeMilestone.id);
            const hasNext = brain.activateNextPending();
            if (hasNext) {
              state.mode = 'EXECUTE';
              brain.writeState(state);
              logger.info('controller', { event: 'milestone.next', data: { completedId: execCtx.activeMilestone.id } });
            } else {
              await handleAllCompleted(brain, ioRegistry, memory, mem0, agentId, tempDir, logger, llm, knowledgeStore, workDir, kpiId);
            }
            break;
          }

          case 'REPLAN': {
            state.replanCount += 1;
            if (state.replanCount > maxReplan) {
              const replanReason = `已连续 REPLAN ${state.replanCount} 次（上限 ${maxReplan}），无法自主突破。最后原因：${attrResult.reason}`;
              await writeBlockOutput(ioRegistry, replanReason, brain.readGoalOriginUser(), logger);
              brain.addPending({
                kind: 'ask_user',
                spec: { prompt: replanReason },
                deadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
                on_timeout: { action: 'block', reason: '人工兜底超时' },
                source: 'attributor:REPLAN_LIMIT',
              });
              state.mode = 'AWAITING';
              state.awaitingReason = `连续 REPLAN 超限：${attrResult.reason}`;
              state.blockedReason = null;
              writeStateAndCommit(state, '[await] REPLAN limit exceeded');
              await safeArchive(knowledgeStore, brain, agentId, workDir, 'REPLAN_LIMIT', attrResult.reason, logger, llm, kpiId);
            } else {
              state.replanReason = attrResult.reason;
              state.mode = 'DECOMPOSE';
              brain.writeState(state);
              logger.info('controller', { event: 'replan', data: { count: state.replanCount, reason: attrResult.reason } });
            }
            break;
          }

          case 'BLOCK': {
            const goalOriginUser = brain.readGoalOriginUser();
            await writeBlockOutput(ioRegistry, attrResult.reason, goalOriginUser, logger);
            brain.addPending({
              kind: 'ask_user',
              spec: { prompt: attrResult.reason },
              deadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
              on_timeout: { action: 'block', reason: '人工兜底超时' },
              source: 'attributor:BLOCK',
            });
            state.mode = 'AWAITING';
            state.awaitingReason = attrResult.reason;
            state.blockedReason = null;
            state.replanCount = 0;
            writeStateAndCommit(state, '[await] attributor BLOCK');
            logger.info('controller', { event: 'awaiting', data: { reason: attrResult.reason, kind: 'ask_user' } });
            await safeArchive(knowledgeStore, brain, agentId, workDir, 'BLOCK', attrResult.reason, logger, llm, kpiId);
            break;
          }

          case 'CYCLE_DONE': {
            const milestone = execCtx.activeMilestone;
            if (!milestone.cyclic || !milestone.cycleIntervalMs) {
              // 非循环里程碑误用 CYCLE_DONE → 降级为 CONTINUE，记录警告
              logger.warn('controller', {
                event: 'cycle_done.non_cyclic',
                data: { milestoneId: milestone.id, reason: attrResult.reason },
              });
              state.mode = 'EXECUTE';
              brain.writeState(state);
              break;
            }

            // cyclic:0 防护：间隔为 0 会造成无限紧密循环，强制最小 1 分钟
            const safeInterval = Math.max(milestone.cycleIntervalMs, 60_000);
            if (safeInterval !== milestone.cycleIntervalMs) {
              logger.warn('controller', {
                event: 'cycle_done.interval_clamped',
                data: { milestoneId: milestone.id, original: milestone.cycleIntervalMs, clamped: safeInterval },
              });
            }

            const maxCycles  = brain.parseMaxCycles();
            const newCycleCount = (state.cycleCount ?? 0) + 1;
            if (maxCycles > 0 && newCycleCount > maxCycles) {
              logger.warn('controller', {
                event: 'cycle_done.max_cycles_exceeded',
                data: { milestoneId: milestone.id, cycleCount: newCycleCount, maxCycles },
              });
              const reason = `循环里程碑 ${milestone.id} 已执行 ${newCycleCount} 轮（max_cycles=${maxCycles}），超出上限，等待外脑决策。`;
              await writeBlockOutput(ioRegistry, reason, brain.readGoalOriginUser(), logger);
              await safeArchive(knowledgeStore, brain, agentId, workDir, 'CYCLE_MAX', reason, logger, llm, kpiId);
              brain.addPending({
                kind: 'ask_user',
                spec: { prompt: reason },
                deadline: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
                on_timeout: { action: 'block', reason: '人工兜底超时' },
                source: 'attributor:CYCLE_MAX',
              });
              state.mode = 'AWAITING';
              state.awaitingReason = reason;
              state.cycleCount = newCycleCount;
              state.blockedReason = null;
              writeStateAndCommit(state, '[await] cycle max exceeded');
              break;
            }

            // 循环里程碑：本轮完成，写一个 timer pending 进 AWAITING
            brain.keepCyclicMilestoneActive(milestone.id);
            const nextWakeAt = new Date(Date.now() + safeInterval).toISOString();
            brain.addPending({
              kind: 'timer',
              spec: { execute_at: nextWakeAt },
              source: `cyclic:${milestone.id}#${newCycleCount}`,
            });
            state.cycleCount  = newCycleCount;
            state.sleepUntil  = null;
            state.mode        = 'AWAITING';
            state.awaitingReason = `cyclic 第 ${newCycleCount} 轮完成，下一轮 ${nextWakeAt}`;
            state.blockedReason = null;
            state.replanCount = 0;
            writeStateAndCommit(state, `[await] cyclic#${newCycleCount} -> timer ${nextWakeAt}`);

            logger.info('controller', {
              event: 'cycle.awaiting',
              data: {
                milestoneId: milestone.id,
                cycleCount: state.cycleCount,
                wakeAt: nextWakeAt,
                intervalMs: milestone.cycleIntervalMs,
                reason: attrResult.reason,
              },
            });

            await writeProgressOutput(
              ioRegistry,
              `[循环第 ${state.cycleCount} 轮完成] ${attrResult.reason}\n下一轮时间：${nextWakeAt}`,
              brain.readGoalOriginUser(),
              logger,
            );
            break;
          }
        }

        // ── 归因决定的 mode 兜底:若仍有 active pending(executor 期间挂起了 ask_user
        //    /wait_timer 等),覆盖为 AWAITING,等数据驱动。
        const stillActive = brain.listActivePendings();
        if (stillActive.length > 0 && state.mode !== 'AWAITING') {
          const summary = stillActive.map(p => `${p.kind}:${p.id}`).join(', ');
          state.mode = 'AWAITING';
          state.awaitingReason = state.awaitingReason ?? `归因后仍挂起 ${stillActive.length} 项：${summary}`;
          writeStateAndCommit(state, `[await] post-attribute pendings remain (${summary})`);
        }

        return { hadWork: true };
      }

      // ── SLEEPING 状态：已废弃（迁移逻辑在 tick 顶部）保留兜底以防进入 ──────
      if (state.mode === 'SLEEPING') {
        // 外脑 input / directives 始终可以提前唤醒
        const input = await safeReadInput(ioRegistry, logger);
        const directives = readAndClearDirectives(directivesFile, logger);
        const hasExternalSignal = !!input || directives.length > 0;

        const wakeTime = state.sleepUntil ? new Date(state.sleepUntil).getTime() : 0;
        const shouldWake = hasExternalSignal || Date.now() >= wakeTime;

        if (!shouldWake) {
          return { hadWork: false };
        }

        // 唤醒：注入外脑信号（如果有），恢复 EXECUTE
        if (input) {
          logger.info('controller', { event: 'sleep.interrupted', data: { reason: 'external input', preview: input.slice(0, 80) } });
          state.replanReason = `外脑干预唤醒：${input}`;
          state.mode = 'DECOMPOSE';
        } else {
          logger.info('controller', {
            event: 'sleep.wakeup',
            data: { cycleCount: state.cycleCount ?? 0, sleepUntil: state.sleepUntil },
          });
          // 注入约束（如有 directive）
          for (const d of directives) {
            if (d.type === 'constraint' || d.type === 'requirement') {
              brain.appendConstraint(
                `\n\n<!-- directive ${d.type} ${d.ts} from ${d.from} -->\n[外脑指示] ${d.content}`,
              );
            }
          }
          state.mode = 'EXECUTE';
        }
        state.sleepUntil = null;
        brain.writeState(state);
        return { hadWork: true };
      }

      // 不应到达这里
      logger.error('controller', { event: 'unknown.mode', data: { mode: state.mode } });
      return { hadWork: false };
    },
  };
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

async function handleAllCompleted(
  brain: BrainFS,
  ioRegistry: IORegistry,
  memory: MemoryLayer2,
  mem0: Mem0Client,
  agentId: string,
  tempDir: string,
  logger: Logger,
  llm: LLMAdapter,
  knowledgeStore?: KnowledgeStore,
  workDir?: string,
  kpiId?: string,
): Promise<void> {
  const goal = brain.readGoal();
  const milestones = brain.readMilestones();
  const goalOriginUser = brain.readGoalOriginUser();

  // 收集 deliverables 文件清单(用于附件 + 报告文本)
  let deliverables: string[] | undefined;
  const deliverablesPath = path.join(tempDir, 'deliverables.json');
  try {
    if (fs.existsSync(deliverablesPath)) {
      const raw = fs.readFileSync(deliverablesPath, 'utf8');
      const parsed = JSON.parse(raw);
      deliverables = Array.isArray(parsed) ? parsed.filter((x: unknown) => typeof x === 'string') : undefined;
      fs.unlinkSync(deliverablesPath);
    }
  } catch { /* ignore */ }

  const deliverableList = deliverables ?? [];
  const reportText = buildCompletionReport({
    goal,
    milestones: shortenMilestonesForReport(milestones),
    knowledge: safeRead(() => brain.readKnowledge()),
    lastExecLog: safeRead(() => {
      const ctx = brain.readExecutionContext();
      return ctx?.executionLog ?? null;
    }),
    reflexion: safeRead(() => readReflexionJson(workDir)),
    deliverables: deliverableList,
    resultExcerpt: workDir ? pickDeliverableExcerpt(workDir, deliverableList) : null,
  });

  await writeCompleteOutput(ioRegistry, reportText, goalOriginUser, logger, deliverables);
  memory.appendDailyLog(`[完成] 目标达成，输出报告`);
  await safeMem0Add(mem0, `目标已完成: ${goal.slice(0, 200)}`, agentId, logger);

  // 里程碑已完成：标 BLOCKED(post-complete)，不挂 ask_user pending。
  // 否则注册表长期 AWAITING、外脑误以为需再 set_goal，且收不到「任务完成」通知。
  // blockedReason 须与 AWAITING/BLOCKED 处理器中 isPostComplete 判断一致。
  brain.writeState({
    mode: 'BLOCKED',
    replanCount: 0,
    replanReason: null,
    blockedReason: '目标已完成，等待新目标',
    awaitingReason: null,
    sleepUntil: null,
    cycleCount: 0,
  });
  void brain.commit('[complete] all milestones done', { mode: 'BLOCKED' });
  logger.info('controller', { event: 'all.complete', data: {} });

  await safeArchive(knowledgeStore, brain, agentId, workDir ?? '', 'COMPLETE', '目标全部完成', logger, llm, kpiId);
}

function buildExecutionSummary(
  milestone: Milestone,
  log: import('../brain/index.js').ExecutionEntry[],
  flag: string,
  reason: string,
): string {
  const toolNames = [...new Set(log.map(e => e.toolName))].join(', ') || '（无工具调用）';
  const errCount  = log.filter(e => !e.result.ok || e.error).length;
  return [
    `[执行归因] 里程碑: ${milestone.id} — ${milestone.title}`,
    `  工具: ${toolNames}  错误: ${errCount}/${log.length}`,
    `  结论: ${flag} — ${reason}`,
  ].join('\n');
}

async function safeReadInput(ioRegistry: IORegistry, logger: Logger): Promise<string | null> {
  try {
    const ep = ioRegistry.getInput('default');
    if (!ep) return null;
    const content = await ep.read();
    if (content) {
      logger.info('io', { event: 'input.read', data: { preview: content.slice(0, 80) } });
    }
    return content;
  } catch (e) {
    logger.error('io', { event: 'input.read.error', data: { error: String(e) } });
    return null;
  }
}

async function writeOutput(ioRegistry: IORegistry, content: string, logger: Logger): Promise<void> {
  try {
    const ep = ioRegistry.getOutput('default');
    if (!ep) return;
    await ep.write(content);
    logger.info('io', { event: 'output.write', data: { preview: content.slice(0, 100) } });
  } catch (e) {
    logger.error('io', { event: 'output.write.error', data: { error: String(e) } });
  }
}

/**
 * 写入结构化 BLOCK 输出（JSON），供外脑 push-loop 解析。
 * 向后兼容：同时写纯文本前缀（[BLOCK]）。
 */
async function writeBlockOutput(
  ioRegistry: IORegistry,
  reason: string,
  targetUser: string | null,
  logger: Logger,
): Promise<void> {
  const output = JSON.stringify({
    type:        'BLOCK',
    message:     reason,
    question:    reason,
    target_user: targetUser ?? undefined,
    ts:          new Date().toISOString(),
  });
  await writeOutput(ioRegistry, output, logger);
}

/**
 * 写入 PROGRESS 输出（JSON），供外脑 push-loop 记录进度（不打断用户）。
 */
async function writeProgressOutput(
  ioRegistry: IORegistry,
  message: string,
  targetUser: string | null,
  logger: Logger,
): Promise<void> {
  const output = JSON.stringify({
    type:        'PROGRESS',
    message,
    target_user: targetUser ?? undefined,
    ts:          new Date().toISOString(),
  });
  await writeOutput(ioRegistry, output, logger);
}

/**
 * 写入结构化 COMPLETE 输出（JSON），供外脑 push-loop 解析。
 * deliverables 为可选，相对于 workDir 的路径列表（见 inner-brain-deliverables 协议）。
 */
async function writeCompleteOutput(
  ioRegistry: IORegistry,
  message: string,
  targetUser: string | null,
  logger: Logger,
  deliverables?: string[],
): Promise<void> {
  const payload: Record<string, unknown> = {
    type:        'COMPLETE',
    message,
    target_user: targetUser ?? undefined,
    ts:          new Date().toISOString(),
  };
  if (deliverables && deliverables.length > 0) payload.deliverables = deliverables;
  const output = JSON.stringify(payload);
  await writeOutput(ioRegistry, output, logger);
}

async function safeArchive(
  store: KnowledgeStore | undefined,
  brain: BrainFS,
  agentId: string,
  workDir: string,
  trigger: import('../archive/index.js').ArchiveTrigger,
  triggerReason: string,
  logger: Logger,
  llm: LLMAdapter,
  kpiId?: string,
): Promise<void> {
  const reflexionResult = await runReflexion({ brain, trigger, triggerReason, llm, logger });
  writeReflexionJson(workDir, reflexionResult);

  if (!store) return;
  try {
    await store.archive({
      brain,
      agentId,
      workDir,
      trigger,
      triggerReason,
      goalText: brain.readGoal(),
      kpiId,
      reflexion: {
        verdict: reflexionResult.verdict,
        hardFailures: reflexionResult.hardFailures,
        softFailures: reflexionResult.softFailures,
        nextStrategy: reflexionResult.nextStrategy,
      },
    });
    logger.info('archive', {
      event: 'archive.done',
      data: { trigger, agentId, kpiId: kpiId ?? null, verdict: reflexionResult.verdict },
    });
  } catch (e) {
    logger.warn('archive', { event: 'archive.error', data: { error: String(e) } });
  }
}

export {
  buildCompletionReport,
  pickDeliverableExcerpt,
  shortenMilestonesForReport,
} from './completion-report.js';

function readReflexionJson(workDir?: string): {
  verdict: string; hardFailures: string[]; softFailures: string[]; nextStrategy: string;
} | null {
  if (!workDir) return null;
  try {
    const fp = path.join(workDir, '.brain', 'reflexion.json');
    if (!fs.existsSync(fp)) return null;
    const raw = fs.readFileSync(fp, 'utf8');
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return {
      verdict: String(obj['verdict'] ?? ''),
      hardFailures: Array.isArray(obj['hardFailures']) ? (obj['hardFailures'] as unknown[]).map(String) : [],
      softFailures: Array.isArray(obj['softFailures']) ? (obj['softFailures'] as unknown[]).map(String) : [],
      nextStrategy: String(obj['nextStrategy'] ?? ''),
    };
  } catch { return null; }
}

function safeRead<T>(fn: () => T): T | null {
  try { return fn(); } catch { return null; }
}

// ── directives 文件工具 ───────────────────────────────────────────────────────

interface Directive {
  ts:      string;
  type:    'constraint' | 'requirement' | 'feedback';
  content: string;
  from:    string;
}

/**
 * 读取并清空 directives 文件。
 * 返回解析成功的所有 directive 条目（失败的行跳过）。
 */
function readAndClearDirectives(filePath: string, logger: Logger): Directive[] {
  if (!fs.existsSync(filePath)) return [];
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
    fs.writeFileSync(filePath, '', 'utf8'); // 消费后立即清空
  } catch (e) {
    logger.warn('controller', { event: 'directives.read.error', data: { error: String(e) } });
    return [];
  }

  const results: Directive[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const d = JSON.parse(trimmed) as Directive;
      if (d.type && d.content) {
        results.push(d);
        logger.info('controller', { event: 'directive.consumed', data: { type: d.type, from: d.from, preview: d.content.slice(0, 60) } });
      }
    } catch {
      logger.warn('controller', { event: 'directive.parse.error', data: { line: trimmed.slice(0, 80) } });
    }
  }
  return results;
}

async function safeMem0Add(
  mem0: Mem0Client,
  content: string,
  agentId: string,
  logger: Logger,
): Promise<void> {
  try {
    await mem0.add(content, agentId);
    logger.debug('mem0', { event: 'add', data: { len: content.length } });
  } catch (e) {
    logger.warn('mem0', { event: 'add.error', data: { error: String(e) } });
  }
}
