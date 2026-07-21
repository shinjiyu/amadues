/**
 * 飞书连接配置。
 *
 * 与 webchat/discord 不同：飞书**非单例**（一个 agent 可挂 N 个 app），
 * 配置不来自 .env，而由 `channelConnectionRegistry` 在热插时传入
 * （app_secret 出自 keychain，绝不落 connections.json）。
 *
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §5
 */

export interface FeishuConnectionConfig {
  /** 飞书应用 app_id（cli_ 开头）；同时用作 channel_key.scope 与 thread_id 前缀 */
  appId: string;
  /** app_secret（keychain 明文，只在内存中） */
  appSecret: string;
  /** 开放平台域名；默认国内 open.feishu.cn，Lark 国际版传 open.larksuite.com */
  domain?: string;
  /** 写入 ThreadRecord.tenant_id；默认 'default' */
  tenant?: string;
}

export const DEFAULT_FEISHU_DOMAIN = 'https://open.feishu.cn';

export function resolveFeishuDomain(config: Pick<FeishuConnectionConfig, 'domain'>): string {
  return (config.domain ?? DEFAULT_FEISHU_DOMAIN).replace(/\/+$/, '');
}
