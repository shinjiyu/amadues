/**
 * ADL: feishuBridge · P4a 扫码建应用（scan-register）
 * @see doc/structurizr/IDENTITY-CROSS-CHANNEL.md §6.6
 */
import { describe, expect, it } from 'vitest';
import { scanRegisterFeishuApp, type RegisterAppImpl } from './scan-register.js';

describe('scanRegisterFeishuApp', () => {
  it('happy path：URL 回调吐给调用方，完成后返回凭证', async () => {
    const urls: string[] = [];
    const fakeImpl: RegisterAppImpl = async (opts) => {
      opts.onQRCodeReady({ url: 'https://open.feishu.cn/page/launcher?user_code=AB-12', expireIn: 600 });
      return { client_id: 'cli_new123', client_secret: 's3cret' };
    };

    const result = await scanRegisterFeishuApp({
      onUrlReady: (info) => urls.push(`${info.url}|${info.expireIn}`),
      registerAppImpl: fakeImpl,
    });

    expect(urls).toEqual(['https://open.feishu.cn/page/launcher?user_code=AB-12|600']);
    expect(result).toEqual({ appId: 'cli_new123', appSecret: 's3cret' });
  });

  it('addons 缺省预填 bot 权限与 im.message.receive_v1 事件；createOnly 默认 true', async () => {
    let captured: Parameters<RegisterAppImpl>[0] | null = null;
    const fakeImpl: RegisterAppImpl = async (opts) => {
      captured = opts;
      opts.onQRCodeReady({ url: 'u', expireIn: 1 });
      return { client_id: 'cli_x', client_secret: 'y' };
    };
    await scanRegisterFeishuApp({ onUrlReady: () => {}, registerAppImpl: fakeImpl });

    expect(captured!.createOnly).toBe(true);
    const addons = captured!.addons as {
      scopes?: { tenant?: string[] };
      events?: string[];
    };
    expect(addons?.scopes?.tenant).toContain('im:message:send_as_bot');
    expect(addons?.events).toContain('im.message.receive_v1');
  });

  it('SDK 拒绝（access_denied）→ 显式抛错', async () => {
    const fakeImpl: RegisterAppImpl = async () => {
      const e = new Error('user denied') as Error & { code?: string };
      e.code = 'access_denied';
      throw e;
    };
    await expect(
      scanRegisterFeishuApp({ onUrlReady: () => {}, registerAppImpl: fakeImpl }),
    ).rejects.toThrow(/access_denied|denied/);
  });

  it('返回缺少凭证 → 显式报错', async () => {
    const fakeImpl: RegisterAppImpl = async (opts) => {
      opts.onQRCodeReady({ url: 'u', expireIn: 1 });
      return { client_id: '', client_secret: '' };
    };
    await expect(
      scanRegisterFeishuApp({ onUrlReady: () => {}, registerAppImpl: fakeImpl }),
    ).rejects.toThrow(/凭证/);
  });
});
