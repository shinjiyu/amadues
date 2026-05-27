import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  Message,
  Thread,
  UserPresence,
  PostMessageRequest,
  Attachment,
} from '@utlra/webchat-protocol';
import { loadIdentity, saveIdentity, clearIdentity, suggestUserId, type ClientIdentity } from './auth.js';
import { LoginScreen } from './components/LoginScreen.js';
import { SessionList } from './components/SessionList.js';
import { OnlineSidebar } from './components/OnlineSidebar.js';
import { MessageTimeline } from './components/MessageTimeline.js';
import { MessageInput } from './components/MessageInput.js';
import { WebChatWs, type ConnectionStatus } from './ws.js';
import {
  fetchMe,
  fetchThreads,
  fetchUsers,
  listMessages,
  postMessage,
  uploadFile,
  createDm,
} from './api.js';

const GLOBAL_THREAD_ID = 'global';

export function App() {
  const [identity, setIdentity] = useState<ClientIdentity | null>(() => loadIdentity());

  const handleLogin = (displayName: string, userId?: string): void => {
    const id: ClientIdentity = {
      user_id: userId?.trim() || suggestUserId(displayName),
      display_name: displayName.trim(),
    };
    saveIdentity(id);
    setIdentity(id);
  };

  const handleLogout = (): void => {
    clearIdentity();
    setIdentity(null);
  };

  if (!identity) {
    return <LoginScreen onLogin={handleLogin} />;
  }
  return <MainScreen identity={identity} onLogout={handleLogout} />;
}

function MainScreen({ identity, onLogout }: { identity: ClientIdentity; onLogout: () => void }) {
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

  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;

  const wsRef = useRef<WebChatWs | null>(null);

  const handleIncomingMessage = useCallback((threadId: string, message: Message): void => {
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
  }, [identity.user_id]);

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
        } else if (ev.type === 'error') {
          setError(`[${ev.code}] ${ev.message}`);
        }
      },
    });
    wsRef.current = ws;
    ws.connect();
    ws.subscribe(GLOBAL_THREAD_ID, null);
    return () => {
      ws.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity.user_id]);

  // Initial bootstrap (REST)
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await fetchMe(identity);
        const [u, t] = await Promise.all([fetchUsers(identity), fetchThreads(identity)]);
        if (cancelled) return;
        setUsers(u.users);
        setThreads(t.threads);
        const { messages, next_before } = await listMessages(identity, GLOBAL_THREAD_ID, { limit: 50 });
        if (cancelled) return;
        setMessagesByThread((prev) => ({ ...prev, [GLOBAL_THREAD_ID]: messages }));
        setHasMoreByThread((prev) => ({ ...prev, [GLOBAL_THREAD_ID]: next_before !== null }));
        if (messages.length > 0) {
          wsRef.current?.updateCursor(GLOBAL_THREAD_ID, messages[messages.length - 1]!.id);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [identity]);

  const handleSelectThread = useCallback(async (threadId: string): Promise<void> => {
    setActiveThreadId(threadId);
    setUnreadByThread((prev) => ({ ...prev, [threadId]: 0 }));
    setHighlightByThread((prev) => ({ ...prev, [threadId]: false }));
    setReplyingTo(null);
    if (!messagesByThread[threadId]) {
      try {
        const { messages, next_before } = await listMessages(identity, threadId, { limit: 50 });
        setMessagesByThread((prev) => ({ ...prev, [threadId]: messages }));
        setHasMoreByThread((prev) => ({ ...prev, [threadId]: next_before !== null }));
        if (messages.length > 0) {
          wsRef.current?.subscribe(threadId, messages[messages.length - 1]!.id);
        } else {
          wsRef.current?.subscribe(threadId, null);
        }
      } catch (e) {
        setError((e as Error).message);
      }
    } else {
      const cached = messagesByThread[threadId];
      const cursor =
        cached && cached.length > 0 ? cached[cached.length - 1]!.id : null;
      wsRef.current?.subscribe(threadId, cursor);
    }
  }, [identity, messagesByThread]);

  const handleLoadMore = useCallback(async (): Promise<void> => {
    const current = messagesByThread[activeThreadId];
    if (!current || current.length === 0) return;
    const before = current[0]!.id;
    try {
      const { messages, next_before } = await listMessages(identity, activeThreadId, { before, limit: 50 });
      setMessagesByThread((prev) => ({
        ...prev,
        [activeThreadId]: [...messages, ...(prev[activeThreadId] ?? [])],
      }));
      setHasMoreByThread((prev) => ({ ...prev, [activeThreadId]: next_before !== null }));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [activeThreadId, identity, messagesByThread]);

  const handleStartDm = useCallback(async (peerUserId: string): Promise<void> => {
    if (peerUserId === identity.user_id) return;
    try {
      const { thread } = await createDm(identity, peerUserId);
      setThreads((prev) => {
        if (prev.some((t) => t.id === thread.id)) return prev;
        return [...prev, thread];
      });
      await handleSelectThread(thread.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [identity, handleSelectThread]);

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
      await postMessage(identity, activeThreadId, body);
      setReplyingTo(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [identity, activeThreadId]);

  const handleUpload = useCallback(async (file: File): Promise<Attachment | null> => {
    try {
      const meta = await uploadFile(identity, file);
      return {
        asset_id: meta.asset_id,
        url: meta.url,
        mime: meta.mime,
        name: meta.name,
        size: meta.size,
      };
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, [identity]);

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId),
    [threads, activeThreadId],
  );

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

  return (
    <div className="app-main">
      <div className="col">
        <div className="col-header">
          <span>会话</span>
          <button
            type="button"
            onClick={onLogout}
            style={{ background: 'transparent', border: 0, color: '#8b949e', fontSize: 11 }}
          >
            登出
          </button>
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
          onSelect={handleSelectThread}
          onStartDm={handleStartDm}
        />
      </div>

      <div className="col">
        {activeThread && (
          <div className="thread-header">
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
            />
          )}
        </div>
      </div>

      <div className="col">
        <div className="col-header">
          <span>成员</span>
          <span className="me">我:{identity.display_name}</span>
        </div>
        <OnlineSidebar
          users={users}
          meUserId={identity.user_id}
          onClickUser={(uid) => uid !== identity.user_id && handleStartDm(uid)}
        />
      </div>
    </div>
  );
}
