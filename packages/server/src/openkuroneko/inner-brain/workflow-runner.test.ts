import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutableWorkflow } from '../../outer/executable-workflow-types.js';
import {
  assertDesignerMayRedesign,
  checkExpect,
  runExecutableWorkflow,
  writeBurstModeMarker,
} from './workflow-runner.js';

describe('workflow-runner', () => {
  let workDir: string;

  afterEach(() => {
    if (workDir && fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
  });

  const wf = (partial?: Partial<ExecutableWorkflow>): ExecutableWorkflow => ({
    id: 'ew-run',
    version: '1',
    kind: 'shell_pipeline',
    title: 'Run',
    tags: [],
    entry: 't1',
    steps: [
      {
        id: 't1',
        action: 'assert',
        args: { touch: 'done.txt' },
        expect: { fileExists: 'done.txt' },
      },
    ],
    failurePolicy: { onStepFail: 'abort_escalate', maxRetries: 0 },
    source: { promotedAt: '2026-07-23T00:00:00.000Z' },
    ...partial,
  });

  it('assert + touch 逐步成功并写 trace', async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-run-'));
    const r = await runExecutableWorkflow(wf(), { workDir });
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(workDir, 'done.txt'))).toBe(true);
    expect(fs.existsSync(path.join(workDir, '.run', 'workflow_run.json'))).toBe(true);
  });

  it('shell expect + stub', async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-run-'));
    const r = await runExecutableWorkflow(
      wf({
        steps: [
          {
            id: 'sh',
            action: 'shell',
            args: { command: 'echo hi' },
            expect: { exitCode: 0, stdoutContains: 'hi' },
          },
        ],
      }),
      {
        workDir,
        runShell: () => ({ exitCode: 0, stdout: 'hi\n', stderr: '' }),
      },
    );
    expect(r.ok).toBe(true);
  });

  it('失败 abort_escalate', async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-run-'));
    const r = await runExecutableWorkflow(
      wf({
        steps: [{ id: 'miss', action: 'assert', expect: { fileExists: 'nope.txt' } }],
      }),
      { workDir },
    );
    expect(r.ok).toBe(false);
    expect(r.abortedAt).toBe('miss');
  });

  it('retry_same', async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-run-'));
    let n = 0;
    const r = await runExecutableWorkflow(
      wf({
        failurePolicy: { onStepFail: 'retry_same', maxRetries: 2 },
        steps: [
          {
            id: 'sh',
            action: 'shell',
            args: { command: 'x' },
            expect: { exitCode: 0 },
          },
        ],
      }),
      {
        workDir,
        runShell: () => {
          n += 1;
          return n < 3
            ? { exitCode: 1, stdout: '', stderr: 'fail' }
            : { exitCode: 0, stdout: '', stderr: '' };
        },
      },
    );
    expect(r.ok).toBe(true);
    expect(r.steps[0]?.attempts).toBe(3);
  });

  it('checkExpect 防穿越', () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-run-'));
    const c = checkExpect({ fileExists: '../secret' }, { workDir });
    expect(c.ok).toBe(false);
  });

  it('execute 禁 redesign', () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-run-'));
    writeBurstModeMarker(workDir, {
      burstMode: 'execute',
      workflowRef: { id: 'ew-run', version: '1' },
    });
    expect(() => assertDesignerMayRedesign(workDir)).toThrow(/禁止 redesign/);
    writeBurstModeMarker(workDir, { burstMode: 'explore' });
    expect(() => assertDesignerMayRedesign(workDir)).not.toThrow();
  });

  it('browser_steps 注入真跑 stub', async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-run-'));
    let called = 0;
    const r = await runExecutableWorkflow(
      wf({
        kind: 'browser_playbook',
        steps: [
          {
            id: 'b',
            action: 'browser_steps',
            args: { steps: [{ action: 'goto', url: 'https://example.com' }] },
            expect: { exitCode: 0, stdoutContains: 'live=1' },
          },
        ],
      }),
      {
        workDir,
        runBrowserSteps: async () => {
          called += 1;
          return { ok: true, detail: 'stub live', exitCode: 0, stdout: 'live=1' };
        },
      },
    );
    expect(r.ok).toBe(true);
    expect(called).toBe(1);
  });

  it('frozen_dag 注入 runLocalDag', async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-run-'));
    let called = 0;
    const r = await runExecutableWorkflow(
      wf({
        kind: 'frozen_dag',
        steps: [
          {
            id: 'd',
            action: 'run_node',
            args: { dag: { nodes: [{ id: 'n1', ref: 'preset/base' }] } },
            expect: { exitCode: 0, stdoutContains: 'ran=1' },
          },
        ],
      }),
      {
        workDir,
        runLocalDag: async () => {
          called += 1;
          return { ok: true, detail: 'stub dag', exitCode: 0, stdout: 'ran=1' };
        },
      },
    );
    expect(r.ok).toBe(true);
    expect(called).toBe(1);
  });

  it('W11 secretRefs 注入 shell env', async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-sec-'));
    let seenEnv: Record<string, string> | undefined;
    const r = await runExecutableWorkflow(
      wf({
        steps: [
          {
            id: 's',
            action: 'shell',
            args: { command: 'echo ok' },
            secretRefs: { AUTH_TOKEN: 'x_auth' },
            expect: { exitCode: 0, stdoutContains: 'ok' },
          },
        ],
      }),
      {
        workDir,
        resolveSecret: async (key) => (key === 'x_auth' ? 'tok-secret' : null),
        runShell: (_cmd, _cwd, env) => {
          seenEnv = env;
          return { exitCode: 0, stdout: 'ok', stderr: '' };
        },
      },
    );
    expect(r.ok).toBe(true);
    expect(seenEnv?.['AUTH_TOKEN']).toBe('tok-secret');
  });

  it('W13 assets 物化后再跑 shell', async () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-asset-run-'));
    const r = await runExecutableWorkflow(
      wf({
        assets: [{ path: '.run/ew/hello.py', content: 'print("hi-asset")\n' }],
        steps: [
          {
            id: 's',
            action: 'shell',
            args: { command: 'python .run/ew/hello.py' },
            expect: { exitCode: 0, stdoutContains: 'hi-asset' },
          },
        ],
      }),
      { workDir },
    );
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(workDir, '.run/ew/hello.py'))).toBe(true);
  });
});
