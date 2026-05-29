/**
 * Forensic replay: why Gin did not reply to @gin messages (reads data-gin/threads.json).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatIRSeenTracker } from '@utlra/chat-ir';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = path.join(__dir, '..', 'data-gin');
const store = JSON.parse(fs.readFileSync(path.join(dataRoot, 'chat', 'threads.json'), 'utf8'));

const AGENT = 'idp:agent:gin';
const THREAD = 'webchat:global';
const MAX_CHAIN = Number(process.env.UTLRA_OUTER_MAX_AGENT_CHAIN ?? '20');
const msgs = store.messages[THREAD] ?? [];
const threadRec = store.threads.find((t) => t.thread_id === THREAD);

function extractText(parts) {
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join(' ')
    .trim();
}

function resolveMeta(content, parts) {
  let threadKind = THREAD.includes('group') ? 'group' : 'dm';
  if (threadKind === 'dm' && (threadRec?.participant_sids?.length ?? 0) >= 3) {
    threadKind = 'group';
  }
  let isMentionAgent = threadKind === 'dm';
  let hasStructuredMentionToOther = false;
  for (const p of parts) {
    if (p.type !== 'mention') continue;
    const targetSid = String(p.target_sid ?? '');
    if (targetSid === AGENT) isMentionAgent = true;
    else if (targetSid) hasStructuredMentionToOther = true;
  }
  const mentionsOthers = isMentionAgent
    ? false
    : hasStructuredMentionToOther || /@[\w\u4e00-\u9fa5]+/.test(content);
  return { threadKind, isMentionAgent, mentionsOthers };
}

function syncSpeak(meta) {
  if (meta.threadKind === 'dm') return { shouldReply: true, reason: 'dm' };
  if (meta.isMentionAgent) return { shouldReply: true, reason: 'group_mention_agent' };
  if (meta.mentionsOthers) return { shouldReply: false, reason: 'group_mention_others' };
  return { shouldReply: false, reason: 'group_proactive_level_0' };
}

function isAgentSid(sid) {
  return /^(idp:)?agent:/i.test(sid) || sid === 'webchat:user:kuroneko' || sid === 'webchat:user:shiro';
}

const targets = [
  { id: 'webchat:6349d703-4eb3-49ee-833f-ada3d2c1478c', label: '09:18 @gin 发' },
  { id: 'webchat:6f6c66ea-05eb-42aa-bf58-5900a7ffcd21', label: '09:32 @gin 你的报告呢' },
  { id: 'webchat:4231c1c3-9828-4e01-aba5-071c1fb68983', label: '09:40 @gin ？？' },
];

const tracker = new ChatIRSeenTracker({ selfAgentSid: AGENT });

console.log('=== Gin silence replay ===');
console.log(`thread participants (${threadRec?.participant_sids?.length}):`, threadRec?.participant_sids?.join(', '));
console.log(`MAX_AGENT_CHAIN=${MAX_CHAIN}\n`);

for (const m of msgs) {
  const idx = msgs.indexOf(m);
  const content = extractText(m.parts);
  const meta = resolveMeta(content, m.parts);
  const chainBefore = tracker.countConsecutiveAgentMessages(THREAD);

  const hit = targets.find((t) => t.id === m.message_id);
  if (hit) {
    const sync = syncSpeak(meta);
    const tail = msgs.slice(Math.max(0, idx - 5), idx);
    const tailAgents = msgs.slice(idx + 1, idx + 6).filter((x) => isAgentSid(x.sender_sid));

    console.log(`--- ${hit.label} ---`);
    console.log(`  sent_at: ${m.sent_at}`);
    console.log(`  content: ${JSON.stringify(content)}`);
    console.log(`  meta: kind=${meta.threadKind} mention_agent=${meta.isMentionAgent} mentions_others=${meta.mentionsOthers}`);
    console.log(`  agent_chain_before_track: ${chainBefore} ${chainBefore >= MAX_CHAIN ? '→ WOULD SKIP' : ''}`);
    console.log(`  policy_sync: shouldReply=${sync.shouldReply} (${sync.reason})`);
    console.log(
      `  freshCheck_risk: ${tailAgents.length} agent msg(s) within next 5 — e.g. ${tailAgents.map((x) => x.sender_sid + '@' + x.sent_at).join('; ') || 'none'}`,
    );
    console.log(`  prev 3 senders: ${tail.map((x) => x.sender_sid).join(' → ')}`);
  }

  tracker.track(THREAD, { message_id: m.message_id, sender_sid: m.sender_sid });
}

// Debounce simulation: after each @gin, what is the last message in next 30s window?
console.log('\n=== Debounce window (30s after each @gin) ===');
for (const t of targets) {
  const m = msgs.find((x) => x.message_id === t.id);
  if (!m) continue;
  const t0 = Date.parse(m.sent_at);
  const window = msgs.filter((x) => {
    const ts = Date.parse(x.sent_at);
    return ts > t0 && ts <= t0 + 30_000;
  });
  const last = window[window.length - 1];
  const lastMeta = last ? resolveMeta(extractText(last.parts), last.parts) : null;
  const lastSync = lastMeta ? syncSpeak(lastMeta) : null;
  console.log(`\n${t.label}:`);
  console.log(`  messages in +30s: ${window.length}`);
  if (last) {
    console.log(`  LAST in window: ${last.sender_sid} @ ${last.sent_at}`);
    console.log(`  LAST mention_agent=${lastMeta?.isMentionAgent} → would_sync_reply=${lastSync?.shouldReply} (${lastSync?.reason})`);
  }
}
