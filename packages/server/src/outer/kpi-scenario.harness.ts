/**
 * KPI 场景 harness — 在临时目录模拟 burst 退出，不启动真实内脑进程。
 *
 * 用法（vitest）：
 *   const fx = createKpiScenarioFixture();
 *   fx.simulateBurstExit({ verdict: 'success', deliverables: ['report.md'], postComplete: true });
 *   expect(fx.kpiRegistry.get(fx.kpiId)?.status).toBe('achieved');
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { KpiRegistry } from './kpi-registry.js';
import { InnerBrainRegistry } from './inner-brain-registry.js';
import {
  processBurstExitForKpi,
  type BurstExitDeps,
} from './kpi-burst-hooks.js';
import { POST_COMPLETE_REASON } from './brain-async-snapshot.js';

export interface KpiScenarioFixture {
  dataRoot: string;
  kpiRegistry: KpiRegistry;
  innerBrainRegistry: InnerBrainRegistry;
  kpiId: string;
  /** 模拟一次 burst 结束并跑 KPI hook */
  simulateBurstExit(opts: SimulateBurstExitOpts): {
    instanceId: string;
    outcome: ReturnType<typeof processBurstExitForKpi>;
  };
  cleanup: () => void;
}

export interface SimulateBurstExitOpts {
  verdict?: 'success' | 'partial' | 'failed';
  deliverables?: string[];
  /** 模拟 milestones 全部完成 */
  postComplete?: boolean;
  /** 模拟仍在等 timer/用户 */
  asyncWaiting?: boolean;
  exitedWithError?: boolean;
  stoppedBy?: 'idle' | 'max_ticks' | 'stop_signal';
  isReflexionBurst?: boolean;
}

export function createKpiScenarioFixture(description = '测试 KPI 目标'): KpiScenarioFixture {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kpi-scenario-'));
  const kpiRegistry = new KpiRegistry(dataRoot);
  const innerBrainRegistry = new InnerBrainRegistry(dataRoot);
  const kpi = kpiRegistry.create({ description, createdBy: 'test:harness' });

  const reflexionBurstsScheduled: string[] = [];
  const deps: BurstExitDeps = {
    kpiRegistry,
    innerBrainRegistry,
    scheduleReflexionBurst: (kid) => {
      reflexionBurstsScheduled.push(kid);
      return `ib-reflexion-${reflexionBurstsScheduled.length}`;
    },
    stuckThreshold: 3,
  };

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
      fs.writeFileSync(
        path.join(workDir, '.brain', 'reflexion.json'),
        JSON.stringify({
          verdict,
          hardFailures: verdict === 'failed' ? ['模拟硬失败'] : [],
          softFailures: [],
          nextStrategy: verdict === 'failed' ? '换方向' : '',
        }),
        'utf8',
      );

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

      innerBrainRegistry.register({
        instanceId,
        workspaceId,
        workDir,
        goal: description,
        originUser: 'test:user',
        status: opts.asyncWaiting ? 'AWAITING' : 'DONE',
        startedAt: new Date().toISOString(),
        finishedAt: opts.asyncWaiting ? undefined : new Date().toISOString(),
        kpiId: kpi.kpiId,
        deliverableCount: deliverables.length,
        isReflexionBurst: opts.isReflexionBurst ?? false,
      });
      kpiRegistry.attachBurst(kpi.kpiId, instanceId);

      const outcome = processBurstExitForKpi(
        {
          instanceId,
          kpiId: kpi.kpiId,
          workDir,
          stoppedBy: opts.stoppedBy ?? 'idle',
          exitedWithError: opts.exitedWithError ?? false,
          isAwaiting: opts.asyncWaiting ?? false,
          isReflexionBurst: opts.isReflexionBurst ?? false,
        },
        deps,
      );

      return { instanceId, outcome };
    },
    cleanup() {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}
