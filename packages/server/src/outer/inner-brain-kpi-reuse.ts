/**
 * 同一 KPI / 长期目标 → 单一 canonical 内脑实例，续跑复用 workDir。
 *
 * 设计：[`doc/structurizr/INNER-BRAIN-SINGLE-INSTANCE.md`](../../../../doc/structurizr/INNER-BRAIN-SINGLE-INSTANCE.md)
 */
import fs from 'node:fs';
import path from 'node:path';

import type { InnerBrainRegistry, TaskRecord } from './inner-brain-registry.js';
import type { KpiRecord, KpiRegistry, ReflexionSummary } from './kpi-registry.js';
import { formatKpiReflexionBlock } from './kpi-registry.js';

/** set_goal 成功时的输出前缀（autonomy / heartbeat 判定用） */
export const SET_GOAL_DISPATCHED_MARKERS = [
  '已创建新内脑实例并启动任务',
  '已在既有内脑实例上续跑',
  '已向内脑派发任务',
] as const;

export function isSetGoalDispatched(output: string): boolean {
  return SET_GOAL_DISPATCHED_MARKERS.some((m) => output.includes(m));
}

/**
 * 同一 KPI 的 canonical 内脑：首个非 meta（非 isReflexionBurst）burst；
 * 若历史上仅有 meta burst，则回退到 kpi.bursts[0]。
 */
export function findCanonicalBurstForKpi(
  innerBrainRegistry: InnerBrainRegistry,
  kpiRegistry: KpiRegistry,
  kpiId: string,
): TaskRecord | undefined {
  const kpi = kpiRegistry.get(kpiId);
  if (!kpi || kpi.bursts.length === 0) return undefined;

  for (const id of kpi.bursts) {
    const rec = innerBrainRegistry.get(id);
    if (rec && rec.kpiId === kpiId && !rec.isReflexionBurst) return rec;
  }
  for (const id of kpi.bursts) {
    const rec = innerBrainRegistry.get(id);
    if (rec && rec.kpiId === kpiId) return rec;
  }
  return undefined;
}

export function writeInnerBrainGoalMd(workDir: string, goal: string): void {
  const brainDir = path.join(workDir, '.brain');
  fs.mkdirSync(brainDir, { recursive: true });
  fs.writeFileSync(path.join(brainDir, 'goal.md'), goal, 'utf8');
}

export function patchCanonicalForContinuation(
  registry: InnerBrainRegistry,
  instanceId: string,
  workDir: string,
  patch: {
    goal: string;
    isReflexionBurst?: boolean;
    originThread?: string;
  },
): void {
  writeInnerBrainGoalMd(workDir, patch.goal);
  registry.update(instanceId, {
    goal: patch.goal,
    status: 'RUNNING',
    finishedAt: undefined,
    pid: undefined,
    errorMessage: undefined,
    lastTickAt: undefined,
    isReflexionBurst: patch.isReflexionBurst ?? false,
    ...(patch.originThread ? { originThread: patch.originThread } : {}),
  });
}

function formatReflexionTrailDigest(recentReflexions: ReflexionSummary[]): string {
  if (recentReflexions.length === 0) return '（暂无 reflexion 记录）';
  return recentReflexions
    .map((r, i) => {
      const lines = [
        `### 第 ${recentReflexions.length - i} 次（${r.ts.slice(0, 16)}, verdict=${r.verdict}）`,
        r.hardFailures.length > 0
          ? `- 硬失败：\n${r.hardFailures.map((f) => `  - ${f}`).join('\n')}`
          : '',
        r.softFailures.length > 0
          ? `- 软失败：\n${r.softFailures.map((f) => `  - ${f}`).join('\n')}`
          : '',
        r.nextStrategy ? `- 上轮建议：${r.nextStrategy}` : '',
      ].filter(Boolean);
      return lines.join('\n');
    })
    .join('\n\n');
}

/** Meta 反思 burst 的 goal.md 正文 */
export function buildKpiMetaReflexionGoal(
  kpi: KpiRecord,
  recentReflexions: ReflexionSummary[],
): string {
  const trailDigest = formatReflexionTrailDigest(recentReflexions);
  return `# KPI 卡点反思（meta-burst）

origin_user: ${kpi.createdBy}

## KPI
${kpi.description}

## 状态
- 已连续 ${kpi.consecutiveIdleBursts} 次 EXECUTE 周期 idle 且无产出
- KPI 已记录 ${kpi.bursts.length} 个 burst id（同一内脑实例复用）
- 已记录 ${kpi.reflexionTrail.length} 条反思

## 历次反思摘要（最近 5 条）
${trailDigest}

## 你的任务
**不要再执行 KPI 本身**——这是一次 meta 反思周期。
请评估：
1. 这个 KPI 是否已陷入"重复撞墙"模式？哪些方向已经死了？
2. 还有什么**手段层面未尝试**的方向？
3. 这个 KPI 是否**根本不可达**？如果是，建议直接放弃。

请将分析结论写入 knowledge.md / constraints.md；周期结束时会写入
.brain/reflexion.json 并进入 KPI reflexionTrail。

输出格式约束：保持原样输出 markdown，不要包 markdown 代码块。`;
}

/** 自动 / 手动续跑真任务时的 goal.md 正文 */
export function buildKpiContinuationGoal(
  kpi: KpiRecord,
  recentReflexions: ReflexionSummary[],
): string {
  const trailBlock = formatKpiReflexionBlock(recentReflexions);
  return (
    `# KPI 续跑（同一内脑实例）\n\n` +
    `origin_user: ${kpi.createdBy}\n\n` +
    `## KPI\n${kpi.description}\n` +
    (trailBlock || '\n（暂无 reflexion trail，请根据 KPI 描述与已有 knowledge 规划下一小步）\n') +
    `\n## 执行约束\n` +
    `- 本轮 EXECUTE 只向 KPI 靠近**一小步**，完成后 REVIEW/REPLAN，不要一次 plan 走到底\n` +
    `- 沿用本 workspace 已有 milestones / knowledge，必要时修订而非另起 workspace\n`
  );
}
