/* ============================================================
   map.js —— 地图数据（第一张：江南大学 · 蠡湖校区）
   ------------------------------------------------------------
   设计依据：蠡湖校区的规划理念是"曲水流觞，生态校园"，水域面积 400 亩，
   中轴线为中央大道，图书馆位于校园中心，南侧临蠡湖，西侧是长广溪湿地。
   这里做的是**抽象化的游戏地图**，不是测绘还原 —— 保留了"一条曲水把校园
   分成东西两岸、靠几座桥连通"这个核心结构，其余按可玩性重新排布。

   坐标系：x 向右为东，z 向下为南（-z 是北），地图范围 [-32, 32]。
   ============================================================ */

export const MAP = {
  name: '江南大学 · 蠡湖校区',
  world: 64,

  /* 水域（多边形，逆时针/顺时针均可） */
  waters: [
    // 曲水：贯穿南北的河道，宽约 6
    [
      [-9, -32], [-5, -16], [-1, 0], [-4, 16], [-8, 32],
      [-2, 32], [2, 16], [5, 0], [1, -16], [-3, -32],
    ],
    // 长广溪湿地：西侧边缘的水带
    [[-32, -32], [-29, -32], [-29, 32], [-32, 32]],
    // 蠡湖：东南角
    [[14, 27], [32, 27], [32, 32], [14, 32]],
  ],

  /* 桥：唯一能过河的地方（矩形），桥面可涂色 */
  bridges: [
    { x0: -7, z0: -18, x1: 3, z1: -14, name: '北桥' },
    { x0: -3, z0: -2, x1: 7, z1: 2, name: '中央桥' },
    { x0: -6, z0: 14, x1: 4, z1: 18, name: '南桥' },
  ],

  /* 建筑：矩形 + 高度，都是不可通行、不可涂色的障碍 */
  buildings: [
    { x0: 12, z0: -6, x1: 24, z1: 6, h: 3.6, name: '图书馆' },
    { x0: 9, z0: -17, x1: 17, z1: -11, h: 2.2, name: '行政楼' },
    { x0: 22, z0: -25, x1: 30, z1: -14, h: 2.8, name: '体育馆' },
    { x0: 12, z0: 10, x1: 22, z1: 17, h: 2.2, name: '设计学院' },
    { x0: 12, z0: 20, x1: 22, z1: 25, h: 2.0, name: '第一教学楼' },
    { x0: -28, z0: -30, x1: -19, z1: -22, h: 2.0, name: '食品学院' },
    { x0: -28, z0: -15, x1: -19, z1: -8, h: 2.0, name: '生物工程学院' },
    { x0: -28, z0: 2, x1: -19, z1: 10, h: 2.0, name: '化工学院' },
    { x0: -28, z0: 17, x1: -19, z1: 24, h: 2.0, name: '环境与土木工程学院' },
  ],

  /* 步道 / 广场：纯装饰，不阻挡移动，只是让地面有"人走过的痕迹" */
  paths: [
    { x0: 7.6, z0: -20, x1: 10.8, z1: 21, kind: 'promenade' },   // 东岸主步道
    { x0: -17.2, z0: -21, x1: -13.8, z1: 22, kind: 'promenade' }, // 西岸主步道
    { x0: 7, z0: -6.5, x1: 12, z1: 6.5, kind: 'plaza' },          // 图书馆前广场
    { x0: 3, z0: 15.5, x1: 10, z1: 18.5, kind: 'cross' },         // 南桥东口
    { x0: -2, z0: -16.5, x1: 3, z1: -13.5, kind: 'cross' },       // 北桥东口
  ],

  /* 出生点：一人一岸，必须走桥才能打到对面 */
  spawn: { me: [-16, 0], bot: [8, 0] },

  /* 练习对手的巡逻路线：三个桥各走一遍，保证它会过河 */
  botPath: [
    [-16, 0], [-5, 0], [7, 0],
    [9, -10], [7, -16], [-5, -16],
    [-16, -13], [-16, 6],
    [-6, 16], [4, 16],
    [9, 12], [9, 4],
    [7, 0], [-5, 0], [-16, 0],
  ],
};

/* 点是否在多边形内（射线法） */
function inPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], zi = poly[i][1];
    const xj = poly[j][0], zj = poly[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function inRect(x, z, r) {
  return x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1;
}

/* 点到矩形的距离（在矩形内为 0） */
function distToRect(x, z, r) {
  const dx = Math.max(r.x0 - x, 0, x - r.x1);
  const dz = Math.max(r.z0 - z, 0, z - r.z1);
  return Math.hypot(dx, dz);
}

function inAnyWater(x, z, map) {
  for (const w of map.waters) if (inPoly(x, z, w)) return true;
  return false;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 树的位置：程序化撒点，带一堆"不许长在这里"的规则。
 * 树干是实心障碍，所以这份数据必须在 buildSolid 之前算出来。
 */
export function makeTrees(map, count = 84, seed = 20261019) {
  const r = mulberry32(seed);
  const out = [];
  const half = map.world / 2 - 2.2;

  const tooClose = (x, z) => {
    for (const t of out) {
      if (Math.hypot(t.x - x, t.z - z) < 2.1) return true;
    }
    return false;
  };

  for (let tries = 0; tries < count * 30 && out.length < count; tries++) {
    let x, z;

    // 近一半放边缘林带，其余撒在校园里，避免中间变成森林
    if (r() < 0.46) {
      const side = Math.floor(r() * 4);
      const t = (r() * 2 - 1) * half;
      const d = half - r() * 3.6;
      if (side === 0) { x = t; z = -d; }
      else if (side === 1) { x = t; z = d; }
      else if (side === 2) { x = -d; z = t; }
      else { x = d; z = t; }
    } else {
      x = (r() * 2 - 1) * half;
      z = (r() * 2 - 1) * half;
    }

    // 建筑里 / 水里 / 桥上不能长
    let bad = false;
    for (const b of map.buildings) if (inRect(x, z, b)) { bad = true; break; }
    if (bad || inAnyWater(x, z, map)) continue;

    // 桥头留出通道
    for (const b of map.bridges) {
      if (distToRect(x, z, b) < 3.2) { bad = true; break; }
    }
    if (bad) continue;

    // 步道上不长树
    for (const p of map.paths) {
      if (distToRect(x, z, p) < 1.9) { bad = true; break; }
    }
    if (bad) continue;

    // 出生点周围留白
    if (Math.hypot(x - map.spawn.me[0], z - map.spawn.me[1]) < 4.5) continue;
    if (Math.hypot(x - map.spawn.bot[0], z - map.spawn.bot[1]) < 4.5) continue;

    // 别挡在 Bot 的航点上
    for (const wp of map.botPath) {
      if (Math.hypot(x - wp[0], z - wp[1]) < 3.4) { bad = true; break; }
    }
    if (bad || tooClose(x, z)) continue;

    const s = 0.52 + r() * 0.52;
    out.push({ x, z, s, r: 0.3 * s });
  }

  return out;
}

/** 路灯：沿两条主步道排开，避开建筑和水面 */
export function makeLamps(map) {
  const out = [];
  const spots = [];
  for (let z = -19; z <= 21; z += 6.2) spots.push([9.4, z], [-15.4, z]);
  spots.push([6.4, 0], [-12.4, 0], [4.5, -15], [5, 16.6]);

  for (const [x, z] of spots) {
    let bad = false;
    for (const b of map.buildings) if (inRect(x, z, b)) { bad = true; break; }
    if (bad || inAnyWater(x, z, map)) continue;
    for (const b of map.bridges) if (distToRect(x, z, b) < 0.8) { bad = true; break; }
    if (bad) continue;
    out.push({ x, z });
  }
  return out;
}

/**
 * 生成"不可通行 / 不可涂色"的格子掩码。
 * 水面会被桥挖掉（桥面是陆地），树干的圆也记为实心。
 */
export function buildSolid(map, world, grid, trees = []) {
  const cell = world / grid;
  const half = world / 2;
  const solid = new Uint8Array(grid * grid);

  for (let row = 0; row < grid; row++) {
    const wz = half - (row + 0.5) * cell;
    for (let col = 0; col < grid; col++) {
      const wx = (col + 0.5) * cell - half;
      const i = row * grid + col;

      for (const b of map.buildings) {
        if (inRect(wx, wz, b)) { solid[i] = 1; break; }
      }
      if (solid[i]) continue;

      // 树干
      for (const t of trees) {
        const dx = wx - t.x, dz = wz - t.z;
        if (dx * dx + dz * dz <= t.r * t.r) { solid[i] = 1; break; }
      }
      if (solid[i]) continue;

      let wet = false;
      for (const w of map.waters) {
        if (inPoly(wx, wz, w)) { wet = true; break; }
      }
      if (!wet) continue;

      let onBridge = false;
      for (const b of map.bridges) {
        if (inRect(wx, wz, b)) { onBridge = true; break; }
      }
      if (!onBridge) solid[i] = 1;
    }
  }
  return solid;
}

