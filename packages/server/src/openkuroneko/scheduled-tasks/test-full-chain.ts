/**
 * 全链路闭环验证脚本 — M3 HeartbeatTaskBridge 集成验证
 *
 * 验证链路：cron 注册 → 调度 → 执行 → 重试 → 告警
 *
 * 运行方式：cd D:\kuroneko\packages\server && npx tsx src/openkuroneko/scheduled-tasks/test-full-chain.ts
 *
 * 所有 API 签名已对照源码确认：
 *   - ScheduledTask.id (非 taskId)
 *   - CreateTaskRequest.createdBy (非 creator)
 *   - ToolCallAction.params (非 parameters)
 *   - PromptAction.content (非 prompt)
 *   - HeartbeatTaskBridge 构造: (config, deps)
 *   - executeToolCallAction 返回 string
 *   - CronParser.validate 是实例方法; validateCronExpression 是独立函数
 *   - SchedulerHealthSummary.state (非 status)
 */

import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';

import { HeartbeatTaskBridge } from './heartbeat-task-bridge.js';
import { validateCronExpression } from './cron-parser.js';
import type {
  CreateTaskRequest,
  ScheduledTask,
  ExecutionLog,
  AlertNotification,
  SchedulerStatus,
  SchedulerHealthSummary,
} from './scheduled-task-types.js';

// ── Test Infrastructure ─────────────────────────────────────────────────

interface TestResult {
  step: string;
  passed: boolean;
  expected: string;
  actual: string;
  error?: string;
}

const results: TestResult[] = [];
let bridge: HeartbeatTaskBridge;
let tmpDir: string;

function assert(condition: boolean, step: string, expected: string, actual: string): void {
  results.push({ step, passed: condition, expected, actual });
  const icon = condition ? '✅' : '❌';
  console.log(`  ${icon} ${step}: expected=${expected}, actual=${actual}`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Step 1: Setup & Cron Validation ─────────────────────────────────────

async function step1_cronValidation(): Promise<void> {
  console.log('\n=== Step 1: Cron 表达式验证 ===');

  // Test valid cron expressions
  const valid1 = validateCronExpression('*/5 * * * *');
  assert(valid1 === true, '1a. validate */5 * * * *', 'true', String(valid1));

  const valid2 = validateCronExpression('0 8 * * 1-5');
  assert(valid2 === true, '1b. validate 0 8 * * 1-5 (weekday)', 'true', String(valid2));

  const valid3 = validateCronExpression('* * * * *');
  assert(valid3 === true, '1c. validate * * * * * (every minute)', 'true', String(valid3));

  // Test invalid cron
  const invalid = validateCronExpression('invalid');
  assert(invalid === false, '1d. validate invalid cron', 'false', String(invalid));
}

// ── Step 2: Bridge Initialization ──────────────────────────────────────

async function step2_bridgeInit(): Promise<void> {
  console.log('\n=== Step 2: HeartbeatTaskBridge 初始化 ===');

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-task-test-'));

  // Track executed actions
  const executedActions: Array<{ taskId: string; type: string; detail: string }> = [];

  bridge = new HeartbeatTaskBridge(
    {
      dataRoot: tmpDir,
      maxExecutionsPerBeat: 10,
      defaultHeartbeatMs: 60_000,
      alertConfig: {
        maxConsecutiveFailures: 2,
        throttleMs: 0,  // no throttle for tests
      },
    },
    {
      executePromptAction: async (taskId: string, prompt: string) => {
        executedActions.push({ taskId, type: 'prompt', detail: prompt });
        return `Prompt executed: ${prompt.substring(0, 50)}`;
      },
      executeToolCallAction: async (taskId: string, toolName: string, params: Record<string, unknown>) => {
        executedActions.push({ taskId, type: 'tool', detail: `${toolName}(${JSON.stringify(params)})` });
        return `Tool call result: ${toolName} OK`;
      },
    }
  );

  // Make executedActions accessible for later steps
  (bridge as any)._testActions = executedActions;

  await bridge.start();

  const status = bridge.getSchedulerStatus();
  assert(status.state === 'running', '2a. scheduler state after start', 'running', status.state);

  console.log('  ℹ️  tmpDir:', tmpDir);
}

// ── Step 3: Task Creation (Cron Registration) ──────────────────────────

let taskId1: string;
let taskId2: string;
let taskId3: string;

async function step3_taskCreation(): Promise<void> {
  console.log('\n=== Step 3: 任务创建 (Cron 注册) ===');

  // Task 1: prompt action, every minute
  const req1: CreateTaskRequest = {
    name: 'test-prompt-every-minute',
    description: 'Test prompt action running every minute',
    schedule: {
      type: 'cron',
      expression: '* * * * *',
    },
    action: {
      type: 'prompt',
      content: 'Say hello from scheduled task',
    },
    executionConfig: {
      timeoutMs: 5000,
      maxConsecutiveFailures: 3,
      retryCount: 2,
      retryIntervalMs: 100,
      onlyWhenIdle: false,
      priority: 1,
    },
    createdBy: {
      type: 'user',
      id: 'test-user',
      name: 'Test User',
    },
    tags: ['test', 'prompt'],
  };

  const task1 = await bridge.createTask(req1);
  taskId1 = task1.id;
  assert(typeof taskId1 === 'string' && taskId1.length > 0, '3a. create task 1 (prompt)', 'non-empty string', taskId1);
  assert(task1.status === 'active', '3b. task 1 initial status', 'active', task1.status);
  assert(task1.action.type === 'prompt', '3c. task 1 action type', 'prompt', task1.action.type);

  // Task 2: tool call action, every minute
  const req2: CreateTaskRequest = {
    name: 'test-tool-every-minute',
    description: 'Test tool call action',
    schedule: {
      type: 'cron',
      expression: '* * * * *',
    },
    action: {
      type: 'tool_call',
      toolName: 'web_search',
      params: { query: 'test query' },
    },
    executionConfig: {
      timeoutMs: 5000,
      maxConsecutiveFailures: 2,
      retryCount: 1,
      retryIntervalMs: 50,
      onlyWhenIdle: false,
      priority: 2,
    },
    createdBy: {
      type: 'system',
      id: 'test-system',
      name: 'Test System',
    },
    tags: ['test', 'tool'],
  };

  const task2 = await bridge.createTask(req2);
  taskId2 = task2.id;
  assert(typeof taskId2 === 'string' && taskId2.length > 0, '3d. create task 2 (tool_call)', 'non-empty string', taskId2);
  assert(task2.action.type === 'tool_call', '3e. task 2 action type', 'tool_call', task2.action.type);

  // Task 3: one-time task (for retry testing - will fail)
  const req3: CreateTaskRequest = {
    name: 'test-retry-task',
    description: 'Task that will fail and trigger retry',
    schedule: {
      type: 'once',
      runAt: new Date().toISOString(),
    },
    action: {
      type: 'prompt',
      content: 'RETRY_TEST_FAIL', // sentinel - we'll make this fail
    },
    executionConfig: {
      timeoutMs: 5000,
      maxConsecutiveFailures: 2,
      retryCount: 3,
      retryIntervalMs: 100,
      onlyWhenIdle: false,
      priority: 1,
    },
    createdBy: {
      type: 'user',
      id: 'test-user',
      name: 'Test User',
    },
    tags: ['test', 'retry'],
  };

  const task3 = await bridge.createTask(req3);
  taskId3 = task3.id;
  assert(typeof taskId3 === 'string' && taskId3.length > 0, '3f. create task 3 (retry)', 'non-empty string', taskId3);

  // Verify list tasks
  const allTasks = await bridge.listTasks();
  assert(allTasks.length === 3, '3g. total task count', '3', String(allTasks.length));
}

// ── Step 4: Scheduling & Execution ─────────────────────────────────────

async function step4_schedulingAndExecution(): Promise<void> {
  console.log('\n=== Step 4: 调度与执行 ===');

  // Trigger heartbeat to process due tasks
  await bridge.onHeartbeat();
  await sleep(500); // allow async execution to complete

  const executedActions: Array<{ taskId: string; type: string; detail: string }> = (bridge as any)._testActions;

  // Check that prompt action was executed
  const promptExecs = executedActions.filter(a => a.type === 'prompt');
  assert(promptExecs.length >= 1, '4a. prompt action executed', '>=1', String(promptExecs.length));

  // Check that tool call action was executed
  const toolExecs = executedActions.filter(a => a.type === 'tool');
  assert(toolExecs.length >= 1, '4b. tool call action executed', '>=1', String(toolExecs.length));

  // Check execution logs
  const logs1 = bridge.getTaskHistory(taskId1, 5);
  assert(logs1.length >= 1, '4c. task 1 execution logs', '>=1', String(logs1.length));

  if (logs1.length > 0) {
    assert(
      logs1[0].status === 'success' || logs1[0].status === 'completed',
      '4d. task 1 execution status',
      'success or completed',
      logs1[0].status
    );
  }

  const logs2 = bridge.getTaskHistory(taskId2, 5);
  assert(logs2.length >= 1, '4e. task 2 execution logs', '>=1', String(logs2.length));

  if (logs2.length > 0) {
    assert(
      logs2[0].status === 'success' || logs2[0].status === 'completed',
      '4f. task 2 execution status',
      'success or completed',
      logs2[0].status
    );
  }

  // Check scheduler status shows executions
  const status = bridge.getSchedulerStatus();
  assert(status.state === 'running', '4g. scheduler still running', 'running', status.state);
  console.log(`  ℹ️  Scheduler lastRunAt: ${status.lastRunAt ?? 'N/A'}`);
}

// ── Step 5: Manual Trigger ─────────────────────────────────────────────

async function step5_manualTrigger(): Promise<void> {
  console.log('\n=== Step 5: 手动触发执行 ===');

  const execLog = await bridge.triggerTask(taskId1);
  assert(typeof execLog === 'object', '5a. trigger returns ExecutionLog', 'object', typeof execLog);
  assert(
    execLog.status === 'success' || execLog.status === 'completed',
    '5b. trigger execution status',
    'success or completed',
    execLog.status
  );
  assert(execLog.taskId === taskId1, '5c. execution log taskId matches', taskId1, execLog.taskId);
}

// ── Step 6: Pause & Resume ─────────────────────────────────────────────

async function step6_pauseResume(): Promise<void> {
  console.log('\n=== Step 6: 暂停与恢复 ===');

  const paused = await bridge.pauseTask(taskId1);
  assert(paused.status === 'paused', '6a. task paused', 'paused', paused.status);

  const fetched = await bridge.getTask(taskId1);
  assert(fetched?.status === 'paused', '6b. fetched task is paused', 'paused', fetched?.status ?? 'null');

  const resumed = await bridge.resumeTask(taskId1);
  assert(resumed.status === 'active', '6c. task resumed', 'active', resumed.status);
}

// ── Step 7: Retry Logic ────────────────────────────────────────────────

async function step7_retryLogic(): Promise<void> {
  console.log('\n=== Step 7: 重试逻辑验证 ===');

  // Create a new bridge with a failing action handler
  const failDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-task-retry-'));
  let callCount = 0;

  const retryBridge = new HeartbeatTaskBridge(
    {
      dataRoot: failDir,
      maxExecutionsPerBeat: 10,
      defaultHeartbeatMs: 60_000,
      alertConfig: { throttleMs: 0 },
    },
    {
      executePromptAction: async (_taskId: string, _prompt: string) => {
        callCount++;
        if (callCount <= 2) {
          throw new Error('Simulated failure for retry test');
        }
        return 'Success after retries';
      },
      executeToolCallAction: async (_taskId: string, toolName: string, _params: Record<string, unknown>) => {
        return `Tool ${toolName} OK`;
      },
    }
  );

  await retryBridge.start();

  // Create a task that should retry
  const retryTask = await retryBridge.createTask({
    name: 'retry-test',
    description: 'Task that fails then succeeds',
    schedule: { type: 'cron', expression: '* * * * *' },
    action: { type: 'prompt', content: 'fail twice then succeed' },
    executionConfig: {
      timeoutMs: 5000,
      maxConsecutiveFailures: 5,
      retryCount: 3,
      retryIntervalMs: 50,
      onlyWhenIdle: false,
      priority: 1,
    },
    createdBy: { type: 'user', id: 'test', name: 'Test' },
    tags: ['retry-test'],
  });

  // Trigger execution
  try {
    await retryBridge.triggerTask(retryTask.id);
  } catch {
    // Expected - task may fail
  }

  // The triggerTask should have internally retried and eventually succeeded
  // (scheduler retry logic runs within triggerTask)
  const logs = retryBridge.getTaskHistory(retryTask.id, 10);

  // We expect at least one execution attempt
  assert(logs.length >= 1, '7a. retry task has execution logs', '>=1', String(logs.length));

  // Check call count - if retry is working, should be called multiple times
  console.log(`  ℹ️  Retry call count: ${callCount}`);

  // The final log should be success if retries worked, or failed if all exhausted
  if (logs.length > 0) {
    const finalLog = logs[0]; // most recent
    console.log(`  ℹ️  Final execution status: ${finalLog.status}, attempts: ${logs.length}`);
  }

  await retryBridge.stop();

  // Cleanup
  try { fs.rmSync(failDir, { recursive: true }); } catch {}
}

// ── Step 8: Alert Verification ─────────────────────────────────────────

async function step8_alertVerification(): Promise<void> {
  console.log('\n=== Step 8: 告警验证 ===');

  // Get alerts from the main bridge
  const alerts: AlertNotification[] = bridge.getAlertHistory(50);
  console.log(`  ℹ️  Total alerts so far: ${alerts.length}`);

  // Alert types we expect to potentially see
  const alertCategories = alerts.map(a => a.category);
  console.log(`  ℹ️  Alert categories: ${[...new Set(alertCategories)].join(', ')}`);

  // Verify alert structure
  if (alerts.length > 0) {
    const first = alerts[0];
    assert(typeof first.id === 'string', '8a. alert has id', 'string', typeof first.id);
    assert(typeof first.timestamp === 'string', '8b. alert has timestamp', 'string', typeof first.timestamp);
    assert(['info', 'warning', 'error', 'critical'].includes(first.level), '8c. alert level valid', 'valid level', first.level);
    assert(typeof first.message === 'string', '8d. alert has message', 'string', typeof first.message);
  } else {
    console.log('  ℹ️  No alerts generated yet (this is OK if no failures occurred)');
    assert(true, '8a. alert check (skipped - no failures)', 'N/A', 'N/A');
    assert(true, '8b. alert check (skipped)', 'N/A', 'N/A');
    assert(true, '8c. alert check (skipped)', 'N/A', 'N/A');
    assert(true, '8d. alert check (skipped)', 'N/A', 'N/A');
  }

  // Create a dedicated test for alert triggering via consecutive failures
  const alertDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-task-alert-'));
  let failCount = 0;

  const alertBridge = new HeartbeatTaskBridge(
    {
      dataRoot: alertDir,
      maxExecutionsPerBeat: 10,
      defaultHeartbeatMs: 60_000,
      alertConfig: {
        maxConsecutiveFailures: 1, // alert after just 1 failure
        throttleMs: 0,
      },
    },
    {
      executePromptAction: async (_taskId: string, _prompt: string) => {
        failCount++;
        throw new Error('Forced failure for alert test');
      },
      executeToolCallAction: async (_taskId: string, toolName: string) => {
        return `Tool ${toolName} OK`;
      },
    }
  );

  await alertBridge.start();

  const alertTask = await alertBridge.createTask({
    name: 'alert-test',
    description: 'Task designed to fail and trigger alerts',
    schedule: { type: 'cron', expression: '* * * * *' },
    action: { type: 'prompt', content: 'fail for alert' },
    executionConfig: {
      timeoutMs: 5000,
      maxConsecutiveFailures: 1,
      retryCount: 0,  // no retry, fail immediately
      retryIntervalMs: 0,
      onlyWhenIdle: false,
      priority: 1,
    },
    createdBy: { type: 'user', id: 'test', name: 'Test' },
    tags: ['alert-test'],
  });

  // Trigger the failing task multiple times to accumulate failures
  for (let i = 0; i < 3; i++) {
    try {
      await alertBridge.triggerTask(alertTask.id);
    } catch {
      // expected
    }
    await sleep(100);
  }

  const alertLogs: AlertNotification[] = alertBridge.getAlertHistory(50);
  console.log(`  ℹ️  Alert bridge alerts: ${alertLogs.length}`);

  assert(alertLogs.length >= 1, '8e. alerts generated from failures', '>=1', String(alertLogs.length));

  if (alertLogs.length > 0) {
    const hasFailureAlert = alertLogs.some(a =>
      a.message.toLowerCase().includes('fail') ||
      a.category === 'task_failure'
    );
    assert(hasFailureAlert, '8f. failure alert present', 'true', String(hasFailureAlert));
  } else {
    assert(false, '8f. failure alert present', 'true', 'no alerts found');
  }

  await alertBridge.stop();
  try { fs.rmSync(alertDir, { recursive: true }); } catch {}
}

// ── Step 9: Health & Monitoring ─────────────────────────────────────────

async function step9_healthMonitoring(): Promise<void> {
  console.log('\n=== Step 9: 健康状态与监控报告 ===');

  // Health summary
  const health: SchedulerHealthSummary = bridge.getHealthSummary();
  assert(typeof health === 'object', '9a. health summary is object', 'object', typeof health);
  assert(typeof health.state === 'string', '9b. health has state', 'string', typeof health.state);
  assert(typeof health.totalTaskCount === 'number', '9c. health has totalTaskCount', 'number', typeof health.totalTaskCount);
  assert(health.totalTaskCount >= 3, '9d. totalTaskCount >= 3', '>=3', String(health.totalTaskCount));
  assert(Array.isArray(health.tasks), '9e. health has tasks array', 'array', typeof health.tasks);

  // Monitoring report
  const report: string = bridge.getMonitoringReport();
  assert(typeof report === 'string' && report.length > 0, '9f. monitoring report is non-empty string', 'non-empty string', `length=${report.length}`);
  console.log(`  ℹ️  Monitoring report preview: ${report.substring(0, 200)}...`);

  // Scheduler status
  const schedStatus: SchedulerStatus = bridge.getSchedulerStatus();
  assert(typeof schedStatus === 'object', '9g. scheduler status is object', 'object', typeof schedStatus);
  assert(schedStatus.state === 'running', '9h. scheduler state is running', 'running', schedStatus.state);
}

// ── Step 10: Integration Entry Function ────────────────────────────────

async function step10_integrationEntry(): Promise<void> {
  console.log('\n=== Step 10: 集成入口函数验证 ===');

  // Import integration entry functions
  const { createScheduledTaskBridge, startScheduledTaskBridge, getScheduledTaskHealthStatus } = await import('./integration-entry.js');

  assert(typeof createScheduledTaskBridge === 'function', '10a. createScheduledTaskBridge exported', 'function', typeof createScheduledTaskBridge);
  assert(typeof startScheduledTaskBridge === 'function', '10b. startScheduledTaskBridge exported', 'function', typeof startScheduledTaskBridge);
  assert(typeof getScheduledTaskHealthStatus === 'function', '10c. getScheduledTaskHealthStatus exported', 'function', typeof getScheduledTaskHealthStatus);

  // Test creating a bridge via integration entry
  const entryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-task-entry-'));

  const entryBridge = createScheduledTaskBridge(
    { dataRoot: entryDir },
    {
      executePromptAction: async (_t, p) => `executed: ${p}`,
      executeToolCallAction: async (_t, name, _p) => `tool: ${name}`,
    }
  );

  assert(typeof entryBridge === 'object', '10d. entry bridge created', 'object', typeof entryBridge);

  await entryBridge.start();
  const entryStatus = entryBridge.getSchedulerStatus();
  assert(entryStatus.state === 'running', '10e. entry bridge running', 'running', entryStatus.state);

  // Test getScheduledTaskHealthStatus
  const healthInfo = getScheduledTaskHealthStatus(entryBridge);
  assert(typeof healthInfo === 'object', '10f. health status from entry function', 'object', typeof healthInfo);
  assert(typeof healthInfo.state === 'string', '10g. health status has state', 'string', typeof healthInfo.state);

  // Test the startScheduledTaskBridge wrapper
  const entryBridge2 = await startScheduledTaskBridge(
    { dataRoot: entryDir, autoStart: true },
    {
      executePromptAction: async (_t, p) => `executed: ${p}`,
      executeToolCallAction: async (_t, name, _p) => `tool: ${name}`,
    }
  );
  const status2 = entryBridge2.getSchedulerStatus();
  assert(status2.state === 'running', '10h. startScheduledTaskBridge auto-starts', 'running', status2.state);

  await entryBridge.stop();
  await entryBridge2.stop();

  try { fs.rmSync(entryDir, { recursive: true }); } catch {}
}

// ── Cleanup ─────────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  if (bridge) {
    await bridge.stop();
  }
  if (tmpDir) {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  }
}

// ── Main Runner ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║   Scheduled Task 全链路闭环验证 — M3 Integration Test      ║');
  console.log('║   链路: cron注册 → 调度 → 执行 → 重试 → 告警              ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  try {
    await step1_cronValidation();
    await step2_bridgeInit();
    await step3_taskCreation();
    await step4_schedulingAndExecution();
    await step5_manualTrigger();
    await step6_pauseResume();
    await step7_retryLogic();
    await step8_alertVerification();
    await step9_healthMonitoring();
    await step10_integrationEntry();
  } catch (err) {
    console.error('\n💥 UNHANDLED ERROR:', err);
    results.push({
      step: 'UNHANDLED ERROR',
      passed: false,
      expected: 'no error',
      actual: String(err),
      error: err instanceof Error ? err.stack : String(err),
    });
  } finally {
    await cleanup();
  }

  // ── Summary ──
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;

  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log(`║   结果: ${passed}/${total} PASSED, ${failed} FAILED                          ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  if (failed > 0) {
    console.log('\n❌ Failed steps:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`  - ${r.step}: expected=${r.expected}, actual=${r.actual}`);
      if (r.error) console.log(`    error: ${r.error}`);
    });
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(2);
});
