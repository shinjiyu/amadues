import { describe, expect, it } from 'vitest';
import {
  feishuChatToIr,
  feishuMessageIdToIr,
  irMessageIdToFeishu,
  irThreadToFeishuChat,
  isFeishuIrThread,
} from './thread-mapper.js';

describe('feishu thread-mapper', () => {
  it('chat ↔ IR 双向映射（app_id 编入 thread_id）', () => {
    const ir = feishuChatToIr('cli_a1', 'oc_room9');
    expect(ir).toBe('feishu:cli_a1:chat:oc_room9');
    expect(irThreadToFeishuChat(ir)).toEqual({ appId: 'cli_a1', chatId: 'oc_room9' });
  });

  it('同一物理群不同 app 的 thread_id 不冲突', () => {
    expect(feishuChatToIr('cli_a', 'oc_x')).not.toBe(feishuChatToIr('cli_b', 'oc_x'));
  });

  it('非飞书 thread 返回 null / false', () => {
    expect(irThreadToFeishuChat('webchat:global')).toBeNull();
    expect(isFeishuIrThread('discord:chan:1')).toBe(false);
    expect(isFeishuIrThread('feishu:cli_a:chat:oc_x')).toBe(true);
  });

  it('message id 双向映射', () => {
    const ir = feishuMessageIdToIr('cli_a', 'om_123');
    expect(ir).toBe('feishu:cli_a:msg:om_123');
    expect(irMessageIdToFeishu(ir)).toEqual({ appId: 'cli_a', messageId: 'om_123' });
    expect(irMessageIdToFeishu('webchat:m1')).toBeNull();
  });
});
