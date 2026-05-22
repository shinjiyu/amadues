/**
 * ADL component: attributor — parseControlFlag 契约
 */
import { describe, expect, it } from 'vitest';

import { parseControlFlag } from './attributor.js';

describe('component: attributor', () => {
  it('CONTROL: CONTINUE（主路径）', () => {
    const r = parseControlFlag('CONTROL: CONTINUE\nREASON: 里程碑完成');
    expect(r.flag).toBe('CONTINUE');
    expect(r.reason).toContain('里程碑');
  });

  it('无法解析 → REPLAN + 默认原因', () => {
    const r = parseControlFlag('随便一段话');
    expect(r.flag).toBe('REPLAN');
    expect(r.reason.length).toBeGreaterThan(0);
  });
});
