/**
 * 冒烟跑题的进度落盘：status.json + events.jsonl，供 progress-server 推页面。
 */
import fs from 'node:fs';
import path from 'node:path';

export type LiveStatus = {
  updatedAt: string;
  startedAt: string;
  task: string;
  cwd: string;
  pid: number;
  phase: 'starting' | 'act' | 'reflect' | 'judge' | 'done';
  waitingSince: string | null;
  execCount: number;
  execOk: number;
  execFail: number;
  lastCommand: string | null;
  lastOutput: string | null;
  registeredTools: string[];
  /** act 里各工具调用次数（含 exec）。 */
  actToolCalls: Record<string, number>;
  rules: string[];
  skills: string[];
  stopReason: string | null;
  artifacts: {
    indexHtml: boolean;
    assetsGlb: number;
    sceneShot: boolean;
    visionProof: boolean;
    design: boolean;
    agentRules: number;
    agentSkills: number;
  };
};

export type LiveWriter = ReturnType<typeof createLiveWriter>;

export function createLiveWriter(
  liveDir: string,
  seed: {
    task: string;
    cwd: string;
    pid: number;
    startedAt?: string;
  },
) {
  fs.mkdirSync(liveDir, { recursive: true });
  const statusPath = path.join(liveDir, 'status.json');
  const eventsPath = path.join(liveDir, 'events.jsonl');
  fs.writeFileSync(eventsPath, '', 'utf8');

  const startedAt = seed.startedAt ?? new Date().toISOString();
  let status: LiveStatus = {
    updatedAt: startedAt,
    startedAt,
    task: seed.task,
    cwd: seed.cwd,
    pid: seed.pid,
    phase: 'starting',
    waitingSince: null,
    execCount: 0,
    execOk: 0,
    execFail: 0,
    lastCommand: null,
    lastOutput: null,
    registeredTools: [],
    actToolCalls: {},
    rules: [],
    skills: [],
    stopReason: null,
    artifacts: scanWorkArtifacts(seed.cwd),
  };
  persist(status);

  function persist(next: LiveStatus): void {
    status = next;
    fs.writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`, 'utf8');
  }

  function emit(kind: string, patch: Partial<LiveStatus> = {}): void {
    const at = new Date().toISOString();
    const next = { ...status, ...patch, updatedAt: at };
    fs.appendFileSync(eventsPath, `${JSON.stringify({ at, kind, ...patch })}\n`, 'utf8');
    persist(next);
  }

  return {
    path: liveDir,
    statusPath,
    eventsPath,
    get: () => status,
    setPhase(phase: LiveStatus['phase'], waiting = true) {
      emit('phase', {
        phase,
        waitingSince: waiting && phase !== 'done' ? new Date().toISOString() : null,
      });
    },
    exec(command: string, ok: boolean, output: string) {
      emit('exec', {
        phase: 'act',
        waitingSince: null,
        lastCommand: command.slice(0, 500),
        lastOutput: output.slice(0, 400).replace(/\n/g, ' '),
        execCount: status.execCount + 1,
        execOk: status.execOk + (ok ? 1 : 0),
        execFail: status.execFail + (ok ? 0 : 1),
        artifacts: scanWorkArtifacts(status.cwd),
      });
    },
    refreshArtifacts() {
      emit('artifacts', { artifacts: scanWorkArtifacts(status.cwd) });
    },
    tools(registeredTools: string[], rules: string[], skills: string[], actToolCalls?: Record<string, number>) {
      emit('memory', {
        registeredTools,
        rules,
        skills,
        ...(actToolCalls ? { actToolCalls } : {}),
      });
    },
    actTool(name: string, uses: number) {
      emit('act-tool', {
        actToolCalls: { ...status.actToolCalls, [name]: uses },
      });
    },
    done(stopReason: string) {
      emit('done', {
        phase: 'done',
        waitingSince: null,
        stopReason,
        artifacts: scanWorkArtifacts(status.cwd),
      });
    },
    note(kind: string, patch: Partial<LiveStatus> = {}) {
      emit(kind, patch);
    },
  };
}

export function scanWorkArtifacts(cwd: string): LiveStatus['artifacts'] {
  let assetsGlb = 0;
  for (const dir of [path.join(cwd, 'assets'), path.join(cwd, 'models')]) {
    if (!fs.existsSync(dir)) continue;
    try {
      assetsGlb += countGlb(dir);
    } catch {
      // ignore
    }
  }
  const rulesDir = path.join(cwd, '.agent', 'rules');
  const skillsDir = path.join(cwd, '.agent', 'skills');
  return {
    indexHtml: fs.existsSync(path.join(cwd, 'index.html')),
    assetsGlb,
    sceneShot: ['reports/scene.png', 'reports/scene.jpg', 'reports/screenshot.png', 'reports/screenshot.jpg']
      .some(rel => fs.existsSync(path.join(cwd, rel))),
    visionProof: fs.existsSync(path.join(cwd, 'reports/vision-proof.md')),
    design: fs.existsSync(path.join(cwd, 'reports/design.md')),
    agentRules: fs.existsSync(rulesDir)
      ? fs.readdirSync(rulesDir).filter(n => n.endsWith('.md')).length
      : 0,
    agentSkills: fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir).length : 0,
  };
}

export function listWorkRulesSkills(cwd: string): { rules: string[]; skills: string[] } {
  const rulesDir = path.join(cwd, '.agent', 'rules');
  const skillsDir = path.join(cwd, '.agent', 'skills');
  const rules = fs.existsSync(rulesDir)
    ? fs.readdirSync(rulesDir).filter(n => n.endsWith('.md')).map(n => n.slice(0, -3)).sort()
    : [];
  const skills = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir).filter(n => {
      try {
        return fs.existsSync(path.join(skillsDir, n, 'SKILL.md'));
      } catch {
        return false;
      }
    }).sort()
    : [];
  return { rules, skills };
}

function countGlb(dir: string): number {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countGlb(path.join(dir, entry.name));
    else if (/\.glb$/i.test(entry.name)) n += 1;
  }
  return n;
}
