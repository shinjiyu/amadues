/**
 * Replay ChatIRSeenTracker + freshCheck for Gin silence window.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatIRSeenTracker } from '@utlra/chat-ir';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const dataRoot = path.join(__dir, '..', 'data-gin');
const store = JSON.parse(fs.readFileSync(path.join(dataRoot, 'chat', 'threads.json'), 'utf8'));
const identities = JSON.parse(fs.readFileSync(path.join(dataRoot, 'identities.json'), 'utf8'));
const kindBySid = new Map(identities.map((i) => [i.sid, i.kind]));

const AGENT = 'idp:agent:gin';
const THREAD = 'webchat:global';
const msgs = (store.messages[THREAD] ?? []).sort(
  (a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at),
);

const registryStub = { get: (sid) => (kindBySid.has(sid) ? { kind: kindBySid.get(sid) } : undefined) };
const tracker = new ChatIRSeenTracker({ selfAgentSid: AGENT, identityRegistry: registryStub });

const triggers = [
  'webchat:6349d703-4eb3-49ee-833f-ada3d2c1478c',
  'webchat:6f6c66ea-05eb-42aa-bf58-5900a7ffcd21',
  'webchat:4231c1c3-9828-4e01-aba5-071c1fb68983',
];

function isAgent(sid) {
  if (/^(idp:)?agent:/i.test(sid)) return true;
  return kindBySid.get(sid) === 'agent';
}

console.log('=== freshCheck replay (kuroneko/shiro count as agent via registry) ===\n');

for (const m of msgs) {
  tracker.track(THREAD, { message_id: m.message_id, sender_sid: m.sender_sid });

  for (const tid of triggers) {
    if (m.message_id === tid) {
      const fc = tracker.hasAnotherAgentRepliedAfter(THREAD, tid);
      console.log(`@ trigger ${m.sent_at.slice(11, 19)} id=${tid.slice(-8)}`);
      console.log(`  freshCheck NOW (right after track): ${fc}`);
    }
  }

  for (const tid of triggers) {
    if (tracker.hasAnotherAgentRepliedAfter(THREAD, tid)) {
      const already = msgs.findIndex((x) => x.message_id === tid);
      if (already >= 0 && msgs.indexOf(m) > already && m.message_id !== tid) {
        const t0 = msgs[already];
        if (m.message_id === triggers.find((id) => id === tid)) continue;
      }
    }
  }
}

console.log('\n=== When would freshCheck flip true? ===\n');
for (const tid of triggers) {
  const trig = msgs.find((x) => x.message_id === tid);
  if (!trig) continue;
  const t0 = Date.parse(trig.sent_at);
  const blockers = msgs.filter((x) => {
    const t = Date.parse(x.sent_at);
    return t > t0 && isAgent(x.sender_sid) && x.sender_sid !== AGENT;
  });
  console.log(`trigger ${trig.sent_at.slice(11, 19)} (${tid.slice(-8)})`);
  if (!blockers.length) {
    console.log('  no other-agent messages after trigger in full history');
  } else {
    const first = blockers[0];
    const delta = ((Date.parse(first.sent_at) - t0) / 1000).toFixed(1);
    console.log(
      `  FIRST blocker: ${first.sender_sid} @ ${first.sent_at.slice(11, 19)} (+${delta}s)`,
    );
    console.log(`  text: ${JSON.stringify(first.parts?.find((p) => p.type === 'text')?.text?.slice(0, 50))}`);
  }
}
