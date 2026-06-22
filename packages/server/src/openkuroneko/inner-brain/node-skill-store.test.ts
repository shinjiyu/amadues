import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';

import { createLocalNodeStore } from './local-node-store.js';
import { createNodeSkillStore, encodeNodeIdForSkills } from './node-skill-store.js';
import type { LocalNode } from './types.js';

function minimalNode(id: string): LocalNode {
  return {
    id,
    version: '1.0.0',
    displayName: id,
    description: 'test',
    tags: [],
    interface: { inputs: [], outputs: [{ key: 'result', type: 'string' }] },
    body: { kind: 'executor', promptTemplate: 'do', tools: ['*'] },
    metadata: { origin: 'preset', createdAt: '', updatedAt: '' },
  };
}

describe('node-skill-store', () => {
  let root = '';
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('encodeNodeIdForSkills replaces slashes', () => {
    expect(encodeNodeIdForSkills('local/ps_open')).toBe('local__ps_open');
  });

  it('writeSkill + readContent + exportSkills', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nsk-'));
    const store = createNodeSkillStore(root);
    const r = store.writeSkill('preset/base', {
      category: 'browser',
      title: 'Playwright login',
      tags: ['login'],
      content: '1. open page\n2. click login',
    });
    expect(r.action).toBe('created');
    expect(store.readIndex('preset/base')).toHaveLength(1);
    expect(store.readContent('preset/base', r.id)).toContain('Playwright login');
    const exported = store.exportSkills('preset/base');
    expect(exported[0]?.content).toContain('click login');
  });

  it('copySkills copies between node refs', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nsk-'));
    const store = createNodeSkillStore(root);
    store.writeSkill('preset/base', {
      category: 'shell',
      title: 'Run script',
      content: 'shell_exec ./run.sh',
    });
    const copied = store.copySkills('preset/base', 'local/foo');
    expect(copied).toHaveLength(1);
    expect(store.readContent('local/foo', copied[0]!.id)).toContain('run.sh');
  });

  it('attachToLocalNode updates LocalNode.skills', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nsk-'));
    const localStore = createLocalNodeStore(root);
    localStore.commit(minimalNode('preset/base'));
    const skillStore = createNodeSkillStore(root);
    const r = skillStore.writeSkill('preset/base', {
      category: 'api',
      title: 'Fetch API',
      content: 'curl endpoint',
    });
    skillStore.attachToLocalNode(localStore, 'preset/base', r.ref);
    const node = localStore.read('preset/base');
    expect(node?.skills?.some(s => s.id === r.id)).toBe(true);
  });
});
