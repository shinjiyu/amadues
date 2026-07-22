import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';

import {
  buildCompletionMessageFromWorkspace,
  readLastCompleteEvent,
  shouldNotifyUserOnBurstExit,
} from './completion-notify.js';

describe('completion-notify', () => {
  let tmp = '';

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('readLastCompleteEvent ignores trailing PROGRESS after COMPLETE', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-notify-'));
    const runDir = path.join(tmp, '.run', 'pi-mono');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'output'),
      [
        JSON.stringify({ type: 'COMPLETE', message: 'done with results', deliverables: ['r.md'] }),
        JSON.stringify({ type: 'PROGRESS', message: 'still working...' }),
      ].join('\n') + '\n',
      'utf8',
    );
    const ev = readLastCompleteEvent(tmp);
    expect(ev?.type).toBe('COMPLETE');
    expect(ev?.message).toContain('results');
    expect(ev?.deliverables).toEqual(['r.md']);
  });

  it('buildCompletionMessageFromWorkspace includes knowledge and report excerpt', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-notify-'));
    const brain = path.join(tmp, '.brain');
    const runDir = path.join(tmp, '.run', 'pi-mono');
    fs.mkdirSync(brain, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(brain, 'goal.md'), '测试目标', 'utf8');
    fs.writeFileSync(
      path.join(brain, 'milestones.md'),
      '[M1] [Completed] 写报告 — 很长描述\n> 输入范围：xxx',
      'utf8',
    );
    fs.writeFileSync(path.join(brain, 'knowledge.md'), '[事实] 用户 A 得分 9 分', 'utf8');
    fs.writeFileSync(
      path.join(tmp, 'final_report.md'),
      '## 总结\n完成了评估。\n\n' + '细节行。\n'.repeat(20),
      'utf8',
    );
    fs.writeFileSync(
      path.join(runDir, 'output'),
      JSON.stringify({
        type: 'COMPLETE',
        message: '所有里程碑已完成。\n\n## 最终目标\n测试\n\n## 完成的里程碑\n很长过程…',
        deliverables: ['final_report.md'],
      }) + '\n',
      'utf8',
    );

    const { message } = buildCompletionMessageFromWorkspace(tmp);
    expect(message).toContain('## 结果');
    expect(message).toContain('完成了评估');
    expect(message).not.toContain('## 里程碑进度');
    expect(message).not.toContain('输入范围');
    expect(message).not.toContain('## 任务目标');
    expect(message).not.toContain('## 自评');
  });

  it('buildCompletionMessageFromWorkspace surfaces memory.json last_failure as 需注意', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-notify-'));
    const brain = path.join(tmp, '.brain');
    const runDir = path.join(tmp, '.run', 'pi-mono');
    fs.mkdirSync(brain, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(brain, 'goal.md'), 'g', 'utf8');
    fs.writeFileSync(path.join(brain, 'milestones.md'), 'm', 'utf8');
    fs.writeFileSync(
      path.join(brain, 'memory.json'),
      JSON.stringify({
        constraints: [],
        facts: [],
        fact_records: [],
        node_results: {},
        last_failure: {
          nodeInstId: 'n1',
          localRef: 'r1',
          summary: '产物缺失 final_report.md',
          attempted: [],
          confidence: 'high',
          at: new Date().toISOString(),
        },
      }),
      'utf8',
    );

    const { message } = buildCompletionMessageFromWorkspace(tmp);
    expect(message).toContain('## 需注意');
    expect(message).toContain('final_report.md');
  });

  it('buildCompletionMessageFromWorkspace uses COMPLETE.message not seed facts for im', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-notify-seed-'));
    const brain = path.join(tmp, '.brain');
    const runDir = path.join(tmp, '.run', 'pi-mono');
    fs.mkdirSync(brain, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(brain, 'goal.md'), 'test token', 'utf8');
    fs.writeFileSync(path.join(brain, 'milestones.md'), 'm', 'utf8');
    fs.writeFileSync(
      path.join(brain, 'memory.json'),
      JSON.stringify({
        constraints: [],
        facts: ['飞书 token 有效', '推演点 2/3'],
        fact_records: [
          { status: 'active', content: '飞书 token 有效' },
          { status: 'active', content: '推演点 2/3' },
        ],
      }),
      'utf8',
    );
    fs.mkdirSync(path.join(tmp, 'workspace'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'workspace', 'gh_token_test.json'),
      JSON.stringify({ valid: true, username: 'shinjiyu' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(runDir, 'output'),
      JSON.stringify({
        type: 'COMPLETE',
        message: 'GitHub token 已测试有效。用户 shinjiyu，结果写入 workspace/gh_token_test.json。',
        deliverables: ['workspace/gh_token_test.json'],
      }) + '\n',
      'utf8',
    );

    const { message } = buildCompletionMessageFromWorkspace(tmp);
    // IM 优先展示产物摘要（json），不 dump memory seed facts
    expect(message).toMatch(/shinjiyu|GitHub token 已测试有效/);
    expect(message).not.toContain('飞书');
    expect(message).not.toContain('推演点');
  });

  it('shouldNotifyUserOnBurstExit：KPI 不通知，ad-hoc 通知', () => {
    expect(shouldNotifyUserOnBurstExit({ kpiId: 'kpi-1' })).toBe(false);
    expect(shouldNotifyUserOnBurstExit({})).toBe(true);
    expect(shouldNotifyUserOnBurstExit({ kpiId: '' })).toBe(true);
  });
});

describe('ingestInnerBrainDeliverablesOnExit (R4.7 Gap A)', () => {
  let tmp = '';

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('KPI 路径：吸收产物到 status.deliverables，不依赖 IM notify', async () => {
    const { ChatAssetStore } = await import('@utlra/chat-ir');
    const { ingestInnerBrainDeliverablesOnExit, shouldNotifyUserOnBurstExit } = await import(
      './completion-notify.js'
    );
    const { FakeImChannel } = await import('../testing/index.js');

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-ingest-kpi-'));
    const brain = path.join(tmp, '.brain');
    const runDir = path.join(tmp, '.run', 'pi-mono');
    fs.mkdirSync(brain, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(brain, 'goal.md'), '抓推特', 'utf8');
    fs.writeFileSync(path.join(tmp, 'tweet_report.md'), '# report\n1412 tweets\n', 'utf8');
    fs.writeFileSync(
      path.join(runDir, 'output'),
      JSON.stringify({
        type: 'COMPLETE',
        message: 'done',
        deliverables: ['tweet_report.md'],
      }) + '\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(runDir, 'deliverables.json'),
      JSON.stringify(['tweet_report.md']),
      'utf8',
    );

    let saved: unknown[] = [];
    const assetStore = new ChatAssetStore(path.join(tmp, 'uploads'));
    const im = new FakeImChannel();
    const r = ingestInnerBrainDeliverablesOnExit(
      {
        assetStore,
        getEngine: () =>
          ({
            setDeliverables: (d: unknown[]) => {
              saved = d;
            },
            readStatus: () => ({ deliverables: saved }),
          }) as never,
      },
      { workspaceId: 'ws-kpi', workDir: tmp },
    );

    expect(shouldNotifyUserOnBurstExit({ kpiId: 'kpi-x' })).toBe(false);
    expect(r.assets).toHaveLength(1);
    expect(r.assets[0]!.filename).toBe('tweet_report.md');
    expect(saved).toHaveLength(1);
    expect(im.outbox).toHaveLength(0);
  });
});

describe('notifyInnerBrainTaskFailed', () => {
  it('sends short failure message without fact dump', async () => {
    const { FakeImChannel } = await import('../testing/index.js');
    const { notifyInnerBrainTaskFailed } = await import('./completion-notify.js');
    const im = new FakeImChannel();
    await notifyInnerBrainTaskFailed(
      { imClient: im, agentSid: 'agent:k' },
      {
        instanceId: 'ib-test',
        originThread: 't1',
        reason: 'Designer LLM 调用失败：503',
      },
    );
    expect(im.lastText('t1')).toContain('内脑任务失败');
    expect(im.lastText('t1')).toContain('503');
    expect(im.lastText('t1')).not.toContain('## 结果');
  });
});

describe('notifyInnerBrainTaskPartial', () => {
  let partialTmp = '';

  afterEach(() => {
    if (partialTmp) fs.rmSync(partialTmp, { recursive: true, force: true });
  });

  it('sends ⚠️ partial message with gap summary, not ✅', async () => {
    const { FakeImChannel } = await import('../testing/index.js');
    const { notifyInnerBrainTaskPartial } = await import('./completion-notify.js');
    const { ChatAssetStore } = await import('@utlra/chat-ir');
    const { createNoopEngine } = await import('../testing/agent-stack-fixture.js');

    partialTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-partial-'));
    const brain = path.join(partialTmp, '.brain');
    const runDir = path.join(partialTmp, '.run', 'pi-mono');
    fs.mkdirSync(brain, { recursive: true });
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(brain, 'goal.md'), '部署到 onlyclaws.world', 'utf8');
    fs.writeFileSync(path.join(brain, 'milestones.md'), 'm', 'utf8');
    fs.writeFileSync(path.join(partialTmp, 'report.md'), '## 总结\n本地代码已完成。', 'utf8');
    fs.writeFileSync(
      path.join(runDir, 'output'),
      JSON.stringify({
        type: 'COMPLETE',
        message: 'done',
        deliverables: ['report.md'],
      }) + '\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(runDir, 'deliverables.json'),
      JSON.stringify(['report.md']),
      'utf8',
    );

    const im = new FakeImChannel();
    const assetStore = new ChatAssetStore(path.join(partialTmp, 'uploads'));

    await notifyInnerBrainTaskPartial(
      {
        imClient: im,
        agentSid: 'agent:k',
        assetStore,
        getEngine: () => createNoopEngine(),
      },
      {
        instanceId: 'ib-partial',
        workspaceId: 'ws1',
        workDir: partialTmp,
        originThread: 't-partial',
        gapSummary: '**未达成的目标：**\n· 未远程部署\n\n**需要你协助：**\n· 本地执行 deploy-auto.sh',
      },
    );

    const text = im.lastText('t-partial');
    expect(text).toMatch(/^⚠️ 内脑任务部分完成/);
    expect(text).not.toMatch(/^✅/);
    expect(text).toContain('未远程部署');
    expect(text).toContain('report.md');
    expect(text).toContain('已附上 1 个产出文件');
  });
});
