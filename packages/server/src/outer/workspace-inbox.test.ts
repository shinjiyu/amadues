import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { InnerBrainRegistry } from './inner-brain-registry.js';
import { KpiRegistry } from './kpi-registry.js';
import {
  collectPeerWorkspaceIds,
  readDeliverableRelativePaths,
  summarizeTextFile,
  writePeerCatalog,
} from './workspace-inbox.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-test-'));
}

describe('workspace-inbox', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('readDeliverableRelativePaths merges log and json', () => {
    const root = mkTmp();
    dirs.push(root);
    const run = path.join(root, '.run');
    fs.mkdirSync(path.join(run, 'pi-mono'), { recursive: true });
    fs.writeFileSync(
      path.join(run, 'deliverables.log'),
      [
        JSON.stringify({ event: 'ingest_ok', path: 'novel_full.md', ts: '2026-06-01T00:00:00Z' }),
        JSON.stringify({ event: 'skip', path: 'ignored.txt' }),
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      path.join(run, 'pi-mono', 'deliverables.json'),
      JSON.stringify(['outline.md', 'novel_full.md']),
      'utf8',
    );

    expect(readDeliverableRelativePaths(root).sort()).toEqual(['novel_full.md', 'outline.md']);
  });

  it('writePeerCatalog writes summaries only, not file copies', () => {
    const upstreamRoot = mkTmp();
    const targetRoot = mkTmp();
    dirs.push(upstreamRoot, targetRoot);

    fs.mkdirSync(path.join(upstreamRoot, '.run'), { recursive: true });
    fs.writeFileSync(path.join(upstreamRoot, 'chapter.md'), '# chapter one content', 'utf8');
    fs.writeFileSync(
      path.join(upstreamRoot, '.run', 'deliverables.log'),
      JSON.stringify({ event: 'ingest_ok', path: 'chapter.md' }) + '\n',
      'utf8',
    );

    const result = writePeerCatalog(targetRoot, [
      { workspaceId: 'task-ib-up', workDir: upstreamRoot, goal: 'write novel' },
    ]);

    expect(result.fileCount).toBe(1);
    expect(fs.existsSync(path.join(targetRoot, '.inbox', 'task-ib-up', 'chapter.md'))).toBe(false);

    const readme = fs.readFileSync(result.readmePath, 'utf8');
    expect(readme).toContain('task-ib-up');
    expect(readme).toContain('chapter.md');
    expect(readme).toContain('chapter one content');

    const catalog = JSON.parse(fs.readFileSync(result.catalogPath, 'utf8')) as {
      peers: Array<{ files: Array<{ path: string; summary: string }> }>;
    };
    expect(catalog.peers[0]?.files[0]?.path).toBe('chapter.md');
    expect(catalog.peers[0]?.files[0]?.summary).toContain('chapter one');
  });

  it('collectPeerWorkspaceIds returns same-KPI siblings only', () => {
    const dataRoot = mkTmp();
    dirs.push(dataRoot);
    const workspaces = path.join(dataRoot, 'workspaces');
    fs.mkdirSync(workspaces, { recursive: true });

    const wsA = path.join(workspaces, 'task-ib-a');
    const wsB = path.join(workspaces, 'task-ib-b');
    const wsOther = path.join(workspaces, 'task-ib-other');
    for (const d of [wsA, wsB, wsOther]) fs.mkdirSync(d, { recursive: true });

    const registry = new InnerBrainRegistry(dataRoot);
    const kpiRegistry = new KpiRegistry(dataRoot);

    registry.register({
      instanceId: 'a1',
      workspaceId: 'task-ib-a',
      workDir: wsA,
      goal: 'g',
      originUser: 'u',
      status: 'STOPPED',
      startedAt: '2026-06-01T12:00:00Z',
      kpiId: 'kpi-novel',
    });
    registry.register({
      instanceId: 'b1',
      workspaceId: 'task-ib-b',
      workDir: wsB,
      goal: 'g',
      originUser: 'u',
      status: 'RUNNING',
      startedAt: '2026-06-02T12:00:00Z',
      kpiId: 'kpi-novel',
    });
    registry.register({
      instanceId: 'o1',
      workspaceId: 'task-ib-other',
      workDir: wsOther,
      goal: 'g',
      originUser: 'u',
      status: 'DONE',
      startedAt: '2026-06-01T10:00:00Z',
      deliverableCount: 3,
    });

    const kpi = kpiRegistry.create({ description: 'novel', createdBy: 'u' });
    kpiRegistry.attachBurst(kpi.kpiId, 'a1');
    kpiRegistry.attachBurst(kpi.kpiId, 'b1');

    const ids = collectPeerWorkspaceIds({
      registry,
      excludeWorkspaceId: 'task-ib-b',
      kpiId: kpi.kpiId,
      kpiRegistry,
    });

    expect(ids).toEqual(['task-ib-a']);
    expect(ids).not.toContain('task-ib-other');
  });

  it('summarizeTextFile truncates long text', () => {
    const root = mkTmp();
    dirs.push(root);
    const fp = path.join(root, 'long.txt');
    fs.writeFileSync(fp, 'x'.repeat(500), 'utf8');
    const summary = summarizeTextFile(fp, 100);
    expect(summary.length).toBeLessThanOrEqual(101);
    expect(summary.endsWith('…')).toBe(true);
  });
});
