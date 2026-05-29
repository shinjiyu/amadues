import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Message,
  Thread,
  UserPresence,
  PostMessageRequest,
  Attachment,
} from '@utlra/webchat-protocol';
import {
  fetchCurrentIdentity,
  fetchAuthConfig,
  consumeLoginserverTokens,
  stripLegacyUrlTokens,
  redirectToLogin,
  logout as logoutRequest,
  type ClientIdentity,
} from './auth.js';
import { AdminPage } from './components/AdminPage.js';
import { SessionList } from './components/SessionList.js';
import { OnlineSidebar } from './components/OnlineSidebar.js';
import { MessageTimeline } from './components/MessageTimeline.js';
import { MessageInput } from './components/MessageInput.js';
import { WebChatWs, type ConnectionStatus } from './ws.js';
import {
  UnauthorizedError,
  fetchThreads,
  fetchUsers,
  listMessages,
  postMessage,
  uploadFile,
  createDm,
} from './api.js';

const GLOBAL_THREAD_ID = 'global';
const MOBILE_BREAKPOINT_PX = 768;
/** typing.relay 收到后，若无新的 start/stop 刷新，多久自动清除指示器（兜底超时）。 */
const TYPING_CLEAR_MS = 8000;

type MobilePanel = 'sessions' | 'chat' | 'members';

function useIsMobile(): boolean {
  const query = `(max-width: ${MOBILE_BREAKPOINT_PX}px)`;
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (): void => setIsMobile(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return isMobile;
}

type BootState =
  | { kind: 'loading' }
  | { kind: 'ready'; identity: ClientIdentity }
  | { kind: 'redirecting' }
  | { kind: 'error'; message: string };

export function App() {
  const [boot, setBoot] = useState<BootState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        stripLegacyUrlTokens();
        // 1) 优先用 loginserver 留在 localStorage / URL 上的 token 换 cookie
        const fromStorage = await consumeLoginserverTokens();
        if (cancelled) return;
        if (fromStorage) {
          setBoot({ kind: 'ready', identity: fromStorage });
          return;
        }
        // 2) 已有 cookie 则直接进
        const existing = await fetchCurrentIdentity();
        if (cancelled) return;
        if (existing) {
          setBoot({ kind: 'ready', identity: existing });
          return;
        }
        // 3) 仍未登录 → 跳 loginserver hosted 登录页
        const cfg = await fetchAuthConfig();
        if (cancelled) return;
        if (!cfg.login_page_url) {
          setBoot({
            kind: 'error',
            message:
              '服务端未配置 WEBCHAT_LOGIN_PAGE_URL；联系管理员把它指向 loginserver hosted 登录页。',
          });
          return;
        }
        setBoot({ kind: 'redirecting' });
        redirectToLogin(cfg);
      } catch (e) {
        if (cancelled) return;
        setBoot({ kind: 'error', message: (e as Error).message });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleLogout = async (): Promise<void> => {
    setBoot({ kind: 'redirecting' });
    await logoutRequest();
  };

  if (boot.kind === 'loading' || boot.kind === 'redirecting') {
    return (
      <div className="login">
        <div className="login-card">
          {boot.kind === 'redirecting' ? '前往登录…' : '载入中…'}
        </div>
      </div>
    );
  }
  if (boot.kind === 'error') {
    return (
      <div className="login">
        <div className="login-card">
          <h1>WebChat</h1>
          <p style={{ color: '#f85149' }}>{boot.message}</p>
          <button type="button" onClick={() => window.location.reload()}>重试</button>
        </div>
      </div>
    );
  }
  return <MainScreen identity={boot.identity} onLogout={handleLogout} />;
}

function MainScreen({ identity, onLogout }: { identity: ClientIdentity; onLogout: () => void | Promise<void> }) {
  const isMobile = useIsMobile();
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('chat');
  const [showAdmin, setShowAdmin] = useState<boolean>(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle');
  const [users, setUsers] = useState<UserPresence[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string>(GLOBAL_THREAD_ID);
  const [messagesByThread, setMessagesByThread] = useState<Record<string, Message[]>>({});
  const [hasMoreByThread, setHasMoreByThread] = useState<Record<string, boolean>>({});
  const [unreadByThread, setUnreadByThread] = useState<Record<string, number>>({});
  const [highlightByThread, setHighlightByThread] = useState<Record<string, boolean>>({});
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [error, setError] = useState<string | null>(null);
  // thread_id → (user_id → display_name)：当前在该线程「正在输入中」的用户。
  const [typingByThread, setTypingByThread] = useState<Record<string, Record<string, string>>>({});

  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;

  const wsRef = useRef<WebChatWs | null>(null);
  // `${threadId}::${userId}` → 兜底清除 timer。
  const typingTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // 清除某线程某用户的输入指示器（含兜底 timer）。
  const clearTyping = useCallback((threadId: string, userId: string): void => {
    const key = `${threadId}::${userId}`;
    const timer = typingTimersRef.current.get(key);
    if (timer) {
      clearTimeout(timer);
      typingTimersRef.current.delete(key);
    }
    setTypingByThread((prev) => {
      const cur = prev[threadId];
      if (!cur || !(userId in cur)) return prev;
      const next = { ...cur };
      delete next[userId];
      if (Object.keys(next).length === 0) {
        const copy = { ...prev };
        delete copy[threadId];
        return copy;
      }
      return { ...prev, [threadId]: next };
    });
  }, []);

  const handleTypingRelay = useCallback(
    (threadId: string, userId: string, displayName: string, state: 'start' | 'stop'): void => {
      if (userId === identity.user_id) return;
      if (state === 'stop') {
        clearTyping(threadId, userId);
        return;
      }
      const key = `${threadId}::${userId}`;
      const existing = typingTimersRef.current.get(key);
      if (existing) clearTimeout(existing);
      typingTimersRef.current.set(
        key,
        setTimeout(() => clearTyping(threadId, userId), TYPING_CLEAR_MS),
      );
      setTypingByThread((prev) => {
        const cur = prev[threadId] ?? {};
        if (cur[userId] === displayName) return prev;
        return { ...prev, [threadId]: { ...cur, [userId]: displayName } };
      });
    },
    [identity.user_id, clearTyping],
  );

  const handleIncomingMessage = useCallback((threadId: string, message: Message): void => {
    // 对方一旦发出消息，立即撤掉其「正在输入」指示器
    clearTyping(threadId, message.sender_user_id);
    setMessagesByThread((prev) => {
      const current = prev[threadId] ?? [];
      if (current.some((m) => m.id === message.id)) return prev;
      return { ...prev, [threadId]: [...current, message] };
    });
    if (threadId !== activeThreadIdRef.current) {
      setUnreadByThread((prev) => ({ ...prev, [threadId]: (prev[threadId] ?? 0) + 1 }));
      if (message.mentions.some((m) => m.user_id === identity.user_id)) {
        setHighlightByThread((prev) => ({ ...prev, [threadId]: true }));
      }
    }
    wsRef.current?.updateCursor(threadId, message.id);
  }, [identity.user_id, clearTyping]);

  // WS lifecycle
  useEffect(() => {
    const ws = new WebChatWs({
      identity,
      onStatusChange: setConnectionStatus,
      onEvent: (ev) => {
        if (ev.type === 'presence.sync') {
          setUsers(ev.users);
        } else if (ev.type === 'presence.update') {
          setUsers((prev) => {
            const idx = prev.findIndex((u) => u.user_id === ev.user_id);
            const next: UserPresence = {
              user_id: ev.user_id,
              display_name: ev.display_name,
              online: ev.online,
              created_at: prev[idx]?.created_at ?? new Date().toISOString(),
            };
            if (idx >= 0) {
              const copy = prev.slice();
              copy[idx] = { ...prev[idx]!, ...next };
              return copy;
            }
            return [...prev, next];
          });
        } else if (ev.type === 'message.new') {
          handleIncomingMessage(ev.thread_id, ev.message);
        } else if (ev.type === 'typing.relay') {
          handleTypingRelay(
            ev.thread_id,
            ev.user_id,
            ev.display_name ?? ev.user_id,
            ev.state ?? 'start',
          );
        } else if (ev.type === 'error') {
          setError(`[${ev.code}] ${ev.message}`);
        }
      },
    });
    wsRef.current = ws;
    ws.connect();
    ws.subscribe(GLOBAL_THREAD_ID, null);
    const timers = typingTimersRef.current;
    return () => {
      ws.close();
      wsRef.current = null;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity.user_id]);

  const handleUnauthorized = useCallback((e: unknown): boolean => {
    if (e instanceof UnauthorizedError) {
      void onLogout();
      return true;
    }
    return false;
  }, [onLogout]);

  // Initial bootstrap (REST)
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [u, t] = await Promise.all([fetchUsers(), fetchThreads()]);
        if (cancelled) return;
        setUsers(u.users);
        setThreads(t.threads);
        const { messages, next_before } = await listMessages(GLOBAL_THREAD_ID, { limit: 50 });
        if (cancelled) return;
        setMessagesByThread((prev) => ({ ...prev, [GLOBAL_THREAD_ID]: messages }));
        setHasMoreByThread((prev) => ({ ...prev, [GLOBAL_THREAD_ID]: next_before !== null }));
        if (messages.length > 0) {
          wsRef.current?.updateCursor(GLOBAL_THREAD_ID, messages[messages.length - 1]!.id);
        }
      } catch (e) {
        if (cancelled) return;
        if (handleUnauthorized(e)) return;
        setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [identity, handleUnauthorized]);

  const handleSelectThread = useCallback(async (threadId: string): Promise<void> => {
    setActiveThreadId(threadId);
    setUnreadByThread((prev) => ({ ...prev, [threadId]: 0 }));
    setHighlightByThread((prev) => ({ ...prev, [threadId]: false }));
    setReplyingTo(null);
    if (typeof window !== 'undefined' && window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches) {
      setMobilePanel('chat');
    }
    if (!messagesByThread[threadId]) {
      try {
        const { messages, next_before } = await listMessages(threadId, { limit: 50 });
        setMessagesByThread((prev) => ({ ...prev, [threadId]: messages }));
        setHasMoreByThread((prev) => ({ ...prev, [threadId]: next_before !== null }));
        if (messages.length > 0) {
          wsRef.current?.subscribe(threadId, messages[messages.length - 1]!.id);
        } else {
          wsRef.current?.subscribe(threadId, null);
        }
      } catch (e) {
        if (handleUnauthorized(e)) return;
        setError((e as Error).message);
      }
    } else {
      const cached = messagesByThread[threadId];
      const cursor =
        cached && cached.length > 0 ? cached[cached.length - 1]!.id : null;
      wsRef.current?.subscribe(threadId, cursor);
    }
  }, [messagesByThread, handleUnauthorized]);

  const handleLoadMore = useCallback(async (): Promise<void> => {
    const current = messagesByThread[activeThreadId];
    if (!current || current.length === 0) return;
    const before = current[0]!.id;
    try {
      const { messages, next_before } = await listMessages(activeThreadId, { before, limit: 50 });
      setMessagesByThread((prev) => ({
        ...prev,
        [activeThreadId]: [...messages, ...(prev[activeThreadId] ?? [])],
      }));
      setHasMoreByThread((prev) => ({ ...prev, [activeThreadId]: next_before !== null }));
    } catch (e) {
      if (handleUnauthorized(e)) return;
      setError((e as Error).message);
    }
  }, [activeThreadId, messagesByThread, handleUnauthorized]);

  const handleStartDm = useCallback(async (peerUserId: string): Promise<void> => {
    if (peerUserId === identity.user_id) return;
    try {
      const { thread } = await createDm(peerUserId);
      setThreads((prev) => {
        if (prev.some((t) => t.id === thread.id)) return prev;
        return [...prev, thread];
      });
      await handleSelectThread(thread.id);
    } catch (e) {
      if (handleUnauthorized(e)) return;
      setError((e as Error).message);
    }
  }, [identity, handleSelectThread, handleUnauthorized]);

  const handleSend = useCallback(async (input: {
    text: string;
    mentionUserIds: string[];
    attachmentIds: string[];
    replyToId?: string;
  }): Promise<void> => {
    const body: PostMessageRequest = {
      client_msg_id: crypto.randomUUID(),
      text: input.text,
      ...(input.mentionUserIds.length > 0 ? { mention_user_ids: input.mentionUserIds } : {}),
      ...(input.attachmentIds.length > 0 ? { attachment_ids: input.attachmentIds } : {}),
      ...(input.replyToId ? { reply_to_message_id: input.replyToId } : {}),
    };
    try {
      await postMessage(activeThreadId, body);
      setReplyingTo(null);
    } catch (e) {
      if (handleUnauthorized(e)) return;
      setError((e as Error).message);
    }
  }, [activeThreadId, handleUnauthorized]);

  const handleTyping = useCallback((state: 'start' | 'stop'): void => {
    wsRef.current?.sendTyping(activeThreadId, state);
  }, [activeThreadId]);

  const handleUpload = useCallback(async (file: File): Promise<Attachment | null> => {
    try {
      const meta = await uploadFile(file);
      return {
        asset_id: meta.asset_id,
        url: meta.url,
        mime: meta.mime,
        name: meta.name,
        size: meta.size,
      };
    } catch (e) {
      if (handleUnauthorized(e)) return null;
      setError((e as Error).message);
      return null;
    }
  }, [handleUnauthorized]);

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId),
    [threads, activeThreadId],
  );

  const activeTypingNames = useMemo(() => {
    const map = typingByThread[activeThreadId];
    return map ? Object.values(map) : [];
  }, [typingByThread, activeThreadId]);

  const usersById = useMemo(() => {
    const map = new Map<string, UserPresence>();
    for (const u of users) map.set(u.user_id, u);
    return map;
  }, [users]);

  const peerForDm = useMemo(() => {
    if (!activeThread || activeThread.kind !== 'dm') return null;
    const otherId = activeThread.participants.find((p) => p !== identity.user_id);
    if (!otherId) return null;
    return usersById.get(otherId)
      ?? { user_id: otherId, display_name: otherId, online: false, created_at: '' };
  }, [activeThread, identity.user_id, usersById]);

  const groupedThreads = useMemo(() => {
    const group = threads.find((t) => t.kind === 'group') ?? null;
    const dms = threads.filter((t) => t.kind === 'dm');
    return { group, dms };
  }, [threads]);

  if (showAdmin && identity.role === 'admin') {
    return (
      <AdminPage
        meEmail={identity.email}
        onClose={() => setShowAdmin(false)}
        onUnauthorized={() => void onLogout()}
      />
    );
  }

  const panelClass = (panel: MobilePanel): string =>
    `col col-panel-${panel}${!isMobile || mobilePanel === panel ? ' col-panel-active' : ''}`;

  return (
    <div className={isMobile ? 'app-main app-main--mobile' : 'app-main'}>
      <div className={panelClass('sessions')}>
        <div className="col-header">
          <span>会话</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {identity.role === 'admin' && (
              <button
                type="button"
                onClick={() => setShowAdmin(true)}
                style={{ background: 'transparent', border: 0, color: '#58a6ff', fontSize: 11 }}
                title="白名单管理"
              >
                管理
              </button>
            )}
            <button
              type="button"
              onClick={onLogout}
              style={{ background: 'transparent', border: 0, color: '#8b949e', fontSize: 11 }}
            >
              登出
            </button>
          </div>
        </div>
        {connectionStatus !== 'open' && (
          <div className={`connection-banner${connectionStatus === 'error' ? ' error' : ''}`}>
            {connectionStatus === 'connecting' && '正在连接...'}
            {connectionStatus === 'closed' && '连接断开,重连中...'}
            {connectionStatus === 'error' && '连接错误,重试中...'}
            {connectionStatus === 'idle' && '尚未连接'}
          </div>
        )}
        <SessionList
          groupThread={groupedThreads.group}
          dmThreads={groupedThreads.dms}
          activeThreadId={activeThreadId}
          unreadByThread={unreadByThread}
          highlightByThread={highlightByThread}
          usersById={usersById}
          meUserId={identity.user_id}
          isMobile={isMobile}
          onSelect={handleSelectThread}
          onStartDm={handleStartDm}
        />
      </div>

      <div className={panelClass('chat')}>
        {activeThread && (
          <div className="thread-header">
            {isMobile && (
              <button
                type="button"
                className="mobile-back-btn"
                aria-label="返回会话列表"
                onClick={() => setMobilePanel('sessions')}
              >
                ‹
              </button>
            )}
            {activeThread.kind === 'group' ? (
              <h2>大群</h2>
            ) : (
              <>
                <h2>{peerForDm?.display_name ?? activeThread.participants.filter((p) => p !== identity.user_id).join(', ')}</h2>
                <span className="subtitle">
                  {peerForDm?.online ? '在线' : '离线'}
                </span>
              </>
            )}
          </div>
        )}
        {error && (
          <div className="connection-banner error" onClick={() => setError(null)}>
            {error}
          </div>
        )}
        <div className="timeline-container">
          {activeThread ? (
            <MessageTimeline
              threadId={activeThreadId}
              messages={messagesByThread[activeThreadId] ?? []}
              hasMore={hasMoreByThread[activeThreadId] ?? false}
              meUserId={identity.user_id}
              usersById={usersById}
              typingNames={activeTypingNames}
              onLoadMore={handleLoadMore}
              onReply={(m) => setReplyingTo(m)}
            />
          ) : (
            <div className="empty-state">请选择一个会话</div>
          )}
          {activeThread && (
            <MessageInput
              users={users}
              meUserId={identity.user_id}
              replyingTo={replyingTo}
              onCancelReply={() => setReplyingTo(null)}
              onSend={handleSend}
              onUpload={handleUpload}
              onTyping={handleTyping}
            />
          )}
        </div>
      </div>

      <div className={panelClass('members')}>
        <div className="col-header">
          <span>成员</span>
          <span className="me">我:{identity.display_name}</span>
        </div>
        <OnlineSidebar
          users={users}
          meUserId={identity.user_id}
          onClickUser={(uid) => uid !== identity.user_id && void handleStartDm(uid)}
        />
      </div>

      {isMobile && (
        <nav className="mobile-bottom-nav" aria-label="主菜单">
          <button
            type="button"
            className={mobilePanel === 'sessions' ? 'active' : ''}
            onClick={() => setMobilePanel('sessions')}
          >
            会话
          </button>
          <button
            type="button"
            className={mobilePanel === 'chat' ? 'active' : ''}
            onClick={() => setMobilePanel('chat')}
          >
            聊天
          </button>
          <button
            type="button"
            className={mobilePanel === 'members' ? 'active' : ''}
            onClick={() => setMobilePanel('members')}
          >
            成员
          </button>
        </nav>
      )}
    </div>
  );
}
