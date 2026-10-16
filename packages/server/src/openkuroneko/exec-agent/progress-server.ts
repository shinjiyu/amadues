/**
 * exec-agent 冒烟进度页。
 *
 *   npx --yes tsx packages/server/src/openkuroneko/exec-agent/progress-server.ts
 *   EXEC_AGENT_EXPERIMENT=exec-agent-blender-frog EXEC_AGENT_PROGRESS_PORT=8933 \
 *     npx --yes tsx packages/server/src/openkuroneko/exec-agent/progress-server.ts
 *
 * 读 experiments/<EXPERIMENT>/live/status.json；无 live 时回退解析 terminals。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  listWorkRulesSkills,
  scanWorkArtifacts,
  type LiveStatus,
} from './live-progress.ts';

const PORT = Number(process.env.EXEC_AGENT_PROGRESS_PORT || 8932);
const EXPERIMENT = process.env.EXEC_AGENT_EXPERIMENT || 'exec-agent-kura-h5';
const RUN_HINT = process.env.EXEC_AGENT_RUN_HINT || (
  EXPERIMENT === 'exec-agent-blender-frog' ? 'run-blender-frog.ts' : 'run-kura-h5.ts'
);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const taskDir = path.join(repoRoot, 'experiments', EXPERIMENT);
const workDir = path.join(taskDir, 'work');
const liveDir = path.join(taskDir, 'live');
const statusPath = path.join(liveDir, 'status.json');
const eventsPath = path.join(liveDir, 'events.jsonl');
const terminalsDir = path.join(
  os.homedir(),
  '.cursor/projects/Users-shinjiyu-Documents-amadues/terminals',
);

type Snapshot = {
  source: 'live' | 'terminal-fallback';
  status: LiveStatus | null;
  recentEvents: Array<Record<string, unknown>>;
  terminalTail: string[];
  agentAlive: boolean;
  hangHint: string | null;
};

function alive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function findKuraTerminal(): { file: string; pid: number | null; startedAt: string | null; body: string } | null {
  if (!fs.existsSync(terminalsDir)) return null;
  const files = fs.readdirSync(terminalsDir)
    .filter(name => name.endsWith('.txt'))
    .map(name => path.join(terminalsDir, name))
    .map(file => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { file } of files) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(RUN_HINT)) continue;
    const pid = Number(text.match(/^pid:\s*(\d+)/m)?.[1] ?? 0) || null;
    const startedAt = text.match(/^started_at:\s*(.+)$/m)?.[1]?.trim() ?? null;
    const body = text.replace(/^---[\s\S]*?---\n/, '');
    return { file, pid, startedAt, body };
  }
  return null;
}

function parseCsvNames(raw: string): string[] {
  const text = raw.trim();
  if (!text || text === '(none)') return [];
  return text.split(',').map(part => part.trim()).filter(Boolean);
}

function parseTerminal(body: string): {
  execCount: number;
  execOk: number;
  execFail: number;
  lastCommand: string | null;
  lastOutput: string | null;
  registeredTools: string[];
  rules: string[];
  skills: string[];
  actToolCalls: Record<string, number>;
  stopReason: string | null;
  lines: string[];
} {
  const lines = body.split(/\r?\n/).filter(Boolean);
  let execCount = 0;
  let execOk = 0;
  let execFail = 0;
  let lastCommand: string | null = null;
  let lastOutput: string | null = null;
  let registeredTools: string[] = [];
  let rules: string[] = [];
  let skills: string[] = [];
  let actToolCalls: Record<string, number> = {};
  let stopReason: string | null = null;

  for (const line of lines) {
    if (line.startsWith('$ ')) {
      execCount += 1;
      lastCommand = line.slice(2);
    } else if (line.startsWith('  -> ok')) {
      execOk += 1;
      lastOutput = line.slice(6).trim();
    } else if (line.startsWith('  -> fail')) {
      execFail += 1;
      lastOutput = line.slice(8).trim();
    }

    const stop = line.match(/^\[exec-agent\] stop=(\S+)/);
    if (stop) stopReason = stop[1];

    const registered = line.match(/^\[exec-agent\] registered (.+)$/);
    if (registered) registeredTools = parseCsvNames(registered[1]);

    const memory = line.match(/^\[exec-agent\] rules (.+) skills (.+)$/);
    if (memory) {
      rules = parseCsvNames(memory[1]);
      skills = parseCsvNames(memory[2]);
    }

    const calls = line.match(/^\[exec-agent\] act calls (.+)$/);
    if (calls) {
      const next: Record<string, number> = {};
      for (const part of calls[1].split(',')) {
        const match = part.trim().match(/^(.+?)×(\d+)$/);
        if (!match) continue;
        next[match[1]] = Number(match[2]);
      }
      actToolCalls = next;
    }
  }

  return {
    execCount,
    execOk,
    execFail,
    lastCommand,
    lastOutput,
    registeredTools,
    rules,
    skills,
    actToolCalls,
    stopReason,
    lines,
  };
}

function hangHint(status: LiveStatus | null, agentAlive: boolean): string | null {
  if (!agentAlive || !status?.waitingSince) return null;
  const waitedMs = Date.now() - Date.parse(status.waitingSince);
  if (!Number.isFinite(waitedMs) || waitedMs < 180_000) return null;
  const mins = Math.round(waitedMs / 60_000);
  return `Waiting on ${status.phase} LLM for ~${mins}m — likely hung.`;
}

function enrichFromWorkAndTerminal(
  status: LiveStatus,
  parsed: ReturnType<typeof parseTerminal> | null,
): LiveStatus {
  const disk = listWorkRulesSkills(workDir);
  if (status.rules.length === 0 && disk.rules.length > 0) status.rules = disk.rules;
  if (status.skills.length === 0 && disk.skills.length > 0) status.skills = disk.skills;
  if (parsed) {
    if (status.registeredTools.length === 0 && parsed.registeredTools.length > 0) {
      status.registeredTools = parsed.registeredTools;
    }
    if (Object.keys(status.actToolCalls ?? {}).length === 0 && Object.keys(parsed.actToolCalls).length > 0) {
      status.actToolCalls = parsed.actToolCalls;
    }
    if (status.rules.length === 0 && parsed.rules.length > 0) status.rules = parsed.rules;
    if (status.skills.length === 0 && parsed.skills.length > 0) status.skills = parsed.skills;
    if (!status.stopReason && parsed.stopReason) status.stopReason = parsed.stopReason;
  }
  status.actToolCalls ??= {};
  return status;
}

function buildSnapshot(): Snapshot {
  const artifacts = scanWorkArtifacts(workDir);
  const term = findKuraTerminal();
  const parsed = term ? parseTerminal(term.body) : null;

  if (fs.existsSync(statusPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(statusPath, 'utf8')) as LiveStatus;
      const status = enrichFromWorkAndTerminal(
        {
          ...raw,
          artifacts,
          actToolCalls: raw.actToolCalls ?? {},
          registeredTools: raw.registeredTools ?? [],
          rules: raw.rules ?? [],
          skills: raw.skills ?? [],
        },
        parsed,
      );
      const agentAlive = alive(status.pid) || alive(term?.pid);
      let recentEvents: Array<Record<string, unknown>> = [];
      if (fs.existsSync(eventsPath)) {
        recentEvents = fs.readFileSync(eventsPath, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .slice(-80)
          .map(line => JSON.parse(line) as Record<string, unknown>);
      }
      return {
        source: 'live',
        status,
        recentEvents,
        terminalTail: parsed?.lines.slice(-40) ?? [],
        agentAlive,
        hangHint: hangHint(status, agentAlive),
      };
    } catch {
      // fall through
    }
  }

  const startedAt = term?.startedAt ?? new Date().toISOString();
  const agentAlive = alive(term?.pid);
  let status: LiveStatus = {
    updatedAt: new Date().toISOString(),
    startedAt,
    task: EXPERIMENT,
    cwd: workDir,
    pid: term?.pid ?? 0,
    phase: agentAlive ? 'act' : 'done',
    waitingSince: null,
    execCount: parsed?.execCount ?? 0,
    execOk: parsed?.execOk ?? 0,
    execFail: parsed?.execFail ?? 0,
    lastCommand: parsed?.lastCommand ?? null,
    lastOutput: parsed?.lastOutput ?? null,
    registeredTools: parsed?.registeredTools ?? [],
    actToolCalls: parsed?.actToolCalls ?? {},
    rules: parsed?.rules ?? [],
    skills: parsed?.skills ?? [],
    stopReason: parsed?.stopReason ?? (agentAlive ? null : 'unknown'),
    artifacts,
  };
  status = enrichFromWorkAndTerminal(status, parsed);
  if (agentAlive && term) {
    const ageMs = Date.now() - fs.statSync(term.file).mtimeMs;
    if (ageMs > 180_000) {
      status.waitingSince = new Date(Date.now() - ageMs).toISOString();
      status.phase = 'reflect';
    }
  }
  return {
    source: 'terminal-fallback',
    status,
    recentEvents: [],
    terminalTail: parsed?.lines.slice(-40) ?? [],
    agentAlive,
    hangHint: hangHint(status, agentAlive),
  };
}

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>exec-agent · Kura H5 progress</title>
  <style>
    :root {
      --bg: #f4f0e8;
      --ink: #1c1915;
      --muted: #6b645a;
      --card: #fffdf8;
      --line: #d9d0c2;
      --ok: #2f6b3a;
      --fail: #9b2c2c;
      --wait: #8a5a12;
      --accent: #1f4e6b;
      --vision: #5b3d8a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.45 "IBM Plex Sans", "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(1000px 500px at 10% -10%, #e7efe8 0%, transparent 55%),
        radial-gradient(800px 400px at 100% 0%, #e4ebf2 0%, transparent 50%),
        var(--bg);
      min-height: 100vh;
    }
    main { max-width: 980px; margin: 0 auto; padding: 28px 20px 48px; }
    h1 { font: 600 28px/1.2 "IBM Plex Serif", Georgia, serif; margin: 0 0 6px; }
    .sub { color: var(--muted); margin-bottom: 22px; }
    .row { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
    .chip {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 6px 12px;
      font-variant-numeric: tabular-nums;
    }
    .chip.ok { color: var(--ok); }
    .chip.fail { color: var(--fail); }
    .chip.wait { color: var(--wait); border-color: #e0c28a; background: #fff7e8; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 18px; }
    .tile {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px 14px;
    }
    .tile .k { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
    .tile .v { font-size: 22px; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums; }
    .tile.on .v { color: var(--ok); }
    .tile.off .v { color: var(--muted); }
    .panel {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 14px 16px;
      margin-bottom: 14px;
    }
    .panel h2 { margin: 0 0 10px; font-size: 15px; color: var(--accent); }
    .tool-list { display: flex; flex-wrap: wrap; gap: 8px; }
    .tool {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 6px 10px;
      font: 12px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
      background: #faf7f1;
    }
    .tool.used { border-color: #9bb8a3; background: #eef6f0; }
    .tool.vision { border-color: #c4b0df; background: #f4eefb; color: var(--vision); }
    .tool .n { color: var(--muted); margin-left: 6px; }
    .empty { color: var(--muted); }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
      max-height: 360px;
      overflow: auto;
    }
    .warn {
      background: #fff1f0;
      border: 1px solid #efc2c0;
      color: var(--fail);
      border-radius: 10px;
      padding: 10px 12px;
      margin-bottom: 14px;
    }
    .meta { color: var(--muted); font-size: 12px; }
  </style>
</head>
<body>
  <main>
    <h1>Kura H5 · exec-agent</h1>
    <div class="sub">Live progress for the lighting + vision smoke run.</div>
    <div id="warn" class="warn" hidden></div>
    <div class="row" id="chips"></div>
    <div class="grid" id="gates"></div>
    <div class="panel">
      <h2>Invented tools <span id="tool-count" class="empty"></span></h2>
      <div class="tool-list" id="tools"></div>
    </div>
    <div class="panel">
      <h2>Rules & skills</h2>
      <pre id="memory"></pre>
    </div>
    <div class="panel">
      <h2>Last command</h2>
      <pre id="last"></pre>
    </div>
    <div class="panel">
      <h2>Terminal tail</h2>
      <pre id="tail"></pre>
    </div>
    <div class="meta" id="meta"></div>
  </main>
  <script>
    const el = id => document.getElementById(id);
    function ago(iso) {
      if (!iso) return '—';
      const ms = Date.now() - Date.parse(iso);
      if (!Number.isFinite(ms) || ms < 0) return iso;
      const s = Math.floor(ms / 1000);
      if (s < 60) return s + 's';
      const m = Math.floor(s / 60);
      if (m < 60) return m + 'm ' + (s % 60) + 's';
      return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
    }
    function isVisionName(name) {
      return /vision|see_|image|shot|snap|scene|capture/i.test(name);
    }
    function renderTools(s) {
      const names = s.registeredTools || [];
      const calls = s.actToolCalls || {};
      el('tool-count').textContent = names.length ? '(' + names.length + ')' : '';
      if (!names.length) {
        el('tools').innerHTML = '<div class="empty">No seeded tools (exec only).</div>';
        return;
      }
      el('tools').innerHTML = names.map(name => {
        const n = calls[name] || 0;
        const cls = ['tool', n > 0 ? 'used' : '', isVisionName(name) ? 'vision' : ''].filter(Boolean).join(' ');
        return '<div class="' + cls + '">' + name + '<span class="n">×' + n + '</span></div>';
      }).join('');
    }
    function render(snap) {
      const s = snap.status;
      const warn = el('warn');
      if (snap.hangHint) {
        warn.hidden = false;
        warn.textContent = snap.hangHint;
      } else {
        warn.hidden = true;
      }
      if (!s) {
        el('chips').innerHTML = '<span class="chip">no run data</span>';
        return;
      }
      const invented = (s.registeredTools || []).length;
      const usedInvented = (s.registeredTools || []).filter(name => (s.actToolCalls || {})[name] > 0).length;
      const waitChip = s.waitingSince
        ? '<span class="chip wait">waiting ' + s.phase + ' · ' + ago(s.waitingSince) + '</span>'
        : '<span class="chip">phase ' + s.phase + '</span>';
      el('chips').innerHTML = [
        '<span class="chip">' + (snap.agentAlive ? 'running' : 'stopped') + '</span>',
        waitChip,
        '<span class="chip">elapsed ' + ago(s.startedAt) + '</span>',
        '<span class="chip ok">ok ' + s.execOk + '</span>',
        '<span class="chip fail">fail ' + s.execFail + '</span>',
        '<span class="chip">exec ×' + s.execCount + '</span>',
        '<span class="chip ok">tools ' + invented + ' · used ' + usedInvented + '</span>',
        '<span class="chip">source ' + snap.source + '</span>',
      ].join('');
      const a = s.artifacts || {};
      const tiles = [
        ['index.html', a.indexHtml],
        ['GLB assets', a.assetsGlb],
        ['scene shot', a.sceneShot],
        ['vision proof', a.visionProof],
        ['design.md', a.design],
        ['rules', a.agentRules],
        ['skills', a.agentSkills],
        ['invented', invented],
      ];
      el('gates').innerHTML = tiles.map(([k, v]) => {
        const on = typeof v === 'boolean' ? v : v > 0;
        const label = typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v);
        return '<div class="tile ' + (on ? 'on' : 'off') + '"><div class="k">' + k + '</div><div class="v">' + label + '</div></div>';
      }).join('');
      renderTools(s);
      el('memory').textContent = [
        (s.rules || []).length ? 'rules: ' + s.rules.join(', ') : 'rules: (none)',
        (s.skills || []).length ? 'skills: ' + s.skills.join(', ') : 'skills: (none)',
        s.stopReason ? 'stop: ' + s.stopReason : '',
      ].filter(Boolean).join('\\n');
      el('last').textContent = [
        s.lastCommand ? '$ ' + s.lastCommand : '(no command yet)',
        s.lastOutput ? '→ ' + s.lastOutput : '',
      ].filter(Boolean).join('\\n');
      el('tail').textContent = (snap.terminalTail || []).join('\\n') || '(empty)';
      el('meta').textContent = 'updated ' + ago(s.updatedAt) + ' ago · pid ' + (s.pid || '—') + ' · ' + (s.cwd || '');
    }
    async function tick() {
      try {
        const snap = await fetch('/api/snapshot').then(r => r.json());
        render(snap);
      } catch (err) {
        el('warn').hidden = false;
        el('warn').textContent = String(err);
      }
    }
    tick();
    setInterval(tick, 1500);
    try {
      const es = new EventSource('/api/stream');
      es.onmessage = (ev) => { try { render(JSON.parse(ev.data)); } catch {} };
    } catch {}
  </script>
</body>
</html>
`;

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';
  if (url === '/' || url.startsWith('/index')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  if (url.startsWith('/api/snapshot')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(buildSnapshot()));
    return;
  }
  if (url.startsWith('/api/stream')) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = () => {
      res.write(`data: ${JSON.stringify(buildSnapshot())}\n\n`);
    };
    send();
    const timer = setInterval(send, 1500);
    req.on('close', () => clearInterval(timer));
    return;
  }
  res.writeHead(404).end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[progress] http://127.0.0.1:${PORT}`);
  console.log(`[progress] live ${statusPath}`);
  console.log(`[progress] work ${workDir}`);
});
