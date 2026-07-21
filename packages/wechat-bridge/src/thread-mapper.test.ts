import { describe, expect, it } from 'vitest';
import {
  irThreadToWechat,
  isWechatIrThread,
  wechatDmToIr,
  wechatGroupToIr,
  wechatMessageIdToIr,
} from './thread-mapper.js';

const BOT = 'e06c1ceea05e@im.bot';
const USER = 'o9cq800kum@im.wechat';

describe('wechat thread-mapper', () => {
  it('dm 往返', () => {
    const ir = wechatDmToIr(BOT, USER);
    expect(ir).toBe(`wechat:${BOT}:dm:${USER}`);
    expect(irThreadToWechat(ir)).toEqual({ botId: BOT, kind: 'dm', peerId: USER });
    expect(isWechatIrThread(ir)).toBe(true);
  });

  it('group 往返（协议预留）', () => {
    const ir = wechatGroupToIr(BOT, 'g_123');
    expect(irThreadToWechat(ir)).toEqual({ botId: BOT, kind: 'group', peerId: 'g_123' });
  });

  it('非 wechat thread → null', () => {
    expect(irThreadToWechat('feishu:cli_a:chat:oc_1')).toBeNull();
    expect(isWechatIrThread('webchat:dm:x')).toBe(false);
  });

  it('message id 编入 bot id', () => {
    expect(wechatMessageIdToIr(BOT, 9812451782375)).toBe(`wechat:${BOT}:msg:9812451782375`);
  });
});
