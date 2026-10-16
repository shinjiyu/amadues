import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildToolIndex, renderToolIndex } from './tool-index.js';

function writeTool(
  root: string,
  name: string,
  patch: Record<string, unknown> = {},
): void {
  const dir = path.join(root, 'tools', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      name,
      description: `Do ${name}.`,
      args: { input: { type: 'string', required: true } },
      deps: [],
      kind: 'composition',
      createdAt: '2026-09-17T00:00:00.000Z',
      ...patch,
    }),
  );
  fs.writeFileSync(path.join(dir, 'run'), '#!/bin/sh\n');
}

describe('toolIndex', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-mdl-idx-'));
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns an empty index and zero grammar cost when tools/ is absent', () => {
    const idx = buildToolIndex(root);
    expect(idx.entries).toEqual([]);
    expect(idx.grammarCostTokens).toBe(0);
  });

  it('scans tools/ into a vocabulary sorted by name', () => {
    writeTool(root, 'zeta');
    writeTool(root, 'alpha');
    const idx = buildToolIndex(root);
    expect(idx.entries.map(e => e.name)).toEqual(['alpha', 'zeta']);
  });

  it('accumulates grammar cost across tools', () => {
    writeTool(root, 'alpha');
    const one = buildToolIndex(root).grammarCostTokens;
    writeTool(root, 'beta');
    const two = buildToolIndex(root).grammarCostTokens;
    expect(two).toBeGreaterThan(one);
  });

  it('skips directories whose manifest is invalid, and reports them', () => {
    writeTool(root, 'good');
    const bad = path.join(root, 'tools', 'bad');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'manifest.json'), '{ broken');

    const idx = buildToolIndex(root);
    expect(idx.entries.map(e => e.name)).toEqual(['good']);
    expect(idx.skipped).toContain('bad');
  });

  it('excludes acquisition tools unless explicitly allowed (M9)', () => {
    writeTool(root, 'fetcher', { kind: 'acquisition' });
    expect(buildToolIndex(root).entries).toEqual([]);
    const allowed = buildToolIndex(root, { allowAcquisition: true });
    expect(allowed.entries.map(e => e.name)).toEqual(['fetcher']);
  });

  it('ignores dotfiles such as .mdl.json', () => {
    writeTool(root, 'alpha');
    fs.writeFileSync(path.join(root, 'tools', '.mdl.json'), '{}');
    expect(buildToolIndex(root).entries.map(e => e.name)).toEqual(['alpha']);
  });

  describe('renderToolIndex — 进 prompt 的词汇表', () => {
    it('renders one line per tool with name, args and description', () => {
      writeTool(root, 'alpha');
      const text = renderToolIndex(buildToolIndex(root));
      expect(text).toMatch(/alpha/);
      expect(text).toMatch(/input/);
      expect(text).toMatch(/Do alpha\./);
    });

    it('never leaks the tool body or a filesystem path (M1)', () => {
      writeTool(root, 'alpha');
      const text = renderToolIndex(buildToolIndex(root));
      expect(text).not.toMatch(/#!\/bin\/sh/);
      expect(text).not.toMatch(/manifest\.json/);
      expect(text).not.toContain(root);
    });
  });
});
