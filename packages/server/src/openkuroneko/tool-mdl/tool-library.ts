/**
 * toolLibrary — 工具库即文法（ADL: TOOL-MDL-GROWTH.md M5 / M6）
 *
 * 收录 = 往文法里加一条产生式；退役 = 删一条。两者共用 mdlAccount 的同一个 L。
 * 落盘形态刻意保持笨：一个工具 = 一个目录，版本交给 git，退役就是删目录。
 */
import fs from 'node:fs';
import path from 'node:path';

import { readFixtures, writeFixtures, type ReplayFixture } from './tool-replay-gate.js';
import { validateToolManifest, type ManifestValidateOptions, type ToolManifest } from './tool-manifest.js';

export interface LibraryTool {
  name: string;
  deps: string[];
  manifest: ToolManifest;
}

export interface MdlHistoryEntry {
  op: 'accept' | 'retire';
  name: string;
  deltaL?: number;
  at: string;
}

export function loadLibrary(workDir: string, opts: ManifestValidateOptions = {}): LibraryTool[] {
  const dir = path.join(workDir, 'tools');
  if (!fs.existsSync(dir)) return [];
  const out: LibraryTool[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const file = path.join(dir, ent.name, 'manifest.json');
    if (!fs.existsSync(file)) continue;
    let m: ToolManifest;
    try {
      m = JSON.parse(fs.readFileSync(file, 'utf8')) as ToolManifest;
    } catch {
      continue;
    }
    if (validateToolManifest(m, opts).length > 0) continue;
    out.push({ name: m.name, deps: m.deps ?? [], manifest: m });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function dependentsOf(library: LibraryTool[], name: string): string[] {
  return library.filter(t => t.deps.includes(name)).map(t => t.name);
}

function historyPath(workDir: string): string {
  return path.join(workDir, 'tools', '.mdl.json');
}

export function readMdlHistory(workDir: string): MdlHistoryEntry[] {
  const file = historyPath(workDir);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { history?: MdlHistoryEntry[] };
    return raw.history ?? [];
  } catch {
    return [];
  }
}

function appendHistory(workDir: string, entry: MdlHistoryEntry): void {
  const file = historyPath(workDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const history = [...readMdlHistory(workDir), entry];
  fs.writeFileSync(file, `${JSON.stringify({ history }, null, 2)}\n`, 'utf8');
}

export interface AcceptInput {
  manifest: ToolManifest;
  body: string;
  fixtures: ReplayFixture[];
  deltaL?: number;
  validate?: ManifestValidateOptions;
}

export function acceptTool(workDir: string, input: AcceptInput): void {
  const errs = validateToolManifest(input.manifest, input.validate ?? {});
  if (errs.length > 0) throw new Error(`invalid manifest: ${errs.join('; ')}`);
  if (input.fixtures.length === 0) {
    throw new Error('refusing to accept a tool with no replay fixtures (M5)');
  }

  const known = new Set(loadLibrary(workDir, input.validate ?? {}).map(t => t.name));
  for (const dep of input.manifest.deps ?? []) {
    if (!known.has(dep)) throw new Error(`unknown dependency: ${dep}`);
  }

  const dir = path.join(workDir, 'tools', input.manifest.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(input.manifest, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'run'), input.body, { encoding: 'utf8', mode: 0o755 });
  writeFixtures(workDir, input.manifest.name, input.fixtures);

  appendHistory(workDir, {
    op: 'accept',
    name: input.manifest.name,
    deltaL: input.deltaL,
    at: new Date().toISOString(),
  });
}

export function retireTool(workDir: string, name: string, deltaL?: number): void {
  const library = loadLibrary(workDir);
  if (!library.some(t => t.name === name)) throw new Error(`unknown tool: ${name}`);

  const blockers = dependentsOf(library, name);
  if (blockers.length > 0) {
    throw new Error(`cannot retire ${name}: still required by ${blockers.join(', ')} (M6)`);
  }

  fs.rmSync(path.join(workDir, 'tools', name), { recursive: true, force: true });
  appendHistory(workDir, { op: 'retire', name, deltaL, at: new Date().toISOString() });
}

export { readFixtures };
