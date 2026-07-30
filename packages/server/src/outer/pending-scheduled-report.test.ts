import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  enqueuePendingScheduledReport,
  flushPendingScheduledReportsForThread,
  listPendingScheduledReports,
} from './pending-scheduled-report.js';

describe('pending-scheduled-report', () => {
  let tmp = '';
  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('enqueue + flush on thread match', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pend-sched-'));
    const ws = path.join(tmp, 'ws1');
    fs.mkdirSync(path.join(ws, 'workspace'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'workspace', 'tweets_summary.html'), '<html>hi</html>', 'utf8');
    fs.writeFileSync(path.join(ws, 'workspace', 'tweets_summary.json'), '{"kept_count":1}', 'utf8');
    // 假标记应被冲刷清掉
    fs.mkdirSync(path.join(ws, '.run'), { recursive: true });
    fs.writeFileSync(
      path.join(ws, '.run', 'completion-notified.json'),
      JSON.stringify({ instanceId: 'ib-x', at: 't' }),
      'utf8',
    );

    enqueuePendingScheduledReport(tmp, {
      instanceId: 'ib-x',
      workDir: ws,
      originThread: 'wechat:bot:dm:u',
      workflowLabel: 'ew@4',
      ok: true,
      kpiId: 'kpi-1',
    });
    expect(listPendingScheduledReports(tmp)).toHaveLength(1);

    const posts: unknown[] = [];
    const { flushed } = await flushPendingScheduledReportsForThread(tmp, 'wechat:bot:dm:u', {
      agentSid: 'agent:k',
      imClient: {
        postMessage: async (tid, body) => {
          posts.push({ tid, body });
        },
      } as never,
    });
    expect(flushed).toEqual(['ib-x']);
    expect(posts).toHaveLength(1);
    expect(listPendingScheduledReports(tmp)).toHaveLength(0);
    expect(fs.existsSync(path.join(ws, '.run', 'completion-notified.json'))).toBe(true);
  });

  it('flush keeps row when postMessage throws', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pend-sched-fail-'));
    const ws = path.join(tmp, 'ws1');
    fs.mkdirSync(ws, { recursive: true });
    enqueuePendingScheduledReport(tmp, {
      instanceId: 'ib-y',
      workDir: ws,
      originThread: 'wechat:bot:dm:u',
      workflowLabel: 'ew@4',
      ok: true,
    });
    const { failed } = await flushPendingScheduledReportsForThread(tmp, 'wechat:bot:dm:u', {
      agentSid: 'agent:k',
      imClient: {
        postMessage: async () => {
          throw new Error('wechat_no_context_token:x');
        },
      } as never,
    });
    expect(failed).toEqual(['ib-y']);
    expect(listPendingScheduledReports(tmp)).toHaveLength(1);
  });
});
