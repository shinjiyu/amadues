import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';

import { loadNodeSkills } from './node-skill-loader.js';
import { createNodeSkillStore } from './node-skill-store.js';
import type { LocalNode, NodeInst } from './types.js';

describe('loadNodeSkills', () => {
  let root = '';
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('loads bound skills into prompt section', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nsl-'));
    const skillStore = createNodeSkillStore(root);
    skillStore.writeSkill('local/test', {
      category: 'browser',
      title: 'Open page',
      content: 'browser_open url',
    });

    const node: LocalNode = {
      id: 'local/test',
      version: '1.0.0',
      displayName: 'test',
      description: 'browser task',
      tags: ['browser'],
      interface: { inputs: [], outputs: [] },
      body: { kind: 'executor', promptTemplate: 'x', tools: ['*'] },
      metadata: { origin: 'creator', createdAt: '', updatedAt: '' },
    };
    const inst: NodeInst = { id: 'n1', ref: 'local/test' };

    const loaded = await loadNodeSkills({ node, inst, workDir: root });
    expect(loaded.refs).toHaveLength(1);
    expect(loaded.section).toContain('节点技能');
    expect(loaded.section).toContain('browser_open');
  });

  it('merges global provider results', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nsl-'));
    const node: LocalNode = {
      id: 'preset/base',
      version: '1.0.0',
      displayName: 'base',
      description: 'read files',
      tags: [],
      interface: { inputs: [], outputs: [] },
      body: { kind: 'executor', promptTemplate: 'x', tools: ['*'] },
      metadata: { origin: 'preset', createdAt: '', updatedAt: '' },
    };
    const inst: NodeInst = { id: 'n1', ref: 'preset/base' };

    const loaded = await loadNodeSkills({
      node,
      inst,
      workDir: root,
      skillProvider: {
        search: () => [{ id: 'g1', category: 'file', title: 'Read file', tags: [], ts: '' }],
        getContent: () => 'read_file path/to/file',
      },
    });
    expect(loaded.refs.some(r => r.id === 'g1')).toBe(true);
    expect(loaded.section).toContain('read_file');
  });
});
