/**
 * Architecture dependency rules — derived from workspace.dsl L2 edges (tag: import).
 * See REFACTOR-PLAN.md P2 and modules-catalog.md.
 *
 * Run: npm run structurizr:deps
 */
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..');

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ── L2 libraries: no upward / sideways leakage ─────────────────────
    {
      name: 'chat-ir-no-cross-package',
      severity: 'error',
      comment: 'chatIrLib — horizon.deps: 无其它 @utlra 包',
      from: { path: '^packages/chat-ir' },
      to: {
        path: '^packages/',
        pathNot: '^packages/chat-ir',
      },
    },
    {
      name: 'webchat-protocol-no-cross-package',
      severity: 'error',
      comment: 'webchatProtocolLib — 纯协议 DTO',
      from: { path: '^packages/webchat-protocol' },
      to: {
        path: '^packages/',
        pathNot: '^packages/webchat-protocol',
      },
    },
    {
      name: 'discord-bridge-only-chat-ir',
      severity: 'error',
      comment: 'discordBridge → chatIrLib (npm import)',
      from: { path: '^packages/discord-bridge' },
      to: {
        path: '^packages/',
        pathNot: ['^packages/chat-ir', '^packages/discord-bridge'],
      },
    },
    {
      name: 'webchat-bridge-only-chat-ir-and-protocol',
      severity: 'error',
      comment: 'webchatBridge → chatIrLib + webchatProtocolLib',
      from: { path: '^packages/webchat-bridge' },
      to: {
        path: '^packages/',
        pathNot: ['^packages/chat-ir', '^packages/webchat-protocol', '^packages/webchat-bridge'],
      },
    },

    // ── Apps (WebChat path) ─────────────────────────────────────────────
    {
      name: 'web-chat-only-protocol',
      severity: 'error',
      from: { path: '^apps/web-chat' },
      to: {
        path: '^packages/',
        pathNot: '^packages/webchat-protocol',
      },
    },
    {
      name: 'chat-server-prod-only-protocol',
      severity: 'error',
      comment: 'chatServer → webchatProtocolLib; e2e tests may import bridge/chat-ir',
      from: {
        path: '^apps/chat-server/src',
        pathNot: '\\.(test|integration)\\.',
      },
      to: {
        path: '^packages/',
        pathNot: ['^packages/webchat-protocol', '^apps/chat-server'],
      },
    },

    // ── agentServer: outer 不得直 import 桥接包 ───────────────────────
    {
      name: 'outer-no-im-bridges',
      severity: 'error',
      comment: 'outerToolExecutor 等经 index 装配 Channel；禁止 outer → discord/webchat-bridge',
      from: { path: '^packages/server/src/outer' },
      to: { path: '^packages/(discord-bridge|webchat-bridge)' },
    },

    // ── workspaceKit：外脑工具包，不依赖业务面 ─────────────────────────
    {
      name: 'workspace-kit-isolated',
      severity: 'error',
      from: { path: '^packages/server/src/workspace-kit' },
      to: {
        path: '^packages/server/src/(outer|openkuroneko|pi-mono|llm|mem9|drive9)',
        pathNot: '^packages/server/src/workspace-kit',
      },
    },
    {
      name: 'workspace-kit-no-bridges',
      severity: 'error',
      from: { path: '^packages/server/src/workspace-kit' },
      to: { path: '^packages/(discord-bridge|webchat-bridge)' },
    },

    // ── innerWorker 执行面（openkuroneko + pi-mono）────────────────────
    {
      name: 'inner-no-im-bridges',
      severity: 'error',
      comment: 'innerWorker 子进程不 import 渠道桥',
      from: { path: '^packages/server/src/(openkuroneko|pi-mono)' },
      to: { path: '^packages/(discord-bridge|webchat-bridge|chat-ir)' },
    },
    {
      name: 'inner-no-workspace-kit-npm',
      severity: 'error',
      comment: 'ADL: innerWorker ↔ workspaceKit 仅 file，禁止 npm import',
      from: { path: '^packages/server/src/(openkuroneko|pi-mono)' },
      to: { path: '^packages/server/src/workspace-kit' },
    },
    {
      name: 'openkuroneko-no-outer',
      severity: 'warn',
      comment: '内脑阶段机不应依赖 outer；scheduled-task 暂例外（P3 收敛）',
      from: {
        path: '^packages/server/src/openkuroneko',
        pathNot: '^packages/server/src/openkuroneko/scheduled-task',
      },
      to: { path: '^packages/server/src/outer' },
    },

    // ── P3c：本地 repository vs mem9 / drive9 ───────────────────────────
    {
      name: 'workspace-kit-no-cloud-memory',
      severity: 'error',
      comment: 'workspaceKit 仅 workDir + 本地 repository 文件；云记忆走 outer/工具',
      from: { path: '^packages/server/src/workspace-kit' },
      to: { path: '^packages/server/src/(mem9|drive9)' },
    },
    {
      name: 'inner-no-outer-memory-modules',
      severity: 'error',
      comment: '执行轨 K/S/P 检索仅外脑 knowledgeRetrieval；内脑用 write_memo 等工具',
      from: { path: '^packages/server/src/(openkuroneko|pi-mono)' },
      to: {
        path: '^packages/server/src/outer/(knowledge-retrieval|outer-memory)\\.ts',
      },
    },
    {
      name: 'inner-no-local-repository',
      severity: 'error',
      comment: '内脑不 npm import FilesystemRepositoryStore',
      from: { path: '^packages/server/src/(openkuroneko|pi-mono)' },
      to: { path: '^packages/server/src/workspace-kit/repository' },
    },
    {
      name: 'outer-no-raw-mem9-client',
      severity: 'error',
      comment: '外脑经 outer-memory 门面访问 mem9',
      from: {
        path: '^packages/server/src/outer',
        pathNot: 'outer-memory\\.ts',
      },
      to: { path: '^packages/server/src/mem9/mem9-client' },
    },
    {
      name: 'outer-no-raw-drive9-client',
      severity: 'error',
      comment: '外脑经 outer-memory / agent-pool / skill stores 访问 drive9',
      from: {
        path: '^packages/server/src/outer',
        pathNot: '(outer-memory|agent-pool)\\.ts',
      },
      to: { path: '^packages/server/src/drive9/drive9-client' },
    },
    {
      name: 'knowledge-retrieval-local-only',
      severity: 'error',
      comment: 'knowledgeRetrieval 仅本地 repository + chat-ir',
      from: { path: '^packages/server/src/outer/knowledge-retrieval' },
      to: { path: '^packages/server/src/(mem9|drive9)' },
    },

    // ── 桥接层不得 import server 业务 ─────────────────────────────────
    {
      name: 'bridges-no-server',
      severity: 'error',
      from: { path: '^packages/(discord-bridge|webchat-bridge)' },
      to: { path: '^packages/server' },
    },
  ],

  options: {
    baseDir: repoRoot,
    doNotFollow: {
      path: 'node_modules',
    },
    exclude: {
      path: [
        'node_modules',
        '\\.d\\.ts$',
        'dist/',
        'doc/structurizr/generated/',
      ],
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
