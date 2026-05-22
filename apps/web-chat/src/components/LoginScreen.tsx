import { useState } from 'react';
import { suggestUserId } from '../auth.js';

interface Props {
  onLogin: (displayName: string, userId?: string) => void;
}

export function LoginScreen({ onLogin }: Props) {
  const [displayName, setDisplayName] = useState('');
  const [userIdInput, setUserIdInput] = useState('');
  const [advanced, setAdvanced] = useState(false);

  const canSubmit = displayName.trim().length > 0;
  const suggested = displayName.trim() ? suggestUserId(displayName) : '';

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (!canSubmit) return;
    onLogin(displayName, userIdInput.trim() || undefined);
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1>WebChat — 临时聊天服务</h1>
        <p className="hint">无认证。你声明的身份就是身份。</p>
        <label>
          显示名 (Display Name)
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="例如:Alice"
            autoFocus
            maxLength={32}
          />
        </label>
        {advanced && (
          <label>
            User ID (可选,自动从显示名推导)
            <input
              type="text"
              value={userIdInput}
              onChange={(e) => setUserIdInput(e.target.value)}
              placeholder={suggested || 'auto'}
              maxLength={32}
            />
          </label>
        )}
        <button type="button"
          onClick={() => setAdvanced((v) => !v)}
          style={{
            background: 'transparent',
            border: 0,
            color: '#58a6ff',
            fontSize: 11,
            textAlign: 'left',
            padding: 0,
          }}
        >
          {advanced ? '隐藏高级' : '高级:自定义 user_id'}
        </button>
        <button type="submit" disabled={!canSubmit}>
          进入
        </button>
      </form>
    </div>
  );
}
