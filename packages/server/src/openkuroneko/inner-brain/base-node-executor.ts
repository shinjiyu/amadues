/**
 * BaseNode Executor — 单个 baseNode 的 ReAct 执行。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §6
 *
 * 与 legacy executor 的根本差异：
 *   - 围绕子目标持续 ReAct，直到目标达成或高置信失败。
 *   - 终止信号：LLM 自然结束（无 tool_calls）= 完成；content 含
 *     `CANNOT_CONTINUE:` = terminal failure。
 *   - 产出契约：interface.outputs 须满足；缺失即 terminal failure。
 *
 * 失败上交 Designer 通过 memory.last_failure（由 runner 写），本模块只
 * 返回 BaseNodeOutcome。
 */

import type { LLMAdapter, Message } from '../adapter/index.js';
import type { Logger } from '../logger/index.js';
import { isTransientLlmTransportError } from '../../llm/llm-transport-error.js';
import type { ToolRegistry } from '../tools/index.js';
import type { ExecutionEntry } from '../brain/index.js';
import {
  recordInnerToolCall,
  recordInnerToolResult,
  resolveInnerToolAuditPaths,
} from './inner-tool-audit.js';
import { selectFactsForPrompt } from './fact-governor.js';
import { selectConstraintsForPrompt } from './constraint-governor.js';
import { buildRuntimeContextSection } from './runtime-context.js';
import {
  buildLiveResourceBudgetSection,
  buildStaticResourceBudgetSection,
  resolveBaseNodeBudget,
  upsertLiveBudgetMessage,
} from './resource-budget.js';
import { closeBrowserSessionsForNode } from '../browser/session-registry.js';
import {
  clearBrowserSessionScope,
  setBrowserSessionScope,
} from '../browser/session-scope.js';
import { pruneReActMessages } from './react-message-prune.js';
import {
  isRejectedWriteContent,
  isWriteFileOverwriteGuardEnabled,
  normalizeWorkRelPath,
  REJECTED_OVERWRITE_MSG,
  REJECTED_WRITE_CONTENT_MSG,
} from '../tools/write-content-guard.js';
import { createShellStallGuard } from './shell-stall-guard.js';
import { compressToolOutputForContext } from './tool-output-spill.js';
import {
  shellOutputLooksFailed,
  validateNodeCompletion,
} from './node-acceptance.js';
import type {
  FailureSummary,
  InnerMemory,
  LocalNode,
  NodeInst,
  NodeOutcomeStatus,
} from './types.js';

export interface BaseNodeOutcome {
  ok: boolean;
  /** §6.7 机械完成态 */
  status?: NodeOutcomeStatus;
  outputs?: Record<string, unknown>;
  failure?: FailureSummary;
  executionLog: ExecutionEntry[];
  lastContent: string;
}

export interface BaseNodeDeps {
  llm: LLMAdapter;
  toolRegistry: ToolRegistry;
  logger: Logger;
}

export interface BaseNodeRunContext {
  node: LocalNode;
  inst: NodeInst;
  memory: InnerMemory;
  workDir: string;
  /** KPI burst，写入 inner tool-audit */
  burstId?: string;
  /** 执行前加载的节点技能块（见 INNER-NODE-SKILLS.md §5） */
  skillsSection?: string;
}

/** 替换 ${{ params.x }} / ${{ memory.x }} 占位 */
export function renderTemplate(
  tpl: string,
  scope: { params: Record<string, unknown>; memory: InnerMemory },
): string {
  return tpl.replace(/\$\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, expr: string) => {
    const [root, ...rest] = expr.split('.');
    let cur: unknown =
      root === 'params' ? scope.params : root === 'memory' ? scope.memory : undefined;
    for (const seg of rest) {
      if (cur == null || typeof cur !== 'object') return '';
      cur = (cur as Record<string, unknown>)[seg];
    }
    if (cur == null) return '';
    return typeof cur === 'string' ? cur : JSON.stringify(cur);
  });
}

/** 合并 effective params：defaultParams ← metadata.workDir ← inst.params */
export function resolveParams(node: LocalNode, inst: NodeInst): Record<string, unknown> {
  const defaults =
    node.body.kind === 'executor' ? node.body.defaultParams ?? {} : {};
  const out: Record<string, unknown> = { ...defaults };
  if (node.metadata.workDir) out['workDir'] = node.metadata.workDir;
  return { ...out, ...(inst.params ?? {}) };
}

function detectTerminal(content: string): { abort: boolean; transient: boolean; reason: string } {
  const m = /CANNOT_CONTINUE(?:\(transient\))?\s*:\s*(.+)/i.exec(content);
  if (!m) return { abort: false, transient: false, reason: '' };
  const transient = /CANNOT_CONTINUE\(transient\)/i.test(content);
  return { abort: true, transient, reason: m[1]!.trim() };
}

function buildUserMessage(ctx: BaseNodeRunContext): string {
  const { node, inst, memory, workDir } = ctx;
  const objective = inst.instruction?.trim() || node.description;
  const extraKeys = (inst.memoryIn ?? []).filter(
    k => !['goal', 'facts', 'constraints', 'last_failure'].includes(k),
  );
  const extraCtx = extraKeys
    .map(k => {
      const v = getPath(memory as Record<string, unknown>, k);
      return v === undefined ? null : `- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`;
    })
    .filter(Boolean);

  const lastFailureBlock = memory.last_failure
    ? `## 上一次失败（参考，不必复刻同路径）\n${memory.last_failure.summary}\n已尝试：${memory.last_failure.attempted.join('; ')}`
    : '## 上一次失败\n（无）';

  const outputsContract =
    node.interface.outputs.length > 0
      ? node.interface.outputs.map(o => `- ${o.key} (${o.type})`).join('\n')
      : '- （无强制 outputs；以子目标达成为准）';

  // P-prompt（DYFLOW §6.7a）：机械验票口令须进 prompt，避免 ALL_CHECKS_PASSED≠FILES_READY 假失败
  const deliverableBlock = formatDeliverableForPrompt(inst.deliverable);

  return [
    `## 你的子目标\n${objective}`,
    `## 全局目标\n${memory.goal ?? '（未指定）'}`,
    selectConstraintsForPrompt(memory.constraints, { max: 20 }).section,
    selectFactsForPrompt(memory.fact_records ?? []).section,
    lastFailureBlock,
    `## 本节点需产出的 outputs（必须真实落地）\n${outputsContract}`,
    deliverableBlock,
    extraCtx.length ? `## 额外上下文\n${extraCtx.join('\n')}` : '',
    `## 工作目录\n${workDir}`,
    `在资源预算内达成子目标并产出 outputs。重复失败或卡住时应尽早 CANNOT_CONTINUE（永久）或 CANNOT_CONTINUE(transient) 上交 Designer，勿空转；接近上限时收束或上报。`,
  ]
    .filter(Boolean)
    .join('\n\n---\n\n');
}

/** §6.7a P-prompt：把 Designer 声明的交付物检查原样披露给 baseNode */
export function formatDeliverableForPrompt(
  deliverable: NodeInst['deliverable'] | undefined,
): string {
  if (!deliverable || deliverable.checks.length === 0) return '';
  const lines = deliverable.checks.map(c => {
    const desc = c.describe?.trim() ? ` — ${c.describe.trim()}` : '';
    return `- [${c.kind}] target=\`${c.target}\`${desc}`;
  });
  const stdoutHints = deliverable.checks
    .filter(c => c.kind === 'stdout_contains' || c.kind === 'stdout_absent')
    .map(c =>
      c.kind === 'stdout_contains'
        ? `必须在 stdout/最终回复中**精确包含**子串「${c.target}」（勿用同义成功词）`
        : `stdout/最终回复中**不得包含**子串「${c.target}」`,
    );
  return [
    `## 本节点交付物验票（机械；与 Runner 一致）`,
    `摘要：${deliverable.summary}`,
    ...lines,
    ...(stdoutHints.length ? ['', ...stdoutHints] : []),
  ].join('\n');
}

function getPath(obj: Record<string, unknown>, dotPath: string): unknown {
  let cur: unknown = obj;
  for (const seg of dotPath.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** 把 allowlist 解析为实际 schema + 校验工具存在 */
function resolveTools(node: LocalNode, registry: ToolRegistry): {
  schema: object[];
  allowed: Set<string> | null;
} {
  if (node.body.kind !== 'executor') return { schema: registry.schema(), allowed: null };
  const allow = node.body.tools;
  if (allow.includes('*')) return { schema: registry.schema(), allowed: null };
  const allowed = new Set(allow);
  const schema = registry.schema().filter(s => {
    const name = (s as { function?: { name?: string } }).function?.name;
    return name ? allowed.has(name) : false;
  });
  return { schema, allowed };
}

export async function runBaseNode(
  ctx: BaseNodeRunContext,
  deps: BaseNodeDeps,
): Promise<BaseNodeOutcome> {
  const { node, inst } = ctx;
  const { llm, toolRegistry, logger } = deps;

  if (node.body.kind !== 'executor') {
    throw new Error(`[base-node] node ${node.id} is not an executor body`);
  }

  const params = resolveParams(node, inst);
  const budgetCfg = resolveBaseNodeBudget();
  const runtimeBlock = buildRuntimeContextSection({
    workDir: ctx.workDir,
    dataRoot: process.env['UTLRA_DATA_ROOT']?.trim(),
  });
  const systemPrompt = renderTemplate(
    [
      node.body.promptTemplate,
      node.body.systemSlice ?? '',
      ctx.skillsSection ?? '',
      runtimeBlock,
      buildStaticResourceBudgetSection('baseNode'),
    ]
      .filter(Boolean)
      .join('\n\n'),
    { params, memory: ctx.memory },
  );
  const userMessage = renderTemplate(buildUserMessage(ctx), { params, memory: ctx.memory });
  const { schema, allowed } = resolveTools(node, toolRegistry);

  const executionLog: ExecutionEntry[] = [];
  let messages: Message[] = [{ role: 'user', content: userMessage }];
  let lastContent = '';
  const auditPaths = resolveInnerToolAuditPaths(ctx.workDir);

  logger.info('base-node', {
    event: 'start',
    data: { nodeInstId: inst.id, ref: node.id, hasInstruction: !!inst.instruction },
  });

  let noProgressStreak = 0;
  const shellStall = createShellStallGuard();
  /** 本节点内已成功 overwrite 的路径（禁止二次整文件覆盖） */
  const committedOverwritePaths = new Set<string>();

  setBrowserSessionScope(ctx.workDir, inst.id);
  try {
  for (let round = 0; round < budgetCfg.maxRounds; round++) {
    messages = upsertLiveBudgetMessage(
      messages,
      buildLiveResourceBudgetSection({
        round,
        maxRounds: budgetCfg.maxRounds,
        toolCalls: executionLog.length,
        noProgressStreak,
        failFastStreak: budgetCfg.failFastStreak,
      }),
    );
    let result;
    try {
      result = await llm.chat(systemPrompt, messages, schema);
    } catch (e) {
      const errMsg = String(e);
      logger.error('base-node', { event: 'llm.error', data: { nodeInstId: inst.id, error: errMsg } });
      const transient = isTransientLlmTransportError(errMsg);
      return {
        ok: false,
        executionLog,
        lastContent,
        failure: makeFailure(
          inst,
          node,
          `LLM 调用失败：${errMsg}`,
          executionLog,
          transient ? 'low' : 'high',
          transient,
          errMsg,
        ),
      };
    }

    lastContent = result.content ?? '';

    if (!result.toolCalls || result.toolCalls.length === 0) {
      const terminal = detectTerminal(lastContent);
      if (terminal.abort) {
        logger.info('base-node', { event: 'terminal_failure', data: { nodeInstId: inst.id, transient: terminal.transient } });
        return {
          ok: false,
          executionLog,
          lastContent,
          failure: makeFailure(
            inst,
            node,
            terminal.reason || '节点放弃执行',
            executionLog,
            terminal.transient ? 'low' : 'high',
            terminal.transient,
            lastContent.slice(-1024),
          ),
        };
      }
      // 自然完成 → 机械验票（§6.7）
      const completion = validateNodeCompletion({
        node,
        inst,
        workDir: ctx.workDir,
        lastContent,
        executionLog,
      });
      if (completion.status === 'failed') {
        const reason = `输出契约未满足：${completion.missing.join('; ')}`;
        logger.warn('base-node', {
          event: 'acceptance_failed',
          data: { nodeInstId: inst.id, missing: completion.missing },
        });
        return {
          ok: false,
          status: 'failed',
          executionLog,
          lastContent,
          failure: makeFailure(inst, node, reason, executionLog, 'high', false, lastContent.slice(-1024)),
        };
      }
      logger.info('base-node', { event: 'done', data: { nodeInstId: inst.id, rounds: round, tools: executionLog.length } });
      return { ok: true, status: 'ok', outputs: completion.outputs, executionLog, lastContent };
    }

    let assistantMsg: Message = {
      role: 'assistant',
      content: lastContent,
      tool_calls: result.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })),
    };
    const toolResultMsgs: Message[] = [];
    const roundToolOk: boolean[] = [];

    for (const tc of result.toolCalls) {
      if (allowed && !allowed.has(tc.name)) {
        toolResultMsgs.push({
          role: 'tool',
          content: JSON.stringify({ ok: false, output: `工具 ${tc.name} 不在本节点 allowlist 内` }),
          tool_call_id: tc.id,
        });
        executionLog.push({ toolName: tc.name, args: tc.args, result: { ok: false, output: 'not allowed' } });
        roundToolOk.push(false);
        continue;
      }
      const tool = toolRegistry.get(tc.name);
      if (!tool) {
        toolResultMsgs.push({
          role: 'tool',
          content: JSON.stringify({ ok: false, output: `Unknown tool: ${tc.name}` }),
          tool_call_id: tc.id,
        });
        executionLog.push({ toolName: tc.name, args: tc.args, result: { ok: false, output: `Unknown tool: ${tc.name}` } });
        roundToolOk.push(false);
        continue;
      }
      let toolResult: { ok: boolean; output: string };
      if (tc.name === 'write_file') {
        const filePath = String(tc.args['path'] ?? '');
        const content = String(tc.args['content'] ?? '');
        const modeRaw = String(tc.args['mode'] ?? 'overwrite').trim().toLowerCase();
        const mode = modeRaw === 'append' ? 'append' : 'overwrite';
        const rel = normalizeWorkRelPath(ctx.workDir, filePath);
        if (isRejectedWriteContent(content)) {
          toolResultMsgs.push({
            role: 'tool',
            content: JSON.stringify({ ok: false, output: REJECTED_WRITE_CONTENT_MSG }),
            tool_call_id: tc.id,
          });
          executionLog.push({ toolName: tc.name, args: tc.args, result: { ok: false, output: REJECTED_WRITE_CONTENT_MSG } });
          roundToolOk.push(false);
          continue;
        }
        if (
          isWriteFileOverwriteGuardEnabled() &&
          mode === 'overwrite' &&
          rel &&
          committedOverwritePaths.has(rel)
        ) {
          toolResultMsgs.push({
            role: 'tool',
            content: JSON.stringify({ ok: false, output: REJECTED_OVERWRITE_MSG }),
            tool_call_id: tc.id,
          });
          executionLog.push({ toolName: tc.name, args: tc.args, result: { ok: false, output: REJECTED_OVERWRITE_MSG } });
          roundToolOk.push(false);
          continue;
        }
      }
      const t0 = Date.now();
      recordInnerToolCall({
        dataRoot: auditPaths.dataRoot,
        workspaceId: auditPaths.workspaceId,
        module: 'base-node',
        nodeInstId: inst.id,
        ...(ctx.burstId ? { burstId: ctx.burstId } : {}),
        reactRound: round,
        toolName: tc.name,
        args: tc.args,
      });
      try {
        toolResult = await tool.call(tc.args);
      } catch (e) {
        toolResult = { ok: false, output: String(e) };
      }
      if (tc.name === 'shell_exec' && toolResult.ok && shellOutputLooksFailed(toolResult.output)) {
        toolResult = {
          ok: false,
          output: `[shell-evidence] 输出含失败信号（404/非零退出等），不得视为成功：${toolResult.output.slice(0, 1200)}`,
        };
      }
      if (tc.name === 'shell_exec') {
        const cmd = String(tc.args['command'] ?? '');
        const stall = shellStall.record(cmd, toolResult.ok);
        if (stall.stalled) {
          logger.warn('base-node', {
            event: 'shell_stall',
            data: { nodeInstId: inst.id, reason: stall.reason },
          });
          return {
            ok: false,
            executionLog,
            lastContent,
            failure: makeFailure(inst, node, stall.reason, executionLog, 'low', true, lastContent.slice(-1024)),
          };
        }
      }
      recordInnerToolResult({
        dataRoot: auditPaths.dataRoot,
        workspaceId: auditPaths.workspaceId,
        module: 'base-node',
        nodeInstId: inst.id,
        ...(ctx.burstId ? { burstId: ctx.burstId } : {}),
        reactRound: round,
        toolName: tc.name,
        ok: toolResult.ok,
        output: toolResult.output,
        durationMs: Date.now() - t0,
      });
      const compressed = {
        ok: toolResult.ok,
        output: compressToolOutputForContext(toolResult.output, {
          spill: {
            workDir: ctx.workDir,
            round,
            toolName: tc.name,
            toolCallId: tc.id,
          },
        }),
      };
      roundToolOk.push(toolResult.ok);
      executionLog.push({ toolName: tc.name, args: tc.args, result: compressed });
      toolResultMsgs.push({ role: 'tool', content: JSON.stringify(compressed), tool_call_id: tc.id });
      if (isWriteFileOverwriteGuardEnabled() && toolResult.ok && tc.name === 'write_file') {
        const modeRaw = String(tc.args['mode'] ?? 'overwrite').trim().toLowerCase();
        if (modeRaw !== 'append') {
          const rel = normalizeWorkRelPath(ctx.workDir, String(tc.args['path'] ?? ''));
          if (rel) committedOverwritePaths.add(rel);
        }
      }
    }

    if (roundHadToolProgress(roundToolOk)) {
      noProgressStreak = 0;
    } else {
      noProgressStreak += 1;
      const failFastStreak = budgetCfg.failFastStreak ?? 5;
      if (noProgressStreak >= failFastStreak) {
        const reason = `连续 ${failFastStreak} 轮工具调用均无 ok:true 进展`;
        logger.warn('base-node', {
          event: 'fail_fast',
          data: { nodeInstId: inst.id, streak: noProgressStreak },
        });
        return {
          ok: false,
          executionLog,
          lastContent,
          failure: makeFailure(inst, node, reason, executionLog, 'low', true, lastContent.slice(-1024)),
        };
      }
    }

    messages = pruneReActMessages([...messages, assistantMsg, ...toolResultMsgs]);
  }

  // 达到安全上限：按 transient 失败上交（可能只是没收敛）
  logger.warn('base-node', { event: 'safety_cap', data: { nodeInstId: inst.id, cap: budgetCfg.maxRounds } });
  return {
    ok: false,
    status: 'capped',
    executionLog,
    lastContent,
    failure: makeFailure(
      inst,
      node,
      `达到安全轮次上限（${budgetCfg.maxRounds}）仍未收敛`,
      executionLog,
      'low',
      true,
      lastContent.slice(-1024),
    ),
  };
  } finally {
    await closeBrowserSessionsForNode(inst.id).catch(() => {});
    clearBrowserSessionScope();
  }
}

function collectOutputs(node: LocalNode, lastContent: string): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  for (const o of node.interface.outputs) {
    outputs[o.key] = lastContent;
  }
  if (node.interface.outputs.length === 0) outputs['result'] = lastContent;
  return outputs;
}

function makeFailure(
  inst: NodeInst,
  node: LocalNode,
  summary: string,
  log: ExecutionEntry[],
  confidence: 'high' | 'low',
  transient: boolean,
  rawTail?: string,
): FailureSummary {
  const attempted = [...new Set(log.map(e => e.toolName))].filter(n => !n.startsWith('__'));
  return {
    nodeInstId: inst.id,
    localRef: node.id,
    summary,
    attempted,
    confidence,
    transient,
    ...(rawTail ? { rawTail } : {}),
    at: new Date().toISOString(),
  };
}

/** 本轮是否至少有一个工具返回 ok:true（无工具调用不算无进展轮） */
export function roundHadToolProgress(roundToolOk: boolean[]): boolean {
  return roundToolOk.some(ok => ok);
}

/** 测试辅助：暴露内部纯函数 */
export const __internal = {
  detectTerminal,
  buildUserMessage,
  formatDeliverableForPrompt,
  collectOutputs,
  roundHadToolProgress,
  buildRuntimeContextSection,
  pruneReActMessages,
};
