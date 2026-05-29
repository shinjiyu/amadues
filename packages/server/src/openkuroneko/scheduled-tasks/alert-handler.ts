/**
 * AlertHandler �?Scheduled Task Alert Handler.
 *
 * Produces alerts when task execution encounters anomalies:
 *   1. Task execution failure (single + consecutive)
 *   2. Task auto-suspension (consecutive failures reached threshold)
 *   3. Task execution timeout
 *   4. Missed task recovery (after system restart)
 *   5. Scheduler state anomalies
 *
 * Alert channels:
 *   - Console logging �?always enabled
 *   - IM message notification �?via ChatIRChannel interface
 *   - Agent memory �?write alert memory for Agent self-reflection
 *   - Custom callback �?injected by integration layer
 *
 * Alert levels:
 *   - info:     Normal event notification (task completed, resumed, etc.)
 *   - warning:  Events requiring attention (single failure, missed recovery)
 *   - error:    Serious events (consecutive failure suspension, timeout)
 *   - critical: System-level anomalies (scheduler init failure)
 *
 * @module scheduled-tasks/alert-handler
 */

import * as crypto from 'node:crypto';
import type { ScheduledTask, ExecutionLog } from './scheduled-task-types.js';

// ── Alert Level Type ────────────────────────────────────────────────────

/** Alert severity level */
export type AlertLevel = 'info' | 'warning' | 'error' | 'critical';

// ── Alert Notification Payload ────────────────────────────────────────────

/** Structured alert payload passed to notification channels */
export interface AlertNotification {
  /** Unique alert ID */
  readonly id: string;
  /** Alert timestamp (ISO 8601) */
  readonly timestamp: string;
  /** Alert severity level */
  readonly level: AlertLevel;
  /** Alert category */
  readonly category: AlertCategory;
  /** Human-readable alert title */
  readonly title: string;
  /** Detailed alert message */
  readonly message: string;
  /** Related task ID (if applicable) */
  readonly taskId?: string;
  /** Related task name (if applicable) */
  readonly taskName?: string;
  /** Related execution ID (if applicable) */
  readonly executionId?: string;
  /** Additional context data */
  readonly context?: Record<string, unknown>;
}

/** Alert category classification */
export type AlertCategory =
  | 'task_execution_failed'
  | 'task_consecutive_failure'
  | 'task_auto_suspended'
  | 'task_execution_timeout'
  | 'task_missed_recovery'
  | 'task_resumed'
  | 'scheduler_error'
  | 'scheduler_recovery'
  | 'heartbeat_integration';

// ── Alert Channel Interface ────────────────────────────────────────────

/** Interface for alert notification channels */
export interface AlertNotifier {
  /** Channel name for logging */
  readonly name: string;
  /** Send alert notification through this channel */
  notify(alert: AlertNotification): Promise<void>;
}

/** Configuration for IM alert notifier */
export interface ImAlertNotifierConfig {
  /** ChatIRChannel-compatible postMessage function */
  postMessage: (threadId: string, message: string) => Promise<void>;
  /** Target thread ID for alert messages */
  alertThreadId: string;
  /** Agent display name for messages */
  agentName?: string;
  /** Minimum alert level to send via IM (default: 'warning') */
  minLevel?: AlertLevel;
}

/** IM-based alert notifier �?sends alerts as IM messages */
export class ImAlertNotifier implements AlertNotifier {
  readonly name = 'im';

  private readonly minLevelNum: number;

  constructor(private readonly config: ImAlertNotifierConfig) {
    this.minLevelNum = levelToNumber(config.minLevel ?? 'warning');
  }

  async notify(alert: AlertNotification): Promise<void> {
    if (levelToNumber(alert.level) < this.minLevelNum) return;

    const prefix = alert.level === 'critical' ? '🚨'
      : alert.level === 'error' ? '�?
      : alert.level === 'warning' ? '⚠️'
      : 'ℹ️';

    const agentLabel = this.config.agentName ? `[${this.config.agentName}] ` : '';
    const text = `${prefix} ${agentLabel}${alert.title}\n${alert.message}`;

    try {
      await this.config.postMessage(this.config.alertThreadId, text);
      console.log(`[scheduled-tasks][alert][im] sent: ${alert.title}`);
    } catch (e) {
      console.error(
        `[scheduled-tasks][alert][im] failed to send: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/** Console-based alert notifier �?always active as baseline */
export class ConsoleAlertNotifier implements AlertNotifier {
  readonly name = 'console';

  async notify(alert: AlertNotification): Promise<void> {
    const tag = `[scheduled-tasks][alert][${alert.level}]`;
    const taskLabel = alert.taskName ? ` (${alert.taskName})` : '';
    console.log(`${tag} ${alert.title}${taskLabel}: ${alert.message}`);
  }
}

/** Callback-based alert notifier �?for custom integration */
export class CallbackAlertNotifier implements AlertNotifier {
  readonly name = 'callback';

  constructor(private readonly callback: (alert: AlertNotification) => void | Promise<void>) {}

  async notify(alert: AlertNotification): Promise<void> {
    await this.callback(alert);
  }
}

// ── Alert Handler Core ────────────────────────────────────────────────────

/** Alert handler configuration */
export interface AlertHandlerCoreConfig {
  /** Minimum alert level to process (default: 'info') */
  minLevel?: AlertLevel;
  /** Maximum alert history to keep in memory (default: 100) */
  maxHistory?: number;
  /** Notifiers to register */
  notifiers?: AlertNotifier[];
  /** Throttle interval in ms �?suppress duplicate alerts within this window (default: 60_000) */
  throttleMs?: number;
}

/** Alert handler �?manages alert dispatching to registered channels */
export class AlertHandlerCore {
  private readonly notifiers: AlertNotifier[] = [];
  private readonly minLevelNum: number;
  private readonly maxHistory: number;
  private readonly throttleMs: number;
  private alertHistory: AlertNotification[] = [];
  private readonly recentAlerts = new Map<string, number>(); // key �?timestamp

  constructor(config?: AlertHandlerCoreConfig) {
    this.minLevelNum = levelToNumber(config?.minLevel ?? 'info');
    this.maxHistory = config?.maxHistory ?? 100;
    this.throttleMs = config?.throttleMs ?? 60_000;

    // Always add console notifier as baseline
    this.notifiers.push(new ConsoleAlertNotifier());

    // Add custom notifiers
    for (const notifier of config?.notifiers ?? []) {
      this.notifiers.push(notifier);
    }
  }

  // ── Alert Dispatch ─────────────────────────────────────────────────

  /** Dispatch an alert to all registered channels */
  async dispatch(alert: Omit<AlertNotification, 'id' | 'timestamp'>): Promise<void> {
    if (levelToNumber(alert.level) < this.minLevelNum) return;

    // Throttle check: suppress duplicate alerts within throttle window
    const throttleKey = `${alert.category}:${alert.taskId ?? ''}:${alert.level}`;
    const now = Date.now();
    const lastTime = this.recentAlerts.get(throttleKey);
    if (lastTime && (now - lastTime) < this.throttleMs) {
      return; // suppressed
    }
    this.recentAlerts.set(throttleKey, now);

    const fullAlert: AlertNotification = {
      ...alert,
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    };

    // Store in history
    this.alertHistory.push(fullAlert);
    if (this.alertHistory.length > this.maxHistory) {
      this.alertHistory = this.alertHistory.slice(-this.maxHistory);
    }

    // Clean up old throttle entries periodically
    if (this.recentAlerts.size > 1000) {
      const cutoff = now - this.throttleMs * 2;
      this.recentAlerts.forEach((ts, key) => {
        if (ts < cutoff) this.recentAlerts.delete(key);
      });
    }

    // Dispatch to all notifiers (parallel, fire-and-forget)
    await Promise.allSettled(
      this.notifiers.map(async (notifier) => {
        try {
          await notifier.notify(fullAlert);
        } catch (e) {
          console.error(
            `[scheduled-tasks][alert] notifier "${notifier.name}" failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }),
    );
  }

  // ── Convenience Methods for Common Alert Scenarios ──────────────────

  /** Alert: single task execution failure */
  async notifyTaskFailed(
    task: ScheduledTask,
    log: ExecutionLog,
    consecutiveCount: number,
  ): Promise<void> {
    await this.dispatch({
      level: 'warning',
      category: 'task_execution_failed',
      title: `Task "${task.name}" execution failed`,
      message: `Task "${task.name}" (ID: ${task.id}) failed with error: ${log.error ?? 'unknown'}. Consecutive failures: ${consecutiveCount}.`,
      taskId: task.id,
      taskName: task.name,
      executionId: log.executionId,
      context: { error: log.error, consecutiveFailures: consecutiveCount },
    });
  }

  /** Alert: task auto-suspended due to consecutive failures */
  async notifyTaskSuspended(task: ScheduledTask): Promise<void> {
    await this.dispatch({
      level: 'error',
      category: 'task_auto_suspended',
      title: `Task "${task.name}" auto-suspended`,
      message: "Task \"" + task.name + "\" (ID: " + task.id + ") has been automatically suspended after " + (task.executionConfig.maxConsecutiveFailures ?? 3) + " consecutive failures (" + task.consecutiveFailures + " recorded). Manual intervention required to resume.",
      taskId: task.id,
      taskName: task.name,
      context: {
        consecutiveFailures: task.consecutiveFailures,
        maxConsecutiveFailures: task.executionConfig.maxConsecutiveFailures,
        lastError: undefined,
      },
    });
  }

  /** Alert: task execution timeout */
  async notifyTaskTimeout(
    task: ScheduledTask,
    log: ExecutionLog,
  ): Promise<void> {
    await this.dispatch({
      level: 'error',
      category: 'task_execution_timeout',
      title: `Task "${task.name}" execution timed out`,
      message: `Task "${task.name}" (ID: ${task.id}) timed out after ${task.executionConfig.timeoutMs ?? 120_000}ms. Execution ID: ${log.executionId}.`,
      taskId: task.id,
      taskName: task.name,
      executionId: log.executionId,
      context: { timeoutMs: task.executionConfig.timeoutMs },
    });
  }

  /** Alert: missed task recovered after restart */
  async notifyMissedTaskRecovery(
    task: ScheduledTask,
    missedCount: number,
  ): Promise<void> {
    await this.dispatch({
      level: 'warning',
      category: 'task_missed_recovery',
      title: `Missed task "${task.name}" recovered`,
      message: `Task "${task.name}" (ID: ${task.id}) had ${missedCount} missed execution(s) during downtime. Task has been queued for immediate execution.`,
      taskId: task.id,
      taskName: task.name,
      context: { missedCount },
    });
  }

  /** Alert: task resumed (manually or automatically) */
  async notifyTaskResumed(task: ScheduledTask): Promise<void> {
    await this.dispatch({
      level: 'info',
      category: 'task_resumed',
      title: `Task "${task.name}" resumed`,
      message: `Task "${task.name}" (ID: ${task.id}) has been resumed and will execute on next schedule.`,
      taskId: task.id,
      taskName: task.name,
    });
  }

  /** Alert: scheduler error */
  async notifySchedulerError(error: Error): Promise<void> {
    await this.dispatch({
      level: 'critical',
      category: 'scheduler_error',
      title: 'Scheduler error',
      message: `Scheduled task scheduler encountered an error: ${error.message}`,
      context: { errorStack: error.stack },
    });
  }

  /** Alert: heartbeat integration event */
  async notifyHeartbeatIntegration(
    event: string,
    details?: string,
  ): Promise<void> {
    await this.dispatch({
      level: 'info',
      category: 'heartbeat_integration',
      title: `Heartbeat integration: ${event}`,
      message: details ?? event,
    });
  }

  // ── Query Methods ─────────────────────────────────────────────────

  /** Get recent alert history */
  getAlertHistory(limit = 20): AlertNotification[] {
    return this.alertHistory.slice(-limit);
  }

  /** Get alerts filtered by level */
  getAlertsByLevel(level: AlertLevel, limit = 20): AlertNotification[] {
    return this.alertHistory
      .filter((a) => a.level === level)
      .slice(-limit);
  }

  /** Get alerts filtered by task ID */
  getAlertsByTaskId(taskId: string, limit = 20): AlertNotification[] {
    return this.alertHistory
      .filter((a) => a.taskId === taskId)
      .slice(-limit);
  }

  /** Clear alert history */
  clearHistory(): void {
    this.alertHistory = [];
  }
}

// ── Helper ──────────────────────────────────────────────────────────────

function levelToNumber(level: AlertLevel): number {
  switch (level) {
    case 'info': return 0;
    case 'warning': return 1;
    case 'error': return 2;
    case 'critical': return 3;
  }
}
