/**
 * 最小 ReAct + 工具 MDL 自生长 · 实验驱动
 * ADL: doc/structurizr/TOOL-MDL-GROWTH.md（结论记在 §11）
 *
 * 唯一要检验的命题：
 *   在有复发结构的确定性任务流上，每任务 token 成本随时间单调下降，
 *   且下降来自系统自己创建的工具。
 *
 * 单次跑的批间方差远大于效应（§11.7），所以默认多种子重复并报告离散度。
 * 没有 `toolCalls` 这一列的成本曲线不可信：收录了但没人调用时，曲线变化与机制无关。
 *
 * Usage (repo root):
 *   npx --yes tsx experiments/minimal-react-mdl/run-loop.ts --fake            # 离线冒烟
 *   set -a && source deploy/agent/env/collatz-lean.env && set +a
 *   npx --yes tsx experiments/minimal-react-mdl/run-loop.ts --repeats=3 --batches=4
 *   ... --family=schema   # 零产出对照族（§11.6）
 *   ... --family=staged   # 分阶段探针：先看能否挖出候选（§11.22），不比 token
 *   ... --arm=a           # 对照臂 A：内联 create_tool 交给模型判断（M11，预测 ≈0）
 *   ... --outdir=.run-staged   # 不覆盖默认 .run/
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readTrace, type TraceRecord } from '../../packages/server/src/openkuroneko/tool-mdl/action-log.ts';
import { runGrowthCycle } from '../../packages/server/src/openkuroneko/tool-mdl/growth-cycle.ts';
import { runReactKernel } from '../../packages/server/src/openkuroneko/tool-mdl/react-kernel.ts';
import { buildToolIndex } from '../../packages/server/src/openkuroneko/tool-mdl/tool-index.ts';
import { loadLibrary, readMdlHistory } from '../../packages/server/src/openkuroneko/tool-mdl/tool-library.ts';
import { replayTool } from '../../packages/server/src/openkuroneko/tool-mdl/tool-replay-gate.ts';
import {
  makeFakeAntiUnify,
  makeFakeKernelLlm,
  makeFakeReportLlm,
  makeFakeStagedLlm,
  makeReplayRunner,
  makeShellExecutor,
  makeZhipuAntiUnify,
  makeZhipuKernelLlm,
  type LlmUsage,
} from './ports.ts';
import { buildReportCorpus } from './tasks-reports.ts';
import { buildStagedCorpus, resetStagedOutput } from './tasks-staged.ts';
import { buildCorpus, resetTaskOutput, verifyTask } from './tasks.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const outdirArg = process.argv.find(a => a.startsWith('--outdir='))?.split('=').slice(1).join('=');
const runsRoot = outdirArg ? path.resolve(here, outdirArg) : path.join(here, '.run');

function argNum(name: string, fallback: number): number {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const n = Number(hit.split('=')[1]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const hasFlag = (n: string) => process.argv.includes(`--${n}`);
const argStr = (n: string, d: string) =>
  process.argv.find(a => a.startsWith(`--${n}=`))?.split('=')[1] ?? d;

interface BatchReport {
  batch: number;
  solved: number;
  total: number;
  steps: number;
  observationTokens: number;
  actionTokens: number;
  llmPromptTokens: number;
  toolsInLibrary: number;
  grammarCostTokens: number;
  /** 按已解任务归一。失败的任务往往更短，不归一会把正确率波动读成成本下降 */
  obsPerSolved: number;
  /**
   * 学到的工具被实际调用的次数。**这是之前缺的那个仪表**：收录了但没人调用时，
   * 成本曲线的任何变化都与机制无关（ADL §8「新工具创建后使用 ≤1 次」）。
   */
  toolCalls: number;
  /** 臂 A：模型当场决定造工具的次数。与 `toolCalls` 一起才说明判断准不准 */
  createToolCalls: number;
}

interface RunConfig {
  family: string;
  arm: string;
  fake: boolean;
  batches: number;
  taskCount: number;
  perTask: number;
  budgetSteps: number;
  minGain: number;
  maxAccept: number;
  /** §11.12 析因：关掉观测上限告知 */
  announceObservationLimit: boolean;
}

interface RunOutcome {
  seed: number;
  reports: BatchReport[];
  library: Array<{ name: string; kind: string; minedFrom?: string }>;
}

async function runOnce(cfg: RunConfig, seed: number, workDir: string): Promise<RunOutcome> {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const { tasks } =
    cfg.family === 'schema'
      ? buildCorpus(workDir, cfg.taskCount, 300)
      : cfg.family === 'staged'
        ? buildStagedCorpus(workDir, cfg.taskCount)
        : buildReportCorpus(workDir, cfg.taskCount, cfg.perTask, seed);

  const usage: LlmUsage = { promptTokens: 0, completionTokens: 0, calls: 0 };
  const executor = makeShellExecutor(workDir, { stageGate: cfg.family === 'staged' });
  const kernelLlm = cfg.fake
    ? cfg.family === 'schema'
      ? makeFakeKernelLlm(workDir)
      : cfg.family === 'staged'
        ? makeFakeStagedLlm()
        : makeFakeReportLlm()
    : makeZhipuKernelLlm(usage);
  const antiUnify = cfg.fake ? makeFakeAntiUnify() : makeZhipuAntiUnify(workDir, usage);

  const reports: BatchReport[] = [];

  for (let b = 0; b < cfg.batches; b += 1) {
    const promptBefore = usage.promptTokens;
    let solved = 0;
    let steps = 0;
    let observationTokens = 0;
    let actionTokens = 0;

    // 批次开始时库里有什么，决定了这一批的调用能算作「学到的工具」
    const libNames = new Set(loadLibrary(workDir).map(t => t.name));

    for (const task of tasks) {
      resetTaskOutput(workDir);
      if (cfg.family === 'staged') resetStagedOutput(workDir);
      const runId = `b${b}-${task.id}`;
      try {
        const res = await runReactKernel({
          workDir,
          runId,
          task: task.prompt,
          llm: kernelLlm,
          executor,
          budgetSteps: cfg.budgetSteps,
          maxObservationChars: 4_000,
          // M11：对照臂 A 才把 create_tool 放进内循环动作空间
          inlineCreateTool: cfg.arm === 'a',
          announceObservationLimit: cfg.announceObservationLimit,
        });
        steps += res.steps;
        observationTokens += res.observationTokens;
        actionTokens += res.actionTokens;
      } catch (e) {
        console.log(`  [${runId}] kernel error: ${(e as Error).message}`);
        continue;
      }
      if (verifyTask(workDir, task)) solved += 1;
    }

    const traces: TraceRecord[] = tasks.flatMap(t => readTrace(workDir, `b${b}-${t.id}`));
    const index = buildToolIndex(workDir);
    // 臂 A 的工具是批次中途冒出来的，所以用「批末的库」而非批初的来认调用
    const knownTools = new Set([...libNames, ...index.entries.map(e => e.name)]);
    const toolCalls = traces.filter(r => knownTools.has(r.symbol)).length;
    const createToolCalls = traces.filter(r => r.symbol === 'create_tool').length;

    reports.push({
      batch: b,
      solved,
      total: tasks.length,
      steps,
      observationTokens,
      actionTokens,
      llmPromptTokens: usage.promptTokens - promptBefore,
      toolsInLibrary: index.entries.length,
      grammarCostTokens: index.grammarCostTokens,
      obsPerSolved: solved > 0 ? Math.round(observationTokens / solved) : 0,
      toolCalls,
      createToolCalls,
    });
    if (cfg.family === 'staged') {
      const byRun = new Map<string, string[]>();
      for (const t of traces) {
        const xs = byRun.get(t.runId) ?? [];
        xs.push(`${t.symbol}${t.ok ? '' : '!'}`);
        byRun.set(t.runId, xs);
      }
      console.log(`    [traces] ${[...byRun.values()].map(s => s.join('→')).join(' | ')}`);
    }
    const r = reports.at(-1)!;
    console.log(
      `  [batch ${b}] solved ${r.solved}/${r.total}  steps=${r.steps}  obs/solved=${r.obsPerSolved}` +
        `  toolCalls=${r.toolCalls}  tools=${r.toolsInLibrary}` +
        (cfg.arm === 'a' ? `  created=${r.createToolCalls}` : ''),
    );

    // ── 外循环（臂 B 才跑；臂 A 靠模型内联判断）─────────────────────────
    if (cfg.arm === 'b' && b < cfg.batches - 1) {
      const growth = await runGrowthCycle(
        {
          workDir,
          traces,
          minSupport: Math.max(2, Math.floor(tasks.length / 2)),
          minGain: cfg.minGain,
          // 携带成本按「每步都要把工具索引放进 prompt」计，所以视界必须与 support
          // 的观测窗口同口径：下一批的预期步数 ≈ 刚跑完这批的实际步数。
          remainingSteps: Math.max(1, r.steps),
          maxAcceptPerCycle: cfg.maxAccept,
        },
        { antiUnify, runTool: makeReplayRunner(workDir) },
      );
      console.log(
        `    [growth] cands=${growth.candidates}` +
          ` accepted=[${growth.accepted.map(a => `${a.name}(ΔL=${a.deltaL})`).join(', ')}]` +
          ` rejected=[${growth.rejected.map(x => `${x.name}:${x.reason}`).join(', ')}]` +
          ` retired=[${growth.retired.join(', ')}]`,
      );
      // 被拒候选的函数体已落盘，必须清掉，否则污染下一轮的工具索引
      for (const x of growth.rejected) {
        const dir = path.join(workDir, 'tools', x.name);
        const proposalFile = path.join(dir, '.proposal.json');
        if (fs.existsSync(path.join(dir, 'manifest.json')) || !fs.existsSync(proposalFile)) continue;
        if (x.reason === 'replay_failed') {
          const p = JSON.parse(fs.readFileSync(proposalFile, 'utf8')) as {
            fixtures: Array<{ args: Record<string, unknown>; expected: string }>;
          };
          const v = await replayTool(x.name, p.fixtures, makeReplayRunner(workDir));
          for (const m of v.mismatches.slice(0, 2)) {
            console.log(
              `      [replay ${x.name}#${m.index}] ${m.reason}` +
                ` expected=${(m.expected ?? '-').slice(0, 120)} actual=${(m.actual ?? '-').slice(0, 120)}`,
            );
          }
        }
        if (hasFlag('keep-rejected')) {
          fs.renameSync(dir, path.join(workDir, `rejected-${x.name}-b${b}`));
        } else {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  }

  return {
    seed,
    reports,
    library: loadLibrary(workDir).map(t => ({
      name: t.name,
      kind: t.manifest.kind,
      minedFrom: t.manifest.minedFrom?.symbols.join('→'),
    })),
  };
}

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

async function main(): Promise<void> {
  const cfg: RunConfig = {
    // schema 族：大观测在获取步上 ⇒ 不可压缩，机制正确地零产出（ADL §11.6）
    // reports 族：大观测可丢弃 ⇒ 才有得压缩，用来检验正面命题
    family: argStr('family', 'reports'),
    arm: argStr('arm', 'b'),
    fake: hasFlag('fake'),
    batches: argNum('batches', 6),
    taskCount: argNum('tasks', 6),
    // per-task 曾降到 3 想把正确率抬上去，结果**机制彻底失效**：模型把任务一行流化，
    // 每任务只剩 ~1.5 步，没有可挖的复发，三个种子全部零收录（§11.12）。
    // 步数就是这套机制的载体，降难度会被模型的上下文内组合吸收掉，不会流向工具库。
    perTask: argNum('per-task', 4),
    budgetSteps: argNum('budget', 8),
    // §8 命中过「新工具创建后使用 ≤1 次 ⇒ 阈值太松」，故默认从 4 提到 12
    minGain: argNum('min-gain', 12),
    maxAccept: argNum('max-accept', 1),
    // 默认关（§11.14：打开会单独把库打死）。`--obs-limit-notice` 显式打开
    announceObservationLimit: hasFlag('obs-limit-notice'),
  };
  const repeats = argNum('repeats', cfg.fake ? 1 : 3);
  const baseSeed = argNum('seed', 4242);

  fs.rmSync(runsRoot, { recursive: true, force: true });
  fs.mkdirSync(runsRoot, { recursive: true });

  console.log(
    `[setup] family=${cfg.family} arm=${cfg.arm} tasks=${cfg.taskCount} batches=${cfg.batches}` +
      ` repeats=${repeats} minGain=${cfg.minGain} perTask=${cfg.perTask}` +
      ` obsNotice=${cfg.announceObservationLimit ? 'on' : 'off'}` +
      `${cfg.fake ? ' (fake llm)' : ''}`,
  );

  const outcomes: RunOutcome[] = [];
  for (let i = 0; i < repeats; i += 1) {
    const seed = baseSeed + i * 7;
    console.log(`\n[repeat ${i}] seed=${seed}`);
    outcomes.push(await runOnce(cfg, seed, path.join(runsRoot, `seed-${seed}`)));
  }

  // ── 聚合：按批次序号横跨种子看，否则单跑的方差会淹没效应 ─────────────
  console.log('\n=== aggregate over seeds ===');
  const agg = Array.from({ length: cfg.batches }, (_, b) => {
    const row = outcomes.map(o => o.reports[b]).filter(Boolean);
    const obs = row.map(r => r.obsPerSolved);
    return {
      batch: b,
      'solved(mean)': +mean(row.map(r => r.solved)).toFixed(2),
      'obs/solved(mean)': Math.round(mean(obs)),
      'obs/solved(min)': Math.min(...obs),
      'obs/solved(max)': Math.max(...obs),
      'steps(mean)': Math.round(mean(row.map(r => r.steps))),
      'toolCalls(mean)': +mean(row.map(r => r.toolCalls)).toFixed(2),
      'tools(mean)': +mean(row.map(r => r.toolsInLibrary)).toFixed(2),
      ...(cfg.arm === 'a'
        ? { 'created(mean)': +mean(row.map(r => r.createToolCalls)).toFixed(2) }
        : {}),
    };
  });
  console.table(agg);

  if (cfg.arm === 'a') {
    const created = outcomes.flatMap(o => o.reports).reduce((s, r) => s + r.createToolCalls, 0);
    const called = outcomes.flatMap(o => o.reports).reduce((s, r) => s + r.toolCalls, 0);
    console.log(
      `\n臂 A（M11）：create_tool 调用 ${created} 次，学到的工具被实际调用 ${called} 次` +
        `（复用率 ${created > 0 ? (called / created).toFixed(2) : 'n/a'}）`,
    );
    if (created === 0) console.log('  理论预测 A≈0 未被推翻：模型一次都没想造工具');
    else if (called === 0) console.log('  造了但从不复用 ⇒ 判断找错了复用点，不是压缩');
    else console.log('  ⚠️  臂 A 有效 ⇒ 本 ADL 的核心论断被证伪（M11）');
  }

  const first = agg[0];
  const last = agg.at(-1)!;
  const spread = Math.max(...agg.map(a => a['obs/solved(max)'] - a['obs/solved(min)']));
  const effect = first['obs/solved(mean)'] - last['obs/solved(mean)'];
  console.log(
    `\nobs/solved: ${first['obs/solved(mean)']} → ${last['obs/solved(mean)']}` +
      `  (效应 ${effect}，最大批内离散 ${spread})`,
  );
  if (Math.abs(effect) < spread) {
    console.log('⚠️  效应小于批内离散 ⇒ 读不出趋势，不要据此下结论（ADL §11.7）');
  }
  const totalToolCalls = outcomes.flatMap(o => o.reports).reduce((s, r) => s + r.toolCalls, 0);
  if (totalToolCalls === 0) {
    console.log('⚠️  学到的工具零调用 ⇒ 成本曲线的任何变化都与本机制无关');
  }

  for (const o of outcomes) {
    console.log(
      `seed ${o.seed}: library=[${o.library.map(t => `${t.name}(${t.kind},${t.minedFrom})`).join(', ') || '空'}]`,
    );
    console.log(`  mdl: ${JSON.stringify(readMdlHistory(path.join(runsRoot, `seed-${o.seed}`)))}`);
  }

  fs.writeFileSync(
    path.join(runsRoot, 'report.json'),
    `${JSON.stringify({ cfg, repeats, outcomes, aggregate: agg }, null, 2)}\n`,
    'utf8',
  );
  console.log(`\nreport → ${path.join(runsRoot, 'report.json')}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
