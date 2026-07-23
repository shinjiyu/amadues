/**
 * Executable Workflow kind adapters — browser_playbook / frozen_dag / kpi_charter.
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md §3 · P3 真执行可注入
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  normalizePlaybookSteps,
  type BrowserPlaybookDoc,
  type BrowserPlaybookStep,
} from '../browser/browser-playbook.js';
import { writeLocalDag, readLocalDag } from './local-dag-store.js';
import type { LocalDag, NodeInst } from './types.js';

export interface AdapterResult {
  ok: boolean;
  detail: string;
  /** 供 expect.stdoutContains */
  stdout?: string;
  exitCode?: number;
}

export type RunBrowserStepsFn = (
  steps: BrowserPlaybookStep[],
  workDir: string,
) => Promise<AdapterResult> | AdapterResult;

export type RunLocalDagFn = (
  dag: LocalDag,
  workDir: string,
) => Promise<AdapterResult> | AdapterResult;

function resolveUnderWorkDir(workDir: string, rel: string): string | null {
  const p = path.resolve(workDir, rel);
  if (!p.startsWith(path.resolve(workDir))) return null;
  return p;
}

async function settle<T>(v: Promise<T> | T): Promise<T> {
  return await v;
}

/**
 * browser_steps：校验 playbook → 落盘 → 可选真实执行。
 * dryRun：显式 true 强制干跑；显式 false 要求注入；缺省 = 有注入则真跑否则干跑。
 */
export async function runBrowserStepsAdapter(
  workDir: string,
  args: Record<string, unknown> | undefined,
  deps?: { runBrowserSteps?: RunBrowserStepsFn },
): Promise<AdapterResult> {
  const outRel =
    typeof args?.['outPath'] === 'string' && args['outPath'].trim()
      ? String(args['outPath']).trim()
      : '.run/playbook-prepared.json';
  const outAbs = resolveUnderWorkDir(workDir, outRel);
  if (!outAbs) return { ok: false, detail: 'outPath escapes workDir' };

  let raw: unknown = args?.['steps'] ?? args?.['playbook'];
  if (typeof args?.['playbookPath'] === 'string' && args['playbookPath'].trim()) {
    const playAbs = resolveUnderWorkDir(workDir, String(args['playbookPath']).trim());
    if (!playAbs || !fs.existsSync(playAbs)) {
      return { ok: false, detail: `playbookPath missing: ${args['playbookPath']}` };
    }
    try {
      raw = JSON.parse(fs.readFileSync(playAbs, 'utf8')) as unknown;
    } catch (e) {
      return { ok: false, detail: `playbook JSON parse failed: ${String(e)}` };
    }
  }
  if (raw == null) {
    return { ok: false, detail: 'browser_steps: need steps|playbook|playbookPath' };
  }
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {
      return { ok: false, detail: 'steps/playbook string is not valid JSON' };
    }
  }

  const norm = normalizePlaybookSteps(raw);
  if ('error' in norm) return { ok: false, detail: norm.error };

  const doc: BrowserPlaybookDoc =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? { ...(raw as BrowserPlaybookDoc), steps: norm.steps }
      : { steps: norm.steps };

  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, JSON.stringify(doc, null, 2), 'utf8');

  const dryRun =
    args?.['dryRun'] === true
      ? true
      : args?.['dryRun'] === false
        ? false
        : !deps?.runBrowserSteps;

  if (dryRun) {
    return {
      ok: true,
      detail: `playbook prepared ${norm.steps.length} steps → ${outRel}`,
      exitCode: 0,
      stdout: `playbook_steps=${norm.steps.length}`,
    };
  }
  if (!deps?.runBrowserSteps) {
    return { ok: false, detail: 'dryRun=false but runBrowserSteps not injected' };
  }

  return settle(deps.runBrowserSteps(norm.steps, workDir));
}

function normalizeDag(raw: unknown, workDir: string): LocalDag | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'dag must be an object' };
  const o = raw as Record<string, unknown>;
  const nodesRaw = o['nodes'];
  if (!Array.isArray(nodesRaw) || nodesRaw.length === 0) {
    return { error: 'dag.nodes must be a non-empty array' };
  }
  const nodes: NodeInst[] = [];
  for (let i = 0; i < nodesRaw.length; i++) {
    const n = nodesRaw[i];
    if (!n || typeof n !== 'object') return { error: `dag.nodes[${i}] invalid` };
    const ref = typeof (n as NodeInst).ref === 'string' ? (n as NodeInst).ref.trim() : '';
    if (!ref) return { error: `dag.nodes[${i}]: ref required` };
    const id =
      typeof (n as NodeInst).id === 'string' && (n as NodeInst).id!.trim()
        ? (n as NodeInst).id!.trim()
        : `n${i + 1}`;
    nodes.push({ ...(n as NodeInst), id, ref });
  }
  return {
    burstId: typeof o['burstId'] === 'string' ? o['burstId'] : `frozen-${path.basename(workDir)}`,
    designedAt: typeof o['designedAt'] === 'string' ? o['designedAt'] : new Date().toISOString(),
    nodes,
    edges: Array.isArray(o['edges']) ? (o['edges'] as LocalDag['edges']) : undefined,
    entry: typeof o['entry'] === 'string' ? o['entry'] : nodes[0]?.id,
    notes: typeof o['notes'] === 'string' ? o['notes'] : 'frozen_dag from Executable Workflow',
  };
}

function writeReady(workDir: string, dag: LocalDag, materializeOnly: boolean): void {
  const ready = path.join(workDir, '.run', 'frozen_dag_ready.json');
  fs.mkdirSync(path.dirname(ready), { recursive: true });
  fs.writeFileSync(
    ready,
    JSON.stringify(
      {
        nodeCount: dag.nodes.length,
        entry: dag.entry,
        materializeOnly,
        refs: dag.nodes.map((n) => n.ref),
      },
      null,
      2,
    ),
    'utf8',
  );
}

/**
 * run_node / frozen_dag：物化 local_dag；可选注入 runLocalDag 真跑。
 * materializeOnly：显式 true 只物化；显式 false 要求注入；缺省 = 有注入则真跑。
 */
export async function runFrozenDagAdapter(
  workDir: string,
  args: Record<string, unknown> | undefined,
  deps?: { runLocalDag?: RunLocalDagFn },
): Promise<AdapterResult> {
  let raw: unknown = args?.['dag'];
  if (typeof args?.['dagPath'] === 'string' && args['dagPath'].trim()) {
    const abs = resolveUnderWorkDir(workDir, String(args['dagPath']).trim());
    if (!abs || !fs.existsSync(abs)) {
      return { ok: false, detail: `dagPath missing: ${args['dagPath']}` };
    }
    try {
      raw = JSON.parse(fs.readFileSync(abs, 'utf8')) as unknown;
    } catch (e) {
      return { ok: false, detail: `dag JSON parse failed: ${String(e)}` };
    }
  }

  let dag: LocalDag;
  if (raw == null) {
    const existing = readLocalDag(workDir);
    if (!existing) {
      return { ok: false, detail: 'run_node: need dag|dagPath or existing local_dag.json' };
    }
    dag = existing;
  } else {
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw) as unknown;
      } catch {
        return { ok: false, detail: 'dag string is not valid JSON' };
      }
    }
    const normalized = normalizeDag(raw, workDir);
    if ('error' in normalized) return { ok: false, detail: normalized.error };
    dag = normalized;
    writeLocalDag(workDir, dag);
  }

  const materializeOnly =
    args?.['materializeOnly'] === true
      ? true
      : args?.['materializeOnly'] === false
        ? false
        : !deps?.runLocalDag;

  writeReady(workDir, dag, materializeOnly);

  if (materializeOnly) {
    return {
      ok: true,
      detail: `frozen dag materialized (${dag.nodes.length} nodes)`,
      exitCode: 0,
      stdout: `frozen_nodes=${dag.nodes.length}`,
    };
  }
  if (!deps?.runLocalDag) {
    return { ok: false, detail: 'materializeOnly=false but runLocalDag not injected' };
  }

  const ran = await settle(deps.runLocalDag(dag, workDir));
  return {
    ok: ran.ok,
    detail: ran.detail,
    exitCode: ran.exitCode ?? (ran.ok ? 0 : 1),
    stdout: ran.stdout ?? `frozen_nodes=${dag.nodes.length};ran=1`,
  };
}

/**
 * kpi_charter：把固定 charter 落到 `.run/kpi_sequence/{stepId}.md`
 */
export function runKpiCharterAdapter(
  workDir: string,
  args: Record<string, unknown> | undefined,
): AdapterResult {
  const charter = typeof args?.['charter'] === 'string' ? args['charter'].trim() : '';
  if (!charter) return { ok: false, detail: 'kpi_charter: args.charter required' };

  const outRel =
    typeof args?.['outPath'] === 'string' && args['outPath'].trim()
      ? String(args['outPath']).trim()
      : `.run/kpi_sequence/${
          typeof args?.['outName'] === 'string' && args['outName'].trim()
            ? String(args['outName']).trim().replace(/[^\w.-]+/g, '_')
            : 'step'
        }.md`;
  const outAbs = resolveUnderWorkDir(workDir, outRel);
  if (!outAbs) return { ok: false, detail: 'outPath escapes workDir' };

  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, `${charter}\n`, 'utf8');
  return {
    ok: true,
    detail: `kpi_charter → ${outRel}`,
    exitCode: 0,
    stdout: `kpi_charter=${outRel}`,
  };
}
