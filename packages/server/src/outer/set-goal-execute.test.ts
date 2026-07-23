import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilesystemWorkspaceStore } from '../workspace-kit/index.js';
import { InnerBrainRegistry } from './inner-brain-registry.js';
import { ExecutableWorkflowStore } from './executable-workflow-store.js';
import { executeOuterTool } from './outer-tools.js';
import type { OuterToolContext } from './outer-tools.js';
import { promoteWorkflow } from './workflow-promote.js';

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

describe('set_goal execute', () => {
  let root: string;
  const prevBrowser = process.env['UTLRA_EW_BROWSER_LIVE'];
  const prevFrozen = process.env['UTLRA_EW_FROZEN_LIVE'];

  afterEach(() => {
    if (root && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    if (prevBrowser === undefined) delete process.env['UTLRA_EW_BROWSER_LIVE'];
    else process.env['UTLRA_EW_BROWSER_LIVE'] = prevBrowser;
    if (prevFrozen === undefined) delete process.env['UTLRA_EW_FROZEN_LIVE'];
    else process.env['UTLRA_EW_FROZEN_LIVE'] = prevFrozen;
  });

  it('缺 workflowRef 拒收', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-sg-'));
    const ctx = makeCtx(root);
    const r = await executeOuterTool(
      'set_goal',
      JSON.stringify({ goal: 'do thing', burst_mode: 'execute' }),
      ctx,
    );
    expect(r.output).toMatch(/workflowRef/);
  });

  it('execute 跑 shell_pipeline 成功', async () => {
    process.env['UTLRA_EW_BROWSER_LIVE'] = '0';
    process.env['UTLRA_EW_FROZEN_LIVE'] = '0';
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-sg-'));
    const ctx = makeCtx(root);
    promoteWorkflow(ctx.executableWorkflowStore!, {
      id: 'ew-sg',
      kind: 'shell_pipeline',
      title: 'SG',
      tags: [],
      steps: [
        {
          id: 'a',
          action: 'assert',
          args: { touch: 'ok.txt' },
          expect: { fileExists: 'ok.txt' },
        },
      ],
    });
    const r = await executeOuterTool(
      'set_goal',
      JSON.stringify({
        goal: 'run ew',
        burst_mode: 'execute',
        workflow_id: 'ew-sg',
        workflow_version: '1',
      }),
      ctx,
    );
    expect(r.output).toMatch(/执行完成/);
  });
});
