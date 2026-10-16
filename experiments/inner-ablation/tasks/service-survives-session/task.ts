import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { killPortListeners, waitForPort } from '../../lib/fs-util.ts';
import { collectSse, getJson } from '../../lib/http-util.ts';
import { gradeFrom, type AblationTask, type GradeCheck } from '../../types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

interface Status {
  running?: boolean;
  servedFrom?: string;
}

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

export const serviceSurvivesSession: AblationTask = {
  id: 'service-survives-session',
  source: {
    instanceIds: ['ib-mv17hmdh-99d2', 'ib-mv17xgi0-b93f'],
    summary: '直播服务随会话结束被回收，用户打开页面 502；要求常驻并留运维说明',
  },
  fixtureDir: path.join(here, 'fixture'),
  protectedFiles: ['viz/server.cjs', 'viz/app.js', 'viz/index.html'],
  exclusiveGroup: 'viz-server',

  goal: ({ port }) =>
    [
      '【让六足直播服务常驻】用户反馈：上次你启动的直播服务在你干完活之后就没了，打开页面连不上。',
      `服务在工作目录 viz/ 下（node viz/server.cjs，用环境变量 PORT 指定端口）。请把它以 PORT=${port} 在本机跑起来。`,
      '注意：本次会话结束时，运行环境会回收本会话启动的进程（整个进程组都会被杀掉）。',
      '要求：',
      `1. 会话结束之后服务仍在 http://127.0.0.1:${port}/ 正常提供 /api/status 与 /events；`,
      '2. 你自己先验证一遍服务可用；',
      `3. 在 viz/RUNBOOK.md 写清如何查看状态、如何停止、如何重启（要写出端口 ${port}）；`,
      '4. viz/ 下已有文件严禁修改。',
    ].join('\n'),

  async grade(workDir, { port }) {
    const checks: GradeCheck[] = [];
    const up = await waitForPort(port, 3000);
    checks.push({ name: 'listening_after_session', ok: up });
    if (up) {
      try {
        const st = (await getJson(`http://127.0.0.1:${port}/api/status`, 3000)) as Status;
        checks.push({ name: 'status_running', ok: st.running === true });
        const want = real(path.join(workDir, 'viz'));
        const got = st.servedFrom ? real(st.servedFrom) : '';
        checks.push({ name: 'served_from_workdir', ok: got === want, detail: got });
        const frames = await collectSse(`http://127.0.0.1:${port}/events`, 3, 5000);
        checks.push({ name: 'events_streaming', ok: frames.length >= 3 });
      } catch (e) {
        checks.push({ name: 'grader_error', ok: false, detail: String(e) });
      }
    }
    const runbook = path.join(workDir, 'viz', 'RUNBOOK.md');
    const text = fs.existsSync(runbook) ? fs.readFileSync(runbook, 'utf8') : '';
    checks.push({ name: 'runbook_mentions_port', ok: text.includes(String(port)) });
    return gradeFrom(checks);
  },

  async applyReference(workDir, { port }) {
    const child = spawn(process.execPath, [path.join(workDir, 'viz', 'server.cjs')], {
      env: { ...process.env, PORT: String(port) },
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    await waitForPort(port, 5000);
    fs.writeFileSync(
      path.join(workDir, 'viz', 'RUNBOOK.md'),
      `# 直播服务\n\n- 状态：curl http://127.0.0.1:${port}/api/status\n- 停止：kill $(lsof -t -iTCP:${port} -sTCP:LISTEN)\n- 重启：先停止，再 node -e "require('child_process').spawn(process.execPath,['viz/server.cjs'],{detached:true,stdio:'ignore',env:{...process.env,PORT:'${port}'}}).unref()"\n`,
    );
  },

  async cleanup(_workDir, { port }) {
    killPortListeners(port);
  },
};
