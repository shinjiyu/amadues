/**
 * actionLog — 结构化动作日志（ADL: TOOL-MDL-GROWTH.md M3 / M10）
 *
 * 外循环的挖掘语料。两条硬约束：
 *  - M3：`args` 必须是规范化字典。存成字符串 blob 则反合一无法进行，且事后补不回来。
 *  - M10：`actionTokens` 与 `obsTokens` 分开计。主项是进入上下文的观测 token。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 观测的两种性质（M12）。**这一分类决定 obsTokens 能否记为「可省」**：
 *  - `acquisition`：观测本身就是它的价值。信息仍须送达 agent，封进工具也省不掉
 *  - `intermediate`：中间产物，可丢弃；这才是工具能吞掉的那部分
 */
export type ObsKind = 'acquisition' | 'intermediate';

export interface TraceRecord {
  runId: string;
  step: number;
  /** 挖掘字母表：shell 动作取 argv[0]，工具动作取工具名 */
  symbol: string;
  args: Record<string, unknown>;
  obsDigest: string;
  obsTokens: number;
  actionTokens: number;
  ok: boolean;
  /** M12；由内核在 run 结束时机械判定。缺失按 `intermediate` 处理（向后兼容） */
  obsKind?: ObsKind;
}

const EMPTY_SYMBOL = '<empty>';
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** 粗粒度 token 估算；口径统一即可，不追求与具体 tokenizer 一致 */
export function countTokens(text: string): number {
  return Math.ceil((text ?? '').length / 4);
}

/** 从 shell 命令抽出 argv[0] 作为符号；跳过 `FOO=1` 形式的环境前缀 */
export function symbolOf(command: string): string {
  const parts = (command ?? '').trim().split(/\s+/).filter(Boolean);
  const head = parts.find(p => !ENV_ASSIGN.test(p));
  if (!head) return EMPTY_SYMBOL;
  const base = head.split('/').pop();
  return base && base.length > 0 ? base : EMPTY_SYMBOL;
}

function digest(text: string): string {
  return createHash('sha256').update(text ?? '').digest('hex').slice(0, 16);
}

export function validateTraceRecord(rec: unknown): string[] {
  const errs: string[] = [];
  if (typeof rec !== 'object' || rec === null) return ['record must be an object'];
  const r = rec as Record<string, unknown>;

  if (typeof r.runId !== 'string' || r.runId.length === 0) errs.push('runId must be a non-empty string');
  if (typeof r.step !== 'number' || !Number.isInteger(r.step) || r.step < 0) errs.push('step must be a non-negative integer');
  if (typeof r.symbol !== 'string' || r.symbol.length === 0) errs.push('symbol must be a non-empty string');

  // M3：字符串 blob / 数组都不合法
  if (typeof r.args !== 'object' || r.args === null || Array.isArray(r.args)) {
    errs.push('args must be a structured object (M3: string blobs are not minable)');
  }

  if (typeof r.obsDigest !== 'string' || r.obsDigest.length === 0) errs.push('obsDigest must be a non-empty string');
  if (typeof r.obsTokens !== 'number' || r.obsTokens < 0) errs.push('obsTokens must be a number (M10)');
  if (typeof r.actionTokens !== 'number' || r.actionTokens < 0) errs.push('actionTokens must be a number (M10)');
  if (typeof r.ok !== 'boolean') errs.push('ok must be a boolean');
  if (r.obsKind !== undefined && r.obsKind !== 'acquisition' && r.obsKind !== 'intermediate') {
    errs.push('obsKind must be acquisition | intermediate (M12)');
  }

  return errs;
}

/** `$2` 这类列引用必须能成词——获取步的信息往往就藏在这种单字符后缀里 */
const TOKEN = /[$A-Za-z0-9_./-]{2,}/g;

function tokensOf(text: string): Set<string> {
  return new Set((text ?? '').toLowerCase().match(TOKEN) ?? []);
}

/**
 * M12 的机械判定：观测 i 是否被**后续动作消费**。
 *
 * 判据——只有 i 首次引入、且出现在后续某个动作参数里的 token，才说明 agent 真的
 * 从这条观测里取走了信息。取不走信息的观测就是中间产物，可被工具吞掉。
 *
 * 这不是模型判断：只用 token 集合的差与交，可复算、可测。
 * 已知局限：若 agent 在后续动作里回显了中间结果（如把行数打回去），会误判为获取步，
 * 方向是保守的（少记节省，宁拒不误收）。
 */
export function classifyObservations(input: {
  task: string;
  steps: Array<{ observation: string; actionText: string }>;
}): ObsKind[] {
  const { steps } = input;
  const laterActionTokens: Array<Set<string>> = [];
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const acc = new Set(i + 1 < steps.length ? laterActionTokens[steps.length - 1 - (i + 1)] : []);
    for (const t of tokensOf(steps[i].actionText)) acc.add(t);
    laterActionTokens[steps.length - 1 - i] = acc;
  }

  const seen = tokensOf(input.task);
  const kinds: ObsKind[] = [];

  for (let i = 0; i < steps.length; i += 1) {
    for (const t of tokensOf(steps[i].actionText)) seen.add(t);

    const novel = [...tokensOf(steps[i].observation)].filter(t => !seen.has(t));
    const later = i + 1 < steps.length ? laterActionTokens[steps.length - 1 - (i + 1)] : new Set<string>();
    kinds.push(novel.some(t => later.has(t)) ? 'acquisition' : 'intermediate');

    for (const t of tokensOf(steps[i].observation)) seen.add(t);
  }

  return kinds;
}

export function createTraceRecord(input: {
  runId: string;
  step: number;
  /** shell 命令；工具调用时传 undefined 并给 symbol */
  command?: string;
  symbol?: string;
  args: Record<string, unknown>;
  observation: string;
  /**
   * 实际进入上下文的观测（截断后）。M10 记的是**上下文成本**，不是执行器产出量：
   * 拿截断前的长度记账会让 `savedTokensPerUse` 把从未进过上下文的 token 算成可省，
   * ΔL 随之荒谬地偏负。省略则退回 `observation`。
   */
  shownObservation?: string;
  ok: boolean;
}): TraceRecord {
  const symbol = input.symbol ?? symbolOf(input.command ?? '');
  const actionText = input.command ?? `${symbol} ${JSON.stringify(input.args)}`;
  return {
    runId: input.runId,
    step: input.step,
    symbol,
    args: input.args,
    obsDigest: digest(input.observation),
    obsTokens: countTokens(input.shownObservation ?? input.observation),
    actionTokens: Math.max(1, countTokens(actionText)),
    ok: input.ok,
  };
}

function tracePath(workDir: string, runId: string): string {
  return path.join(workDir, 'runs', runId, 'trace.jsonl');
}

/** 追加一条；校验不过则抛出且**不**落盘 */
export function appendTrace(workDir: string, rec: TraceRecord): void {
  const errs = validateTraceRecord(rec);
  if (errs.length > 0) throw new Error(`invalid TraceRecord: ${errs.join('; ')}`);
  const file = tracePath(workDir, rec.runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
}

/** 整段覆写。`obsKind` 要等 run 结束才判得出，所以必须能回填（M12） */
export function rewriteTrace(workDir: string, runId: string, recs: TraceRecord[]): void {
  for (const rec of recs) {
    const errs = validateTraceRecord(rec);
    if (errs.length > 0) throw new Error(`invalid TraceRecord: ${errs.join('; ')}`);
  }
  const file = tracePath(workDir, runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, recs.map(r => `${JSON.stringify(r)}\n`).join(''), 'utf8');
}

export function readTrace(workDir: string, runId: string): TraceRecord[] {
  const file = tracePath(workDir, runId);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as TraceRecord);
}
