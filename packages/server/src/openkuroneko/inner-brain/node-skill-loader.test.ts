import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';

import { loadNodeSkills } from './node-skill-loader.js';
import { createNodeSkillStore } from './node-skill-store.js';
import { createHarnessSpecStore } from './harness-spec-store.js';
import { createHarnessPointer } from './harness-pointer.js';
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

  it('prefers active harness skillRefs before other bound skills', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nsl-h-'));
    const skillStore = createNodeSkillStore(root);
    const a = skillStore.writeSkill('local/test', {
      category: 'a',
      title: 'Skill A',
      content: 'content-a',
    });
    const b = skillStore.writeSkill('local/test', {
      category: 'b',
      title: 'Skill B',
      content: 'content-b',
    });
    const harnessStore = createHarnessSpecStore(root);
    harnessStore.put({
      id: 'hs-1',
      refs: { skillRefs: [{ nodeRef: 'local/test', skillId: b.ref.id }] },
      status: 'gated_ok',
    });
    createHarnessPointer(root, harnessStore).upgrade('hs-1');

    const node: LocalNode = {
      id: 'local/test',
      version: '1.0.0',
      displayName: 'test',
      description: 'x',
      tags: [],
      interface: { inputs: [], outputs: [] },
      body: { kind: 'executor', promptTemplate: 'x', tools: ['*'] },
      metadata: { origin: 'creator', createdAt: '', updatedAt: '' },
      skills: [
        { id: a.ref.id, category: 'a', title: 'Skill A' },
        { id: b.ref.id, category: 'b', title: 'Skill B' },
      ],
    };
    const loaded = await loadNodeSkills({
      node,
      inst: { id: 'n1', ref: 'local/test' },
      workDir: root,
    });
    expect(loaded.refs[0]?.id).toBe(b.ref.id);
    expect(loaded.section).toContain('source: harness');
  });
});
