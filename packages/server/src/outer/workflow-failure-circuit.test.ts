import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InnerBrainRegistry } from './inner-brain-registry.js';
import { ExecutableWorkflowStore } from './executable-workflow-store.js';
import { promoteWorkflow } from './workflow-promote.js';
import { writeBurstModeMarker } from '../openkuroneko/inner-brain/workflow-runner.js';
import {
  selectWorkflowsForCircuit,
  tripWorkflowFailureCircuit,
  workflowRouteKey,
} from './workflow-failure-circuit.js';

describe('workflow-failure-circuit', () => {
  let root = '';

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  function setup() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ew-fc-'));
    const registry = new InnerBrainRegistry(root);
    const store = new ExecutableWorkflowStore({ dataRoot: root });
    promoteWorkflow(store, {
      id: 'ew-fail',
      kind: 'shell_pipeline',
      title: 'fail',
      steps: [{ id: 's1', action: 'assert', expect: { fileExists: 'x' } }],
    });
    return { registry, store };
  }

  function addExecuteFail(
    registry: InnerBrainRegistry,
    id: string,
    startedAt: string,
    ref = { id: 'ew-fail', version: '1' },
  ) {
    const workDir = path.join(root, 'workspaces', `task-${id}`);
    fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });
    writeBurstModeMarker(workDir, { burstMode: 'execute', workflowRef: ref });
    registry.register({
      instanceId: id,
      workspaceId: `task-${id}`,
      workDir,
      goal: `[ew:${ref.id}@${ref.version}] run`,
      originUser: 'u',
      status: 'ERROR',
      startedAt,
      finishedAt: startedAt,
      errorMessage: 'boom',
    });
  }

  it('连败 ≥3 → select + trip pause EW', () => {
    const { registry, store } = setup();
    addExecuteFail(registry, 'a', '2026-07-23T10:00:00.000Z');
    addExecuteFail(registry, 'b', '2026-07-23T10:01:00.000Z');
    addExecuteFail(registry, 'c', '2026-07-23T10:02:00.000Z');

    const hits = selectWorkflowsForCircuit(registry, 3);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.routeKey).toBe(workflowRouteKey('ew-fail', '1'));

    const res = tripWorkflowFailureCircuit({ dataRoot: root, registry, store, maxConsecutiveFailures: 3 });
    expect(res.paused).toHaveLength(1);
    expect(store.getMeta('ew-fail')?.paused).toBe(true);

    const again = tripWorkflowFailureCircuit({ dataRoot: root, registry, store, maxConsecutiveFailures: 3 });
    expect(again.paused).toHaveLength(0);
    expect(again.alreadyPaused).toHaveLength(1);
  });

  it('中间成功打断连败计数', () => {
    const { registry, store } = setup();
    addExecuteFail(registry, 'a', '2026-07-23T10:00:00.000Z');
    addExecuteFail(registry, 'b', '2026-07-23T10:01:00.000Z');
    const workDir = path.join(root, 'workspaces', 'task-ok');
    fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });
    writeBurstModeMarker(workDir, {
      burstMode: 'execute',
      workflowRef: { id: 'ew-fail', version: '1' },
    });
    registry.register({
      instanceId: 'ok',
      workspaceId: 'task-ok',
      workDir,
      goal: '[ew:ew-fail@1] ok',
      originUser: 'u',
      status: 'DONE',
      startedAt: '2026-07-23T10:02:00.000Z',
      finishedAt: '2026-07-23T10:02:00.000Z',
    });
    addExecuteFail(registry, 'c', '2026-07-23T10:03:00.000Z');
    addExecuteFail(registry, 'd', '2026-07-23T10:04:00.000Z');

    expect(selectWorkflowsForCircuit(registry, 3)).toHaveLength(0);
    expect(store.getMeta('ew-fail')?.paused).not.toBe(true);
  });
});
