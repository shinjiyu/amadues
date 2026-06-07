/**
 * 进程内 Playwright 浏览器会话注册表。
 *
 * ADL：doc/structurizr/BROWSER-SESSION-TOOL.md
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { stepToActArgs, type BrowserPlaybookStep } from './browser-playbook.js';
import { inlinePageSummary } from './page-summary.js';
import { loadPlaywright } from './playwright-loader.js';
import {
  getBrowserSessionNodeInstId,
  getBrowserSessionWorkDir,
} from './session-scope.js';
import { getWorkDir, isPathReadable, isPathWritable, pathSecurityError } from '../tools/definitions/workdir-guard.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PwPage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PwBrowser = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type PwContext = any;

export interface BrowserSessionRecord {
  id: string;
  label: string;
  workDir: string;
  nodeInstId: string;
  browser: PwBrowser;
  context: PwContext;
  page: PwPage;
  createdAt: number;
  lastUsedAt: number;
}

export interface BrowserOpenOptions {
  label?: string;
  headless?: boolean;
  viewportWidth?: number;
  viewportHeight?: number;
  cookiesFile?: string;
  storageState?: string;
  userAgent?: string;
}

export interface BrowserActResult {
  ok: boolean;
  url?: string;
  title?: string;
  summary?: string;
  screenshot?: string;
  snapshot_path?: string;
  output?: string;
  error?: string;
}

const sessions = new Map<string, BrowserSessionRecord>();

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function defaultHeadless(): boolean {
  const raw = process.env['INNER_BROWSER_HEADLESS']?.trim().toLowerCase();
  if (raw === '0' || raw === 'false' || raw === 'off') return false;
  return true;
}

function maxSessionsPerWorkDir(): number {
  return readPositiveIntEnv('INNER_BROWSER_MAX_PER_WORKDIR', 3);
}

function defaultActionTimeoutMs(): number {
  return readPositiveIntEnv('INNER_BROWSER_ACTION_TIMEOUT_MS', 15_000);
}

function resolveReadablePath(relOrAbs: string, workDir: string): string | null {
  const trimmed = relOrAbs.trim();
  if (!trimmed) return null;
  const abs = path.isAbsolute(trimmed) ? trimmed : path.join(workDir, trimmed);
  if (!isPathReadable(abs)) return null;
  return abs;
}

function resolveWritableRelPath(relPath: string, workDir: string): string | null {
  const trimmed = relPath.trim();
  if (!trimmed) return null;
  const abs = path.isAbsolute(trimmed) ? trimmed : path.join(workDir, trimmed);
  if (!isPathWritable(abs)) return null;
  return path.relative(workDir, abs).split(path.sep).join('/');
}

function countSessionsForWorkDir(workDir: string): number {
  let n = 0;
  for (const s of sessions.values()) {
    if (s.workDir === workDir) n += 1;
  }
  return n;
}

function touchSession(rec: BrowserSessionRecord): void {
  rec.lastUsedAt = Date.now();
}

async function parseCookiesFromFile(absPath: string): Promise<Array<Record<string, string>>> {
  const raw = fs.readFileSync(absPath, 'utf8');
  const data = JSON.parse(raw) as unknown;
  if (Array.isArray(data)) {
    return data as Array<Record<string, string>>;
  }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj['cookies'])) {
      return obj['cookies'] as Array<Record<string, string>>;
    }
    const cookieStr = obj['cookie'];
    if (typeof cookieStr === 'string' && cookieStr.trim()) {
      const out: Array<Record<string, string>> = [];
      for (const part of cookieStr.split(';')) {
        const item = part.trim();
        const eq = item.indexOf('=');
        if (eq > 0) {
          out.push({
            name: item.substring(0, eq).trim(),
            value: item.substring(eq + 1).trim(),
            domain: '.fanqienovel.com',
            path: '/',
          });
        }
      }
      return out;
    }
  }
  return [];
}

export function generateBrowserSessionId(): string {
  return `br-${crypto.randomBytes(4).toString('hex')}`;
}

export function getBrowserSession(sessionId: string): BrowserSessionRecord | undefined {
  return sessions.get(sessionId.trim());
}

export function listBrowserSessions(workDir?: string): Array<{
  session_id: string;
  label: string;
  url: string;
  node_inst_id: string;
}> {
  const wd = workDir ?? getBrowserSessionWorkDir();
  const out: Array<{ session_id: string; label: string; url: string; node_inst_id: string }> = [];
  for (const s of sessions.values()) {
    if (s.workDir !== wd) continue;
    let url = '';
    try {
      url = String(s.page?.url?.() ?? '');
    } catch {
      url = '';
    }
    out.push({
      session_id: s.id,
      label: s.label,
      url,
      node_inst_id: s.nodeInstId,
    });
  }
  return out;
}

export async function openBrowserSession(opts: BrowserOpenOptions = {}): Promise<{
  ok: boolean;
  session_id?: string;
  output: string;
}> {
  const workDir = getBrowserSessionWorkDir();
  const nodeInstId = getBrowserSessionNodeInstId();
  if (!workDir) {
    return { ok: false, output: 'browser scope not set (internal error)' };
  }
  if (countSessionsForWorkDir(workDir) >= maxSessionsPerWorkDir()) {
    return {
      ok: false,
      output: `max browser sessions (${maxSessionsPerWorkDir()}) reached for this workspace; browser_close first`,
    };
  }

  const pw = await loadPlaywright();
  const headless = opts.headless ?? defaultHeadless();
  const viewport = {
    width: opts.viewportWidth ?? 1280,
    height: opts.viewportHeight ?? 900,
  };

  let storageStatePath: string | undefined;
  if (opts.storageState?.trim()) {
    const abs = resolveReadablePath(opts.storageState, workDir);
    if (!abs) {
      return { ok: false, output: `storage_state not readable: ${opts.storageState}` };
    }
    storageStatePath = abs;
  }

  const browser = await pw.chromium.launch({
    headless,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  const contextOpts: Record<string, unknown> = { viewport };
  if (opts.userAgent?.trim()) contextOpts['userAgent'] = opts.userAgent.trim();
  if (storageStatePath) contextOpts['storageState'] = storageStatePath;

  const context = await browser.newContext(contextOpts);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  if (opts.cookiesFile?.trim()) {
    const abs = resolveReadablePath(opts.cookiesFile, workDir);
    if (!abs) {
      await browser.close();
      return { ok: false, output: `cookies_file not readable: ${opts.cookiesFile}` };
    }
    try {
      const cookies = await parseCookiesFromFile(abs);
      if (cookies.length) await context.addCookies(cookies);
    } catch (e) {
      await browser.close();
      return { ok: false, output: `cookies_file parse failed: ${String(e)}` };
    }
  }

  const page = await context.newPage();
  const id = generateBrowserSessionId();
  const now = Date.now();
  const rec: BrowserSessionRecord = {
    id,
    label: opts.label?.trim() || id,
    workDir,
    nodeInstId,
    browser,
    context,
    page,
    createdAt: now,
    lastUsedAt: now,
  };
  sessions.set(id, rec);

  return {
    ok: true,
    session_id: id,
    output: JSON.stringify(
      {
        session_id: id,
        label: rec.label,
        headless,
        viewport,
        hint: 'Use browser_act with this session_id for incremental steps; browser_close when done.',
      },
      null,
      2,
    ),
  };
}

async function captureAriaSnapshot(page: PwPage): Promise<string> {
  try {
    const snap = await page.locator('body').ariaSnapshot();
    return typeof snap === 'string' ? snap : String(snap ?? '');
  } catch {
    return '(aria snapshot unavailable)';
  }
}

async function pageState(rec: BrowserSessionRecord): Promise<{
  url: string;
  title: string;
  summary: string;
}> {
  const url = rec.page.url();
  const title = await rec.page.title();
  const treeText = await captureAriaSnapshot(rec.page);
  return { url, title, summary: inlinePageSummary(url, title, treeText) };
}

export async function runBrowserAct(
  sessionId: string,
  action: string,
  args: Record<string, unknown>,
): Promise<BrowserActResult> {
  const rec = sessions.get(sessionId.trim());
  if (!rec) {
    return { ok: false, error: `unknown session_id: ${sessionId}` };
  }
  const workDir = getBrowserSessionWorkDir();
  if (rec.workDir !== workDir) {
    return { ok: false, error: 'session belongs to another workDir' };
  }

  touchSession(rec);
  const page = rec.page;
  const timeout = Math.min(
    Number(args['timeout_ms'] ?? defaultActionTimeoutMs()),
    120_000,
  );
  page.setDefaultTimeout(timeout);

  const act = action.trim().toLowerCase();

  try {
    if (act === 'goto') {
      const url = String(args['url'] ?? '').trim();
      if (!url) return { ok: false, error: 'goto requires url' };
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      const st = await pageState(rec);
      return { ok: true, ...st };
    }

    if (act === 'click') {
      const selector = String(args['selector'] ?? '').trim();
      const text = String(args['text'] ?? '').trim();
      if (selector) {
        await page.locator(selector).first().click({ timeout });
      } else if (text) {
        await page.getByText(text, { exact: false }).first().click({ timeout });
      } else {
        return { ok: false, error: 'click requires selector or text' };
      }
      const st = await pageState(rec);
      return { ok: true, ...st };
    }

    if (act === 'fill') {
      const selector = String(args['selector'] ?? '').trim();
      const value = String(args['value'] ?? '');
      if (!selector) return { ok: false, error: 'fill requires selector' };
      await page.locator(selector).first().fill(value, { timeout });
      const st = await pageState(rec);
      return { ok: true, ...st };
    }

    if (act === 'type') {
      const selector = String(args['selector'] ?? '').trim();
      const text = String(args['text'] ?? '');
      const delay = Number(args['delay_ms'] ?? 0);
      if (!selector) return { ok: false, error: 'type requires selector' };
      const loc = page.locator(selector).first();
      await loc.click({ timeout });
      if (delay > 0) {
        await loc.pressSequentially(text, { delay });
      } else {
        await loc.pressSequentially(text);
      }
      const st = await pageState(rec);
      return { ok: true, ...st };
    }

    if (act === 'press') {
      const key = String(args['key'] ?? '').trim();
      if (!key) return { ok: false, error: 'press requires key' };
      await page.keyboard.press(key);
      const st = await pageState(rec);
      return { ok: true, ...st };
    }

    if (act === 'wait') {
      const ms = Number(args['ms'] ?? 0);
      const selector = String(args['selector'] ?? '').trim();
      const state = String(args['state'] ?? 'visible').trim();
      if (selector) {
        await page.locator(selector).first().waitFor({ state, timeout });
      } else if (ms > 0) {
        await page.waitForTimeout(ms);
      } else {
        return { ok: false, error: 'wait requires ms or selector' };
      }
      const st = await pageState(rec);
      return { ok: true, ...st };
    }

    if (act === 'screenshot') {
      const rel = String(args['path'] ?? '').trim();
      if (!rel) return { ok: false, error: 'screenshot requires path' };
      const abs = path.isAbsolute(rel) ? rel : path.join(workDir, rel);
      if (!isPathWritable(abs)) {
        return { ok: false, error: pathSecurityError(abs) };
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      await page.screenshot({ path: abs, fullPage: Boolean(args['full_page']) });
      const relOut = resolveWritableRelPath(rel, workDir) ?? rel;
      const st = await pageState(rec);
      return { ok: true, ...st, screenshot: relOut };
    }

    if (act === 'snapshot') {
      const treeText = await captureAriaSnapshot(page);
      const st = await pageState(rec);
      const rel = String(args['path'] ?? '').trim();
      if (rel) {
        const abs = path.isAbsolute(rel) ? rel : path.join(workDir, rel);
        if (!isPathWritable(abs)) {
          return { ok: false, error: pathSecurityError(abs) };
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, treeText, 'utf8');
        const relOut = resolveWritableRelPath(rel, workDir) ?? rel;
        return { ok: true, ...st, snapshot_path: relOut, summary: st.summary };
      }
      return { ok: true, ...st, output: treeText.slice(0, 4000) };
    }

    if (act === 'evaluate') {
      const expression = String(args['expression'] ?? '').trim();
      if (!expression) return { ok: false, error: 'evaluate requires expression' };
      const result = await page.evaluate((expr: string) => {
        try {
          // eslint-disable-next-line no-eval
          return eval(expr);
        } catch {
          // eslint-disable-next-line no-new-func
          const fn = new Function(`return (${expr})`);
          return fn();
        }
      }, expression);
      const st = await pageState(rec);
      const out =
        typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return { ok: true, ...st, output: out.slice(0, 4000) };
    }

    if (act === 'state') {
      const st = await pageState(rec);
      return { ok: true, ...st };
    }

    return { ok: false, error: `unknown action: ${action}` };
  } catch (e) {
    return { ok: false, error: String(e instanceof Error ? e.message : e) };
  }
}

export interface BrowserStepRunRecord {
  step: number;
  action: string;
  ok: boolean;
  error?: string;
}

export interface BrowserRunStepsResult {
  ok: boolean;
  completed: number;
  total: number;
  from_step: number;
  failed_step?: number;
  failed_action?: string;
  error?: string;
  results: BrowserStepRunRecord[];
  url?: string;
  title?: string;
}

export interface BrowserRunStepsOptions {
  fromStep?: number;
  stopOnError?: boolean;
}

export async function runBrowserSteps(
  sessionId: string,
  steps: BrowserPlaybookStep[],
  opts: BrowserRunStepsOptions = {},
): Promise<BrowserRunStepsResult> {
  const fromStep = Math.max(0, opts.fromStep ?? 0);
  const stopOnError = opts.stopOnError !== false;
  const total = steps.length;
  const results: BrowserStepRunRecord[] = [];
  let completed = 0;
  let lastUrl: string | undefined;
  let lastTitle: string | undefined;

  if (fromStep >= total) {
    return {
      ok: false,
      completed: 0,
      total,
      from_step: fromStep,
      error: `from_step ${fromStep} >= total ${total}`,
      results,
    };
  }

  for (let i = fromStep; i < total; i++) {
    const step = steps[i]!;
    const actResult = await runBrowserAct(sessionId, step.action, stepToActArgs(step));
    const record: BrowserStepRunRecord = {
      step: i,
      action: step.action,
      ok: actResult.ok,
      ...(actResult.error ? { error: actResult.error } : {}),
    };
    results.push(record);
    if (actResult.ok) {
      completed += 1;
      lastUrl = actResult.url;
      lastTitle = actResult.title;
    } else if (stopOnError) {
      return {
        ok: false,
        completed,
        total,
        from_step: fromStep,
        failed_step: i,
        failed_action: step.action,
        error: actResult.error ?? 'step failed',
        results,
        url: lastUrl,
        title: lastTitle,
      };
    }
  }

  const allOk = results.every((r) => r.ok);
  return {
    ok: allOk,
    completed,
    total,
    from_step: fromStep,
    results,
    url: lastUrl,
    title: lastTitle,
  };
}

async function disposeSession(rec: BrowserSessionRecord): Promise<void> {
  sessions.delete(rec.id);
  try {
    await rec.context?.close?.();
  } catch {
    /* ignore */
  }
  try {
    await rec.browser?.close?.();
  } catch {
    /* ignore */
  }
}

export async function closeBrowserSession(sessionId: string): Promise<{ ok: boolean; output: string }> {
  const rec = sessions.get(sessionId.trim());
  if (!rec) {
    return { ok: false, output: `unknown session_id: ${sessionId}` };
  }
  if (rec.workDir !== getBrowserSessionWorkDir()) {
    return { ok: false, output: 'session belongs to another workDir' };
  }
  await disposeSession(rec);
  return { ok: true, output: `closed session ${sessionId}` };
}

export async function closeAllBrowserSessionsForWorkDir(workDir: string): Promise<number> {
  const toClose = [...sessions.values()].filter((s) => s.workDir === workDir);
  for (const rec of toClose) {
    await disposeSession(rec);
  }
  return toClose.length;
}

export async function closeBrowserSessionsForNode(nodeInstId: string): Promise<number> {
  const toClose = [...sessions.values()].filter((s) => s.nodeInstId === nodeInstId);
  for (const rec of toClose) {
    await disposeSession(rec);
  }
  return toClose.length;
}

/** 测试用：清空注册表（不关闭真实浏览器时仅用于 mock） */
export function __resetBrowserSessionsForTests(): void {
  sessions.clear();
}

export function __sessionCountForTests(): number {
  return sessions.size;
}
