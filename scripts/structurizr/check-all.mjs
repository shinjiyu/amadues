#!/usr/bin/env node
/**
 * ADL 三连：validate + inspect + dependency-cruiser（与 doc/structurizr/TOOLCHAIN.md 对齐）
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const structDir = path.join(root, 'doc', 'structurizr');
const war = path.join(structDir, '.tools', 'structurizr.war');
const isWin = process.platform === 'win32';
const java = 'java';

const ensure = spawnSync(process.execPath, [path.join(root, 'scripts', 'structurizr', 'ensure-war.mjs')], {
  cwd: root,
  stdio: 'inherit',
});
if (ensure.status !== 0) process.exit(ensure.status ?? 1);

function run(label, cmd, args, cwd = root) {
  console.log(`\n▶ ${label}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: isWin });
  if (r.status !== 0) {
    console.error(`\n✗ ${label} failed (exit ${String(r.status ?? 1)})`);
    process.exit(r.status ?? 1);
  }
}

run('structurizr validate', java, ['-jar', war, 'validate', '-workspace', 'workspace.dsl'], structDir);
run(
  'structurizr inspect',
  java,
  ['-jar', war, 'inspect', '-workspace', 'workspace.dsl', '-severity', 'error,warning'],
  structDir,
);
run('structurizr:deps', isWin ? 'npm.cmd' : 'npm', ['run', 'structurizr:deps'], root);
console.log('\n✓ structurizr:check passed');
