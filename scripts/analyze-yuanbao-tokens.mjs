import fs from 'node:fs';
import path from 'node:path';

const DATA = 'd:/kuroneko/packages/server/data-yuanbao';
const root = path.join(DATA, 'workspaces');
const usage = fs
  .readFileSync(path.join(DATA, 'usage/llm-usage.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
const reg = JSON.parse(fs.readFileSync(path.join(DATA, 'inner-brain-registry.json'), 'utf8'));
const goalById = Object.fromEntries(reg.map((r) => [r.instanceId, r.goal?.slice(0, 100)]));

const toolCounts = {};
const toolByInst = {};
const readTargets = {};
const skillCalls = {};
const phaseCounts = { decompose: 0, execute: 0, attribute: 0, awaiting: 0, other: 0 };
let totalToolCalls = 0;
let logLines = 0;

function walk(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (ent.name.endsWith('.jsonl') && p.includes(`${path.sep}.run${path.sep}pi-mono${path.sep}logs`)) {
      const parts = p.split(`${path.sep}workspaces${path.sep}`)[1]?.split(path.sep) ?? [];
      const inst = parts[0]?.replace(/^task-/, '') ?? '?';
      for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        logLines++;
        let j;
        try {
          j = JSON.parse(line);
        } catch {
          continue;
        }
        const mod = j.module || '';
        const ev = j.event || '';
        if (mod === 'controller') {
          if (ev === 'decompose.done') phaseCounts.decompose++;
          else if (ev === 'tick.start') {
            const m = j.data?.mode;
            if (m === 'EXECUTE') phaseCounts.execute++;
            else if (m === 'ATTRIBUTE') phaseCounts.attribute++;
            else if (m === 'AWAITING') phaseCounts.awaiting++;
            else phaseCounts.other++;
          }
        }
        if (mod === 'executor' && ev === 'tool.call') {
          totalToolCalls++;
          const name = j.data?.name || '?';
          toolCounts[name] = (toolCounts[name] || 0) + 1;
          toolByInst[inst] = toolByInst[inst] || {};
          toolByInst[inst][name] = (toolByInst[inst][name] || 0) + 1;
          if (name === 'read_file' || name === 'read_peer_file') {
            const target =
              j.data?.args?.path ||
              j.data?.args?.file ||
              JSON.stringify(j.data?.args || {}).slice(0, 120);
            readTargets[target.replace(/\\/g, '/')] =
              (readTargets[target.replace(/\\/g, '/')] || 0) + 1;
          }
          if (name === 'get_skill_content') {
            const sid = j.data?.args?.skill_id || '?';
            skillCalls[sid] = (skillCalls[sid] || 0) + 1;
          }
        }
      }
    }
  }
}
walk(root);

console.log('=== LOG SCAN ===');
console.log('Log lines:', logLines, 'Tool calls:', totalToolCalls);
console.log('\n=== CONTROLLER PHASE TICKS ===', phaseCounts);

console.log('\n=== TOP TOOLS ===');
for (const [k, v] of Object.entries(toolCounts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20)) {
  console.log(k, v, `(${(100 * v) / totalToolCalls}%)`);
}

console.log('\n=== TOP REPEATED READ TARGETS ===');
for (const [k, v] of Object.entries(readTargets)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 30)) {
  console.log(`${v}x`, k.slice(0, 120));
}

console.log('\n=== TOP SKILL FETCHES ===');
for (const [k, v] of Object.entries(skillCalls)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 20)) {
  console.log(`${v}x`, k);
}

const innerUsage = {};
for (const j of usage.filter((x) => x.source === 'inner_pi_mono')) {
  const id = j.instanceId;
  if (!innerUsage[id]) innerUsage[id] = { tokens: 0, calls: 0, prompt: 0 };
  innerUsage[id].tokens += j.totalTokens || 0;
  innerUsage[id].prompt += j.promptTokens || 0;
  innerUsage[id].calls++;
}

console.log('\n=== TOP 8 INSTANCES: token burn vs activity ===');
for (const [id, u] of Object.entries(innerUsage)
  .sort((a, b) => b[1].tokens - a[1].tokens)
  .slice(0, 8)) {
  const rec = reg.find((r) => r.instanceId === id);
  const tools = toolByInst[id] || toolByInst[id.replace(/^ib-/, 'task-ib-')] || {};
  const tc = Object.values(tools).reduce((a, b) => a + b, 0);
  console.log('\n---', id, `${(u.tokens / 1e6).toFixed(2)}M`, `llm=${u.calls}`, `tools=${tc}`);
  console.log('  status:', rec?.status, 'ticks:', rec?.ticks, 'deliverables:', rec?.deliverableCount ?? 0);
  console.log('  goal:', goalById[id]?.replace(/\n/g, ' '));
  console.log(
    '  tools:',
    Object.entries(tools)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([k, v]) => `${k}:${v}`)
      .join(', '),
  );
}

// Cross-burst duplicate reads of same repo files
const repoReads = Object.entries(readTargets)
  .filter(([k]) => k.includes('packages/server') || k.includes('kuroneko'))
  .sort((a, b) => b[1] - a[1]);
console.log('\n=== REPO SOURCE FILE RE-READS (cross-burst) ===');
for (const [k, v] of repoReads.slice(0, 20)) console.log(`${v}x`, k.slice(-100));

// Decompose vs execute token ratio estimate
const decomposeCalls = phaseCounts.decompose;
const executeTicks = phaseCounts.execute;
console.log('\n=== PHASE RATIO ===');
console.log('decompose.done:', decomposeCalls, 'execute ticks:', executeTicks, 'attribute:', phaseCounts.attribute);
