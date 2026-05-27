import { useState } from 'react';
import type { Attachment } from '@utlra/webchat-protocol';
import { isMarkdownAttachment, MarkdownPreviewModal } from './MarkdownPreviewModal.js';

interface Props {
  attachment: Attachment;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function FileAttachmentCard({ attachment }: Props) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const isMd = isMarkdownAttachment(attachment);

  if (isMd) {
    return (
      <>
        <button
          type="button"
          className="file-card file-card-button"
          onClick={() => setPreviewOpen(true)}
          title="预览 Markdown"
        >
          <span>📄</span>
          <span>{attachment.name}</span>
          <span className="file-card-meta">{humanSize(attachment.size)}</span>
        </button>
        {previewOpen && (
          <MarkdownPreviewModal attachment={attachment} onClose={() => setPreviewOpen(false)} />
        )}
      </>
    );
  }

  return (
    <a
      className="file-card"
      href={attachment.url}
      target="_blank"
      rel="noreferrer"
      download={attachment.name}
    >
      <span>📎</span>
      <span>{attachment.name}</span>
      <span className="file-card-meta">{humanSize(attachment.size)}</span>
    </a>
  );
}
