/**
 * WebChat thread ↔ chat IR thread_id 映射。
 *
 * 与 Discord 不同：WebChat 的 thread_id 已经是稳定字符串（`global` / `dm:a:b`），
 * 因此本映射是**纯结构性**的（加/减 `webchat:` 前缀），不需要持久化的 maps.json。
 *
 * - WebChat `global` → IR `webchat:global`
 * - WebChat `dm:alice:bob` → IR `webchat:dm:alice:bob`
 *
 * 这样 IR threads.json 里同时存在 Discord/WebChat/其它渠道时不会冲突。
 */
const IR_PREFIX = 'webchat:';

export function webChatThreadToIr(threadId: string): string {
  return `${IR_PREFIX}${threadId}`;
}

export function irThreadToWebChat(irThreadId: string): string | null {
  if (!irThreadId.startsWith(IR_PREFIX)) return null;
  return irThreadId.slice(IR_PREFIX.length);
}

export function isWebChatIrThread(irThreadId: string): boolean {
  return irThreadId.startsWith(IR_PREFIX);
}

export function webChatMessageIdToIr(id: string): string {
  return `webchat:${id}`;
}

export function irMessageIdToWebChat(irId: string): string | null {
  if (!irId.startsWith('webchat:')) return null;
  return irId.slice('webchat:'.length);
}
