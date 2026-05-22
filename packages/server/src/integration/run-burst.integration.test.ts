/**
 * E.1：内脑单 burst（FakeLLM）— DECOMPOSE → EXECUTE → ATTRIBUTE → COMPLETE 落盘。
 */
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  burstScriptMilestones,
  createControllerHarness,
  type ControllerHarness,
} from '../testing/controller-fixture.js';
import { createFakeLLM } from '../testing/fake-llm.js';

describe('integration: run-burst', () => {
  let h: ControllerHarness;

  afterEach(() => {
    h?.cleanup();
  });

  it('FakeLLM 脚本驱动 → milestones.md + COMPLETE output', async () => {
    h = createControllerHarness({
      goal: '写一份一页纸的项目摘要（summary.md）',
      llm: createFakeLLM(burstScriptMilestones()),
    });

    let ticks = 0;
    for (let i = 0; i < 12; i++) {
      const { hadWork } = await h.controller.tick();
      ticks += 1;
      if (!hadWork) break;
    }
    expect(ticks).toBeGreaterThan(0);

    const milestones = h.brain.readMilestones();
    expect(milestones).toMatch(/\[M1\]/);

    const output = fs.readFileSync(h.outputPath, 'utf8');
    expect(output).toContain('COMPLETE');
    const st = h.brain.readState();
    // 完成后先 BLOCKED(post-complete)，后续 tick 可能 migrate → AWAITING
    expect(st.blockedReason ?? st.awaitingReason ?? '').toContain('目标已完成');
  });
});
