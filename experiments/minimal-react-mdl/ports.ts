/**
 * 端口实现：真实 shell 执行器 + 真实 LLM（Zhipu）+ 离线 fake。
 *
 * 内核与外循环都不知道这些的存在——它们只吃注入的端口。这一点是刻意的：
 * 冻结内核（M1）意味着换模型、换执行器都不触碰内核。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  KernelExecutorPort,
  KernelLlmPort,
  KernelLlmReply,
} from '../../packages/server/src/openkuroneko/tool-mdl/react-kernel.ts';
import type { AntiUnifyResult, GrowthPorts } from '../../packages/server/src/openkuroneko/tool-mdl/growth-cycle.ts';
import {
  artifactEffectDigest,
  buildFixturesFromOriginal,
  composeEffectDigest,
  factsEffectDigest,
  replayTool,
  type ToolRunner,
} from '../../packages/server/src/openkuroneko/tool-mdl/tool-replay-gate.ts';
import {
  validateToolManifest,
  type ToolManifest,
} from '../../packages/server/src/openkuroneko/tool-mdl/tool-manifest.ts';
import type { ToolCandidate } from '../../packages/server/src/openkuroneko/tool-mdl/trace-miner.ts';
import { captureStages, enforceStageGate } from './stage-gate.ts';

// ───────────────────────────── shell 执行器 ─────────────────────────────

/** 学到的工具目录下的 `run` 可执行文件；调用约定 = stdin JSON args → stdout */
function runLearnedTool(workDir: string, name: string, args: Record<string, unknown>) {
  const bin = path.join(workDir, 'tools', name, 'run');
  if (!fs.existsSync(bin)) return { ok: false, observation: `no such tool: ${name}` };
  const r = spawnSync(bin, {
    cwd: workDir,
    input: JSON.stringify(args),
    encoding: 'utf8',
    timeout: 30_000,
    shell: false,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { ok: r.status === 0, observation: out.length > 0 ? out : '(no output)' };
}

/**
 * 对照臂 A 的 `create_tool`（M11）。与臂 B 的**唯一**区别是谁来决定收录：
 * 这里是模型当场判断，没有挖掘、没有 ΔL、没有重放闸门。
 *
 * 闸门的缺席不是我故意削弱臂 A —— 它是**内在的**：臂 A 前瞻性地造工具，
 * 造的那一刻还没有历史实例可供重放。臂 B 回顾性地造，所以才有夹具可用。
 * 这条不对称本身就是 M11 要量的东西之一。
 *
 * 形式合法性仍然检查（manifest schema、M7 描述预算、M9 kind），否则拿到的
 * 是「模型能否写出合法工具」的噪声，而不是「模型判断能否找准复用点」。
 */
function createToolInline(
  workDir: string,
  args: Record<string, unknown>,
): { ok: boolean; observation: string } {
  const name = String(args.name ?? '').trim();
  const body = String(args.body ?? '');
  if (!name || !body) return { ok: false, observation: 'create_tool needs name and body' };

  const manifest = {
    name,
    description: String(args.description ?? ''),
    args: (args.args ?? {}) as ToolManifest['args'],
    deps: [],
    kind: 'composition' as const,
    createdAt: new Date().toISOString(),
  };
  const errs = validateToolManifest(manifest);
  if (errs.length > 0) return { ok: false, observation: `rejected: ${errs.join('; ')}` };

  const dir = path.join(workDir, 'tools', name);
  if (fs.existsSync(path.join(dir, 'manifest.json'))) {
    return { ok: false, observation: `tool ${name} already exists` };
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'run'), body, { encoding: 'utf8', mode: 0o755 });
  return { ok: true, observation: `created ${name}; available to every later task` };
}

export function makeShellExecutor(
  workDir: string,
  opts?: { stageGate?: boolean; timeoutMs?: number },
): KernelExecutorPort {
  return async call => {
    if (call.name === 'create_tool') return createToolInline(workDir, call.args);
    if (call.name !== 'shell_exec') return runLearnedTool(workDir, call.name, call.args);
    const command = String(call.args.command ?? '');
    if (!command.trim()) return { ok: false, observation: 'empty command' };
    const before = opts?.stageGate ? captureStages(workDir) : null;
    const r = spawnSync('bash', ['-lc', command], {
      cwd: workDir,
      encoding: 'utf8',
      timeout: opts?.timeoutMs ?? 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (before) {
      const gate = enforceStageGate(workDir, before);
      if (!gate.ok) return gate;
    }
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    return { ok: r.status === 0, observation: out.length > 0 ? out : '(no output)' };
  };
}

// ─────────────────── 效果等价的重放（M5a / M5b） ───────────────────

/**
 * 域投影：reports 族从 stdout 抽出「id=latency」事实。
 * 投影规则留在端口；序列化走核心的 `factsEffectDigest`（M5b）。
 */
function projectFacts(text: string): string[] {
  const facts = new Set<string>();
  for (const m of (text ?? '').matchAll(
    /rep-(\w+)[\s\S]{0,400}?Observed handling latency: ([a-z ]+?) milliseconds/g,
  )) {
    facts.add(`${m[1]}=${m[2].trim()}`);
  }
  for (const m of (text ?? '').matchAll(/^\s*(\w{2})\s*[:=,]\s*([a-z ]+?)\s*(?:milliseconds)?$/gm)) {
    facts.add(`${m[1]}=${m[2].trim()}`);
  }
  return [...facts];
}

function effectDigest(dir: string, stdout = ''): string {
  const file = path.join(dir, 'out.csv');
  // 空文件（`: > out.csv`）没有实例间差异，却会和 facts  conjunct。
  // §11.20：模型只复现了空文件、漏了事实，闸门因此失败。
  let artifact = '';
  if (fs.existsSync(file)) {
    const body = fs.readFileSync(file, 'utf8');
    if (body.trim().length > 0) artifact = artifactEffectDigest(body, 'out.csv');
  }
  return composeEffectDigest(artifact, factsEffectDigest(projectFacts(stdout)));
}

/** 沙箱不复制的东西：run 记录与产物。其余语料目录一律软链，否则原始命令在沙箱里会失败 */
const SCRATCH_EXCLUDE = new Set(['runs', 'out.csv', 'report.json']);

/** 隔离沙箱：语料只读共享，产物互不干扰 */
function scratch(workDir: string, tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mdl-${tag}-`));
  for (const entry of fs.readdirSync(workDir)) {
    if (SCRATCH_EXCLUDE.has(entry) || entry.startsWith('rejected-')) continue;
    fs.symlinkSync(path.join(workDir, entry), path.join(dir, entry));
  }
  return dir;
}

/** 重放用 runner：在沙箱里跑工具，上报效果摘要而非 stdout */
export function makeReplayRunner(workDir: string): ToolRunner {
  return async (name, args) => {
    const dir = scratch(workDir, 'tool');
    try {
      const bin = path.join(workDir, 'tools', name, 'run');
      if (!fs.existsSync(bin)) return { ok: false, output: `no such tool: ${name}` };
      const r = spawnSync(bin, {
        cwd: dir,
        input: JSON.stringify(args),
        encoding: 'utf8',
        timeout: 30_000,
      });
      if (r.status !== 0) {
        return { ok: false, output: `exit=${r.status} ${(r.stderr ?? '').slice(0, 300)}` };
      }
      return { ok: true, output: effectDigest(dir, r.stdout ?? '') };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** 期望值的**独立**来源：在沙箱里重跑该实例的原始 shell 命令，取效果摘要 */
function originalEffect(workDir: string, steps: Array<{ args: Record<string, unknown> }>): string | null {
  const dir = scratch(workDir, 'orig');
  let stdout = '';
  try {
    for (const s of steps) {
      const command = String(s.args.command ?? '');
      if (!command) continue;
      const r = spawnSync('bash', ['-lc', command], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      if (r.status !== 0) return null;
      stdout += r.stdout ?? '';
    }
    // 既无产物又投影不出事实 ⇒ 这个实例无法验收，不能当夹具
    return effectDigest(dir, stdout) || null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ───────────────────────────── Zhipu ─────────────────────────────

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

export function firstJsonObject(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  if (start < 0) return null;
  for (let end = body.lastIndexOf('}'); end > start; end = body.lastIndexOf('}', end - 1)) {
    try {
      return JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      /* keep shrinking */
    }
  }
  return null;
}

export async function zhipuChat(
  system: string,
  user: string,
  usage: LlmUsage,
  maxTokens = 1200,
): Promise<string> {
  const apiKey = process.env.ZHIPU_API_KEY?.trim();
  if (!apiKey) throw new Error('ZHIPU_API_KEY missing (use --fake for an offline run)');
  const baseUrl = (
    process.env.ZHIPU_BASE_URL ?? 'https://open.bigmodel.cn/api/coding/paas/v4'
  ).replace(/\/$/, '');
  const model = process.env.ZHIPU_MODEL ?? 'glm-5.1';

  let text = '';
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          max_tokens: maxTokens,
          temperature: attempt === 0 ? 0.2 : 0.5,
          thinking: { type: 'disabled' },
        }),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      lastErr = `ZHIPU fetch failed: ${(e as Error).message}`;
      continue;
    }
    const raw = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      choices?: Array<{ message?: { content?: string } }>;
    };
    if (!res.ok) {
      lastErr = `ZHIPU HTTP ${res.status}: ${raw.error?.message ?? res.statusText}`;
      continue;
    }
    usage.calls += 1;
    usage.promptTokens += raw.usage?.prompt_tokens ?? 0;
    usage.completionTokens += raw.usage?.completion_tokens ?? 0;
    text = raw.choices?.[0]?.message?.content ?? '';
    if (text.trim()) break;
  }
  if (!text.trim()) throw new Error(lastErr || 'empty ZHIPU content');
  return text;
}

/** 内循环 LLM 端口。内核只给它 prompt，它只回一个动作或收工 */
export function makeZhipuKernelLlm(usage: LlmUsage, role?: string): KernelLlmPort {
  const system = [
    role ?? 'You are an agent solving one data-wrangling task in a POSIX shell.',
    'Reply with ONE JSON object and nothing else.',
    'To act:    {"thought":"...","action":{"name":"shell_exec","args":{"command":"..."}}}',
    'To use a learned tool: {"thought":"...","action":{"name":"<tool>","args":{...}}}',
    'To finish: {"thought":"...","done":true,"answer":"..."}',
    'Use exactly the action names listed as available in the user message — no others.',
    'Rules: the work directory is the cwd; never cd outside it; prefer the fewest steps;',
    'if a learned tool matches the job, call it instead of re-deriving the pipeline.',
  ].join('\n');

  return async prompt => {
    const text = await zhipuChat(system, prompt, usage);
    const obj = firstJsonObject(text);
    if (!obj) return { thought: 'unparseable', done: true, answer: '' };
    if (obj.done === true) {
      return { thought: String(obj.thought ?? ''), done: true, answer: String(obj.answer ?? '') };
    }
    const action = obj.action as { name?: string; args?: Record<string, unknown> } | undefined;
    if (!action?.name) return { thought: String(obj.thought ?? ''), done: true, answer: '' };
    return {
      thought: String(obj.thought ?? ''),
      done: false,
      call: { name: action.name, args: action.args ?? {} },
    } satisfies KernelLlmReply;
  };
}

/**
 * 外循环唯一用到模型的一步：把挖出来的**具体**片段泛化成带参工具并写函数体。
 * 它不决定造不造——那是 min-support / min-gain / ΔL 的事。
 */
export function makeZhipuAntiUnify(
  workDir: string,
  usage: LlmUsage,
  repairRounds = 2,
): GrowthPorts['antiUnify'] {
  const system = [
    'You generalise a recurring shell action subsequence into ONE reusable tool.',
    'Return ONE JSON object with exactly these keys:',
    '  name: snake_case identifier',
    '  description: at most 20 words',
    '  args: {"<arg>":{"type":"string","required":true}}',
    '  body: a bash script; it reads a JSON object of args on stdin',
    '  bindings: an array with ONE entry per numbered instance, in order — the args',
    '            you would pass to reproduce that instance. Keys must match `args`.',
    'The acceptance gate compares an EFFECT DIGEST, not the raw report text.',
    'Each instance below lists its expected digest.',
    '  - If the digest contains facts=id=words|..., stdout must be one line per fact:',
    '      id: words',
    '    and must NOT dump the source file.',
    '  - If the digest contains artifact=out.csv, the script must write that same file.',
    'Parameterise what varies; hard-code what does not.',
    'Bash note: parse stdin with grep/sed, jq may be unavailable.',
  ].join('\n');

  return async (cand: ToolCandidate, backing): Promise<AntiUnifyResult | null> => {
    const instances = backing.slice(0, 4);
    const samples = instances.map((steps, i) =>
      [`# instance ${i}`, ...steps.map(s => `${s.symbol}: ${JSON.stringify(s.args)}`)].join('\n'),
    );
    // 期望值来自**原始实例重跑**的效果摘要，与候选工具无关（M5a）
    const originalEffects = instances.map(steps => originalEffect(workDir, steps));
    const user = [
      `Recurring symbols: ${cand.symbols.join(' → ')}  (support=${cand.support})`,
      '',
      'Concrete instances:',
      samples.join('\n\n'),
      '',
      'Expected effect digest of each instance (independently replayed; your tool must match it):',
      ...originalEffects.map((e, i) => `# instance ${i}: ${e ?? '(no verifiable effect)'}`),
    ].join('\n');

    const runner = makeReplayRunner(workDir);
    let feedback = '';

    // 首发泛化不可靠（P2 实测：模型把列号绑成 "$2"，awk 里静默退化成整行匹配）。
    // 闸门的失配信息必须喂回反合一，否则机制的产出恒为零。
    for (let attempt = 0; attempt <= repairRounds; attempt += 1) {
      const obj = firstJsonObject(
        await zhipuChat(system, feedback ? `${user}\n\n${feedback}` : user, usage, 2400),
      );
      if (!obj?.name || !obj?.body) return null;
      const bindings = Array.isArray(obj.bindings) ? (obj.bindings as Record<string, unknown>[]) : [];
      if (bindings.length === 0) return null; // 没有参数绑定的「泛化」是假泛化

      const manifest = {
        name: String(obj.name),
        description: String(obj.description ?? cand.symbols.join(' then ')),
        args: (obj.args ?? {}) as AntiUnifyResult['manifest']['args'],
        deps: [],
        kind: 'composition' as const,
        createdAt: new Date().toISOString(),
        minedFrom: { symbols: cand.symbols, support: cand.support },
      };
      const body = String(obj.body);

      const fixtures = await buildFixturesFromOriginal({
        bindings: bindings.slice(0, instances.length),
        originalEffect: async i => originalEffects[i],
      });
      if (fixtures.length === 0) return null;

      // 工具体须先落盘，重放门才跑得起来；未通过收录时由 growthCycle 之外清理
      const dir = path.join(workDir, 'tools', manifest.name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'run'), body, { encoding: 'utf8', mode: 0o755 });
      fs.writeFileSync(
        path.join(dir, '.proposal.json'),
        JSON.stringify({ manifest, body, fixtures, attempt }, null, 2),
        'utf8',
      );

      const verdict = await replayTool(manifest.name, fixtures, runner);
      if (verdict.pass) {
        if (attempt > 0) console.log(`    [antiunify] ${manifest.name} passed after ${attempt} repair(s)`);
        return { manifest, body, fixtures };
      }
      if (attempt === repairRounds) return { manifest, body, fixtures }; // 交给闸门正式拒

      fs.rmSync(dir, { recursive: true, force: true });
      feedback = [
        'Your previous attempt FAILED effect-equivalence replay. Fix it.',
        `body was:\n${body}`,
        'Mismatches (expected = effect of the original instance, actual = effect of your tool):',
        ...verdict.mismatches
          .slice(0, 3)
          .map(m => `  #${m.index} ${m.reason} expected=${m.expected ?? '-'} actual=${(m.actual ?? '-').slice(0, 200)}`),
        'Hint: match the digest, do not dump the source.',
        '  facts=id=words|...  ⇒ print lines "id: words".',
        '  artifact=out.csv   ⇒ write that file with the same bytes.',
        'An empty actual usually means stdout matched neither form.',
      ].join('\n');
    }
    return null;
  };
}

// ───────────────────────────── 离线 fake（冒烟用） ─────────────────────────────

/**
 * 不需要 API key：脚本化地走一遍 inspect→act→verify，用来验证接线本身。
 * 阶段从 prompt 里的历史条数推断，因此**无状态**——否则跨 batch 会串。
 */
export function makeFakeKernelLlm(_workDir: string): KernelLlmPort {
  return async prompt => {
    const task = prompt.match(/TASK: (.*)/)?.[1] ?? '';
    const k = task.match(/logs-(\d+)\.tsv/)?.[1] ?? '0';
    const level = task.match(/level is (\w+)/)?.[1] ?? 'INFO';
    const phase = (prompt.match(/^#\d+ /gm) ?? []).length;

    // 列序只能从已读到的 schema 观测里解析出来——和真实模型走的是同一条路
    const seen = prompt.match(/Column (\d+)\s+--\s+(\w+)/g) ?? [];
    const col: Record<string, number> = {};
    for (const m of seen) {
      const hit = /Column (\d+)\s+--\s+(\w+)/.exec(m);
      if (hit) col[hit[2]] = Number(hit[1]);
    }

    const plan: string[] = [`ls data`, `cat data/schema-${k}.txt`];
    if (phase < plan.length) {
      return { done: false, call: { name: 'shell_exec', args: { command: plan[phase] } } };
    }
    if (phase === plan.length && col.level && col.service) {
      const cmd =
        `awk -F'\\t' '$${col.level}=="${level}"{print $${col.service}}' data/logs-${k}.tsv` +
        ` | sort > out.csv`;
      return { done: false, call: { name: 'shell_exec', args: { command: cmd } } };
    }
    if (phase === plan.length + 1) {
      return { done: false, call: { name: 'shell_exec', args: { command: 'wc -l out.csv' } } };
    }
    return { done: true, answer: 'ok' };
  };
}

/**
 * reports 族的离线 agent：逐份 `cat` 报告（大且可丢弃的观测），读完写答案。
 * 词形数字的换算在这里是 TS 代码，在真实跑里是模型的工作。
 */
export function makeFakeReportLlm(): KernelLlmPort {
  const ONES: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
    nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
    sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
    forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  };
  const parse = (words: string): number =>
    words.split(/\s+/).reduce((acc, w) => (w === 'hundred' ? acc * 100 : acc + (ONES[w] ?? 0)), 0);

  return async prompt => {
    const task = prompt.match(/TASK: (.*)/)?.[1] ?? '';
    const files = [...task.matchAll(/reports\/rep-(\w+)\.txt/g)].map(m => m[1]);
    const phase = (prompt.match(/^#\d+ /gm) ?? []).length;

    if (phase < files.length) {
      return {
        done: false,
        call: { name: 'shell_exec', args: { command: `cat reports/rep-${files[phase]}.txt` } },
      };
    }
    if (phase === files.length) {
      // 判断只依赖已读进上下文的观测——和真实模型同一条路
      const seen = [...prompt.matchAll(/rep-(\w+)\.txt[\s\S]*?Observed handling latency: ([a-z ]+) milliseconds/g)];
      const hits = seen
        .filter(m => parse(m[2].trim()) > 300)
        .map(m => m[1])
        .sort();
      const cmd = hits.length
        ? `printf '%s\\n' ${hits.join(' ')} > out.csv`
        : ': > out.csv';
      return { done: false, call: { name: 'shell_exec', args: { command: cmd } } };
    }
    return { done: true, answer: 'ok' };
  };
}

/**
 * staged 探针的离线 agent：固定走 grep → awk → sort。
 * 只用来证明「符号序列对齐时挖掘器能出候选」。真实模型不走这条硬编码。
 */
export function makeFakeStagedLlm(): KernelLlmPort {
  return async prompt => {
    const task = prompt.match(/TASK: (.*)/)?.[1] ?? '';
    const k = task.match(/inbox\/batch-(\d+)\.txt/)?.[1];
    if (k === undefined) return { done: true, answer: 'no batch' };
    const phase = (prompt.match(/^#\d+ /gm) ?? []).length;
    const plan = [
      `grep MARK inbox/batch-${k}.txt | tee work/s1.txt`,
      `awk '$3+0 > 500 {print $2}' work/s1.txt | tee work/s2.txt`,
      `LC_ALL=C sort work/s2.txt > out.csv`,
    ];
    if (phase < plan.length) {
      return { done: false, call: { name: 'shell_exec', args: { command: plan[phase] } } };
    }
    return { done: true, answer: 'ok' };
  };
}

export function makeFakeAntiUnify(): GrowthPorts['antiUnify'] {
  return async () => null; // fake 模式只验证内循环与挖掘，不造工具
}
