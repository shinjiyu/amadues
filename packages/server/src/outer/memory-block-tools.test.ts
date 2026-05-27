/**
 * @see doc/structurizr/MEMORY-BLOCKS.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InnerBrainRegistry } from './inner-brain-registry.js';
import { createMemoryBlockStore } from './memory-block-store.js';
import {
  execMemoryBlockBind,
  execMemoryBlockEntries,
  execMemoryBlockList,
  execMemoryBlockPut,
} from './memory-block-tools.js';
import type { OuterToolContext } from './outer-tools.js';

function minimalCtx(
  root: string,
  overrides: Partial<OuterToolContext> = {},
): OuterToolContext {
  return {
    threadId: 'thread:t1',
    agentSid: 'agent:kuro',
    workspaceId: 'default',
    imClient: {} as OuterToolContext['imClient'],
    assetStore: {} as OuterToolContext['assetStore'],
    getEngine: () => {
      throw new Error('not used');
    },
    workspaceStore: {} as OuterToolContext['workspaceStore'],
    repoStore: {} as OuterToolContext['repoStore'],
    dataRoot: root,
    memoryBlockStore: createMemoryBlockStore(root, null, 'agent:kuro'),
    ...overrides,
  };
}

describe('memory-block-tools', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-tools-'));
  });

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('memory_block_list includes keychain', async () => {
    const out = await execMemoryBlockList(minimalCtx(root));
    expect(out.output).toContain('keychain');
  });

  it('memory_block_put → entries without value in list/get', async () => {
    const ctx = minimalCtx(root);
    const put = await execMemoryBlockPut(
      { block_id: 'keychain', key: 'weibo', kind: 'cookie', value: 's=1' },
      ctx,
    );
    expect(put.output).toContain('weibo');
    expect(put.output).not.toContain('s=1');

    const entries = await execMemoryBlockEntries({ block_id: 'keychain' }, ctx);
    expect(entries.output).toContain('weibo');
  });

  it('memory_block_bind resolves instance_id via registry', async () => {
    const reg = new InnerBrainRegistry(root);
    const workDir = path.join(root, 'ws-bind');
    fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });
    reg.register({
      instanceId: 'ib-mb-01',
      workspaceId: 'task-ib-mb-01',
      workDir,
      goal: 'test',
      originUser: 'human:u1',
      originThread: 'thread:t1',
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
    });

    const ctx = minimalCtx(root, { innerBrainRegistry: reg });
    await execMemoryBlockPut(
      { block_id: 'keychain', key: 'cred', kind: 'token', value: 'tok-bind' },
      ctx,
    );

    const bind = await execMemoryBlockBind(
      { block_id: 'keychain', keys: 'cred', instance_id: 'ib-mb-01' },
      ctx,
    );
    expect(bind.output).toContain('.brain/secrets/cred.json');
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(workDir, '.brain', 'secrets', 'cred.json'), 'utf8'),
    ) as { value: string };
    expect(onDisk.value).toBe('tok-bind');
  });

  it('returns disabled message when store missing', async () => {
    const out = await execMemoryBlockList(minimalCtx(root, { memoryBlockStore: undefined }));
    expect(out.output).toContain('未启用');
  });

  it('executeOuterTool dispatches memory_block_put', async () => {
    const { executeOuterTool } = await import('./outer-tools.js');
    const ctx = minimalCtx(root);
    const out = await executeOuterTool(
      'memory_block_put',
      JSON.stringify({ block_id: 'keychain', key: 'x', kind: 'token', value: 'sec' }),
      ctx,
    );
    expect(out.output).toContain('keychain/x');
    expect(out.output).not.toContain('sec');
  });
});
