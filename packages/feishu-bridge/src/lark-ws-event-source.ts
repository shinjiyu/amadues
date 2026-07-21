/**
 * 飞书长连接事件源（生产实现）：`@larksuiteoapi/node-sdk` 的 WSClient。
 *
 * SDK 是**可选依赖**（动态 import）：未安装时 start 抛出带安装指引的错误，
 * 让 `feishu_channel_add` 把原因显式回给操作者（ADL：热插失败要显式）。
 * 单测不走这里（注入 fake event source）。
 */
import type { FeishuConnectionConfig } from './config.js';
import type { FeishuEventSource } from './feishu-channel.js';
import type { FeishuInboundEvent } from './inbound.js';

export async function createLarkWsEventSource(
  config: FeishuConnectionConfig,
): Promise<FeishuEventSource> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sdk: any;
  try {
    // 非字面量 specifier：TS 不静态解析，可选依赖未安装时走 catch
    const moduleName = '@larksuiteoapi/node-sdk';
    sdk = await import(moduleName);
  } catch {
    throw new Error(
      'feishu 长连接需要 @larksuiteoapi/node-sdk：npm i @larksuiteoapi/node-sdk -w @utlra/feishu-bridge',
    );
  }

  let wsClient: { start(opts: { eventDispatcher: unknown }): void } | null = null;
  return {
    start(onEvent) {
      const dispatcher = new sdk.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: Record<string, unknown>) => {
          const ev: FeishuInboundEvent = {
            ...(typeof data['event_id'] === 'string' ? { event_id: data['event_id'] as string } : {}),
            sender: data['sender'] as FeishuInboundEvent['sender'],
            message: data['message'] as FeishuInboundEvent['message'],
          };
          await onEvent(ev);
        },
      });
      const client = new sdk.WSClient({
        appId: config.appId,
        appSecret: config.appSecret,
        loggerLevel: sdk.LoggerLevel.warn,
        ...(config.domain ? { domain: config.domain } : {}),
      }) as { start(opts: { eventDispatcher: unknown }): void };
      wsClient = client;
      client.start({ eventDispatcher: dispatcher });
    },
    stop() {
      // SDK 未提供优雅 stop；进程内丢弃引用（重连由 registry remove/add 完成）
      wsClient = null;
    },
  };
}
