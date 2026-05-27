/**
 * ADL component: attributor — parseControlFlag + research write_skill gate
 */
import { describe, expect, it } from 'vitest';

import { parseControlFlag } from './attributor.js';
import { applyResearchWriteSkillGate, shouldBlockForMissingWriteSkill } from './research-skill-policy.js';

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

  it('研究里程碑缺 write_skill → gate 为 CONTINUE', () => {
    const r = applyResearchWriteSkillGate(
      { flag: 'SUCCESS_AND_NEXT', reason: '调研完成' },
      0,
      true,
    );
    expect(r.flag).toBe('CONTINUE');
    expect(r.gated).toBe(true);
  });

  it('契约要求 write_skill 且仍缺失 → shouldBlock', () => {
    expect(shouldBlockForMissingWriteSkill(0, true, 'SUCCESS_AND_NEXT', false)).toBe(true);
  });
});
