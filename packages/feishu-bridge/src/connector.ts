/**
 * 飞书 `ChannelConnector`：给 `channelConnectionRegistry` 的连接工厂。
 *
 * `connect(record, secret)` 完成：
 * 1. tenant_access_token 探测（凭证错 → 抛异常，registry 回滚）
 * 2. GET bot 信息拿 bot open_id（回声过滤 + bind agentSid 用）
 * 3. 构造 FeishuChannel，入站回调 = `makeInboundHandler(record.connection_id)`
 *    （即 fanIn.makeInboundHandler，thread→connection 路由由 fan-in 记录）
 *
 * 类型与 `packages/server/src/outer/channel-connection-registry.ts` 的
 * `ChannelConnector` 结构兼容（本包不反向依赖 @utlra/server）。
 */
import type {
  ChatIRChannel,
  ChatIRInboundEvent,
  ChatIRSeenTracker,
  IdentityBindingIndex,
  IdentityRegistry,
  LooseThreadStore,
} from '@utlra/chat-ir';
import type { FeishuConnectionConfig } from './config.js';
import { FeishuApiClient } from './api-client.js';
import { FeishuChannel, type FeishuEventSource } from './feishu-channel.js';
import { createLarkWsEventSource } from './lark-ws-event-source.js';

/** registry 侧 record 的结构子集（避免依赖 @utlra/server 类型） */
export interface FeishuConnectionRecordLike {
  connection_id: string;
  app_id: string;
}

export interface FeishuConnectorDeps {
  agentSid: string;
  registry: IdentityRegistry;
  bindingIndex?: IdentityBindingIndex | null;
  seenTracker: ChatIRSeenTracker;
  loadThreads: () => LooseThreadStore;
  saveThreads: (data: LooseThreadStore) => void;
  /** 通常 = fanIn.makeInboundHandler；connector 不直接认识 fan-in */
  makeInboundHandler: (connectionId: string) => (ev: ChatIRInboundEvent) => Promise<void>;
  /** 飞书域名/tenant 缺省覆盖 */
  domain?: string;
  tenant?: string;
  /** 事件源工厂；缺省 = 飞书长连接 SDK（@larksuiteoapi/node-sdk，动态 import） */
  eventSourceFactory?: (config: FeishuConnectionConfig) => Promise<FeishuEventSource>;
  fetchImpl?: typeof fetch;
}

export function createFeishuConnector(deps: FeishuConnectorDeps): {
  connect(
    record: FeishuConnectionRecordLike,
    secret: string,
  ): Promise<{ channel: ChatIRChannel; botNativeId?: string }>;
} {
  return {
    async connect(record, secret) {
      const config: FeishuConnectionConfig = {
        appId: record.app_id,
        appSecret: secret,
        ...(deps.domain ? { domain: deps.domain } : {}),
        ...(deps.tenant ? { tenant: deps.tenant } : {}),
      };
      const api = new FeishuApiClient(
        config,
        deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {},
      );
      // 凭证探测：token + bot 信息（任一失败 = add 失败）
      await api.probe();
      const bot = await api.getBotInfo();

      const eventSource = await (deps.eventSourceFactory ?? createLarkWsEventSource)(config);

      const channel = new FeishuChannel({
        config,
        botOpenId: bot.open_id,
        agentSid: deps.agentSid,
        registry: deps.registry,
        ...(deps.bindingIndex != null ? { bindingIndex: deps.bindingIndex } : {}),
        loadThreads: deps.loadThreads,
        saveThreads: deps.saveThreads,
        seenTracker: deps.seenTracker,
        onAgentMessage: deps.makeInboundHandler(record.connection_id),
        eventSource,
        apiClient: api,
      });
      return { channel, botNativeId: bot.open_id };
    },
  };
}
