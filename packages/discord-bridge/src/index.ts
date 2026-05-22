/**
 * @utlra/discord-bridge —— Discord 渠道桥：`ChatIRChannel` 的 Discord 实现。
 *
 * 直接进 agent 主进程运行（无中间 IM Server），与 `IdentityRegistry` / `ChatAssetStore`
 * / `threads.json` 同源。
 *
 * 用法（agent 主进程内）：
 *   const cfg = loadDiscordBridgeConfig();
 *   if (cfg) {
 *     const channel = new DiscordChannel({
 *       config: cfg,
 *       agentSid,
 *       dataRoot,
 *       registry,
 *       assetStore,
 *       loadThreads, saveThreads,
 *       onAgentMessage: async (ev) => outerBrain.handle(ev),
 *     });
 *     channel.start();
 *   }
 */
export { loadDiscordBridgeConfig, type DiscordBridgeConfig } from './config.js';
export { DiscordChannel, type DiscordChannelOptions } from './discord-channel.js';
export { getAgentSid } from './identity-mapper.js';
