/**
 * 空口承诺对账（post-loop）— 用户祈使做事 + 口头答应 + 无成功派活 → 强制再跑一轮工具环。
 * @see doc/structurizr/IM-INBOUND-INTENT-ROUTING.md §4.2
 */
import { classifyImInboundIntent } from './inbound/im-intent-classifier.js';
import { isSetGoalDispatched } from './inner-brain-kpi-reuse.js';
import { isToolOutputOk } from './outer-tool-audit.js';

export interface OuterToolResultSnap {
  name: string;
  output: string;
}

/** 算「已动手」的派活/登记类工具（成功输出才算） */
export const WORK_ACTION_TOOLS = new Set([
  'set_goal',
  'advance_kpi',
  'workflow_run',
  'workflow_promote',
  'set_kpi',
  'schedule_commitment',
  'send_directive',
  'start_self_update',
]);

/** 用户高置信「要做事」——与前置 ad-hoc/KPI 信号对齐，并补 EW / 催促 */
const EXTRA_WORK_REQUEST_RE =
  /固化|晋升|再跑一次|按上次|不要摸索|工作流|workflow|派内脑|去改|去修|去跑|立刻(?:去)?(?:改|修|跑|查|做)|马上(?:去)?(?:改|修|跑|查|做)|赶紧|继续做|再试一下|再弄一下/i;

/** 口头承诺「已派 / 我去办」——问句不算 */
const WORK_COMMITMENT_RE =
  /(?:我去|我来|这就|马上|这就去|我这就)(?:办|做|查|改|修|跑|派|安排|处理|搞|开跑)|已(?:经)?(?:派|开跑|启动|安排)(?:了|内脑|任务)?|交给内脑|派给内脑|开跑了|已开跑|安排内脑|这就办|马上办|好的[，,]?\s*我(?:去|来)|收到[，,]?\s*我(?:去|来)|我这就去/i;

const COMMITMENT_QUESTION_RE = /[？?]|要我|要不要|确认一下|还没派/;

export function isUserWorkRequest(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const intent = classifyImInboundIntent(t);
  if (
    intent.kind === 'ad_hoc_task' ||
    intent.kind === 'kpi_create' ||
    intent.kind === 'kpi_update' ||
    intent.kind === 'task_followup'
  ) {
    return true;
  }
  return EXTRA_WORK_REQUEST_RE.test(t);
}

export function isAgentWorkCommitment(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (COMMITMENT_QUESTION_RE.test(t)) return false;
  return WORK_COMMITMENT_RE.test(t);
}

export function isSuccessfulWorkAction(toolName: string, output: string): boolean {
  if (!WORK_ACTION_TOOLS.has(toolName)) return false;
  if (!isToolOutputOk(output)) return false;
  switch (toolName) {
    case 'set_goal':
    case 'workflow_run':
    case 'start_self_update':
      return isSetGoalDispatched(output) || output.includes('已启动受控 self-update');
    case 'advance_kpi':
      return output.includes('KPI 推进成功') || isSetGoalDispatched(output);
    case 'set_kpi':
      return output.includes('KPI 已创建');
    case 'schedule_commitment':
      return /已(?:创建|更新|存在)日历承诺/.test(output);
    case 'workflow_promote':
      return output.includes('已晋升');
    case 'send_directive':
      return output.includes('指令已写入');
    default:
      return false;
  }
}

export function hasSuccessfulWorkAction(results: OuterToolResultSnap[]): boolean {
  return results.some((r) => isSuccessfulWorkAction(r.name, r.output));
}

export function shouldReconcileEmptyPromise(opts: {
  userMessage: string;
  replyTexts: string[];
  toolResults: OuterToolResultSnap[];
}): boolean {
  if (!isUserWorkRequest(opts.userMessage)) return false;
  if (!opts.replyTexts.some((t) => isAgentWorkCommitment(t))) return false;
  if (hasSuccessfulWorkAction(opts.toolResults)) return false;
  return true;
}

export const EMPTY_PROMISE_RECOVERY_SYSTEM = (
  '【系统空口对账】你刚才口头答应做事，但本轮没有成功调用派活工具' +
  '（set_goal / advance_kpi / workflow_run / workflow_promote / set_kpi / schedule_commitment / send_directive）。' +
  '现在必须二选一：① 立刻调用相应工具真正开跑/登记；② 用 reply_to_user 改口说明「还没派，要我现在开跑吗？」——禁止再空口承诺已开跑。'
);
