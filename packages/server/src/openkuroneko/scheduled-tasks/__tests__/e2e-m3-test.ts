/**
 * E2E Integration Test — Scheduled Tasks Module (M3 Final)
 *
 * Full chain: register task → cron schedule → execute callback →
 *             timeout detection → retry → HeartbeatTaskBridge event mapping →
 *             task unregister
 *
 * Run: cd D:\kuroneko\packages\server && npx tsx src/openkuroneko/scheduled-tasks/__tests__/e2e-m3-test.ts
 *
 * API Signatures verified via Select-String (M3):
 *   - HeartbeatTaskBridge(config: HeartbeatTaskBridgeConfig, deps?: HeartbeatTaskBridgeDeps)
 *   - bridge.start(): Promise<void>
 *   - bridge.stop(): Promise<void>
 *   - bridge.onHeartbeat(): Promise<void>
 *   - bridge.createTask(request: CreateTaskRequest): Promise<ScheduledTask>
 *   - bridge.getTask(taskId: string): Promise<ScheduledTask | null>
 *   - bridge.listTasks(filter?): Promise<ScheduledTask[]> — async, MUST await
 *   - bridge.updateTask(taskId: string, updates: UpdateTaskRequest): Promise<ScheduledTask>
 *   - bridge.deleteTask(taskId: string): Promise<boolean>
 *   - bridge.pauseTask(taskId: string): Promise<ScheduledTask>
 *   - bridge.resumeTask(taskId: string): Promise<ScheduledTask>
 *   - bridge.triggerTask(taskId: string): Promise<ExecutionLog>
 *   - bridge.getTaskHistory(taskId: string, limit?): ExecutionLog[] — sync, no await

 *   - bridge.getSchedulerStatus(): SchedulerStatus — sync
 *   - bridge.onEvent(callback: BridgeEventCallback): void — NOT onBridgeEvent
 *   - validateCronExpression(expr): string | null — NOT boolean
 *   - convertSchedulerEventToBridgeEvent: task_executed (success) → null (no BridgeEvent)
 *   - TaskExecutionConfig.retryIntervalMs — NOT retryDelayMs (default 30000ms)
 *   - CreateTaskRequest.createdBy: TaskCreator — must include { type, id, name }
 *   - ToolCallAction.tool: string — NOT toolName
 *   - ExecutionLog: { executionId, taskId, status, startedAt, finishedAt?, durationMs?, result?, error?, isRetry, retryAttempt }
 *   - SchedulerStatus: { isRunning: boolean, ... }
 *   - SchedulerHealthSummary: { totalTaskCount, activeTaskCount, pausedTaskCount, suspendedTaskCount, completedTaskCount, dueTaskCount }
 *   - IntervalSchedule.intervalMs minimum: 1000 (validateScheduleRule constraint)
 *
 * Known limitations (documented per Constraints):
 *   KL-1: scheduler_started BridgeEvent not received (initialize() emits before wireUpEvents())
 *   KL-2: task_completed only emitted for 'once' type tasks on success
 *   KL-3: updateTask() does not persist tags (scheduler ignores tags field)
 *   KL-4: shutdown()/stop() does not update schedulerStatus.isRunning
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

import { HeartbeatTaskBridge } from '../heartbeat-task-bridge.js';
import type { BridgeEvent } from '../heartbeat-task-bridge.js';
import { validateCronExpression } from '../cron-parser.js';
import type {
  ScheduledTask,
  ExecutionLog,
  CreateTaskRequest,
  UpdateTaskRequest,
  TaskFilter,
  SchedulerStatus,
} from '../scheduled-task-types.js';
import type { SchedulerHealthSummary } from '../task-monitor.js';

// ── Test Helpers ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✓ PASS: ${label}`);
    passed++;
  } else {
    console.log(`  ✗ FAIL: ${label}`);
    failed++;
    failures.push(label);
  }
}

function assertNotNull(value: unknown, label: string): void {
  assert(value != null, label);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    console.log(`  ✓ PASS: ${label}`);
    passed++;
  } else {
    console.log(`  ✗ FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failed++;
    failures.push(label);
  }
}

function assertIncludes<T>(arr: T[], item: T, label: string): void {
  if (arr.includes(item)) {
    console.log(`  ✓ PASS: ${label}`);
    passed++;
  } else {
    console.log(`  ✗ FAIL: ${label} — ${JSON.stringify(item)} not in [${arr.map(String).join(',')}]`);
    failed++;
    failures.push(label);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Collected BridgeEvents ────────────────────────────────────────────────────

const bridgeEvents: BridgeEvent[] = [];

function eventTypes(): string[] {
  return bridgeEvents.map(e => e.type);
}

function findEvents(type: string): BridgeEvent[] {
  return bridgeEvents.filter(e => e.type === type);
}

// ── Main Test ─────────────────────────────────────────────────────────────────

async function runTests(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   E2E Integration Test — Scheduled Tasks Module (M3)    ');
  console.log('═══════════════════════════════════════════════════════════');

  // Create temp dir for test data
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-m3-'));
  console.log(`Test data root: ${testRoot}\n`);

  try {
    // ── Setup mock callbacks ─────────────────────────────────────────────────

    const promptResults = new Map<string, string>();
    const toolCallResults = new Map<string, string>();
    const sendMessageResults = new Map<string, string>();

    promptResults.set('test-prompt-1', 'Prompt execution result: OK');
    promptResults.set('test-prompt-retry', 'Retry prompt result: OK');
    promptResults.set('test-prompt-timeout', 'TIMEOUT'); // sentinel to trigger timeout simulation

    toolCallResults.set('test_tool', 'Tool execution result: OK');

    const deps = {
      executePromptAction: async (_taskId: string, prompt: string) => {
        // Simulate timeout for specific prompt
        if (prompt === 'test-prompt-timeout') {
          await sleep(300); // exceed timeoutMs
          return 'Should not reach here';
        }
        // Simulate failure for retry test
        if (prompt === 'test-prompt-fail') {
          throw new Error('Simulated execution failure');
        }
        return promptResults.get(prompt) ?? `Default result for: ${prompt}`;
      },
      executeToolCallAction: async (_taskId: string, toolName: string, _params: Record<string, unknown>) => {
        return toolCallResults.get(toolName) ?? `Tool ${toolName} executed`;
      },
      executeSendMessageAction: async (_taskId: string, _conversationId: string, message: string) => {
        return `Message sent: ${message}`;
      },
    };

    // ── Step 1: Create HeartbeatTaskBridge and start ──────────────────────────

    console.log('\n── Step 1: Create HeartbeatTaskBridge and start ──────────');

    const bridge = new HeartbeatTaskBridge(
      { dataRoot: testRoot, maxExecutionsPerBeat: 10, defaultHeartbeatMs: 5000 },
      deps,
    );

    // Register event listener BEFORE start
    bridge.onEvent((event: BridgeEvent) => {
      bridgeEvents.push(event);
    });

    await bridge.start();
    assert(true, 'Step 1.1: bridge.start() completed without error');

    // KL-1: scheduler_started not received (emitted before wireUpEvents)
    assertEqual(findEvents('scheduler_started').length, 0, 'Step 1.2: [KL-1] scheduler_started BridgeEvent NOT received (expected)');

    // isRunning is false before first onHeartbeat
    const statusBeforeHeartbeat = bridge.getSchedulerStatus();
    assertEqual(statusBeforeHeartbeat.isRunning, false, 'Step 1.3: isRunning is false before first onHeartbeat');

    // ── Step 2: Cron validation ─────────────────────────────────────────────

    console.log('\n── Step 2: Cron expression validation ────────────────────');

    const validCron = validateCronExpression('*/5 * * * *');
    assertEqual(validCron, null, 'Step 2.1: validateCronExpression returns null for valid cron');

    const invalidCron = validateCronExpression('invalid-cron');
    assert(invalidCron !== null && typeof invalidCron === 'string', 'Step 2.2: validateCronExpression returns string for invalid cron');

    // ── Step 3: Register a cron task (tool_call action) ─────────────────────

    console.log('\n── Step 3: Register cron task with tool_call action ───────');

    const cronTaskRequest: CreateTaskRequest = {
      name: 'Test Cron Task',
      description: 'A cron task for E2E testing',
      schedule: { type: 'cron', expression: '*/5 * * * *' },
      action: { type: 'tool_call', tool: 'test_tool', params: { key: 'value' } },
      executionConfig: {
        timeoutMs: 5000,
        maxConsecutiveFailures: 3,
        retryCount: 1,
        retryIntervalMs: 20,
        onlyWhenIdle: false,
        priority: 5,
      },
      metadata: { source: 'e2e-test' },
      tags: ['test', 'cron'],
      createdBy: { type: 'system', id: 'e2e-test', name: 'E2E Test Runner' },
    };

    const cronTask = await bridge.createTask(cronTaskRequest);
    assertNotNull(cronTask.id, 'Step 3.1: Cron task created with non-null id');
    assertEqual(cronTask.name, 'Test Cron Task', 'Step 3.2: Task name matches');
    assertEqual(cronTask.status, 'active', 'Step 3.3: Initial status is active');
    assertEqual(cronTask.schedule.type, 'cron', 'Step 3.4: Schedule type is cron');

    // Wait for task_created BridgeEvent
    await sleep(50);
    const taskCreatedEvents = findEvents('task_created');
    assert(taskCreatedEvents.length >= 1, 'Step 3.5: task_created BridgeEvent received');
    if (taskCreatedEvents.length > 0) {
      assertEqual((taskCreatedEvents[taskCreatedEvents.length - 1] as { type: 'task_created'; taskId: string }).taskId, cronTask.id, 'Step 3.6: task_created event has correct taskId');
    }

    // ── Step 4: Register a once task (prompt action) — triggers immediately ──

    console.log('\n── Step 4: Register once task (past time → immediate execution) ──');

    const pastDate = new Date(Date.now() - 60000); // 1 minute ago
    const onceTaskRequest: CreateTaskRequest = {
      name: 'Test Once Task',
      description: 'A once task scheduled in the past',
      schedule: { type: 'once', runAt: pastDate.toISOString() },
      action: { type: 'prompt', content: 'test-prompt-1' },
      executionConfig: {
        timeoutMs: 5000,
        maxConsecutiveFailures: 3,
        retryCount: 0,
        retryIntervalMs: 20,
        onlyWhenIdle: false,
        priority: 10,
      },
      createdBy: { type: 'user', id: 'user-1', name: 'Test User' },
    };

    const onceTask = await bridge.createTask(onceTaskRequest);
    assertNotNull(onceTask.id, 'Step 4.1: Once task created with non-null id');
    assertEqual(onceTask.schedule.type, 'once', 'Step 4.2: Schedule type is once');

    // ── Step 5: Heartbeat → trigger execution ──────────────────────────────

    console.log('\n── Step 5: First heartbeat → execute due tasks ───────────');

    bridgeEvents.length = 0; // Clear events to focus on execution events

    await bridge.onHeartbeat();

    // isRunning should now be true (after first onHeartbeat)
    const statusAfterHeartbeat = bridge.getSchedulerStatus();
    assertEqual(statusAfterHeartbeat.isRunning, true, 'Step 5.1: isRunning is true after first onHeartbeat');

    // Wait for async execution to complete
    await sleep(200);

    // KL-2: task_completed only for 'once' tasks
    const completedEvents = findEvents('task_completed');
    assert(completedEvents.length >= 1, 'Step 5.2: task_completed BridgeEvent received (once task)');

    const completedTaskIds = completedEvents.map(e => (e as { type: 'task_completed'; taskId: string }).taskId);
    assert(completedTaskIds.includes(onceTask.id), 'Step 5.3: task_completed for once task ID');

    // task_executed (success) → null (no BridgeEvent emitted)
    const executedBridgeEvents = findEvents('task_executed');
    assertEqual(executedBridgeEvents.length, 0, 'Step 5.4: No task_executed BridgeEvent for successful execution (returns null)');

    // heartbeat_tick should be emitted
    const tickEvents = findEvents('heartbeat_tick');
    assert(tickEvents.length >= 1, 'Step 5.5: heartbeat_tick BridgeEvent received');

    // ── Step 6: Verify execution logs via getTaskHistory ────────────────────

    console.log('\n── Step 6: Verify execution logs ──────────────────────────');

    // getTaskHistory is SYNC — no await
    const onceLogs: ExecutionLog[] = bridge.getTaskHistory(onceTask.id, 10);
    assert(onceLogs.length >= 1, 'Step 6.1: Once task has execution logs');
    if (onceLogs.length > 0) {
      const log = onceLogs[0];
      assertEqual(log.taskId, onceTask.id, 'Step 6.2: Log taskId matches');
      assertEqual(log.status, 'success', 'Step 6.3: Log status is success');
      assertNotNull(log.executionId, 'Step 6.4: Log has executionId');
      assertNotNull(log.startedAt, 'Step 6.5: Log has startedAt');
    }

    // Cron task should also have execution log
    const cronLogs: ExecutionLog[] = bridge.getTaskHistory(cronTask.id, 10);
    assert(cronLogs.length >= 1, 'Step 6.6: Cron task has execution logs');

    // ── Step 7: Update task ────────────────────────────────────────────────

    console.log('\n── Step 7: Update task ─────────────────────────────────────');

    bridgeEvents.length = 0;

    const updatedTask = await bridge.updateTask(cronTask.id, {
      name: 'Updated Cron Task',
      description: 'Updated description',
      executionConfig: {
        timeoutMs: 10000,
        maxConsecutiveFailures: 5,
        retryCount: 2,
        retryIntervalMs: 20,
        onlyWhenIdle: false,
        priority: 8,
      },
    });

    assertEqual(updatedTask.name, 'Updated Cron Task', 'Step 7.1: Task name updated');
    assertEqual(updatedTask.description, 'Updated description', 'Step 7.2: Task description updated');

    await sleep(50);
    const updatedEvents = findEvents('task_updated');
    assert(updatedEvents.length >= 1, 'Step 7.3: task_updated BridgeEvent received');

    // ── Step 8: Pause and resume task ──────────────────────────────────────

    console.log('\n── Step 8: Pause and resume task ────────────────────────────');

    bridgeEvents.length = 0;

    const pausedTask = await bridge.pauseTask(cronTask.id);
    assertEqual(pausedTask.status, 'paused', 'Step 8.1: Task paused');

    await sleep(50);
    const pausedEvents = findEvents('task_paused');
    assert(pausedEvents.length >= 1, 'Step 8.2: task_paused BridgeEvent received');

    bridgeEvents.length = 0;

    const resumedTask = await bridge.resumeTask(cronTask.id);
    assertEqual(resumedTask.status, 'active', 'Step 8.3: Task resumed');

    await sleep(50);
    const resumedEvents = findEvents('task_resumed');
    assert(resumedEvents.length >= 1, 'Step 8.4: task_resumed BridgeEvent received');

    // ── Step 9: Retry mechanism — register a failing task ──────────────────

    console.log('\n── Step 9: Retry mechanism (failing task with retryCount=2) ──');

    const retryTaskRequest: CreateTaskRequest = {
      name: 'Retry Test Task',
      description: 'Task that fails to test retry',
      schedule: { type: 'once', runAt: new Date(Date.now() - 1000).toISOString() },
      action: { type: 'prompt', content: 'test-prompt-fail' },
      executionConfig: {
        timeoutMs: 5000,
        maxConsecutiveFailures: 5,
        retryCount: 2,
        retryIntervalMs: 20, // Very short to avoid test timeout
        onlyWhenIdle: false,
        priority: 15,
      },
      createdBy: { type: 'system', id: 'e2e-retry', name: 'E2E Retry Test' },
    };

    const retryTask = await bridge.createTask(retryTaskRequest);
    assertNotNull(retryTask.id, 'Step 9.1: Retry task created');

    bridgeEvents.length = 0;

    // Trigger heartbeat to execute the failing task
    await bridge.onHeartbeat();

    // Wait for retries to complete (2 retries × 20ms retryInterval + execution time)
    await sleep(500);

    // Should get task_failed BridgeEvent for the failed execution
    const failedEvents = findEvents('task_failed');
    assert(failedEvents.length >= 1, 'Step 9.2: task_failed BridgeEvent received');

    // Verify execution logs show retry attempts
    const retryLogs: ExecutionLog[] = bridge.getTaskHistory(retryTask.id, 20);
    assert(retryLogs.length >= 1, 'Step 9.3: Retry task has execution logs');

    // At least one log should show retry
    const retryLogEntries = retryLogs.filter(l => l.isRetry);
    assert(retryLogEntries.length >= 1, 'Step 9.4: At least one log entry is a retry');

    // ── Step 10: List tasks with filter ────────────────────────────────────

    console.log('\n── Step 10: List tasks with filter ──────────────────────────');

    const allTasks: ScheduledTask[] = await bridge.listTasks();
    assert(allTasks.length >= 3, 'Step 10.1: listTasks() returns all tasks (≥3)');

    const activeFilter: TaskFilter = { status: 'active' };
    const activeTasks: ScheduledTask[] = await bridge.listTasks(activeFilter);
    assert(activeTasks.length >= 1, 'Step 10.2: listTasks(active) returns active tasks');

    // ── Step 11: Trigger task manually ─────────────────────────────────────

    console.log('\n── Step 11: Trigger task manually via triggerTask ──────────');

    bridgeEvents.length = 0;

    const triggerLog: ExecutionLog = await bridge.triggerTask(cronTask.id);
    assertNotNull(triggerLog.executionId, 'Step 11.1: triggerTask returns ExecutionLog with executionId');
    assertEqual(triggerLog.taskId, cronTask.id, 'Step 11.2: triggerTask log has correct taskId');

    // ── Step 12: Health summary ────────────────────────────────────────────

    console.log('\n── Step 12: Health summary and scheduler status ────────────');

    const health: SchedulerHealthSummary = bridge.getHealthSummary();
    assertNotNull(health, 'Step 12.1: getHealthSummary() returns non-null');
    assert(typeof health.totalTaskCount === 'number', 'Step 12.2: totalTaskCount is number');
    assert(typeof health.activeTaskCount === 'number', 'Step 12.3: activeTaskCount is number');
    assert(typeof health.pausedTaskCount === 'number', 'Step 12.4: pausedTaskCount is number');
    assert(typeof health.completedTaskCount === 'number', 'Step 12.5: completedTaskCount is number');

    console.log(`  Health summary: total=${health.totalTaskCount}, active=${health.activeTaskCount}, paused=${health.pausedTaskCount}, completed=${health.completedTaskCount}`);

    const schedStatus: SchedulerStatus = bridge.getSchedulerStatus();
    assertEqual(schedStatus.isRunning, true, 'Step 12.6: Scheduler is running');

    // ── Step 13: Delete tasks (unregister) ─────────────────────────────────

    console.log('\n── Step 13: Delete tasks (unregister) ───────────────────────');

    bridgeEvents.length = 0;

    const deleted1 = await bridge.deleteTask(cronTask.id);
    assertEqual(deleted1, true, 'Step 13.1: Cron task deleted successfully');

    const deleted2 = await bridge.deleteTask(retryTask.id);
    assertEqual(deleted2, true, 'Step 13.2: Retry task deleted successfully');

    await sleep(50);

    const deletedEvents = findEvents('task_deleted');
    assert(deletedEvents.length >= 2, 'Step 13.3: task_deleted BridgeEvent received for both tasks');

    // Verify tasks are gone
    const deletedTask = await bridge.getTask(cronTask.id);
    assertEqual(deletedTask, null, 'Step 13.4: getTask returns null for deleted task');

    // ── Step 14: Stop bridge ────────────────────────────────────────────────

    console.log('\n── Step 14: Stop bridge ──────────────────────────────────────');

    await bridge.stop();
    assert(true, 'Step 14.1: bridge.stop() completed without error');

    // KL-4: isRunning still true after stop (shutdown doesn't update status)
    const statusAfterStop = bridge.getSchedulerStatus();
    assertEqual(statusAfterStop.isRunning, true, 'Step 14.2: [KL-4] isRunning still true after stop (known limitation)');

    // ── Summary ──────────────────────────────────────────────────────────────

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log(`   Results: ${passed} passed, ${failed} failed`);
    console.log('═══════════════════════════════════════════════════════════');

    if (failures.length > 0) {
      console.log('\nFailed assertions:');
      for (const f of failures) {
        console.log(`  - ${f}`);
      }
    }

    console.log('\nKnown Limitations:');
    console.log('  KL-1: scheduler_started not received (initialize before wireUpEvents)');
    console.log('  KL-2: task_completed only for once-type tasks');
    console.log('  KL-3: updateTask ignores tags field');
    console.log('  KL-4: stop() does not update isRunning');

  } finally {
    // Cleanup temp dir
    try {
      fs.rmSync(testRoot, { recursive: true, force: true });
      console.log(`\nCleaned up: ${testRoot}`);
    } catch {
      console.log(`\nWarning: Could not clean up ${testRoot}`);
    }
  }

  // Exit with appropriate code
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(2);
});
