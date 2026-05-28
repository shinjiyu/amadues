/**
 * 白名单管理页 —— 仅 admin 可见。
 *
 * 容器要点：因为没有 dashboard 入口可以挂，admin UI 必须长在 web-chat 自己里。
 * MainScreen 在顶部给 admin 一个 "管理" 按钮，进来这里；左上角的 ← 返回。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  type WhitelistEntry,
  UnauthorizedError,
  addWhitelistEntry,
  listWhitelist,
  patchWhitelistEntry,
  removeWhitelistEntry,
} from '../api.js';

interface Props {
  meEmail: string;
  onClose: () => void;
  onUnauthorized: () => void;
}

function getDisplayName(e: WhitelistEntry): string {
  return e.display_name ?? e.displayName ?? '';
}

function getUserId(e: WhitelistEntry): string {
  return e.user_id ?? e.userId ?? '';
}

export function AdminPage({ meEmail, onClose, onUnauthorized }: Props) {
  const [entries, setEntries] = useState<WhitelistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'member'>('member');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listWhitelist();
      setEntries(list);
    } catch (e) {
      if (e instanceof UnauthorizedError) { onUnauthorized(); return; }
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleAdd = async (): Promise<void> => {
    const email = newEmail.trim().toLowerCase();
    if (!email.includes('@')) { setError('邮箱格式不对'); return; }
    setAdding(true);
    setError(null);
    try {
      await addWhitelistEntry({
        email,
        role: newRole,
        ...(newDisplayName.trim() ? { display_name: newDisplayName.trim() } : {}),
      });
      setNewEmail('');
      setNewDisplayName('');
      setNewRole('member');
      await refresh();
    } catch (e) {
      if (e instanceof UnauthorizedError) { onUnauthorized(); return; }
      setError((e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const handlePatch = async (
    email: string,
    patch: Partial<{ role: 'admin' | 'member'; status: 'active' | 'disabled' }>,
  ): Promise<void> => {
    try {
      await patchWhitelistEntry(email, patch);
      await refresh();
    } catch (e) {
      if (e instanceof UnauthorizedError) { onUnauthorized(); return; }
      setError((e as Error).message);
    }
  };

  const handleRemove = async (email: string): Promise<void> => {
    if (!confirm(`移除 ${email}？该用户的当前连接不会立刻断，但下次登录会被拒。`)) return;
    try {
      await removeWhitelistEntry(email);
      await refresh();
    } catch (e) {
      if (e instanceof UnauthorizedError) { onUnauthorized(); return; }
      setError((e as Error).message);
    }
  };

  return (
    <div className="admin-page">
      <div className="admin-header">
        <button type="button" className="admin-back" onClick={onClose}>← 返回</button>
        <h1>白名单管理</h1>
        <span className="admin-me">当前 admin: {meEmail}</span>
      </div>

      <p className="admin-hint">
        加白名单 <strong>不</strong> 创建 loginserver 账号 —— 用户必须先在 loginserver 注册同一邮箱。
        移除/禁用立即生效（已建立的连接需 cookie 过期或手动重启 chat-server）。
      </p>

      <div className="admin-add-row">
        <input
          type="email"
          placeholder="user@example.com"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
        />
        <input
          type="text"
          placeholder="显示名（可选）"
          value={newDisplayName}
          onChange={(e) => setNewDisplayName(e.target.value)}
        />
        <select value={newRole} onChange={(e) => setNewRole(e.target.value as 'admin' | 'member')}>
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
        <button type="button" disabled={adding || !newEmail.trim()} onClick={handleAdd}>
          {adding ? '添加中…' : '添加'}
        </button>
      </div>

      {error && <div className="admin-error" onClick={() => setError(null)}>{error}</div>}

      {loading ? (
        <div className="admin-empty">载入中…</div>
      ) : entries.length === 0 ? (
        <div className="admin-empty">白名单为空。先把自己（admin）加进来才能正常工作。</div>
      ) : (
        <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>邮箱</th>
              <th>显示名</th>
              <th>角色</th>
              <th>状态</th>
              <th>user_id</th>
              <th>添加者 / 时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => {
              const isMe = e.email === meEmail;
              return (
                <tr key={e.email} className={e.status === 'disabled' ? 'row-disabled' : ''}>
                  <td>{e.email}{isMe && <span className="badge">me</span>}</td>
                  <td>{getDisplayName(e) || <span className="muted">—</span>}</td>
                  <td>
                    <select
                      value={e.role}
                      disabled={isMe}
                      onChange={(ev) => handlePatch(e.email, { role: ev.target.value as 'admin' | 'member' })}
                    >
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                    </select>
                  </td>
                  <td>
                    <select
                      value={e.status}
                      disabled={isMe}
                      onChange={(ev) => handlePatch(e.email, { status: ev.target.value as 'active' | 'disabled' })}
                    >
                      <option value="active">active</option>
                      <option value="disabled">disabled</option>
                    </select>
                  </td>
                  <td className="muted small">{getUserId(e) || '—'}</td>
                  <td className="muted small">
                    {e.addedBy}
                    <br />
                    {new Date(e.updatedAt).toLocaleString()}
                  </td>
                  <td>
                    <button
                      type="button"
                      disabled={isMe}
                      onClick={() => handleRemove(e.email)}
                      title={isMe ? '不能移除自己' : '移除该用户'}
                    >
                      移除
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}
