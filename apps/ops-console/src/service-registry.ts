/**
 * Ops 控制台监管的服务清单。
 *
 * 设计原则：
 *  - 每个服务对应一个独立子进程；spawn 时使用 shell 以便 npm.cmd（Windows）正常解析。
 *  - `dependsOn` 用于推荐启动顺序（UI 提示用，不强制）。
 *  - `healthUrl` 为空 = 仅靠 PID 是否存活判定 RUNNING。
 *  - `port` 用于：a) 检测外部占用；b) UI 展示。
 */
import path from 'node:path';

export interface ServiceDef {
  id: string;
  name: string;
  description: string;
  /** 命令名（npm / node 等）；spawn 时会按平台自动加 .cmd */
  cmd: string;
  args: string[];
  /** 工作目录（默认仓库根） */
  cwd: string;
  /** 主要监听端口；用于状态展示与外部占用检测 */
  port: number | null;
  /** 健康检查地址；返回 2xx 即视为 healthy。null = 不做主动健康检查 */
  healthUrl: string | null;
  /** 浏览器可点击打开的入口（UI 卡片渲染「打开」按钮）；非 UI 服务设 null */
  openUrl: string | null;
  /** 推荐先启动的服务 id 列表（UI 提示） */
  dependsOn: string[];
  /** 启动后多少 ms 内健康检查不通过仍算 STARTING（避免 npm 编译期误报 unhealthy） */
  healthGraceMs: number;
  /** Docker 等外部托管：无子进程时 stop 调用此 PowerShell 脚本（相对 repo 根） */
  stopScript?: string;
}

export function buildServiceRegistry(repoRoot: string): ServiceDef[] {
  const cwd = repoRoot;
  const ps = (rel: string) => path.join(cwd, rel);

  return [
    {
      id: 'agent-kuroneko',
      name: 'Agent: Kuroneko',
      description: '主助手（Docker，deploy/agent/env/kuroneko.env，端口 8787）',
      cmd: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps('scripts/kuroneko/start-agent-kuroneko.ps1')],
      cwd,
      port: 8787,
      healthUrl: 'http://127.0.0.1:8787/api/health',
      openUrl: null,
      dependsOn: [],
      healthGraceMs: 90_000,
      stopScript: 'scripts/kuroneko/stop-agent-kuroneko.ps1',
    },
    {
      id: 'agent-shiro',
      name: 'Agent: Shiro',
      description: '副助手（Docker，deploy/agent/env/shiro.env，端口 8788）',
      cmd: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps('scripts/kuroneko/start-agent-shiro.ps1')],
      cwd,
      port: 8788,
      healthUrl: 'http://127.0.0.1:8788/api/health',
      openUrl: null,
      dependsOn: [],
      healthGraceMs: 90_000,
      stopScript: 'scripts/kuroneko/stop-agent-shiro.ps1',
    },
    {
      id: 'agent-gin',
      name: 'Agent: Gin',
      description: '第三助手（Docker，deploy/agent/env/gin.env，端口 8789）',
      cmd: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps('scripts/kuroneko/start-agent-gin.ps1')],
      cwd,
      port: 8789,
      healthUrl: 'http://127.0.0.1:8789/api/health',
      openUrl: null,
      dependsOn: [],
      healthGraceMs: 90_000,
      stopScript: 'scripts/kuroneko/stop-agent-gin.ps1',
    },
    {
      id: 'agent-aoi',
      name: 'Agent: Aoi',
      description: '第四助手（Docker，deploy/agent/env/aoi.env，端口 8791）',
      cmd: 'powershell',
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps('scripts/kuroneko/start-agent-aoi.ps1')],
      cwd,
      port: 8791,
      healthUrl: 'http://127.0.0.1:8791/api/health',
      openUrl: null,
      dependsOn: [],
      healthGraceMs: 90_000,
      stopScript: 'scripts/kuroneko/stop-agent-aoi.ps1',
    },
    {
      id: 'dashboard',
      name: 'Dashboard',
      description: 'Vite 仪表盘（5173）',
      cmd: 'npm',
      args: ['run', 'dev:dashboard'],
      cwd,
      port: 5173,
      healthUrl: null,
      openUrl: 'http://localhost:5173/',
      dependsOn: [],
      healthGraceMs: 30_000,
    },
    {
      id: 'chat-server',
      name: 'Chat Server',
      description: '独立类 Discord 聊天服务（Hono + WS，端口 8790）— webchat 渠道后端',
      cmd: 'npm',
      args: ['run', 'dev:chat-server'],
      cwd,
      port: 8790,
      healthUrl: 'http://127.0.0.1:8790/healthz',
      openUrl: null,
      dependsOn: [],
      healthGraceMs: 30_000,
    },
    {
      id: 'web-chat',
      name: 'Web Chat',
      description: 'Vite WebChat 客户端（5180）— Discord 风格 H5 前端',
      cmd: 'npm',
      args: ['run', 'dev:web-chat'],
      cwd,
      port: 5180,
      healthUrl: null,
      openUrl: 'http://localhost:5180/',
      dependsOn: ['chat-server'],
      healthGraceMs: 30_000,
    },
  ];
}

export function resolveRepoRoot(callerDir: string): string {
  // apps/ops-console/src → repo root = ../../..
  return path.resolve(callerDir, '..', '..', '..');
}
