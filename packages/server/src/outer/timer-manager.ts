/**
 * 定时管理器：到点派一名新工人。不看台上谁在等，也不找闲活。
 * ADL: doc/structurizr/WORKSHOP.md §7
 */
import type { OuterToolContext } from './outer-tools.js';
import { executeOuterTool } from './outer-tools.js';
import { EmployeeCalendar } from '../scheduler/employee-calendar.js';
import { Scheduler } from '../scheduler/scheduler.js';

const DISPATCHED = ['已创建新内脑实例并启动任务', '已后台启动工作流', '已向内脑派发任务'];

export interface TimerManagerDeps {
  dataRoot: string;
  defaultThreadId: string;
  toolCtx: OuterToolContext;
}

export class TimerManager {
  private readonly scheduler: Scheduler;
  private readonly calendar: EmployeeCalendar;

  constructor(deps: TimerManagerDeps) {
    this.scheduler = new Scheduler({
      dataRoot: deps.dataRoot,
      deferMissedExecution: true,
    });
    this.scheduler.configureCallbacks({
      executePromptAction: async (_taskId, prompt) => {
        const result = await executeOuterTool(
          'set_goal',
          JSON.stringify({
            goal: prompt,
            origin_thread: deps.defaultThreadId,
          }),
          deps.toolCtx,
        );
        if (!DISPATCHED.some((mark) => result.output.includes(mark))) {
          throw new Error(result.output);
        }
        return result.output;
      },
      executeToolCallAction: async () => {
        throw new Error('timer_manager_only_dispatches_a_worker');
      },
      executeSendMessageAction: async (_taskId, target, content) => {
        await deps.toolCtx.imClient.postMessage(target || deps.defaultThreadId, {
          sender_sid: deps.toolCtx.agentSid,
          text: content,
        });
        return 'message_sent';
      },
      isAgentBusy: () => false,
    });
    this.calendar = new EmployeeCalendar(this.scheduler);
    deps.toolCtx.employeeCalendar = this.calendar;
  }

  start(): Promise<void> {
    return this.scheduler.start();
  }

  stop(): Promise<void> {
    return this.scheduler.stop();
  }

  getCalendar(): EmployeeCalendar {
    return this.calendar;
  }
}
