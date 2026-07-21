/**
 * 微信 iLink `ChannelConnector`：给 `channelConnectionRegistry` 的连接工厂（kind=wechat）。
 *
 * `connect(record, secret)` 完成：
 * 1. secret = 扫码登录持久化的凭证 JSON（keychain 持有）→ 解析 token/accountId
 * 2. 探测 = 一次 getupdates（token 失效 / -14 → 抛异常，registry 回滚/标 down）；
 *    探测消费的消息 prime 进长轮询源，不丢
 * 3. 构造 WechatChannel，入站回调 = `makeInboundHandler(record.connection_id)`
 *
 * 类型与 `packages/server/src/outer/channel-connection-registry.ts` 的
 * `ChannelConnector` 结构兼容（本包不反向依赖 @utlra/server）。
 */
import fs from 'node:fs';
import path from 'node:path';
import type {
  ChatIRChannel,
  ChatIRInboundEvent,
  ChatIRSeenTracker,
  IdentityBindingIndex,
  IdentityRegistry,
  LooseThreadStore,
} from '@utlra/chat-ir';
import { parseWechatCredentials, type WechatConnectionConfig } from './config.js';
import { IlinkApiClient } from './ilink-api-client.js';
import {
  WechatChannel,
  createLongPollUpdateSource,
  memoryCursorStore,
  type WechatAssetStore,
  type WechatCursorStore,
  type WechatUpdateSource,
} from './wechat-channel.js';

export interface WechatConnectionRecordLike {
  connection_id: string;
  app_id: string;
}

export interface WechatConnectorDeps {
  agentSid: string;
  registry: IdentityRegistry;
  bindingIndex?: IdentityBindingIndex | null;
  seenTracker: ChatIRSeenTracker;
  loadThreads: () => LooseThreadStore;
  saveThreads: (data: LooseThreadStore) => void;
  /** 通常 = fanIn.makeInboundHandler */
  makeInboundHandler: (connectionId: string) => (ev: ChatIRInboundEvent) => Promise<void>;
  tenant?: string;
  /** 游标持久化目录（缺省 = 仅内存，重启后重新从最新开始） */
  cursorDir?: string;
  /** 媒体镜像/发送用资产仓库（生产 = ChatAssetStore）；缺省降级文本 */
  assetStore?: WechatAssetStore | null;
  /** 事件源工厂（单测注入）；缺省 = getupdates 长轮询 */
  updateSourceFactory?: (
    api: IlinkApiClient,
    cursor: WechatCursorStore,
    prime: import('./ilink-api-client.js').WeixinMessage[],
  ) => WechatUpdateSource;
  fetchImpl?: typeof fetch;
}

function fileCursorStore(dir: string, botId: string): WechatCursorStore {
  const file = path.join(dir, `${botId.replace(/[^a-zA-Z0-9@._-]/g, '_')}.cursor.json`);
  return {
    load() {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { get_updates_buf?: string };
        return typeof raw.get_updates_buf === 'string' ? raw.get_updates_buf : '';
      } catch {
        return '';
      }
    },
    save(buf) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ get_updates_buf: buf }), 'utf8');
      } catch (e) {
        console.warn('[wechat-bridge] cursor save failed', String(e));
      }
    },
  };
}

export function createWechatConnector(deps: WechatConnectorDeps): {
  connect(
    record: WechatConnectionRecordLike,
    secret: string,
  ): Promise<{ channel: ChatIRChannel; botNativeId?: string }>;
} {
  return {
    async connect(record, secret) {
      const creds = parseWechatCredentials(secret);
      const config: WechatConnectionConfig = {
        botId: creds.accountId,
        botToken: creds.token,
        ...(creds.baseUrl ? { baseUrl: creds.baseUrl } : {}),
        ...(creds.userId ? { ownerUserId: creds.userId } : {}),
      };
      const api = new IlinkApiClient(
        { botToken: config.botToken, ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}) },
        deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {},
      );
      const cursor = deps.cursorDir
        ? fileCursorStore(deps.cursorDir, config.botId)
        : memoryCursorStore();

      // 凭证探测：一次 getupdates（-14/401 = token 失效 → 抛异常）。
      // 探测消费的消息 prime 进事件源，避免丢失。
      const probe = await api.getUpdates(cursor.load());
      if (probe.buf) cursor.save(probe.buf);

      const updateSource = deps.updateSourceFactory
        ? deps.updateSourceFactory(api, cursor, probe.msgs)
        : createLongPollUpdateSource(api, cursor, { primeMessages: probe.msgs });

      const channel = new WechatChannel({
        config,
        agentSid: deps.agentSid,
        ...(deps.tenant ? { tenant: deps.tenant } : {}),
        registry: deps.registry,
        ...(deps.bindingIndex != null ? { bindingIndex: deps.bindingIndex } : {}),
        loadThreads: deps.loadThreads,
        saveThreads: deps.saveThreads,
        seenTracker: deps.seenTracker,
        onAgentMessage: deps.makeInboundHandler(record.connection_id),
        updateSource,
        apiClient: api,
        ...(deps.assetStore ? { assetStore: deps.assetStore } : {}),
      });
      return { channel, botNativeId: config.botId };
    },
  };
}
