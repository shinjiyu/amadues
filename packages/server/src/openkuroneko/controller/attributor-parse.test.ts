/**
 * Attributor 响应解析：`parseControlFlag`。
 *
 * 这是 controller 的关键决策入口——LLM 给的字符串落到哪一个 ControlFlag。
 * 任何 LLM 风格变动（中文冒号、markdown 加粗、反引号、大小写、纯关键词）都不能脱出兜底语义。
 */
import { describe, expect, it } from 'vitest';

import { parseControlFlag } from './attributor.js';

describe('parseControlFlag · 直接命中', () => {
  it('CONTINUE 半角冒号', () => {
    expect(parseControlFlag('CONTROL: CONTINUE\nREASON: 继续推进')).toEqual({
      flag: 'CONTINUE',
      reason: '继续推进',
    });
  });

  it('SUCCESS_AND_NEXT 全角冒号', () => {
    expect(parseControlFlag('CONTROL:SUCCESS_AND_NEXT\nREASON:M1 已完成')).toEqual({
      flag: 'SUCCESS_AND_NEXT',
      reason: 'M1 已完成',
    });
  });

  it('REPLAN markdown 加粗 + 反引号', () => {
    expect(parseControlFlag('**CONTROL**: `REPLAN`\nREASON: 工具不可用')).toEqual({
      flag: 'REPLAN',
      reason: '工具不可用',
    });
  });

  it('BLOCK 小写 + 多余空格', () => {
    expect(parseControlFlag('control :   block\nreason  :  人工兜底')).toEqual({
      flag: 'BLOCK',
      reason: '人工兜底',
    });
  });

  it('CYCLE_DONE', () => {
    expect(parseControlFlag('CONTROL: CYCLE_DONE\nREASON: 第一轮巡检完成')).toEqual({
      flag: 'CYCLE_DONE',
      reason: '第一轮巡检完成',
    });
  });
});

describe('parseControlFlag · 兜底路径', () => {
  it('无 CONTROL 标识，但末尾出现 CONTINUE 关键词 → 取兜底', () => {
    const r = parseControlFlag('我已经把文件改完了。CONTINUE');
    expect(r.flag).toBe('CONTINUE');
    expect(r.reason).toContain('从末尾关键词推断');
  });

  it('完全无关 → 保守降级 REPLAN', () => {
    const r = parseControlFlag('我在思考');
    expect(r.flag).toBe('REPLAN');
    expect(r.reason).toContain('无法解析');
  });

  it('无 REASON 但有 CONTROL → reason 显示「无原因说明」', () => {
    const r = parseControlFlag('CONTROL: CONTINUE');
    expect(r.flag).toBe('CONTINUE');
    expect(r.reason).toBe('（无原因说明）');
  });

  it('REASON 中含多行 → 仅取首行避免误吞下游内容', () => {
    const r = parseControlFlag('CONTROL: REPLAN\nREASON: 工具拒绝\n额外解释');
    expect(r.flag).toBe('REPLAN');
    expect(r.reason).toBe('工具拒绝');
  });
});

describe('parseControlFlag · 大小写鲁棒', () => {
  it.each(['continue', 'Continue', 'CONTINUE'])('flag=%s 都识别为 CONTINUE', (raw) => {
    expect(parseControlFlag(`CONTROL: ${raw}\nREASON: x`).flag).toBe('CONTINUE');
  });
});
