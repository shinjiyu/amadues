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

  if (/newchapter_0|新草稿|draft item|item_id每次|重复使用.*draft|draft.*url/i.test(text)) {
    return 'fanqie.publish.draft';
  }
  if (
    /chapter_passed|已成功发布|latest_publish|chapter_passed_num|待发布|正文字数/i.test(text) ||
    (/已发布/.test(text) && /第\d+章|chapter/i.test(text))
  ) {
    return 'fanqie.publish.status';
  }
  if (
    /clipboardevent|nativeinputvaluesetter|window\.__txt_parts|base64.*paste|内容注入|paste.*prosemirror/i.test(
      text,
    )
  ) {
    return /fanqie|番茄|prosemirror|newchapter/i.test(text)
      ? 'fanqie.publish.inject'
      : 'env.browser.inject';
  }

  if (/fanqie|番茄/.test(text)) {
    const appApi = /\/app\/book\/([a-z0-9_/-]+)/i.exec(raw)?.[1];
    if (appApi) return `fanqie.app.${appApi.toLowerCase().replace(/\//g, '.')}`;
    if (/api|\/api\/author\//i.test(text)) {
      const m = /\/api\/author\/([a-z0-9_/-]+)/i.exec(raw);
      return m?.[1] ? `fanqie.api.${m[1].toLowerCase().replace(/\//g, '.')}` : 'fanqie.api.general';
    }
    if (/newchapter_0|新草稿|draft item|item_id每次|重复使用.*draft|draft.*url/i.test(text)) {
      return 'fanqie.publish.draft';
    }
    if (
      /clipboardevent|nativeinputvaluesetter|window\.__txt_parts|base64.*paste|内容注入|paste.*prosemirror/i.test(
        text,
      )
    ) {
      return 'fanqie.publish.inject';
    }
    if (/prosemirror|syl-editor|正文编辑器/.test(text)) return 'fanqie.ui.prosemirror';
    if (/发布流程|确认发布|仅基础检测|错别字弹窗/.test(text)) return 'fanqie.publish.flow';
    if (
      /chapter_passed|已成功发布|已发布|latest_publish|chapter_passed_num|待发布|正文字数/i.test(text)
    ) {
      return 'fanqie.publish.status';
    }
    if (/ui|编辑器|selector|选择器|serial-input|章节序号/.test(text)) return 'fanqie.ui.editor';
    if (/cookie|sessionid|browser_open/.test(text)) return 'fanqie.auth.cookies';
  }

  if (/playbook|\.playbook\.json/i.test(text)) {
    const m = /([\w.-]+)\.playbook\.json/i.exec(raw);
    if (m?.[1]) return `playbook.${m[1].toLowerCase()}`;
    return 'playbook.general';
  }

  if (/powershell|invoke-webrequest|\.cjs|shell_exec -e/.test(text)) return 'env.powershell.node';

  const ch = /workspace\/ch(\d+)\.txt/i.exec(raw);
  if (ch?.[1]) return `artifact.ch${ch[1]}`;

  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
  return `general.${hash}`;
}
