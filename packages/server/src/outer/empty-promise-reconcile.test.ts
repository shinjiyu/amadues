import { describe, expect, it } from 'vitest';

import {
  hasSuccessfulWorkAction,
  isAgentWorkCommitment,
  isSuccessfulWorkAction,
  isUserWorkRequest,
  shouldReconcileEmptyPromise,
} from './empty-promise-reconcile.js';

describe('emptyPromiseReconcile', () => {
  it('识别高置信用户祈使', () => {
    expect(isUserWorkRequest('帮我查一下今天天气')).toBe(true);
    expect(isUserWorkRequest('把报告固化成工作流')).toBe(true);
    expect(isUserWorkRequest('你好')).toBe(false);
    expect(isUserWorkRequest('介绍一下自己')).toBe(false);
  });

  it('识别口头承诺；问句不算', () => {
    expect(isAgentWorkCommitment('好的，我去办')).toBe(true);
    expect(isAgentWorkCommitment('这就开跑，稍等')).toBe(true);
    expect(isAgentWorkCommitment('已派内脑了')).toBe(true);
    expect(isAgentWorkCommitment('还没派，要我现在开跑吗？')).toBe(false);
    expect(isAgentWorkCommitment('今天晴，体感不错')).toBe(false);
  });

  it('软跳过 / 失败不算成功派活', () => {
    expect(
      isSuccessfulWorkAction('set_goal', '（另一 agent 已先接单，跳过内脑派发）'),
    ).toBe(false);
    expect(isSuccessfulWorkAction('set_goal', '（槽位已满，本次 set_goal 跳过）')).toBe(false);
    expect(
      isSuccessfulWorkAction('set_goal', '已创建新内脑实例并启动任务。instance_id=ib-1'),
    ).toBe(true);
    expect(isSuccessfulWorkAction('advance_kpi', 'KPI 推进成功：kpi_sprint_dispatched')).toBe(true);
    expect(isSuccessfulWorkAction('reply_to_user', '已发送消息')).toBe(false);
  });

  it('双侧命中且无成功派活 → 应对账', () => {
    expect(
      shouldReconcileEmptyPromise({
        userMessage: '帮我改一下 gen_table 输出 HTML',
        replyTexts: ['好的，我去办'],
        toolResults: [{ name: 'reply_to_user', output: '已发送消息（8 字符）' }],
      }),
    ).toBe(true);
  });

  it('已成功 set_goal → 不对账', () => {
    expect(
      shouldReconcileEmptyPromise({
        userMessage: '帮我查一下今天天气',
        replyTexts: ['已开跑'],
        toolResults: [
          {
            name: 'set_goal',
            output: '已创建新内脑实例并启动任务。instance_id=ib-1',
          },
          { name: 'reply_to_user', output: '已发送消息' },
        ],
      }),
    ).toBe(false);
    expect(
      hasSuccessfulWorkAction([
        { name: 'set_goal', output: '（禁止 set_goal(kpi_id)）' },
      ]),
    ).toBe(false);
  });

  it('闲聊口头「我去忙」→ 不对账', () => {
    expect(
      shouldReconcileEmptyPromise({
        userMessage: '在吗',
        replyTexts: ['在，我去忙别的了'],
        toolResults: [{ name: 'reply_to_user', output: '已发送' }],
      }),
    ).toBe(false);
  });
});
