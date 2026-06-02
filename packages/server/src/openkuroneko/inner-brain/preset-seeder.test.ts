import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { seedPresetNodes } from './preset-seeder.js';
import { createLocalNodeStore } from './local-node-store.js';
import type { LocalNode } from './types.js';

describe('presetSeeder', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'preset-seeder-'));
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('first spawn seeds preset/base and preset/node_creator', () => {
    const r = seedPresetNodes(root);
    expect(r.seeded).toContain('preset/base');
    expect(r.seeded).toContain('preset/node_creator');
    const store = createLocalNodeStore(root);
    expect(store.has('preset/base')).toBe(true);
    expect(store.read('preset/node_creator')?.body.kind).toBe('executor');
  });

  it('second spawn skips already-seeded same-version presets', () => {
    seedPresetNodes(root);
    const r2 = seedPresetNodes(root);
    expect(r2.seeded).toHaveLength(0);
    expect(r2.skipped).toContain('preset/base');
  });

  it('upgrades preset when version changes', () => {
    const store = createLocalNodeStore(root);
    const old: LocalNode = {
      id: 'preset/base',
      version: '0.9.0',
      displayName: 'old',
      description: 'old',
      tags: ['preset'],
      interface: { inputs: [], outputs: [{ key: 'result', type: 'string' }] },
      body: { kind: 'executor', promptTemplate: 'old', tools: ['*'] },
      metadata: { origin: 'preset', createdAt: '', updatedAt: '' },
    };
    store.commit(old);
    const r = seedPresetNodes(root, { store });
    expect(r.upgraded).toContain('preset/base');
    expect(store.read('preset/base')?.version).toBe('1.2.0');
  });

  it('preset nodes are flagged export=false', () => {
    seedPresetNodes(root);
    const store = createLocalNodeStore(root);
    expect(store.read('preset/base')?.metadata.export).toBe(false);
  });
});
