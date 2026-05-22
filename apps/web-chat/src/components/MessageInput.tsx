import { useEffect, useRef, useState } from 'react';
import type { Attachment, Message, UserPresence } from '@utlra/webchat-protocol';

interface Props {
  users: UserPresence[];
  meUserId: string;
  replyingTo: Message | null;
  onCancelReply: () => void;
  onSend: (input: {
    text: string;
    mentionUserIds: string[];
    attachmentIds: string[];
    replyToId?: string;
  }) => Promise<void>;
  onUpload: (file: File) => Promise<Attachment | null>;
}

interface InputAttachment {
  localId: string;
  name: string;
  size: number;
  status: 'uploading' | 'done' | 'error';
  attachment?: Attachment;
}

export function MessageInput({ users, meUserId, replyingTo, onCancelReply, onSend, onUpload }: Props) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<InputAttachment[]>([]);
  const [mentionPopup, setMentionPopup] = useState<{ query: string; index: number } | null>(null);
  const [popupActiveIdx, setPopupActiveIdx] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const mentionCandidates = mentionPopup
    ? users.filter((u) =>
        u.user_id !== meUserId
        && (u.display_name.toLowerCase().includes(mentionPopup.query.toLowerCase())
          || u.user_id.toLowerCase().includes(mentionPopup.query.toLowerCase())),
      ).slice(0, 8)
    : [];

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const value = e.target.value;
    setText(value);
    const caret = e.target.selectionStart ?? value.length;
    const slice = value.slice(0, caret);
    const m = slice.match(/(?:^|\s)@([^\s@]*)$/);
    if (m) {
      const atIdx = caret - m[1]!.length - 1;
      setMentionPopup({ query: m[1]!, index: atIdx });
      setPopupActiveIdx(0);
    } else {
      setMentionPopup(null);
    }
  };

  const acceptMention = (u: UserPresence): void => {
    if (!mentionPopup) return;
    const before = text.slice(0, mentionPopup.index);
    const afterStart = mentionPopup.index + mentionPopup.query.length + 1;
    const after = text.slice(afterStart);
    const replacement = `@${u.display_name} `;
    const newText = `${before}${replacement}${after}`;
    setText(newText);
    setMentionPopup(null);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      const pos = before.length + replacement.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (mentionPopup && mentionCandidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setPopupActiveIdx((idx) => (idx + 1) % mentionCandidates.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setPopupActiveIdx((idx) => (idx - 1 + mentionCandidates.length) % mentionCandidates.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const candidate = mentionCandidates[popupActiveIdx];
        if (candidate) acceptMention(candidate);
        return;
      }
      if (e.key === 'Escape') {
        setMentionPopup(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void doSend();
    }
  };

  const collectMentions = (): string[] => {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const u of users) {
      if (u.user_id === meUserId) continue;
      if (text.includes(`@${u.display_name}`) || text.includes(`@${u.user_id}`)) {
        if (!seen.has(u.user_id)) {
          seen.add(u.user_id);
          ids.push(u.user_id);
        }
      }
    }
    return ids;
  };

  const doSend = async (): Promise<void> => {
    const trimmed = text.trim();
    const doneAttachments = attachments.filter((a) => a.status === 'done' && a.attachment);
    if (attachments.some((a) => a.status === 'uploading')) return;
    if (!trimmed && doneAttachments.length === 0) return;

    await onSend({
      text: trimmed,
      mentionUserIds: collectMentions(),
      attachmentIds: doneAttachments.map((a) => a.attachment!.asset_id),
      ...(replyingTo ? { replyToId: replyingTo.id } : {}),
    });
    setText('');
    setAttachments([]);
  };

  const handleFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      const localId = crypto.randomUUID();
      setAttachments((prev) => [
        ...prev,
        { localId, name: file.name, size: file.size, status: 'uploading' },
      ]);
      const att = await onUpload(file);
      if (att) {
        setAttachments((prev) =>
          prev.map((a) => (a.localId === localId
            ? { ...a, status: 'done', attachment: att }
            : a)),
        );
      } else {
        setAttachments((prev) =>
          prev.map((a) => (a.localId === localId ? { ...a, status: 'error' } : a)),
        );
      }
    }
  };

  const removeAttachment = (localId: string): void => {
    setAttachments((prev) => prev.filter((a) => a.localId !== localId));
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) {
      void handleFiles(e.dataTransfer.files);
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      void handleFiles(dt.files);
    }
  };

  return (
    <div
      className="input-area"
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      {replyingTo && (
        <div className="reply-banner">
          <span>回复 <span style={{ color: '#58a6ff' }}>@{replyingTo.sender_user_id}</span>: {replyingTo.text.slice(0, 60)}{replyingTo.text.length > 60 && '...'}</span>
          <button type="button" onClick={onCancelReply}>×</button>
        </div>
      )}
      {attachments.length > 0 && (
        <div className="input-attachments">
          {attachments.map((a) => (
            <div key={a.localId} className="att-chip">
              <span className={a.status === 'uploading' ? 'uploading' : ''}>
                {a.status === 'uploading' ? '上传中…' : a.status === 'error' ? '失败' : '📎'} {a.name}
              </span>
              <button type="button" onClick={() => removeAttachment(a.localId)}>×</button>
            </div>
          ))}
        </div>
      )}
      <div style={{ position: 'relative' }}>
        {mentionPopup && mentionCandidates.length > 0 && (
          <div className="mention-popup">
            {mentionCandidates.map((u, i) => (
              <div
                key={u.user_id}
                className={`mention-item${i === popupActiveIdx ? ' active' : ''}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  acceptMention(u);
                }}
                onMouseEnter={() => setPopupActiveIdx(i)}
              >
                <span className={u.online ? '' : ''} style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: u.online ? '#3fb950' : '#6e7681',
                  display: 'inline-block',
                }} />
                <span style={{ color: '#c9d1d9' }}>{u.display_name}</span>
                <span style={{ color: '#6e7681', fontSize: 11 }}>{u.user_id}</span>
              </div>
            ))}
          </div>
        )}
        <div className="input-row">
          <button
            type="button"
            className="icon-btn"
            onClick={() => fileInputRef.current?.click()}
            title="附件"
          >📎</button>
          <input
            ref={fileInputRef}
            type="file"
            style={{ display: 'none' }}
            multiple
            onChange={(e) => void handleFiles(e.target.files)}
          />
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="说点什么... (Enter 发送, Shift+Enter 换行, @ 提及)"
            rows={1}
          />
          <button type="button" onClick={() => void doSend()} disabled={
            (!text.trim() && attachments.length === 0) ||
            attachments.some((a) => a.status === 'uploading')
          }>发送</button>
        </div>
      </div>
    </div>
  );
}
