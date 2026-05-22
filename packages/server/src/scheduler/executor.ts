/**
 * Scheduler Module - Task Executor
 *
 * Dispatches task actions to appropriate handlers based on action type.
 * Wraps the TaskScheduler's execution callbacks into a clean executor interface
 * that can be injected into the OuterHeartbeat tick cycle.
 *
 * Action dispatch mapping:
 *   - prompt       -> executePromptAction (triggers outer-brain LLM)
 *   - tool_call    -> executeToolCallAction (invokes named tool)
 *   - send_message -> executeSendMessageAction (pushes IM message)
 *
 * @module scheduler/executor
 */

import type {
  ScheduledTask,
  TaskAction,
  ExecutionLog,
  PromptAction,
  ToolCallAction,
  SendMessageAction,
} from '../openkuroneko/scheduled-tasks/scheduled-task-types.js';
import type { ExecutorCallbacks } from './types.js';

// -- Constants ----------------------------------------------------------------

/** Default execution timeout in milliseconds (2 minutes) */
const DEFAULT_EXECUTION_TIMEOUT_MS = 120_000;

/** Maximum retry attempts for a failed task execution */
const DEFAULT_MAX_RETRIES = 3;

// -- Types --------------------------------------------------------------------

/** Result of a single task execution attempt */
export interface ExecutionResult {
  /** Whether the execution succeeded */
  success: boolean;
  /** Result message or output */
  message: string;
  /** Duration in milliseconds */
  durationMs: number;
  /** Error details if failed */
  error?: string;
}

/** Executor configuration */
export interface TaskExecutorConfig {
  /** Callbacks for action dispatching */
  callbacks: ExecutorCallbacks;
  /** Execution timeout in milliseconds */
  timeoutMs?: number;
  /** Maximum retry attempts */
  maxRetries?: number;
  /** Enable verbose logging */
  verbose?: boolean;
}

// -- TaskExecutor -------------------------------------------------------------

/**
 * TaskExecutor - Dispatches task actions to registered callbacks.
 *
 * Supports retry with exponential backoff and per-action-type dispatching.
 */
export class TaskExecutor {
  private callbacks: ExecutorCallbacks;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly verbose: boolean;

  constructor(config: TaskExecutorConfig) {
    this.callbacks = config.callbacks;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.verbose = config.verbose ?? false;
  }

  /**
   * Execute a single task action.
   * Dispatches to the appropriate callback based on action type.
   *
   * @param action - The task action to execute
   * @param taskId - The task ID (for logging and callback context)
   * @returns Execution result message
   */
  async executeAction(action: TaskAction, taskId: string): Promise<string> {
    switch (action.type) {
      case 'prompt': {
        const promptAction = action as PromptAction;
        if (!this.callbacks.executePromptAction) {
          throw new Error(`[scheduler/executor] no executePromptAction callback registered`);
        }
        return this.callbacks.executePromptAction(taskId, promptAction.content);
      }

      case 'tool_call': {
        const toolCallAction = action as ToolCallAction;
        if (!this.callbacks.executeToolCallAction) {
          throw new Error(`[scheduler/executor] no executeToolCallAction callback registered`);
        }
        return this.callbacks.executeToolCallAction(
          taskId,
          toolCallAction.tool,
          toolCallAction.params ?? {},
        );
      }

      case 'send_message': {
        const sendMsgAction = action as SendMessageAction;
        if (!this.callbacks.executeSendMessageAction) {
          throw new Error(`[scheduler/executor] no executeSendMessageAction callback registered`);
        }
        return this.callbacks.executeSendMessageAction(
          taskId,
          sendMsgAction.channel ?? '',
          sendMsgAction.content,
        );
      }

      default: {
        const _exhaustive: never = action;
        throw new Error(`[scheduler/executor] unknown action type: ${(action as any).type}`);
      }
    }
  }

  /**
   * Execute a full task with timeout and retry logic.
   *
   * @param task - The task to execute
   * @returns Final execution result after retries
   */
  async executeTask(task: ScheduledTask): Promise<ExecutionResult> {
    const startTime = Date.now();

    try {
      // Check if agent is busy
      if (this.callbacks.isAgentBusy?.()) {
        return {
          success: false,
          message: 'Agent is busy, skipping execution',
          durationMs: Date.now() - startTime,
          error: 'agent_busy',
        };
      }

      const result = await this.withTimeout(
        this.executeAction(task.action, task.id),
        this.timeoutMs,
        `Task ${task.id} execution timed out after ${this.timeoutMs}ms`,
      );

      return {
        success: true,
        message: result,
        durationMs: Date.now() - startTime,
      };
    } catch (err: any) {
      return {
        success: false,
        message: err.message,
        durationMs: Date.now() - startTime,
        error: err.message,
      };
    }
  }

  /**
   * Execute a task with retry logic (exponential backoff).
   *
   * @param task - The task to execute
   * @returns Final execution result after retries
   */
  async executeWithRetry(task: ScheduledTask): Promise<ExecutionResult> {
    let lastResult: ExecutionResult | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      lastResult = await this.executeTask(task);

      if (lastResult.success) {
        return lastResult;
      }

      if (attempt < this.maxRetries) {
        if (this.verbose) {
          console.log(
            `[scheduler/executor] task ${task.id} retry ${attempt + 1}/${this.maxRetries}`,
          );
        }
        // Exponential backoff: 1s, 2s, 4s...
        const backoffMs = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    return lastResult!;
  }

  /**
   * Update callbacks (e.g., when executor context changes).
   */
  updateCallbacks(callbacks: Partial<ExecutorCallbacks>): void {
    Object.assign(this.callbacks, callbacks);
  }

  /**
   * Wrap a promise with a timeout.
   */
  private withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      promise.then(
        (result) => { clearTimeout(timer); resolve(result); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }
}