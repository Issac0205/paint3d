/* ============================================================
   textures.js —— 所有贴图在运行时用 Canvas 画出来
   ------------------------------------------------------------
   为什么不用 png 文件：
   1) 项目要能离线双击就跑，多一个图片就多一个 404 风险
   2) 程序化生成可以按需调色、按世界尺寸平铺，不用维护图集

   所有平铺贴图都做了"跨边界补画"处理：一个草叶画在右边缘，
   就在左边缘再画一份，这样 repeat 之后接缝看不出来。
   ============================================================ */

import * as THREE from 'three';

let ANISO = 4;
export function setAnisotropy(n) { ANISO = n; }

/* ---------------- 基础工具 ---------------- */

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

function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function finish(canvas, opts = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = opts.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = opts.clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  t.anisotropy = ANISO;
  t.needsUpdate = true;
  return t;
}

/* 元素跨边界时在对侧补画，保证平铺无缝 */
function eachWrap(size, x, y, pad, fn) {
  const xs = x < pad ? [x, x + size] : x > size - pad ? [x, x - size] : [x];
  const ys = y < pad ? [y, y + size] : y > size - pad ? [y, y - size] : [y];
  for (const px of xs) for (const py of ys) fn(px, py);
}

/* 可平铺的值噪声：网格点随机值 + 双三次平滑插值，坐标取模实现环绕 */
function noise2(cells, seed) {
  const r = mulberry32(seed);
  const g = new Float32Array(cells * cells);
  for (let i = 0; i < g.length; i++) g[i] = r();

  const m = v => ((v % cells) + cells) % cells;

  return (u, v) => {
    const fx = u * cells, fy = v * cells;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);

    const a = g[m(y0) * cells + m(x0)];
    const b = g[m(y0) * cells + m(x0 + 1)];
    const c = g[m(y0 + 1) * cells + m(x0)];
    const d = g[m(y0 + 1) * cells + m(x0 + 1)];

    const top = a + (b - a) * sx;
    const bot = c + (d - c) * sx;
    return top + (bot - top) * sy;
  };
}

function fbm(seed, octaves = 4, base = 4) {
  const layers = [];
  let sum = 0;
  for (let i = 0; i < octaves; i++) {
    const w = 1 / (1 << i);
    layers.push({ n: noise2(base << i, seed + i * 977), w });
    sum += w;
  }
  return (u, v) => {
    let acc = 0;
    for (const l of layers) acc += l.n(u, v) * l.w;
    return acc / sum;
  };
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/* ============================================================
   草地：暗绿底 + 大块斑驳 + 细小草叶
   ============================================================ */
export function grassTexture(size = 512) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;

  const big = fbm(1337, 3, 3);     // 大块明暗
  const fine = fbm(90210, 3, 16);  // 细颗粒

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const t = clamp01((big(u, v) - 0.34) * 1.7);
      const f = (fine(u, v) - 0.5) * 16;

      const i = (y * size + x) * 4;
      d[i] = 46 + t * 50 + f;
      d[i + 1] = 70 + t * 64 + f;
      d[i + 2] = 46 + t * 34 + f * 0.6;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // 草叶：短斜线，深浅各一半
  const r = mulberry32(5150);
  ctx.lineCap = 'round';
  for (let i = 0; i < 2600; i++) {
    const x = r() * size, y = r() * size;
    const len = 2 + r() * 5;
    const ang = -Math.PI / 2 + (r() - 0.5) * 1.2;
    const light = r() > 0.48;
    ctx.strokeStyle = light ? 'rgba(146,186,108,.26)' : 'rgba(20,38,24,.30)';
    ctx.lineWidth = r() > 0.8 ? 1.6 : 1;
    eachWrap(size, x, y, len + 2, (px, py) => {
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + Math.cos(ang) * len, py + Math.sin(ang) * len);
      ctx.stroke();
    });
  }

  return finish(c);
}

/* ============================================================
   铺装：石板路 / 广场，带勾缝和单块色差
   ============================================================ */
export function plazaTexture(size = 512, tint = 1) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const r = mulberry32(4242);

  ctx.fillStyle = '#2e343c';
  ctx.fillRect(0, 0, size, size);

  const N = 8;
  const s = size / N;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const v = (0.82 + r() * 0.28) * tint;
      const g = Math.round(92 * v);
      ctx.fillStyle = `rgb(${g},${Math.round(g * 1.04)},${Math.round(g * 1.12)})`;
      ctx.fillRect(i * s + 1.5, j * s + 1.5, s - 3, s - 3);
    }
  }

  // 颗粒感
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * 14;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);

  return finish(c);
}

/* ============================================================
   木栈道：横向板材 + 木纹
   ============================================================ */
export function woodTexture(size = 256) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const r = mulberry32(777);

  ctx.fillStyle = '#3a2b1e';
  ctx.fillRect(0, 0, size, size);

  const rows = 8;
  const h = size / rows;

  for (let j = 0; j < rows; j++) {
    const v = 0.82 + r() * 0.36;
    const cr = Math.round(120 * v), cg = Math.round(88 * v), cb = Math.round(58 * v);
    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
    ctx.fillRect(0, j * h + 1, size, h - 2);

    // 木纹
    ctx.strokeStyle = 'rgba(40,26,16,.30)';
    ctx.lineWidth = 1;
    const lines = 3 + Math.floor(r() * 3);
    for (let k = 0; k < lines; k++) {
      const y0 = j * h + 3 + r() * (h - 6);
      ctx.beginPath();
      ctx.moveTo(0, y0);
      let cy = y0;
      for (let x = 0; x <= size; x += 16) {
        cy += (r() - 0.5) * 1.6;
        ctx.lineTo(x, cy);
      }
      ctx.stroke();
    }

    // 板缝阴影
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.fillRect(0, j * h, size, 1.5);
  }

  return finish(c);
}

/* ============================================================
   石材：桥墩、台阶
   ============================================================ */
export function stoneTexture(size = 256) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const n = fbm(31337, 4, 6);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = 0.55 + n(x / size, y / size) * 0.5;
      const g = Math.round(132 * v);
      const i = (y * size + x) * 4;
      d[i] = g; d[i + 1] = Math.round(g * 0.98); d[i + 2] = Math.round(g * 0.94);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // 砌缝
  const r = mulberry32(8);
  ctx.strokeStyle = 'rgba(40,38,34,.42)';
  ctx.lineWidth = 2;
  for (let j = 0; j < 4; j++) {
    const y = (j + 0.5) * (size / 4);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(size, y); ctx.stroke();
    const off = j % 2 ? size / 4 : 0;
    for (let k = 0; k < 2; k++) {
      const x = off + k * (size / 2);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + size / 4); ctx.stroke();
    }
  }
  // 零星裂纹
  for (let i = 0; i < 14; i++) {
    let x = r() * size, y = r() * size;
    ctx.strokeStyle = 'rgba(30,28,26,.28)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let k = 0; k < 4; k++) {
      x += (r() - 0.5) * 22; y += (r() - 0.5) * 22;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  return finish(c);
}

/* ============================================================
   建筑立面：一格 = 一扇窗 + 一条楼层分隔带
   ============================================================ */
export function facadeTexture(size = 256, wall = [96, 106, 122]) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const n = fbm(6161, 3, 8);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = 0.88 + n(x / size, y / size) * 0.24;
      const i = (y * size + x) * 4;
      d[i] = wall[0] * v; d[i + 1] = wall[1] * v; d[i + 2] = wall[2] * v;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // 楼层分隔带（贴图底部），重复之后就是每层一道
  ctx.fillStyle = 'rgba(0,0,0,.22)';
  ctx.fillRect(0, size * 0.88, size, size * 0.12);
  ctx.fillStyle = 'rgba(255,255,255,.10)';
  ctx.fillRect(0, size * 0.88, size, 2);

  // 窗洞
  const x0 = size * 0.19, y0 = size * 0.16;
  const w = size * 0.62, h = size * 0.54;

  // 外框
  ctx.fillStyle = '#c3ccd8';
  ctx.fillRect(x0 - 4, y0 - 4, w + 8, h + 8);

  // 玻璃：上浅下深的反射渐变
  const g = ctx.createLinearGradient(x0, y0, x0 + w * 0.6, y0 + h);
  g.addColorStop(0, '#5d86a8');
  g.addColorStop(0.42, '#2c4a63');
  g.addColorStop(1, '#121e2a');
  ctx.fillStyle = g;
  ctx.fillRect(x0, y0, w, h);

  // 斜向高光
  ctx.save();
  ctx.beginPath(); ctx.rect(x0, y0, w, h); ctx.clip();
  ctx.fillStyle = 'rgba(255,255,255,.16)';
  ctx.beginPath();
  ctx.moveTo(x0 + w * 0.1, y0 + h);
  ctx.lineTo(x0 + w * 0.42, y0);
  ctx.lineTo(x0 + w * 0.62, y0);
  ctx.lineTo(x0 + w * 0.3, y0 + h);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // 竖梃
  ctx.fillStyle = 'rgba(200,212,226,.55)';
  ctx.fillRect(x0 + w / 2 - 1.5, y0, 3, h);

  // 窗台
  ctx.fillStyle = 'rgba(255,255,255,.22)';
  ctx.fillRect(x0 - 6, y0 + h + 4, w + 12, 4);
  ctx.fillStyle = 'rgba(0,0,0,.25)';
  ctx.fillRect(x0 - 6, y0 + h + 8, w + 12, 3);

  return finish(c);
}

/* ============================================================
   屋顶：防水卷材 + 接缝
   ============================================================ */
export function roofTexture(size = 256) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const n = fbm(2020, 3, 5);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = 0.8 + n(x / size, y / size) * 0.4;
      const g = Math.round(112 * v);
      const i = (y * size + x) * 4;
      d[i] = g; d[i + 1] = Math.round(g * 1.02); d[i + 2] = Math.round(g * 1.06);
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // 卷材接缝
  ctx.fillStyle = 'rgba(0,0,0,.20)';
  for (let i = 1; i < 4; i++) {
    ctx.fillRect(0, (i * size) / 4, size, 2);
    ctx.fillRect((i * size) / 4, 0, 2, size);
  }

  return finish(c);
}

/* ============================================================
   水面法线：整数频率正弦叠加 → 天然可平铺
   ============================================================ */
export function waterNormalTexture(size = 256) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;

  const waves = [
    { fx: 2, fy: 1, a: 0.55, p: 0.0 },
    { fx: -1, fy: 3, a: 0.38, p: 1.7 },
    { fx: 4, fy: -2, a: 0.24, p: 3.1 },
    { fx: 6, fy: 5, a: 0.13, p: 5.2 },
    { fx: 9, fy: -7, a: 0.07, p: 2.4 },
  ];

  const H = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let h = 0;
      for (const w of waves) {
        h += Math.sin((u * w.fx + v * w.fy) * Math.PI * 2 + w.p) * w.a;
      }
      H[y * size + x] = h;
    }
  }

  const at = (x, y) => H[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  const STRENGTH = 6;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * STRENGTH;
      const dy = (at(x, y + 1) - at(x, y - 1)) * STRENGTH;

      // n = normalize(-dx, -dy, 1)
      const len = Math.hypot(dx, dy, 1);
      const nx = -dx / len, ny = -dy / len, nz = 1 / len;

      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  return finish(c, { linear: true });
}

/* ============================================================
   涂色笔触：软边圆，中心实、边缘淡
   ============================================================ */
export function splatTexture(size = 128) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const h = size / 2;

  const g = ctx.createRadialGradient(h, h, 0, h, h, h);
  g.addColorStop(0.00, 'rgba(255,255,255,1)');
  g.addColorStop(0.84, 'rgba(255,255,255,1)');
  g.addColorStop(0.93, 'rgba(255,255,255,.70)');
  g.addColorStop(1.00, 'rgba(255,255,255,0)');

  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return finish(c, { clamp: true });
}

/* ============================================================
   角色脚下的软阴影贴片
   ============================================================ */
export function blobShadowTexture(size = 128) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const h = size / 2;

  const g = ctx.createRadialGradient(h, h, 0, h, h, h);
  g.addColorStop(0, 'rgba(0,0,0,.55)');
  g.addColorStop(0.55, 'rgba(0,0,0,.30)');
  g.addColorStop(1, 'rgba(0,0,0,0)');

  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return finish(c, { clamp: true });
}

/* ============================================================
   灯光辉光（加色混合用）
   ============================================================ */
export function glowTexture(size = 128) {
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  const h = size / 2;

  const g = ctx.createRadialGradient(h, h, 0, h, h, h);
  g.addColorStop(0, 'rgba(255,240,200,1)');
  g.addColorStop(0.22, 'rgba(255,226,160,.55)');
  g.addColorStop(0.55, 'rgba(255,200,120,.12)');
  g.addColorStop(1, 'rgba(255,190,100,0)');

  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return finish(c, { clamp: true });
}
