/**
 * Executable Workflow local registry — DATA_ROOT/workflows/{id}/
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  ExecutableWorkflow,
  WorkflowMeta,
  WorkflowRef,
} from './executable-workflow-types.js';

const WORKFLOWS_REL = 'workflows';
const META_FILE = 'meta.json';

function pathSafeId(id: string): string {
  const s = id.trim();
  if (!s || s.includes('..') || s.includes('/') || s.includes('\\') || s.includes('\0')) {
    throw new Error(`executable-workflow: invalid id ${JSON.stringify(id)}`);
  }
  if (!/^[\w.-]+$/.test(s)) {
    throw new Error(`executable-workflow: id must be [\w.-]+, got ${s}`);
  }
  return s;
}

function versionFileName(version: string): string {
  const v = version.trim();
  if (!/^\d+$/.test(v) && !/^\d+\.\d+\.\d+$/.test(v)) {
    throw new Error(`executable-workflow: invalid version ${version}`);
  }
  return `v${v.replace(/\./g, '_')}.json`;
}

export interface ExecutableWorkflowStoreOptions {
  dataRoot: string;
}

export class ExecutableWorkflowStore {
  private readonly dataRoot: string;

  constructor(opts: ExecutableWorkflowStoreOptions) {
    this.dataRoot = opts.dataRoot;
    fs.mkdirSync(this.rootDir(), { recursive: true });
  }

  rootDir(): string {
    return path.join(this.dataRoot, WORKFLOWS_REL);
  }

  workflowDir(id: string): string {
    return path.join(this.rootDir(), pathSafeId(id));
  }

  list(): WorkflowMeta[] {
    if (!fs.existsSync(this.rootDir())) return [];
    const out: WorkflowMeta[] = [];
    for (const name of fs.readdirSync(this.rootDir())) {
      const metaPath = path.join(this.rootDir(), name, META_FILE);
      if (!fs.existsSync(metaPath)) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(metaPath, 'utf8')) as WorkflowMeta);
      } catch {
        /* skip corrupt */
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  getMeta(id: string): WorkflowMeta | null {
    const p = path.join(this.workflowDir(id), META_FILE);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8')) as WorkflowMeta;
  }

  get(ref: WorkflowRef): ExecutableWorkflow | null {
    const dir = this.workflowDir(ref.id);
    const file = path.join(dir, versionFileName(ref.version));
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ExecutableWorkflow;
  }

  getLatest(id: string): ExecutableWorkflow | null {
    const meta = this.getMeta(id);
    if (!meta) return null;
    return this.get({ id, version: meta.latestVersion });
  }

  /**
   * 写入某一 version。若 id 已存在且 version 已存在 → 抛错（不可变）。
   * 若 version 更新 → 刷新 meta.latestVersion。
   */
  put(wf: ExecutableWorkflow): void {
    const id = pathSafeId(wf.id);
    const dir = this.workflowDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, versionFileName(wf.version));
    if (fs.existsSync(file)) {
      throw new Error(`executable-workflow: version immutable ${id}@${wf.version}`);
    }
    const body: ExecutableWorkflow = { ...wf, id };
    fs.writeFileSync(file, JSON.stringify(body, null, 2), 'utf8');

    const now = new Date().toISOString();
    const prev = this.getMeta(id);
    const meta: WorkflowMeta = {
      schema: 'executable-workflow.meta.v1',
      id,
      kind: body.kind,
      title: body.title,
      latestVersion: body.version,
      tags: body.tags ?? [],
      updatedAt: now,
      paused: prev?.paused,
    };
    // latest = max numeric or last written if semver-ish — P0: last put wins as latest
    if (prev && compareVersions(prev.latestVersion, body.version) > 0) {
      meta.latestVersion = prev.latestVersion;
    }
    fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify(meta, null, 2), 'utf8');
  }

  setPaused(id: string, paused: boolean): void {
    const meta = this.getMeta(id);
    if (!meta) throw new Error(`executable-workflow: unknown ${id}`);
    meta.paused = paused;
    meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(this.workflowDir(id), META_FILE),
      JSON.stringify(meta, null, 2),
      'utf8',
    );
  }
}

/** 简单版本比较：纯数字按数值；否则字典序。返回 a-b 语义。 */
export function compareVersions(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return Number(a) - Number(b);
  return a.localeCompare(b);
}

/** 下一整数版本 */
export function nextIntegerVersion(latest: string | null | undefined): string {
  if (!latest || !/^\d+$/.test(latest)) return '1';
  return String(Number(latest) + 1);
}
