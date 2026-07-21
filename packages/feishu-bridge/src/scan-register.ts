/**
 * ADL: feishuBridge · P4a 扫码建应用
 * path: packages/feishu-bridge/src/scan-register.ts
 * horizon.intention: 包装 @larksuiteoapi/node-sdk `registerApp`（OAuth 2.0 Device Flow，RFC 8628）：
 *   Agent 侧拿验证 URL 发给用户 → 用户飞书内扫码/打开 → 确认后返回 App ID/Secret。
 * horizon.in:  onUrlReady 回调（吐验证 URL）；可注入 registerAppImpl（单测/降级）
 * horizon.out: { appId, appSecret }（调用方负责 keychain + registry.add）
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §6.6 P4a
 *
 * 与手填 app_id/secret 的自建应用流程（channel-connection-tools `feishu_channel_add`）并存，
 * 互不影响。SDK 未安装时显式报错（与 lark-ws-event-source 同一可选依赖策略）。
 */

export interface ScanUrlInfo {
  url: string;
  expireIn: number;
}

export interface RegisterAppSdkOptions {
  onQRCodeReady: (info: ScanUrlInfo) => void;
  onStatusChange?: (info: { status: string; interval?: number }) => void;
  addons?: unknown;
  createOnly?: boolean;
  appId?: string;
  signal?: AbortSignal;
}

/** SDK `registerApp` 的结构子集（可注入假实现） */
export type RegisterAppImpl = (
  opts: RegisterAppSdkOptions,
) => Promise<{ client_id: string; client_secret: string }>;

export interface ScanRegisterOptions {
  /** 验证 URL 就绪（渲染为链接/二维码发给用户） */
  onUrlReady: (info: ScanUrlInfo) => void;
  onStatusChange?: (status: string) => void;
  /** 更新既有应用的配置（cli_ 开头）；缺省 = 只新建 */
  appId?: string;
  signal?: AbortSignal;
  /** 单测注入；缺省动态 import @larksuiteoapi/node-sdk */
  registerAppImpl?: RegisterAppImpl;
}

export interface ScanRegisterResult {
  appId: string;
  appSecret: string;
}

/**
 * 缺省 addons：在飞书「智能体应用」基础模板上增量补齐本桥所需
 * （收消息事件 + bot 发送 + reaction Typing 模拟）。
 */
export const DEFAULT_SCAN_ADDONS = {
  scopes: {
    tenant: [
      'im:message:send_as_bot',
      'im:message',
      'im:message.reaction:write',
      'im:chat:readonly',
    ],
  },
  events: ['im.message.receive_v1'],
} as const;

async function loadSdkRegisterApp(): Promise<RegisterAppImpl> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import('@larksuiteoapi/node-sdk')) as Record<string, unknown>;
  } catch {
    throw new Error(
      '扫码建应用需要可选依赖 @larksuiteoapi/node-sdk（npm i @larksuiteoapi/node-sdk）',
    );
  }
  const fn = mod['registerApp'];
  if (typeof fn !== 'function') {
    throw new Error('@larksuiteoapi/node-sdk 版本过旧：缺少 registerApp（需 ≥1.61）');
  }
  return fn as RegisterAppImpl;
}

/**
 * 走一遍扫码建应用 device flow。阻塞直到用户确认 / 拒绝 / 过期
 * （SDK 默认验证链接 600s 过期），调用方应放后台任务并自行通知用户。
 */
export async function scanRegisterFeishuApp(
  opts: ScanRegisterOptions,
): Promise<ScanRegisterResult> {
  const impl = opts.registerAppImpl ?? (await loadSdkRegisterApp());
  const result = await impl({
    onQRCodeReady: (info) => opts.onUrlReady(info),
    ...(opts.onStatusChange
      ? { onStatusChange: (info: { status: string }) => opts.onStatusChange!(info.status) }
      : {}),
    addons: DEFAULT_SCAN_ADDONS,
    // appId 传入时 SDK 走「更新既有应用」流程；否则强制只新建，避免误覆盖
    ...(opts.appId ? { appId: opts.appId } : { createOnly: true }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  const appId = result?.client_id?.trim();
  const appSecret = result?.client_secret?.trim();
  if (!appId || !appSecret) {
    throw new Error('扫码完成但未返回有效凭证（client_id/client_secret 为空）');
  }
  return { appId, appSecret };
}
