/**
 * Discord 桥环境配置解析。
 *
 * 必填：DISCORD_BOT_TOKEN
 * 可选：
 *   DISCORD_APPLICATION_ID            (slash command 用，第一版未启用)
 *   DISCORD_GUILDS                    (逗号分隔白名单 guild_id；为空 = 不限)
 *   DISCORD_BRIDGE_INGEST             (mention_only | all；用户已选 "all")
 *   DISCORD_BRIDGE_DOWNLOAD_ATTACHMENTS (1/0；默认 1，下载到 ChatAssetStore)
 *   DISCORD_BRIDGE_BACKFILL           (1/0；默认 0，启动时不拉历史)
 *   DISCORD_BRIDGE_TENANT             (写入 ThreadRecord.tenant_id；默认 default)
 */

export interface DiscordBridgeConfig {
  token: string;
  applicationId?: string;
  guildAllowlist: string[];
  ingest: 'mention_only' | 'all';
  downloadAttachments: boolean;
  backfill: boolean;
  tenant: string;
}

export function loadDiscordBridgeConfig(): DiscordBridgeConfig | null {
  const token = process.env['DISCORD_BOT_TOKEN']?.trim();
  if (!token) return null;

  const guilds = (process.env['DISCORD_GUILDS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const ingestRaw = (process.env['DISCORD_BRIDGE_INGEST'] ?? 'all').trim();
  const ingest: 'mention_only' | 'all' = ingestRaw === 'mention_only' ? 'mention_only' : 'all';

  const dl = (process.env['DISCORD_BRIDGE_DOWNLOAD_ATTACHMENTS'] ?? '1').trim();
  const bf = (process.env['DISCORD_BRIDGE_BACKFILL'] ?? '0').trim();

  return {
    token,
    applicationId: process.env['DISCORD_APPLICATION_ID']?.trim() || undefined,
    guildAllowlist: guilds,
    ingest,
    downloadAttachments: dl !== '0',
    backfill: bf === '1',
    tenant: process.env['DISCORD_BRIDGE_TENANT']?.trim() || 'default',
  };
}
