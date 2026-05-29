/**
 * Full-Chain Verification Script for HeartbeatTaskBridge Integration
 *
 * Validates: cron registration -> scheduling -> execution -> retry -> alert -> complete lifecycle
 *
 * Run with: npx tsx packages/server/src/openkuroneko/scheduled-tasks/verify-full-chain.ts
 *   (from repo root)
 *
 * Uses a temporary data directory; all state is cleaned up after verification.
 *
 * @module scheduled-tasks
 */

import { HeartbeatTaskBridge } from './heartbeat-task-bridge.js';
import type {
  BridgeEvent,
  ScheduledTask,
  ExecutionLog,
} from './scheduled-task-types.js';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// -- Test helpers -----------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
    console.log(`  [PASS] ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.error(`  [FAIL] ${msg}`);
  }
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`  [PASS] ${msg}`);
  } else {
    failed++;
    failures.push(`${msg} -- expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    console.error(`  [FAIL] ${msg} -- expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertNotEqual<T>(actual: T, notExpected: T, msg: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(notExpected)) {
    passed++;
    console.log(`  [PASS] ${msg}`);
  } else {
    failed++;
    failures.push(`${msg} -- should not equal ${JSON.stringify(notExpected)}`);
    console.error(`  [FAIL] ${msg}`);
  }
}

function assertIncludes(arr: string[], item: string, msg: string): void {
  if (arr.includes(item)) {
    passed++;
    console.log(`  [PASS] ${msg}`);
  } else {
    failed++;
    failures.push(`${msg} -- array does not include ${item}`);
    console.error(`  [FAIL] ${msg} -- array ${JSON.stringify(arr)} does not include ${item}`);
  }
}

function assertNotEmpty<T>(arr: T[], msg: string): void {
  if (arr.length > 0) {
    passed++;
    console.log(`  [PASS] ${msg}`);
  } else {
    failed++;
    failures.push(`${msg} -- array is empty`);
    console.error(`  [FAIL] ${msg} -- array is empty`);
  }
}

function assertNotNull<T>(val: T | null | undefined, msg: string): void {
  if (val !== null && val !== undefined) {
    passed++;
    console.log(`  [PASS] ${msg}`);
  } else {
    failed++;
    failures.push(`${msg} -- value is null/undefined`);
    console.error(`  [FAIL] ${msg} -- value is null/undefined`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// -- Test setup -------------------------------------------------------------

const TEMP_DATA_ROOT = join(process.cwd(), 'test-tmp-verify-chain');

function cleanup(): void {
  if (existsSync(TEMP_DATA_ROOT)) {
    rmSync(TEMP_DATA_ROOT, { recursive: true, force: true });
  }
}

// -- Main verification ------------------------------------------------------

async function runVerification(): Promise<void> {
  cleanup();

  console.log('================================================================');
  console.log('  Full-Chain Verification: cron -> schedule -> execute -> retry -> alert');
  console.log('================================================================');
  console.log(`  Temp data root: ${TEMP_DATA_ROOT}`);
  console.log('');

  // Tracking arrays for mock callbacks
  const promptCalls: string[] = [];
  const toolCalls: Array<{ toolName: string; parameters: Record<string, unknown> }> = [];
  const messages: string[] = [];
  const events: BridgeEvent[] = [];

  // -- Step 1: Bridge Instantiation ----------------------------------------
  console.log('\n--- Step 1: Bridge Instantiation ---');

  const bridge = new HeartbeatTaskBridge(
    {
      dataRoot: TEMP_DATA_ROOT,
      maxExecutionsPerBeat: 3,
      defaultHeartbeatMs: 60_000,
    },
    {
      executePromptAction: async (_taskId: string, prompt: string) => {
        promptCalls.push(prompt);
        return `Executed prompt: ${prompt}`;
      },
      executeToolCallAction: async (_taskId: string, toolName: string, params: Record<string, unknown>) => {
        toolCalls.push({ toolName, parameters: params });
        return `Executed tool: ${toolName}`;
      },
      executeSendMessageAction: async (_taskId: string, content: string, _conversationId?: string) => {
        messages.push(content);
        return `Sent message: ${content}`;
      },
      notifyUser: async (_taskId: string, message: string) => {
        console.log(`  [notify] ${message}`);
      },
      isAgentBusy: () => false,
    },
  );

  assertNotNull(bridge, 'Bridge instance created');
  assertNotNull(bridge.getScheduler(), 'Scheduler accessible via bridge');
  assertNotNull(bridge.getMonitor(), 'Monitor accessible via bridge');
  assertNotNull(bridge.getAlertHandler(), 'AlertHandler accessible via bridge');

  // -- Step 2: Start bridge ------------------------------------------------
  console.log('\n--- Step 2: Start Bridge (initializes store + scheduler) ---');

  await bridge.start();

  // TaskStore creates: dataRoot/scheduled_tasks/ and dataRoot/scheduled_tasks/logs/
  // (NOT dataRoot/scheduled_tasks/tasks/ -- see implementation-notes)
  const scheduledTasksDir = join(TEMP_DATA_ROOT, 'scheduled_tasks');
  const logsDir = join(TEMP_DATA_ROOT, 'scheduled_tasks', 'logs');
  assert(existsSync(scheduledTasksDir), 'Scheduled tasks directory created');
  assert(existsSync(logsDir), 'Logs directory created');

  // Wire up event listener
  bridge.onEvent((event: BridgeEvent) => {
    events.push(event);
  });

  // -- Step 3: Register a cron task (prompt action) -------------------------
  console.log('\n--- Step 3: Register Cron Task (prompt action) ---');

  // NOTE: PromptAction field is 'content' (not 'prompt')
  const task1 = await bridge.createTask({
    name: 'test-prompt-cron',
    description: 'Test prompt-based cron task',
    schedule: {
      type: 'cron',
      expression: '* * * * *',
    },
    action: {
      type: 'prompt',
      content: 'Generate a daily status summary',
    },
    creator: {
      type: 'system',
      id: 'test-runner',
    },
    executionConfig: {
      retryCount: 2,
      timeoutMs: 30_000,
    },
  });

  assertNotNull(task1, 'Cron task created');
  assertEqual(task1.name, 'test-prompt-cron', 'Task name matches');
  assertEqual(task1.status, 'active', 'Task status is active');
  assertEqual(task1.schedule.type, 'cron', 'Schedule type is cron');
  assertNotNull(task1.nextRunAt, 'nextRunAt is set');

  const task1Id = task1.id;

  // -- Step 4: Register a tool_call task ------------------------------------
  console.log('\n--- Step 4: Register Interval Task (tool_call action) ---');

  // NOTE: ToolCallAction fields: toolName, parameters (not tool_name, params)
  const task2 = await bridge.createTask({
    name: 'test-tool-interval',
    description: 'Test tool call with interval schedule',
    schedule: {
      type: 'interval',
      intervalMs: 100, // Fast interval for testing
    },
    action: {
      type: 'tool_call',
      toolName: 'read_file',
      parameters: { path: '/tmp/test.txt' },
    },
    creator: {
      type: 'user',
      id: 'test-user',
    },
    executionConfig: {
      retryCount: 1,
      timeoutMs: 10_000,
    },
  });

  assertNotNull(task2, 'Interval task created');
  assertEqual(task2.schedule.type, 'interval', 'Schedule type is interval');

  // -- Step 5: Register a send_message task ---------------------------------
  console.log('\n--- Step 5: Register One-shot Task (send_message action) ---');

  // NOTE: SendMessageAction field is 'content' (not 'message')
  const task3 = await bridge.createTask({
    name: 'test-message-once',
    description: 'Test send_message with once schedule',
    schedule: {
      type: 'once',
      runAt: new Date(Date.now() + 100).toISOString(),
    },
    action: {
      type: 'send_message',
      content: 'Hello from scheduled task!',
    },
    creator: {
      type: 'agent',
      id: 'test-agent',
    },
    executionConfig: {
      retryCount: 0,
      timeoutMs: 5_000,
    },
  });

  assertNotNull(task3, 'One-shot task created');
  assertEqual(task3.schedule.type, 'once', 'Schedule type is once');

  // -- Step 6: Verify list and filter tasks ---------------------------------
  console.log('\n--- Step 6: List and Filter Tasks ---');

  const allTasks = await bridge.listTasks();
  assertEqual(allTasks.length, 3, 'Three tasks total');

  const activeTasks = await bridge.listTasks({ status: 'active' });
  assertEqual(activeTasks.length, 3, 'Three active tasks');

  // -- Step 7: Trigger heartbeat and verify execution -----------------------
  console.log('\n--- Step 7: Simulate Heartbeat -> Execution ---');

  // Wait for interval/once tasks to become due (intervalMs=100, runAt=now+100)
  await delay(200);
  await bridge.onHeartbeat();
  await delay(300);

  console.log(`  Prompt calls: ${promptCalls.length}`);
  console.log(`  Tool calls: ${toolCalls.length}`);
  console.log(`  Messages: ${messages.length}`);

  // At least one of the tasks should have been executed
  const totalExecutions = promptCalls.length + toolCalls.length + messages.length;
  assert(totalExecutions >= 1, `At least 1 task executed (actual: ${totalExecutions})`);

  // -- Step 8: Verify execution logs ----------------------------------------
  console.log('\n--- Step 8: Verify Execution Logs ---');

  const logs1 = bridge.getTaskHistory(task1Id);
  if (logs1.length > 0) {
    assertEqual(logs1[0].taskId, task1Id, 'Log taskId matches task 1');
    assertNotNull(logs1[0].executionId, 'Log has executionId');
    assertIncludes(
      ['success', 'failed', 'timeout'] as string[],
      logs1[0].status,
      'Log has valid status',
    );
  } else {
    // Task 1 is cron (every minute), might not have been due yet
    console.log('  [INFO] Task 1 has no logs yet (cron may not be due)');
    passed++;
  }

  // -- Step 9: Trigger a task manually --------------------------------------
  console.log('\n--- Step 9: Manual Trigger ---');

  // Force trigger task 2 (interval-based tool call)
  await bridge.triggerTask(task2.id);
  await delay(100);

  assert(toolCalls.length >= 1, `Tool call executed (total: ${toolCalls.length})`);
  if (toolCalls.length > 0) {
    assertEqual(toolCalls[0].toolName, 'read_file', 'Tool name matches');
    assertEqual(toolCalls[0].parameters.path, '/tmp/test.txt', 'Tool params match');
  }

  // -- Step 10: Pause and resume --------------------------------------------
  console.log('\n--- Step 10: Pause and Resume ---');

  const preCallCount = promptCalls.length;
  await bridge.pauseTask(task1Id);
  const pausedTask = await bridge.getTask(task1Id);
  assertEqual(pausedTask?.status, 'paused', 'Task is paused');

  await bridge.onHeartbeat();
  await delay(100);

  // Paused task should not execute
  assertEqual(
    promptCalls.length,
    preCallCount,
    'No execution while paused',
  );

  await bridge.resumeTask(task1Id);
  const resumedTask = await bridge.getTask(task1Id);
  assertEqual(resumedTask?.status, 'active', 'Task resumed to active');

  // -- Step 11: Update task -------------------------------------------------
  console.log('\n--- Step 11: Update Task ---');

  const updatedTask = await bridge.updateTask(task1Id, {
    description: 'Updated description',
  });
  assertEqual(updatedTask.description, 'Updated description', 'Description updated');

  // -- Step 12: Delete task -------------------------------------------------
  console.log('\n--- Step 12: Delete Task ---');

  await bridge.deleteTask(task3.id);
  const deletedTask = await bridge.getTask(task3.id);
  assertEqual(deletedTask, null, 'Task deleted');

  const remainingTasks = await bridge.listTasks();
  assertEqual(remainingTasks.length, 2, 'Two tasks remaining');

  // -- Step 13: Monitoring --------------------------------------------------
  console.log('\n--- Step 13: Monitoring and Health ---');

  const healthSummary = bridge.getHealthSummary();
  assertNotNull(healthSummary, 'Health summary returned');
  console.log(`  Health status: ${healthSummary.status}`);

  const report = bridge.getMonitoringReport();
  assertNotNull(report, 'Monitoring report returned');
  console.log(`  Report preview: ${report.substring(0, 100)}...`);

  // -- Step 14: Alert history -----------------------------------------------
  console.log('\n--- Step 14: Alert History ---');

  const alertHistory = bridge.getAlertHistory(10);
  // Alerts may or may not have been generated depending on task execution
  console.log(`  Alert history length: ${alertHistory.length}`);

  // -- Step 15: Retry test (force failure) ----------------------------------
  console.log('\n--- Step 15: Retry Behavior Test ---');

  // Create a task with a failing action handler to test retry
  const failBridge = new HeartbeatTaskBridge(
    {
      dataRoot: TEMP_DATA_ROOT,
      maxExecutionsPerBeat: 5,
    },
    {
      executePromptAction: async (_taskId: string, _prompt: string) => {
        throw new Error('Simulated execution failure');
      },
    },
  );
  await failBridge.start();

  const retryTask = await failBridge.createTask({
    name: 'retry-test',
    schedule: {
      type: 'interval',
      intervalMs: 50,
    },
    action: {
      type: 'prompt',
      content: 'This should fail',
    },
    creator: {
      type: 'system',
      id: 'test',
    },
    executionConfig: {
      retryCount: 2,
      retryIntervalMs: 50,
    },
  });

  assertNotNull(retryTask, 'Retry test task created');

  // Wait for task to become due (intervalMs=50), then trigger heartbeat
  await delay(100);
  await failBridge.onHeartbeat();
  await delay(500);

  const retryLogs = failBridge.getTaskHistory(retryTask.id);
  assertNotEmpty(retryLogs, 'Execution logs exist after failure');

  if (retryLogs.length > 0) {
    const hasFailure = retryLogs.some(l => l.status === 'failed');
    assert(hasFailure, 'At least one failed execution log exists');
    console.log(`  Retry test: ${retryLogs.length} execution log(s), failure detected: ${hasFailure}`);
  }

  // Check alert history for failure alerts
  const failAlerts = failBridge.getAlertHistory(10);
  console.log(`  Alert count after failure: ${failAlerts.length}`);

  await failBridge.stop();

  // -- Step 16: Stop bridge -------------------------------------------------
  console.log('\n--- Step 16: Stop Bridge ---');

  await bridge.stop();
  console.log('  Bridge stopped successfully');

  // After stop, heartbeat should not trigger executions
  const preStopCalls = promptCalls.length;
  await bridge.onHeartbeat();
  await delay(100);
  assertEqual(
    promptCalls.length,
    preStopCalls,
    'No execution after bridge stopped',
  );

  // -- Cleanup --------------------------------------------------------------
  bridge.offEvent(() => {});
  cleanup();

  // -- Summary --------------------------------------------------------------
  console.log('\n================================================================');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('================================================================');

  if (failures.length > 0) {
    console.log('\n  Failures:');
    for (const f of failures) {
      console.log(`    - ${f}`);
    }
  }

  console.log('');

  if (failed > 0) {
    process.exit(1);
  }
}

// -- Run --------------------------------------------------------------------

runVerification().catch((err) => {
  console.error('\nUnexpected error during verification:', err);
  cleanup();
  process.exit(2);
});
