import type { ArmId, GradeResult } from '../types.ts';
import type { RunMetrics } from './metrics.ts';

export interface RunRecord {
  taskId: string;
  arm: ArmId;
  rep: number;
  workspaceId: string;
  runDir: string;
  exit: 'ok' | 'error' | 'timeout';
  exitCode: number | null;
  wallMs: number;
  tampered: string[];
  /** 运行后在宿主上回收的残留（launchd / plist / crontab / 进程） */
  hostResidue?: string[];
  /** 被沙箱垫片拒绝的整杀命令 */
  blockedKills?: string[];
  grade: GradeResult;
  metrics: RunMetrics;
  armResult: unknown;
}

export interface CellSummary {
  taskId: string;
  arm: ArmId;
  runs: number;
  passes: number;
  medianTokens: number;
  medianWallMs: number;
  medianToolCalls: number;
  exits: Record<string, number>;
}

export interface ArmSummary {
  arm: ArmId;
  runs: number;
  passes: number;
  totalTokens: number;
  tokensPerPass: number | null;
}

export interface AblationReport {
  startedAt: string;
  finishedAt: string;
  repeats: number;
  fake: boolean;
  cells: CellSummary[];
  arms: ArmSummary[];
  /** INNER-ABLATION.md §8：A 比 B 多通过 ≥ 2×repeats 次才算编排层有效 */
  verdict: 'dyflow_effective' | 'not_shown_necessary' | 'incomplete';
  runs: RunRecord[];
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function buildReport(
  runs: RunRecord[],
  meta: { startedAt: string; finishedAt: string; repeats: number; fake: boolean },
): AblationReport {
  const keys = [...new Set(runs.map(r => `${r.taskId}\u0000${r.arm}`))];
  const cells: CellSummary[] = keys.map(k => {
    const [taskId, arm] = k.split('\u0000') as [string, ArmId];
    const rs = runs.filter(r => r.taskId === taskId && r.arm === arm);
    const exits: Record<string, number> = {};
    for (const r of rs) exits[r.exit] = (exits[r.exit] ?? 0) + 1;
    return {
      taskId,
      arm,
      runs: rs.length,
      passes: rs.filter(r => r.grade.pass).length,
      medianTokens: median(rs.map(r => r.metrics.totalTokens)),
      medianWallMs: median(rs.map(r => r.wallMs)),
      medianToolCalls: median(rs.map(r => r.metrics.toolCalls)),
      exits,
    };
  });

  const armIds = [...new Set(runs.map(r => r.arm))];
  const arms: ArmSummary[] = armIds.map(arm => {
    const rs = runs.filter(r => r.arm === arm);
    const passes = rs.filter(r => r.grade.pass).length;
    const totalTokens = rs.reduce((s, r) => s + r.metrics.totalTokens, 0);
    return { arm, runs: rs.length, passes, totalTokens, tokensPerPass: passes > 0 ? Math.round(totalTokens / passes) : null };
  });

  const a = arms.find(x => x.arm === 'dyflow');
  const b = arms.find(x => x.arm === 'single');
  let verdict: AblationReport['verdict'] = 'incomplete';
  if (a && b && meta.repeats >= 3 && a.runs === b.runs) {
    verdict = a.passes - b.passes >= 2 * meta.repeats ? 'dyflow_effective' : 'not_shown_necessary';
  }

  return { ...meta, cells, arms, verdict, runs };
}

const k = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : String(Math.round(n)));
const min = (ms: number) => `${(ms / 60_000).toFixed(1)}m`;

export function renderMarkdown(r: AblationReport): string {
  const lines: string[] = [];
  lines.push(`# 内脑消融报告${r.fake ? '（fake 冒烟）' : ''}`, '');
  lines.push(`- 时间：${r.startedAt} → ${r.finishedAt}`);
  lines.push(`- 每格重复：${r.repeats}`);
  lines.push(`- 判读（INNER-ABLATION §8）：**${r.verdict}**`, '');

  lines.push('## 每任务', '', '| 任务 | 臂 | 通过 | token 中位 | 工具调用中位 | 墙钟中位 | 退出 |', '|---|---|---|---|---|---|---|');
  for (const c of r.cells) {
    const exits = Object.entries(c.exits).map(([e, n]) => `${e}×${n}`).join(' ');
    lines.push(`| ${c.taskId} | ${c.arm} | ${c.passes}/${c.runs} | ${k(c.medianTokens)} | ${c.medianToolCalls} | ${min(c.medianWallMs)} | ${exits} |`);
  }

  lines.push('', '## 每臂', '', '| 臂 | 通过 | 总 token | 每次通过 token |', '|---|---|---|---|');
  for (const a of r.arms) {
    lines.push(`| ${a.arm} | ${a.passes}/${a.runs} | ${k(a.totalTokens)} | ${a.tokensPerPass == null ? '—' : k(a.tokensPerPass)} |`);
  }

  lines.push('', '## 未通过的检查', '');
  for (const run of r.runs.filter(x => !x.grade.pass)) {
    const failed = run.grade.checks.filter(c => !c.ok).map(c => `${c.name}${c.detail ? `(${c.detail.slice(0, 80)})` : ''}`);
    const extra = run.tampered.length ? ` 篡改：${run.tampered.join(',')}` : '';
    lines.push(`- ${run.taskId} / ${run.arm} / r${run.rep}（${run.exit}）：${failed.join('; ') || '—'}${extra}`);
  }

  const hazards = r.runs.filter(x => (x.hostResidue?.length ?? 0) > 0 || (x.blockedKills?.length ?? 0) > 0);
  if (hazards.length > 0) {
    lines.push('', '## 宿主副作用', '');
    for (const run of hazards) {
      const parts = [
        ...(run.hostResidue?.length ? [`回收 ${run.hostResidue.join(', ')}`] : []),
        ...(run.blockedKills?.length ? [`拦截 ${run.blockedKills.join(' / ')}`] : []),
      ];
      lines.push(`- ${run.taskId} / ${run.arm} / r${run.rep}：${parts.join('；')}`);
    }
  }
  return lines.join('\n') + '\n';
}
