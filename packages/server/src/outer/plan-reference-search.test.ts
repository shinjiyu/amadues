import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BrainFS } from '../openkuroneko/brain/brain-fs.js';
import { createFilesystemStore } from '../openkuroneko/archive/fs-store.js';
import { FilesystemRepositoryStore } from '../workspace-kit/index.js';
import { createPlanReferencePort } from './plan-reference-search.js';

let tmpDirs: string[] = [];

beforeEach(() => {
  tmpDirs = [];
});

afterEach(() => {
  for (const d of tmpDirs) {
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  }
});

function mkTmp(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

describe('createPlanReferencePort', () => {
  it('searches archive and repository without writing facts', async () => {
    const dataRoot = mkTmp('plan-ref-dr-');
    const archiveDir = mkTmp('plan-ref-ar-');

    const archiveStore = createFilesystemStore(archiveDir);
    const ws = mkTmp('plan-ref-ws-');
    const brain = new BrainFS(ws);
    brain.writeGoal('抓取股票数据生成报告');
    brain.appendKnowledge('[事实] 某 API 限流');
    await archiveStore.archive({
      brain,
      agentId: 'a1',
      workDir: ws,
      trigger: 'BLOCK',
      triggerReason: '限流',
      goalText: '抓取股票数据生成报告',
      kpiId: 'kpi-stock',
      burstOutcome: {
        verdict: 'failed',
        hardFailures: ['公开 API 拒绝'],
        softFailures: [],
        nextStrategy: '换爬虫源',
      },
    });

    const repo = new FilesystemRepositoryStore(dataRoot);
    repo.commitSession('default', {
      session_id: 's1',
      realm: 'test',
      lane: 'execution',
      items: [
        {
          kind: 'skill',
          title: '股票抓取 playbook',
          body: '抓取股票数据生成报告：先用 search 找数据源',
          tags: ['stock'],
        },
      ],
    });

    const port = createPlanReferencePort({ dataRoot, archiveDir, tenantId: 'default' });
    const hits = await port.search({
      query: '抓取股票数据',
      kpiId: 'kpi-stock',
      sources: ['archive', 'repository'],
      topK: 5,
    });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.source === 'archive')).toBe(true);
    expect(hits.some((h) => h.source === 'repository')).toBe(true);
    expect(hits.some((h) => h.snippet.includes('换爬虫源') || h.snippet.includes('playbook'))).toBe(
      true,
    );
  });

  it('searches peer workspace goal summaries', async () => {
    const workspacesRoot = mkTmp('plan-ref-peers-');
    const peerId = 'task-peer-1';
    const peerDir = path.join(workspacesRoot, peerId);
    fs.mkdirSync(path.join(peerDir, '.brain'), { recursive: true });
    fs.writeFileSync(
      path.join(peerDir, '.brain', 'goal.md'),
      '章节四排版：使用 serial-input 选择器',
      'utf8',
    );

    const port = createPlanReferencePort({
      workspacesRoot,
      peerWorkspaceIds: [peerId],
    });
    const hits = await port.search({
      query: 'serial-input 章节',
      sources: ['peer'],
      topK: 3,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.source).toBe('peer');
    expect(hits[0]?.snippet).toContain('serial-input');
  });
});
