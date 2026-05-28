/**
 * 外脑工具定义（对齐 openKuroneko outer-brain/tools/）。
 * 外脑 LLM 可调用这些工具来回复用户、派发内脑任务、查询/管理内脑状态。
 *
 * 多内脑支持（参考 openKuroneko InnerBrainPool）：
 *   - set_goal：每次调用创建独立 workspace，返回 instanceId
 *   - list_inner_brains：列出所有任务实例
 *   - stop_inner_brain：停止指定实例（写入停止信号文件）
 *   - send_directive：向指定实例发送指令
 */
import type { InnerBrainEngine, FilesystemWorkspaceStore, FilesystemRepositoryStore } from '../workspace-kit/index.js';
import {
  resolvePrimaryAgentSid,
  serializeMessageForLlm,
  MessageRecordSchema,
  type ChatAssetStore,
  type ChatIRChannel,
  type LooseThreadStore,
} from '@utlra/chat-ir';
import fs from 'node:fs';
import path from 'node:path';
import { runOpenKuronekoPiMonoAuto, writeStopSignal, clearStopSignal } from '../pi-mono/run-tick.js';
import { spawnInnerBrainWorker, readWorkerStatus } from '../pi-mono/inner-brain-spawner.js';
import { isInnerBrainStoppable, stopInnerBrainInstance } from './stop-inner-brain.js';
import type { InnerBrainRegistry, TaskRecord } from './inner-brain-registry.js';
import type { KpiRegistry } from './kpi-registry.js';
import { formatKpiReflexionBlock } from './kpi-registry.js';
import { formatKpiDigest, suggestKpiAction, buildKpiBurstLinks } from './kpi-progress.js';
import { ingestDeliverables } from './deliverables-ingest.js';
import { processBurstExitForKpi } from './kpi-burst-hooks.js';
import {
  listActivePendings as listActivePendingsSync,
  resolvePending as resolvePendingSync,
} from '../openkuroneko/pendings/index.js';
import {
  buildBrainAsyncSnapshot,
  isBrainAwaitingAsync,
} from './brain-async-snapshot.js';
import { notifyInnerBrainTaskComplete } from './completion-notify.js';
import { expandAttachAssetIds, type AttachmentPart } from './attach-expand.js';
import {
  mergeWorkDirSkillsToAgentPool,
  mergeWorkDirSkillsToMem9,
  mergeWorkDirSkillsToDrive9,
  mergeWorkDirKnowledgeToDrive9,
  seedInnerBrainSharedContext,
} from './agent-pool.js';
import type { OuterMemoryStore } from './outer-memory.js';
import type { SkillMemoryStore } from '../mem9/skill-memory-store.js';
import type { SkillDrive9Store } from '../drive9/skill-drive9-store.js';
import type { KnowledgeDrive9Store } from '../drive9/knowledge-drive9-store.js';
import {
  initSelfUpdateSession,
  readSelfUpdateSession,
} from '../self-update/session.js';
import { PerformanceGoalEngine } from '../performance-goals/engine.js';
import { MEMORY_BLOCK_TOOL_DEFS, dispatchMemoryBlockTool } from './memory-block-tools.js';
import type { MemoryBlockStore } from './memory-block-store.js';

// ── OpenAI-compatible tool schema ──────────────────────────────────────────

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string; enum?: string[] }>;
      required?: string[];
    };
  };
}

export const OUTER_TOOL_DEFS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'reply_to_user',
      description:
        '向用户发送消息（通过 chat IR 渠道，例如 Discord）。可多次调用追加多条消息。调用后消息立即发送。\n' +
        '可选附件：通过 attach_asset_ids 传入逗号分隔的 asset id 列表（裸 UUID，可带 `asset:` 前缀），' +
        '系统会自动转为附件并随消息发出。asset id 通常来自 read_inner_status 返回的 deliverables[].asset_id。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要发送给用户的消息内容（Markdown 可用）' },
          attach_asset_ids: {
            type: 'string',
            description: '可选；逗号分隔的 asset id 列表（来自 read_inner_status 的 deliverables[].asset_id）。无效 id 会被静默剔除。',
          },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_goal',
      description:
        '向内脑派发新任务，**每次调用会创建新的独立工作区与 instance_id**（一次性任务、KPI 的**第一次**尝试）。' +
        '请确认用户明确要求开始新任务后再调用。\n\n' +
        '【持续 / 周期 / 监督类目标】只调用一次 set_goal，在 goal 正文写明检查周期与交付物，' +
        '要求内脑用 wait_timer 或 [cyclic:N] 自行排期；**禁止**用「第二轮/第三轮监督检查」再 set_goal。' +
        '续跑前用 read_inner_status 看 async.is_async_waiting；若在等定时则勿重复派发。\n\n' +
        '【KPI 模式】若该任务是长期 KPI 的**首次** burst，传入 kpi_id；同 KPI 共享反思与失败记忆。' +
        '后续换路线才可再 set_goal（新尝试），不要用同主题多 instance 模拟多轮。',
      parameters: {
        type: 'object',
        properties: {
          goal: {
            type: 'string',
            description: '任务目标描述（Markdown），内脑将根据此目标执行',
          },
          origin_user: {
            type: 'string',
            description: '下达此目标的用户 SID（用于通知路由）',
          },
          origin_thread: {
            type: 'string',
            description: '下达任务时所在的 thread_id，群聊时必须填写',
          },
          kpi_id: {
            type: 'string',
            description: '（可选）关联的 KPI ID。同一 KPI 的多次 burst 共享反思 / 失败记忆。',
          },
        },
        required: ['goal'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_kpi',
      description:
        '创建一个长期 KPI（关键绩效目标）——给你一个总目标，让你用一切手段去达成。' +
        '与 set_goal 区别：set_goal 派一个一次性 burst，KPI 是长期挂着的"探索目标"，' +
        '它本身不直接执行，但会作为多个 set_goal burst 的共同身份，让这些 burst 共享反思 / 失败记忆。\n\n' +
        '典型用法：用户给一个高难度 / 开放式目标时（如"通过 X 拿到 Y"），先 set_kpi 创建身份，' +
        '然后再调 set_goal 并传入 kpi_id 派发第一个尝试 burst；第一个 burst 跑完如果没成，' +
        '系统会自动让你（或你 set_goal）派下一个换方向的 burst。\n\n' +
        '连续 3 个 burst 都 idle 无产出会自动触发"反思 burst"，让 agent 自评 KPI 是否卡死并建议新方向。',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'KPI 自然语言描述，例如："通过任意手段查到 X 的手机号"',
          },
          created_by: {
            type: 'string',
            description: '（可选）创建者 SID，默认 agent 自身',
          },
          notes: {
            type: 'string',
            description: '（可选）附加约束或提示，会进入后续 burst 的 constraints',
          },
        },
        required: ['description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_kpis',
      description: '列出当前 agent 的所有 KPI，可按 status 过滤（active/paused/achieved/abandoned）。',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: '可选状态过滤：active / paused / achieved / abandoned',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'view_kpi',
      description: '查看 KPI 详情：描述、状态、关联 burst 列表、反思链路。',
      parameters: {
        type: 'object',
        properties: {
          kpi_id: { type: 'string', description: 'KPI ID' },
        },
        required: ['kpi_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'abandon_kpi',
      description:
        '放弃一个 KPI（标记为 abandoned）。仅在确实判定不可达 / 用户撤销时调用。' +
        '反思 burst 经常会建议放弃 KPI——如果你在反思 burst 中执行，应该用这个工具。',
      parameters: {
        type: 'object',
        properties: {
          kpi_id: { type: 'string', description: 'KPI ID' },
          reason: { type: 'string', description: '放弃原因（写给未来的自己看）' },
        },
        required: ['kpi_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'achieve_kpi',
      description:
        '标记 KPI 已达成。需要附带证据（evidence）说明为什么算达成。' +
        '只有真正拿到目标产物 / 信息时才调用。',
      parameters: {
        type: 'object',
        properties: {
          kpi_id: { type: 'string', description: 'KPI ID' },
          evidence: { type: 'string', description: '达成证据' },
        },
        required: ['kpi_id', 'evidence'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_self_update',
      description:
        '启动一个受控的自我更新任务。' +
        '与普通 set_goal 不同：必须提供验证命令 verify_commands，' +
        '默认更新范围为整个 repoRoot，' +
        '内脑会进入受控 self-update 模式，仓库文件修改会被自动备份，可在验证失败时回滚。',
      parameters: {
        type: 'object',
        properties: {
          goal: {
            type: 'string',
            description: '更新目标描述（只做更新，不做问题发现）',
          },
          verify_commands: {
            type: 'string',
            description: '必填：换行分隔的验证命令列表，在 repo 根目录执行，如 "npm run build\\nnpm test -- foo.test.ts"',
          },
          origin_user: {
            type: 'string',
            description: '下达此更新任务的用户 SID（用于通知路由）',
          },
          origin_thread: {
            type: 'string',
            description: '下达更新任务时所在的 thread_id',
          },
        },
        required: ['goal', 'verify_commands'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_inner_brains',
      description:
        '列出所有内脑任务实例。含 registry_status、阶段、里程碑，以及 async 字段' +
        '（is_async_waiting、next_wake_at、active_pendings、is_post_complete）。' +
        '派发新任务前先看是否已有同 KPI 实例在等定时。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_inner_brain',
      description:
        '停止内脑任务实例（含 AWAITING/ask_user 挂起中）。传入 instance_id 停止指定实例，不传则停止所有可停实例。' +
        '适用于：用户放弃任务、任务卡住、ask_user 等回复时需要彻底终止。',
      parameters: {
        type: 'object',
        properties: {
          instance_id: {
            type: 'string',
            description: '要停止的实例 ID（由 set_goal 或 list_inner_brains 返回）。不填则停止所有。',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_directive',
      description:
        '向指定内脑实例发送即时指令（补充约束/要求/反馈）。目标实例可为 RUNNING 或 AWAITING' +
        '（等定时/等回复时可用 feedback resolve ask_user pending）。\n' +
        '- "constraint": 补充约束\n' +
        '- "requirement": 补充任务要求\n' +
        '- "feedback": 用户反馈或解封回复\n' +
        '只有一个 RUNNING/AWAITING 实例时 instance_id 可省略。',
      parameters: {
        type: 'object',
        properties: {
          instance_id: {
            type: 'string',
            description: '目标实例 ID。有多个运行实例时必填。',
          },
          type: {
            type: 'string',
            description: '"constraint" | "requirement" | "feedback"',
          },
          content: {
            type: 'string',
            description: '指令内容',
          },
        },
        required: ['type', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_time',
      description: '获取当前时间（ISO 8601 格式）。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_thread',
      description:
        '搜索指定对话线程的历史消息。用于查询群聊记录或回顾私信上下文。' +
        'thread_id 来自系统提示中的已知对话频道列表。',
      parameters: {
        type: 'object',
        properties: {
          thread_id: { type: 'string', description: '要搜索的 thread_id' },
          query:     { type: 'string', description: '关键词（空格分隔，留空返回最近 N 条）' },
          limit:     { type: 'string', description: '返回条数上限（默认 10，最多 30）' },
        },
        required: ['thread_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        '读取内脑 workspace 目录下的文本文件。常用：relative_path=.brain/goal.md 查目标；' +
        'relative_path=.run/status.json 查状态；relative_path=.run/pi-mono/output 查输出。',
      parameters: {
        type: 'object',
        properties: {
          instance_id:   { type: 'string', description: '内脑实例 ID（必填）' },
          relative_path: { type: 'string', description: '相对于 workspace 根的路径，禁止使用 ..' },
          max_bytes:     { type: 'string', description: '最多读取字节数（默认 262144）' },
          tail_lines:    { type: 'string', description: '只返回最后 N 行（适合大 output 文件）' },
        },
        required: ['instance_id', 'relative_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_file',
      description:
        '将已经登记为 chat IR 资产的文件作为附件发给用户。\n' +
        '只接受 asset id（裸 UUID，可带 `asset:` 前缀），不再接受文件路径。\n' +
        '通常用法：先调 read_inner_status 拿 deliverables[].asset_id，再用此工具跨 thread 发送。\n' +
        '协议：doc/protocols/inner-brain-deliverables.md §6.6（v1 起 file_paths 参数已废弃）。',
      parameters: {
        type: 'object',
        properties: {
          thread_id: { type: 'string', description: '目标 thread_id' },
          asset_ids: { type: 'string', description: '逗号分隔的 asset id 列表（来自 read_inner_status 的 deliverables[].asset_id）' },
          caption:   { type: 'string', description: '随附说明文字（可选）' },
        },
        required: ['thread_id', 'asset_ids'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_memory',
      description:
        '读取外脑记忆：每日对话日志（过去几天的摘要）和当前任务状态（tasks）。' +
        '用于了解自己最近做了什么、当前有哪些进行中的任务，避免重复派发相同任务。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_tasks',
      description:
        '更新当前任务状态（自由形式 Markdown）。' +
        '用于记录正在进行的任务、计划事项、已完成事项。下次心跳和对话会自动读取。' +
        '内容会覆盖旧状态，建议保留完整的任务列表。',
      parameters: {
        type: 'object',
        properties: {
          tasks_markdown: {
            type: 'string',
            description: '新的任务状态 Markdown 内容，将完全替换旧内容',
          },
        },
        required: ['tasks_markdown'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_performance_goals',
      description:
        '读取绩效目标列表、当前评分卡、最近动作与建议动作。' +
        '用于回答“当前长期自驱目标是什么/现在状态如何”等问题。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manage_performance_goal',
      description:
        '创建或调整绩效目标。只在用户明确要求新增/暂停/恢复/归档/删除这类长期目标时调用，不要自行扩增目标集合。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'create | update | pause | resume | complete | archive | delete',
            enum: ['create', 'update', 'pause', 'resume', 'complete', 'archive', 'delete'],
          },
          goal_id: {
            type: 'string',
            description: '目标 ID；create 时可省略，其余动作通常必填',
          },
          title: {
            type: 'string',
            description: '目标标题（可选）',
          },
          goal_text: {
            type: 'string',
            description: '目标内容（create 时建议填写）',
          },
          target_sids: {
            type: 'string',
            description: '目标用户 SID 列表，逗号或换行分隔',
          },
          target_thread_id: {
            type: 'string',
            description: '目标线程 ID；传空字符串可清空',
          },
          priority: {
            type: 'string',
            description: '优先级（数字，默认 50）',
          },
          review_interval_ms: {
            type: 'string',
            description: '审阅间隔毫秒数',
          },
          min_action_cooldown_ms: {
            type: 'string',
            description: '动作冷却毫秒数',
          },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_inner_status',
      description:
        '查询内脑状态：阶段、产物、registry_status，以及 async（controller_mode、active_pendings、' +
        'next_wake_at、is_async_waiting、is_post_complete）。不填 instance_id 则返回所有实例摘要。',
      parameters: {
        type: 'object',
        properties: {
          instance_id: {
            type: 'string',
            description: '实例 ID（可选，不填则返回所有实例状态）',
          },
          workspace_id: {
            type: 'string',
            description: '工作区 ID（旧版兼容，优先使用 instance_id）',
          },
        },
        required: [],
      },
    },
  },
  ...MEMORY_BLOCK_TOOL_DEFS,
];

// ── 工具执行上下文 ──────────────────────────────────────────────────────────

export interface OuterToolContext {
  threadId: string;
  agentSid: string;
  workspaceId: string;
  repoRoot?: string;
  imClient: ChatIRChannel;
  /**
   * Chat IR 资产仓库（用于把内脑产物转 `asset:<uuid>`，以及 `attach_asset_ids` 解引用）。
   * 详见 `doc/protocols/inner-brain-deliverables.md`。
   */
  assetStore: ChatAssetStore;
  getEngine: (workspaceId: string) => InnerBrainEngine;
  workspaceStore: FilesystemWorkspaceStore;
  repoStore: FilesystemRepositoryStore;
  dataRoot: string;
  innerBrainRegistry?: InnerBrainRegistry;
  /** 行为日志存储（与 OuterBrain 共享，目前 OuterToolContext 内未消费，仅为兼容 heartbeat 注入） */
  actionLogStore?: unknown;
  /** KPI 注册表，用于 set_kpi / list_kpis / view_kpi / abandon_kpi / achieve_kpi 工具 */
  kpiRegistry?: KpiRegistry;
  /**
   * 派发"反思 burst"的函数；progress detector 在 idle streak 阈值触发时调用。
   * 由 index.ts 通过 ctx 注入（避免 outer-tools ↔ index 循环依赖）。
   */
  scheduleReflexionBurst?: (kpiId: string) => string | null;
  /** meta 反思后自动续跑真 burst（UTLRA_KPI_AUTO_NEXT_BURST=1） */
  scheduleNextKpiBurst?: (kpiId: string) => string | null;
  loadThreads?: () => LooseThreadStore;
  /**
   * 发消息前的跨进程新鲜度检查。
   * 返回 true 表示另一个 agent 已抢先回复，本次发送应跳过。
   */
  freshCheck?: () => Promise<boolean>;
  /** 外脑记忆层（支持 mem9 云端存储） */
  memoryStore?: OuterMemoryStore;
  /** 技能语义存储层（mem9 shared:skills 命名空间） */
  skillStore?: SkillMemoryStore;
  /** 技能 drive9 存储层（原文存储，语义检索，优先于 mem9） */
  skillDrive9Store?: SkillDrive9Store;
  /** 事实 drive9 存储层（/knowledge/shared/，方案 B） */
  knowledgeDrive9Store?: KnowledgeDrive9Store;
  /** Memory Block 存储（keychain 等结构化长期记忆） */
  memoryBlockStore?: MemoryBlockStore;
}

export interface ToolCallResult {
  /** 是否已向用户发送过消息（控制对话循环是否继续） */
  replied: boolean;
  output: string;
  /**
   * true 时通知外层对话循环立即中止。
   * 用于 freshCheck 命中：另一个 agent 已抢先处理，本次所有后续动作都应取消。
   */
  abortLoop?: boolean;
}

/**
 * 部分模型会把 @ 写成 Markdown 链 `[显示](@sid:…)`；Discord 桥只解析裸 `@昵称`。
 * 在 postMessage 前收敛为可解析的纯文本（多轮替换以吃掉外层 ** / [] 包裹）。
 */
export function normalizeAgentReplyMentionText(raw: string): string {
  let t = raw;
  for (let i = 0; i < 5; i++) {
    const next = t
      .replace(/\[([^\]]*)\]\(@sid:[^)]+?\)/g, (_full, inner: string) => {
        const cleaned = String(inner).replace(/\*/g, '').replace(/^\[+/u, '').trim();
        if (!cleaned) return '';
        const bare = cleaned.startsWith('@') ? cleaned.replace(/^@+/, '') : cleaned;
        const word = bare.split(/\s+/)[0] ?? '';
        return word ? `@${word}` : '';
      })
      .replace(/\[(@[\w\u4e00-\u9fa5-]+)\**\]/gu, '$1')
      .replace(/(@[\w\u4e00-\u9fa5-]+)\*+\]/gu, '$1');
    if (next === t) break;
    t = next;
  }
  return t;
}

// ── 工具执行函数 ────────────────────────────────────────────────────────────

function parseAssetIdsArg(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseListArg(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 选一个能写 deliverables.log 的 workspace 目录。
 *
 * 优先：当前活跃内脑实例 → 当前 workspace。仅用于 attach 校验的 warning 写入。
 */
function resolveLogDir(ctx: OuterToolContext): string {
  const reg = ctx.innerBrainRegistry;
  if (reg) {
    const active = reg.list().find((r) => r.status === 'RUNNING' || r.status === 'BLOCKED' || r.status === 'DONE');
    if (active?.workDir) return active.workDir;
  }
  return path.join(ctx.dataRoot, 'workspaces', ctx.workspaceId);
}

async function execReplyToUser(
  args: { text?: string; attach_asset_ids?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const rawText = args.text?.trim() ?? '';
  if (!rawText) return { replied: false, output: '（空消息，未发送）' };

  const text = normalizeAgentReplyMentionText(rawText);

  if (ctx.freshCheck) {
    const anotherReplied = await ctx.freshCheck();
    if (anotherReplied) {
      console.log(`[utlra][outer-tools] abort loop: another agent already replied in ${ctx.threadId}`);
      return { replied: false, output: '（另一 agent 已先回复，中止本次处理）', abortLoop: true };
    }
  }

  const assetIds = parseAssetIdsArg(args.attach_asset_ids);
  const expand = expandAttachAssetIds(assetIds, ctx.assetStore, { logDir: resolveLogDir(ctx) });
  const parts: AttachmentPart[] = expand.parts;

  await ctx.imClient.postMessage(ctx.threadId, {
    sender_sid: ctx.agentSid,
    text,
    parse_mentions: true,
    ...(parts.length > 0 ? { parts: [{ type: 'text', text }, ...parts] } : {}),
  });

  const noteAttach =
    parts.length > 0 ? `，含 ${parts.length} 个附件` : '';
  const noteReject =
    expand.rejected.length > 0 ? `（${expand.rejected.length} 个 asset id 无效，已剔除）` : '';
  return { replied: true, output: `已发送消息（${text.length} 字符${noteAttach}）${noteReject}` };
}

async function execSetGoal(
  args: { goal?: string; workspace_id?: string; origin_user?: string; origin_thread?: string; kpi_id?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const goal = args.goal?.trim() ?? '';
  if (!goal) return { replied: false, output: '（goal 为空，已跳过）' };

  if (ctx.freshCheck) {
    const anotherReplied = await ctx.freshCheck();
    if (anotherReplied) {
      console.log(`[utlra][outer-tools] skip set_goal: another agent already claimed the task in ${ctx.threadId}`);
      return { replied: false, output: '（另一 agent 已先接单，跳过内脑派发）', abortLoop: true };
    }
  }

  const registry = ctx.innerBrainRegistry;

  // ── 多内脑模式：注册表存在时，每次 set_goal 创建独立 workspace ──────────
  if (registry) {
    const instanceId = registry.generateInstanceId();
    const wsId = `task-${instanceId}`;
    ctx.workspaceStore.ensureWorkspace(wsId);
    const workDir = path.join(ctx.dataRoot, 'workspaces', wsId);
    const originUser = args.origin_user?.trim() || ctx.agentSid;
    const originThread = args.origin_thread?.trim() || ctx.threadId;

    // KPI 关联（可选）：校验 kpi_id 有效再挂；无效则忽略不报错，避免误用阻塞任务派发
    const kpiId = args.kpi_id?.trim() || undefined;
    const kpi = kpiId && ctx.kpiRegistry ? ctx.kpiRegistry.get(kpiId) : null;
    if (kpiId && !kpi) {
      console.warn(`[utlra][outer-tools] set_goal kpi_id=${kpiId} 不存在，本 burst 不挂 KPI`);
    }
    const resolvedKpiId = kpi ? kpi.kpiId : undefined;

    // 清除可能残留的停止信号
    clearStopSignal(workDir);

    // 共享上下文 seed：drive9 技能 + 本地池补充 + drive9 事实（方案 B）
    await seedInnerBrainSharedContext({
      dataRoot: ctx.dataRoot,
      workDir,
      goal,
      skillDrive9Store: ctx.skillDrive9Store,
      knowledgeDrive9Store: ctx.knowledgeDrive9Store,
      skillStore: ctx.skillStore,
    });

    let dispatchGoal = goal;
    if (resolvedKpiId && ctx.kpiRegistry) {
      const trailBlock = formatKpiReflexionBlock(ctx.kpiRegistry.recentReflexions(resolvedKpiId, 5));
      if (trailBlock) dispatchGoal = goal + trailBlock;
    }

    const eng = ctx.getEngine(wsId);
    eng.setGoal(dispatchGoal);

    const maxTicks = Math.min(10_000, Math.max(1, Number(process.env['UTLRA_PI_AUTO_MAX_TICKS'] ?? 500)));

    // 注册任务（先注册再 spawn，确保 exit handler 能访问到记录）
    const taskRecord: TaskRecord = {
      instanceId,
      workspaceId: wsId,
      workDir,
      goal: dispatchGoal,
      originUser,
      originThread,
      status: 'RUNNING',
      startedAt: new Date().toISOString(),
      ...(resolvedKpiId ? { kpiId: resolvedKpiId } : {}),
    };
    registry.register(taskRecord);
    if (resolvedKpiId && ctx.kpiRegistry) {
      ctx.kpiRegistry.attachBurst(resolvedKpiId, instanceId);
    }

    // ── 以独立子进程启动内脑，实现进程级隔离 ────────────────────────────────
    let workerPid: number;
    try {
      const { pid } = spawnInnerBrainWorker({
        instanceId,
        workspaceId: wsId,
        workDir,
        maxTicks,
        kpiId: resolvedKpiId,
        onExit: (exitCode, signal) => {
          // 子进程退出时，从 worker 状态文件读取结果并更新注册表
          const workerStatus = readWorkerStatus(workDir);
          const ticks = workerStatus?.ticks ?? 0;
          const stoppedBy = workerStatus?.stoppedBy ?? (signal ? 'stop_signal' : 'idle');
          const isError = exitCode !== 0 && signal == null;
          const isAwaiting = isBrainAwaitingAsync(workDir);

          // KPI hook（若挂 KPI 且系统注入了 scheduleReflexionBurst 才生效）
          const kpiOutcome = (resolvedKpiId && ctx.kpiRegistry && ctx.scheduleReflexionBurst)
            ? processBurstExitForKpi(
                {
                  instanceId,
                  kpiId: resolvedKpiId,
                  isReflexionBurst: taskRecord.isReflexionBurst,
                  workDir,
                  stoppedBy,
                  exitedWithError: isError,
                  isAwaiting,
                },
                {
                  kpiRegistry: ctx.kpiRegistry,
                  innerBrainRegistry: registry,
                  scheduleReflexionBurst: ctx.scheduleReflexionBurst,
                  scheduleNextKpiBurst: ctx.scheduleNextKpiBurst,
                },
              )
            : null;

          if (isError) {
            registry.update(instanceId, {
              status: 'ERROR',
              finishedAt: new Date().toISOString(),
              ticks,
              ...(kpiOutcome ? { deliverableCount: kpiOutcome.deliverableCount } : {}),
              errorMessage: workerStatus?.error ?? `子进程退出码 ${String(exitCode)}`,
            });
            console.error(`[utlra][outer-tools] inner burst error (${instanceId}): exitCode=${String(exitCode)}`);
            return;
          }

          const finalStatus =
            (signal != null || stoppedBy === 'stop_signal') ? 'STOPPED'
            : isAwaiting ? 'AWAITING'
            : 'DONE';
          const status = eng.syncAfterPiMonoAuto({
            ticks,
            lastHadWork: stoppedBy !== 'idle',
            stoppedBy: stoppedBy as 'idle' | 'max_ticks' | 'stop_signal',
          });
          registry.update(instanceId, {
            status: finalStatus,
            // AWAITING 表示 burst 暂停而非结束,不写 finishedAt,等真正完成时再标
            finishedAt: finalStatus === 'AWAITING' ? undefined : new Date().toISOString(),
            ticks,
            ...(kpiOutcome ? { deliverableCount: kpiOutcome.deliverableCount } : {}),
            pid: undefined,
          });
          if (kpiOutcome?.reflexionBurstId) {
            console.log(
              `[utlra][outer-tools] kpi=${resolvedKpiId} 派发反思 burst ` +
              `${kpiOutcome.reflexionBurstId} (idleStreak=${kpiOutcome.idleStreak})`,
            );
          }

          // 知识合并（无论 DONE/STOPPED 都执行）
          mergeWorkDirSkillsToAgentPool(ctx.dataRoot, workDir);
          if (ctx.skillDrive9Store) {
            mergeWorkDirSkillsToDrive9(ctx.skillDrive9Store, workDir, ctx.agentSid);
          } else if (ctx.skillStore) {
            mergeWorkDirSkillsToMem9(ctx.skillStore, workDir, ctx.agentSid);
          }
          if (ctx.knowledgeDrive9Store) {
            mergeWorkDirKnowledgeToDrive9(ctx.knowledgeDrive9Store, workDir, ctx.agentSid);
          }

          if (finalStatus === 'DONE') {
            // 内脑 output → 外脑 mem9：自动提取工作成果为语义知识
            ctx.memoryStore?.ingestInnerOutput(workDir, wsId);
          }

          // 用户通知：onExit 是进程退出的确定性时机。
          // PushLoop 只轮询 RUNNING/BLOCKED 实例，onExit 比 poll 更及时，统一在此处理。
          const record = registry.get(instanceId);
          if (record?.originThread) {
            const lastEvent = readLastOutputEvent(workDir);

            if (lastEvent?.type === 'BLOCK') {
              // 内脑因缺能力/信息而暂停，通知用户;新架构下统一 AWAITING(pending 数据)
              registry.update(instanceId, { status: 'AWAITING' });
              void ctx.imClient.postMessage(record.originThread, {
                sender_sid: ctx.agentSid,
                text:
                  `⚠️ 内脑任务被阻塞，需要您的输入。\n\n` +
                  `**问题**：${lastEvent.question ?? lastEvent.message}\n\n` +
                  `请回复后，我会将您的答复转发给内脑继续执行。\n任务 ID：\`${instanceId}\``,
              }).catch((e: unknown) =>
                console.error('[utlra][outer-tools] block notify failed:', e),
              );
            } else if (finalStatus === 'DONE') {
              void notifyInnerBrainTaskComplete(
                {
                  imClient: ctx.imClient,
                  agentSid: ctx.agentSid,
                  assetStore: ctx.assetStore,
                  getEngine: ctx.getEngine,
                },
                {
                  instanceId,
                  workspaceId: wsId,
                  workDir,
                  originThread: record.originThread,
                },
              ).catch((e: unknown) =>
                console.error('[utlra][outer-tools] completion notify failed:', e),
              );
            }
          }
          console.log(
            `[utlra][outer-tools] inner burst done (${instanceId}): ticks=${ticks} finalStatus=${finalStatus} phase=${status.phase}`,
          );
        },
      });
      workerPid = pid;
    } catch (e) {
      registry.update(instanceId, {
        status: 'ERROR',
        finishedAt: new Date().toISOString(),
        errorMessage: `spawn 失败: ${String(e)}`,
      });
      console.error(`[utlra][outer-tools] spawn inner brain failed (${instanceId}):`, e);
      return {
        replied: false,
        output: `内脑启动失败（spawn error）：${String(e)}`,
      };
    }

    // 写入 pid 供存活检测和停止使用
    registry.update(instanceId, { pid: workerPid });

    return {
      replied: false,
      output: `已创建新内脑实例并启动任务。instance_id=${instanceId}，workspace=${wsId}。可用 list_inner_brains 查看状态，send_directive 发送补充指令。`,
    };
  }

  // ── 单内脑兼容模式（无注册表时） ─────────────────────────────────────────
  const wsId = args.workspace_id?.trim() || ctx.workspaceId;
  ctx.workspaceStore.ensureWorkspace(wsId);
  const workDir = path.join(ctx.dataRoot, 'workspaces', wsId);
  const eng = ctx.getEngine(wsId);
  eng.setGoal(goal);

  const maxTicks = Math.min(10_000, Math.max(1, Number(process.env['UTLRA_PI_AUTO_MAX_TICKS'] ?? 500)));
  runOpenKuronekoPiMonoAuto({ workspaceId: wsId, workDir, maxTicks }).then((result) => {
    if (!result.ok) {
      console.error(`[utlra][outer-tools] inner burst error: ${result.error}`);
      return;
    }
    const status = eng.syncAfterPiMonoAuto({
      ticks: result.ticks,
      lastHadWork: result.lastHadWork,
      stoppedBy: result.stoppedBy,
    });
    console.log(
      `[utlra][outer-tools] inner burst done: ticks=${result.ticks} stoppedBy=${result.stoppedBy} phase=${status.phase}`,
    );
  }).catch((e) => {
    console.error('[utlra][outer-tools] inner burst error', e);
  });

  return { replied: false, output: `已向内脑派发任务，内脑开始异步执行。可通过 read_inner_status 查看进展。` };
}

async function execStartSelfUpdate(
  args: { goal?: string; verify_commands?: string; origin_user?: string; origin_thread?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const goal = args.goal?.trim() ?? '';
  if (!goal) return { replied: false, output: 'goal 不能为空。' };

  const verifyCommands = parseListArg(args.verify_commands);
  if (verifyCommands.length === 0) return { replied: false, output: 'verify_commands 不能为空。' };

  const repoRoot = ctx.repoRoot?.trim();
  if (!repoRoot) {
    return { replied: false, output: 'repoRoot 未注入，无法启动 self-update 任务。' };
  }

  const registry = ctx.innerBrainRegistry;
  if (!registry) {
    return { replied: false, output: 'self-update 仅支持多内脑模式（需要 innerBrainRegistry）。' };
  }

  if (ctx.freshCheck) {
    const anotherReplied = await ctx.freshCheck();
    if (anotherReplied) {
      return { replied: false, output: '（另一 agent 已先接单，跳过 self-update 派发）', abortLoop: true };
    }
  }

  const instanceId = registry.generateInstanceId();
  const wsId = `task-${instanceId}`;
  ctx.workspaceStore.ensureWorkspace(wsId);
  const workDir = path.join(ctx.dataRoot, 'workspaces', wsId);
  const originUser = args.origin_user?.trim() || ctx.agentSid;
  const originThread = args.origin_thread?.trim() || ctx.threadId;

  clearStopSignal(workDir);
  initSelfUpdateSession(workDir, {
    repoRoot,
    verifyCommands,
  });

  const updateGoal = [
    `# Self Update Task`,
    ``,
    goal,
    ``,
    `## 更新约束（系统注入）`,
    `- 只做更新，不做问题发现或范围外重构`,
    `- 默认更新范围：整个 repoRoot（${repoRoot}）`,
    `- 完成代码修改后必须执行 verify_self_update`,
    `- 如果 verify_self_update 失败且不能快速修复，执行 rollback_self_update 并停止`,
    `- 产出 self-update-report.md，并用 register_deliverable 登记`,
  ].join('\n');

  const eng = ctx.getEngine(wsId);
  eng.setGoal(updateGoal);

  const maxTicks = Math.min(10_000, Math.max(1, Number(process.env['UTLRA_PI_AUTO_MAX_TICKS'] ?? 500)));

  registry.register({
    instanceId,
    workspaceId: wsId,
    workDir,
    goal: updateGoal,
    originUser,
    originThread,
    status: 'RUNNING',
    startedAt: new Date().toISOString(),
  });

  let workerPid: number;
  try {
    const { pid } = spawnInnerBrainWorker({
      instanceId,
      workspaceId: wsId,
      workDir,
      maxTicks,
      onExit: (exitCode, signal) => {
        const workerStatus = readWorkerStatus(workDir);
        const ticks = workerStatus?.ticks ?? 0;
        const stoppedBy = workerStatus?.stoppedBy ?? (signal ? 'stop_signal' : 'idle');
        const isError = exitCode !== 0 && signal == null;

        if (isError) {
          registry.update(instanceId, {
            status: 'ERROR',
            finishedAt: new Date().toISOString(),
            ticks,
            errorMessage: workerStatus?.error ?? `子进程退出码 ${String(exitCode)}`,
          });
          return;
        }

        const finalStatus = (signal != null || stoppedBy === 'stop_signal') ? 'STOPPED' : 'DONE';
        const status = eng.syncAfterPiMonoAuto({
          ticks,
          lastHadWork: stoppedBy !== 'idle',
          stoppedBy: stoppedBy as 'idle' | 'max_ticks' | 'stop_signal',
        });
        registry.update(instanceId, {
          status: finalStatus,
          finishedAt: new Date().toISOString(),
          ticks,
          pid: undefined,
        });

        mergeWorkDirSkillsToAgentPool(ctx.dataRoot, workDir);
        if (ctx.skillDrive9Store) {
          mergeWorkDirSkillsToDrive9(ctx.skillDrive9Store, workDir, ctx.agentSid);
        } else if (ctx.skillStore) {
          mergeWorkDirSkillsToMem9(ctx.skillStore, workDir, ctx.agentSid);
        }
        if (ctx.knowledgeDrive9Store) {
          mergeWorkDirKnowledgeToDrive9(ctx.knowledgeDrive9Store, workDir, ctx.agentSid);
        }

        if (finalStatus === 'DONE') {
          ctx.memoryStore?.ingestInnerOutput(workDir, wsId);
        }

        const record = registry.get(instanceId);
        if (record?.originThread && finalStatus === 'DONE') {
          void notifyInnerBrainTaskComplete(
            {
              imClient: ctx.imClient,
              agentSid: ctx.agentSid,
              assetStore: ctx.assetStore,
              getEngine: ctx.getEngine,
            },
            {
              instanceId,
              workspaceId: wsId,
              workDir,
              originThread: record.originThread,
            },
          ).catch(() => {});
        }

        console.log(
          `[utlra][outer-tools] self-update done (${instanceId}): ticks=${ticks} finalStatus=${finalStatus} phase=${status.phase}`,
        );
      },
    });
    workerPid = pid;
  } catch (e) {
    registry.update(instanceId, {
      status: 'ERROR',
      finishedAt: new Date().toISOString(),
      errorMessage: `spawn 失败: ${String(e)}`,
    });
    return { replied: false, output: `self-update 启动失败：${String(e)}` };
  }

  registry.update(instanceId, { pid: workerPid });
  return {
    replied: false,
    output:
      `已启动受控 self-update 任务。instance_id=${instanceId}，workspace=${wsId}。` +
      `更新范围=整个 repoRoot。可用 read_inner_status 查看 selfUpdate 状态。`,
  };
}

// ── KPI 工具实现 ────────────────────────────────────────────────────────────

function execSetKpi(
  args: { description?: string; created_by?: string; notes?: string },
  ctx: OuterToolContext,
): ToolCallResult {
  if (!ctx.kpiRegistry) return { replied: false, output: '（KPI 注册表未启用）' };
  const description = args.description?.trim() ?? '';
  if (!description) return { replied: false, output: '（description 为空，已跳过）' };
  const createdBy = args.created_by?.trim() || ctx.agentSid;
  const kpi = ctx.kpiRegistry.create({
    description,
    createdBy,
    ...(args.notes?.trim() ? { notes: args.notes.trim() } : {}),
  });
  return {
    replied: false,
    output: `KPI 已创建：kpi_id=${kpi.kpiId}\n描述：${kpi.description}\n` +
      `下一步：调用 set_goal 并传入 kpi_id=${kpi.kpiId} 派发第一个尝试 burst。`,
  };
}

function execListKpis(
  args: { status?: string },
  ctx: OuterToolContext,
): ToolCallResult {
  if (!ctx.kpiRegistry) return { replied: false, output: '（KPI 注册表未启用）' };
  const allowed = ['active', 'paused', 'achieved', 'abandoned'] as const;
  const status = (args.status as typeof allowed[number] | undefined);
  const filter = status && allowed.includes(status) ? { status } : undefined;
  const kpis = ctx.kpiRegistry.list(filter);
  if (kpis.length === 0) {
    return { replied: false, output: status ? `（无 ${status} 状态的 KPI）` : '（暂无 KPI）' };
  }
  const lines = kpis.map((k) => {
    const flag = k.status === 'active' ? '●' : k.status === 'paused' ? '⏸' : k.status === 'achieved' ? '✓' : '✗';
    let hint = '';
    if (k.status === 'active' && ctx.innerBrainRegistry) {
      const { action } = suggestKpiAction(k, buildKpiBurstLinks(k, ctx.innerBrainRegistry));
      hint = ` →${action}`;
    }
    return `${flag} ${k.kpiId} [${k.status}] bursts=${k.bursts.length} idle=${k.consecutiveIdleBursts}${hint} | ${k.description.slice(0, 80)}`;
  });
  return { replied: false, output: `KPI 列表（${kpis.length} 条）：\n${lines.join('\n')}` };
}

function execViewKpi(
  args: { kpi_id?: string },
  ctx: OuterToolContext,
): ToolCallResult {
  if (!ctx.kpiRegistry) return { replied: false, output: '（KPI 注册表未启用）' };
  const id = args.kpi_id?.trim() ?? '';
  if (!id) return { replied: false, output: '（kpi_id 为空）' };
  const k = ctx.kpiRegistry.get(id);
  if (!k) return { replied: false, output: `（KPI ${id} 不存在）` };
  const digest = formatKpiDigest(k, ctx.innerBrainRegistry);
  const recent = ctx.kpiRegistry.recentReflexions(id, 5);
  const reflexionText = recent.length === 0
    ? '（暂无 reflexion）'
    : recent.map((r, i) => {
        return [
          `第 ${i + 1} 次（${r.ts.slice(0, 16)}, verdict=${r.verdict}）`,
          r.hardFailures.length > 0 ? `  硬失败：${r.hardFailures.join('；')}` : '',
          r.softFailures.length > 0 ? `  软失败：${r.softFailures.join('；')}` : '',
          r.nextStrategy ? `  换向建议：${r.nextStrategy}` : '',
        ].filter(Boolean).join('\n');
      }).join('\n\n');
  return {
    replied: false,
    output: [digest, '', '反思链（最近 5 条）：', reflexionText].join('\n'),
  };
}

function execAbandonKpi(
  args: { kpi_id?: string; reason?: string },
  ctx: OuterToolContext,
): ToolCallResult {
  if (!ctx.kpiRegistry) return { replied: false, output: '（KPI 注册表未启用）' };
  const id = args.kpi_id?.trim() ?? '';
  const k = ctx.kpiRegistry.get(id);
  if (!k) return { replied: false, output: `（KPI ${id} 不存在）` };
  ctx.kpiRegistry.abandon(id, args.reason);
  return { replied: false, output: `KPI ${id} 已标记为 abandoned。` };
}

function execAchieveKpi(
  args: { kpi_id?: string; evidence?: string },
  ctx: OuterToolContext,
): ToolCallResult {
  if (!ctx.kpiRegistry) return { replied: false, output: '（KPI 注册表未启用）' };
  const id = args.kpi_id?.trim() ?? '';
  const evidence = args.evidence?.trim() ?? '';
  if (!evidence) return { replied: false, output: '（必须提供 evidence 证明已达成）' };
  const k = ctx.kpiRegistry.get(id);
  if (!k) return { replied: false, output: `（KPI ${id} 不存在）` };
  ctx.kpiRegistry.markAchieved(id, evidence);
  return { replied: false, output: `KPI ${id} 已标记为 achieved。证据：${evidence.slice(0, 200)}` };
}

function execListInnerBrains(
  _args: Record<string, unknown>,
  ctx: OuterToolContext,
): ToolCallResult {
  const registry = ctx.innerBrainRegistry;
  if (!registry) {
    return { replied: false, output: '（多内脑注册表未启用）' };
  }

  const all = registry.list();
  if (!all.length) {
    return { replied: false, output: '当前没有内脑任务实例（使用 set_goal 启动新任务）。' };
  }

  const result = all.map((r) => {
    // 读取 Pi-mono 运行时状态文件
    const statusFile = path.join(r.workDir, '.run', 'status.json');
    let runtimeStatus: Record<string, unknown> | null = null;
    if (fs.existsSync(statusFile)) {
      try {
        runtimeStatus = JSON.parse(fs.readFileSync(statusFile, 'utf8')) as Record<string, unknown>;
      } catch { /* ignore */ }
    }

    // 读取里程碑进度
    const milestonesFile = path.join(r.workDir, '.brain', 'milestones.md');
    let milestoneLines: string[] = [];
    if (fs.existsSync(milestonesFile)) {
      milestoneLines = fs.readFileSync(milestonesFile, 'utf8')
        .split('\n')
        .filter((l) => l.trim().startsWith('[M'));
    }

    const asyncSnap = buildBrainAsyncSnapshot(r.workDir);

    return {
      instance_id:   r.instanceId,
      workspace_id:  r.workspaceId,
      registry_status: r.status,
      origin_user:   r.originUser,
      origin_thread: r.originThread ?? null,
      goal:          r.goal.slice(0, 100) + (r.goal.length > 100 ? '…' : ''),
      started_at:    r.startedAt,
      finished_at:   r.finishedAt ?? null,
      ticks:         r.ticks ?? null,
      error:         r.errorMessage ?? null,
      phase:         runtimeStatus?.['phase'] ?? null,
      last_action:   runtimeStatus?.['lastAction'] ?? null,
      milestones:    milestoneLines,
      async: {
        controller_mode: asyncSnap.controller.mode,
        awaiting_reason: asyncSnap.controller.awaiting_reason,
        blocked_reason: asyncSnap.controller.blocked_reason,
        is_async_waiting: asyncSnap.is_async_waiting,
        is_post_complete: asyncSnap.is_post_complete,
        next_wake_at: asyncSnap.next_wake_at,
        active_pendings: asyncSnap.active_pendings,
      },
    };
  });

  return { replied: false, output: JSON.stringify(result, null, 2) };
}

async function execStopInnerBrain(
  args: { instance_id?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const registry = ctx.innerBrainRegistry;
  if (!registry) {
    return { replied: false, output: '（多内脑注册表未启用）' };
  }

  const instanceId = args.instance_id?.trim();

  if (instanceId) {
    const record = registry.get(instanceId);
    if (!record) {
      return { replied: false, output: `找不到实例 ${instanceId}。` };
    }
    const res = stopInnerBrainInstance(record, registry);
    if (!res.ok) {
      return { replied: false, output: res.message };
    }
    console.log(
      `[utlra][stop-inner-brain] ${instanceId} prior=${res.priorStatus} actions=${res.actions.join(',')}`,
    );
    return {
      replied: false,
      output:
        `已停止实例 ${instanceId}（原状态 ${res.priorStatus}）：${res.actions.join('；')}。` +
        (res.priorStatus === 'AWAITING' ? ' 已取消 ask_user pending 并尝试结束子进程。' : ''),
    };
  }

  const stoppable = registry.list().filter((r) => isInnerBrainStoppable(r.status));
  if (!stoppable.length) {
    return { replied: false, output: '当前没有可停止的内脑实例（RUNNING/AWAITING/BLOCKED）。' };
  }
  const summaries: string[] = [];
  for (const r of stoppable) {
    const res = stopInnerBrainInstance(r, registry);
    if (res.ok) {
      summaries.push(`${r.instanceId}(${res.priorStatus})`);
      console.log(
        `[utlra][stop-inner-brain] ${r.instanceId} prior=${res.priorStatus} actions=${res.actions.join(',')}`,
      );
    }
  }
  return {
    replied: false,
    output: `已停止 ${summaries.length} 个实例：${summaries.join(', ')}。`,
  };
}

function execSendDirective(
  args: { instance_id?: string; type?: string; content?: string },
  ctx: OuterToolContext,
): ToolCallResult {
  const registry = ctx.innerBrainRegistry;
  if (!registry) {
    return { replied: false, output: '（多内脑注册表未启用）' };
  }

  const type = args.type?.trim() ?? 'feedback';
  const content = args.content?.trim() ?? '';
  if (!content) return { replied: false, output: 'content 不能为空。' };

  const instanceId = args.instance_id?.trim();
  let targetWorkDir: string;

  if (instanceId) {
    const record = registry.get(instanceId);
    if (!record) return { replied: false, output: `找不到实例 ${instanceId}。` };
    if (record.status !== 'RUNNING' && record.status !== 'AWAITING' && record.status !== 'BLOCKED') {
      return { replied: false, output: `实例 ${instanceId} 不可接收指令（状态：${record.status}）。` };
    }
    targetWorkDir = record.workDir;
  } else {
    const candidates = registry.list().filter(
      (r) => r.status === 'RUNNING' || r.status === 'AWAITING' || r.status === 'BLOCKED',
    );
    if (!candidates.length) return { replied: false, output: '没有可接收指令的内脑实例（RUNNING/AWAITING/BLOCKED）。' };
    if (candidates.length > 1) {
      return {
        replied: false,
        output: `有多个候选实例（${candidates.map((r) => `${r.instanceId}(${r.status})`).join(', ')}），请指定 instance_id。`,
      };
    }
    targetWorkDir = candidates[0]!.workDir;
  }

  // 写入指令文件（<workDir>/.run/directives.jsonl 保留兼容）
  const directivesFile = path.join(targetWorkDir, '.run', 'directives.jsonl');
  try {
    fs.mkdirSync(path.dirname(directivesFile), { recursive: true });
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      type,
      content,
      from: ctx.agentSid,
    });
    fs.appendFileSync(directivesFile, entry + '\n', 'utf8');
  } catch (e) {
    return { replied: false, output: `写入指令失败：${e instanceof Error ? e.message : String(e)}` };
  }

  // 新架构：若内脑有 ask_user pending，把 feedback 直接 resolve 到 pending(数据驱动)
  let resolvedPendingId: string | null = null;
  if (type === 'feedback') {
    try {
      const brainDir = path.join(targetWorkDir, '.brain');
      if (fs.existsSync(path.join(brainDir, 'pendings.json'))) {
        const list = listActivePendingsSync(brainDir).filter((p) => p.kind === 'ask_user');
        const target = list.length > 0 ? list[list.length - 1] : null;
        if (target) {
          resolvePendingSync(brainDir, target.id, { result: { reply: content } });
          resolvedPendingId = target.id;
        }
      }
    } catch (e) {
      console.warn('[send_directive] resolve pending failed:', e);
    }
  }

  const suffix = resolvedPendingId ? `，并 resolve 了 pending=${resolvedPendingId}` : '';
  return { replied: false, output: `指令已写入（type=${type}）${suffix}。ChangeWatcher 将在 1s 内 spawn 新 burst。` };
}

function execReadInnerStatus(
  args: { workspace_id?: string; instance_id?: string },
  ctx: OuterToolContext,
): ToolCallResult {
  const registry = ctx.innerBrainRegistry;

  // 优先按 instance_id 查找
  const instanceId = args.instance_id?.trim();
  if (instanceId && registry) {
    const record = registry.get(instanceId);
    if (!record) return { replied: false, output: `找不到实例 ${instanceId}。` };
    try {
      const status = ctx.getEngine(record.workspaceId).readStatus();
      if (!status) return { replied: false, output: `实例 ${instanceId} 尚无状态文件。` };
      const selfUpdate = readSelfUpdateSession(record.workDir);
      const asyncSnap = buildBrainAsyncSnapshot(record.workDir);
      return {
        replied: false,
        output: JSON.stringify({
          instance_id: instanceId,
          registry_status: record.status,
          phase: status.phase,
          goalSummary: status.goalSummary,
          lastAction: status.lastAction,
          lastError: status.lastError,
          tickCount: status.tickCount,
          // R5.1：永远返回 deliverables[]（空数组也返回），让 LLM 明确"无产物"≠"看不到"。
          deliverables: status.deliverables ?? [],
          async: {
            controller_mode: asyncSnap.controller.mode,
            awaiting_reason: asyncSnap.controller.awaiting_reason,
            blocked_reason: asyncSnap.controller.blocked_reason,
            is_async_waiting: asyncSnap.is_async_waiting,
            is_post_complete: asyncSnap.is_post_complete,
            next_wake_at: asyncSnap.next_wake_at,
            active_pendings: asyncSnap.active_pendings,
          },
          selfUpdate: selfUpdate
            ? {
                status: selfUpdate.status,
                repoRoot: selfUpdate.repoRoot,
                repoScope: selfUpdate.allowedPaths.length === 0 ? 'repo_root' : 'partial',
                verifyCommands: selfUpdate.verifyCommands,
                mutations: selfUpdate.mutations,
                verifications: selfUpdate.verifications,
                lastError: selfUpdate.lastError,
              }
            : null,
        }, null, 2),
      };
    } catch (e) {
      return { replied: false, output: `读取状态失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }

  // 无注册表或无 instance_id：返回所有实例状态（有注册表时），或单 workspace（兼容旧版）
  if (registry && !args.workspace_id) {
    const all = registry.list();
    if (!all.length) return { replied: false, output: '当前没有内脑任务实例。' };
    const summary = all.map((r) => {
      let phase: string | null = null;
      let lastAction: string | null = null;
      let deliverablesCount = 0;
      let selfUpdateStatus: string | null = null;
      let selfUpdateScope: string | null = null;
      let asyncWaiting = false;
      let nextWakeAt: string | null = null;
      let postComplete = false;
      try {
        const st = ctx.getEngine(r.workspaceId).readStatus();
        phase = st?.phase ?? null;
        lastAction = st?.lastAction ?? null;
        deliverablesCount = st?.deliverables?.length ?? 0;
        const su = readSelfUpdateSession(r.workDir);
        selfUpdateStatus = su?.status ?? null;
        selfUpdateScope = su ? (su.allowedPaths.length === 0 ? 'repo_root' : 'partial') : null;
        const snap = buildBrainAsyncSnapshot(r.workDir);
        asyncWaiting = snap.is_async_waiting;
        nextWakeAt = snap.next_wake_at;
        postComplete = snap.is_post_complete;
      } catch { /* */ }
      return {
        instance_id: r.instanceId,
        registry_status: r.status,
        phase,
        lastAction,
        goal: r.goal.slice(0, 80) + (r.goal.length > 80 ? '…' : ''),
        started_at: r.startedAt,
        finished_at: r.finishedAt ?? null,
        deliverables_count: deliverablesCount,
        self_update_status: selfUpdateStatus,
        self_update_scope: selfUpdateScope,
        is_async_waiting: asyncWaiting,
        is_post_complete: postComplete,
        next_wake_at: nextWakeAt,
      };
    });
    return { replied: false, output: JSON.stringify(summary, null, 2) };
  }

  // 旧版：单 workspace
  const wsId = args.workspace_id?.trim() || ctx.workspaceId;
  try {
    const status = ctx.getEngine(wsId).readStatus();
    if (!status) return { replied: false, output: '内脑尚未启动或无状态文件。' };
    const deliverables = status.deliverables ?? [];
    const lines = [
      `阶段：${status.phase ?? '未知'}`,
      `目标摘要：${status.goalSummary?.slice(0, 200) ?? '无'}`,
      `最近动作：${status.lastAction ?? '—'}`,
      `错误：${status.lastError ?? '无'}`,
      `产物（${deliverables.length} 个）：${deliverables.length === 0 ? '无' : deliverables.map((d) => `${d.filename}#${d.asset_id}`).join(', ')}`,
    ];
    return { replied: false, output: lines.join('\n') };
  } catch (e) {
    return { replied: false, output: `读取状态失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

// ── 记忆层工具 ───────────────────────────────────────────────────────────────

async function execReadMemory(ctx: OuterToolContext): Promise<ToolCallResult> {
  const memStore = ctx.memoryStore;
  if (!memStore) {
    return { replied: false, output: '（记忆层未初始化）' };
  }
  const memory = await memStore.readMemoryContext();
  if (!memory.hasAny) {
    return {
      replied: false,
      output: '（记忆层为空。外脑对话结束后会自动写入 daily-log；可用 update_tasks 初始化任务状态。）',
    };
  }
  return { replied: false, output: memStore.formatMemoryForLlm(memory) };
}

function execUpdateTasks(
  args: { tasks_markdown?: string },
  ctx: OuterToolContext,
): ToolCallResult {
  const content = args.tasks_markdown?.trim() ?? '';
  if (!content) return { replied: false, output: 'tasks_markdown 不能为空。' };
  if (ctx.memoryStore) {
    ctx.memoryStore.writeTasks(content);
  }
  return { replied: false, output: '任务状态已更新。' };
}

function execReadPerformanceGoals(ctx: OuterToolContext): ToolCallResult {
  const engine = new PerformanceGoalEngine(ctx.dataRoot);
  const states = engine.listGoalStates({ includeArchived: false });
  if (states.length === 0) {
    return { replied: false, output: '当前没有绩效目标。' };
  }

  const lines: string[] = [];
  for (const entry of states.slice(0, 10)) {
    const { goal, scorecard } = entry;
    lines.push(`- ${goal.id} | ${goal.status} | P${goal.priority} | ${goal.title}`);
    lines.push(`  目标: ${goal.goalText}`);
    if (goal.targetSids.length > 0) lines.push(`  对象: ${goal.targetSids.join(', ')}`);
    if (goal.targetThreadId) lines.push(`  线程: ${goal.targetThreadId}`);
    if (scorecard) {
      lines.push(
        `  分数: ${scorecard.currentScore}/100 (${scorecard.trend}, confidence=${scorecard.confidence.toFixed(2)})`,
      );
      lines.push(`  建议: ${scorecard.suggestedActionType} - ${scorecard.suggestedActionSummary}`);
      if (scorecard.lastActionAt) {
        lines.push(
          `  最近动作: ${scorecard.lastActionType ?? 'unknown'} / ${scorecard.lastActionStatus ?? 'unknown'} / ${scorecard.lastActionSummary ?? '无'} @ ${scorecard.lastActionAt}`,
        );
      }
    } else {
      lines.push('  分数: 尚未审阅');
    }
  }
  return { replied: false, output: lines.join('\n') };
}

function execManagePerformanceGoal(
  args: {
    action?: string;
    goal_id?: string;
    title?: string;
    goal_text?: string;
    target_sids?: string;
    target_thread_id?: string;
    priority?: string;
    review_interval_ms?: string;
    min_action_cooldown_ms?: string;
  },
  ctx: OuterToolContext,
): ToolCallResult {
  const action = args.action?.trim() ?? '';
  const goalId = args.goal_id?.trim() ?? '';
  const engine = new PerformanceGoalEngine(ctx.dataRoot);

  const parseOptionalNumber = (raw?: string): number | undefined => {
    if (raw == null || raw.trim() === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };

  if (action === 'create') {
    const goalText = args.goal_text?.trim() ?? '';
    if (!goalText) return { replied: false, output: 'create 需要 goal_text。' };
    const created = engine.createGoal({
      title: args.title?.trim() ?? '',
      goalText,
      targetSids: parseListArg(args.target_sids),
      targetThreadId: args.target_thread_id,
      priority: parseOptionalNumber(args.priority),
      reviewIntervalMs: parseOptionalNumber(args.review_interval_ms),
      minActionCooldownMs: parseOptionalNumber(args.min_action_cooldown_ms),
    });
    return {
      replied: false,
      output: `已创建绩效目标：${created.id} | ${created.status} | ${created.title}`,
    };
  }

  if (!goalId) {
    return { replied: false, output: '该动作需要 goal_id。' };
  }

  if (action === 'delete') {
    const deleted = engine.deleteGoal(goalId);
    return {
      replied: false,
      output: deleted ? `已删除绩效目标 ${goalId}。` : `找不到绩效目标 ${goalId}。`,
    };
  }

  const statusMap: Record<string, 'paused' | 'active' | 'completed' | 'archived'> = {
    pause: 'paused',
    resume: 'active',
    complete: 'completed',
    archive: 'archived',
  };

  const updated = engine.updateGoal(goalId, {
    ...(action in statusMap ? { status: statusMap[action]! } : {}),
    ...(args.title !== undefined ? { title: args.title } : {}),
    ...(args.goal_text !== undefined ? { goalText: args.goal_text } : {}),
    ...(args.target_sids !== undefined ? { targetSids: parseListArg(args.target_sids) } : {}),
    ...(args.target_thread_id !== undefined ? { targetThreadId: args.target_thread_id } : {}),
    ...(parseOptionalNumber(args.priority) !== undefined
      ? { priority: parseOptionalNumber(args.priority) }
      : {}),
    ...(parseOptionalNumber(args.review_interval_ms) !== undefined
      ? { reviewIntervalMs: parseOptionalNumber(args.review_interval_ms) }
      : {}),
    ...(parseOptionalNumber(args.min_action_cooldown_ms) !== undefined
      ? { minActionCooldownMs: parseOptionalNumber(args.min_action_cooldown_ms) }
      : {}),
  });

  if (!updated) {
    return { replied: false, output: `找不到绩效目标 ${goalId}。` };
  }

  return {
    replied: false,
    output: `已更新绩效目标：${updated.id} | ${updated.status} | ${updated.title}`,
  };
}

// ── 新增工具执行函数 ─────────────────────────────────────────────────────────

function execGetTime(): ToolCallResult {
  return { replied: false, output: new Date().toISOString() };
}

function execSearchThread(
  args: { thread_id?: string; query?: string; limit?: string },
  ctx: OuterToolContext,
): ToolCallResult {
  const threadId = args.thread_id?.trim() ?? '';
  if (!threadId) return { replied: false, output: 'thread_id 不能为空。' };

  if (!ctx.loadThreads) {
    return { replied: false, output: '（search_thread: loadThreads 未注入）' };
  }

  const data  = ctx.loadThreads();
  const msgs  = data.messages[threadId] ?? [];
  const limit = Math.min(Number(args.limit ?? 10), 30);
  const query = args.query?.trim() ?? '';

  const parsed = msgs
    .map((m) => {
      const r = MessageRecordSchema.safeParse(m);
      return r.success ? r.data : null;
    })
    .filter((m): m is NonNullable<typeof m> => m !== null);

  if (!parsed.length) return { replied: false, output: `${threadId} 暂无历史记录。` };

  const filtered = query
    ? parsed.filter((m) =>
        m.parts.some(
          (p) => p.type === 'text' && p.text?.toLowerCase().includes(query.toLowerCase()),
        ),
      )
    : parsed;

  const recent = filtered.slice(-limit);
  if (!recent.length) return { replied: false, output: `在 ${threadId} 中未找到匹配"${query}"的消息。` };

  const lines = recent.map((m) => {
    const time = new Date(m.sent_at).toLocaleString('zh-CN');
    const text = m.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join(' ')
      .slice(0, 200);
    return `[${time}] ${m.sender_sid}: ${text}`;
  });

  return {
    replied: false,
    output: `${threadId} 共找到 ${recent.length} 条：\n\n${lines.join('\n')}`,
  };
}

const DEFAULT_MAX_BYTES = 256 * 1024;
const MAX_MAX_BYTES     = 2 * 1024 * 1024;

function execReadFile(
  args: { instance_id?: string; relative_path?: string; max_bytes?: string; tail_lines?: string },
  ctx: OuterToolContext,
): ToolCallResult {
  const instanceId   = args.instance_id?.trim() ?? '';
  const relativePath = args.relative_path?.trim() ?? '';
  if (!instanceId)   return { replied: false, output: 'instance_id 不能为空。' };
  if (!relativePath) return { replied: false, output: 'relative_path 不能为空。' };

  const registry = ctx.innerBrainRegistry;
  if (!registry)  return { replied: false, output: '（read_file: 多内脑注册表未启用）' };

  const record = registry.get(instanceId);
  if (!record)  return { replied: false, output: `找不到实例 ${instanceId}。` };

  // 路径安全校验：禁止 ..
  const parts = relativePath.replace(/\\/g, '/').split('/').filter((p) => p.length > 0);
  if (parts.some((p) => p === '..')) return { replied: false, output: '禁止使用 .. 路径。' };

  const abs = path.resolve(record.workDir, ...parts);
  if (!abs.startsWith(path.resolve(record.workDir))) {
    return { replied: false, output: '路径越出 workspace 范围。' };
  }

  if (!fs.existsSync(abs)) return { replied: false, output: `文件不存在：${relativePath}` };

  let maxBytes = DEFAULT_MAX_BYTES;
  if (args.max_bytes) {
    const n = parseInt(args.max_bytes, 10);
    if (!isNaN(n) && n > 0) maxBytes = Math.min(n, MAX_MAX_BYTES);
  }

  let tailLines: number | undefined;
  if (args.tail_lines) {
    const n = parseInt(args.tail_lines, 10);
    if (!isNaN(n) && n > 0) tailLines = Math.min(n, 50_000);
  }

  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return { replied: false, output: `不是普通文件：${relativePath}` };

    if (tailLines != null) {
      const readSize = Math.min(stat.size, maxBytes);
      const fd  = fs.openSync(abs, 'r');
      const buf = Buffer.alloc(readSize);
      const start = stat.size > readSize ? stat.size - readSize : 0;
      fs.readSync(fd, buf, 0, readSize, start);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n').slice(-tailLines).join('\n');
      return { replied: false, output: lines };
    }

    if (stat.size > maxBytes) {
      const fd  = fs.openSync(abs, 'r');
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, 0);
      fs.closeSync(fd);
      return {
        replied: false,
        output: buf.toString('utf8') + `\n…（已截断，文件总大小 ${stat.size} 字节）`,
      };
    }

    return { replied: false, output: fs.readFileSync(abs, 'utf8') };
  } catch (e) {
    return { replied: false, output: `读取失败：${e instanceof Error ? e.message : String(e)}` };
  }
}

async function execSendFile(
  args: { thread_id?: string; asset_ids?: string; caption?: string },
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  const threadId = args.thread_id?.trim() ?? ctx.threadId;
  const rawIds   = args.asset_ids?.trim() ?? '';
  const caption  = args.caption?.trim()   ?? '';

  if (!rawIds) {
    return {
      replied: false,
      output:
        'asset_ids 不能为空。提示：v1 起 send_file 仅接受 asset id（来自 read_inner_status 的 deliverables[].asset_id），' +
        '不再接受文件路径；详见 doc/protocols/inner-brain-deliverables.md §6.6。',
    };
  }

  const ids = rawIds.split(',').map((s) => s.trim()).filter(Boolean);
  const expand = expandAttachAssetIds(ids, ctx.assetStore, { logDir: resolveLogDir(ctx) });

  if (expand.parts.length === 0) {
    const rejectedNote = expand.rejected
      .map((r) => `${r.id}（${r.reason}）`)
      .join('；');
    return {
      replied: false,
      output: `所有 asset id 均无法解析，未发送。被剔除：${rejectedNote || '（无）'}`,
    };
  }

  const captionPart =
    caption.length > 0 ? [{ type: 'text' as const, text: caption }] : [];

  await ctx.imClient.postMessage(threadId, {
    sender_sid: ctx.agentSid,
    text: caption,
    parts: [...captionPart, ...expand.parts],
  });

  const noteReject =
    expand.rejected.length > 0 ? `（${expand.rejected.length} 个无效 id 已剔除）` : '';
  return {
    replied: true,
    output: `已向 ${threadId} 发送 ${expand.parts.length} 个附件${noteReject}。`,
  };
}

// ── 统一分发 ────────────────────────────────────────────────────────────────

export async function executeOuterTool(
  name: string,
  argsJson: string,
  ctx: OuterToolContext,
): Promise<ToolCallResult> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    args = {};
  }

  switch (name) {
    case 'reply_to_user':
      return execReplyToUser(args as { text?: string; attach_asset_ids?: string }, ctx);
    case 'set_goal':
      return execSetGoal(
        args as { goal?: string; workspace_id?: string; origin_user?: string; origin_thread?: string; kpi_id?: string },
        ctx,
      );
    case 'set_kpi':
      return execSetKpi(args as { description?: string; created_by?: string; notes?: string }, ctx);
    case 'list_kpis':
      return execListKpis(args as { status?: string }, ctx);
    case 'view_kpi':
      return execViewKpi(args as { kpi_id?: string }, ctx);
    case 'abandon_kpi':
      return execAbandonKpi(args as { kpi_id?: string; reason?: string }, ctx);
    case 'achieve_kpi':
      return execAchieveKpi(args as { kpi_id?: string; evidence?: string }, ctx);
    case 'start_self_update':
      return execStartSelfUpdate(
        args as { goal?: string; verify_commands?: string; origin_user?: string; origin_thread?: string },
        ctx,
      );
    case 'list_inner_brains':
      return execListInnerBrains(args, ctx);
    case 'stop_inner_brain':
      return execStopInnerBrain(args as { instance_id?: string }, ctx);
    case 'send_directive':
      return execSendDirective(args as { instance_id?: string; type?: string; content?: string }, ctx);
    case 'get_time':
      return execGetTime();
    case 'search_thread':
      return execSearchThread(args as { thread_id?: string; query?: string; limit?: string }, ctx);
    case 'read_file':
      return execReadFile(
        args as { instance_id?: string; relative_path?: string; max_bytes?: string; tail_lines?: string },
        ctx,
      );
    case 'send_file':
      return execSendFile(args as { thread_id?: string; asset_ids?: string; caption?: string }, ctx);
    case 'read_inner_status':
      return execReadInnerStatus(args as { workspace_id?: string; instance_id?: string }, ctx);
    case 'read_memory':
      return execReadMemory(ctx);
    case 'update_tasks':
      return execUpdateTasks(args as { tasks_markdown?: string }, ctx);  // sync: updates cache immediately
    case 'read_performance_goals':
      return execReadPerformanceGoals(ctx);
    case 'manage_performance_goal':
      return execManagePerformanceGoal(
        args as {
          action?: string;
          goal_id?: string;
          title?: string;
          goal_text?: string;
          target_sids?: string;
          target_thread_id?: string;
          priority?: string;
          review_interval_ms?: string;
          min_action_cooldown_ms?: string;
        },
        ctx,
      );
    default: {
      const mb = await dispatchMemoryBlockTool(name, args, ctx);
      if (mb) return mb;
      return { replied: false, output: `未知工具：${name}` };
    }
  }
}

interface OutputEvent {
  type: 'BLOCK' | 'COMPLETE' | 'PROGRESS';
  message: string;
  question?: string;
  /**
   * COMPLETE 事件可能携带的内脑产物清单（workspace 相对路径）。
   * 详见 doc/protocols/inner-brain-deliverables.md §3。
   */
  deliverables?: string[];
}

/**
 * 从内脑 output 文件中读取最后一条有效事件（BLOCK / COMPLETE / PROGRESS）。
 * 找不到时返回 null。
 */
function readLastOutputEvent(workDir: string): OutputEvent | null {
  const outputFile = path.join(workDir, '.run', 'pi-mono', 'output');
  if (!fs.existsSync(outputFile)) return null;
  const lines = fs.readFileSync(outputFile, 'utf8').split('\n').filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as {
        type?: string;
        message?: string;
        question?: string;
        deliverables?: unknown;
      };
      if (obj.type && obj.message) {
        const deliverables = Array.isArray(obj.deliverables)
          ? obj.deliverables.filter((x): x is string => typeof x === 'string')
          : undefined;
        return {
          type: obj.type as OutputEvent['type'],
          message: obj.message,
          question: obj.question,
          ...(deliverables ? { deliverables } : {}),
        };
      }
    } catch { /* not JSON */ }
    if (line.startsWith('[BLOCK]'))    return { type: 'BLOCK',    message: line.replace('[BLOCK]', '').trim(),    question: line.replace('[BLOCK]', '').trim() };
    if (line.startsWith('[COMPLETE]')) return { type: 'COMPLETE', message: line.replace('[COMPLETE]', '').trim() };
    if (line.startsWith('[PROGRESS]')) return { type: 'PROGRESS', message: line.replace('[PROGRESS]', '').trim() };
  }
  return null;
}

/** 默认工作区 ID */
export function resolveWorkspaceId(): string {
  return process.env['UTLRA_OUTER_WORKSPACE_ID']?.trim() || 'default';
}

/** 解析 agent 自身的 IM sid */
export function resolveAgentSid(): string {
  return process.env['UTLRA_AGENT_IM_SID']?.trim() || resolvePrimaryAgentSid();
}
