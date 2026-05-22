#!/usr/bin/env node
/**
 * Generate Structurizr DSL from Kuroneko code layout (manifest-driven).
 *
 * Usage:
 *   node scripts/structurizr/code-to-dsl.mjs --granularity l2
 *   node scripts/structurizr/code-to-dsl.mjs --granularity l3-full --out doc/structurizr/generated/workspace.generated.dsl
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModel } from './dsl-emit.mjs';
import { GRANULARITY, GRANULARITY_KEYS, L2_CONTAINERS, PACKAGE_TO_CONTAINER } from './manifest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

function parseArgs(argv) {
  const opts = {
    granularity: null,
    out: path.join(REPO_ROOT, 'doc/structurizr/generated/workspace.generated.dsl'),
    list: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--list') opts.list = true;
    else if (a === '--granularity' || a === '-g') opts.granularity = argv[++i];
    else if (a === '--out' || a === '-o') opts.out = path.resolve(REPO_ROOT, argv[++i]);
  }
  return opts;
}

function readPackageJson(dir) {
  const fp = path.join(dir, 'package.json');
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function collectImportEdges() {
  const edges = [];
  const seen = new Set();

  const scanDir = (relDir) => {
    const dir = path.join(REPO_ROOT, relDir);
    const pkg = readPackageJson(dir);
    if (!pkg?.name) return;
    const fromId = PACKAGE_TO_CONTAINER[pkg.name];
    if (!fromId) return;

    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const dep of Object.keys(deps)) {
      if (!dep.startsWith('@utlra/')) continue;
      const toId = PACKAGE_TO_CONTAINER[dep];
      if (!toId || toId === fromId) continue;
      const key = `${fromId}->${toId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from: fromId, to: toId, reason: `${pkg.name} depends on ${dep}` });
    }
  };

  for (const c of L2_CONTAINERS) {
    if (!c.path.startsWith('packages/') && !c.path.startsWith('apps/')) continue;
    const base = c.path.split('/src/')[0];
    scanDir(base);
  }

  return edges;
}

function pathExists(relPath) {
  const fp = path.join(REPO_ROOT, relPath);
  if (fs.existsSync(fp)) return true;
  if (relPath.endsWith('.ts')) return fs.existsSync(fp.replace(/\.ts$/, ''));
  return false;
}

function main() {
  const opts = parseArgs(process.argv);

  if (opts.help || opts.list) {
    console.log(`Usage: node scripts/structurizr/code-to-dsl.mjs --granularity <${GRANULARITY_KEYS.join('|')}>`);
    console.log('\nGranularity presets (prevents drift — always pick explicitly):\n');
    for (const k of GRANULARITY_KEYS) {
      console.log(`  ${k.padEnd(12)} ${GRANULARITY[k].label}`);
    }
    process.exit(0);
  }

  if (!opts.granularity || !GRANULARITY[opts.granularity]) {
    console.error(`Error: --granularity is required. One of: ${GRANULARITY_KEYS.join(', ')}`);
    console.error('Run with --list to see descriptions.');
    process.exit(2);
  }

  const preset = { key: opts.granularity, ...GRANULARITY[opts.granularity] };
  const importEdges = preset.importEdges ? collectImportEdges() : [];

  const dsl = buildModel({
    granularity: preset,
    importEdges,
    repoRoot: REPO_ROOT,
    pathExists,
  });

  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, dsl, 'utf8');

  console.log(`Wrote ${path.relative(REPO_ROOT, opts.out)}`);
  console.log(`  granularity: ${opts.granularity} — ${preset.label}`);
  console.log(`  import edges: ${importEdges.length}`);
  console.log('\nNext:');
  console.log(`  npm run structurizr:diff -- --left doc/structurizr/workspace.dsl --right ${path.relative(REPO_ROOT, opts.out)}`);
  console.log('  doc/structurizr/run-war.bat validate -workspace <file>');
}

main();
