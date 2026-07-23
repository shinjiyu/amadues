/**
 * Executable Workflow 默认 browser 真跑 — Playwright session-registry
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md P3
 */
import type { BrowserPlaybookStep } from '../browser/browser-playbook.js';
import {
  closeBrowserSession,
  openBrowserSession,
  runBrowserSteps,
} from '../browser/session-registry.js';
import { clearBrowserSessionScope, setBrowserSessionScope } from '../browser/session-scope.js';
import type { AdapterResult } from './workflow-adapters.js';

/**
 * 打开会话 → 跑 playbook → 关闭。供 `runExecutableWorkflow` 注入。
 */
export async function runBrowserPlaybookLive(
  steps: BrowserPlaybookStep[],
  workDir: string,
): Promise<AdapterResult> {
  setBrowserSessionScope(workDir, 'ew-execute');
  let sessionId: string | undefined;
  try {
    const opened = await openBrowserSession({ headless: true });
    if (!opened.ok || !opened.session_id) {
      return { ok: false, detail: opened.output || 'browser_open failed', exitCode: 1 };
    }
    sessionId = opened.session_id;
    const ran = await runBrowserSteps(sessionId, steps, { stopOnError: true });
    const stdout = `playbook_steps=${steps.length};completed=${ran.completed};ok=${ran.ok}`;
    if (!ran.ok) {
      return {
        ok: false,
        detail: ran.error ?? `browser step failed at ${ran.failed_step}`,
        exitCode: 1,
        stdout,
      };
    }
    return {
      ok: true,
      detail: `browser playbook ran ${ran.completed}/${ran.total}`,
      exitCode: 0,
      stdout,
    };
  } catch (e) {
    return { ok: false, detail: `browser live failed: ${String(e)}`, exitCode: 1 };
  } finally {
    if (sessionId) {
      try {
        await closeBrowserSession(sessionId);
      } catch {
        /* ignore */
      }
    }
    clearBrowserSessionScope();
  }
}
