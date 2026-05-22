#!/usr/bin/env node
/**
 * Diff two Structurizr workspace.dsl files (lightweight parser).
 *
 * Usage:
 *   node scripts/structurizr/diff-workspace.mjs --left doc/structurizr/workspace.dsl --right doc/structurizr/generated/workspace.generated.dsl
 *   node scripts/structurizr/diff-workspace.mjs --left A.dsl --right B.dsl --json report.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffWorkspaces, loadWorkspace } from './parse-dsl.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');

function parseArgs(argv) {
  const opts = { left: null, right: null, json: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--left' || a === '-l') opts.left = path.resolve(REPO_ROOT, argv[++i]);
    else if (a === '--right' || a === '-r') opts.right = path.resolve(REPO_ROOT, argv[++i]);
    else if (a === '--json' || a === '-j') opts.json = path.resolve(REPO_ROOT, argv[++i]);
  }
  return opts;
}

function printSection(title, items, fmt) {
  if (!items.length) return;
  console.log(`\n## ${title} (${items.length})`);
  for (const x of items) console.log(`  ${fmt(x)}`);
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help || !opts.left || !opts.right) {
    console.log('Usage: node scripts/structurizr/diff-workspace.mjs --left <a.dsl> --right <b.dsl> [--json report.json]');
    process.exit(opts.help ? 0 : 2);
  }

  const left = loadWorkspace(opts.left);
  const right = loadWorkspace(opts.right);
  const diff = diffWorkspaces(left, right);

  const summary = {
    left: opts.left,
    right: opts.right,
    addedElements: diff.addedElements.length,
    removedElements: diff.removedElements.length,
    changedElements: diff.changedElements.length,
    addedRelationships: diff.addedRelationships.length,
    removedRelationships: diff.removedRelationships.length,
  };

  console.log('Structurizr workspace diff');
  console.log(`  left:  ${path.relative(REPO_ROOT, opts.left)}`);
  console.log(`  right: ${path.relative(REPO_ROOT, opts.right)}`);
  console.log('\nSummary:', JSON.stringify(summary, null, 2));

  printSection('Added elements', diff.addedElements, (e) => `+ ${e.qualified} [${e.type}] ${e.name}`);
  printSection('Removed elements', diff.removedElements, (e) => `- ${e.qualified} [${e.type}] ${e.name}`);
  printSection(
    'Changed elements',
    diff.changedElements,
    (c) => `~ ${c.qualified}: "${c.left.name}" → "${c.right.name}" (${c.left.type}→${c.right.type})`,
  );
  printSection(
    'Added relationships',
    diff.addedRelationships,
    (r) => `+ ${r.src} -> ${r.dst} "${r.description}" [${r.tags.join(',')}]`,
  );
  printSection(
    'Removed relationships',
    diff.removedRelationships,
    (r) => `- ${r.src} -> ${r.dst} "${r.description}" [${r.tags.join(',')}]`,
  );

  if (opts.json) {
    fs.mkdirSync(path.dirname(opts.json), { recursive: true });
    fs.writeFileSync(opts.json, JSON.stringify({ summary, diff }, null, 2), 'utf8');
    console.log(`\nWrote JSON report: ${path.relative(REPO_ROOT, opts.json)}`);
  }

  const drift =
    summary.addedElements +
    summary.removedElements +
    summary.changedElements +
    summary.addedRelationships +
    summary.removedRelationships;

  process.exit(drift > 0 ? 1 : 0);
}

main();
