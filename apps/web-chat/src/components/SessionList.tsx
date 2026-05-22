import { useState } from 'react';
import type { Thread, UserPresence } from '@utlra/webchat-protocol';

interface Props {
  groupThread: Thread | null;
  dmThreads: Thread[];
  activeThreadId: string;
  unreadByThread: Record<string, number>;
  highlightByThread: Record<string, boolean>;
  usersById: Map<string, UserPresence>;
  meUserId: string;
  onSelect: (threadId: string) => void;
  onStartDm: (peerUserId: string) => void;
}

export function SessionList({
  groupThread,
  dmThreads,
  activeThreadId,
  unreadByThread,
  highlightByThread,
  usersById,
  meUserId,
  onSelect,
  onStartDm,
}: Props) {
  const [showNewDm, setShowNewDm] = useState(false);
  const [newDmPeer, setNewDmPeer] = useState('');

  const handleStartDm = (e: React.FormEvent): void => {
    e.preventDefault();
    const peer = newDmPeer.trim();
    if (!peer || peer === meUserId) return;
    onStartDm(peer);
    setNewDmPeer('');
    setShowNewDm(false);
  };

  return (
    <div className="col-body">
      {groupThread && (
        <SessionItem
          icon="#"
          name="大群"
          active={activeThreadId === groupThread.id}
          unread={unreadByThread[groupThread.id] ?? 0}
          highlight={highlightByThread[groupThread.id] ?? false}
          onClick={() => onSelect(groupThread.id)}
        />
      )}

      <div style={{ padding: '12px 14px 4px', fontSize: 11, color: '#6e7681' }}>私聊</div>
      {dmThreads.length === 0 && (
        <div style={{ padding: '4px 14px', color: '#6e7681', fontSize: 12 }}>
          点击右侧成员发起私聊
        </div>
      )}
      {dmThreads.map((t) => {
        const otherId = t.participants.find((p) => p !== meUserId) ?? '';
        const other = usersById.get(otherId);
        return (
          <SessionItem
            key={t.id}
            icon="@"
            name={other?.display_name ?? otherId}
            active={activeThreadId === t.id}
            unread={unreadByThread[t.id] ?? 0}
            highlight={highlightByThread[t.id] ?? false}
            onClick={() => onSelect(t.id)}
          />
        );
      })}

      {showNewDm ? (
        <form onSubmit={handleStartDm} style={{ padding: '8px 14px', display: 'flex', gap: 6 }}>
          <input
            value={newDmPeer}
            onChange={(e) => setNewDmPeer(e.target.value)}
            placeholder="对方 user_id"
            style={{
              flex: 1,
              background: '#0d1117',
              border: '1px solid #30363d',
              borderRadius: 4,
              padding: '4px 8px',
              color: '#c9d1d9',
              fontSize: 12,
            }}
            autoFocus
          />
          <button type="submit" style={{
            background: '#238636', color: '#fff', border: 0, borderRadius: 4, fontSize: 11, padding: '2px 8px',
          }}>OK</button>
        </form>
      ) : (
        <button className="new-dm-btn" onClick={() => setShowNewDm(true)}>
          + 按 user_id 发起私聊
        </button>
      )}
    </div>
  );
}

function SessionItem(props: {
  icon: string;
  name: string;
  active: boolean;
  unread: number;
  highlight: boolean;
  onClick: () => void;
}) {
  return (
    <div className={`session-item${props.active ? ' active' : ''}`} onClick={props.onClick}>
      <span className="session-icon">{props.icon}</span>
      <div className="session-meta">
        <span className="session-name">{props.name}</span>
      </div>
      {props.unread > 0 && (
        <span
          className="unread-badge"
          style={props.highlight ? { background: '#da3633' } : { background: '#30363d' }}
        >
          {props.unread > 99 ? '99+' : props.unread}
        </span>
      )}
    </div>
  );
}
