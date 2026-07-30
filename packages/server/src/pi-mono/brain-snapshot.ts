import fs from 'node:fs';
import path from 'node:path';

import {
  buildDyflowInspectorPayload,
  buildWorkflowRunView,
  isDyflowWorkDir,
} from '../openkuroneko/inner-brain/dyflow-inspector.js';
import { tailFileLines, resolveLatestPiMonoLog } from './tail-file.js';

/** 外脑注入的 workDir 读接口（ADL：内脑模块不 npm import workspace-kit） */
export interface BrainInspectorFileReader {
  readTextFile(workspaceId: string, relPath: string): string | null;
}

/** 供 Dashboard 展示：一次 Pi-mono 单步在 DyFlow 内脑里到底做什么 */
export const PI_MONO_TICK_EXPLAINED = {
  summary:
    '一次「Pi-mono 单步」= 调用 DyFlow Controller.tick() 恰好一次。它读取 .brain/dyflow-state.json 里的 mode（DESIGN/RUN/…），执行「一整段」该模式逻辑后写回状态；不是「一次 LLM 一行字」或「一个工具调用」这种更细粒度。',
  modes: [
    {
      mode: 'DESIGN',
      what:
        '运行 Designer：读 goal / memory.facts / last_failure / 已注册 LocalNode，**一次** LLM 规划出 local_dag（节点 = preset/base 或 local/* 等）；可在反思期调 promote_local_node 固化战术；成功则 mode→RUN。',
    },
    {
      mode: 'RUN',
      what:
        '运行 Runner：按 local_dag 拓扑依次实例化并执行节点。baseNode 在受限轮数内多轮 **LLM + 工具**（fail-fast：连续无进展即 transient 上交 Designer）；节点结果写入 memory.node_results；全部成功 → DONE，遇失败 → 回 DESIGN 重规划。',
    },
    {
      mode: 'AWAITING',
      what:
        '存在未决 pending（ask_user / wait_timer / wait_signal）时挂起，等待外脑或定时信号；满足后回到 RUN。',
    },
    {
      mode: 'DONE',
      what:
        '所有节点完成，写 COMPLETE 输出；hadWork=false。',
    },
  ],
  note:
    'RUN 这一「宏步」内部已包含多轮 LLM/工具。若要看规划与失败原因，见下方 DyFlow 区块（mode / 执行 graph / last_failure）或日志里 designer / base-node / runner。',
} as const;

/**
 * 读取 pi-mono 日志尾部用于 logHighlights（findLastLogEntry 反向找各模块最近一条）。
 * 取尾部 800 行：远超单 burst 内各模块最近事件所需，又与文件总大小解耦（真 tail）。
 */
const BRAIN_INSPECTOR_LOG_TAIL = 800;
function readPiMonoLogLines(workDir: string): string[] {
  const filePath = resolveLatestPiMonoLog(workDir);
  if (!filePath) return [];
  return tailFileLines(filePath, BRAIN_INSPECTOR_LOG_TAIL);
}

function findLastLogEntry(
  lines: string[],
  pred: (e: Record<string, unknown>) => boolean,
): Record<string, unknown> | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]!) as Record<string, unknown>;
      if (pred(e)) return e;
    } catch {
      continue;
    }
  }
  return null;
}

function truncateExecutionContextJson(raw: string): Record<string, unknown> | null {
  try {
    const ctx = JSON.parse(raw) as {
      activeMilestone?: unknown;
      preState?: string;
      postState?: string;
      executionLog?: Array<{
        toolName: string;
        args: unknown;
        result: { ok: boolean; output: string };
        error?: string;
      }>;
    };
    return {
      activeMilestone: ctx.activeMilestone,
      preStateChars: ctx.preState?.length ?? 0,
      postStateChars: ctx.postState?.length ?? 0,
      preStatePreview: (ctx.preState ?? '').slice(0, 2000),
      postStatePreview: (ctx.postState ?? '').slice(0, 2000),
      executionLog: (ctx.executionLog ?? []).map((e, i) => ({
        index: i,
        toolName: e.toolName,
        ok: e.result?.ok,
        args: e.args,
        outputPreview: String(e.result?.output ?? '').slice(0, 800),
        error: e.error,
      })),
    };
  } catch {
    return { _parseError: true as const };
  }
}

export function buildBrainInspectorPayload(
  workspaceId: string,
  reader: BrainInspectorFileReader,
  workDir: string,
): Record<string, unknown> {
  const read = (rel: string) => reader.readTextFile(workspaceId, rel);

  let controllerState: Record<string, unknown> | null = null;
  const cs = read('.brain/controller-state.json');
  if (cs) {
    try {
      controllerState = JSON.parse(cs) as Record<string, unknown>;
    } catch {
      controllerState = { _parseError: true as const };
    }
  }

  const goalBrain = read('.brain/goal.md');
  const goalRun = read('.run/goal.md'); // 遗留，P3b 后 setGoal 不再写入
  const milestones = read('.brain/milestones.md') ?? '';

  const exRaw = read('.brain/execution-context.json');
  let executionContextPreview: unknown = null;
  if (exRaw?.trim()) {
    executionContextPreview = truncateExecutionContextJson(exRaw);
  }

  const logLines = readPiMonoLogLines(workDir);

  const attrDone = findLastLogEntry(
    logLines,
    (e) => e['module'] === 'attributor' && e['event'] === 'attribute.done',
  );
  let lastAttributor: Record<string, unknown> | null = null;
  if (attrDone) {
    const data = attrDone['data'] as Record<string, unknown> | undefined;
    lastAttributor = {
      ts: attrDone['ts'],
      flag: data?.['flag'],
      reason: data?.['reason'],
    };
  }

  const decomposeDone = findLastLogEntry(
    logLines,
    (e) => e['module'] === 'decomposer' && e['event'] === 'decompose.done',
  );

  const ctrlTick = findLastLogEntry(logLines, (e) => e['module'] === 'controller' && e['event'] === 'tick.start');

  const dyflowTick = findLastLogEntry(
    logLines,
    (e) => e['module'] === 'dyflow-controller' && e['event'] === 'tick.start',
  );
  const lastBaseNode = findLastLogEntry(logLines, (e) => e['module'] === 'base-node');
  const lastDesigner = findLastLogEntry(logLines, (e) => e['module'] === 'designer');

  const dyflow = isDyflowWorkDir(workDir) ? buildDyflowInspectorPayload(workDir) : null;
  const workflowRun = dyflow?.workflowRun ?? buildWorkflowRunView(workDir);
  const engine = dyflow ? ('dyflow' as const) : workflowRun ? ('execute' as const) : ('legacy' as const);

  return {
    engine,
    dyflow,
    workflowRun,
    controllerState,
    goalText: (goalBrain ?? goalRun ?? '').slice(0, 8000),
    milestonesText: milestones.slice(0, 12000),
    paths: {
      brainDir: fs.existsSync(path.join(workDir, '.brain')),
      controllerState: Boolean(cs),
      milestones: fs.existsSync(path.join(workDir, '.brain', 'milestones.md')),
      executionContext: Boolean(exRaw?.trim()),
    },
    executionContextPreview,
    logHighlights: {
      lastAttributor,
      lastDecomposer: decomposeDone
        ? { ts: decomposeDone['ts'], data: decomposeDone['data'] }
        : null,
      lastControllerTickStart: ctrlTick
        ? { ts: ctrlTick['ts'], data: ctrlTick['data'] }
        : null,
      lastDyflowTickStart: dyflowTick
        ? { ts: dyflowTick['ts'], data: dyflowTick['data'] }
        : null,
      lastBaseNode: lastBaseNode
        ? { ts: lastBaseNode['ts'], module: lastBaseNode['module'], event: lastBaseNode['event'], data: lastBaseNode['data'] }
        : null,
      lastDesigner: lastDesigner
        ? { ts: lastDesigner['ts'], module: lastDesigner['module'], event: lastDesigner['event'], data: lastDesigner['data'] }
        : null,
    },
    piMonoTickExplained: PI_MONO_TICK_EXPLAINED,
    dyflowTickExplained: dyflow
      ? {
          summary:
            'DyFlow 内脑：DESIGN（Designer 出 local_dag）↔ RUN（Runner 顺序执行 NodeInst）。baseNode 猛猛干；连续无进展或达轮次上限则 transient failure → Designer replan。',
          modes: [
            { mode: 'DESIGN', what: '读 memory + LocalNode 库，commit_local_dag 或 report_done' },
            { mode: 'RUN', what: '按 local_dag 顺序跑 preset/base、local/* 等' },
            { mode: 'AWAITING', what: 'pendings 等待（与外脑 changeWatcher 一致）' },
            { mode: 'DONE', what: '本 burst 结束' },
          ],
        }
      : undefined,
  };
}
