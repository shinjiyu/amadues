/**
 * reactKernel — 冻结的最小内循环（ADL: TOOL-MDL-GROWTH.md M1 / M2）
 *
 * 不可变解释器 + 可变数据：内核不读自己、不写自己、不把自己发给模型。
 * 唯一终结符是 shell_exec；被学到的工具经 toolIndex 进入词汇表——那一步是
 * 内核的固定约定，不是一个动作。自改写在本设计中不存在。
 */
import {
  appendTrace,
  classifyObservations,
  countTokens,
  createTraceRecord,
  rewriteTrace,
  symbolOf,
  type TraceRecord,
} from './action-log.js';
import { buildToolIndex, renderToolIndex } from './tool-index.js';

/** 供测试断言「内核源码从不进 prompt」 */
export const KERNEL_SOURCE_FILES = [
  'react-kernel.ts',
  'tool-index.ts',
  'action-log.ts',
  'trace-miner.ts',
  'mdl-account.ts',
] as const;

export interface KernelCall {
  name: string;
  args: Record<string, unknown>;
}

export interface KernelLlmReply {
  thought?: string;
  done: boolean;
  answer?: string;
  call?: KernelCall;
}

export type KernelLlmPort = (prompt: string) => Promise<KernelLlmReply>;

export type KernelExecutorPort = (call: KernelCall) => Promise<{ ok: boolean; observation: string }>;

export interface KernelOptions {
  workDir: string;
  runId: string;
  task: string;
  llm: KernelLlmPort;
  executor: KernelExecutorPort;
  budgetSteps: number;
  maxObservationChars?: number;
  /** 仅对照臂 A（M11）：把 create_tool 放进内循环动作空间。默认关 */
  inlineCreateTool?: boolean;
  /**
   * 是否在 prompt 里事先告知观测截断上限。默认**关**。
   * §11.11 曾主张默认开；§11.14 析因表明：在 reports 族上单独打开就会
   * 把每任务步数压垮、库归零，且正确率并未改善。需要时显式打开。
   */
  announceObservationLimit?: boolean;
  allowAcquisition?: boolean;
  /**
   * 是否在提示里把「结束」当成合法出口。默认开（短任务自己宣布完成）。
   * 长程改代码时关掉：结束由调用方按仓库状态接受，而不是模型说了算。
   */
  offerFinish?: boolean;
  /** 只把最近 N 步放进提示。默认全量。长轨迹否则把截断观测堆满上下文。 */
  maxHistorySteps?: number;
}

export interface KernelResult {
  done: boolean;
  answer?: string;
  steps: number;
  stopReason: 'done' | 'budget';
  actionTokens: number;
  observationTokens: number;
}

const DEFAULT_MAX_OBS_CHARS = 2_000;

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncated ${text.length - limit} chars]`;
}

function buildPrompt(input: {
  task: string;
  toolIndexText: string;
  history: string[];
  stepsLeft: number;
  inlineCreateTool: boolean;
  maxObservationChars: number;
  announceObservationLimit: boolean;
  offerFinish: boolean;
  historyNote: string;
}): string {
  const actions = [
    '- shell_exec(command: string): run a shell command, returns its output',
    ...(input.inlineCreateTool
      ? [
          // 臂 A 必须能造出**带参**工具，否则是稻草人：无参工具天然不可复用
          '- create_tool(name: string, description: string, args: object, body: string):',
          '    define a reusable tool available to every later task. `args` maps arg name to',
          '    {"type":"string","required":true}. `body` is a script reading a JSON object of',
          '    args on stdin. Create one when you expect to need the same work again.',
        ]
      : []),
  ].join('\n');

  return [
    input.offerFinish
      ? 'You are solving one task. Reply with a single action, or finish.'
      : 'You are solving one task. Reply with a single action. Do not finish until the required change is committed.',
    '',
    `TASK: ${input.task}`,
    '',
    'PRIMITIVE ACTIONS:',
    actions,
    '',
    'LEARNED TOOLS:',
    input.toolIndexText,
    '',
    // 不告知上限时模型会用 glob 一次性 dump 再在被截断的观测上猜答案（P2 实测）
    ...(input.announceObservationLimit
      ? [
          `OBSERVATION LIMIT: output beyond ${input.maxObservationChars} chars is discarded.`,
          'Prefer commands whose output fits; split the work across steps if it does not.',
          '',
        ]
      : []),
    `STEPS LEFT: ${input.stepsLeft}`,
    '',
    'HISTORY:',
    input.historyNote,
    input.history.length > 0 ? input.history.join('\n') : '(empty)',
  ].join('\n');
}

export async function runReactKernel(opts: KernelOptions): Promise<KernelResult> {
  const maxObs = opts.maxObservationChars ?? DEFAULT_MAX_OBS_CHARS;
  const history: string[] = [];
  let steps = 0;
  let actionTokens = 0;
  let observationTokens = 0;

  // M12：获取/中间之分要看**后续**动作有没有消费该观测，所以只能在 run 结束时回填
  const records: TraceRecord[] = [];
  const classifyInput: Array<{ observation: string; actionText: string }> = [];
  const persistKinds = (): void => {
    if (records.length === 0) return;
    const kinds = classifyObservations({ task: opts.task, steps: classifyInput });
    rewriteTrace(
      opts.workDir,
      opts.runId,
      records.map((r, i) => ({ ...r, obsKind: kinds[i] })),
    );
  };

  while (steps < opts.budgetSteps) {
    const index = buildToolIndex(opts.workDir, { allowAcquisition: opts.allowAcquisition });
    const window = opts.maxHistorySteps && opts.maxHistorySteps > 0
      ? history.slice(-opts.maxHistorySteps)
      : history;
    const omitted = history.length - window.length;
    const prompt = buildPrompt({
      task: opts.task,
      toolIndexText: renderToolIndex(index),
      history: window,
      historyNote: omitted > 0 ? `(${omitted} earlier steps omitted)` : '',
      stepsLeft: opts.budgetSteps - steps,
      inlineCreateTool: opts.inlineCreateTool === true,
      maxObservationChars: maxObs,
      announceObservationLimit: opts.announceObservationLimit === true,
      offerFinish: opts.offerFinish !== false,
    });

    const reply = await opts.llm(prompt);
    if (reply.done || !reply.call) {
      persistKinds();
      return {
        done: true,
        answer: reply.answer,
        steps,
        stopReason: 'done',
        actionTokens,
        observationTokens,
      };
    }

    const call = reply.call;
    const { ok, observation } = await opts.executor(call);
    const shown = clip(observation, maxObs);

    const command = typeof call.args.command === 'string' ? call.args.command : undefined;
    const rec = createTraceRecord({
      runId: opts.runId,
      step: steps,
      command,
      symbol: call.name === 'shell_exec' ? symbolOf(command ?? '') : call.name,
      args: call.args,
      observation,
      shownObservation: shown,
      ok,
    });
    appendTrace(opts.workDir, rec);
    records.push(rec);
    classifyInput.push({
      observation: shown,
      actionText: command ?? `${call.name} ${JSON.stringify(call.args)}`,
    });

    actionTokens += rec.actionTokens;
    observationTokens += countTokens(shown);
    history.push(`#${steps} ${call.name} ${JSON.stringify(call.args)}\n-> ${ok ? '' : '[failed] '}${shown}`);
    steps += 1;
  }

  persistKinds();
  return { done: false, steps, stopReason: 'budget', actionTokens, observationTokens };
}
