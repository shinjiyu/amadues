// 六足直播页面的状态应用逻辑。浏览器里由 index.html 引入；也可在 Node 里 require 做测试。
(function (root) {
  function createView() {
    return {
      body: { position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } },
      joints: new Array(18).fill(0),
      hud: { gen: 0, step: 0, reward: 0 },
      frames: 0,
    };
  }

  function applyState(view, msg) {
    if (!msg || msg.type !== 'state') return view;
    const body = msg.body || {};
    const pos = body.position || {};
    view.body.position.x = Number(pos.x) || view.body.position.x;
    view.body.position.y = Number(pos.y) || view.body.position.y;
    view.body.position.z = Number(pos.z) || view.body.position.z;

    const q = body.quaternion || {};
    view.body.quaternion.x = Number(q.x) || 0;
    view.body.quaternion.y = Number(q.y) || 0;
    view.body.quaternion.z = Number(q.z) || 0;
    view.body.quaternion.w = Number(q.w) || 1;

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
