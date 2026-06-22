/**
 * 内脑 burst 退出时的辅助（registry 终态、DyFlow 失败判定）。
 */
import fs from 'node:fs';
import path from 'node:path';

import type { DyflowState } from '../openkuroneko/inner-brain/types.js';
import { formatInnerWorkerExitMessage } from '../llm/llm-transport-error.js';
import type { TaskStatus } from './inner-brain-registry.js';

/** 读取 deliverables.json 条目数 */
export function countDeliverables(workDir: string): number {
  const p = path.join(workDir, '.run', 'pi-mono', 'deliverables.json');
  try {
    if (!fs.existsSync(p)) return 0;
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

const DYFLOW_FAILURE_REASON = /空转|LLM 调用失败|安全轮次上限|RUN failed|无法推进/i;

/** goal 要求远程部署，但 memory/dyflow 记录 BLOCKED 或未部署 */
const GOAL_DEPLOY_PATTERN = /部署到|部署|deploy|onlyclaws|nginx|pm2|systemd|ssh/i;
const GAP_SIGNAL_PATTERN =
  /\[BLOCKED\]|未远程部署|未部署到|沙箱.*(?:SSH|出站)|出站.*受限|安全组|需在有.*SSH|远程部署限制/i;

export interface BurstGoalGap {
  hasGap: boolean;
  blocked: boolean;
  issues: string[];
  suggestedActions: string[];
}

export interface InnerBurstExitResolution {
  finalStatus: TaskStatus;
  errorMessage: string | null;
  /** DyFlow DONE 但 goal 未完全达成；onExit 走 partial 通知（仍可附产出） */
  partialWithDeliverables?: boolean;
}

function readMemoryFactTexts(workDir: string): string[] {
  const p = path.join(workDir, '.brain', 'memory.json');
  if (!fs.existsSync(p)) return [];
  try {
    const mem = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      fact_records?: Array<{ status?: string; content: string }>;
      facts?: string[];
      constraints?: string[];
    };
    const fromRecords = (mem.fact_records ?? [])
      .filter((r) => r.status === 'active' || r.status == null)
      .map((r) => r.content);
    return [...fromRecords, ...(mem.facts ?? []), ...(mem.constraints ?? [])];
  } catch {
    return [];
  }
}

function readGoalText(workDir: string): string {
  const p = path.join(workDir, '.brain', 'goal.md');
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  } catch {
    return '';
  }
}

/** 对比 goal 与 memory/dyflow，检出「本地完成但未部署」等假完成 */
export function detectBurstGoalGaps(workDir: string): BurstGoalGap {
  const goal = readGoalText(workDir);
  if (!GOAL_DEPLOY_PATTERN.test(goal)) {
    return { hasGap: false, blocked: false, issues: [], suggestedActions: [] };
  }

  const dyflow = readDyflowState(workDir);
  const reason = dyflow?.reason?.trim() ?? '';
  const factTexts = readMemoryFactTexts(workDir);
  const gapLines = [reason, ...factTexts].filter((t) => t && GAP_SIGNAL_PATTERN.test(t));
  if (gapLines.length === 0) {
    return { hasGap: false, blocked: false, issues: [], suggestedActions: [] };
  }

  const blocked = gapLines.some((t) => /\[BLOCKED\]|沙箱|安全组|出站.*受限/i.test(t));
  const issues: string[] = [];
  const blockedLine = gapLines.find((t) => /\[BLOCKED\]/i.test(t));
  if (blockedLine) {
    issues.push(blockedLine.replace(/^\[BLOCKED\]\s*/i, '').trim().slice(0, 500));
  } else {
    const deployLine = gapLines.find((t) => /未远程部署|未部署|远程部署限制/i.test(t));
    issues.push((deployLine ?? gapLines[0]!).trim().slice(0, 500));
  }

  const suggestedActions: string[] = blocked
    ? [
        '沙箱环境无法 SSH 到目标服务器；请在你本地或有出站权限的机器执行工作区内的 `deploy-auto.sh`（见 DEPLOY_README.md）。',
        '若必须从沙箱部署，请在云安全组放行目标 IP 的 SSH/HTTP，或告知我改由你本地执行部署。',
      ]
    : ['请确认远程部署是否已完成；若未部署，请按工作区 DEPLOY_README.md 执行部署脚本。'];

  return { hasGap: true, blocked, issues, suggestedActions };
}

export function formatBurstGoalGapMessage(gaps: BurstGoalGap): string {
  const parts = ['**未达成的目标：**'];
  for (const issue of gaps.issues) {
    parts.push(`· ${issue}`);
  }
  if (gaps.suggestedActions.length > 0) {
    parts.push('');
    parts.push('**需要你协助：**');
    for (const action of gaps.suggestedActions) {
      parts.push(`· ${action}`);
    }
  }
  return parts.join('\n');
}

export function readDyflowState(workDir: string): DyflowState | null {
  const p = path.join(workDir, '.brain', 'dyflow-state.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as DyflowState;
  } catch {
    return null;
  }
}

/** DyFlow 终态是否为失败（含 legacy DONE+失败 reason） */
export function isDyflowBurstFailure(workDir: string): { failed: boolean; reason: string | null } {
  const state = readDyflowState(workDir);
  if (!state) return { failed: false, reason: null };
  if (state.mode === 'ERROR') {
    return { failed: true, reason: state.reason?.trim() || '内脑异常结束' };
  }
  if (state.mode === 'DONE') {
    const reason = state.reason?.trim() ?? '';
    if (reason && DYFLOW_FAILURE_REASON.test(reason)) {
      return { failed: true, reason };
    }
  }
  return { failed: false, reason: null };
}

export function resolveInnerBurstFinalStatus(input: {
  workDir: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stoppedBy?: string;
  workerError?: string | null;
  isAwaiting?: boolean;
}): InnerBurstExitResolution {
  const { workDir, exitCode, signal, stoppedBy, workerError, isAwaiting } = input;

  if (exitCode !== 0 && signal == null) {
    return {
      finalStatus: 'ERROR',
      errorMessage: formatInnerWorkerExitMessage(exitCode, workerError),
    };
  }

  if (signal != null || stoppedBy === 'stop_signal') {
    return { finalStatus: 'STOPPED', errorMessage: null };
  }

  if (isAwaiting) {
    return { finalStatus: 'AWAITING', errorMessage: null };
  }

  const dyflowFail = isDyflowBurstFailure(workDir);
  if (dyflowFail.failed) {
    return { finalStatus: 'ERROR', errorMessage: dyflowFail.reason };
  }

  const gaps = detectBurstGoalGaps(workDir);
  if (gaps.hasGap) {
    return {
      finalStatus: 'ERROR',
      errorMessage: formatBurstGoalGapMessage(gaps),
      partialWithDeliverables: true,
    };
  }

  return { finalStatus: 'DONE', errorMessage: null };
}
