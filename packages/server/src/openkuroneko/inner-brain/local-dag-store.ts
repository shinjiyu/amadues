/**
 * Local DAG Store — .brain/local_dag.json 读写。
 *
 * ADL：doc/structurizr/DYFLOW-INNER-EXECUTOR.md §5
 *
 * Designer 经 commit_local_dag 写入；controller/runner 读取执行。
 */

import fs from 'node:fs';
import path from 'node:path';

import type { LocalDag } from './types.js';

function dagPath(workDir: string): string {
  return path.join(workDir, '.brain', 'local_dag.json');
}

export function writeLocalDag(workDir: string, dag: LocalDag): void {
  const fp = dagPath(workDir);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(dag, null, 2), 'utf8');
}

export function readLocalDag(workDir: string): LocalDag | null {
  try {
    const raw = fs.readFileSync(dagPath(workDir), 'utf8');
    const parsed = JSON.parse(raw) as LocalDag;
    if (parsed && Array.isArray(parsed.nodes)) return parsed;
  } catch { /* ignore */ }
  return null;
}

export function clearLocalDag(workDir: string): void {
  try { fs.unlinkSync(dagPath(workDir)); } catch { /* ignore */ }
}
