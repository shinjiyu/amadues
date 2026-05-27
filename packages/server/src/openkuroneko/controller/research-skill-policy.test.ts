/**
 * @see doc/todo/cross-agent-research-and-keychain.md R1
 */
import { describe, expect, it } from 'vitest';

import type { Milestone } from '../brain/brain-fs.js';
import {
  applyResearchWriteSkillGate,
  buildAttributorSystemPrompt,
  countWriteSkillToolCalls,
  isResearchMilestone,
  contractRequiresWriteSkill,
  shouldBlockForMissingWriteSkill,
  shouldRetryResearchWriteSkillPass,
} from './research-skill-policy.js';

function ms(overrides: Partial<Milestone> = {}): Milestone {
  return {
    id: 'M1',
    status: 'Active',
    title: '完成 API 调用',
    description: '拿到响应',
    ...overrides,
  };
}

describe('isResearchMilestone', () => {
  it('detects 调研 in title', () => {
    expect(isResearchMilestone(ms({ title: 'WAF 绕过调研' }))).toBe(true);
  });

  it('detects write_skill in outputsContract', () => {
    expect(
      isResearchMilestone(
        ms({ outputsContract: '报告 + write_skill 蒸馏 tags 含 research' }),
        '',
      ),
    ).toBe(true);
  });

  it('detects 跨Agent in contract text', () => {
    expect(isResearchMilestone(ms(), '跨Agent共享：须 write_skill')).toBe(true);
  });

  it('returns false for ordinary milestone', () => {
    expect(isResearchMilestone(ms({ title: '部署服务', description: '上线 v2' }))).toBe(false);
  });
});

describe('buildAttributorSystemPrompt', () => {
  it('research mode includes write_skill 蒸馏 section', () => {
    const p = buildAttributorSystemPrompt(true);
    expect(p).toContain('研究类里程碑');
    expect(p).toContain('write_skill');
    expect(p).not.toContain('至少 3 步操作且包含决策逻辑');
  });

  it('standard mode keeps 3-step skill gate', () => {
    const p = buildAttributorSystemPrompt(false);
    expect(p).toContain('至少 3 步操作且包含决策逻辑');
  });
});

describe('applyResearchWriteSkillGate', () => {
  it('downgrades SUCCESS_AND_NEXT when no write_skill', () => {
    const out = applyResearchWriteSkillGate(
      { flag: 'SUCCESS_AND_NEXT', reason: '报告已完成' },
      0,
      true,
    );
    expect(out.flag).toBe('CONTINUE');
    expect(out.gated).toBe(true);
    expect(out.reason).toContain('write_skill=0');
  });

  it('passes through when write_skill was called', () => {
    const out = applyResearchWriteSkillGate(
      { flag: 'SUCCESS_AND_NEXT', reason: 'ok' },
      1,
      true,
    );
    expect(out.flag).toBe('SUCCESS_AND_NEXT');
    expect(out.gated).toBe(false);
  });

  it('does not gate non-research milestones', () => {
    const out = applyResearchWriteSkillGate(
      { flag: 'SUCCESS_AND_NEXT', reason: 'ok' },
      0,
      false,
    );
    expect(out.flag).toBe('SUCCESS_AND_NEXT');
  });
});

describe('countWriteSkillToolCalls', () => {
  it('counts write_skill only', () => {
    expect(countWriteSkillToolCalls(['write_knowledge', 'write_skill', 'write_skill'])).toBe(2);
  });
});

describe('contractRequiresWriteSkill', () => {
  it('true when outputsContract mentions write_skill', () => {
    expect(
      contractRequiresWriteSkill(ms({ outputsContract: '须 write_skill 蒸馏' }), ''),
    ).toBe(true);
  });

  it('false when only title says 调研 without contract requirement', () => {
    expect(contractRequiresWriteSkill(ms({ title: 'WAF 调研' }), '')).toBe(false);
  });
});

describe('shouldRetryResearchWriteSkillPass', () => {
  it('retries when gated with zero write_skill', () => {
    expect(shouldRetryResearchWriteSkillPass(0, true, 'SUCCESS_AND_NEXT', true)).toBe(true);
  });

  it('no retry when write_skill present', () => {
    expect(shouldRetryResearchWriteSkillPass(1, true, 'SUCCESS_AND_NEXT', false)).toBe(false);
  });
});

describe('shouldBlockForMissingWriteSkill', () => {
  it('blocks after retry still missing on SUCCESS', () => {
    expect(shouldBlockForMissingWriteSkill(0, true, 'SUCCESS_AND_NEXT', false)).toBe(true);
  });

  it('no block on CONTINUE without contract requirement', () => {
    expect(shouldBlockForMissingWriteSkill(0, false, 'CONTINUE', false)).toBe(false);
  });
});
