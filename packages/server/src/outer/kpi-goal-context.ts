/**
 * 为 autonomy / 心跳 KPI goal 起草 LLM 注入尽可能完整的决策上下文。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { InnerBrainEngine } from '../workspace-kit/index.js';
import type { InnerBrainRegistry, TaskRecord } from './inner-brain-registry.js';
import type { KpiRecord, KpiRegistry } from './kpi-registry.js';
import { formatKpiReflexionBlock } from './kpi-registry.js';
import { buildBrainAsyncSnapshot } from './brain-async-snapshot.js';
import { LIVE_KPI_BURST_STATUSES } from './kpi-dispatch-guard.js';
import {
  buildKpiBurstLinks,
  formatKpiDigest,
  suggestKpiAction,
} from './kpi-progress.js';
import { loadOuterGoal } from './outer-goal.js';
import type { OuterMemoryStore } from './outer-memory.js';
import type { ResourceSnapshot } from './autonomy-types.js';

const GOAL_EXCERPT = 700;
const MILESTONE_EXCERPT = 500;
const REFLEXION_COUNT = 5;
const BURST_DETAIL_COUNT = 6;

function safeReadUtf8(filePath: string, maxChars?: number): string | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    if (maxChars != null && raw.length > maxChars) {
      return raw.slice(0, maxChars) + `…（共 ${raw.length} 字符，已截断）`;
    }
    return raw;
  } catch {
    return null;
  }
}

function readDeliverablePaths(workDir: string): string[] {
  const p = path.join(workDir, '.run', 'pi-mono', 'deliverables.json');
  try {
    if (!fs.existsSync(p)) return [];
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function excerptGoal(record: TaskRecord, workDir: string): string {
  const fromFile = safeReadUtf8(path.join(workDir, '.brain', 'goal.md'), GOAL_EXCERPT);
  if (fromFile) return fromFile;
  const g = record.goal.trim();
  if (!g) return '（无 goal 文本）';
  return g.length > GOAL_EXCERPT ? g.slice(0, GOAL_EXCERPT) + '…' : g;
}

function formatBurstDetail(
  record: TaskRecord,
  kpi: KpiRecord,
  getEngine?: (workspaceId: string) => InnerBrainEngine,
): string {
  const lines: string[] = [
    `### ${record.instanceId} [registry=${record.status}]`,
    `- kpi_id: ${record.kpiId ?? '（无）'}`,
    `- started: ${record.startedAt}`,
    `- finished: ${record.finishedAt ?? '—'}`,
    `- ticks: ${record.ticks ?? 0}`,
    `- last_tick_at: ${record.lastTickAt ?? '—'}`,
  ];
  if (record.errorMessage) {
    lines.push(`- error: ${record.errorMessage}`);
  }
  if (record.isReflexionBurst) {
    lines.push('- type: reflexion_burst');
  }

  lines.push('', '**goal 摘要：**', excerptGoal(record, record.workDir));

  const milestones = safeReadUtf8(path.join(record.workDir, '.brain', 'milestones.md'), MILESTONE_EXCERPT);
  if (milestones) {
    lines.push('', '**milestones：**', milestones);
  }

  const deliverables = readDeliverablePaths(record.workDir);
  if (deliverables.length > 0) {
    lines.push('', `**deliverables（${deliverables.length}）：** ${deliverables.join(', ')}`);
  }

  const snap = buildBrainAsyncSnapshot(record.workDir);
  lines.push(
    '',
    '**async：**',
    `- mode=${snap.controller.mode ?? '—'}`,
    `- awaiting=${snap.controller.awaiting_reason ?? '—'}`,
    `- blocked=${snap.controller.blocked_reason ?? '—'}`,
    `- is_async_waiting=${snap.is_async_waiting}`,
    `- is_post_complete=${snap.is_post_complete}`,
    `- next_wake_at=${snap.next_wake_at ?? '—'}`,
  );
  if (snap.active_pendings.length > 0) {
    lines.push('- active_pendings:');
    for (const p of snap.active_pendings.slice(0, 4)) {
      lines.push(
        `  - [${p.kind}] ${p.id} status=${p.status}` +
          (p.prompt_preview ? ` prompt=${p.prompt_preview.slice(0, 80)}` : '') +
          (p.execute_at ? ` at=${p.execute_at}` : ''),
      );
    }
  }

  if (getEngine) {
    try {
      const st = getEngine(record.workspaceId).readStatus();
      if (st) {
        lines.push(
          '',
          '**runtime status：**',
          `- phase=${st.phase}`,
          `- last_action=${st.lastAction ?? '—'}`,
          `- last_error=${st.lastError ?? '—'}`,
          `- tick_count=${st.tickCount}`,
        );
        if (st.deliverables.length > 0) {
          lines.push(
            `- registered_assets: ${st.deliverables.map((d) => d.filename).join(', ')}`,
          );
        }
      }
    } catch {
      /* workspace 可能未初始化 */
    }
  }

  const run = kpi.burstRunHistory.find((r) => r.instanceId === record.instanceId);
  const ev = run?.outcomeEvaluation;
  if (ev) {
    lines.push(
      '',
      '**该 burst 结果评估：**',
      `- successConfirmed=${ev.successConfirmed}`,
      ev.evidenceSummary ? `- evidence: ${ev.evidenceSummary.slice(0, 200)}` : '',
      ev.failureReasons.length ? `- failures: ${ev.failureReasons.slice(0, 3).join('；')}` : '',
    );
  }

  return lines.filter(Boolean).join('\n');
}

function formatLiveBurstSummary(registry: InnerBrainRegistry, kpiId: string): string {
  const live = registry
    .list()
    .filter(
      (t) => t.kpiId === kpiId && LIVE_KPI_BURST_STATUSES.has(t.status),
    );
  if (live.length === 0) return '（本 KPI 当前无 RUNNING/AWAITING/BLOCKED 内脑）';
  return live
    .map((t) => {
      const goalPreview = t.goal.replace(/\s+/g, ' ').slice(0, 120);
      return (
        `- ${t.instanceId} [${t.status}] kpi=${t.kpiId ?? '—'} ticks=${t.ticks ?? 0}\n` +
        `  goal: ${goalPreview}${t.goal.length > 120 ? '…' : ''}`
      );
    })
    .join('\n');
}

function formatResourceSnapshot(snapshot: ResourceSnapshot): string {
  return [
    `captured_at: ${snapshot.capturedAt}`,
    `inner: running=${snapshot.innerBrains.running} awaiting=${snapshot.innerBrains.awaiting}` +
      ` blocked=${snapshot.innerBrains.blocked} async_waiting=${snapshot.innerBrains.asyncWaiting}`,
    `llm: in_flight=${snapshot.llm.inFlight} tokens_1h=${snapshot.llm.tokensLast1h.total}` +
      ` calls_1h=${snapshot.llm.callsLast1h}`,
    `inbound: orch_queued=${snapshot.inbound.orchestratorQueuedTotal}` +
      ` outer_active=${snapshot.inbound.outerLoopActiveThreads}`,
    `process: heap_mb=${snapshot.process.heapUsedMb} rss_mb=${snapshot.process.rssMb}`,
  ].join('\n');
}

export interface KpiGoalPlannerContextInput {
  dataRoot: string;
  kpi: KpiRecord;
  kpiRegistry: KpiRegistry;
  registry: InnerBrainRegistry;
  snapshot: ResourceSnapshot;
  getEngine?: (workspaceId: string) => InnerBrainEngine;
  memoryStore?: OuterMemoryStore;
  now?: Date;
}

/**
 * 拼装 KPI 下一轮 goal 规划用的完整 Markdown 上下文（供 LLM user message）。
 */
export async function buildKpiGoalPlannerContext(input: KpiGoalPlannerContextInput): Promise<string> {
  const now = input.now ?? new Date();
  const { kpi, registry, kpiRegistry, snapshot } = input;
  const links = buildKpiBurstLinks(kpi, registry);
  const { action, reason } = suggestKpiAction(kpi, links);

  const sections: string[] = [];

  sections.push(
    `## 当前时间\n${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} (${now.toISOString()})`,
  );

  sections.push(`## 系统资源快照\n${formatResourceSnapshot(snapshot)}`);

  const longTerm = loadOuterGoal(input.dataRoot).trim();
  if (longTerm) {
    sections.push(`## 外脑长期目标\n${longTerm.slice(0, 1200)}`);
  }

  if (input.memoryStore) {
    try {
      const mem = await input.memoryStore.readMemoryContext(kpi.description.slice(0, 200));
      const memBlock = input.memoryStore.formatMemoryForLlm(mem);
      if (memBlock.trim()) {
        sections.push(memBlock);
      }
    } catch {
      /* mem9 不可用时不阻断 */
    }
  }

  sections.push(`## KPI 总览\n${formatKpiDigest(kpi, registry)}`);
  sections.push(
    `## KPI 元数据`,
    `- kpi_id: ${kpi.kpiId}`,
    `- status: ${kpi.status}`,
    `- created_by: ${kpi.createdBy}`,
    `- created_at: ${kpi.createdAt}`,
    `- last_burst_at: ${kpi.lastBurstAt ?? '—'}`,
    `- consecutive_idle_bursts: ${kpi.consecutiveIdleBursts}`,
    kpi.notes ? `- notes: ${kpi.notes}` : '',
    `- 系统建议动作: ${action}（${reason}）`,
  );

  const reflexionBlock = formatKpiReflexionBlock(
    kpiRegistry.recentReflexions(kpi.kpiId, REFLEXION_COUNT),
  );
  if (reflexionBlock.trim()) {
    sections.push(reflexionBlock.trim());
  }

  const burstIds = kpi.bursts.slice(-BURST_DETAIL_COUNT);
  if (burstIds.length > 0) {
    const burstLines: string[] = ['## 历次 burst 详情（最近）'];
    for (const id of burstIds) {
      const rec = registry.get(id);
      if (rec && rec.kpiId != null && rec.kpiId !== kpi.kpiId) {
        continue;
      }
      if (rec) {
        burstLines.push(formatBurstDetail(rec, kpi, input.getEngine));
      } else {
        burstLines.push(`### ${id}\n（registry 中已缺失）`);
      }
    }
    sections.push(burstLines.join('\n\n'));
  }

  sections.push(
    `## 本 KPI 在途内脑（禁止重复派发）\n${formatLiveBurstSummary(registry, kpi.kpiId)}`,
  );

  const otherKpis = kpiRegistry.list({ status: 'active' }).filter((k) => k.kpiId !== kpi.kpiId);
  if (otherKpis.length > 0) {
    sections.push(
      '## 其他活跃 KPI',
      otherKpis
        .map((k) => `- ${k.kpiId}: ${k.description.slice(0, 200)}（bursts=${k.bursts.length}）`)
        .join('\n'),
    );
  }

  sections.push(
    '## 规划约束',
    '- 只输出一条**新的、可执行**的内脑 goal（Markdown，≤500 字），不要解释、不要前言。',
    '- **禁止**与本 KPI 在途内脑或最近 burst 的 goal 重复同一调研/执行主题。',
    '- 非本 KPI 的一次性内脑 / 群聊杂务只写入记忆层，勿写进 KPI goal。',
    '- 硬失败方向（见反思）禁止重试；优先采纳 nextStrategy 换向建议。',
    '- 若系统建议动作为 continue/follow_up/achieved，应派**明显不同的下一步**而非重开同类任务。',
    '- 若上一轮已有 deliverable，下一轮应**承接产出**（深化、汇总、换维度），不要从零重复。',
  );

  return sections.filter((s) => s.trim()).join('\n\n');
}
