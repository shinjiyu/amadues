/**
 * toolReplayGate — 确定性验收（ADL: TOOL-MDL-GROWTH.md M5 / M5a / M5b）
 *
 * 候选工具拿**挖掘时那些历史实例**重放，比对结果。这是整套设计里唯一便宜的
 * 那种验证：逐个可判定、不需要 benchmark、不吃统计联合界。
 * 夹具与工具同目录存放，因此它同时是永久回归。
 *
 * M5a / M5b 是 P2 踩出来的：闸门曾经自指（拿候选自己的输出当 expected），
 * 且曾经用原始观测文本比对（工具的目的就是让观测变短）。本模块把这两条
 * 收成可调用的 API，而不是只写在 ADL 里。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface ReplayFixture {
  args: Record<string, unknown>;
  expected: string;
  /**
   * M5a：expected 从哪来。缺省在 `validateAcceptFixtures` 里视为违规——
   * 不强制标注就拦不住「跑候选自己」那种自指夹具。
   */
  provenance?: ExpectedProvenance;
}

/**
 * M5a：期望值的来源。`candidate_self` 永远非法——闸门恒过、等于没有。
 * 合法的只有「重跑原始实例」或「域外神谕」。
 */
export type ExpectedProvenance =
  | { kind: 'original_replay' }
  | { kind: 'external'; note?: string };

export type ToolRunner = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ ok: boolean; output: string }>;

export interface ReplayMismatch {
  index: number;
  reason: 'error' | 'mismatch';
  expected?: string;
  actual?: string;
}

export interface ReplayVerdict {
  pass: boolean;
  total: number;
  passed: number;
  mismatches: ReplayMismatch[];
}

export interface ReplayOptions {
  /** 归一化尾随空白后比对；关掉则严格逐字 */
  normalize?: boolean;
}

function norm(text: string, on: boolean): string {
  return on ? text.replace(/\s+$/gm, '').trim() : text;
}

export async function replayTool(
  name: string,
  fixtures: ReplayFixture[],
  runner: ToolRunner,
  opts: ReplayOptions = {},
): Promise<ReplayVerdict> {
  const normalize = opts.normalize !== false;
  const mismatches: ReplayMismatch[] = [];
  let passed = 0;

  for (let i = 0; i < fixtures.length; i += 1) {
    const f = fixtures[i];
    let res: { ok: boolean; output: string };
    try {
      res = await runner(name, f.args);
    } catch {
      mismatches.push({ index: i, reason: 'error' });
      continue;
    }
    if (!res.ok) {
      mismatches.push({ index: i, reason: 'error', actual: res.output });
      continue;
    }
    if (norm(res.output, normalize) !== norm(f.expected, normalize)) {
      mismatches.push({ index: i, reason: 'mismatch', expected: f.expected, actual: res.output });
      continue;
    }
    passed += 1;
  }

  // 无夹具即无验收：M5 下不得放行
  const pass = fixtures.length > 0 && mismatches.length === 0;
  return { pass, total: fixtures.length, passed, mismatches };
}

// ───────────────────────────── M5a ─────────────────────────────

/**
 * 收录前的夹具合法性（M5a）。`replayTool` 本身只比字符串相等，拦不住自指；
 * 这一层强制声明 provenance，并把 `candidate_self` 拒掉。
 */
export function validateAcceptFixtures(fixtures: ReplayFixture[]): string[] {
  const errs: string[] = [];
  if (fixtures.length === 0) {
    errs.push('empty fixtures: no acceptance without replay (M5)');
    return errs;
  }
  for (let i = 0; i < fixtures.length; i += 1) {
    const f = fixtures[i];
    if (!f.expected || !String(f.expected).trim()) {
      errs.push(`fixture#${i}: empty expected`);
      continue;
    }
    const p = f.provenance;
    if (!p) {
      errs.push(`fixture#${i}: missing provenance (M5a: expected must be independently derived)`);
      continue;
    }
    if ((p as { kind: string }).kind === 'candidate_self') {
      errs.push(
        `fixture#${i}: provenance=candidate_self is self-referential (M5a: gate would always pass)`,
      );
    } else if (p.kind !== 'original_replay' && p.kind !== 'external') {
      errs.push(`fixture#${i}: unknown provenance kind`);
    }
  }
  return errs;
}

/**
 * 从「原始实例效果」构造夹具。调用方必须提供**不经过候选工具**的效果函数——
 * 这是把 M5a 编进类型的方式：API 形状本身拒绝自指。
 */
export async function buildFixturesFromOriginal(input: {
  bindings: Record<string, unknown>[];
  /** 对第 i 个绑定，重跑挖掘时的原始实例，返回效果摘要；无效果则返回 null（跳过） */
  originalEffect: (index: number, args: Record<string, unknown>) => Promise<string | null>;
}): Promise<ReplayFixture[]> {
  const out: ReplayFixture[] = [];
  for (let i = 0; i < input.bindings.length; i += 1) {
    const args = input.bindings[i];
    const expected = await input.originalEffect(i, args);
    if (!expected) continue;
    out.push({ args, expected, provenance: { kind: 'original_replay' } });
  }
  return out;
}

// ───────────────────────────── M5b ─────────────────────────────

/**
 * 产物效果摘要。比对的是「写了什么文件」，不是 stdout——工具可以（也应该）
 * 把中间观测压掉。
 */
export function artifactEffectDigest(content: string, name = 'out.csv'): string {
  const lines = content.split('\n').filter(l => l.length > 0).length;
  const sha = createHash('sha256').update(content).digest('hex').slice(0, 16);
  return `artifact=${name} lines=${lines} sha=${sha}`;
}

/**
 * 信息投影效果摘要。纯只读工具无产物时用：效果 = 抽出的事实集，不是原文。
 * 事实本身由端口按域投影；本函数只负责稳定序列化。
 */
export function factsEffectDigest(facts: Iterable<string>): string {
  const sorted = [...new Set(facts)].filter(f => f.length > 0).sort();
  return sorted.length > 0 ? `facts=${sorted.join('|')}` : '';
}

/** 拼装多段效果摘要。空段丢弃；全空则返回空串（调用方应视为「无可验收效果」）。 */
export function composeEffectDigest(...parts: Array<string | null | undefined>): string {
  return parts.map(p => (p ?? '').trim()).filter(p => p.length > 0).join(' ');
}

// ───────────────────────────── 持久化 ─────────────────────────────

function fixturePath(workDir: string, name: string): string {
  return path.join(workDir, 'tools', name, 'tests.jsonl');
}

export function writeFixtures(workDir: string, name: string, fixtures: ReplayFixture[]): void {
  const file = fixturePath(workDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, fixtures.map(f => JSON.stringify(f)).join('\n') + (fixtures.length ? '\n' : ''), 'utf8');
}

export function readFixtures(workDir: string, name: string): ReplayFixture[] {
  const file = fixturePath(workDir, name);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as ReplayFixture);
}
