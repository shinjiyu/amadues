import type { UserPresence } from '@utlra/webchat-protocol';
import { sortSidebarUsers } from '../mention-users.js';

interface Props {
  users: UserPresence[];
  meUserId: string;
  onClickUser: (userId: string) => void;
}

export function OnlineSidebar({ users, meUserId, onClickUser }: Props) {
  const online = sortSidebarUsers(users, meUserId).filter((u) => u.online);

  return (
    <div className="col-body">
      <div style={{ padding: '4px 14px', fontSize: 11, color: '#6e7681' }}>
        在线 {online.length}
      </div>
      {online.length === 0 && (
        <div style={{ padding: '8px 14px', color: '#6e7681', fontSize: 12 }}>
          暂无其他在线成员
        </div>
      )}
      {online.map((u) => (
        <div
          key={u.user_id}
          className={`online-user online${u.user_id !== meUserId ? ' clickable' : ''}`}
          onClick={() => u.user_id !== meUserId && onClickUser(u.user_id)}
          title={u.user_id !== meUserId ? `点击发起私聊 (${u.user_id})` : ''}
        >
          <span className="dot" />
          <span className="name">{u.display_name}</span>
          {u.user_id === meUserId && <span className="is-me">我</span>}
        </div>
      ))}
    </div>
  );
}
