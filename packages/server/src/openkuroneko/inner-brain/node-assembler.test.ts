import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { createFakeLLM } from '../../testing/fake-llm.js';
import type { Logger } from '../logger/index.js';
import { createNodeDefDrive9Store, computeDedupeKey, type Drive9Fs } from '../../drive9/node-def-drive9-store.js';
import { createLocalNodeStore } from './local-node-store.js';
import { assembleNodeDef, applyBinding, importedId } from './node-assembler.js';
import type { NodeDef } from './types.js';

function silentLogger(): Logger {
  const noop = () => {};
  return { info: noop, warn: noop, error: noop, debug: noop } as unknown as Logger;
}

function createMemFs(): Drive9Fs {
  const files = new Map<string, string>();
  return {
    async read(p) { const v = files.get(p); if (v === undefined) throw new Error('404'); return v; },
    async write(p, c) { files.set(p, c); },
    async delete(p) { files.delete(p); },
    async exists(p) { return files.has(p); },
    async list() { return []; },
    async grep() { return []; },
    async copy(s, d) { const v = files.get(s); if (v !== undefined) files.set(d, v); },
  };
}

function makeDef(): NodeDef {
  const body = { kind: 'executor' as const, promptTemplate: 'cd ${{ WORK_DIR }} login ${{ PS_ACCOUNT }}', tools: ['shell_exec'] };
  const iface = { inputs: [], outputs: [{ key: 'room', type: 'string' }] };
  return {
    id: 'ps_open_battle',
    version: '1.0.0',
    description: 'open ps battle',
    tags: ['battle'],
    placeholders: [
      { name: 'WORK_DIR', kind: 'path', required: true },
      { name: 'PS_ACCOUNT', kind: 'account', required: true },
    ],
    interface: iface,
    body,
    metadata: {
      sourceAgent: 'agent-x', sourceLocalId: 'local/ps_open',
      dedupeKey: computeDedupeKey(body, iface),
      citeCount: 0, importCount: 0, assembleFailCount: 0,
      createdAt: new Date().toISOString(), status: 'active',
    },
  };
}

describe('applyBinding', () => {
  it('replaces placeholders keeping JSON valid', () => {
    const out = applyBinding({ a: 'go ${{ X }}', b: ['${{ Y }}'] }, { X: '/p', Y: 'acc' });
    expect(out).toEqual({ a: 'go /p', b: ['acc'] });
  });
});

describe('assembleNodeDef', () => {
  let root = '';
  let fs2: Drive9Fs;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'assembler-')); fs2 = createMemFs(); });
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it('binds and writes an imported LocalNode + bumpImport', async () => {
    const defStore = createNodeDefDrive9Store(fs2);
    const def = makeDef();
    await defStore.put(def);
    const localStore = createLocalNodeStore(root);
    const llm = createFakeLLM([{ match: () => true, reply: { content: JSON.stringify({ binding: { WORK_DIR: '/home/gin/w', PS_ACCOUNT: 'gin_bot' }, rationale: 'from env' }) } }]);

    const res = await assembleNodeDef(def, root, { llm, logger: silentLogger(), defStore, localStore });
    expect(res.ok).toBe(true);
    expect(res.localId).toBe('imported/ps_open_battle@1.0.0');
    const local = localStore.read(res.localId!)!;
    expect(local.metadata.origin).toBe('imported');
    expect((local.body as { promptTemplate: string }).promptTemplate).toBe('cd /home/gin/w login gin_bot');
    expect((await defStore.list())[0]?.importCount).toBe(1);
  });

  it('is idempotent on repeat assembly', async () => {
    const defStore = createNodeDefDrive9Store(fs2);
    const def = makeDef();
    await defStore.put(def);
    const localStore = createLocalNodeStore(root);
    const llm = createFakeLLM([{ match: () => true, reply: { content: JSON.stringify({ binding: { WORK_DIR: '/w', PS_ACCOUNT: 'a' } }) } }]);
    await assembleNodeDef(def, root, { llm, logger: silentLogger(), defStore, localStore });
    const res2 = await assembleNodeDef(def, root, { llm, logger: silentLogger(), defStore, localStore });
    expect(res2.skipped).toBe(true);
    expect((await defStore.list())[0]?.importCount).toBe(1); // not double-counted
  });

  it('fails and bumps assembleFail when required binding missing', async () => {
    const defStore = createNodeDefDrive9Store(fs2);
    const def = makeDef();
    await defStore.put(def);
    const localStore = createLocalNodeStore(root);
    const llm = createFakeLLM([{ match: () => true, reply: { content: JSON.stringify({ binding: { WORK_DIR: '/w' } }) } }]);
    const res = await assembleNodeDef(def, root, { llm, logger: silentLogger(), defStore, localStore });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('PS_ACCOUNT');
    expect((await defStore.list())[0]?.assembleFailCount).toBe(1);
    expect(localStore.has(importedId(def))).toBe(false);
  });

  it('uses bindingHints as fallback', async () => {
    const defStore = createNodeDefDrive9Store(fs2);
    const def = makeDef();
    await defStore.put(def);
    const localStore = createLocalNodeStore(root);
    const llm = createFakeLLM([{ match: () => true, reply: { content: JSON.stringify({ binding: { WORK_DIR: '/w' } }) } }]);
    const res = await assembleNodeDef(def, root, { llm, logger: silentLogger(), defStore, localStore }, { bindingHints: { PS_ACCOUNT: 'hinted' } });
    expect(res.ok).toBe(true);
  });
});
