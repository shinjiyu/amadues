import { describe, expect, it } from 'vitest';
import { OUTER_EXECUTABLE_WORKFLOW_GUIDE } from './executable-workflow-guide.js';

describe('OUTER_EXECUTABLE_WORKFLOW_GUIDE', () => {
  it('教 Agent 认识 explore 与 execute 两套能力', () => {
    expect(OUTER_EXECUTABLE_WORKFLOW_GUIDE).toMatch(/explore/);
    expect(OUTER_EXECUTABLE_WORKFLOW_GUIDE).toMatch(/execute/);
    expect(OUTER_EXECUTABLE_WORKFLOW_GUIDE).toMatch(/workflow_list/);
    expect(OUTER_EXECUTABLE_WORKFLOW_GUIDE).toMatch(/workflow_promote/);
    expect(OUTER_EXECUTABLE_WORKFLOW_GUIDE).toMatch(/workflow_suggest_promote/);
    expect(OUTER_EXECUTABLE_WORKFLOW_GUIDE).toMatch(/workflow_run/);
    expect(OUTER_EXECUTABLE_WORKFLOW_GUIDE).toMatch(/promote_executable_workflow/);
    expect(OUTER_EXECUTABLE_WORKFLOW_GUIDE).toMatch(/ATTRIBUTE/);
    expect(OUTER_EXECUTABLE_WORKFLOW_GUIDE).toMatch(/聊天显式指定/);
    expect(OUTER_EXECUTABLE_WORKFLOW_GUIDE).toMatch(/workflow_promote/);
  });
});
