import { useEffect, useRef } from 'react';
import type { Message, UserPresence } from '@utlra/webchat-protocol';
import { MessageItem } from './MessageItem.js';

interface Props {
  threadId: string;
  messages: Message[];
  hasMore: boolean;
  meUserId: string;
  usersById: Map<string, UserPresence>;
  /** 当前在本线程「正在输入中」的用户显示名（不含自己）。 */
  typingNames?: string[];
  onLoadMore: () => void;
  onReply: (m: Message) => void;
}

function formatTyping(names: string[]): string {
  if (names.length === 1) return `${names[0]} 正在输入`;
  if (names.length === 2) return `${names[0]}、${names[1]} 正在输入`;
  return `${names[0]} 等 ${names.length} 人正在输入`;
}

export function MessageTimeline({
  threadId,
  messages,
  hasMore,
  meUserId,
  usersById,
  typingNames = [],
  onLoadMore,
  onReply,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastLengthRef = useRef(0);
  const lastThreadRef = useRef(threadId);

  useEffect(() => {
    if (lastThreadRef.current !== threadId) {
      lastThreadRef.current = threadId;
      lastLengthRef.current = 0;
    }
    const el = scrollRef.current;
    if (!el) return;
    // Only auto-scroll on append (length grew by < 5 messages = streaming arrival)
    const delta = messages.length - lastLengthRef.current;
    if (delta > 0 && delta < 5) {
      el.scrollTop = el.scrollHeight;
    } else if (lastLengthRef.current === 0 && messages.length > 0) {
      // Initial load or switched thread
      el.scrollTop = el.scrollHeight;
    }
    lastLengthRef.current = messages.length;
  }, [threadId, messages]);

  const messagesById = new Map<string, Message>();
  for (const m of messages) messagesById.set(m.id, m);

  return (
    <div className="timeline" ref={scrollRef}>
      {hasMore && (
        <button type="button" className="load-more" onClick={onLoadMore}>
          加载更多
        </button>
      )}
      {messages.length === 0 && !hasMore && (
        <div className="empty-state">还没有消息</div>
      )}
      {messages.map((m) => (
        <MessageItem
          key={m.id}
          message={m}
          meUserId={meUserId}
          repliedTo={m.reply_to_message_id ? messagesById.get(m.reply_to_message_id) : undefined}
          authorName={usersById.get(m.sender_user_id)?.display_name ?? m.sender_user_id}
          onReply={() => onReply(m)}
        />
      ))}
      {typingNames.length > 0 && (
        <div className="typing-indicator" aria-live="polite">
          <span className="typing-dots" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          <span className="typing-text">{formatTyping(typingNames)}</span>
        </div>
      )}
    </div>
  );
}
