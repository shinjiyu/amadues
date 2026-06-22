import { describe, expect, it } from 'vitest';

import { deriveFactTopic } from './fact-topic.js';

describe('deriveFactTopic', () => {
  it('maps publish_context.json to ctx.publish_context', () => {
    expect(deriveFactTopic('publish_context.json has bookId field')).toBe('ctx.publish_context');
  });

  it('maps fanqie API paths to fanqie.api slug', () => {
    expect(deriveFactTopic('番茄 /api/author/publish_article 须 Playwright')).toBe(
      'fanqie.api.publish_article',
    );
  });

  it('maps fanqie UI/selector to fanqie.ui.editor', () => {
    expect(deriveFactTopic('番茄编辑器 selector .serial-input 有效')).toBe('fanqie.ui.editor');
  });

  it('maps fanqie publish status to fanqie.publish.status', () => {
    expect(deriveFactTopic('chapter_passed_num=5 第5章待发布')).toBe('fanqie.publish.status');
  });

  it('maps fanqie draft strategy to fanqie.publish.draft', () => {
    expect(deriveFactTopic('每次导航 newchapter_0 新草稿 item_id')).toBe('fanqie.publish.draft');
  });

  it('maps fanqie content inject to fanqie.publish.inject', () => {
    expect(deriveFactTopic('番茄 prosemirror 内容注入 clipboardevent paste')).toBe(
      'fanqie.publish.inject',
    );
  });

  it('maps playbook files to playbook basename', () => {
    expect(deriveFactTopic('稳定流程见 workspace/ch4.playbook.json')).toBe('playbook.ch4');
  });

  it('maps workspace chapter artifacts', () => {
    expect(deriveFactTopic('章节正文在 workspace/ch4.txt')).toBe('artifact.ch4');
  });

  it('falls back to general hash for unrelated content', () => {
    const t1 = deriveFactTopic('bot account is gin');
    const t2 = deriveFactTopic('bot account is gin');
    expect(t1).toMatch(/^general\.[a-f0-9]{8}$/);
    expect(t1).toBe(t2);
  });
});
