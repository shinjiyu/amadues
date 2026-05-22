import fs from 'node:fs';
import path from 'node:path';

/** 外脑注入的 workDir 读接口（ADL：内脑模块不 npm import workspace-kit） */
export interface BrainInspectorFileReader {
  readTextFile(workspaceId: string, relPath: string): string | null;
}

/** 供 Dashboard 展示：一次 Pi-mono 单步在 openKuroneko 里到底做什么 */
export const PI_MONO_TICK_EXPLAINED = {
  summary:
    '一次「Pi-mono 单步」= 调用 openKuroneko 的 Controller.tick() 恰好一次。它会读取 .brain/controller-state.json 里的 mode，在该模式下执行「一整段」该模式的逻辑，然后写回状态；不是「一次 LLM 一行字」，也不是「一个工具调用」这种更细粒度。',
  modes: [
    {
      mode: 'DECOMPOSE',
      what:
        '运行 Tactical Decomposer：读 goal / constraints / 旧 milestones，通常 **一次** LLM（无工具），生成新的 milestones.md；成功则 mode→EXECUTE，失败则 BLOCKED。',
    },
    {
      mode: 'EXECUTE',
      what:
        '运行 Reactive Executor：针对 **当前 Active 里程碑**，在循环里多轮 **LLM + 工具**，直到本轮不再返回 tool_calls；写 environment 快照与 **execution-context.json**（给下一步 Attributor），然后 mode→ATTRIBUTE。',
    },
    {
      mode: 'ATTRIBUTE',
      what:
        '运行 Mandatory Attributor：读 execution-context，多轮 LLM + 写约束/技能/知识工具；解析末尾 **CONTROL:** / **REASON:**，决定 CONTINUE / SUCCESS_AND_NEXT / REPLAN / BLOCK / CYCLE_DONE；然后 **删除** execution-context.json，并切换 mode。',
    },
    {
      mode: 'BLOCKED',
      what:
        '等待外脑 input 或 directives（如 BLOCK 解封）；有输入则可能 REPLAN 或解封进 EXECUTE；无输入则 hadWork=false。',
    },
    {
      mode: 'SLEEPING',
      what:
        '循环里程碑间歇休眠；到时或外脑信号唤醒后回到 EXECUTE 或 DECOMPOSE。',
    },
  ],
  note:
    'EXECUTE 这一「宏步」内部已包含多轮 LLM/工具；ATTRIBUTE 同理。若要看归因结论，见下方「最近归因」或日志里 attributor / attribute.done。',
} as const;

function readPiMonoLogLines(workDir: string): string[] {
  const logsDir = path.join(workDir, '.run', 'pi-mono', 'logs');
  if (!fs.existsSync(logsDir)) return [];
  const today = new Date().toISOString().slice(0, 10);
  let filePath = path.join(logsDir, `${today}.jsonl`);
  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf8');
  } else {
    const files = fs
      .readdirSync(logsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .reverse();
    if (files[0]) {
      filePath = path.join(logsDir, files[0]!);
      content = fs.readFileSync(filePath, 'utf8');
    }
  }
  return content.trim().split('\n').filter(Boolean);
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

  return {
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
    },
    piMonoTickExplained: PI_MONO_TICK_EXPLAINED,
  };
}
