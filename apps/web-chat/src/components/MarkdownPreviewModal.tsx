import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Attachment } from '@utlra/webchat-protocol';

interface Props {
  attachment: Attachment;
  onClose: () => void;
}

export function MarkdownPreviewModal({ attachment, onClose }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);

    fetch(attachment.url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.text();
      })
      .then((text) => {
        if (!cancelled) setContent(text);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : '加载失败');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [attachment.url]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="md-preview-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="md-preview-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="md-preview-panel">
        <header className="md-preview-header">
          <h2 id="md-preview-title" className="md-preview-title">
            {attachment.name}
          </h2>
          <div className="md-preview-header-actions">
            <a
              className="md-preview-download"
              href={attachment.url}
              download={attachment.name}
              target="_blank"
              rel="noreferrer"
            >
              下载
            </a>
            <button type="button" className="md-preview-close" onClick={onClose} aria-label="关闭">
              ×
            </button>
          </div>
        </header>
        <div className="md-preview-body">
          {loading && <p className="md-preview-status">加载中…</p>}
          {error && <p className="md-preview-status md-preview-error">{error}</p>}
          {!loading && !error && content !== null && (
            <article className="md-rendered">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </article>
          )}
        </div>
      </div>
    </div>
  );
}

/** 附件是否为 Markdown（按 MIME 或扩展名）。 */
export function isMarkdownAttachment(att: { mime: string; name: string }): boolean {
  const mime = att.mime.toLowerCase();
  if (
    mime === 'text/markdown' ||
    mime === 'text/x-markdown' ||
    mime.includes('markdown')
  ) {
    return true;
  }
  const lower = att.name.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}
