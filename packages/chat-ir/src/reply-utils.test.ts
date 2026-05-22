import { describe, expect, it } from 'vitest';
import { StructuredReplySchema } from './schemas/reply.js';
import {
  collectMentionSidsFromReply,
  mergeStructuredReply,
  parseJsonObjectFromLlmText,
  renderMockChannel,
  validateReplyMentions,
} from './reply-utils.js';
import { resolvePrimaryAgentSid } from './agent-sid.js';

describe('parseJsonObjectFromLlmText', () => {
  it('parses fenced json', () => {
    const raw = '```json\n{"text":"hi","mention_sids":[]}\n```';
    expect(parseJsonObjectFromLlmText(raw)).toEqual({ text: 'hi', mention_sids: [] });
  });

  it('parses bare object with surrounding prose', () => {
    const raw = 'Here:\n{"text":"x","mention_sids":["idp:a"]}\ntrailing';
    expect(parseJsonObjectFromLlmText(raw)).toEqual({ text: 'x', mention_sids: ['idp:a'] });
  });
});

describe('mergeStructuredReply', () => {
  it('injects schema and thread_id', () => {
    const r = mergeStructuredReply('tid', { text: 'hello', mention_sids: ['idp:u:1'] });
    expect(r).toMatchObject({
      schema: 'reply.v1',
      thread_id: 'tid',
      text: 'hello',
      mention_sids: ['idp:u:1'],
    });
  });
});

describe('StructuredReply parts + mentions', () => {
  it('collects mention_sids and parts mentions', () => {
    const primary = resolvePrimaryAgentSid();
    const r = StructuredReplySchema.parse({
      schema: 'reply.v1',
      thread_id: 't1',
      text: 'hi',
      mention_sids: ['idp:peer:other'],
      parts: [{ type: 'mention', target_sid: primary, label: 'bot' }],
    });
    const sids = collectMentionSidsFromReply(r);
    expect(sids.sort()).toEqual([primary, 'idp:peer:other'].sort());
  });

  it('validateReplyMentions checks all sids', () => {
    const r = StructuredReplySchema.parse({
      schema: 'reply.v1',
      thread_id: 't1',
      text: 'x',
      parts: [{ type: 'mention', target_sid: 'idp:unknown', label: 'x' }],
    });
    const allowed = new Set(['idp:unknown']);
    expect(validateReplyMentions(r, allowed).ok).toBe(true);
    expect(validateReplyMentions(r, new Set(['idp:user:demo'])).ok).toBe(false);
  });

  it('renderMockChannel includes parts suffix', () => {
    const r = StructuredReplySchema.parse({
      schema: 'reply.v1',
      thread_id: 't1',
      text: 'note',
      mention_sids: [],
      parts: [
        { type: 'attachment', asset_ref: { kind: 'image', uri: 'https://x/a.png', name: 'a' } },
      ],
    });
    const m = renderMockChannel(r);
    expect(m.wireText).toContain('--- parts ---');
    expect(m.wireText).toContain('[image:');
  });
});
