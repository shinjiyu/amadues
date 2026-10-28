import type { AblationTask } from '../types.ts';
import { accessLogRedact } from './access-log-redact/task.ts';
import { catalogPageSlice } from './catalog-page-slice/task.ts';
import { closeDayDrift } from './close-day-drift/task.ts';
import { claims1in8b } from './claims-1in8b/task.ts';
import { fakeHello } from './fake-hello/task.ts';
import { impl1in8b } from './impl-1in8b/task.ts';
import { intakeSilentDrop } from './intake-silent-drop/task.ts';
import { keywordFromLog } from './keyword-from-log/task.ts';
import { ledgerRefundSign } from './ledger-refund-sign/task.ts';
import { notesSearchGap } from './notes-search-gap/task.ts';
import { orderStatusSplit } from './order-status-split/task.ts';
import { rewardStandingExploit } from './reward-standing-exploit/task.ts';
import { rosterNoOverlap } from './roster-no-overlap/task.ts';
import { serviceSurvivesSession } from './service-survives-session/task.ts';
import { shanghaiOpenHours } from './shanghai-open-hours/task.ts';
import { vizFrontendNotMoving } from './viz-frontend-not-moving/task.ts';
import { vizLegLayout } from './viz-leg-layout/task.ts';

/** 第一轮：六足研究线，已跑完，原始数据在 runs/round1 */
export const ROUND1_TASKS: readonly AblationTask[] = [
  vizFrontendNotMoving,
  vizLegLayout,
  rewardStandingExploit,
  serviceSurvivesSession,
];

/** 第二轮：更宽的题目类型。不覆盖第一轮数据。 */
export const ROUND2_TASKS: readonly AblationTask[] = [
  ledgerRefundSign,
  catalogPageSlice,
  rosterNoOverlap,
  accessLogRedact,
  shanghaiOpenHours,
];

/** 第三轮：开放排查。不覆盖前两轮数据。 */
export const ROUND3_TASKS: readonly AblationTask[] = [
  closeDayDrift,
  intakeSilentDrop,
  notesSearchGap,
  orderStatusSplit,
];

/** 第四轮：更开放的取证。不覆盖前三轮数据。 */
export const ROUND4_TASKS: readonly AblationTask[] = [
  keywordFromLog,
  impl1in8b,
  claims1in8b,
];

/** 真实任务集（各轮都要过判分器自证） */
export const REAL_TASKS: readonly AblationTask[] = [...ROUND1_TASKS, ...ROUND2_TASKS, ...ROUND3_TASKS, ...ROUND4_TASKS];

export const SMOKE_TASKS: readonly AblationTask[] = [fakeHello];

export const ALL_TASKS: readonly AblationTask[] = [...REAL_TASKS, ...SMOKE_TASKS];

export function findTask(id: string): AblationTask {
  const t = ALL_TASKS.find(x => x.id === id);
  if (!t) throw new Error(`unknown task: ${id}（可选：${ALL_TASKS.map(x => x.id).join(', ')}）`);
  return t;
}
