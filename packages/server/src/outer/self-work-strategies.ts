/**
 * SelfWorkPolicy 多策略 — ADL DIGITAL-EMPLOYEE-AUTONOMY.md §4.2
 *
 * 每个策略只是"提案角度"的优先序不同：draft（推进交付）/ research（信息增益）/
 * tooling（自动化）/ testing（验证）。策略只有提案权；合法性统一由
 * validateSelfWorkProposal 把关（重复、依赖、冲突、路线熔断）。
 */
import {
  LlmReflectiveSelfWorkPolicy,
  LLM_REFLECTIVE_STRATEGY_ID,
  type SelfWorkLlmCaller,
} from './self-work-llm-policy.js';
import type { SelfWorkMetricsSummary } from './self-work-metrics.js';
import { buildNarrowDraftProposal } from './advance-allocator.js';
import { shouldSkipSelfWorkForKpi } from './advance-perception.js';
import {
  validateSelfWorkProposal,
  type SelfWorkContext,
  type SelfWorkKpi,
  type SelfWorkPolicy,
  type SelfWorkProposal,
} from './self-work-policy.js';

export type SelfWorkAngle = 'draft' | 'research' | 'tooling' | 'testing';

export const SELF_WORK_STRATEGY_IDS = [
  'conservative',
  'research_first',
  'tooling_first',
  'balanced',
] as const;
export type SelfWorkStrategyId = (typeof SELF_WORK_STRATEGY_IDS)[number];

function buildAngleProposal(
  kpi: SelfWorkKpi,
  angle: SelfWorkAngle,
  strategyId: string,
  context: SelfWorkContext,
): SelfWorkProposal | null {
  const desc = kpi.description;
  switch (angle) {
    case 'draft':
      return buildNarrowDraftProposal(kpi, context.perception, strategyId);
    case 'research':
      return {
        kpiId: kpi.kpiId,
        action: `调研并总结「${desc.slice(0, 120)}」的最新可行动情报（本轮有限范围）`,
        expectedOutcome: `≥3 条可验证的新信息，并说明各自对该 KPI 的下一步含义`,
        reason: '信息增益优先：先降低不确定性再投入执行',
        strategyId,
      };
    case 'tooling':
      return {
        kpiId: kpi.kpiId,
        action: `为「${desc.slice(0, 120)}」构建或改进一个可复用的自动化工具/脚本`,
        expectedOutcome: `一个可运行的工具/脚本 + 使用说明，能降低该 KPI 的重复人工成本`,
        reason: '自动化优先：一次投入换长期执行效率',
        strategyId,
      };
    case 'testing':
      return {
        kpiId: kpi.kpiId,
        action: `验证「${desc.slice(0, 120)}」现有交付物的质量并记录问题`,
        expectedOutcome: `一份可复现的验证报告（通过项 + 缺陷清单 + 建议修复顺序）`,
        reason: '质量优先：确认既有交付可靠再扩展新工作',
        strategyId,
      };
  }
}

function activeKpisByMomentum(context: SelfWorkContext): SelfWorkKpi[] {
  return [...context.activeKpis]
    .filter((kpi) => kpi.status === 'active')
    .filter((kpi) =>
      context.perception ? !shouldSkipSelfWorkForKpi(context.perception, kpi.kpiId) : true,
    )
    .sort((a, b) => b.momentum - a.momentum);
}

/**
 * 通用角度轮询策略：按 KPI momentum 优先，逐角度构造提案，
 * 返回第一个通过合法性校验的；全部被拒则休眠（null）。
 */
export class AngleSelfWorkPolicy implements SelfWorkPolicy {
  constructor(
    readonly strategyId: SelfWorkStrategyId,
    private readonly angleOrder: (context: SelfWorkContext) => SelfWorkAngle[],
  ) {}

  async propose(context: SelfWorkContext): Promise<SelfWorkProposal | null> {
    const angles = this.angleOrder(context);
    for (const kpi of activeKpisByMomentum(context)) {
      for (const angle of angles) {
        const proposal = buildAngleProposal(kpi, angle, this.strategyId, context);
        if (proposal && validateSelfWorkProposal(proposal, context).ok) return proposal;
      }
    }
    return null;
  }
}

const BALANCED_ROTATION: SelfWorkAngle[] = ['draft', 'research', 'tooling', 'testing'];

export function createSelfWorkStrategy(strategyId: SelfWorkStrategyId): SelfWorkPolicy {
  switch (strategyId) {
    case 'conservative':
      return new AngleSelfWorkPolicy('conservative', () => ['draft']);
    case 'research_first':
      return new AngleSelfWorkPolicy('research_first', () => ['research', 'draft']);
    case 'tooling_first':
      return new AngleSelfWorkPolicy('tooling_first', () => ['tooling', 'testing', 'draft']);
    case 'balanced':
      // 按最近动作数轮换起始角度：写作/调研/工具/测试轮流，避免固定单一路线
      return new AngleSelfWorkPolicy('balanced', (context) => {
        const offset = context.recentActions.length % BALANCED_ROTATION.length;
        return [...BALANCED_ROTATION.slice(offset), ...BALANCED_ROTATION.slice(0, offset)];
      });
  }
}

export function isSelfWorkStrategyId(value: string): value is SelfWorkStrategyId {
  return (SELF_WORK_STRATEGY_IDS as readonly string[]).includes(value);
}

// ── 策略 A/B 灰度（P3，ADL §4.2）─────────────────────────────

export interface AbTestSelfWorkPolicyOptions {
  candidates: SelfWorkStrategyId[];
  /** 读 self-work-metrics 汇总（byStrategy accepted/rejected）做探索/利用 */
  getSummary: () => SelfWorkMetricsSummary;
  /** 每个候选先探索满该次数提案，再按 acceptance rate 利用（默认 3） */
  minTrialsPerStrategy?: number;
}

/**
 * 指标驱动的策略选择器：探索期轮询试满每个候选，之后利用 acceptance rate 最优者；
 * 被选策略提案为 null 时按顺序回退其余候选。提案保留各策略真实 strategyId，
 * 指标归因不失真。
 */
export class AbTestSelfWorkPolicy implements SelfWorkPolicy {
  private readonly policies: Map<SelfWorkStrategyId, SelfWorkPolicy>;
  private readonly candidates: SelfWorkStrategyId[];
  private readonly minTrials: number;

  constructor(private readonly options: AbTestSelfWorkPolicyOptions) {
    this.candidates = [...new Set(options.candidates)];
    if (this.candidates.length === 0) {
      throw new Error('AbTestSelfWorkPolicy requires at least one candidate strategy');
    }
    this.policies = new Map(
      this.candidates.map((id) => [id, createSelfWorkStrategy(id)]),
    );
    this.minTrials = Math.max(1, options.minTrialsPerStrategy ?? 3);
  }

  /** 探索优先（试次未满的最少试次候选），否则利用 acceptance rate 最优（平手按候选顺序） */
  pick(): SelfWorkStrategyId {
    const byStrategy = this.options.getSummary().byStrategy;
    const trials = (id: SelfWorkStrategyId): number => {
      const stats = byStrategy[id];
      return (stats?.accepted ?? 0) + (stats?.rejected ?? 0);
    };

    const underExplored = this.candidates.filter((id) => trials(id) < this.minTrials);
    if (underExplored.length > 0) {
      return underExplored.reduce((best, id) => (trials(id) < trials(best) ? id : best));
    }

    return this.candidates.reduce((best, id) => {
      const rate = (candidate: SelfWorkStrategyId): number => {
        const stats = byStrategy[candidate];
        const total = (stats?.accepted ?? 0) + (stats?.rejected ?? 0);
        return total > 0 ? (stats?.accepted ?? 0) / total : 0;
      };
      return rate(id) > rate(best) ? id : best;
    });
  }

  async propose(context: SelfWorkContext): Promise<SelfWorkProposal | null> {
    const chosen = this.pick();
    const ordered = [chosen, ...this.candidates.filter((id) => id !== chosen)];
    for (const id of ordered) {
      const proposal = await this.policies.get(id)!.propose(context);
      if (proposal) return proposal;
    }
    return null;
  }
}

// ── 统一策略解析（runtime 入口）──────────────────────────────

export interface CreateSelfWorkPolicyOptions {
  getSummary: () => SelfWorkMetricsSummary;
  /** llm_reflective 需要；缺失时回退 conservative */
  llmCaller?: SelfWorkLlmCaller;
  minTrialsPerStrategy?: number;
}

export interface ResolvedSelfWorkPolicy {
  policy: SelfWorkPolicy;
  /** 实际生效的 spec（非法输入回退后可能与传入不同） */
  spec: string;
}

/**
 * 解析策略 spec：
 * - `conservative` / `research_first` / `tooling_first` / `balanced` → 单策略；
 * - `llm_reflective` → LLM 提案 + conservative fallback（无 caller 时降级 conservative）；
 * - `ab` → 全部 deterministic 策略灰度；`ab:a,b` → 指定候选灰度；
 * - 非法输入 → conservative。
 */
export function createSelfWorkPolicy(
  spec: string,
  options: CreateSelfWorkPolicyOptions,
): ResolvedSelfWorkPolicy {
  const trimmed = spec.trim();

  if (isSelfWorkStrategyId(trimmed)) {
    return { policy: createSelfWorkStrategy(trimmed), spec: trimmed };
  }

  if (trimmed === LLM_REFLECTIVE_STRATEGY_ID) {
    if (!options.llmCaller) {
      return { policy: createSelfWorkStrategy('conservative'), spec: 'conservative' };
    }
    return {
      policy: new LlmReflectiveSelfWorkPolicy(
        options.llmCaller,
        createSelfWorkStrategy('conservative'),
      ),
      spec: trimmed,
    };
  }

  if (trimmed === 'ab' || trimmed.startsWith('ab:')) {
    const requested = trimmed === 'ab'
      ? [...SELF_WORK_STRATEGY_IDS]
      : trimmed
          .slice(3)
          .split(',')
          .map((id) => id.trim())
          .filter(isSelfWorkStrategyId);
    const candidates = requested.length > 0 ? requested : [...SELF_WORK_STRATEGY_IDS];
    return {
      policy: new AbTestSelfWorkPolicy({
        candidates,
        getSummary: options.getSummary,
        minTrialsPerStrategy: options.minTrialsPerStrategy,
      }),
      spec: `ab:${candidates.join(',')}`,
    };
  }

  return { policy: createSelfWorkStrategy('conservative'), spec: 'conservative' };
}
