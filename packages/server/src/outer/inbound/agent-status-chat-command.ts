/**
 * 聊天只读快指令 — ADL IM-INBOUND-INTENT-ROUTING.md §4.1
 *
 * `状态/进度`：当前 KPI、在跑/等待、最近结果与执行槽。
 * `密度/今天`：过去 24h 执行槽位利用率、等待时长、完成/失败与最活跃 KPI。
 *
 * 整句匹配；无 LLM、无副作用、不读取 brain-inspector / workspace。
 */
import {
  buildAgentActivitySnapshot,
  type AgentActivitySnapshot,
  type ActivityTaskSummary,
  type BuildAgentActivitySnapshotInput,
} from '../agent-activity-snapshot.js';

export type AgentStatusChatCommand = 'progress' | 'density';

const PROGRESS_COMMANDS = new Set(['状态', '进度', '/status', '/progress']);
const DENSITY_COMMANDS = new Set(['密度', '今天', '/density', '/today']);

export function parseAgentStatusChatCommand(content: string): AgentStatusChatCommand | null {
  const normalized = content.trim().toLocaleLowerCase();
  if (PROGRESS_COMMANDS.has(normalized)) return 'progress';
  if (DENSITY_COMMANDS.has(normalized)) return 'density';
  return null;
}

function compact(value: string, max = 72): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = minutes / 60;
  return `${hours >= 10 ? Math.round(hours) : hours.toFixed(1)} 小时`;
}

function taskLine(task: ActivityTaskSummary): string {
  const kpi = task.kpiDescription ? ` · ${compact(task.kpiDescription, 24)}` : '';
  const output = task.deliverableCount > 0 ? ` · 产出 ${task.deliverableCount}` : '';
  return `- ${compact(task.goal)}${kpi} · ${formatDuration(task.elapsedMs)}${output}`;
}

export function formatProgressReply(snapshot: AgentActivitySnapshot): string {
  const { progress } = snapshot;
  const lines = [
    '📍 当前进度',
    `执行槽：${progress.runningSlots}/${progress.maxRunningInnerBrains}（空闲 ${progress.freeSlots}）`,
  ];

  if (progress.activeKpis.length > 0) {
    lines.push(
      '',
      `🎯 Active KPI（${progress.activeKpis.length}）`,
      ...progress.activeKpis
        .slice(0, 3)
        .map((kpi) => `- ${compact(kpi.description)}（momentum ${kpi.momentum}）`),
    );
  }

  lines.push('', `▶️ 进行中（${progress.running.length}）`);
  lines.push(
    ...(progress.running.length > 0
      ? progress.running.slice(0, 5).map(taskLine)
      : ['- 当前没有执行中的任务']),
  );

  if (progress.blocked.length > 0) {
    lines.push('', `⛔ 阻塞（${progress.blocked.length}）`, ...progress.blocked.slice(0, 3).map(taskLine));
  }
  if (progress.awaiting.length > 0) {
    lines.push('', `⏸️ 等待（${progress.awaiting.length}）`, ...progress.awaiting.slice(0, 5).map(taskLine));
  }
  if (progress.recentTerminal.length > 0) {
    lines.push(
      '',
      '最近结果',
      ...progress.recentTerminal.slice(0, 3).map((task) => {
        const icon = task.status === 'DONE' ? '✅' : task.status === 'STOPPED' ? '⏹️' : '❌';
        return `${icon} ${compact(task.goal)} · ${task.status}`;
      }),
    );
  }
  return lines.join('\n');
}

export function formatActivityDensityReply(snapshot: AgentActivitySnapshot): string {
  const { activity } = snapshot;
  const densityPercent = Math.round(activity.density * 100);
  const lines = [
    '📊 过去 24 小时',
    `执行密度：${densityPercent}%`,
    `执行时长：${formatDuration(activity.executionMs)}`,
    `等待时长：${formatDuration(activity.awaitingMs)}（不计入执行密度）`,
    `任务：启动 ${activity.started} · 完成 ${activity.completed} · 失败 ${activity.failed} · 停止 ${activity.stopped}`,
  ];

  if (activity.topKpis.length > 0) {
    lines.push(
      '',
      '最活跃 KPI',
      ...activity.topKpis.map(
        (kpi) => `- ${compact(kpi.description)} · ${formatDuration(kpi.executionMs)}`,
      ),
    );
  }
  if (activity.estimatedTaskCount > 0) {
    lines.push('', `注：${activity.estimatedTaskCount} 个历史任务缺少状态时间线，时长为估算。`);
  }
  return lines.join('\n');
}

export type AgentStatusChatCommandResult =
  | { handled: false }
  | {
      handled: true;
      kind: AgentStatusChatCommand;
      text: string;
      snapshot: AgentActivitySnapshot;
    };

export function tryHandleAgentStatusChatCommand(
  input: BuildAgentActivitySnapshotInput & { content: string },
): AgentStatusChatCommandResult {
  const kind = parseAgentStatusChatCommand(input.content);
  if (!kind) return { handled: false };
  const snapshot = buildAgentActivitySnapshot(input);
  return {
    handled: true,
    kind,
    text: kind === 'progress' ? formatProgressReply(snapshot) : formatActivityDensityReply(snapshot),
    snapshot,
  };
}
