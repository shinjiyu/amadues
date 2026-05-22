import fs from 'node:fs';
import path from 'node:path';
import type { RunManifest } from './manifest.js';
import { RunManifestSchema, emptyManifest } from './manifest.js';

const RUN_DIR = '.run';

export class FilesystemWorkspaceStore {
  constructor(private readonly workspacesRoot: string) {}

  /** workspaceId 例如 `default` → workspacesRoot/default */
  resolveWorkDir(workspaceId: string): string {
    return path.join(this.workspacesRoot, workspaceId);
  }

  ensureWorkspace(workspaceId: string): string {
    const wd = this.resolveWorkDir(workspaceId);
    fs.mkdirSync(path.join(wd, RUN_DIR, 'telemetry'), { recursive: true });
    const manifestPath = path.join(wd, RUN_DIR, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      const m = emptyManifest(workspaceId, wd);
      fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2), 'utf8');
    }
    return wd;
  }

  readManifest(workspaceId: string): RunManifest {
    const wd = this.resolveWorkDir(workspaceId);
    const p = path.join(wd, RUN_DIR, 'manifest.json');
    if (!fs.existsSync(p)) {
      this.ensureWorkspace(workspaceId);
      return this.readManifest(workspaceId);
    }
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    return RunManifestSchema.parse(raw);
  }

  writeManifest(workspaceId: string, manifest: RunManifest): void {
    const wd = this.resolveWorkDir(workspaceId);
    fs.mkdirSync(path.join(wd, RUN_DIR), { recursive: true });
    const next = { ...manifest, updatedAt: new Date().toISOString() };
    fs.writeFileSync(
      path.join(wd, RUN_DIR, 'manifest.json'),
      JSON.stringify(next, null, 2),
      'utf8',
    );
  }

  /** 相对 workDir 的路径，必须在 workDir 内 */
  readTextFile(workspaceId: string, relativePath: string): string | null {
    const wd = this.resolveWorkDir(workspaceId);
    const full = path.resolve(wd, relativePath);
    if (!full.startsWith(path.resolve(wd))) return null;
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
    return fs.readFileSync(full, 'utf8');
  }

  listRunTree(
    workspaceId: string,
    subPath = '.run',
    maxDepth = 6,
  ): { path: string; type: 'file' | 'dir'; size?: number }[] {
    const wd = this.resolveWorkDir(workspaceId);
    const root = path.resolve(wd, subPath);
    if (!root.startsWith(path.resolve(wd)) || !fs.existsSync(root)) return [];

    const out: { path: string; type: 'file' | 'dir'; size?: number }[] = [];

    function walk(dir: string, depth: number): void {
      if (depth > maxDepth) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        const rel = path.relative(wd, full).replace(/\\/g, '/');
        if (e.isDirectory()) {
          out.push({ path: rel, type: 'dir' });
          walk(full, depth + 1);
        } else if (e.isFile()) {
          const st = fs.statSync(full);
          out.push({ path: rel, type: 'file', size: st.size });
        }
      }
    }

    walk(root, 0);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }
}
