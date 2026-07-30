import { describe, expect, it } from 'vitest';

import { isSetGoalDispatched } from './inner-brain-kpi-reuse.js';

describe('inner-brain-kpi-reuse', () => {
  it('isSetGoalDispatched 识别新实例与历史续跑文案', () => {
    expect(isSetGoalDispatched('已创建新内脑实例并启动任务。instance_id=ib-1')).toBe(true);
    expect(isSetGoalDispatched('已在既有内脑实例上续跑。instance_id=ib-1')).toBe(true);
    expect(isSetGoalDispatched('已后台启动工作流 ew-x@2（instance=ib-1，ws=task-ib-1）')).toBe(true);
    expect(isSetGoalDispatched('（禁止 set_goal(kpi_id)）')).toBe(false);
  });
});
