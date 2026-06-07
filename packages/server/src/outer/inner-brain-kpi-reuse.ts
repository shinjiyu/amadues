/**
 * 同一 KPI / 长期目标 → 单一 canonical 内脑实例，续跑复用 workDir。
 *
 * 设计：[`doc/structurizr/INNER-BRAIN-SINGLE-INSTANCE.md`](../../../../doc/structurizr/INNER-BRAIN-SINGLE-INSTANCE.md)
 */
import fs from 'node:fs';
import path from 'node:path';

import type { InnerBrainRegistry, TaskRecord } from './inner-brain-registry.js';
import type { KpiRecord, KpiRegistry, ReflexionSummary } from './kpi-registry.js';
import { formatBurstRunDigest } from './kpi/burst-run-history.js';

/** set_goal 成功时的输出前缀（autonomy / heartbeat 判定用） */
export const SET_GOAL_DISPATCHED_MARKERS = [
  '已创建新内脑实例并启动任务',
  '已在既有内脑实例上续跑',
  '已向内脑派发任务',
] as const;

export function isSetGoalDispatched(output: string): boolean {
  return SET_GOAL_DISPATCHED_MARKERS.some((m) => output.includes(m));
}

/** 同一 KPI 的 canonical 内脑：kpi.canonicalInstanceId 或 bursts[0] */
export function findCanonicalBurstForKpi(
  innerBrainRegistry: InnerBrainRegistry,
  kpiRegistry: KpiRegistry,
  kpiId: string,
): TaskRecord | undefined {
  const kpi = kpiRegistry.get(kpiId);
  if (!kpi || kpi.bursts.length === 0) return undefined;

  const preferred = kpi.canonicalInstanceId ?? kpi.bursts[0];
  if (preferred) {
    const rec = innerBrainRegistry.get(preferred);
    if (rec && rec.kpiId === kpiId) return rec;
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

/** @deprecated reflexion meta burst 已退役；保留供历史测试引用 */
export function buildKpiMetaReflexionGoal(
  kpi: KpiRecord,
  recentReflexions: ReflexionSummary[],
): string {
  const trailDigest = formatReflexionTrailDigest(recentReflexions);
  return (
    `# KPI 卡点反思（已废弃 meta-burst）\n\n` +
    `origin_user: ${kpi.createdBy}\n\n## KPI\n${kpi.description}\n\n` +
    `请改用外脑 outcomeEvaluator + advance_kpi。\n\n${trailDigest}`
  );
}

/** 自动 / 手动续跑真任务时的 goal.md 正文 */
export function buildKpiContinuationGoal(kpi: KpiRecord): string {
  const historyBlock = formatBurstRunDigest(kpi, 5);
  const charter = kpi.charter?.trim();
  return (
    `# KPI 续跑（同一内脑实例）\n\n` +
    `origin_user: ${kpi.createdBy}\n\n` +
    `## KPI\n${kpi.description}\n` +
    (charter ? `\n## 当前章程\n${charter}\n` : '') +
    `\n${historyBlock}\n` +
    `\n## 执行约束\n` +
    `- 本轮 EXECUTE 只向 KPI 靠近**一小步**，完成后 REVIEW/REPLAN，不要一次 plan 走到底\n` +
    `- 沿用本 workspace 已有 memory.facts / deliverables，必要时修订而非另起 workspace\n`
  );
}
