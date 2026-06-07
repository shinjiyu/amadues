/**
 * browser_open / browser_act / browser_close / browser_list — 增量 Playwright 会话。
 *
 * ADL：doc/structurizr/BROWSER-SESSION-TOOL.md
 */

import {
  loadPlaybookFile,
  parseInlineStepsArg,
  type BrowserPlaybookStep,
} from '../../browser/browser-playbook.js';
import {
  closeAllBrowserSessionsForWorkDir,
  closeBrowserSession,
  listBrowserSessions,
  openBrowserSession,
  runBrowserAct,
  runBrowserSteps,
} from '../../browser/session-registry.js';
import { getBrowserSessionWorkDir } from '../../browser/session-scope.js';
import type { Tool } from '../index.js';

const BROWSER_ACT_ACTIONS = [
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

function formatActOutput(result: Awaited<ReturnType<typeof runBrowserAct>>): string {
  if (!result.ok) {
    return JSON.stringify({ ok: false, error: result.error ?? 'browser_act failed' }, null, 2);
  }
  const payload: Record<string, unknown> = { ok: true };
  if (result.url) payload['url'] = result.url;
  if (result.title) payload['title'] = result.title;
  if (result.summary) payload['summary'] = result.summary;
  if (result.screenshot) payload['screenshot'] = result.screenshot;
  if (result.snapshot_path) payload['snapshot_path'] = result.snapshot_path;
  if (result.output) payload['output'] = result.output;
  return JSON.stringify(payload, null, 2);
}

export const browserOpenTool: Tool = {
  name: 'browser_open',
  description:
    'Open a persistent Playwright browser session for incremental UI automation.\n' +
    'Returns session_id — use browser_act for each step (goto/click/fill/…), then browser_close.\n' +
    'Prefer this over writing Playwright scripts + shell_exec.\n' +
    'cookies_file: JSON with "cookie" string or Playwright cookies array. storage_state: Playwright storage JSON path.',
  parameters: {
    label: { type: 'string', description: 'Optional label for audit logs' },
    headless: { type: 'boolean', description: 'Default true (INNER_BROWSER_HEADLESS=0 for headed)' },
    viewport_width: { type: 'number', description: 'Default 1280' },
    viewport_height: { type: 'number', description: 'Default 900' },
    cookies_file: { type: 'string', description: 'workDir-relative path to cookies JSON' },
    storage_state: { type: 'string', description: 'workDir-relative Playwright storage state JSON' },
    user_agent: { type: 'string', description: 'Optional user agent' },
  },
  required: [],

  async call(args) {
    const r = await openBrowserSession({
      label: args['label'] != null ? String(args['label']) : undefined,
      headless: args['headless'] != null ? Boolean(args['headless']) : undefined,
      viewportWidth: args['viewport_width'] != null ? Number(args['viewport_width']) : undefined,
      viewportHeight: args['viewport_height'] != null ? Number(args['viewport_height']) : undefined,
      cookiesFile: args['cookies_file'] != null ? String(args['cookies_file']) : undefined,
      storageState: args['storage_state'] != null ? String(args['storage_state']) : undefined,
      userAgent: args['user_agent'] != null ? String(args['user_agent']) : undefined,
    });
    return { ok: r.ok, output: r.output };
  },
};

export const browserActTool: Tool = {
  name: 'browser_act',
  description:
    'Run one incremental browser action on an open session.\n' +
    `Actions: ${BROWSER_ACT_ACTIONS.join(', ')}.\n` +
    'click: use selector or text. screenshot/snapshot: save under workDir; use describe_image on PNG.\n' +
    'After errors, browser state is preserved — fix the step and retry without browser_open.',
  parameters: {
    session_id: { type: 'string', description: 'From browser_open' },
    action: {
      type: 'string',
      description: 'Action name',
      enum: [...BROWSER_ACT_ACTIONS],
    },
    url: { type: 'string', description: 'goto: target URL' },
    selector: { type: 'string', description: 'click/fill/type/wait: CSS selector' },
    text: { type: 'string', description: 'click: visible text, or type: text to enter' },
    value: { type: 'string', description: 'fill: value' },
    key: { type: 'string', description: 'press: key name e.g. Enter' },
    ms: { type: 'number', description: 'wait: milliseconds' },
    state: { type: 'string', description: 'wait for selector: visible|hidden|attached|detached' },
    path: { type: 'string', description: 'screenshot or snapshot output path (workDir-relative)' },
    expression: { type: 'string', description: 'evaluate: JS expression in page context' },
    timeout_ms: { type: 'number', description: 'Per-action timeout (default 15000)' },
    full_page: { type: 'boolean', description: 'screenshot: full page' },
    delay_ms: { type: 'number', description: 'type: per-key delay' },
  },
  required: ['session_id', 'action'],

  async call(args) {
    const sessionId = String(args['session_id'] ?? '').trim();
    const action = String(args['action'] ?? '').trim();
    if (!sessionId) return { ok: false, output: 'Missing required argument: session_id' };
    if (!action) return { ok: false, output: 'Missing required argument: action' };

    const actArgs: Record<string, unknown> = { ...args };
    delete actArgs['session_id'];
    delete actArgs['action'];

    const result = await runBrowserAct(sessionId, action, actArgs);
    return { ok: result.ok, output: formatActOutput(result) };
  },
};

export const browserCloseTool: Tool = {
  name: 'browser_close',
  description:
    'Close a browser session (or all sessions in this workspace when all=true).\n' +
    'Framework also auto-closes sessions when the baseNode exits.',
  parameters: {
    session_id: { type: 'string', description: 'Session to close' },
    all: { type: 'boolean', description: 'Close all sessions for this workDir' },
  },
  required: [],

  async call(args) {
    if (args['all'] === true || args['all'] === 'true') {
      const n = await closeAllBrowserSessionsForWorkDir(getBrowserSessionWorkDir());
      return { ok: true, output: `closed ${n} browser session(s)` };
    }
    const sessionId = String(args['session_id'] ?? '').trim();
    if (!sessionId) {
      return { ok: false, output: 'Provide session_id or all=true' };
    }
    return closeBrowserSession(sessionId);
  },
};

export const browserListTool: Tool = {
  name: 'browser_list',
  description: 'List active browser sessions in this workspace (session_id, label, current url).',
  parameters: {},
  required: [],

  async call() {
    const list = listBrowserSessions();
    return { ok: true, output: JSON.stringify({ sessions: list }, null, 2) };
  },
};

function formatRunStepsOutput(result: Awaited<ReturnType<typeof runBrowserSteps>>): string {
  return JSON.stringify(result, null, 2);
}

export const browserRunStepsTool: Tool = {
  name: 'browser_run_steps',
  description:
    'Run a scripted sequence of browser_act steps on an open session (one tool call, same incremental browser).\n' +
    'Provide inline `steps` (JSON array) OR `playbook` (workDir-relative .json path).\n' +
    'Playbook format: { "label"?, "stop_on_error"?, "from_step"?, "steps": [{ "action": "goto", "url": "..." }, ...] }.\n' +
    'Use `from_step` to resume after a failed step without browser_open. Stable flows: record_fact the playbook path.',
  parameters: {
    session_id: { type: 'string', description: 'From browser_open' },
    steps: {
      type: 'string',
      description: 'Inline JSON: array of steps or { steps: [...] }',
    },
    playbook: {
      type: 'string',
      description: 'workDir-relative playbook JSON file (alternative to steps)',
    },
    from_step: {
      type: 'number',
      description: '0-based step index to start from (resume); overrides playbook from_step',
    },
    stop_on_error: {
      type: 'boolean',
      description: 'Stop on first failed step (default true)',
    },
  },
  required: ['session_id'],

  async call(args) {
    const sessionId = String(args['session_id'] ?? '').trim();
    if (!sessionId) return { ok: false, output: 'Missing required argument: session_id' };

    const playbookPath = args['playbook'] != null ? String(args['playbook']).trim() : '';
    const inlineSteps = args['steps'];

    let steps: BrowserPlaybookStep[] = [];
    let docFromStep: number | undefined;

    if (playbookPath) {
      const loaded = loadPlaybookFile(playbookPath);
      if ('error' in loaded) {
        return { ok: false, output: loaded.error };
      }
      steps = loaded.steps;
      if (typeof loaded.doc.from_step === 'number') {
        docFromStep = loaded.doc.from_step;
      }
    } else if (inlineSteps != null) {
      const parsed = parseInlineStepsArg(inlineSteps);
      if ('error' in parsed) {
        return { ok: false, output: parsed.error };
      }
      steps = parsed.steps;
    } else {
      return { ok: false, output: 'Provide steps (inline JSON) or playbook (file path)' };
    }

    const fromStep =
      args['from_step'] != null
        ? Number(args['from_step'])
        : docFromStep ?? 0;
    const stopOnError =
      args['stop_on_error'] === false || args['stop_on_error'] === 'false' ? false : true;

    const result = await runBrowserSteps(sessionId, steps, { fromStep, stopOnError });
    return { ok: result.ok, output: formatRunStepsOutput(result) };
  },
};
