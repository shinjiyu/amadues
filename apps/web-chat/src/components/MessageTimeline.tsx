import { useEffect, useRef } from 'react';
import type { Message, UserPresence } from '@utlra/webchat-protocol';
import { MessageItem } from './MessageItem.js';

interface Props {
  messages: Message[];
  hasMore: boolean;
  meUserId: string;
  usersById: Map<string, UserPresence>;
  onLoadMore: () => void;
  onReply: (m: Message) => void;
}

export function MessageTimeline({ messages, hasMore, meUserId, usersById, onLoadMore, onReply }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastLengthRef = useRef(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Only auto-scroll on append (length grew by < 5 messages = streaming arrival)
    const delta = messages.length - lastLengthRef.current;
    if (delta > 0 && delta < 5) {
      el.scrollTop = el.scrollHeight;
    } else if (lastLengthRef.current === 0 && messages.length > 0) {
      // Initial load
      el.scrollTop = el.scrollHeight;
    }
    lastLengthRef.current = messages.length;
  }, [messages]);

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
    </div>
  );
}
