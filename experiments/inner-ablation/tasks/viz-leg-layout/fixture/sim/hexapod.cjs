// 六足仿真几何（训练与物理用）。坐标：x 向右，y 向上，z 向前（机头方向）。
// 机体是瘦长的：前后方向（z）长，左右方向（x）窄。

const BODY_HALF = { x: 0.10, y: 0.03, z: 0.18 };

// 腿序：0..2 右侧（前、中、后），3..5 左侧（前、中、后）。
const LEG_ROWS_Z = [0.12, 0.0, -0.12];
const SIDES = [1, -1];

const SEGMENTS = { coxa: 0.08, femur: 0.16, tibia: 0.2 };

function legAnchors() {
  const out = [];
  for (const side of SIDES) {
    for (const z of LEG_ROWS_Z) {
      out.push({ x: side * BODY_HALF.x, y: 0, z, side });
    }
  }
  return out;
}

/** 腿在水平面上向外伸出的单位方向（coxa 零位） */
function legOutward(i) {
  const a = legAnchors()[i];
  return { x: a.side, y: 0, z: 0 };
}

module.exports = { BODY_HALF, LEG_ROWS_Z, SEGMENTS, legAnchors, legOutward };
