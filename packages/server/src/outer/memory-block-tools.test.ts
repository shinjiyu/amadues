/**
 * @see doc/structurizr/MEMORY-BLOCKS.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMemoryBlockStore } from './memory-block-store.js';
import {
  execMemoryBlockCreate,
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

  it('memory_block_create + put notebook entry', async () => {
    const ctx = minimalCtx(root);
    const created = await execMemoryBlockCreate(
      { block_id: 'lab-notes', strategy: 'notebook', title: '实验室' },
      ctx,
    );
    expect(created.output).toContain('lab-notes');
    const put = await execMemoryBlockPut(
      { block_id: 'lab-notes', key: 'n1', body: '记住：先 ADL 再代码' },
      ctx,
    );
    expect(put.output).toContain('notebook');
    const entries = await execMemoryBlockEntries({ block_id: 'lab-notes' }, ctx);
    expect(entries.output).toContain('n1');
  });

  it('memory_block_put keychain without value in list output', async () => {
    const ctx = minimalCtx(root);
    const put = await execMemoryBlockPut(
      { block_id: 'keychain', key: 'weibo', kind: 'cookie', value: 's=1' },
      ctx,
    );
    expect(put.output).toContain('weibo');
    expect(put.output).not.toContain('s=1');
  });

  it('returns disabled message when store missing', async () => {
    const out = await execMemoryBlockList(minimalCtx(root, { memoryBlockStore: undefined }));
    expect(out.output).toContain('未启用');
  });

  it('executeOuterTool dispatches memory_block_create', async () => {
    const { executeOuterTool } = await import('./outer-tools.js');
    const ctx = minimalCtx(root);
    const out = await executeOuterTool(
      'memory_block_create',
      JSON.stringify({ block_id: 'x-notes', strategy: 'notebook', title: 'X' }),
      ctx,
    );
    expect(out.output).toContain('x-notes');
  });
});
