import fs from 'node:fs';
import path from 'node:path';
import type { FilesystemWorkspaceStore } from './workspace-kit/index.js';

export function revealWorkspaceAllowed(): boolean {
  const v = process.env['UTLRA_DISABLE_WORKSPACE_REVEAL']?.trim().toLowerCase();
  return v !== '1' && v !== 'true' && v !== 'yes';
}

export function readPiMonoLogSpan(wd: string): {
  file: string;
  firstTs: string | null;
  lastTs: string | null;
  lines: number;
} | null {
  const logsDir = path.join(wd, '.run', 'pi-mono', 'logs');
  if (!fs.existsSync(logsDir)) return null;
  const files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.jsonl')).sort();
  const lastFile = files[files.length - 1];
  if (!lastFile) return null;
  const p = path.join(logsDir, lastFile);
  const content = fs.readFileSync(p, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  if (lines.length === 0) return { file: lastFile, firstTs: null, lastTs: null, lines: 0 };
  try {
    const first = JSON.parse(lines[0]!) as { ts?: string };
    const last = JSON.parse(lines[lines.length - 1]!) as { ts?: string };
    return {
      file: lastFile,
      firstTs: first.ts ?? null,
      lastTs: last.ts ?? null,
      lines: lines.length,
    };
  } catch {
    return { file: lastFile, firstTs: null, lastTs: null, lines: lines.length };
  }
}

function listToolOutputSample(wd: string, max = 48): { path: string; size: number; modifiedAt: string }[] {
  const dir = path.join(wd, '.tool-outputs');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  const names = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.txt'))
    .sort()
    .reverse();
  const out: { path: string; size: number; modifiedAt: string }[] = [];
  for (const n of names.slice(0, max)) {
    const full = path.join(dir, n);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      out.push({
        path: path.join('.tool-outputs', n).replace(/\\/g, '/'),
        size: st.size,
        modifiedAt: st.mtime.toISOString(),
      });
    } catch {
      continue;
    }
  }
  return out;
}

export function buildWorkspaceArtifactsPayload(
  workspaceId: string,
  store: FilesystemWorkspaceStore,
): Record<string, unknown> {
  store.ensureWorkspace(workspaceId);
  const wd = store.resolveWorkDir(workspaceId);

  const rootMarkdown: { path: string; size: number; modifiedAt: string }[] = [];
  for (const name of fs.readdirSync(wd)) {
    if (!name.endsWith('.md') || name.startsWith('.')) continue;
    const full = path.join(wd, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    rootMarkdown.push({
      path: name,
      size: st.size,
      modifiedAt: st.mtime.toISOString(),
    });
  }
  rootMarkdown.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));

  const piMono = store.listRunTree(workspaceId, '.run/pi-mono');
  const toolOutputSample = listToolOutputSample(wd);
  let toolOutputsTxtCount = 0;
  const topDir = path.join(wd, '.tool-outputs');
  if (fs.existsSync(topDir) && fs.statSync(topDir).isDirectory()) {
    toolOutputsTxtCount = fs.readdirSync(topDir).filter((f) => f.endsWith('.txt')).length;
  }

  const delPath = path.join(wd, '.run', 'pi-mono', 'deliverables.json');
  let deliverablesPreview: unknown = null;
  if (fs.existsSync(delPath)) {
    try {
      deliverablesPreview = JSON.parse(fs.readFileSync(delPath, 'utf8'));
    } catch {
      deliverablesPreview = { _parseError: true as const };
    }
  }

  const logSpan = readPiMonoLogSpan(wd);
  let logSpanDurationMs: number | null = null;
  if (logSpan?.firstTs && logSpan?.lastTs) {
    const a = Date.parse(logSpan.firstTs);
    const b = Date.parse(logSpan.lastTs);
    if (!Number.isNaN(a) && !Number.isNaN(b) && b >= a) logSpanDurationMs = b - a;
  }

  return {
    workspaceId,
    workDir: wd,
    revealAllowed: revealWorkspaceAllowed(),
    workspaceRootMarkdown: rootMarkdown,
    piMonoTree: piMono,
    toolOutputsTxtCount,
    toolOutputSample,
    deliverablesJsonPath: '.run/pi-mono/deliverables.json',
    deliverablesJsonPresent: fs.existsSync(delPath),
    deliverablesPreview,
    piMonoLogSpan: logSpan,
    piMonoLogDurationMs: logSpanDurationMs,
  };
}
