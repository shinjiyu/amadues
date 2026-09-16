/**
 * HarnessSpec store — .brain/harness/specs/<id>.json
 *
 * ADL: doc/structurizr/HARNESS-RSI.md §5–§7 (H2)
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { HarnessRefs, HarnessSpec, HarnessStatus } from './harness-types.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface HarnessSpecInput {
  id?: string;
  parentId?: string;
  refs: HarnessRefs;
  status?: HarnessStatus;
}

export interface HarnessSpecStore {
  put(input: HarnessSpecInput): HarnessSpec;
  get(id: string): HarnessSpec | null;
  list(): HarnessSpec[];
  patchStatus(id: string, status: HarnessStatus): HarnessSpec;
  readonly specsDir: string;
}

function assertValidId(id: string): void {
  if (!id || !ID_PATTERN.test(id) || id.includes('..')) {
    throw new Error(`[harness-spec-store] invalid harness id: ${JSON.stringify(id)}`);
  }
}

function specsDir(workDir: string): string {
  return path.join(workDir, '.brain', 'harness', 'specs');
}

function specPath(workDir: string, id: string): string {
  return path.join(specsDir(workDir), `${id}.json`);
}

export function hashHarnessRefs(refs: HarnessRefs): string {
  const canonical = JSON.stringify({
    loopTreeId: refs.loopTreeId ?? null,
    loopRoots: [...(refs.loopRoots ?? [])].sort(),
    loopEntry: refs.loopEntry ?? null,
    gateChecks: [...(refs.gateChecks ?? [])]
      .map((c) => ({ id: c.id, command: c.command, cwd: c.cwd ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    localNodeIds: [...(refs.localNodeIds ?? [])].sort(),
    skillRefs: [...(refs.skillRefs ?? [])]
      .map((s) => ({ nodeRef: s.nodeRef, skillId: s.skillId }))
      .sort((a, b) => `${a.nodeRef}/${a.skillId}`.localeCompare(`${b.nodeRef}/${b.skillId}`)),
    workflowRef: refs.workflowRef
      ? { id: refs.workflowRef.id, version: refs.workflowRef.version }
      : null,
    assetPaths: [...(refs.assetPaths ?? [])].sort(),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function createHarnessSpecStore(workDir: string): HarnessSpecStore {
  const dir = specsDir(workDir);

  function ensureDir(): void {
    fs.mkdirSync(dir, { recursive: true });
  }

  function readFile(id: string): HarnessSpec | null {
    assertValidId(id);
    const p = specPath(workDir, id);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as HarnessSpec;
  }

  function writeFile(spec: HarnessSpec): void {
    ensureDir();
    fs.writeFileSync(specPath(workDir, spec.id), `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  }

  return {
    specsDir: dir,

    put(input) {
      const contentHash = hashHarnessRefs(input.refs);
      const id = input.id?.trim() || `hs-${contentHash}`;
      assertValidId(id);
      const existing = readFile(id);
      if (existing) {
        // Idempotent re-put of identical content (H2); avoids revise crash when H′ ≡ active
        if (existing.contentHash === contentHash) return existing;
        throw new Error(`[harness-spec-store] immutable: ${id} already exists (H2)`);
      }
      const spec: HarnessSpec = {
        id,
        createdAt: new Date().toISOString(),
        refs: input.refs,
        contentHash,
        status: input.status ?? 'draft',
        ...(input.parentId ? { parentId: input.parentId } : {}),
      };
      writeFile(spec);
      return spec;
    },

    get(id) {
      return readFile(id);
    },

    list() {
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .filter((n) => n.endsWith('.json'))
        .map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) as HarnessSpec)
        .sort((a, b) => a.id.localeCompare(b.id));
    },

    patchStatus(id, status) {
      const cur = readFile(id);
      if (!cur) throw new Error(`[harness-spec-store] missing spec ${id}`);
      const next: HarnessSpec = { ...cur, status };
      writeFile(next);
      return next;
    },
  };
}
