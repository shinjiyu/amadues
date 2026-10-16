import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acceptTool,
  dependentsOf,
  loadLibrary,
  readMdlHistory,
  retireTool,
} from './tool-library.js';
import type { ToolManifest } from './tool-manifest.js';

function manifest(name: string, deps: string[] = []): ToolManifest {
  return {
    name,
    description: `Do ${name}.`,
    args: { input: { type: 'string', required: true } },
    deps,
    kind: 'composition',
    createdAt: '2026-09-17T00:00:00.000Z',
  };
}

const fixtures = [{ args: { input: 'x' }, expected: 'y' }];

describe('toolLibrary', () => {
  let root = '';
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-mdl-lib-'));
  });
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  describe('acceptTool — 收录 = 加一条产生式', () => {
    it('writes manifest, body and fixtures into tools/<name>/', () => {
      acceptTool(root, { manifest: manifest('grep_jq'), body: '#!/bin/sh\necho y\n', fixtures });
      const dir = path.join(root, 'tools', 'grep_jq');
      expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'run'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'tests.jsonl'))).toBe(true);
    });

    it('rejects an invalid manifest', () => {
      expect(() =>
        acceptTool(root, {
          manifest: { ...manifest('Bad Name'), name: 'Bad Name' },
          body: 'x',
          fixtures,
        }),
      ).toThrow(/name/);
    });

    it('rejects a tool with no fixtures (M5)', () => {
      expect(() =>
        acceptTool(root, { manifest: manifest('nofix'), body: 'x', fixtures: [] }),
      ).toThrow(/fixture/i);
    });

    it('rejects a dependency that is not in the library', () => {
      expect(() =>
        acceptTool(root, { manifest: manifest('b', ['missing']), body: 'x', fixtures }),
      ).toThrow(/missing/);
    });

    it('accepts a dependency that already exists (层级)', () => {
      acceptTool(root, { manifest: manifest('a'), body: 'x', fixtures });
      acceptTool(root, { manifest: manifest('b', ['a']), body: 'x', fixtures });
      expect(loadLibrary(root).map(e => e.name).sort()).toEqual(['a', 'b']);
    });

    it('appends an accept entry to .mdl.json history', () => {
      acceptTool(root, { manifest: manifest('a'), body: 'x', fixtures, deltaL: -120 });
      const h = readMdlHistory(root);
      expect(h).toHaveLength(1);
      expect(h[0]).toMatchObject({ op: 'accept', name: 'a', deltaL: -120 });
    });
  });

  describe('retireTool — 退役须尊重 deps DAG (M6)', () => {
    beforeEach(() => {
      acceptTool(root, { manifest: manifest('a'), body: 'x', fixtures });
      acceptTool(root, { manifest: manifest('b', ['a']), body: 'x', fixtures });
    });

    it('refuses to retire a tool that others depend on', () => {
      expect(() => retireTool(root, 'a')).toThrow(/b/);
      expect(loadLibrary(root).map(e => e.name).sort()).toEqual(['a', 'b']);
    });

    it('retires a leaf and removes its directory', () => {
      retireTool(root, 'b');
      expect(loadLibrary(root).map(e => e.name)).toEqual(['a']);
      expect(fs.existsSync(path.join(root, 'tools', 'b'))).toBe(false);
    });

    it('allows retiring the dependency once the dependent is gone', () => {
      retireTool(root, 'b');
      expect(() => retireTool(root, 'a')).not.toThrow();
      expect(loadLibrary(root)).toEqual([]);
    });

    it('appends a retire entry to history', () => {
      retireTool(root, 'b', -30);
      expect(readMdlHistory(root).at(-1)).toMatchObject({ op: 'retire', name: 'b', deltaL: -30 });
    });

    it('throws for an unknown tool', () => {
      expect(() => retireTool(root, 'ghost')).toThrow(/ghost/);
    });
  });

  describe('dependentsOf', () => {
    it('lists direct dependents', () => {
      acceptTool(root, { manifest: manifest('a'), body: 'x', fixtures });
      acceptTool(root, { manifest: manifest('b', ['a']), body: 'x', fixtures });
      acceptTool(root, { manifest: manifest('c', ['a']), body: 'x', fixtures });
      expect(dependentsOf(loadLibrary(root), 'a').sort()).toEqual(['b', 'c']);
      expect(dependentsOf(loadLibrary(root), 'b')).toEqual([]);
    });
  });
});
