/**
 * Loop source tree — immutable COW snapshots for Harness-RSI P5.
 *
 * ADL: doc/structurizr/HARNESS-RSI.md §5 / §12 / H2 / H10 / H11
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { HarnessPatch, LoopTreeManifest } from './harness-types.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface SeedLoopTreeInput {
  /** Absolute or workDir-relative source files to copy into the tree */
  files: Array<{ from: string; to: string }>;
  parentTreeId?: string;
  treeId?: string;
}

export interface HarnessLoopTreeStore {
  readonly treesDir: string;
  seed(input: SeedLoopTreeInput): LoopTreeManifest;
  get(treeId: string): LoopTreeManifest | null;
  treeRoot(treeId: string): string;
  readFile(treeId: string, relPath: string): string | null;
  applyPatches(
    parentTreeId: string,
    patches: HarnessPatch[],
    loopRoots: string[],
  ): LoopTreeManifest;
  resolveEntry(treeId: string, loopEntry: string): string;
}

function assertTreeId(id: string): void {
  if (!id || !ID_PATTERN.test(id) || id.includes('..')) {
    throw new Error(`[harness-loop-tree] invalid tree id: ${JSON.stringify(id)}`);
  }
}

function treesDir(workDir: string): string {
  return path.join(workDir, '.brain', 'harness', 'trees');
}

function hashContent(buf: string | Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function hashManifestFiles(files: Record<string, string>): string {
  const canonical = JSON.stringify(
    Object.keys(files)
      .sort()
      .map((k) => [k, files[k]]),
  );
  return hashContent(canonical);
}

/** Normalize + reject path escape (H11). Returns posix-style relative path. */
export function assertPathInLoopRoots(relPath: string, loopRoots: string[]): string {
  const raw = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw || raw.includes('\0')) {
    throw new Error(`[harness-loop-tree] H11: empty/invalid path`);
  }
  const parts = raw.split('/');
  if (parts.some((p) => p === '..' || p === '')) {
    throw new Error(`[harness-loop-tree] H11: path escape rejected: ${JSON.stringify(relPath)}`);
  }
  const normalized = parts.join('/');
  const roots = loopRoots.length
    ? loopRoots.map((r) => r.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    : [''];
  const ok = roots.some((root) => {
    if (!root) return true;
    return normalized === root || normalized.startsWith(`${root}/`);
  });
  if (!ok) {
    throw new Error(
      `[harness-loop-tree] H11: path ${JSON.stringify(normalized)} outside loopRoots ${JSON.stringify(loopRoots)}`,
    );
  }
  return normalized;
}

function copyFileIntoTree(absFrom: string, absTo: string): void {
  fs.mkdirSync(path.dirname(absTo), { recursive: true });
  fs.copyFileSync(absFrom, absTo);
}

function writeManifest(root: string, manifest: LoopTreeManifest): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

export function createHarnessLoopTreeStore(workDir: string): HarnessLoopTreeStore {
  const dir = treesDir(workDir);

  function treeRoot(treeId: string): string {
    assertTreeId(treeId);
    return path.join(dir, treeId);
  }

  function readManifest(treeId: string): LoopTreeManifest | null {
    const p = path.join(treeRoot(treeId), 'manifest.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as LoopTreeManifest;
  }

  function materializeFiles(
    treeId: string,
    files: Record<string, string>,
    writer: (rel: string, absDest: string) => void,
  ): LoopTreeManifest {
    const root = treeRoot(treeId);
    if (fs.existsSync(root)) {
      throw new Error(`[harness-loop-tree] immutable: tree ${treeId} already exists (H2)`);
    }
    fs.mkdirSync(root, { recursive: true });
    for (const rel of Object.keys(files).sort()) {
      const absDest = path.join(root, ...rel.split('/'));
      writer(rel, absDest);
    }
    const manifest: LoopTreeManifest = {
      treeId,
      files,
      createdAt: new Date().toISOString(),
    };
    writeManifest(root, manifest);
    return manifest;
  }

  return {
    treesDir: dir,

    seed(input) {
      const files: Record<string, string> = {};
      const payloads: Record<string, Buffer> = {};
      for (const { from, to } of input.files) {
        const rel = assertPathInLoopRoots(to, ['']);
        const absFrom = path.isAbsolute(from) ? from : path.join(workDir, from);
        if (!fs.existsSync(absFrom)) {
          throw new Error(`[harness-loop-tree] seed missing source: ${absFrom}`);
        }
        const buf = fs.readFileSync(absFrom);
        files[rel] = hashContent(buf);
        payloads[rel] = buf;
      }
      if (Object.keys(files).length === 0) {
        throw new Error('[harness-loop-tree] seed requires at least one file');
      }
      const treeId = input.treeId?.trim() || `lt-${hashManifestFiles(files)}`;
      assertTreeId(treeId);
      const existing = readManifest(treeId);
      if (existing) {
        if (existing.files && hashManifestFiles(existing.files) === hashManifestFiles(files)) {
          return existing;
        }
        throw new Error(`[harness-loop-tree] immutable: tree ${treeId} already exists (H2)`);
      }
      const manifest = materializeFiles(treeId, files, (rel, absDest) => {
        fs.mkdirSync(path.dirname(absDest), { recursive: true });
        fs.writeFileSync(absDest, payloads[rel]!);
      });
      if (input.parentTreeId) {
        const withParent: LoopTreeManifest = { ...manifest, parentTreeId: input.parentTreeId };
        writeManifest(treeRoot(treeId), withParent);
        return withParent;
      }
      return manifest;
    },

    get(treeId) {
      return readManifest(treeId);
    },

    treeRoot,

    readFile(treeId, relPath) {
      const rel = assertPathInLoopRoots(relPath, ['']);
      const p = path.join(treeRoot(treeId), ...rel.split('/'));
      if (!fs.existsSync(p)) return null;
      return fs.readFileSync(p, 'utf8');
    },

    applyPatches(parentTreeId, patches, loopRoots) {
      const parent = readManifest(parentTreeId);
      if (!parent) throw new Error(`[harness-loop-tree] missing parent tree ${parentTreeId}`);
      if (!patches.length) {
        throw new Error('[harness-loop-tree] H12: empty patches');
      }

      const parentRoot = treeRoot(parentTreeId);
      const nextFiles: Record<string, string> = { ...parent.files };
      const overrides = new Map<string, { action: 'write' | 'delete'; content?: string }>();

      for (const patch of patches) {
        const rel = assertPathInLoopRoots(patch.path, loopRoots);
        if (patch.action === 'write') {
          if (typeof patch.content !== 'string') {
            throw new Error(`[harness-loop-tree] write patch missing content: ${rel}`);
          }
          nextFiles[rel] = hashContent(patch.content);
          overrides.set(rel, { action: 'write', content: patch.content });
        } else if (patch.action === 'delete') {
          delete nextFiles[rel];
          overrides.set(rel, { action: 'delete' });
        } else {
          throw new Error(`[harness-loop-tree] unknown patch action`);
        }
      }

      if (hashManifestFiles(nextFiles) === hashManifestFiles(parent.files)) {
        throw new Error('[harness-loop-tree] H12: patches produced no tree diff');
      }

      const treeId = `lt-${hashManifestFiles(nextFiles)}`;
      const existing = readManifest(treeId);
      if (existing) return { ...existing, parentTreeId: parentTreeId };

      const manifest = materializeFiles(treeId, nextFiles, (rel, absDest) => {
        const ov = overrides.get(rel);
        if (ov?.action === 'delete') return;
        if (ov?.action === 'write') {
          fs.mkdirSync(path.dirname(absDest), { recursive: true });
          fs.writeFileSync(absDest, ov.content!, 'utf8');
          return;
        }
        const from = path.join(parentRoot, ...rel.split('/'));
        copyFileIntoTree(from, absDest);
      });
      const withParent: LoopTreeManifest = { ...manifest, parentTreeId };
      writeManifest(treeRoot(treeId), withParent);
      return withParent;
    },

    resolveEntry(treeId, loopEntry) {
      const rel = assertPathInLoopRoots(loopEntry, ['']);
      const abs = path.join(treeRoot(treeId), ...rel.split('/'));
      if (!fs.existsSync(abs)) {
        throw new Error(`[harness-loop-tree] H10: missing loopEntry ${rel} in tree ${treeId}`);
      }
      return abs;
    },
  };
}

/** Resolve active harness loopEntry absolute path, or null if H has no loopTree. */
export function resolveActiveLoopEntry(
  workDir: string,
  refs: { loopTreeId?: string; loopEntry?: string } | null | undefined,
): string | null {
  if (!refs?.loopTreeId || !refs.loopEntry) return null;
  return createHarnessLoopTreeStore(workDir).resolveEntry(refs.loopTreeId, refs.loopEntry);
}
