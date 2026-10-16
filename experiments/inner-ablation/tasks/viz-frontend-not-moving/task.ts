import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { freePort, waitForPort } from '../../lib/fs-util.ts';
import { collectSse } from '../../lib/http-util.ts';
import { loadCjs } from '../../lib/load-cjs.ts';
import { gradeFrom, type AblationTask, type GradeCheck } from '../../types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

interface StateMsg {
  type: string;
  body: { pos: number[]; quat: number[] };
}

interface View {
  body: {
    position: { x: number; y: number; z: number };
    quaternion: { x: number; y: number; z: number; w: number };
  };
}

interface VizApi {
  createView(): View;
  applyState(view: View, msg: unknown): View;
}

const close = (a: number, b: number) => Number.isFinite(a) && Math.abs(a - b) < 1e-6;

export const vizFrontendNotMoving: AblationTask = {
  id: 'viz-frontend-not-moving',
  source: {
    instanceIds: ['ib-mv1c9fl3-74f9', 'ib-mv4k2u02-5ef3'],
    summary: '直播页虫子不动：后端 SSE 在动，前端 applyState 读错字段',
  },
  fixtureDir: path.join(here, 'fixture'),
  referenceDir: path.join(here, 'reference'),
  protectedFiles: ['viz/server.cjs'],
  exclusiveGroup: 'viz-server',

  goal: ({ port }) =>
    [
      '【排查六足直播虫子不动】用户打开六足训练直播页，能看到虫子但它一直不动，HUD 上的 gen/step 在涨。',
      `服务代码在工作目录 viz/ 下（server.cjs 推 SSE /events，index.html + app.js 渲染）。需要时可以用 PORT=${port} 在本机启动它来观察。`,
      '要求：',
      '1. 先确认问题出在服务端数据还是前端渲染（采样 /events 的真实消息看机体位置是否在变）；',
      '2. 修好问题，使页面上的机体位置与姿态跟随服务端推送的每一帧；',
      '3. server.cjs 是训练循环，严禁修改。',
      '完成后停掉你自己启动的服务。',
    ].join('\n'),

  async grade(workDir) {
    const checks: GradeCheck[] = [];
    const port = await freePort();
    const srv = spawn(process.execPath, [path.join(workDir, 'viz', 'server.cjs')], {
      env: { ...process.env, PORT: String(port) },
      stdio: 'ignore',
    });
    try {
      const up = await waitForPort(port, 5000);
      checks.push({ name: 'server_starts', ok: up });
      if (!up) return gradeFrom(checks);

      const frames = (await collectSse(`http://127.0.0.1:${port}/events`, 12, 8000)) as StateMsg[];
      let api: VizApi;
      try {
        api = loadCjs<VizApi>(path.join(workDir, 'viz', 'app.js'));
      } catch (e) {
        checks.push({ name: 'app_loads', ok: false, detail: String(e) });
        return gradeFrom(checks);
      }
      checks.push({ name: 'app_loads', ok: typeof api.applyState === 'function' && typeof api.createView === 'function' });

      const view = api.createView();
      let posOk = 0;
      let quatOk = 0;
      for (const f of frames) {
        api.applyState(view, f);
        const [x, y, z] = f.body.pos;
        const [qx, qy, qz, qw] = f.body.quat;
        const p = view.body.position;
        const q = view.body.quaternion;
        if (close(p.x, x!) && close(p.y, y!) && close(p.z, z!)) posOk += 1;
        if (close(q.x, qx!) && close(q.y, qy!) && close(q.z, qz!) && close(q.w, qw!)) quatOk += 1;
      }
      checks.push({ name: 'position_follows_frames', ok: posOk === frames.length, detail: `${posOk}/${frames.length}` });
      checks.push({ name: 'orientation_follows_frames', ok: quatOk === frames.length, detail: `${quatOk}/${frames.length}` });
    } catch (e) {
      checks.push({ name: 'grader_error', ok: false, detail: String(e) });
    } finally {
      srv.kill('SIGKILL');
    }
    return gradeFrom(checks);
  },
};
