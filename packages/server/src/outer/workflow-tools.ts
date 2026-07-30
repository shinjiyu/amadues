/**
 * Outer LLM tools for Executable Workflow.
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md §10
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDef } from './outer-tools.js';
import type { OuterToolContext, ToolCallResult } from './outer-tools.js';
import { ExecutableWorkflowStore } from './executable-workflow-store.js';
import { promoteWorkflow, type PromoteWorkflowInput } from './workflow-promote.js';
import type { WorkflowKind, WorkflowStep } from './executable-workflow-types.js';
import { WORKFLOW_KINDS } from './executable-workflow-types.js';
import { runExecutableWorkflow, writeBurstModeMarker } from '../openkuroneko/inner-brain/workflow-runner.js';
import { defaultExecutableWorkflowRunnerDeps } from '../openkuroneko/inner-brain/default-workflow-runner-deps.js';
import { startExecutableWorkflowBackground } from './workflow-run-background.js';
import { normalizePlaybookSteps } from '../openkuroneko/browser/browser-playbook.js';
import { resolveWorkflowWithDrive9 } from '../drive9/workflow-drive9-seed.js';
import { suggestPromoteFromWorkspace } from './workflow-promote-suggest.js';
import { formatExecuteGoalPrefix } from './workflow-failure-circuit.js';

export const WORKFLOW_TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'workflow_list',
      description: '列出本 agent 已晋升的确定性工作流（Executable Workflow）及最新版本。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workflow_get',
      description: '读取指定工作流某一版本的完整契约（steps + expect）。',
      parameters: {
        type: 'object',
        properties: {
          workflow_id: { type: 'string', description: '工作流 id' },
          version: { type: 'string', description: '版本号；缺省取 latest' },
        },
        required: ['workflow_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workflow_promote',
      description:
        '【聊天可显式指定】把已验证步骤冻结为 Executable Workflow（须每步机械 expect）。' +
        '用户说固化/晋升/存成工作流时必须调用；可传 steps JSON，或 playbook_path / dag_path 从 workspace 生成。' +
        '探索成功后的自动晋升由内脑 ATTRIBUTE 负责；本工具用于聊天点名、补录与改版。' +
        '禁止写死 /data/workspaces/task-…；步间状态用相对文件，勿依赖跨步 $VAR。',
      parameters: {
        type: 'object',
        properties: {
          workflow_id: { type: 'string', description: '新/已有 id（同 id 会 bump version）' },
          kind: {
            type: 'string',
            description: 'skill_md | browser_playbook | frozen_dag | shell_pipeline',
            enum: ['skill_md', 'browser_playbook', 'frozen_dag', 'shell_pipeline', 'kpi_sequence'],
          },
          title: { type: 'string', description: '标题' },
          tags: { type: 'string', description: '逗号分隔标签' },
          steps_json: {
            type: 'string',
            description:
              'WorkflowStep[] JSON：action 仅 shell|browser_steps|run_node|assert|skill_step|kpi_charter；' +
              'shell 必 args.command；browser_steps 必 steps|playbook|playbookPath；禁止 shell_exec/browser_open 等工具名；' +
              '路径相对 workDir；跨步状态写 .run/ew/ 文件',
          },
          playbook_path: {
            type: 'string',
            description: 'workspace 相对路径：browser playbook JSON → 自动生成 browser_steps 步',
          },
          dag_path: {
            type: 'string',
            description: 'workspace 相对路径：local_dag JSON → 自动生成 run_node 步',
          },
          workspace_id: {
            type: 'string',
            description: '读 playbook/dag 时的 workspace（默认当前 outer workspace）',
          },
        },
        required: ['workflow_id', 'kind', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workflow_run',
      description:
        '按已晋升工作流确定性执行（burstMode=execute，不启 DyFlow redesign）。' +
        '默认后台启动、立即返回（不堵外脑）；完成后查 list_inner_brains / .run/workflow_run.json。' +
        '短测可传 wait=true 同步等待。',
      parameters: {
        type: 'object',
        properties: {
          workflow_id: { type: 'string', description: '工作流 id' },
          version: { type: 'string', description: '缺省 latest' },
          goal: { type: 'string', description: '可选说明，写入 goal.md' },
          wait: {
            type: 'boolean',
            description: 'true=同步等跑完（仅短测）；默认 false 后台跑',
          },
        },
        required: ['workflow_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workflow_suggest_promote',
      description:
        '扫描 workspace 探索产物，给出 Executable Workflow 晋升建议（不写入；确认后请 workflow_promote）。',
      parameters: {
        type: 'object',
        properties: {
          workspace_id: {
            type: 'string',
            description: '要扫描的 workspace（默认当前 outer workspace）',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'workflow_pause',
      description: '暂停/恢复某工作流（paused 后 set_goal execute 会拒收）。',
      parameters: {
        type: 'object',
        properties: {
          workflow_id: { type: 'string', description: '工作流 id' },
          paused: { type: 'boolean', description: 'true 暂停，false 恢复' },
        },
        required: ['workflow_id', 'paused'],
      },
    },
  },
];

function resolveStore(ctx: OuterToolContext): ExecutableWorkflowStore {
  return ctx.executableWorkflowStore ?? new ExecutableWorkflowStore({ dataRoot: ctx.dataRoot });
}

function resolveWsDir(ctx: OuterToolContext, workspaceId?: string): string {
  const ws = workspaceId?.trim() || ctx.workspaceId;
  return path.join(ctx.dataRoot, 'workspaces', ws);
}

function parseStepsJson(raw: string): WorkflowStep[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('steps_json must be an array');
  return parsed as WorkflowStep[];
}

function stepsFromPlaybook(workDir: string, rel: string): WorkflowStep[] {
  const abs = path.resolve(workDir, rel);
  if (!abs.startsWith(path.resolve(workDir)) || !fs.existsSync(abs)) {
    throw new Error(`playbook_path not found: ${rel}`);
  }
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8')) as unknown;
  const norm = normalizePlaybookSteps(raw);
  if ('error' in norm) throw new Error(norm.error);
  return [
    {
      id: 'playbook',
      action: 'browser_steps',
      args: { steps: norm.steps },
      expect: { fileExists: '.run/playbook-prepared.json', stdoutContains: 'playbook_steps=' },
    },
  ];
}

function stepsFromDag(workDir: string, rel: string): WorkflowStep[] {
  const abs = path.resolve(workDir, rel);
  if (!abs.startsWith(path.resolve(workDir)) || !fs.existsSync(abs)) {
    throw new Error(`dag_path not found: ${rel}`);
  }
  const dag = JSON.parse(fs.readFileSync(abs, 'utf8')) as unknown;
  return [
    {
      id: 'frozen',
      action: 'run_node',
      args: { dag },
      expect: { fileExists: '.run/frozen_dag_ready.json', stdoutContains: 'frozen_nodes=' },
    },
  ];
}

export async function dispatchWorkflowTool(
  name: string,
  args: Record<string, unknown>,
  ctx: OuterToolContext,
): Promise<ToolCallResult | null> {
  if (!name.startsWith('workflow_')) return null;
  const store = resolveStore(ctx);

  try {
    switch (name) {
      case 'workflow_list': {
        const list = store.list().map((m) => ({
          id: m.id,
          kind: m.kind,
          title: m.title,
          latestVersion: m.latestVersion,
          tags: m.tags,
          paused: Boolean(m.paused),
          updatedAt: m.updatedAt,
        }));
        return { replied: false, output: JSON.stringify(list, null, 2) };
      }
      case 'workflow_get': {
        const id = String(args['workflow_id'] ?? '').trim();
        if (!id) return { replied: false, output: '（workflow_id 为空）' };
        const ver = String(args['version'] ?? '').trim();
        const wf = ver ? store.get({ id, version: ver }) : store.getLatest(id);
        if (!wf) return { replied: false, output: `（未找到 ${id}${ver ? '@' + ver : ''}）` };
        return { replied: false, output: JSON.stringify(wf, null, 2) };
      }
      case 'workflow_promote': {
        const id = String(args['workflow_id'] ?? '').trim();
        const kind = String(args['kind'] ?? '').trim() as WorkflowKind;
        const title = String(args['title'] ?? '').trim();
        if (!WORKFLOW_KINDS.includes(kind)) {
          return { replied: false, output: `（未知 kind：${kind}）` };
        }
        const wsDir = resolveWsDir(ctx, typeof args['workspace_id'] === 'string' ? args['workspace_id'] : undefined);
        let steps: WorkflowStep[] = [];
        const stepsJson = typeof args['steps_json'] === 'string' ? args['steps_json'].trim() : '';
        const playbookPath = typeof args['playbook_path'] === 'string' ? args['playbook_path'].trim() : '';
        const dagPath = typeof args['dag_path'] === 'string' ? args['dag_path'].trim() : '';
        if (stepsJson) steps = parseStepsJson(stepsJson);
        else if (playbookPath) steps = stepsFromPlaybook(wsDir, playbookPath);
        else if (dagPath) steps = stepsFromDag(wsDir, dagPath);
        else return { replied: false, output: '（须提供 steps_json 或 playbook_path 或 dag_path）' };

        const tags =
          typeof args['tags'] === 'string'
            ? args['tags'].split(',').map((t) => t.trim()).filter(Boolean)
            : [];
        const input: PromoteWorkflowInput = {
          id,
          kind,
          title,
          tags,
          steps,
          source: {
            agentId: ctx.agentSid,
            workspaceId: path.basename(wsDir),
            fromArtifacts: [playbookPath || dagPath || 'steps_json'].filter(Boolean),
          },
        };
        const wf = promoteWorkflow(store, input, {
          drive9: ctx.workflowDrive9Store,
          workDir: wsDir,
        });
        return {
          replied: false,
          output: `已晋升 ${wf.id}@${wf.version}（${wf.kind}，${wf.steps.length} 步${ctx.workflowDrive9Store ? '，已同步 drive9' : ''}）`,
        };
      }
      case 'workflow_run': {
        const id = String(args['workflow_id'] ?? '').trim();
        if (!id) return { replied: false, output: '（workflow_id 为空）' };
        const ver = String(args['version'] ?? '').trim();
        let wf = ver
          ? await resolveWorkflowWithDrive9(store, { id, version: ver }, ctx.workflowDrive9Store)
          : store.getLatest(id);
        if (!wf && !ver && ctx.workflowDrive9Store) {
          // 无本地 latest：尝试 seed 后再取
          const listed = await ctx.workflowDrive9Store.listShared(50);
          const hit = listed.find((e) => e.id === id);
          if (hit) {
            wf = await resolveWorkflowWithDrive9(
              store,
              { id: hit.id, version: hit.version },
              ctx.workflowDrive9Store,
            );
          }
        }
        const meta = store.getMeta(id);
        if (!wf) {
          return {
            replied: false,
            output: meta
              ? `（版本不存在：${id}@${ver || meta.latestVersion}）`
              : `（工作流不存在：${id}）`,
          };
        }
        if (meta?.paused) return { replied: false, output: `（工作流已暂停：${id}）` };

        const registry = ctx.innerBrainRegistry;
        const instanceId = registry?.generateInstanceId() ?? `wf-${Date.now().toString(36)}`;
        const wsId = `task-${instanceId}`;
        ctx.workspaceStore.ensureWorkspace(wsId);
        const workDir = path.join(ctx.dataRoot, 'workspaces', wsId);
        const goalRaw =
          typeof args['goal'] === 'string' && args['goal'].trim()
            ? args['goal'].trim()
            : `execute ${wf.id}@${wf.version}`;
        const goal = `${formatExecuteGoalPrefix({ id: wf.id, version: wf.version })} ${goalRaw}`;
        fs.writeFileSync(path.join(workDir, 'goal.md'), `# Execute\n\n${goalRaw}\n`, 'utf8');
        writeBurstModeMarker(workDir, {
          burstMode: 'execute',
          workflowRef: { id: wf.id, version: wf.version },
        });
        const wait =
          args['wait'] === true ||
          args['wait'] === 'true' ||
          args['wait'] === 1 ||
          args['wait'] === '1';
        const deps = defaultExecutableWorkflowRunnerDeps(workDir);
        if (wait) {
          const run = await runExecutableWorkflow(wf, deps);
          if (registry) {
            registry.register({
              instanceId,
              workspaceId: wsId,
              workDir,
              goal,
              originUser: ctx.inboundHumanSid || ctx.agentSid,
              originThread: ctx.threadId,
              status: run.ok ? 'DONE' : 'ERROR',
              startedAt: new Date().toISOString(),
              finishedAt: new Date().toISOString(),
              ticks: run.steps.length,
              deliverableCount: run.ok ? 1 : 0,
              ...(run.ok ? {} : { errorMessage: `failed at ${run.abortedAt}` }),
            });
          }
          return {
            replied: false,
            output: run.ok
              ? `工作流 ${wf.id}@${wf.version} 完成（${run.steps.length} 步，ws=${wsId}）`
              : `工作流 ${wf.id}@${wf.version} 失败于 ${run.abortedAt}：${run.steps.find((s) => !s.ok)?.detail ?? ''}（ws=${wsId}）`,
          };
        }
        startExecutableWorkflowBackground({
          wf,
          workDir,
          deps,
          registry,
          task: {
            instanceId,
            workspaceId: wsId,
            workDir,
            goal,
            originUser: ctx.inboundHumanSid || ctx.agentSid,
            originThread: ctx.threadId,
            status: 'RUNNING',
            startedAt: new Date().toISOString(),
          },
        });
        return {
          replied: false,
          output:
            `已后台启动工作流 ${wf.id}@${wf.version}（instance=${instanceId}，ws=${wsId}）；` +
            `不阻塞对话。完成后看 list_inner_brains 或 ${wsId}/.run/workflow_run.json`,
        };
      }
      case 'workflow_suggest_promote': {
        const wsDir = resolveWsDir(
          ctx,
          typeof args['workspace_id'] === 'string' ? args['workspace_id'] : undefined,
        );
        const suggestions = suggestPromoteFromWorkspace(wsDir, path.basename(wsDir));
        return {
          replied: false,
          output:
            suggestions.length === 0
              ? '（无可晋升建议：未找到 local_dag / playbook / 成功 workflow_run）'
              : JSON.stringify(
                  suggestions.map((s) => ({
                    kind: s.kind,
                    suggestedId: s.suggestedId,
                    title: s.title,
                    reason: s.reason,
                    fromArtifacts: s.fromArtifacts,
                    draftSteps: s.draft.steps.length,
                    note: '确认后调用 workflow_promote（不会自动写入）',
                  })),
                  null,
                  2,
                ),
        };
      }
      case 'workflow_pause': {
        const id = String(args['workflow_id'] ?? '').trim();
        const paused = Boolean(args['paused']);
        store.setPaused(id, paused);
        return { replied: false, output: paused ? `已暂停 ${id}` : `已恢复 ${id}` };
      }
      default:
        return { replied: false, output: `未知 workflow 工具：${name}` };
    }
  } catch (e) {
    return { replied: false, output: `（workflow 工具失败：${(e as Error).message}）` };
  }
}
