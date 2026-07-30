import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutableWorkflowStore } from './executable-workflow-store.js';
import {
  auditWorkflowSteps,
  pauseInvalidWorkflows,
  promoteWorkflow,
  validatePromoteDraft,
  WorkflowPromoteError,
} from './workflow-promote.js';
import type { PromoteWorkflowInput } from './workflow-promote.js';
import type { ExecutableWorkflow } from './executable-workflow-types.js';

describe('workflow-promote', () => {
  let root: string;

  afterEach(() => {
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
  });

  const base = (): PromoteWorkflowInput => ({
    id: 'ew-pub',
    kind: 'shell_pipeline',
    title: 'Publish',
    steps: [
      {
        id: 'a',
        action: 'shell',
        args: { command: 'echo ok > out.txt' },
        expect: { fileExists: 'out.txt' },
      },
      { id: 'b', action: 'assert', expect: { stdoutContains: 'ok' } },
    ],
  });

  it('拒收无机械 expect 的步骤 (W3)', () => {
    expect(() =>
      validatePromoteDraft({
        ...base(),
        steps: [
          {
            id: 'x',
            action: 'shell',
            args: { command: 'echo' },
            expect: { note: 'only note' },
          },
        ],
      }),
    ).toThrow(WorkflowPromoteError);
  });

  it('拒收内脑工具名 action (W5)', () => {
    expect(() =>
      validatePromoteDraft({
        ...base(),
        steps: [
          {
            id: 'x',
            action: 'shell_exec' as never,
            expect: { exitCode: 0 },
          },
        ],
      }),
    ).toThrow(/unknown action "shell_exec"/);
  });

  it('拒收 shell 缺 command (W6)', () => {
    expect(() =>
      validatePromoteDraft({
        ...base(),
        steps: [{ id: 'x', action: 'shell', expect: { exitCode: 0 } }],
      }),
    ).toThrow(/args\.command/);
  });

  it('拒收 browser_steps 空壳 (W6)', () => {
    expect(() =>
      validatePromoteDraft({
        id: 'ew-b',
        kind: 'browser_playbook',
        title: 'B',
        steps: [
          {
            id: 'b',
            action: 'browser_steps',
            expect: { fileExists: '.run/playbook-prepared.json' },
          },
        ],
      }),
    ).toThrow(/steps\|playbook\|playbookPath/);
  });

  it('拒收写死 workspace 绝对路径 (W8)', () => {
    expect(() =>
      validatePromoteDraft({
        ...base(),
        steps: [
          {
            id: 'x',
            action: 'shell',
            args: {
              command: 'cd /data/workspaces/task-ib-mryg5okg-8559 && cat workspace/fan.json',
            },
            expect: { exitCode: 0 },
          },
        ],
      }),
    ).toThrow(/W8/);
  });

  it('拒收跨步未赋值的 shell 变量 (W9)', () => {
    expect(() =>
      validatePromoteDraft({
        ...base(),
        steps: [
          {
            id: 'profile',
            action: 'shell',
            args: {
              command: 'curl -H "Cookie: SUB=${SUB}" https://weibo.com/ajax/profile/info',
            },
            expect: { exitCode: 0 },
          },
        ],
      }),
    ).toThrow(/\$SUB.*W9/);
  });

  it('同一步内赋值后再用变量可通过 (W9)', () => {
    expect(() =>
      validatePromoteDraft({
        ...base(),
        steps: [
          {
            id: 'ok',
            action: 'shell',
            args: {
              command: 'SUB=abc\necho "$SUB" > .run/ew/sub.txt',
            },
            expect: { fileExists: '.run/ew/sub.txt' },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('shadow 拒收 .. 逃出 workDir (W10)', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-shadow-'));
    expect(() =>
      validatePromoteDraft(
        {
          ...base(),
          steps: [
            {
              id: 'x',
              action: 'assert',
              expect: { fileExists: '../outside.txt' },
            },
          ],
        },
        { workDir: root },
      ),
    ).toThrow(/W10/);
  });

  it('拒收 Cookie/Token 明文 (W11)', () => {
    expect(() =>
      validatePromoteDraft({
        ...base(),
        steps: [
          {
            id: 'x',
            action: 'shell',
            args: {
              command:
                "node -e \"const cookie='auth_token=ef2cb80f07adfb6e08ce6d1aa45fa366ab508899; ct0=a579724d501b52e667948ff11a5fee64fd553b1f7eb3ccb9ac6b0d780f11ff92';\"",
            },
            expect: { exitCode: 0 },
          },
        ],
      }),
    ).toThrow(/W11/);
  });

  it('secretRefs 合法可通过 (W11)', () => {
    expect(() =>
      validatePromoteDraft({
        ...base(),
        steps: [
          {
            id: 'x',
            action: 'shell',
            args: { command: 'echo "$AUTH_TOKEN" | wc -c' },
            secretRefs: { AUTH_TOKEN: 'x_twitter_auth' },
            expect: { exitCode: 0 },
          },
        ],
      }),
    ).not.toThrow();
  });

  it('hoist args.secretRefs 到顶层 (W11)', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-hoist-'));
    const store = new ExecutableWorkflowStore({ dataRoot: root });
    const wf = promoteWorkflow(store, {
      ...base(),
      steps: [
        {
          id: 'x',
          action: 'shell',
          args: {
            command: 'echo "$COOKIES" > .run/ew/out.txt',
            secretRefs: { COOKIES: 'twitter_x_cookies.json' },
          },
          expect: { fileExists: '.run/ew/out.txt' },
        },
      ],
    });
    expect(wf.steps[0]!.secretRefs).toEqual({ COOKIES: 'twitter_x_cookies.json' });
    expect(wf.steps[0]!.args?.['secretRefs']).toBeUndefined();
  });

  it('打包 shell 引用的 .run/ew 脚本 (W13)', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-assets-'));
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, '.run/ew'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.run/ew/fetch.py'), 'print("ok")\n', 'utf8');
    const store = new ExecutableWorkflowStore({ dataRoot: root });
    const wf = promoteWorkflow(
      store,
      {
        id: 'ew-pack',
        kind: 'shell_pipeline',
        title: 'Pack',
        steps: [
          {
            id: 'run',
            action: 'shell',
            args: { command: 'python3 .run/ew/fetch.py' },
            expect: { exitCode: 0 },
          },
        ],
      },
      { workDir: ws },
    );
    expect(wf.assets?.some((a) => a.path === '.run/ew/fetch.py' && a.content.includes('print'))).toBe(
      true,
    );
  });

  it('引用脚本但无 assets/workDir 拒收 (W13)', () => {
    expect(() =>
      validatePromoteDraft({
        id: 'ew-miss',
        kind: 'shell_pipeline',
        title: 'Miss',
        steps: [
          {
            id: 'run',
            action: 'shell',
            args: { command: 'python3 .run/ew/missing.py' },
            expect: { exitCode: 0 },
          },
        ],
      }),
    ).toThrow(/W13/);
  });

  it('promote bumps version', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-promote-'));
    const store = new ExecutableWorkflowStore({ dataRoot: root });
    const v1 = promoteWorkflow(store, base());
    expect(v1.version).toBe('1');
    const v2 = promoteWorkflow(store, { ...base(), title: 'Publish2' });
    expect(v2.version).toBe('2');
    expect(store.getLatest('ew-pub')?.title).toBe('Publish2');
  });

  it('promote 可同步 drive9', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-promote-'));
    const store = new ExecutableWorkflowStore({ dataRoot: root });
    const shared: unknown[] = [];
    const drive9 = {
      storeShared: (wf: unknown) => {
        shared.push(wf);
      },
    } as import('../drive9/workflow-drive9-store.js').WorkflowDrive9Store;
    promoteWorkflow(store, base(), { drive9 });
    expect(shared).toHaveLength(1);
  });

  it('auditWorkflowSteps + pauseInvalidWorkflows', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-audit-'));
    const store = new ExecutableWorkflowStore({ dataRoot: root });
    // 直接 put 绕过 promote（模拟历史空壳）
    const bad: ExecutableWorkflow = {
      id: 'ew-bad',
      version: '1',
      kind: 'shell_pipeline',
      title: 'bad',
      tags: [],
      entry: 's1',
      steps: [{ id: 's1', action: 'write_file' as never, expect: { fileExists: 'x' } }],
      failurePolicy: { onStepFail: 'abort_escalate', maxRetries: 0 },
      source: { promotedAt: '2026-07-24T00:00:00.000Z' },
    };
    store.put(bad);
    expect(auditWorkflowSteps(bad).length).toBeGreaterThan(0);
    expect(pauseInvalidWorkflows(store)).toEqual(['ew-bad']);
    expect(store.getMeta('ew-bad')?.paused).toBe(true);
  });
});
