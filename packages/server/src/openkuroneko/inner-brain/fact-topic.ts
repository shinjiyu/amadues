/**
 * Fact topic normalization — merge key for supersede-on-write.
 *
 * ADL：doc/structurizr/FACTS-KNOWLEDGE-GOVERNANCE.md §4.1
 */

import crypto from 'node:crypto';

function norm(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 从事实陈述机械推导 topic（P0 启发式） */
export function deriveFactTopic(content: string): string {
  const text = norm(content);
  const raw = content.replace(/\s+/g, ' ').trim();

  if (/publish_context\.json/i.test(text)) return 'ctx.publish_context';

  if (/fanqie|番茄/.test(text)) {
    if (/api|\/api\/author\//i.test(text)) {
      const m = /\/api\/author\/([a-z0-9_-]+)/i.exec(raw);
      return m?.[1] ? `fanqie.api.${m[1].toLowerCase()}` : 'fanqie.api.general';
    }
    if (/ui|编辑器|selector|选择器/i.test(text)) return 'fanqie.ui.editor';
  }

  if (/playbook|\.playbook\.json/i.test(text)) {
    const m = /([\w.-]+)\.playbook\.json/i.exec(raw);
    if (m?.[1]) return `playbook.${m[1].toLowerCase()}`;
    return 'playbook.general';
  }

  const ch = /workspace\/ch(\d+)\.txt/i.exec(raw);
  if (ch?.[1]) return `artifact.ch${ch[1]}`;

  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
  return `general.${hash}`;
}
