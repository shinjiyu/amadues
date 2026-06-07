/**
 * 一次性 ad-hoc burst — ADL KPI-ADVANCEMENT.md §8
 */
import fs from 'node:fs';
import path from 'node:path';

import { executeOuterTool, type OuterToolContext } from './outer-tools.js';
import { isSetGoalDispatched } from './inner-brain-kpi-reuse.js';

export interface AdHocTask {
  taskId: string;
  goal: string;
  originThread?: string;
  originUser: string;
  status: 'pending' | 'running' | 'done';
  instanceId?: string;
  createdAt: string;
}

function storePath(dataRoot: string): string {
  return path.join(dataRoot, 'ad-hoc-tasks.json');
}

function loadTasks(dataRoot: string): AdHocTask[] {
  const fp = storePath(dataRoot);
  if (!fs.existsSync(fp)) return [];
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf8')) as AdHocTask[];
  } catch {
    return [];
  }
}

function saveTasks(dataRoot: string, tasks: AdHocTask[]): void {
  fs.mkdirSync(dataRoot, { recursive: true });
  const fp = storePath(dataRoot);
  fs.writeFileSync(fp, JSON.stringify(tasks, null, 2), 'utf8');
}

export async function dispatchAdHocBurst(
  dataRoot: string,
  toolCtx: OuterToolContext,
  input: {
    goal: string;
    originUser: string;
    originThread?: string;
    workspaceId: string;
  },
): Promise<{ ok: boolean; output: string; instanceId?: string }> {
  const toolOut = await executeOuterTool(
    'set_goal',
    JSON.stringify({
      goal: input.goal,
      workspace_id: input.workspaceId,
      origin_user: input.originUser,
      origin_thread: input.originThread,
    }),
    { ...toolCtx, inboundHumanSid: input.originUser },
  );

  const m = toolOut.output.match(/instance_id=([^\s,，]+)/);
  const instanceId = m?.[1];
  const tasks = loadTasks(dataRoot);
  tasks.push({
    taskId: `adhoc-${Date.now().toString(36)}`,
    goal: input.goal,
    originUser: input.originUser,
    originThread: input.originThread,
    status: isSetGoalDispatched(toolOut.output) ? 'running' : 'pending',
    instanceId,
    createdAt: new Date().toISOString(),
  });
  saveTasks(dataRoot, tasks.slice(-100));

  return {
    ok: isSetGoalDispatched(toolOut.output),
    output: toolOut.output,
    instanceId,
  };
}
