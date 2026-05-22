/**
 * 异步等待工具：ask_user / wait_timer / wake_signal
 *
 * 设计文档：doc/agent-data-state-machine.md §5
 *
 * 哲学：
 *   - 工具调用本身写一条 pending 数据到 .brain/pendings.json
 *   - 工具立即返回 { status: "pending", pending_id: "..." }（不阻塞）
 *   - LLM 看到 pending 后应当停止调用工具，让本轮执行结束
 *   - 控制器检测到有未消费的 active pending → 切到 AWAITING 模式 → 进程退出
 *   - ChangeWatcher 在外部事件到达时改 pending 的 status → spawn 新 tick
 *   - 新 tick 中 executor 会把 resolved 的 pending result 注入 LLM 对话上下文
 *
 * 默认 deadline：
 *   - ask_user: 24 小时（防止永远等待）
 *   - wait_timer: 无 deadline（execute_at 本身就是时间）
 *   - wake_signal: 7 天
 */

import path from 'node:path';
import {
  addPending,
  type AskUserSpec,
  type TimerSpec,
  type SignalSpec,
  type OnTimeoutSpec,
  type PendingIntent,
} from '../../pendings/index.js';
import type { Tool } from '../index.js';

// ── 全局注入：worker 启动时调用 setAsyncWaitBrainDir(brainDir) ─────────────────
let _brainDir: string | null = null;

export function setAsyncWaitBrainDir(brainDir: string): void {
  _brainDir = brainDir;
}

function ensureBrainDir(): string {
  if (!_brainDir) throw new Error('async-wait: brainDir not configured');
  return _brainDir;
}

/**
 * 共用的 intent 解析:LLM 传 intent 字段时(可以是 string JSON 或对象)统一解析成 PendingIntent。
 *
 * 接受三种输入格式,容错优先:
 *   1. 完整对象 { expectation, success_signal?, fallback? }
 *   2. JSON 字符串(LLM 偶尔会序列化嵌套对象)
 *   3. 纯字符串(只有 expectation)
 *
 * 不合法或缺 expectation 时返回 undefined(intent 是可选字段)。
 */
function parseIntent(raw: unknown): PendingIntent | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith('{')) {
      try { obj = JSON.parse(trimmed); } catch { return { expectation: trimmed }; }
    } else {
      return { expectation: trimmed };
    }
  }
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  const expectation = typeof o['expectation'] === 'string' ? o['expectation'].trim() : '';
  if (!expectation) return undefined;
  const out: PendingIntent = { expectation };
  if (typeof o['success_signal'] === 'string' && o['success_signal']) {
    out.success_signal = o['success_signal'].trim();
  }
  if (typeof o['fallback'] === 'string' && o['fallback']) {
    out.fallback = o['fallback'].trim();
  }
  return out;
}

// ── 工具：ask_user ────────────────────────────────────────────────────────────

export const askUserTool: Tool = {
  name: 'ask_user',
  description: [
    '向用户提问并等待回复。这是一个【异步】工具：',
    '调用后会把"等用户回复"记录为 pending 数据，本次执行循环应当立即结束',
    '（你不需要再调用其它工具）。外部系统在收到用户回复后，会自动重新启动',
    '一段新的执行循环，并把回复内容注入到对话上下文里。',
    '',
    '使用场景：缺少凭据 / 需要用户决策 / 需要更多信息 / 阻塞性问题。',
    '不要为了"打个招呼"调用此工具——它会真的发送给用户。',
    '',
    '【强烈建议】调用时同时传 intent：',
    '  intent.expectation: "你期望这次问询能获得什么(例：用户给出 sk- 开头的 token)"',
    '  intent.success_signal: "怎样的回复算成功(例：回复包含 sk- 或 token: 前缀)"',
    '  intent.fallback: "如果期望落空,你打算怎么办(例：回复 cancel 则转为探索 OAuth 流)"',
    '这些是你"问之前已经想好的预案"——用户回复后,新一轮执行会把它们再展示给你,',
    '让你"前后呼应"地决策,而不是"重新从零思考"。',
    '',
    'deadline_seconds（可选）：超时秒数，默认 86400（24 小时）。',
    'channel（可选）：指定回复渠道；不填使用任务发起人的默认渠道。',
  ].join('\n'),
  parameters: {
    prompt: { type: 'string', description: '给用户看的问题文本（直接发到 IM）' },
    deadline_seconds: { type: 'number', description: '超时秒数，默认 86400' },
    channel: { type: 'string', description: '回复渠道，可选' },
    intent: { type: 'object', description: '【强烈建议】拟人意图: {expectation, success_signal?, fallback?}。也接受 JSON 字符串。' },
  },
  required: ['prompt'],
  async call(args) {
    const prompt = String(args['prompt'] ?? '').trim();
    if (!prompt) return { ok: false, output: '缺少参数: prompt' };

    const deadlineSec = Number(args['deadline_seconds'] ?? 86400);
    const channel = typeof args['channel'] === 'string' ? args['channel'] : undefined;
    const brainDir = ensureBrainDir();

    const spec: AskUserSpec = { prompt };
    if (channel) spec.channel = channel;
    const deadline = isFinite(deadlineSec) && deadlineSec > 0
      ? new Date(Date.now() + deadlineSec * 1000).toISOString()
      : undefined;
    const on_timeout: OnTimeoutSpec = { action: 'block', reason: `等用户回复超时（${deadlineSec}s）` };
    const intent = parseIntent(args['intent']);

    const item = addPending(brainDir, {
      kind: 'ask_user',
      spec,
      ...(deadline ? { deadline } : {}),
      on_timeout,
      source: 'tool:ask_user',
      ...(intent ? { intent } : {}),
    });

    const output = [
      `[已挂起等待用户回复 pending=${item.id}]`,
      `问题：${prompt}`,
      deadline ? `截止时间：${deadline}` : '',
      intent ? `已记录意图：${intent.expectation}` : '（未记录意图——下次建议传 intent,让前后呼应）',
      '执行循环应当结束。当用户回复后，新一轮执行会注入回复内容 + 你刚才的意图。',
    ].filter(Boolean).join('\n');

    return { ok: true, output };
  },
};

// ── 工具：wait_timer ──────────────────────────────────────────────────────────

export const waitTimerTool: Tool = {
  name: 'wait_timer',
  description: [
    '设置一个定时器，到点后自动唤醒一段新的执行循环。这是【异步】工具：',
    '调用后写入 pending 数据，本次执行循环应当立即结束。',
    '',
    '可用于：',
    '  - 实现常态化监督任务（每 N 分钟检查一次）',
    '  - 等待外部进程稳定后再观察',
    '  - 把"现在不能做、等会儿再做"的任务延后',
    '',
    '参数二选一：',
    '  - delay_seconds: 相对时间（推荐），N 秒后触发',
    '  - execute_at:    ISO 8601 绝对时间',
    '',
    'reason：人类可读的等待原因，会进入 git commit 历史。',
    '',
    '【强烈建议】调用时同时传 intent：',
    '  intent.expectation: "为什么是这个间隔(例：估计 Shiro 编译 10 分钟够了)"',
    '  intent.success_signal: "醒来时要检查什么(例：Shiro tick 数 > 上次记录)"',
    '  intent.fallback: "如果失败,你打算怎么办(例：连续 3 次未推进 → ask_user 升级)"',
    '人类设闹钟时心里盘算的"为什么、怎么验证、不行怎么办"——记下来,醒来时会回注给你。',
  ].join('\n'),
  parameters: {
    delay_seconds: { type: 'number', description: '等待多少秒后触发（与 execute_at 二选一）' },
    execute_at:    { type: 'string', description: '绝对触发时间 ISO 8601（与 delay_seconds 二选一）' },
    reason:        { type: 'string', description: '人类可读的等待原因' },
    intent:        { type: 'object', description: '【强烈建议】拟人意图: {expectation, success_signal?, fallback?}。也接受 JSON 字符串。' },
  },
  required: [],
  async call(args) {
    const brainDir = ensureBrainDir();
    let executeAt: string | null = null;
    const delaySec = Number(args['delay_seconds']);
    const ea = String(args['execute_at'] ?? '').trim();

    if (ea) {
      const t = Date.parse(ea);
      if (!isFinite(t)) return { ok: false, output: 'execute_at 不是合法的 ISO 8601 时间' };
      executeAt = new Date(t).toISOString();
    } else if (isFinite(delaySec) && delaySec >= 0) {
      executeAt = new Date(Date.now() + delaySec * 1000).toISOString();
    } else {
      return { ok: false, output: '必须提供 delay_seconds 或 execute_at' };
    }

    const reason = String(args['reason'] ?? '').trim() || '定时等待';
    const spec: TimerSpec = { execute_at: executeAt };
    const intent = parseIntent(args['intent']);
    const item = addPending(brainDir, {
      kind: 'timer',
      spec,
      source: `tool:wait_timer(${reason.slice(0, 80)})`,
      ...(intent ? { intent } : {}),
    });

    const output = [
      `[已挂起等待定时器 pending=${item.id}]`,
      `触发时间：${executeAt}`,
      `原因：${reason}`,
      intent ? `已记录意图：${intent.expectation}` : '（未记录意图——下次建议传 intent,让前后呼应）',
      '执行循环应当结束。到点后新一轮执行会自动启动 + 你刚才的意图。',
    ].join('\n');

    return { ok: true, output };
  },
};

// ── 工具：wake_signal（命名信号；外部 webhook / 工具触发） ───────────────────

export const waitSignalTool: Tool = {
  name: 'wait_signal',
  description: [
    '等待一个命名信号到达。外部系统（webhook / 其它 agent / Dashboard）',
    '可以通过 POST /api/inner-brains/:id/signal 唤醒。这是【异步】工具：',
    '调用后写入 pending，本次执行循环应当立即结束。',
    '',
    'signal_name：信号名称（外部用此名称唤醒）。',
    'deadline_seconds：超时秒数，默认 604800（7 天）。',
    '',
    '【强烈建议】调用时同时传 intent：',
    '  intent.expectation: "为什么挂这个信号(例：CI 跑完后会推 webhook)"',
    '  intent.success_signal: "醒来时要看什么(例：信号 payload 含 success=true)"',
    '  intent.fallback: "如果触发了但不符合预期(例：失败时重跑一次,2 次都失败 → ask_user)"',
  ].join('\n'),
  parameters: {
    signal_name:      { type: 'string', description: '信号名称' },
    deadline_seconds: { type: 'number', description: '超时秒数，默认 604800' },
    intent:           { type: 'object', description: '【强烈建议】拟人意图: {expectation, success_signal?, fallback?}。也接受 JSON 字符串。' },
  },
  required: ['signal_name'],
  async call(args) {
    const signalName = String(args['signal_name'] ?? '').trim();
    if (!signalName) return { ok: false, output: '缺少参数: signal_name' };
    const brainDir = ensureBrainDir();

    const deadlineSec = Number(args['deadline_seconds'] ?? 604800);
    const deadline = isFinite(deadlineSec) && deadlineSec > 0
      ? new Date(Date.now() + deadlineSec * 1000).toISOString()
      : undefined;
    const spec: SignalSpec = { signal_name: signalName };
    const intent = parseIntent(args['intent']);

    const item = addPending(brainDir, {
      kind: 'signal',
      spec,
      ...(deadline ? { deadline } : {}),
      on_timeout: { action: 'block', reason: `等信号 ${signalName} 超时` },
      source: 'tool:wait_signal',
      ...(intent ? { intent } : {}),
    });

    return {
      ok: true,
      output: [
        `[已挂起等待信号 pending=${item.id}] signal_name=${signalName}`,
        intent ? `已记录意图：${intent.expectation}` : '（未记录意图——下次建议传 intent,让前后呼应）',
        '执行循环应当结束。',
      ].join('\n'),
    };
  },
};

// ── helper: 从 workDir 推断 brainDir，便于 worker 直接注入 workDir ───────────

export function brainDirFromWorkDir(workDir: string): string {
  return path.join(workDir, '.brain');
}
