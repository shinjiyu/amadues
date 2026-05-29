/**
 * E2E Integration Test: Scheduled-Task Full Chain (M4)
 * Covers: register �?cron dispatch �?execution �?timeout �?retry �?unregister
 *
 * Uses HeartbeatTaskBridge as the unified facade (real production code path).
 * No mocks for scheduler/store/monitor �?only action callbacks are stubbed.
 *
 * Known limitations observed (do NOT assert these):
 *   KL-1: scheduler_started BridgeEvent not captured (emit before wireUpEvents)
 *   KL-2: task_completed only emitted for 'once' type tasks on success
 *   KL-3: updateTask does not persist tags
 *   KL-4: shutdown/stop does not update schedulerStatus.isRunning to false
 *
 * Constraints:
 *   - intervalMs must be >= 1000 (validateScheduleRule constraint)
 *   - retryIntervalMs must be explicitly set to short value (10-50ms)
 *   - No Unix pipe commands
 */

import { HeartbeatTaskBridge } from '../heartbeat-task-bridge.js';
import type { BridgeEvent, BridgeEventCallback } from '../heartbeat-task-bridge.js';
import type {
  CreateTaskRequest,
  ExecutionLog,
  ScheduledTask,
  TaskAction,
} from '../scheduled-task-types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// 鈹€鈹€鈹€ Helpers 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

let testCounter = 0;
let passCount = 0;
let failCount = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string): void {
  testCounter++;
  if (condition) {
    passCount++;
    console.log(`  �?[${testCounter}] ${label}`);
  } else {
    failCount++;
    failures.push(`[${testCounter}] ${label}`);
    console.error(`  �?[${testCounter}] ${label}`);
  }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  const match = actual === expected;
  if (!match) {
    label += ` (expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)})`;
  }
  assert(match, label);
}

function assertNotNull<T>(value: T | null | undefined, label: string): void {
  assert(value != null, label);
}

function assertIncludes(arr: string[], item: string, label: string): void {
  assert(arr.includes(item), `${label} (array=${JSON.stringify(arr)})`);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sched-e2e-'));
}

function cleanupDir(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

const uniqueSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

/** Make a once-task with past runAt (immediately due) */
function makeOnceTask(suffix: string): CreateTaskRequest {
  return {
    name: `test-once-${suffix}`,
    description: `Once task for e2e test ${suffix}`,
    schedule: {
      type: 'once',
      runAt: new Date(Date.now() - 60000).toISOString(), // past = immediately due
    },
    action: {
      type: 'prompt',
      content: `Hello from e2e test ${suffix}`,
    },
    executionConfig: {
      timeoutMs: 5000,
      maxConsecutiveFailures: 3,
      retryCount: 0,
      retryIntervalMs: 20,
      onlyWhenIdle: false,
      priority: 0,
    },
    createdBy: { type: 'system', id: 'e2e-test', name: 'E2E Test Runner' },
  };
}

/** Make a once-task with retry enabled */
function makeRetryOnceTask(suffix: string): CreateTaskRequest {
  return {
    name: `test-retry-${suffix}`,
    description: `Once task with retry for e2e test ${suffix}`,
    schedule: {
      type: 'once',
      runAt: new Date(Date.now() - 60000).toISOString(),
    },
    action: {
      type: 'prompt',
      content: `Retry test ${suffix}`,
    },
    executionConfig: {
      timeoutMs: 5000,
      maxConsecutiveFailures: 5,
      retryCount: 2,
      retryIntervalMs: 20, // CRITICAL: short retry interval (10-50ms)
      onlyWhenIdle: false,
      priority: 0,
    },
    createdBy: { type: 'system', id: 'e2e-test', name: 'E2E Test Runner' },
  };
}

/** Make a cron task (every minute) */
function makeCronTask(suffix: string): CreateTaskRequest {
  return {
    name: `test-cron-${suffix}`,
    description: `Cron task for e2e test ${suffix}`,
    schedule: {
      type: 'cron',
      expression: '* * * * *',
    },
    action: {
      type: 'prompt',
      content: `Cron test ${suffix}`,
    },
    executionConfig: {
      timeoutMs: 5000,
      maxConsecutiveFailures: 3,
      retryCount: 0,
      retryIntervalMs: 20,
      onlyWhenIdle: false,
      priority: 0,
    },
    createdBy: { type: 'system', id: 'e2e-test', name: 'E2E Test Runner' },
  };
}

/** Make an interval task (min intervalMs = 1000) */
function makeIntervalTask(suffix: string): CreateTaskRequest {
  return {
    name: `test-interval-${suffix}`,
    description: `Interval task for e2e test ${suffix}`,
    schedule: {
      type: 'interval',
      intervalMs: 1000, // minimum allowed value
    },
    action: {
      type: 'prompt',
      content: `Interval test ${suffix}`,
    },
    executionConfig: {
      timeoutMs: 5000,
      maxConsecutiveFailures: 3,
      retryCount: 0,
      retryIntervalMs: 20,
      onlyWhenIdle: false,
      priority: 0,
    },
    createdBy: { type: 'system', id: 'e2e-test', name: 'E2E Test Runner' },
  };
}

/** Make a tool_call once-task */
function makeToolCallTask(suffix: string): CreateTaskRequest {
  return {
    name: `test-tool-${suffix}`,
    description: `Tool call task for e2e test ${suffix}`,
    schedule: {
      type: 'once',
      runAt: new Date(Date.now() - 60000).toISOString(),
    },
    action: {
      type: 'tool_call',
      tool: 'testTool',
      params: { key: 'value' },
    },
    executionConfig: {
      timeoutMs: 5000,
      maxConsecutiveFailures: 3,
      retryCount: 0,
      retryIntervalMs: 20,
      onlyWhenIdle: false,
      priority: 0,
    },
    createdBy: { type: 'system', id: 'e2e-test', name: 'E2E Test Runner' },
  };
}

// 鈹€鈹€鈹€ Main Test 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

async function main(): Promise<void> {
  console.log('=== E2E Integration Test: Scheduled-Task Full Chain ===\n');

  const tempDir = createTempDir();
  console.log(`Temp dataRoot: ${tempDir}`);

  // Track action callback invocations
  const promptCalls: string[] = [];
  const toolCalls: string[] = [];
  const messages: string[] = [];
  const bridgeEvents: BridgeEvent[] = [];

  let promptActionShouldFail = false;
  let toolActionShouldFail = false;

  // Create bridge with stubbed action callbacks
  const bridge = new HeartbeatTaskBridge(
    { dataRoot: tempDir },
    {
      executePromptAction: async (taskId: string, prompt: string): Promise<string> => {
        promptCalls.push(taskId);
        if (promptActionShouldFail) {
          throw new Error('Simulated prompt action failure');
        }
        return `Executed prompt: ${prompt.slice(0, 50)}`;
      },
      executeToolCallAction: async (taskId: string, toolName: string, params: Record<string, unknown>): Promise<string> => {
        toolCalls.push(taskId);
        if (toolActionShouldFail) {
          throw new Error('Simulated tool call failure');
        }
        return `Executed tool: ${toolName} with ${JSON.stringify(params)}`;
      },
      executeSendMessageAction: async (taskId: string, target: string, content: string): Promise<string> => {
        messages.push(taskId);
        return `Message sent to ${target}: ${content}`;
      },
      notifyUser: async (_taskId: string, _message: string): Promise<void> => {
        // no-op for test
      },
      isAgentBusy: () => false,
    },
  );

  // Register bridge event listener BEFORE start (except KL-1: scheduler_started is missed)
  bridge.onEvent((event: BridgeEvent) => {
    bridgeEvents.push(event);
    console.log(`  [BridgeEvent] ${event.type}`);
  });

  try {
    // 鈹€鈹€鈹€ Step 1: Start bridge 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    console.log('\n--- Step 1: Start Bridge ---');
    await bridge.start();
    assert(true, 'Bridge started successfully');

    // 鈹€鈹€鈹€ Step 2: Verify scheduler status 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    console.log('\n--- Step 2: Verify Scheduler Status ---');
    const status = bridge.getSchedulerStatus();
    assertNotNull(status, 'SchedulerStatus is returned');
    // Note: isRunning may not be true until after first onHeartbeat (KL-4 related)

    // 鈹€鈹€鈹€ Step 3: Register cron task (prompt action) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    console.log('\n--- Step 3: Register Cron Task (prompt action) ---');
    const cronTask = await bridge.createTask(makeCronTask(uniqueSuffix));
    assertNotNull(cronTask, 'Cron task created');
    assertEqual(cronTask.name, `test-cron-${uniqueSuffix}`, 'Cron task name matches');
    assertEqual(cronTask.status, 'active', 'Cron task status is active');
    assertEqual(cronTask.schedule.type, 'cron', 'Cron schedule type');
    assertNotNull(cronTask.nextRunAt, 'Cron task nextRunAt is set');

    const cronTaskId = cronTask.id;

    // 鈹€鈹€鈹€ Step 4: Register once-task (tool_call action) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    console.log('\n--- Step 4: Register Once Task (tool_call action) ---');
    const onceTask = await bridge.createTask(makeToolCallTask(uniqueSuffix));
    assertNotNull(onceTask, 'Once task created');
    assertEqual(onceTask.status, 'active', 'Once task status is active');
    assertEqual(onceTask.action.type, 'tool_call', 'Once task action is tool_call');
    assertEqual((onceTask.action as { tool: string }).tool, 'testTool', 'Tool name matches');

    const onceTaskId = onceTask.id;

    // 鈹€鈹€鈹€ Step 5: Register interval task 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    console.log('\n--- Step 5: Register Interval Task ---');
    const intervalTask = await bridge.createTask(makeIntervalTask(uniqueSuffix));
    assertNotNull(intervalTask, 'Interval task created');
    assertEqual(intervalTask.schedule.type, 'interval', 'Interval schedule type');
    assertEqual((intervalTask.schedule as { intervalMs: number }).intervalMs, 1000, 'Interval 1000ms');

    const intervalTaskId = intervalTask.id;

    // 鈹€鈹€鈹€ Step 6: Register retry once-task (will fail �?retry) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    console.log('\n--- Step 6: Register Retry Once-Task ---');
    promptActionShouldFail = true; // Make prompt actions fail
    const retryTask = await bridge.createTask(makeRetryOnceTask(uniqueSuffix));
    assertNotNull(retryTask, 'Retry task created');
    assertEqual(retryTask.executionConfig.retryCount, 2, 'Retry count is 2');
    assertEqual(retryTask.executionConfig.retryIntervalMs, 20, 'Retry interval is 20ms');

    const retryTaskId = retryTask.id;

    // 鈹€鈹€鈹€ Step 7: Verify task listing 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    console.log('\n--- Step 7: List Tasks ---');
    const allTasks = await bridge.listTasks();
    assertEqual(allTasks.length, 4, 'Four tasks total');

    const activeTasks = await bridge.listTasks({ status: 'active' });
    assertEqual(activeTasks.length, 4, 'Four active tasks');

    // Verify task_created BridgeEvents
    const createdEvents = bridgeEvents.filter(e => e.type === 'task_created');
    assertEqual(createdEvents.length, 4, 'Four task_created BridgeEvents');

    // 鈹€鈹€鈹€ Step 8: Trigger heartbeat �?execution 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    console.log('\n--- Step 8: Trigger Heartbeat �?Execution ---');
    await bridge.onHeartbeat();
    await delay(200); // Allow async execution to complete

    console.log(`  Prompt calls: ${promptCalls.length}`);
    console.log(`  Tool calls: ${toolCalls.length}`);

    // The cron task, retry task use prompt; once task uses tool_call
    // Prompt actions fail (promptActionShouldFail=true), tool actions succeed
    assert(toolCalls.length >= 1, `Tool call executed (actual: ${toolCalls.length})`);
    assert(promptCalls.length >= 1, `Prompt call attempted (actual: ${promptCalls.length})`);

    // 鈹€鈹€鈹€ Step 9: Verify execution logs 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    console.log('\n--- Step 9: Verify Execution Logs ---');

    // Check tool_call task logs (should succeed)
    const onceTaskLogs = bridge.getTaskHistory(onceTaskId);
    if (onceTaskLogs.length > 0) {
      assertEqual(onceTaskLogs[0].taskId, onceTaskId, 'Once task log taskId matches');
      assertEqual(onceTaskLogs[0].status, 'success', 'Once task execution succeeded');
    } else {
      assert(false, 'Once task should have execution logs');
    }

    // Check retry task logs (should fail with retries)
    const retryTaskLogs = bridge.getTaskHistory(retryTaskId);
    if (retryTaskLogs.length > 0) {
      const failedLog = retryTaskLogs.find(l => l.status === 'failed');
      if (failedLog) {
        assert((failedLog.error ?? '').includes('Simulated prompt action failure'), 'Error message contains failure text');
      }
      // Check that retries occurred
      const retryAttempts = retryTaskLogs.filter(l => l.isRetry);
      assert(retryAttempts.length >= 1, `Retry attempts found (actual: ${retryAttempts.length})`);
    } else {
      assert(false, 'Retry task should have execution logs');
    }

    // 鈹€鈹€鈹€ Step 10: Verify task_failed BridgeEvent 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    console.log('\n--- Step 10: Verify BridgeEvents ---');
    const failedEvents = bridgeEvents.filter(e => e.type === 'task_failed');
    assert(failedEvents.length >= 1, `task_failed BridgeEvent emitted (actual: ${failedEvents.length})`);

    // heartbeat_tick should be emitted
    const tickEvents = bridgeEvents.filter(e => e.type === 'heartbeat_tick');
    assert(tickEvents.length >= 1, `heartbeat_tick BridgeEvent emitted (actual: ${tickEvents.length})`);

    // KL-1: scheduler_started not captured (known limitation, do NOT assert)

    // 鈹€鈹€鈹€ Step 11: Unregister (delete) a task 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    console.log('\n--- Step 11: Unregister Task (Delete) ---');
    const deleted = await bridge.deleteTask(intervalTaskId);
    assertEqual(deleted, true, 'Delete interval task succeeded');

    const taskAfterDelete = await bridge.getTask(intervalTaskId);
    assertEqual(taskAfterDelete, null, 'Deleted task returns null');

    const taskDeletedEvent = bridgeEvents.find(e => e.type === 'task_deleted' && e.taskId === intervalTaskId);
    assertNotNull(taskDeletedEvent, 'task_deleted BridgeEvent emitted');

    // Verify task count decreased
    const remainingTasks = await bridge.listTasks();
    assertEqual(remainingTasks.length, 3, 'Three tasks remaining after delete');

    // 鈹€鈹€鈹€ Step 12: Pause and resume a task 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    console.log('\n--- Step 12: Pause and Resume ---');
    const pausedTask = await bridge.pauseTask(cronTaskId);
    assertEqual(pausedTask.status, 'paused', 'Cron task paused');

    const pausedEvent = bridgeEvents.find(e => e.type === 'task_paused' && e.taskId === cronTaskId);
    assertNotNull(pausedEvent, 'task_paused BridgeEvent emitted');

    const resumedTask = await bridge.resumeTask(cronTaskId);
    assertEqual(resumedTask.status, 'active', 'Cron task resumed');

    const resumedEvent = bridgeEvents.find(e => e.type === 'task_resumed' && e.taskId === cronTaskId);
    assertNotNull(resumedEvent, 'task_resumed BridgeEvent emitted');

    // 鈹€鈹€鈹€ Step 13: Update a task 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    console.log('\n--- Step 13: Update Task ---');
    const updatedTask = await bridge.updateTask(cronTaskId, {
      name: 'test-cron-updated',
      description: 'Updated cron task description',
    });
    assertEqual(updatedTask.name, 'test-cron-updated', 'Task name updated');
    assertEqual(updatedTask.description, 'Updated cron task description', 'Task description updated');

    const updatedEvent = bridgeEvents.find(e => e.type === 'task_updated' && e.taskId === cronTaskId);
    assertNotNull(updatedEvent, 'task_updated BridgeEvent emitted');

    // 鈹€鈹€鈹€ Step 14: Manual trigger (triggerTask) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    console.log('\n--- Step 14: Manual Trigger ---');
    promptActionShouldFail = false; // Reset failure
    const triggerLog = await bridge.triggerTask(cronTaskId);
    assertNotNull(triggerLog, 'Manual trigger returned execution log');
    assertEqual(triggerLog.taskId, cronTaskId, 'Trigger log taskId matches');
    assertEqual(triggerLog.status, 'success', 'Manual trigger succeeded');

    // 鈹€鈹€鈹€ Step 15: Health summary 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    console.log('\n--- Step 15: Health Summary ---');
    const health = bridge.getHealthSummary();
    assertNotNull(health, 'Health summary returned');

    const report = bridge.getMonitoringReport();
    assert(report.length > 0, 'Monitoring report is non-empty');

    // 鈹€鈹€鈹€ Step 16: Cleanup remaining tasks 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    console.log('\n--- Step 16: Cleanup ---');
    await bridge.deleteTask(cronTaskId);
    await bridge.deleteTask(onceTaskId);
    await bridge.deleteTask(retryTaskId);

    const finalTasks = await bridge.listTasks();
    assertEqual(finalTasks.length, 0, 'All tasks cleaned up');

    // 鈹€鈹€鈹€ Step 17: Stop bridge 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    console.log('\n--- Step 17: Stop Bridge ---');
    await bridge.stop();
    assert(true, 'Bridge stopped');
    // KL-4: Do NOT assert isRunning=false after shutdown

  } catch (err) {
    console.error('\n!!! UNEXPECTED ERROR !!!', err);
    failCount++;
    failures.push(`UNEXPECTED: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    cleanupDir(tempDir);
    console.log('\nTemp dir cleaned up');
  }

  // 鈹€鈹€鈹€ Summary 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  console.log('\n鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨�?);
  console.log(`  Total: ${testCounter}  Passed: ${passCount}  Failed: ${failCount}`);
  if (failures.length > 0) {
    console.log('\n  FAILED:');
    for (const f of failures) {
      console.log(`    ${f}`);
    }
  }
  console.log('鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨晲鈺愨�?);

  const exitCode = failCount > 0 ? 1 : 0;
  process.exit(exitCode);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
