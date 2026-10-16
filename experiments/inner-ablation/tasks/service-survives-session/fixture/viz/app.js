// 参考解：服务端 body.pos / body.quat 是数组（[x,y,z] / [x,y,z,w]），前端按对象读导致永远不动。
(function (root) {
  function createView() {
    return {
      body: { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } },
      joints: new Array(18).fill(0),
      hud: { gen: 0, step: 0, reward: 0 },
      frames: 0,
    };
  }

  function vec(v, keys) {
    if (Array.isArray(v)) return keys.map((_, i) => Number(v[i]));
    if (v && typeof v === 'object') return keys.map(k => Number(v[k]));
    return keys.map(() => NaN);
  }

  function applyState(view, msg) {
    if (!msg || msg.type !== 'state') return view;
    const body = msg.body || {};
    const [px, py, pz] = vec(body.pos ?? body.position, ['x', 'y', 'z']);
    if (Number.isFinite(px)) view.body.position.x = px;
    if (Number.isFinite(py)) view.body.position.y = py;
    if (Number.isFinite(pz)) view.body.position.z = pz;

    const [qx, qy, qz, qw] = vec(body.quat ?? body.quaternion, ['x', 'y', 'z', 'w']);
    if ([qx, qy, qz, qw].every(Number.isFinite)) {
      view.body.quaternion = { x: qx, y: qy, z: qz, w: qw };
    }

    if (Array.isArray(msg.joints)) view.joints = msg.joints.slice(0, 18);
    view.hud.gen = msg.gen;
    view.hud.step = msg.step;
    view.hud.reward = msg.reward;
    view.frames += 1;
    return view;
  }

  const api = { createView, applyState };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HexViz = api;
})(typeof window !== 'undefined' ? window : globalThis);
