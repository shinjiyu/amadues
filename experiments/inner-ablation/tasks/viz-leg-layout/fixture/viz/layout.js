// 直播页里六足模型的摆放（three.js 场景用）。浏览器里挂在 window.HexLayout；Node 里可 require。
(function (root) {
  const BODY = { length: 0.36, width: 0.2, height: 0.06 };

  /** three.js BoxGeometry(x, y, z) 的尺寸 */
  function bodySize() {
    return { x: BODY.width, y: BODY.height, z: BODY.length };
  }

  /** 6 条腿在机体坐标里的挂点，顺序与仿真腿序、关节数组一致 */
  function legMounts() {
    const rows = [0.12, 0.0, -0.12];
    const out = [];
    for (const side of [1, -1]) {
      for (const r of rows) {
        out.push({ x: r, y: 0, z: side * (BODY.width / 2) });
      }
    }
    return out;
  }

  /** 每条腿绕 y 轴的朝向（弧度）；0 表示沿 +x 伸出 */
  function legYaw() {
    return legMounts().map(m => (m.z > 0 ? Math.PI / 2 : -Math.PI / 2));
  }

  const api = { bodySize, legMounts, legYaw };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HexLayout = api;
})(typeof window !== 'undefined' ? window : globalThis);
