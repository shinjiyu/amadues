import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCjs } from '../../lib/load-cjs.ts';
import { gradeFrom, type AblationTask, type GradeCheck } from '../../types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

type Vec = { x: number; y: number; z: number };

interface SimApi {
  BODY_HALF: Vec;
  legAnchors(): Array<Vec & { side: number }>;
  legOutward(i: number): Vec;
}

interface LayoutApi {
  bodySize(): Vec;
  legMounts(): Vec[];
  legYaw(): number[];
}

const close = (a: number, b: number) => Number.isFinite(a) && Math.abs(a - b) < 1e-6;

export const vizLegLayout: AblationTask = {
  id: 'viz-leg-layout',
  source: {
    instanceIds: ['ib-mv1f2mnn-edac'],
    summary: '直播页 6 条腿挂在身体扁的那侧、看着像 4 条腿；仿真本身正确',
  },
  fixtureDir: path.join(here, 'fixture'),
  referenceDir: path.join(here, 'reference'),
  protectedFiles: ['sim/hexapod.cjs'],

  goal: () =>
    [
      '【修复六足直播 viewer 建模显示】用户反馈直播页上的六足昆虫建模不对：6 条腿看起来挂在身体「扁」的那一侧，像 4 条腿；',
      '正确的应该是腿分布在身体瘦长的两侧、每侧 3 条，并朝身体外侧伸出。',
      '仿真几何在 sim/hexapod.cjs（物理和训练都在用，严禁修改）；页面的模型摆放在 viz/layout.js（index.html 用它画 three.js 场景）。',
      '要求：核对仿真里机体尺寸、6 条腿的挂点与朝向，修改 viz/layout.js，使 bodySize / legMounts / legYaw 与仿真一致，',
      '腿序必须与仿真腿序一致（关节数组按腿序对应）。legYaw 的约定见 layout.js 注释与 index.html 的用法。',
    ].join('\n'),

  async grade(workDir) {
    const checks: GradeCheck[] = [];
    let sim: SimApi;
    let layout: LayoutApi;
    try {
      sim = loadCjs<SimApi>(path.join(workDir, 'sim', 'hexapod.cjs'));
      layout = loadCjs<LayoutApi>(path.join(workDir, 'viz', 'layout.js'));
    } catch (e) {
      checks.push({ name: 'modules_load', ok: false, detail: String(e) });
      return gradeFrom(checks);
    }

    try {
      const size = layout.bodySize();
      const h = sim.BODY_HALF;
      checks.push({
        name: 'body_size_matches_sim',
        ok: close(size.x, 2 * h.x) && close(size.y, 2 * h.y) && close(size.z, 2 * h.z),
        detail: JSON.stringify(size),
      });

      const anchors = sim.legAnchors();
      const mounts = layout.legMounts();
      const mountOk =
        mounts.length === anchors.length &&
        anchors.every((a, i) => close(mounts[i]!.x, a.x) && close(mounts[i]!.y, a.y) && close(mounts[i]!.z, a.z));
      checks.push({ name: 'leg_mounts_match_sim_order', ok: mountOk, detail: JSON.stringify(mounts) });

      const yaws = layout.legYaw();
      // index.html：leg.rotation.y = -yaw，腿几何沿 +x ⇒ 外伸方向 = (cos yaw, 0, sin yaw)
      const yawOk =
        yaws.length === anchors.length &&
        anchors.every((_, i) => {
          const out = sim.legOutward(i);
          return close(Math.cos(yaws[i]!), out.x) && close(Math.sin(yaws[i]!), out.z);
        });
      checks.push({ name: 'leg_yaw_points_outward', ok: yawOk, detail: JSON.stringify(yaws) });
    } catch (e) {
      checks.push({ name: 'grader_error', ok: false, detail: String(e) });
    }
    return gradeFrom(checks);
  },
};
