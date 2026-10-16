// 参考解：挂点与朝向按仿真几何（z 为长轴，腿在 x=±半宽 两侧，每侧沿 z 排三条，向 ±x 伸出）。
(function (root) {
  const BODY = { length: 0.36, width: 0.2, height: 0.06 };

  function bodySize() {
    return { x: BODY.width, y: BODY.height, z: BODY.length };
  }

  function legMounts() {
    const rows = [0.12, 0.0, -0.12];
    const out = [];
    for (const side of [1, -1]) {
      for (const r of rows) {
        out.push({ x: side * (BODY.width / 2), y: 0, z: r });
      }
    }
    return out;
  }

  function legYaw() {
    return legMounts().map(m => (m.x > 0 ? 0 : Math.PI));
  }

  const api = { bodySize, legMounts, legYaw };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.HexLayout = api;
})(typeof window !== 'undefined' ? window : globalThis);
