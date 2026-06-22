/**
 * KPI 场景 harness — 在临时目录模拟 burst 工作区与 registry 行，不跑 hook / 不 spawn。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { KpiRegistry, type KpiKind } from './kpi-registry.js';
import { InnerBrainRegistry } from './inner-brain-registry.js';
import { POST_COMPLETE_REASON } from './brain-async-snapshot.js';
import { countDeliverables } from './inner-burst-exit.js';

export interface KpiScenarioFixture {
  dataRoot: string;
  kpiRegistry: KpiRegistry;
  innerBrainRegistry: InnerBrainRegistry;
  kpiId: string;
  simulateBurstExit(opts: SimulateBurstExitOpts): {
    instanceId: string;
    deliverableCount: number;
  };
  cleanup: () => void;
}

export interface SimulateBurstExitOpts {
  verdict?: 'success' | 'partial' | 'failed';
  deliverables?: string[];
  postComplete?: boolean;
  asyncWaiting?: boolean;
  exitedWithError?: boolean;
  stoppedBy?: 'idle' | 'max_ticks' | 'stop_signal';
}

export function createKpiScenarioFixture(
  description = '测试 KPI 目标',
  kind: KpiKind = 'delivery',
): KpiScenarioFixture {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-scenario-'));
  const kpiRegistry = new KpiRegistry(dataRoot);
  const innerBrainRegistry = new InnerBrainRegistry(dataRoot);
  const kpi = kpiRegistry.create({ description, createdBy: 'test:harness', kind });

  return {
    dataRoot,
    kpiRegistry,
    innerBrainRegistry,
    kpiId: kpi.kpiId,
    simulateBurstExit(opts) {
      const instanceId = innerBrainRegistry.generateInstanceId();
      const workspaceId = `task-${instanceId}`;
      const workDir = path.join(dataRoot, 'workspaces', workspaceId);
      fs.mkdirSync(path.join(workDir, '.brain'), { recursive: true });
      fs.mkdirSync(path.join(workDir, '.run', 'pi-mono'), { recursive: true });

      const deliverables = opts.deliverables ?? [];
      if (deliverables.length > 0) {
        fs.writeFileSync(
          path.join(workDir, '.run', 'pi-mono', 'deliverables.json'),
          JSON.stringify(deliverables),
          'utf8',
        );
        for (const rel of deliverables) {
          const abs = path.join(workDir, rel);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          if (!fs.existsSync(abs)) {
            fs.writeFileSync(abs, `# ${rel}\n\n模拟产出内容。\n`, 'utf8');
          }
        }
      }

      const verdict = opts.verdict ?? 'success';
      if (verdict === 'failed') {
        fs.writeFileSync(
          path.join(workDir, '.brain', 'memory.json'),
          JSON.stringify({
            constraints: [],
            facts: [],
            fact_records: [],
            node_results: {},
            last_failure: {
              nodeInstId: 'sim',
              localRef: 'sim',
              summary: '模拟硬失败',
              attempted: [],
              confidence: 'high',
              at: new Date().toISOString(),
            },
          }),
          'utf8',
        );
      }

      if (opts.postComplete) {
        fs.writeFileSync(
          path.join(workDir, '.brain', 'controller-state.json'),
          JSON.stringify({
            mode: 'BLOCKED',
            blockedReason: POST_COMPLETE_REASON,
            awaitingReason: null,
          }),
          'utf8',
        );
      } else if (opts.asyncWaiting) {
        fs.writeFileSync(
          path.join(workDir, '.brain', 'controller-state.json'),
          JSON.stringify({ mode: 'AWAITING', awaitingReason: '等定时' }),
          'utf8',
        );
      }

      const asyncWaiting = opts.asyncWaiting ?? false;
      innerBrainRegistry.register({
        instanceId,
        workspaceId,
        workDir,
        goal: description,
        originUser: 'test:user',
        status: asyncWaiting ? 'AWAITING' : 'DONE',
        startedAt: new Date().toISOString(),
        finishedAt: asyncWaiting ? undefined : new Date().toISOString(),
        kpiId: kpi.kpiId,
        deliverableCount: deliverables.length,
      });
      kpiRegistry.attachBurst(kpi.kpiId, instanceId);

      return { instanceId, deliverableCount: countDeliverables(workDir) };
    },
    cleanup() {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}
