/**
 * 浏览器步骤脚本 / playbook 解析（内联 steps 或 workspace JSON 文件）。
 *
 * ADL：doc/structurizr/BROWSER-SESSION-TOOL.md §2.5
 */

import fs from 'node:fs';
import path from 'node:path';

import { getWorkDir, isPathReadable } from '../tools/definitions/workdir-guard.js';

export const BROWSER_STEP_ACTIONS = [
  'goto',
  'click',
  'fill',
  'type',
  'press',
  'wait',
  'screenshot',
  'snapshot',
  'evaluate',
  'state',
] as const;

export type BrowserStepAction = (typeof BROWSER_STEP_ACTIONS)[number];

export interface BrowserPlaybookStep {
  action: BrowserStepAction;
  [key: string]: unknown;
}

export interface BrowserPlaybookDoc {
  label?: string;
  stop_on_error?: boolean;
  from_step?: number;
  steps: BrowserPlaybookStep[];
}

const MAX_STEPS = 50;

function isStepAction(v: string): v is BrowserStepAction {
  return (BROWSER_STEP_ACTIONS as readonly string[]).includes(v);
}

function normalizeStep(raw: unknown, index: number): BrowserPlaybookStep | string {
  if (!raw || typeof raw !== 'object') {
    return `step ${index}: must be an object`;
  }
  const obj = raw as Record<string, unknown>;
  const action = String(obj['action'] ?? '').trim().toLowerCase();
  if (!action) return `step ${index}: missing action`;
  if (!isStepAction(action)) return `step ${index}: unknown action "${action}"`;
  const out: BrowserPlaybookStep = { action };
  for (const [k, v] of Object.entries(obj)) {
    if (k !== 'action') out[k] = v;
  }
  return out;
}

export function normalizePlaybookSteps(raw: unknown): { steps: BrowserPlaybookStep[] } | { error: string } {
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === 'object' && Array.isArray((raw as BrowserPlaybookDoc).steps)) {
    list = (raw as BrowserPlaybookDoc).steps;
  } else {
    return { error: 'playbook must be a steps array or { steps: [...] }' };
  }
  if (list.length === 0) return { error: 'playbook has no steps' };
  if (list.length > MAX_STEPS) {
    return { error: `playbook exceeds max ${MAX_STEPS} steps` };
  }
  const steps: BrowserPlaybookStep[] = [];
  for (let i = 0; i < list.length; i++) {
    const norm = normalizeStep(list[i], i);
    if (typeof norm === 'string') return { error: norm };
    steps.push(norm);
  }
  return { steps };
}

export function parseInlineStepsArg(raw: unknown): { steps: BrowserPlaybookStep[] } | { error: string } {
  if (raw == null) return { error: 'steps is empty' };
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t) return { error: 'steps is empty' };
    try {
      return normalizePlaybookSteps(JSON.parse(t) as unknown);
    } catch {
      return { error: 'steps string is not valid JSON' };
    }
  }
  return normalizePlaybookSteps(raw);
}

export function loadPlaybookFile(relPath: string): {
  doc: BrowserPlaybookDoc;
  steps: BrowserPlaybookStep[];
} | { error: string } {
  const workDir = getWorkDir();
  const trimmed = relPath.trim();
  if (!trimmed) return { error: 'playbook path is empty' };
  const abs = path.isAbsolute(trimmed) ? trimmed : path.join(workDir, trimmed);
  if (!isPathReadable(abs)) {
    return { error: `playbook not readable: ${relPath}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8')) as unknown;
  } catch (e) {
    return { error: `playbook JSON parse failed: ${String(e)}` };
  }
  const norm = normalizePlaybookSteps(parsed);
  if ('error' in norm) return norm;
  const doc: BrowserPlaybookDoc =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as BrowserPlaybookDoc)
      : { steps: norm.steps };
  return { doc, steps: norm.steps };
}

/** 将 playbook step 转为 runBrowserAct 参数（去掉 action 字段） */
export function stepToActArgs(step: BrowserPlaybookStep): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(step)) {
    if (k !== 'action') args[k] = v;
  }
  return args;
}
