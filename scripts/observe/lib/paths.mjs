/**
 * 观测结果落盘根目录（默认仓库外，切 branch 不丢）。
 *
 * 优先级：
 *   1. KURONEKO_OBSERVATIONS_DIR
 *   2. <repo>/../kuroneko-observations
 *   3. <repo>/.observations（需在 .gitignore）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function findRepoRoot(fromDir = __dirname) {
  let dir = fromDir;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'packages', 'server'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('无法定位 kuroneko 仓库根目录');
}

export function resolveObservationsRoot(explicit) {
  if (explicit) return path.resolve(explicit);
  const env = process.env['KURONEKO_OBSERVATIONS_DIR']?.trim();
  if (env) return path.resolve(env);
  const repo = findRepoRoot();
  return path.join(repo, '..', 'kuroneko-observations');
}

/** @returns {string} run 报告目录 */
export function resolveRunOutputDir(obsRoot, runKind, runId) {
  const safeKind = runKind.replace(/[^a-z0-9_-]/gi, '_') || 'other';
  const safeId = runId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return path.join(obsRoot, 'runs', safeKind, safeId);
}

export function slugifyLabel(label) {
  return (label || 'run')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 40) || 'run';
}

export function makeRunId(label) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${ts}Z-${slugifyLabel(label)}`;
}
