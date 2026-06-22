import { describe, expect, it } from 'vitest';

import {
  deriveConstraintTopic,
  recordConstraintGoverned,
  selectConstraintsForPrompt,
  sweepConstraints,
} from './constraint-governor.js';

describe('deriveConstraintTopic', () => {
  it('groups run-failure by ref', () => {
    const a = '[run-failure] 节点 foo（preset/base）：cap';
    const b = '[run-failure] ref preset/base 已达 safety_cap';
    expect(deriveConstraintTopic(a)).toBe('run-failure.preset.base');
    expect(deriveConstraintTopic(b)).toBe('run-failure.cap.preset.base');
  });

  it('groups publish_article避坑', () => {
    const a = '[避坑] fanqienovel /app/book/publish_article/v0/ 必须 form-urlencoded';
    const b = '[避坑] publish_article Content-Type charset=UTF-8';
    expect(deriveConstraintTopic(a)).toBe('避坑.api.publish_article.v0');
    expect(deriveConstraintTopic(b)).toBe('避坑.api.publish_article.v0');
  });
});

describe('recordConstraintGoverned', () => {
  it('replaces same-topic constraint', () => {
    const first = recordConstraintGoverned([], '[避坑] /app/book/publish_article/v0/ 用 form');
    const second = recordConstraintGoverned(
      first.constraints,
      '[避坑] publish_article 必须 charset=UTF-8',
    );
    expect(second.action).toBe('replaced');
    expect(second.constraints).toHaveLength(1);
  });

  it('skips exact duplicate', () => {
    const c = '[红线] 禁止纯 API publish';
    const first = recordConstraintGoverned([], c);
    const second = recordConstraintGoverned(first.constraints, c);
    expect(second.action).toBe('skipped');
  });
});

describe('selectConstraintsForPrompt', () => {
  it('dedupes by topic and caps output', () => {
    const constraints = [
      '[避坑] /app/book/publish_article/v0/ rule A',
      '[避坑] publish_article rule B updated',
      '[红线] no api',
      ...Array.from({ length: 20 }, (_, i) => `[避坑] misc ${i}`),
    ];
    const { lines, omitted } = selectConstraintsForPrompt(constraints, { max: 5 });
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(omitted).toBeGreaterThan(0);
    expect(lines.some(l => l.includes('[红线]'))).toBe(true);
  });
});

describe('sweepConstraints', () => {
  it('dedupes bot2-like run-failure pile', () => {
    const constraints = [
      '[run-failure] 节点 a（preset/base）：cap',
      '[run-failure] 节点 b（preset/base）：cap',
      '[run-failure] ref preset/base 已达 safety_cap',
      '[避坑] /app/book/publish_article/v0/ x',
      '[避坑] publish_article y',
    ];
    const { constraints: out, result } = sweepConstraints(constraints);
    expect(out.length).toBeLessThan(constraints.length);
    expect(result.remaining).toBe(out.length);
  });
});
