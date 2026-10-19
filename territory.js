/* ============================================================
   territory.js —— 地盘逻辑（纯 JS，不依赖 three.js）
   ------------------------------------------------------------
   单机时给前端用；将来 P2 联机时，Node 服务端 import 同一个文件，
   客户端和服务端跑的是同一份规则，不会出现"我这边涂上了、你那边没有"。

   三件事：
   1) 归属网格 + 计数，O(1) 求占比
   2) 障碍（水 / 建筑）掩码 + 圆形碰撞
   3) 围地填充：从地图四边"灌水"，灌不到又被你圈起来的地方就归你
   ============================================================ */

export function createTerritory({ world, grid, palette, solid: solidMask }) {
  const half = world / 2;
  const cell = world / grid;
  const total = grid * grid;

  const owner = new Uint8Array(total);        // 每格归属：0 空 / 1 / 2 ...
  const counts = new Uint32Array(8);          // 各方已占格数
  const solid = solidMask || new Uint8Array(total);   // 1 = 水 / 建筑，不可走不可涂

  let paintable = 0;
  for (let i = 0; i < total; i++) if (!solid[i]) paintable++;

  // 围地计算用的临时缓冲（只分配一次）
  const reach = new Uint8Array(total);        // 从地图外缘能灌到的格子
  const comp = new Uint8Array(total);         // 连通块标记
  const queue = new Int32Array(total);
  const fillMask = new Uint8Array(total);     // 本次被填充的格子（给渲染层用）

  function reset() {
    owner.fill(0);
    counts.fill(0);
    fillMask.fill(0);
  }
  reset();

  /** 世界坐标 -> 格子索引；出界返回 -1 */
  function indexAt(x, z) {
    const col = Math.floor((x + half) / cell);
    const row = Math.floor((half - z) / cell);
    if (col < 0 || col >= grid || row < 0 || row >= grid) return -1;
    return row * grid + col;
  }

  /**
   * 半径 r 的圆能否站在 (x,z)。
   * 用圆与格子矩形的精确相交判断，撞墙时能贴着墙滑行。
   */
  function canStand(x, z, r) {
    const c0 = Math.floor((x + half - r) / cell);
    const c1 = Math.floor((x + half + r) / cell);
    const r0 = Math.floor((half - z - r) / cell);
    const r1 = Math.floor((half - z + r) / cell);

    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        if (col < 0 || col >= grid || row < 0 || row >= grid) return false;
        if (!solid[row * grid + col]) continue;

        const x0 = col * cell - half;
        const x1 = x0 + cell;
        const z1 = half - row * cell;
        const z0 = z1 - cell;
        const px = Math.max(x0, Math.min(x, x1));
        const pz = Math.max(z0, Math.min(z, z1));
        const dx = x - px;
        const dz = z - pz;
        if (dx * dx + dz * dz < r * r) return false;
      }
    }
    return true;
  }

  /**
   * 以 (x,z) 为圆心、radius 为半径涂色，遇到障碍自动跳过。
   * 返回本次真正改归属的格子数（0 表示全在自己的地里，联机时不用发同步包）。
   */
  function paint(x, z, who, radius) {
    const r2 = radius * radius;
    const c0 = Math.max(0, Math.floor((x + half - radius) / cell));
    const c1 = Math.min(grid - 1, Math.ceil((x + half + radius) / cell));
    const r0 = Math.max(0, Math.floor((half - z - radius) / cell));
    const r1 = Math.min(grid - 1, Math.ceil((half - z + radius) / cell));
    let changed = 0;

    for (let row = r0; row <= r1; row++) {
      const wz = half - (row + 0.5) * cell;
      for (let col = c0; col <= c1; col++) {
        const i = row * grid + col;
        if (solid[i]) continue;

        const wx = (col + 0.5) * cell - half;
        const dx = wx - x;
        const dz = wz - z;
        if (dx * dx + dz * dz > r2) continue;

        const prev = owner[i];
        if (prev === who) continue;

        owner[i] = who;
        counts[prev]--;
        counts[who]++;
        changed++;
      }
    }
    return changed;
  }

  /** 某方占"可涂面积"的百分比 */
  function percentOf(who) {
    return paintable ? (counts[who] / paintable) * 100 : 0;
  }

  /**
   * 围地填充。
   * 做法：从地图四边向内"灌水"，水能流到的地方就是没被围住的；
   * 灌不到、又不属于 who 的连通块，就是被 who 的涂色圈起来的内部。
   *
   * 注意：障碍（水 / 建筑）对灌水是透明的 —— 否则只要贴着河岸划一道
   * 就能白拿半张地图，地形不能替代涂色来围地。
   *
   * @returns {number} 本次填充的格子数
   */
  function fillEnclosed(who, minArea = 100, maxRatio = 0.35) {
    const maxArea = paintable * maxRatio;
    fillMask.fill(0);
    reach.fill(0);
    comp.fill(0);

    let qt = 0;
    const push = (i) => { reach[i] = 1; queue[qt++] = i; };

    // 四边灌水
    for (let c = 0; c < grid; c++) {
      let i = c;
      if (!reach[i] && owner[i] !== who) push(i);
      i = (grid - 1) * grid + c;
      if (!reach[i] && owner[i] !== who) push(i);
    }
    for (let r = 0; r < grid; r++) {
      let i = r * grid;
      if (!reach[i] && owner[i] !== who) push(i);
      i = r * grid + grid - 1;
      if (!reach[i] && owner[i] !== who) push(i);
    }

    let qh = 0;
    while (qh < qt) {
      const i = queue[qh++];
      const r = (i / grid) | 0;
      const c = i - r * grid;
      if (c > 0) { const j = i - 1; if (!reach[j] && owner[j] !== who) push(j); }
      if (c < grid - 1) { const j = i + 1; if (!reach[j] && owner[j] !== who) push(j); }
      if (r > 0) { const j = i - grid; if (!reach[j] && owner[j] !== who) push(j); }
      if (r < grid - 1) { const j = i + grid; if (!reach[j] && owner[j] !== who) push(j); }
    }

    // 剩下的就是被圈住的区域，逐个连通块判断
    let filled = 0;
    for (let i = 0; i < total; i++) {
      if (reach[i] || comp[i] || owner[i] === who) continue;

      let h = 0, t = 0;
      queue[t++] = i;
      comp[i] = 1;
      let touches = false;

      const visit = (j) => {
        if (owner[j] === who) { touches = true; return; }
        if (comp[j]) return;
        comp[j] = 1;
        queue[t++] = j;
      };

      while (h < t) {
        const c0 = queue[h++];
        const r = (c0 / grid) | 0;
        const c = c0 - r * grid;
        if (c > 0) visit(c0 - 1);
        if (c < grid - 1) visit(c0 + 1);
        if (r > 0) visit(c0 - grid);
        if (r < grid - 1) visit(c0 + grid);
      }

      // 必须是自己涂出来的圈（贴着自己的颜色），面积够大，才认。
      // 上限是平衡保护：沿地图边缘跑一圈就能把整张图圈进去直接通杀，
      // 这种"跑边线"的退化打法收益太大，超过 35% 的区域不算数。
      if (!touches || t < minArea || t > maxArea) continue;

      for (let k = 0; k < t; k++) {
        const m = queue[k];
        if (solid[m]) continue;                 // 水里和楼里不涂
        const prev = owner[m];
        owner[m] = who;
        counts[prev]--;
        counts[who]++;
        fillMask[m] = 1;
        filled++;
      }
    }
    return filled;
  }

  return {
    world, grid, cell, half, total, paintable, solid,
    owner, counts, fillMask,
    paint, percentOf, indexAt, canStand, fillEnclosed, reset,
  };
}
