/**
 * 将办公室 manifest 中的 outcomes（K/S/P + deliverables）晋升到 RepositoryStore 执行轨。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FilesystemRepositoryStore, CommitSessionItem, RepositoryLane } from '../workspace-kit/index.js';
import type { FilesystemWorkspaceStore } from '../workspace-kit/index.js';
import type { OutcomeRef } from '../workspace-kit/index.js';

const MAX_BODY_CHARS = 120_000;

function readOutcomeFile(workDir: string, rel: string): { ok: true; body: string } | { ok: false; reason: string } {
  const full = path.resolve(workDir, rel);
  const root = path.resolve(workDir);
  if (!full.startsWith(root)) return { ok: false, reason: 'path_escape' };
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return { ok: false, reason: 'missing' };
  let body = fs.readFileSync(full, 'utf8');
  if (body.length > MAX_BODY_CHARS) {
    body = body.slice(0, MAX_BODY_CHARS) + '\n\n…(truncated for repository promotion)';
  }
  return { ok: true, body };
}

function kindFor(
  bucket: 'knowledge' | 'skill' | 'policy' | 'deliverable',
): 'knowledge' | 'skill' | 'policy' {
  if (bucket === 'skill') return 'skill';
  if (bucket === 'policy') return 'policy';
  return 'knowledge';
}

export function promoteWorkspaceManifestToRepository(
  repo: FilesystemRepositoryStore,
  store: FilesystemWorkspaceStore,
  tenantId: string,
  workspaceId: string,
  opts: {
    realm: string;
    sessionId: string;
    lane?: RepositoryLane;
  },
): { added: number; skipped: string[] } {
  store.ensureWorkspace(workspaceId);
  const m = store.readManifest(workspaceId);
  const wd = store.resolveWorkDir(workspaceId);
  const skipped: string[] = [];
  const items: CommitSessionItem[] = [];
  const seenPath = new Set<string>();

  const pushRef = (bucket: 'knowledge' | 'skill' | 'policy' | 'deliverable', ref: OutcomeRef) => {
    if (seenPath.has(ref.path)) return;
    const r = readOutcomeFile(wd, ref.path);
    if (!r.ok) {
      skipped.push(`${ref.path}(${r.reason})`);
      return;
    }
    seenPath.add(ref.path);
    items.push({
      kind: kindFor(bucket),
      title: `[${bucket}] ${ref.id} ← ${ref.path}`,
      body: r.body,
      tags: [workspaceId, bucket, ref.path],
    });
  };

  for (const ref of m.outcomes.knowledge) pushRef('knowledge', ref);
  for (const ref of m.outcomes.skills) pushRef('skill', ref);
  for (const ref of m.outcomes.policy) pushRef('policy', ref);
  for (const ref of m.outcomes.deliverables) pushRef('deliverable', ref);

  if (items.length === 0) return { added: 0, skipped };

  repo.commitSession(tenantId, {
    session_id: opts.sessionId,
    realm: opts.realm,
    lane: opts.lane ?? 'execution',
    items,
  });

  return { added: items.length, skipped };
}
