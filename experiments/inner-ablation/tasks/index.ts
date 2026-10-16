import type { AblationTask } from '../types.ts';
import { fakeHello } from './fake-hello/task.ts';
import { rewardStandingExploit } from './reward-standing-exploit/task.ts';
import { serviceSurvivesSession } from './service-survives-session/task.ts';
import { vizFrontendNotMoving } from './viz-frontend-not-moving/task.ts';
import { vizLegLayout } from './viz-leg-layout/task.ts';

/** 真实任务集（从 kuroneko 历史固化） */
export const REAL_TASKS: readonly AblationTask[] = [
  vizFrontendNotMoving,
  vizLegLayout,
  rewardStandingExploit,
  serviceSurvivesSession,
];

export const SMOKE_TASKS: readonly AblationTask[] = [fakeHello];

export const ALL_TASKS: readonly AblationTask[] = [...REAL_TASKS, ...SMOKE_TASKS];

export function findTask(id: string): AblationTask {
  const t = ALL_TASKS.find(x => x.id === id);
  if (!t) throw new Error(`unknown task: ${id}（可选：${ALL_TASKS.map(x => x.id).join(', ')}）`);
  return t;
}
