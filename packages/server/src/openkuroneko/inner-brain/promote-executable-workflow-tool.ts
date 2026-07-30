/**
 * Attributor 工具：promote_executable_workflow（层 C）
 * @see doc/structurizr/EXECUTABLE-WORKFLOW.md · DYFLOW-ATTRIBUTION.md
 */
import path from 'node:path';
import type { Tool } from '../tools/index.js';
import { ExecutableWorkflowStore } from '../../outer/executable-workflow-store.js';
import { promoteWorkflow, type PromoteWorkflowInput } from '../../outer/workflow-promote.js';
import { suggestPromoteFromWorkspace } from '../../outer/workflow-promote-suggest.js';
import { kpiWorkflowTag } from '../../outer/workflow-for-kpi.js';
import type { WorkflowKind, WorkflowStep } from '../../outer/executable-workflow-types.js';
import { WORKFLOW_KINDS } from '../../outer/executable-workflow-types.js';
import {
  listEvolutionProposals,
  markEvolutionStatus,
} from '../../outer/workflow-evolution-store.js';

export interface PromoteExecutableWorkflowToolOpts {
  workDir: string;
  /** agent DATA_ROOT（workflows/ 挂在此下） */
  dataRoot: string;
  /** 可选：打 tag kpi:{id}，供 SelfWork execute 命中 */
  kpiId?: string;
}

/** workDir = DATA_ROOT/workspaces/<id> → DATA_ROOT */
export function resolveDataRootFromWorkDir(workDir: string): string {
  const abs = path.resolve(workDir);
  const parent = path.dirname(abs);
  if (path.basename(parent) === 'workspaces') return path.dirname(parent);
  // 测试/非标准布局：退回 workDir 自身作为 dataRoot
  return abs;
}

export function createPromoteExecutableWorkflowTool(
  opts: PromoteExecutableWorkflowToolOpts,
): Tool {
  return {
    name: 'promote_executable_workflow',
    description:
      '【层 C】把本轮已跑通的稳定路径冻结为 Executable Workflow（版本化、逐步 expect、execute 禁 redesign）。' +
      '【优先 from=auto】扫描 local_dag / playbook，由系统生成合法 action+args；' +
      '勿把 browser_open/shell_exec/write_file 等内脑工具名写成 action。' +
      'from=steps 仅补录：action 仅 shell|browser_steps|run_node|assert|skill_step|kpi_charter，且必须带对应 args（如 shell.command）。' +
      '【W8】禁止写死 /data/workspaces/task-…；路径相对当前 workspace。' +
      '【W9】步间状态写 .run/ew/ 等相对文件，禁止依赖上一步 $VAR。' +
      '【W11】禁止 Cookie/Token 明文；用 secretRefs 指向 keychain（如 AUTH_TOKEN→x_auth）。' +
      '【W12】KPI 主流程打 tag role:primary 或 role:collect；repair/verify 另打 role。' +
      '【W13】shell 用到的 .run/ew/*.py 等脚本会随 workDir 自动打进 assets。' +
      '【W15 修订】若 goal 写明修订某 EW：workflow_id 用同一 id；填 base_workflow_id/base_workflow_version；修好后必须 promote。',
    parameters: {
      workflow_id: {
        type: 'string',
        description: '工作流 id（同 id 会 bump version），如 ew-fanqie-publish',
      },
      title: { type: 'string', description: '人类可读标题' },
      kind: {
        type: 'string',
        description: 'frozen_dag | browser_playbook | shell_pipeline | skill_md | kpi_sequence；from=auto 时可省略',
      },
      from: {
        type: 'string',
        description: '默认/推荐 auto（扫产物）；steps=手写 steps_json（须过 W5/W6 校验）',
      },
      steps_json: {
        type: 'string',
        description:
          'from=steps：WorkflowStep[] JSON。action∈shell|browser_steps|run_node|assert|skill_step|kpi_charter；' +
          'shell 必有 args.command；browser_steps 必有 steps|playbook|playbookPath；run_node 必有 dag|dagPath',
      },
      tags: {
        type: 'string',
        description: '可选逗号标签；若有 kpi 会自动加 kpi:{id}',
      },
      base_workflow_id: {
        type: 'string',
        description: 'W15：修订时填被替代的 EW id（通常与 workflow_id 相同）',
      },
      base_workflow_version: {
        type: 'string',
        description: 'W15：修订时填被替代的 version',
      },
      revision_reason: {
        type: 'string',
        description: 'W15：为何修订（写入 source.fromArtifacts）',
      },
    },
    required: ['workflow_id', 'title'],
    async call(args) {
      const workflowId = String(args['workflow_id'] ?? '').trim();
      const title = String(args['title'] ?? '').trim();
      if (!workflowId || !title) {
        return { ok: false, output: 'promote_executable_workflow: workflow_id 与 title 必填' };
      }

      // W7：缺省 auto
      const from = String(args['from'] ?? 'auto').trim() || 'auto';
      const tagsRaw = String(args['tags'] ?? '').trim();
      const tags = tagsRaw
        ? tagsRaw.split(/[,;]/).map((t) => t.trim()).filter(Boolean)
        : [];
      if (opts.kpiId?.trim()) {
        const tag = kpiWorkflowTag(opts.kpiId);
        if (!tags.includes(tag)) tags.push(tag);
      }

      const baseId = String(args['base_workflow_id'] ?? '').trim();
      const baseVer = String(args['base_workflow_version'] ?? '').trim();
      const revisionReason = String(args['revision_reason'] ?? '').trim();
      const store = new ExecutableWorkflowStore({ dataRoot: opts.dataRoot });

      // 修订时继承 base EW 的 role/kpi tags，避免 SelfWork 丢 role:collect
      if (baseId && baseVer) {
        const base = store.get({ id: baseId, version: baseVer });
        if (base?.tags?.length) {
          for (const t of base.tags) {
            if (!tags.includes(t)) tags.push(t);
          }
        }
      }

      let draft: PromoteWorkflowInput | null = null;

      if (from === 'steps') {
        const raw = String(args['steps_json'] ?? '').trim();
        if (!raw) return { ok: false, output: 'from=steps 需要 steps_json' };
        let steps: WorkflowStep[];
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (!Array.isArray(parsed)) throw new Error('not array');
          steps = parsed as WorkflowStep[];
        } catch (e) {
          return { ok: false, output: `steps_json 无效：${String(e)}` };
        }
        const kindRaw = String(args['kind'] ?? 'shell_pipeline').trim() as WorkflowKind;
        if (!WORKFLOW_KINDS.includes(kindRaw)) {
          return { ok: false, output: `未知 kind：${kindRaw}` };
        }
        draft = {
          id: workflowId,
          kind: kindRaw,
          title,
          tags,
          steps,
          source: {
            workspaceId: path.basename(opts.workDir),
            fromArtifacts: ['steps_json'],
          },
        };
      } else {
        const suggestions = suggestPromoteFromWorkspace(opts.workDir, path.basename(opts.workDir));
        if (suggestions.length === 0) {
          return {
            ok: false,
            output:
              'auto 未找到可晋升产物（需 .brain/local_dag.json 或 playbook）。可改 from=steps 传 steps_json。',
          };
        }
        const pick =
          suggestions.find((s) => {
            const k = String(args['kind'] ?? '').trim();
            return k ? s.kind === k : true;
          }) ?? suggestions[0]!;
        draft = {
          ...pick.draft,
          id: workflowId,
          title,
          tags: [...new Set([...(pick.draft.tags ?? []), ...tags])],
          source: {
            ...pick.draft.source,
            workspaceId: path.basename(opts.workDir),
            fromArtifacts: pick.fromArtifacts,
          },
        };
      }

      if (draft && (baseId || baseVer || revisionReason)) {
        const prev = draft.source ?? {
          promotedAt: new Date().toISOString(),
          workspaceId: path.basename(opts.workDir),
          fromArtifacts: [],
        };
        const arts = [...(prev.fromArtifacts ?? [])];
        if (baseId && baseVer) arts.push(`revises:${baseId}@${baseVer}`);
        if (revisionReason) arts.push(`revision_reason:${revisionReason.slice(0, 200)}`);
        draft.source = { ...prev, fromArtifacts: arts };
      }

      try {
        const wf = promoteWorkflow(store, draft!, { workDir: opts.workDir });
        if (baseId) {
          for (const p of [
            ...listEvolutionProposals(opts.dataRoot, 'pending'),
            ...listEvolutionProposals(opts.dataRoot, 'dispatched'),
          ]) {
            if (p.workflowId === baseId || p.workflowId === workflowId) {
              markEvolutionStatus(opts.dataRoot, p.id, 'done');
            }
          }
        }
        return {
          ok: true,
          output: `promoted ${wf.id}@${wf.version} (${wf.kind}, ${wf.steps.length} steps, tags=${wf.tags.join(',') || '—'})`,
        };
      } catch (e) {
        return { ok: false, output: `promote 失败：${(e as Error).message}` };
      }
    },
  };
}
