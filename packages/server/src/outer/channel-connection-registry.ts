/**
 * ADL: channelConnectionRegistry
 * path: packages/server/src/outer/channel-connection-registry.ts
 * horizon.intention: 飞书等通道非单例——N 条连接元数据 + 运行时热插；凭证只持 keychain ref
 * horizon.in:  add/remove/list（工具或 boot）；connections.json
 * horizon.out: 连接生命周期（经 FanInChatIRChannel 挂/摘）；bot binding → identityBindingIndex
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §5.2
 *
 * 本模块不 import 任何具体桥实现：每种 kind 由入口注入 `ChannelConnector`
 * （feishuBridge 落地后在 index.ts 注册 `{ feishu: feishuConnector }`）。
 * 探测失败 → 回滚，不留半开连接（ADL §5.2 热插场景第 4 条）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatIRChannel, FanInChatIRChannel, IdentityBindingIndex } from '@utlra/chat-ir';

export type ChannelConnectionStatus = 'connecting' | 'up' | 'down' | 'failed';

export interface ChannelConnectionRecord {
  connection_id: string;
  kind: string;
  /** scope（飞书 app_id 等价物） */
  app_id: string;
  /** keychain 条目引用；**绝不**存明文 secret */
  secret_ref: string;
  status: ChannelConnectionStatus;
  /** 探测成功后写入（飞书 bot open_id / union_id 等） */
  bot_native_id?: string;
  added_by_sid: string;
  added_at: string;
  last_error?: string;
}

export interface ConnectorResult {
  channel: ChatIRChannel;
  /** 机器人在该渠道的 native id；提供则 bind 到 agentSid */
  botNativeId?: string;
}

/**
 * kind → 具体桥的连接工厂。connect 内应完成凭证探测；
 * 失败抛异常（消息会作为 add 的失败原因返回给调用方）。
 */
export interface ChannelConnector {
  connect(record: ChannelConnectionRecord, secret: string): Promise<ConnectorResult>;
}

export interface ChannelConnectionRegistryDeps {
  /** connections.json 路径；null = 仅内存 */
  persistPath: string | null;
  fanIn: FanInChatIRChannel;
  connectors: Record<string, ChannelConnector | undefined>;
  /** secret_ref → 明文（通常 memoryBlockStore keychain）；null = 取不到 */
  getSecret: (secretRef: string) => Promise<string | null>;
  /** bot binding 目标（主助手 sid） */
  agentSid: string;
  /** bot key bind（可省略 = 不 bind） */
  bindingIndex?: IdentityBindingIndex | null;
  now?: () => Date;
}

export type AddConnectionResult =
  | { ok: true; record: ChannelConnectionRecord }
  | { ok: false; reason: string };

export class ChannelConnectionRegistry {
  private readonly records = new Map<string, ChannelConnectionRecord>();

  constructor(private readonly deps: ChannelConnectionRegistryDeps) {
    this.loadFromDisk();
  }

  list(): ChannelConnectionRecord[] {
    return [...this.records.values()];
  }

  get(connectionId: string): ChannelConnectionRecord | undefined {
    return this.records.get(connectionId);
  }

  /**
   * 热插一条连接：取 secret → connect 探测 → 挂 fan-in → bind bot key → 落盘。
   * 任一步失败即回滚，不留半开连接。
   */
  async add(input: {
    kind: string;
    appId: string;
    secretRef: string;
    addedBySid: string;
  }): Promise<AddConnectionResult> {
    const kind = input.kind.trim().toLowerCase();
    const appId = input.appId.trim();
    const secretRef = input.secretRef.trim();
    if (!kind || !appId || !secretRef) {
      return { ok: false, reason: 'kind/app_id/secret_ref required' };
    }
    const connector = this.deps.connectors[kind];
    if (!connector) {
      return { ok: false, reason: `no connector registered for kind=${kind}` };
    }
    for (const r of this.records.values()) {
      if (r.kind === kind && r.app_id === appId) {
        return { ok: false, reason: `connection for ${kind}/${appId} already exists (${r.connection_id})` };
      }
    }
    const secret = await this.deps.getSecret(secretRef);
    if (!secret) {
      return { ok: false, reason: `secret not found for ref=${secretRef}（先 keychain_put）` };
    }

    const record: ChannelConnectionRecord = {
      connection_id: `conn-${kind}-${randomUUID().slice(0, 8)}`,
      kind,
      app_id: appId,
      secret_ref: secretRef,
      status: 'connecting',
      added_by_sid: input.addedBySid,
      added_at: (this.deps.now?.() ?? new Date()).toISOString(),
    };

    let result: ConnectorResult;
    try {
      result = await connector.connect(record, secret);
    } catch (e) {
      // 回滚：未挂载、未落盘，直接失败返回
      return { ok: false, reason: e instanceof Error ? e.message : String(e) };
    }

    record.status = 'up';
    record.bot_native_id = result.botNativeId;
    this.deps.fanIn.addConnection(record.connection_id, result.channel);

    if (result.botNativeId && this.deps.bindingIndex) {
      try {
        this.deps.bindingIndex.bind(
          { channel: kind, native_user_id: result.botNativeId, scope: appId },
          this.deps.agentSid,
        );
      } catch (e) {
        console.warn(`[utlra][channel-registry] bot bind skipped: ${e instanceof Error ? e.message : e}`);
      }
    }

    this.records.set(record.connection_id, record);
    this.saveToDisk();
    return { ok: true, record };
  }

  /** 摘除连接：fan-in 卸载（内部 destroy channel）+ 删除记录落盘。 */
  async remove(connectionId: string): Promise<boolean> {
    const record = this.records.get(connectionId);
    if (!record) return false;
    this.deps.fanIn.removeConnection(connectionId);
    this.records.delete(connectionId);
    this.saveToDisk();
    return true;
  }

  /**
   * 启动时按落盘记录逐条重连。失败标 `down`（保留记录，允许人工修复后重试），
   * 不影响其它连接。
   */
  async bootLoad(): Promise<void> {
    for (const record of this.records.values()) {
      const connector = this.deps.connectors[record.kind];
      const secret = connector ? await this.deps.getSecret(record.secret_ref) : null;
      if (!connector || !secret) {
        record.status = 'down';
        record.last_error = !connector ? `no connector for kind=${record.kind}` : 'secret unavailable';
        continue;
      }
      try {
        const result = await connector.connect(record, secret);
        this.deps.fanIn.addConnection(record.connection_id, result.channel);
        record.status = 'up';
        if (result.botNativeId) record.bot_native_id = result.botNativeId;
        record.last_error = undefined;
      } catch (e) {
        record.status = 'down';
        record.last_error = e instanceof Error ? e.message : String(e);
        console.error(`[utlra][channel-registry] bootLoad reconnect failed ${record.connection_id}:`, e);
      }
    }
    this.saveToDisk();
  }

  private loadFromDisk(): void {
    const p = this.deps.persistPath;
    if (!p || !fs.existsSync(p)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
      if (!Array.isArray(raw)) return;
      for (const item of raw) {
        const r = item as ChannelConnectionRecord;
        if (r?.connection_id && r?.kind && r?.app_id) {
          // 磁盘上的状态是上个进程的；本进程内以 bootLoad 结果为准
          this.records.set(r.connection_id, { ...r, status: 'down' });
        }
      }
    } catch (e) {
      console.error('[utlra][channel-registry] load failed', e);
    }
  }

  private saveToDisk(): void {
    const p = this.deps.persistPath;
    if (!p) return;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(this.list(), null, 2), 'utf8');
  }
}
