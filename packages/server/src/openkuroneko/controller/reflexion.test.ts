/**
 * Reflexion parser 单元测试
 *
 * runReflexion 的主要风险是 LLM 输出格式不严格——我们必须能从带 markdown 围栏、
 * 带前言、字段缺失的脏文本里提炼出干净的 ReflexionResult。下面所有 case 都来自
 * 真实 LLM 偶尔的不规范输出形态。
 */
import { describe, expect, it } from 'vitest';
import { parseReflexionJson } from './reflexion.js';

describe('parseReflexionJson', () => {
  it('解析干净 JSON', () => {
    const json = JSON.stringify({
      verdict: 'failed',
      hardFailures: ['X 接口 403'],
      softFailures: ['关键词命中率低'],
      nextStrategy: '换 Y 路径',
    });
    const r = parseReflexionJson(json)!;
    expect(r.verdict).toBe('failed');
    expect(r.hardFailures).toEqual(['X 接口 403']);
    expect(r.softFailures).toEqual(['关键词命中率低']);
    expect(r.nextStrategy).toBe('换 Y 路径');
  });

  it('剥掉 ```json fence', () => {
    const text = '```json\n{"verdict":"partial","hardFailures":[],"softFailures":[],"nextStrategy":"继续深挖"}\n```';
    const r = parseReflexionJson(text)!;
    expect(r.verdict).toBe('partial');
    expect(r.nextStrategy).toBe('继续深挖');
  });

  it('剥掉 ``` 无语言 tag 的 fence', () => {
    const text = '```\n{"verdict":"success","hardFailures":[],"softFailures":[],"nextStrategy":""}\n```';
    const r = parseReflexionJson(text)!;
    expect(r.verdict).toBe('success');
  });

  it('忍受前言文字（"以下是反思："+JSON）', () => {
    const text = '以下是本次反思：\n{"verdict":"failed","hardFailures":["A"],"softFailures":[],"nextStrategy":"B"}\n（END）';
    const r = parseReflexionJson(text)!;
    expect(r.verdict).toBe('failed');
    expect(r.hardFailures).toEqual(['A']);
    expect(r.nextStrategy).toBe('B');
  });

  it('verdict 字段非法时降级为 failed', () => {
    const text = '{"verdict":"unknown_status","hardFailures":[],"softFailures":[],"nextStrategy":""}';
    const r = parseReflexionJson(text)!;
    expect(r.verdict).toBe('failed');
  });

  it('数组字段为非数组时降级为空数组', () => {
    const text = '{"verdict":"failed","hardFailures":"not an array","softFailures":null,"nextStrategy":"OK"}';
    const r = parseReflexionJson(text)!;
    expect(r.hardFailures).toEqual([]);
    expect(r.softFailures).toEqual([]);
    expect(r.nextStrategy).toBe('OK');
  });

  it('数组里有 non-string 元素时用 String() 强转', () => {
    const text = '{"verdict":"failed","hardFailures":[123,true,"normal"],"softFailures":[],"nextStrategy":""}';
    const r = parseReflexionJson(text)!;
    expect(r.hardFailures).toEqual(['123', 'true', 'normal']);
  });

  it('完全无效输入返回 null', () => {
    expect(parseReflexionJson('')).toBeNull();
    expect(parseReflexionJson('not json at all')).toBeNull();
    expect(parseReflexionJson('   \n   ')).toBeNull();
  });

  it('verdict 大小写不敏感', () => {
    const r = parseReflexionJson('{"verdict":"SUCCESS","hardFailures":[],"softFailures":[],"nextStrategy":""}')!;
    expect(r.verdict).toBe('success');
  });

  it('硬失败列表超过 10 条会被截断', () => {
    const many = Array.from({ length: 15 }, (_, i) => `f-${i}`);
    const text = JSON.stringify({
      verdict: 'failed',
      hardFailures: many,
      softFailures: [],
      nextStrategy: '',
    });
    const r = parseReflexionJson(text)!;
    expect(r.hardFailures).toHaveLength(10);
    expect(r.hardFailures[0]).toBe('f-0');
    expect(r.hardFailures[9]).toBe('f-9');
  });
});
