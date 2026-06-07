import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  closeBrowserSessionsForNode,
} from '../../browser/session-registry.js';
import { clearBrowserSessionScope, setBrowserSessionScope } from '../../browser/session-scope.js';
import { setWorkDirGuard } from './workdir-guard.js';
import {
  browserActTool,
  browserCloseTool,
  browserOpenTool,
  browserRunStepsTool,
} from './browser-tools.js';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../browser/fixtures');
const FIXTURE_HTML = path.join(FIXTURE_DIR, 'minimal-page.html');
const FIXTURE_PLAYBOOK = path.join(FIXTURE_DIR, 'minimal-playbook.json');

describe('browser tools (integration)', () => {
  let workDir = '';
  let tempDir = '';

  afterEach(async () => {
    await closeBrowserSessionsForNode('test-node');
    clearBrowserSessionScope();
  });

  it('open → goto → click → snapshot on fixture page', async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-tools-'));
    tempDir = workDir;
    setWorkDirGuard(workDir, tempDir, []);
    setBrowserSessionScope(workDir, 'test-node');

    const opened = await browserOpenTool.call({ headless: true });
    expect(opened.ok).toBe(true);
    const openJson = JSON.parse(opened.output) as { session_id: string };
    const sessionId = openJson.session_id;
    expect(sessionId).toMatch(/^br-/);

    const fileUrl = pathToFileURL(FIXTURE_HTML).href;
    const goto = await browserActTool.call({
      session_id: sessionId,
      action: 'goto',
      url: fileUrl,
    });
    expect(goto.ok).toBe(true);
    const gotoJson = JSON.parse(goto.output) as { title: string };
    expect(gotoJson.title).toContain('Fixture');

    const click = await browserActTool.call({
      session_id: sessionId,
      action: 'click',
      text: '提交',
    });
    expect(click.ok).toBe(true);

    const snapPath = 'workspace/snap.txt';
    const snap = await browserActTool.call({
      session_id: sessionId,
      action: 'snapshot',
      path: snapPath,
    });
    expect(snap.ok, snap.output).toBe(true);
    const absSnap = path.join(workDir, snapPath);
    expect(fs.existsSync(absSnap)).toBe(true);
    expect(fs.readFileSync(absSnap, 'utf8')).toContain('提交');

    const closed = await browserCloseTool.call({ session_id: sessionId });
    expect(closed.ok).toBe(true);

    fs.rmSync(workDir, { recursive: true, force: true });
  }, 60_000);

  it('browser_run_steps inline and playbook file', async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-run-steps-'));
    tempDir = workDir;
    setWorkDirGuard(workDir, tempDir, []);
    setBrowserSessionScope(workDir, 'test-node');

    const opened = await browserOpenTool.call({ headless: true });
    expect(opened.ok).toBe(true);
    const sessionId = (JSON.parse(opened.output) as { session_id: string }).session_id;
    const fileUrl = pathToFileURL(FIXTURE_HTML).href;
    await browserActTool.call({ session_id: sessionId, action: 'goto', url: fileUrl });

    const inline = await browserRunStepsTool.call({
      session_id: sessionId,
      steps: JSON.stringify([
        { action: 'click', text: '提交' },
        { action: 'state' },
      ]),
    });
    expect(inline.ok).toBe(true);
    const inlineJson = JSON.parse(inline.output) as { completed: number; total: number };
    expect(inlineJson.completed).toBe(2);

    const playbookDest = path.join(workDir, 'workspace', 'flow.playbook.json');
    fs.mkdirSync(path.dirname(playbookDest), { recursive: true });
    fs.copyFileSync(FIXTURE_PLAYBOOK, playbookDest);

    const fromFile = await browserRunStepsTool.call({
      session_id: sessionId,
      playbook: 'workspace/flow.playbook.json',
    });
    expect(fromFile.ok).toBe(true);

    await browserCloseTool.call({ session_id: sessionId });
    fs.rmSync(workDir, { recursive: true, force: true });
  }, 60_000);

  it('browser_run_steps resumes with from_step', async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-from-step-'));
    tempDir = workDir;
    setWorkDirGuard(workDir, tempDir, []);
    setBrowserSessionScope(workDir, 'test-node');

    const opened = await browserOpenTool.call({ headless: true });
    const sessionId = (JSON.parse(opened.output) as { session_id: string }).session_id;
    const fileUrl = pathToFileURL(FIXTURE_HTML).href;

    const fail = await browserRunStepsTool.call({
      session_id: sessionId,
      steps: JSON.stringify([
        { action: 'goto', url: fileUrl },
        { action: 'click', text: '不存在的按钮' },
        { action: 'state' },
      ]),
    });
    expect(fail.ok).toBe(false);
    const failJson = JSON.parse(fail.output) as { failed_step: number };
    expect(failJson.failed_step).toBe(1);

    const resume = await browserRunStepsTool.call({
      session_id: sessionId,
      from_step: 1,
      steps: JSON.stringify([
        { action: 'goto', url: fileUrl },
        { action: 'click', text: '提交' },
        { action: 'state' },
      ]),
    });
    expect(resume.ok).toBe(true);

    await browserCloseTool.call({ session_id: sessionId });
    fs.rmSync(workDir, { recursive: true, force: true });
  }, 60_000);
});
