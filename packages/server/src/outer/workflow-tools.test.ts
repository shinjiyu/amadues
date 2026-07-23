import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilesystemWorkspaceStore } from '../workspace-kit/index.js';
import { InnerBrainRegistry } from './inner-brain-registry.js';
import { ExecutableWorkflowStore } from './executable-workflow-store.js';
import { dispatchWorkflowTool } from './workflow-tools.js';
import type { OuterToolContext } from './outer-tools.js';

function makeCtx(root: string): OuterToolContext {
  const registry = new InnerBrainRegistry(root);
  return {
    threadId: 't1',
    agentSid: 'agent:test',
    workspaceId: 'ws-outer',
    imClient: {} as OuterToolContext['imClient'],
    assetStore: {} as OuterToolContext['assetStore'],
    getEngine: () => ({ setGoal: () => undefined } as never),
    workspaceStore: new FilesystemWorkspaceStore(path.join(root, 'workspaces')),
    repoStore: {} as OuterToolContext['repoStore'],
    dataRoot: root,
    innerBrainRegistry: registry,
    executableWorkflowStore: new ExecutableWorkflowStore({ dataRoot: root }),
  };
}

describe('workflow-tools', () => {
  let root: string;
  const prevLive = process.env['UTLRA_EW_BROWSER_LIVE'];
  const prevFrozen = process.env['UTLRA_EW_FROZEN_LIVE'];

  afterEach(() => {
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    if (prevLive === undefined) delete process.env['UTLRA_EW_BROWSER_LIVE'];
    else process.env['UTLRA_EW_BROWSER_LIVE'] = prevLive;
    if (prevFrozen === undefined) delete process.env['UTLRA_EW_FROZEN_LIVE'];
    else process.env['UTLRA_EW_FROZEN_LIVE'] = prevFrozen;
  });

  it('promote from playbook_path + list/get/run', async () => {
    process.env['UTLRA_EW_BROWSER_LIVE'] = '0';
    process.env['UTLRA_EW_FROZEN_LIVE'] = '0';
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-tools-'));
    const ctx = makeCtx(root);
    const ws = path.join(root, 'workspaces', 'ws-outer');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'pb.json'),
      JSON.stringify({ steps: [{ action: 'goto', url: 'https://example.com' }, { action: 'snapshot' }] }),
      'utf8',
    );

    const promo = await dispatchWorkflowTool(
      'workflow_promote',
      {
        workflow_id: 'ew-pb',
        kind: 'browser_playbook',
        title: 'Example',
        playbook_path: 'pb.json',
      },
      ctx,
    );
    expect(promo?.output).toMatch(/已晋升 ew-pb@1/);

    const list = await dispatchWorkflowTool('workflow_list', {}, ctx);
    expect(list?.output).toContain('ew-pb');

    const got = await dispatchWorkflowTool(
      'workflow_get',
      { workflow_id: 'ew-pb' },
      ctx,
    );
    expect(got?.output).toContain('browser_steps');

    const run = await dispatchWorkflowTool(
      'workflow_run',
      { workflow_id: 'ew-pb', goal: 'run pb' },
      ctx,
    );
    expect(run?.output).toMatch(/完成/);
  });

  it('promote from dag_path', async () => {
    process.env['UTLRA_EW_FROZEN_LIVE'] = '0';
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-tools-'));
    const ctx = makeCtx(root);
    const ws = path.join(root, 'workspaces', 'ws-outer');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(
      path.join(ws, 'dag.json'),
      JSON.stringify({ nodes: [{ id: 'n1', ref: 'preset/base', instruction: 'x' }] }),
      'utf8',
    );
    const promo = await dispatchWorkflowTool(
      'workflow_promote',
      {
        workflow_id: 'ew-dag',
        kind: 'frozen_dag',
        title: 'Dag',
        dag_path: 'dag.json',
      },
      ctx,
    );
    expect(promo?.output).toMatch(/ew-dag@1/);
    const run = await dispatchWorkflowTool('workflow_run', { workflow_id: 'ew-dag' }, ctx);
    expect(run?.output).toMatch(/完成/);
  });

  it('pause blocks run', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-tools-'));
    const ctx = makeCtx(root);
    await dispatchWorkflowTool(
      'workflow_promote',
      {
        workflow_id: 'ew-p',
        kind: 'shell_pipeline',
        title: 'P',
        steps_json: JSON.stringify([
          { id: 'a', action: 'assert', args: { touch: 'x.txt' }, expect: { fileExists: 'x.txt' } },
        ]),
      },
      ctx,
    );
    await dispatchWorkflowTool('workflow_pause', { workflow_id: 'ew-p', paused: true }, ctx);
    const run = await dispatchWorkflowTool('workflow_run', { workflow_id: 'ew-p' }, ctx);
    expect(run?.output).toMatch(/已暂停/);
  });

  it('workflow_suggest_promote 只建议不写入', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-tools-'));
    const ctx = makeCtx(root);
    const ws = path.join(root, 'workspaces', 'ws-outer');
    fs.mkdirSync(path.join(ws, '.brain'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, '.brain', 'local_dag.json'),
      JSON.stringify({ nodes: [{ id: 'n1', ref: 'preset/base' }] }),
      'utf8',
    );
    const sug = await dispatchWorkflowTool('workflow_suggest_promote', {}, ctx);
    expect(sug?.output).toContain('frozen_dag');
    expect(sug?.output).toContain('不会自动写入');
    expect(ctx.executableWorkflowStore!.list()).toHaveLength(0);
  });
});
