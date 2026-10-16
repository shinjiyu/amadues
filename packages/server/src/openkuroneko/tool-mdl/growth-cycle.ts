/**
 * growthCycle — 外循环编排（ADL: TOOL-MDL-GROWTH.md §4.2）
 *
 *   reEncode → mine → antiUnify → replay → ΔL 收录 → ΔL 退役
 *
 * 模型只在 antiUnify 一步出现：把挖出来的**具体**片段泛化成带参工具并写函数体。
 * 造不造由 min-support / min-gain / ΔL 决定，模型不参与。
 */
import { countTokens, type TraceRecord } from './action-log.js';
import { acceptDelta, retireDelta } from './mdl-account.js';
import { manifestCostTokens, validateToolManifest, type ToolManifest } from './tool-manifest.js';
import { acceptTool, loadLibrary, retireTool } from './tool-library.js';
import { replayTool, validateAcceptFixtures, type ReplayFixture, type ToolRunner } from './tool-replay-gate.js';
import { mineCandidates, reEncode, type ToolCandidate } from './trace-miner.js';

export interface AntiUnifyResult {
  manifest: ToolManifest;
  body: string;
  fixtures: ReplayFixture[];
}

export interface GrowthPorts {
  /** 模型唯一职责：泛化 + 写函数体。返回 null 表示放弃该候选 */
  antiUnify: (cand: ToolCandidate, backing: TraceRecord[][]) => Promise<AntiUnifyResult | null>;
  runTool: ToolRunner;
}

export interface GrowthOptions {
  workDir: string;
  traces: TraceRecord[];
  minSupport: number;
  minGain: number;
  /** 剩余步数预算 S：文法代价乘子 */
  remainingSteps: number;
  maxAcceptPerCycle?: number;
  allowAcquisition?: boolean;
}

export type RejectReason =
  | 'antiunify_empty'
  | 'invalid_manifest'
  | 'invalid_fixtures'
  | 'replay_failed'
  | 'mdl_not_negative'
  | 'write_failed';

export interface GrowthResult {
  accepted: Array<{ name: string; deltaL: number; support: number }>;
  rejected: Array<{ name: string; reason: RejectReason; detail?: string }>;
  retired: string[];
  candidates: number;
}

/**
 * 该候选每次使用省下的 token：被折叠掉那几步的动作 + **可压缩的**观测。
 *
 * M12：`obsKind === 'acquisition'` 的观测不计入。它的观测就是它的价值，信息仍须
 * 送达 agent，封进工具也省不掉。把它算成节省会系统性高估 ΔL，让必然亏本的工具
 * 通过闸门（P2 实测：`cat schema → awk` 的 409 token schema 被误记为可省，
 * ΔL 从诚实的 +134 变成 −1331）。
 */
function savedTokensPerUse(backing: TraceRecord[][]): number {
  if (backing.length === 0) return 0;
  const totals = backing.map(steps =>
    steps.reduce(
      (s, r) => s + r.actionTokens + (r.obsKind === 'acquisition' ? 0 : r.obsTokens),
      0,
    ),
  );
  return Math.round(totals.reduce((a, b) => a + b, 0) / totals.length);
}

function instanceRecords(traces: TraceRecord[], cand: ToolCandidate): TraceRecord[][] {
  return cand.instances.map(inst => {
    const start = traces.findIndex(r => r.runId === inst.runId && r.step === inst.startStep);
    return start < 0 ? [] : traces.slice(start, start + cand.symbols.length);
  });
}

/** 在原始轨迹里找出某个符号序列的全部出现，用于给库内工具估算节省 */
function occurrencesOf(traces: TraceRecord[], symbols: string[]): TraceRecord[][] {
  if (symbols.length === 0) return [];
  const out: TraceRecord[][] = [];
  for (let i = 0; i + symbols.length <= traces.length; i += 1) {
    const window = traces.slice(i, i + symbols.length);
    const sameRun = window.every(r => r.runId === window[0].runId);
    if (sameRun && window.every((r, k) => r.symbol === symbols[k])) out.push(window);
  }
  return out;
}

export async function runGrowthCycle(
  opts: GrowthOptions,
  ports: GrowthPorts,
): Promise<GrowthResult> {
  const validate = { allowAcquisition: opts.allowAcquisition };
  const library = loadLibrary(opts.workDir, validate);

  // M8：先用当前库重编码，否则层级永远停在深度 1
  const encoded = reEncode(
    opts.traces,
    library
      .filter(t => t.manifest.minedFrom?.symbols?.length)
      .map(t => ({ name: t.name, symbols: t.manifest.minedFrom!.symbols })),
  );

  const candidates = mineCandidates(encoded, {
    minSupport: opts.minSupport,
    minGain: opts.minGain,
  });

  const result: GrowthResult = { accepted: [], rejected: [], retired: [], candidates: candidates.length };
  const existing = new Set(library.map(t => t.name));
  const cap = opts.maxAcceptPerCycle ?? Number.POSITIVE_INFINITY;

  for (const cand of candidates) {
    if (result.accepted.length >= cap) break;

    const backing = instanceRecords(opts.traces, cand).filter(s => s.length > 0);
    const proposal = await ports.antiUnify(cand, backing);
    if (!proposal) {
      result.rejected.push({ name: cand.symbols.join('_'), reason: 'antiunify_empty' });
      continue;
    }
    const name = proposal.manifest?.name ?? cand.symbols.join('_');
    if (existing.has(name)) continue;

    const errs = validateToolManifest(proposal.manifest, validate);
    if (errs.length > 0) {
      result.rejected.push({ name, reason: 'invalid_manifest', detail: errs.join('; ') });
      continue;
    }

    const fixtureErrs = validateAcceptFixtures(proposal.fixtures);
    if (fixtureErrs.length > 0) {
      result.rejected.push({ name, reason: 'invalid_fixtures', detail: fixtureErrs.join('; ') });
      continue;
    }

    const verdict = await replayTool(name, proposal.fixtures, ports.runTool);
    if (!verdict.pass) {
      result.rejected.push({
        name,
        reason: 'replay_failed',
        detail: `${verdict.passed}/${verdict.total} reproduced`,
      });
      continue;
    }

    const savingPerUse = savedTokensPerUse(backing);
    const deltaL = acceptDelta(
      {
        name,
        manifestCostTokens: manifestCostTokens(proposal.manifest),
        support: cand.support,
        savedTokensPerUse: savingPerUse,
        callCostTokens: countTokens(`${name} ${JSON.stringify(proposal.manifest.args)}`),
        buildCostTokens: countTokens(proposal.body),
      },
      { remainingSteps: opts.remainingSteps },
    );
    if (deltaL >= 0) {
      result.rejected.push({ name, reason: 'mdl_not_negative', detail: String(deltaL) });
      continue;
    }

    try {
      acceptTool(opts.workDir, {
        manifest: {
          ...proposal.manifest,
          minedFrom: {
            symbols: proposal.manifest.minedFrom?.symbols ?? cand.symbols,
            support: proposal.manifest.minedFrom?.support ?? cand.support,
            // 退役账本要用：采用后表面复发消失，不能再从语料回算
            savedTokensPerUse: savingPerUse,
          },
        },
        body: proposal.body,
        fixtures: proposal.fixtures,
        deltaL,
        validate,
      });
    } catch (e) {
      result.rejected.push({ name, reason: 'write_failed', detail: (e as Error).message });
      continue;
    }
    existing.add(name);
    result.accepted.push({ name, deltaL, support: cand.support });
  }

  // M6：退役用同一个 L。叶子优先，避免被 deps DAG 挡住
  const after = loadLibrary(opts.workDir, validate);
  const uses = new Map<string, number>();
  for (const r of encoded) uses.set(r.symbol, (uses.get(r.symbol) ?? 0) + 1);

  for (const tool of [...after].reverse()) {
    if (result.accepted.some(a => a.name === tool.name)) continue;
    const useCount = uses.get(tool.name) ?? 0;
    // 仍在被调用 ⇒ 用收录时锁定的节省；表面片段已折叠，回算 minedFrom 会得到 0（§11.15）
    // 从未被调用 ⇒ 才允许从当前语料估（通常也是 0 ⇒ 退役）
    const saving =
      useCount > 0
        ? (tool.manifest.minedFrom?.savedTokensPerUse ??
          savedTokensPerUse(occurrencesOf(opts.traces, tool.manifest.minedFrom?.symbols ?? [])))
        : savedTokensPerUse(occurrencesOf(opts.traces, tool.manifest.minedFrom?.symbols ?? []));
    const d = retireDelta(
      {
        name: tool.name,
        manifestCostTokens: manifestCostTokens(tool.manifest),
        uses: useCount,
        savedTokensPerUse: saving,
        callCostTokens: countTokens(tool.name),
      },
      { remainingSteps: opts.remainingSteps },
    );
    if (d >= 0) continue;
    try {
      retireTool(opts.workDir, tool.name, d);
      result.retired.push(tool.name);
    } catch {
      // 仍被依赖：本轮不退，下一轮叶子清空后再说（M6）
    }
  }

  return result;
}
