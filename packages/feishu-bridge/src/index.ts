/**
 * @utlra/feishu-bridge —— 飞书渠道桥（非单例：一 app 连接一 FeishuChannel）。
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §5 · doc/channel-bridge-guide.md
 */
export * from './config.js';
export * from './thread-mapper.js';
export * from './identity-mapper.js';
export * from './api-client.js';
export * from './inbound.js';
export * from './feishu-channel.js';
export * from './connector.js';
export * from './lark-ws-event-source.js';
export * from './scan-register.js';
