import type { Message, MessagePart } from '@utlra/webchat-protocol';

interface Props {
  message: Message;
  meUserId: string;
  repliedTo: Message | undefined;
  authorName: string;
  onReply: () => void;
}

export function MessageItem({ message, meUserId, repliedTo, authorName, onReply }: Props) {
  const time = formatTime(message.sent_at);
  const initials = authorName.slice(0, 1).toUpperCase();

  return (
    <div className="message">
      <span className="avatar">{initials}</span>
      <div className="msg-body">
        <div className="msg-head">
          <span className="msg-author">{authorName}</span>
          <span className="msg-time" title={message.sent_at}>{time}</span>
        </div>
        {message.reply_to_message_id && (
          <div
            className="msg-reply-ref"
            onClick={() => {
              if (repliedTo) {
                document.getElementById(`msg-${repliedTo.id}`)?.scrollIntoView({ behavior: 'smooth' });
              }
            }}
          >
            {repliedTo ? (
              <>
                <span className="ref-author">@{repliedTo.sender_user_id}: </span>
                {repliedTo.text.slice(0, 80)}
                {repliedTo.text.length > 80 && '...'}
              </>
            ) : (
              <span style={{ color: '#6e7681' }}>引用了一条历史消息</span>
            )}
          </div>
        )}
        <div className="msg-content" id={`msg-${message.id}`}>
          {message.parts.map((p, i) => (
            <PartRenderer key={i} part={p} meUserId={meUserId} />
          ))}
        </div>
      </div>
      <div className="msg-actions">
        <button type="button" onClick={onReply} title="回复">回复</button>
      </div>
    </div>
  );
}

function PartRenderer({ part, meUserId }: { part: MessagePart; meUserId: string }) {
  if (part.type === 'text') return <span>{part.text}</span>;
  if (part.type === 'mention') {
    return (
      <span className={`msg-mention${part.user_id === meUserId ? ' is-me' : ''}`}>
        @{part.display_name}
      </span>
    );
  }
  if (part.type === 'attachment') {
    const a = part.attachment;
    if (a.mime.startsWith('image/')) {
      return (
        <div className="msg-attachment">
          <a href={a.url} target="_blank" rel="noreferrer">
            <img src={a.url} alt={a.name} loading="lazy" />
          </a>
        </div>
      );
    }
    return (
      <div className="msg-attachment">
        <a className="file-card" href={a.url} target="_blank" rel="noreferrer" download={a.name}>
          <span>📎</span>
          <span>{a.name}</span>
          <span style={{ color: '#6e7681', fontSize: 11 }}>{humanSize(a.size)}</span>
        </a>
      </div>
    );
  }
  return null;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (sameDay) return `${hh}:${mm}`;
    const M = d.getMonth() + 1;
    const D = d.getDate();
    return `${M}/${D} ${hh}:${mm}`;
  } catch {
    return '';
  }
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
