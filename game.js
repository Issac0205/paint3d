import * as THREE from 'three';
import { createTerritory } from './territory.js';
import { MAP, buildSolid, makeTrees, makeLamps } from './map.js';
import { buildWorld } from './world.js';
import { splatTexture, blobShadowTexture } from './textures.js';
import { createNet } from './net.js';

/* ============================================================
   涂地大作战 · P0 单机原型
   ------------------------------------------------------------
   1) territory.js 负责规则：归属网格、障碍、占比、围地填充
   2) map.js 负责地形数据：河道、桥、建筑、树
   3) world.js 负责把这些数据变成有贴图有阴影的场景
   4) 本文件负责角色、输入、循环和 HUD
   ============================================================ */

const WORLD = MAP.world;
const GRID = 256;          // 逻辑网格分辨率（只算分，不渲染）
const DURATION = 90;       // 单局秒数
const BRUSH = 1.9;         // 笔刷半径（世界单位）
const SPEED = 9;           // 玩家速度
const BOT_SPEED = 6.5;     // 练习对手速度，略慢
const STAMP_STEP = 0.28;   // 每走多远盖一个圆片
const BODY_R = 0.5;        // 角色碰撞半径
const SPLAT_MAX = 24000;   // 全场圆片上限（增量上传，开大也不贵）
const FILL_INTERVAL = 0.2; // 多久检查一次"有没有围出封闭区域"

const HEX = [0x1b212c, 0x2dd4bf, 0xfb7185];
const PALETTE = [[27, 33, 44], [45, 212, 191], [251, 113, 133]];

const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

/* 树和路灯要先算出来：树干是实心障碍，必须进掩码 */
const trees = makeTrees(MAP);
const lamps = makeLamps(MAP);
const solid = buildSolid(MAP, WORLD, GRID, trees);
const territory = createTerritory({ world: WORLD, grid: GRID, palette: PALETTE, solid });

/* ---------------- 渲染基础 ---------------- */
const app = document.getElementById('app');

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, isTouch ? 1.75 : 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.16;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);      // 尺寸交给 fitCamera() 统一处理

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1b2531);
scene.fog = new THREE.Fog(0x1b2531, 58, 152);

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
camera.position.set(0, 26, 18);

/* 半球光补环境色：天光偏冷、地面反射偏暖，物体暗部不会死黑 */
scene.add(new THREE.HemisphereLight(0xa9c9ef, 0x3a4430, 1.35));

const sun = new THREE.DirectionalLight(0xffe8c6, 2.7);
sun.position.set(-26, 44, 22);
sun.castShadow = true;
sun.shadow.mapSize.set(isTouch ? 1024 : 2048, isTouch ? 1024 : 2048);
sun.shadow.camera.left = -38;
sun.shadow.camera.right = 38;
sun.shadow.camera.top = 38;
sun.shadow.camera.bottom = -38;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 140;
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.02;
scene.add(sun);

/* ---------------- 场景 ---------------- */
const world = buildWorld(scene, renderer, trees, lamps);

/* ---------------- 涂色贴片层 ---------------- */
/* 两个玩家共用同一层，实例索引顺序 = 涂抹时间顺序，
   所以"后涂的盖住先涂的"天然成立。
   贴图是软边圆：中心实、边缘淡，笔迹叠起来像真的颜料。 */
const SPLAT_TEX = splatTexture();
const BLOB_TEX = blobShadowTexture();

class SplatLayer {
  constructor(max) {
    const geo = new THREE.PlaneGeometry(2, 2);   // 半径 1，scale 就是笔刷半径
    geo.rotateX(-Math.PI / 2);

    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,                 // 真实颜色来自逐实例 instanceColor
      map: SPLAT_TEX,
      transparent: true,
      depthWrite: false,
      toneMapped: false,               // 不参与色调映射，颜料保持鲜艳
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);

    this.max = max;
    this.used = 0;
    this.dirty = false;
    this.rangeStart = -1;
    this.dummy = new THREE.Object3D();
  }

  add(x, z, r, color) {
    if (this.used >= this.max) return;
    if (this.rangeStart < 0) this.rangeStart = this.used;

    const jr = r * (0.96 + Math.random() * 0.08);   // 半径抖一点，边缘才不像圆规画的
    this.dummy.position.set(x, 0.018, z);
    this.dummy.rotation.set(0, Math.random() * Math.PI, 0);
    this.dummy.scale.set(jr, 1, jr);
    this.dummy.updateMatrix();
    this.mesh.setMatrixAt(this.used, this.dummy.matrix);
    this.mesh.setColorAt(this.used, color);

    this.used++;
    this.mesh.count = this.used;
    this.dirty = true;
  }

  flush() {
    if (!this.dirty) return;
    const start = this.rangeStart < 0 ? 0 : this.rangeStart;
    const count = this.used - start;

    if (count > 0) {
      // 只上传新增的那一段，而不是整块 24000 个实例。
      // 注意：这里不能 clearUpdateRanges() —— 真正上传后 three 会自己清空，
      // 如果这里先清，同一帧内的第二次 flush 会把上一次还没上传的区间抹掉，
      // 表现为"涂了一大片却只画出来最后两笔"。
      const m = this.mesh.instanceMatrix;
      m.addUpdateRange(start * 16, count * 16);
      m.needsUpdate = true;

      const c = this.mesh.instanceColor;
      if (c) {
        c.addUpdateRange(start * 3, count * 3);
        c.needsUpdate = true;
      }
    }
    this.rangeStart = -1;
    this.dirty = false;
  }

  clear() {
    this.used = 0;
    this.mesh.count = 0;
    this.rangeStart = -1;
    this.dirty = false;
  }
}

const paintLayer = new SplatLayer(SPLAT_MAX);

/* 笔刷靠墙 / 靠水时收窄，避免涂色浮在水面上 */
function safeRadius(x, z, maxR) {
  for (let r = maxR; r > 0.45; r -= 0.3) {
    if (territory.canStand(x, z, r)) return r;
  }
  return 0.45;
}

/* 把 fillEnclosed 圈出来的内部整片补上圆片（贪心覆盖，几十个就够） */
const coverScratch = new Uint8Array(GRID * GRID);
function stampFilledRegion(color) {
  const mask = territory.fillMask;
  coverScratch.fill(0);

  const cell = territory.cell;
  const half = territory.half;

  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const i = row * GRID + col;
      if (!mask[i] || coverScratch[i]) continue;

      const wx = (col + 0.5) * cell - half;
      const wz = half - (row + 0.5) * cell;
      const r = safeRadius(wx, wz, BRUSH);
      addStamp(wx, wz, r, color);

      const rc = r / cell;
      const r2c = rc * rc;
      const r0 = Math.max(0, Math.floor(row - rc));
      const r1 = Math.min(GRID - 1, Math.ceil(row + rc));
      const c0 = Math.max(0, Math.floor(col - rc));
      const c1 = Math.min(GRID - 1, Math.ceil(col + rc));
      for (let rr = r0; rr <= r1; rr++) {
        const dz = rr - row;
        for (let cc = c0; cc <= c1; cc++) {
          const dx = cc - col;
          if (dx * dx + dz * dz <= r2c) coverScratch[rr * GRID + cc] = 1;
        }
      }
    }
  }
}

/* ---------------- 角色 ---------------- */
function makeAvatar(hex) {
  const g = new THREE.Group();
  const base = new THREE.Color(hex);
  const bodyCol = base.clone().offsetHSL(0, -0.12, 0.2);
  const capCol = base.clone().offsetHSL(0, 0.04, -0.2);

  const mat = (c, rough = 0.45) =>
    new THREE.MeshStandardMaterial({ color: c, roughness: rough, metalness: 0.06 });

  const torso = new THREE.Group();
  g.add(torso);

  // 身体：胶囊，略带锥度感
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.5, 0.74, 8, 20), mat(bodyCol));
  body.position.y = 1.0;
  body.castShadow = true;
  torso.add(body);

  // 头
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.43, 22, 16), mat(bodyCol));
  head.position.y = 1.83;
  head.castShadow = true;
  torso.add(head);

  // 眼睛：白眼球 + 深色瞳孔
  const eyeWhite = mat(0xffffff, 0.28);
  const pupilMat = mat(0x14202a, 0.18);
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.132, 14, 12), eyeWhite);
    eye.position.set(s * 0.165, 1.84, 0.40);
    torso.add(eye);

    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), pupilMat);
    pupil.position.set(s * 0.165, 1.84, 0.485);
    torso.add(pupil);
  }

  // 帽子：半球帽顶 + 帽檐，认人主要靠这个
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(0.45, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.44),
    mat(capCol)
  );
  cap.position.y = 1.9;
  torso.add(cap);

  // 手臂：挂在肩关节上，靠旋转做摆臂
  const armGeo = new THREE.CapsuleGeometry(0.112, 0.32, 6, 12);
  const arms = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.54, 1.28, 0);
    pivot.rotation.z = s * 0.2;

    const arm = new THREE.Mesh(armGeo, mat(bodyCol));
    arm.position.y = -0.24;
    arm.castShadow = true;
    pivot.add(arm);

    torso.add(pivot);
    arms.push(pivot);
  }

  // 脚下软阴影：比真实的投影更稳定，也顺便把角色"贴"在地上
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(2.1, 2.1),
    new THREE.MeshBasicMaterial({
      map: BLOB_TEX,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.032;
  shadow.renderOrder = 2;
  g.add(shadow);

  g.userData = { torso, head, arms, shadow };
  return g;
}

class Actor {
  constructor(who, hex, x, z, speed) {
    this.who = who;
    this.speed = speed;
    this.pos = new THREE.Vector3(x, 0, z);
    this.face = 0;
    this.moving = false;
    this.animT = Math.random() * 10;
    this.mesh = makeAvatar(hex);
    this.parts = this.mesh.userData;
    scene.add(this.mesh);
    this.color = new THREE.Color(hex);
    this.lastStamp = new THREE.Vector3(x, 0, z);
    this.paintedSinceCheck = false;
  }

  /** 逻辑上记一笔 + 视觉上盖一片，两边用同一个半径 */
  stampAt(x, z) {
    territory.paint(x, z, this.who, BRUSH);
    addStamp(x, z, safeRadius(x, z, BRUSH), this.color);
    this.lastStamp.set(x, 0, z);
    this.paintedSinceCheck = true;
  }

  trail() {
    if (this.pos.distanceTo(this.lastStamp) >= STAMP_STEP) {
      this.stampAt(this.pos.x, this.pos.z);
    }
  }

  /** 分轴推进：撞墙时能沿着墙滑，而不是卡死 */
  step(nx, nz, dt) {
    const d = this.speed * dt;

    const tx = this.pos.x + nx * d;
    if (territory.canStand(tx, this.pos.z, BODY_R)) this.pos.x = tx;

    const tz = this.pos.z + nz * d;
    if (territory.canStand(this.pos.x, tz, BODY_R)) this.pos.z = tz;

    if (nx || nz) this.face = Math.atan2(nx, nz);
  }

  sync(dt) {
    this.mesh.position.set(this.pos.x, 0, this.pos.z);

    let d = this.face - this.mesh.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.mesh.rotation.y += d * 0.25;

    // 走路：摆臂 + 上下颠，幅度都不大，俯视角下够用
    this.animT += dt * (this.moving ? 1 : 0.22);
    const swing = Math.sin(this.animT * 9);
    const amp = this.moving ? 0.62 : 0.07;

    this.parts.arms[0].rotation.x = swing * amp;
    this.parts.arms[1].rotation.x = -swing * amp;
    this.parts.torso.position.y = this.moving ? Math.abs(swing) * 0.075 : 0;
    this.parts.torso.rotation.x = this.moving ? -0.06 : 0;

    this.moving = false;
  }
}

class Player extends Actor {
  move(dx, dz, dt) {
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return;
    this.step(dx / len, dz / len, dt);
    this.moving = true;
  }
}

/* 练习对手：沿预设路线巡逻，路线串起了三座桥，保证它会过河 */
class Bot extends Actor {
  constructor(who, hex, x, z, speed) {
    super(who, hex, x, z, speed);
    this.isBot = true;
    this.wp = 1;
    this.stuck = 0;
    this.lastPos = this.pos.clone();
    this.target = new THREE.Vector3();
    this.pickTarget();
  }

  pickTarget() {
    const wp = MAP.botPath[this.wp];
    this.target.set(
      wp[0] + (Math.random() * 2 - 1) * 0.8,
      0,
      wp[1] + (Math.random() * 2 - 1) * 0.8
    );
  }

  update(dt) {
    const dx = this.target.x - this.pos.x;
    const dz = this.target.z - this.pos.z;
    const dist = Math.hypot(dx, dz);

    if (dist < 1.5) {
      this.wp = (this.wp + 1) % MAP.botPath.length;
      this.pickTarget();
      return;
    }

    this.step(dx / dist, dz / dist, dt);
    this.moving = true;

    // 卡住了就换下一个航点
    if (this.pos.distanceToSquared(this.lastPos) < 0.0006) {
      this.stuck += dt;
      if (this.stuck > 1.0) {
        this.wp = (this.wp + 1) % MAP.botPath.length;
        this.pickTarget();
        this.stuck = 0;
      }
    } else {
      this.stuck = 0;
    }
    this.lastPos.copy(this.pos);
  }
}

/* 联机对手：位置由网络包驱动，本地只做插值，不自己算移动 */
class Remote extends Actor {
  constructor(who, hex, x, z) {
    super(who, hex, x, z, 0);
    this.isRemote = true;
    this.target = new THREE.Vector3(x, 0, z);
    this.faceTarget = 0;
  }

  /** 直接吸到位（重开一局时用） */
  snap(x, z, f) {
    this.pos.set(x, 0, z);
    this.target.set(x, 0, z);
    this.face = f;
    this.faceTarget = f;
  }

  /** 收到对端坐标 */
  setState(x, z, f) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    this.target.set(x, 0, z);
    if (Number.isFinite(f)) this.faceTarget = f;
  }

  update(dt) {
    const dx = this.target.x - this.pos.x;
    const dz = this.target.z - this.pos.z;
    this.moving = Math.abs(dx) + Math.abs(dz) > 0.004;
    const k = 1 - Math.pow(1e-7, dt);
    this.pos.x += dx * k;
    this.pos.z += dz * k;
    this.face = this.faceTarget;
  }

  /** 远程玩家的涂色来自网络包，本地不自己盖章 */
  trail() {}
}

/* ---------------- 输入 ---------------- */
const keys = new Set();
addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  keys.add(k);
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
});
addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

const stickEl = document.getElementById('stick');
const knobEl = document.getElementById('knob');
const stick = { x: 0, y: 0, active: false, id: null };
const STICK_R = 40;

if (isTouch) {
  stickEl.classList.add('on');
  stickEl.style.left = '26px';
  stickEl.style.bottom = '26px';
  document.getElementById('hint').textContent = '拖动左下摇杆移动 · 涂出一圈封闭区域可占满内部 · 过河只能走桥';
}

function stickStart(e) {
  stick.active = true;
  stick.id = e.pointerId;
  stickEl.setPointerCapture(e.pointerId);
  stickMove(e);
}
function stickMove(e) {
  if (!stick.active || e.pointerId !== stick.id) return;
  const r = stickEl.getBoundingClientRect();
  let dx = e.clientX - (r.left + r.width / 2);
  let dy = e.clientY - (r.top + r.height / 2);
  const len = Math.hypot(dx, dy);
  if (len > STICK_R) { dx = dx / len * STICK_R; dy = dy / len * STICK_R; }
  knobEl.style.transform = `translate(${dx}px, ${dy}px)`;
  stick.x = dx / STICK_R;
  stick.y = dy / STICK_R;
}
function stickEnd(e) {
  if (e.pointerId !== stick.id) return;
  stick.active = false;
  stick.x = stick.y = 0;
  stick.id = null;
  knobEl.style.transform = 'translate(0,0)';
}
stickEl.addEventListener('pointerdown', stickStart);
stickEl.addEventListener('pointermove', stickMove);
stickEl.addEventListener('pointerup', stickEnd);
stickEl.addEventListener('pointercancel', stickEnd);

function inputVector() {
  let x = 0, z = 0;
  if (keys.has('w') || keys.has('arrowup')) z -= 1;
  if (keys.has('s') || keys.has('arrowdown')) z += 1;
  if (keys.has('a') || keys.has('arrowleft')) x -= 1;
  if (keys.has('d') || keys.has('arrowright')) x += 1;
  if (x || z) return { x, z };
  if (stick.active) return { x: stick.x, z: stick.y };
  return { x: 0, z: 0 };
}

/* ---------------- 局面 ---------------- */

const SIDE_CSS = { 1: '#2dd4bf', 2: '#fb7185' };

let mode = 'solo';        // 'solo' | 'online'
let side = 1;             // 1 = 青色，2 = 粉色
let running = false;      // 倒数结束后才为 true
let timeLeft = DURATION;
let hudTimer = 0;
let fillTimer = 0;
let netTimer = 0;
let cdTimer = 0;
let cdEndAt = 0;          // 倒数结束的墙钟时刻
let cdShown = -1;
let goTimer = 0;

const outbox = [];        // 待发给对端的笔迹
let net = null;

let me = new Player(1, HEX[1], MAP.spawn.me[0], MAP.spawn.me[1], SPEED);
let opp = new Bot(2, HEX[2], MAP.spawn.bot[0], MAP.spawn.bot[1], BOT_SPEED);

/* 涂一笔：本地画，联机时顺手排队发给对端 */
function addStamp(x, z, r, color) {
  paintLayer.add(x, z, r, color);
  if (mode === 'online' && running) {
    outbox.push([+x.toFixed(2), +z.toFixed(2), +r.toFixed(2)]);
  }
}

const el = {
  clock: document.getElementById('clock'),
  p1pct: document.getElementById('p1pct'),
  p2pct: document.getElementById('p2pct'),
  p1bar: document.getElementById('p1bar'),
  p2bar: document.getElementById('p2bar'),
  p1name: document.getElementById('p1name'),
  p2name: document.getElementById('p2name'),
  over: document.getElementById('over'),
  result: document.getElementById('result'),
  finalScore: document.getElementById('finalScore'),
  overNote: document.getElementById('overNote'),
  toast: document.getElementById('toast'),
  flash: document.getElementById('flash'),
  cd: document.getElementById('countdown'),
  cdText: document.getElementById('cdText'),
};

let toastTimer = 0;

function toast(text) {
  el.toast.textContent = text;
  el.toast.classList.remove('on');
  void el.toast.offsetWidth;      // 强制重排，让动画能重播
  el.toast.classList.add('on');
  toastTimer = 1.6;
}

function flash() {
  el.flash.classList.remove('on');
  void el.flash.offsetWidth;
  el.flash.classList.add('on');
}

function showCd(text) {
  el.cdText.textContent = text;
  el.cdText.classList.remove('pop');
  void el.cdText.offsetWidth;
  el.cdText.classList.add('pop');
}

function updateHUD() {
  const a = territory.percentOf(1);
  const b = territory.percentOf(2);
  el.p1pct.textContent = a.toFixed(1) + '%';
  el.p2pct.textContent = b.toFixed(1) + '%';
  el.p1bar.style.width = a + '%';
  el.p2bar.style.width = b + '%';

  const left = Math.max(0, Math.ceil(timeLeft));
  el.clock.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

function updateNames() {
  const other = mode === 'solo' ? '练习对手' : '对手';
  el.p1name.textContent = side === 1 ? '你' : other;
  el.p2name.textContent = side === 2 ? '你' : other;
}

function endGame() {
  running = false;
  cdTimer = 0;
  el.cd.classList.remove('on');

  const a = territory.percentOf(1);
  const b = territory.percentOf(2);
  const mine = side === 1 ? a : b;
  const theirs = side === 1 ? b : a;

  el.result.textContent = mine > theirs ? '你赢了' : mine < theirs ? '你输了' : '平局';
  el.finalScore.innerHTML =
    `你 <b style="color:${SIDE_CSS[side]}">${mine.toFixed(1)}%</b> &nbsp;·&nbsp; ` +
    `对手 <b style="color:${SIDE_CSS[3 - side]}">${theirs.toFixed(1)}%</b>`;
  el.overNote.textContent = mode === 'online' ? '点"再来一局"会同时为双方重开' : '';
  el.over.classList.add('on');
}

/* 只检查本地玩家有没有围出封闭区域；对手的由他自己的客户端判定，
   判定产生的笔迹会通过网络发过来，所以两边不会打架 */
function checkEnclosure() {
  if (!me.paintedSinceCheck) return;
  me.paintedSinceCheck = false;

  const n = territory.fillEnclosed(me.who);
  if (n > 0) {
    stampFilledRegion(me.color);
    toast(`围地成功 +${((n / territory.paintable) * 100).toFixed(1)}%`);
    flash();
  }
}

function spawnOf(s) {
  return s === 1 ? MAP.spawn.me : MAP.spawn.bot;
}

function rebuildActors() {
  if (me) scene.remove(me.mesh);
  if (opp) scene.remove(opp.mesh);

  const a = spawnOf(side);
  const b = spawnOf(3 - side);

  me = new Player(side, HEX[side], a[0], a[1], SPEED);
  opp = mode === 'solo'
    ? new Bot(3 - side, HEX[3 - side], b[0], b[1], BOT_SPEED)
    : new Remote(3 - side, HEX[3 - side], b[0], b[1]);

  camera.position.set(me.pos.x, CAM_H, me.pos.z + CAM_BACK);
  camTarget.set(me.pos.x, 0, me.pos.z);
}

function resetMatch() {
  territory.reset();
  paintLayer.clear();
  outbox.length = 0;

  const a = spawnOf(side);
  const b = spawnOf(3 - side);

  me.pos.set(a[0], 0, a[1]);
  me.face = 0;
  me.moving = false;
  me.sync(0);

  opp.pos.set(b[0], 0, b[1]);
  opp.face = 0;
  opp.moving = false;
  opp.sync(0);
  if (opp.isBot) { opp.wp = 1; opp.pickTarget(); opp.stuck = 0; }
  if (opp.isRemote) opp.snap(b[0], b[1], 0);

  timeLeft = DURATION;
  fillTimer = 0;
  hudTimer = 0;
  netTimer = 0;
  el.over.classList.remove('on');
  el.overNote.textContent = '';
  updateHUD();
}

function beginPlay() {
  running = true;
  me.stampAt(me.pos.x, me.pos.z);       // 开局先在脚下盖一笔
  if (opp.isBot) opp.stampAt(opp.pos.x, opp.pos.z);
  if (mode === 'online') {
    net.send({ t: 'p', x: +me.pos.x.toFixed(2), z: +me.pos.z.toFixed(2), f: +me.face.toFixed(2) });
  }
}

function countdown(seconds) {
  running = false;
  cdTimer = seconds;
  cdShown = seconds;
  cdEndAt = performance.now() + seconds * 1000;
  goTimer = 0;
  el.cd.classList.add('on');
  showCd(String(seconds));
}

/* ---------------- 联机 ---------------- */

function netPump(dt) {
  if (mode !== 'online' || !net) return;
  netTimer += dt;

  if (outbox.length && netTimer >= 0.06) {
    net.send({ t: 'ink', s: outbox.splice(0, 240) });
  }
  if (netTimer >= 0.08) {
    netTimer = 0;
    net.send({ t: 'p', x: +me.pos.x.toFixed(2), z: +me.pos.z.toFixed(2), f: +me.face.toFixed(2) });
  }
}

function ensureNet() {
  if (net) return net;
  net = createNet();

  net.on('room', m => {
    side = m.side;
    mode = 'online';
    if (m.side === 1) {
      showWaiting(m.code);
    } else {
      lobbyMsg('');
      L.waitText.textContent = '已进入房间，准备开始…';
    }
  });

  net.on('err', m => {
    lobbyMsg(m.msg || '出错了');
    const n = net;
    net = null;
    if (n) n.close();
    showMenu();
  });

  // 连接信令服务器的进度提示（重试时会更新文案），别让界面干等着
  net.on('status', m => {
    if (m && m.text) lobbyMsg(m.text, true);
    else lobbyMsg('');
  });

  net.on('start', m => {
    mode = 'online';
    rebuildActors();
    updateNames();
    resetMatch();
    // 局时以开局消息为准，否则会先显示 90 再跳成实际值
    if (m.dur) { timeLeft = m.dur; updateHUD(); }
    hideLobby();
    countdown(m.in || 3);
  });

  net.on('tick', m => {
    timeLeft = Math.max(0, m.left);
  });

  net.on('end', () => {
    if (running) endGame();
  });

  net.on('p', m => {
    if (opp && opp.isRemote) opp.setState(m.x, m.z, m.f);
  });

  net.on('ink', m => {
    if (!Array.isArray(m.s) || !opp) return;
    for (const s of m.s) {
      if (!Array.isArray(s) || s.length < 3) continue;
      territory.paint(s[0], s[1], opp.who, BRUSH);
      paintLayer.add(s[0], s[1], s[2], opp.color);
    }
  });

  net.on('peer', m => {
    if (m.state === 'left') {
      backToMenu('对手已离开，房间已关闭');
    } else if (m.state === 'joined' && side === 1) {
      L.waitText.textContent = '对手已加入，正在开始…';
    }
  });

  net.on('close', () => {
    if (mode === 'online') backToMenu('与服务器断开');
  });

  return net;
}

function backToMenu(msg) {
  mode = 'solo';
  side = 1;
  running = false;
  cdTimer = 0;
  goTimer = 0;
  el.cd.classList.remove('on');
  el.over.classList.remove('on');

  if (net) { const n = net; net = null; n.close(); }

  rebuildActors();
  updateNames();
  resetMatch();
  showMenu();
  lobbyMsg(msg || '');
}

/* ---------------- 大厅 ---------------- */

const L = {
  root: document.getElementById('lobby'),
  menu: document.getElementById('lobbyMenu'),
  codeBox: document.getElementById('codeBox'),
  codeVal: document.getElementById('codeVal'),
  waitText: document.getElementById('waitText'),
  msg: document.getElementById('lobbyMsg'),
  input: document.getElementById('codeInput'),
};

function lobbyMsg(text, ok) {
  L.msg.textContent = text || '';
  L.msg.classList.toggle('ok', !!ok);
}

function showMenu() {
  L.menu.style.display = '';
  L.codeBox.classList.remove('on');
  L.root.classList.remove('hide');
}

function showWaiting(code) {
  L.menu.style.display = 'none';
  L.codeBox.classList.add('on');
  L.codeVal.textContent = code;
  L.waitText.textContent = '等待对手输入房间号…';
  L.root.classList.remove('hide');
}

function hideLobby() {
  L.root.classList.add('hide');
}

function startSolo() {
  mode = 'solo';
  side = 1;
  rebuildActors();
  updateNames();
  resetMatch();
  hideLobby();
  countdown(3);
}

document.getElementById('btnSolo').addEventListener('click', startSolo);

document.getElementById('btnCreate').addEventListener('click', async () => {
  lobbyMsg('');
  try {
    ensureNet();
    await net.connect();
    net.send({ t: 'create' });
  } catch (e) {
    lobbyMsg(e.message || '连接失败');
    if (net) { const n = net; net = null; n.close(); }
  }
});

document.getElementById('btnJoin').addEventListener('click', async () => {
  const code = (L.input.value || '').trim().toUpperCase();
  if (code.length !== 4) { lobbyMsg('请输入 4 位房间号'); return; }

  lobbyMsg('');
  try {
    ensureNet();
    await net.connect();
    net.send({ t: 'join', code });
  } catch (e) {
    lobbyMsg(e.message || '连接失败');
    if (net) { const n = net; net = null; n.close(); }
  }
});

L.input.addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btnJoin').click();
});

// 房间号只有大写字母和数字，边打边规范，省得手机上还要按 Shift
L.input.addEventListener('input', () => {
  const v = L.input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (v !== L.input.value) L.input.value = v;
});

document.getElementById('btnCancel').addEventListener('click', () => {
  backToMenu('');
});

document.getElementById('again').addEventListener('click', () => {
  if (mode === 'online' && net) {
    el.over.classList.remove('on');
    net.send({ t: 'again' });
  } else {
    resetMatch();
    countdown(3);
  }
});

/* ---------------- 主循环 ---------------- */
const clock = new THREE.Clock();
const camTarget = new THREE.Vector3(me.pos.x, 0, me.pos.z);
const camGoal = new THREE.Vector3();
const lookGoal = new THREE.Vector3();
const headGoal = new THREE.Vector3();

const BASE_FOV = 55, BASE_H = 26, BASE_BACK = 18;
let CAM_H = BASE_H, CAM_BACK = BASE_BACK;

/* 竖屏时纵向 FOV 固定会把横向视野压得极窄，只把镜头拉远、不动 FOV，
   既扩大横向范围又不引入广角畸变。
   画布尺寸用容器实测值，而不是 innerHeight —— 移动端后者会把地址栏也算进去。 */
function fitCamera() {
  const w = app.clientWidth || innerWidth;
  const h = app.clientHeight || innerHeight;
  const aspect = w / h;
  const t = Math.max(0, Math.min(1, (1.25 - aspect) / 0.75));

  camera.aspect = aspect;
  camera.fov = BASE_FOV;
  const k = 1 + t * 0.35;
  CAM_H = BASE_H * k;
  CAM_BACK = BASE_BACK * k;
  camera.updateProjectionMatrix();

  renderer.setSize(w, h);
}

function tick() {
  requestAnimationFrame(tick);
  const raw = clock.getDelta();
  // 物理用 dt 要小（步子太大穿墙），计时用 tdt 可以大一些。
  // 低帧率设备上如果两处都用 0.05 截断，90 秒的局会被拖成 150 秒。
  const dt = Math.min(raw, 0.05);
  const tdt = Math.min(raw, 0.25);

  // 开局倒数：按墙钟算剩余，不累加 dt，帧率再低也是准的
  if (cdTimer > 0) {
    cdTimer = Math.max(0, (cdEndAt - performance.now()) / 1000);
    const n = Math.ceil(cdTimer);
    if (n !== cdShown) {
      cdShown = n;
      showCd(n > 0 ? String(n) : 'GO');
    }
    if (cdTimer <= 0) {
      beginPlay();
      goTimer = 0.55;
    }
  } else if (goTimer > 0) {
    goTimer -= dt;
    if (goTimer <= 0) el.cd.classList.remove('on');
  }

  if (running) {
    timeLeft = Math.max(0, timeLeft - tdt);

    const v = inputVector();
    me.move(v.x, v.z, dt);
    opp.update(dt);

    me.trail();
    if (opp.isBot) opp.trail();

    fillTimer += dt;
    if (fillTimer >= FILL_INTERVAL) {
      fillTimer = 0;
      checkEnclosure();
    }

    netPump(dt);

    hudTimer += dt;
    if (hudTimer > 0.1) { hudTimer = 0; updateHUD(); }

    if (timeLeft <= 0) endGame();
  }

  if (toastTimer > 0) {
    toastTimer -= dt;
    if (toastTimer <= 0) el.toast.classList.remove('on');
  }

  paintLayer.flush();
  me.sync(dt);
  opp.sync(dt);

  camGoal.set(me.pos.x, CAM_H, me.pos.z + CAM_BACK);
  lookGoal.set(me.pos.x, 0, me.pos.z - 1.5);
  const k = 1 - Math.pow(0.0015, dt);
  camera.position.lerp(camGoal, k);
  camTarget.lerp(lookGoal, k);
  camera.lookAt(camTarget);

  // 遮挡淡出要用"当前帧的镜头"和"玩家胸口"，放在相机更新之后
  headGoal.set(me.pos.x, 1.4, me.pos.z);
  world.update(dt, camera.position, headGoal);

  renderer.render(scene, camera);
}

addEventListener('resize', fitCamera);
addEventListener('orientationchange', fitCamera);
if (window.ResizeObserver) new ResizeObserver(fitCamera).observe(app);

/* 调试接口：控制台执行 __sim(10) 可快进 10 秒，用来截图 / 演示 */
window.__sim = function (seconds) {
  const dt = 1 / 60;
  const steps = Math.round(seconds * 60);
  running = true;
  el.cd.classList.remove('on');
  cdTimer = 0;

  for (let i = 0; i < steps; i++) {
    timeLeft = Math.max(0, timeLeft - dt);
    const v = inputVector();
    me.move(v.x, v.z, dt);
    opp.update(dt);
    me.trail();
    if (opp.isBot) opp.trail();

    fillTimer += dt;
    if (fillTimer >= FILL_INTERVAL) { fillTimer = 0; checkEnclosure(); }
  }

  me.sync(dt);
  opp.sync(dt);
  paintLayer.flush();
  camera.position.set(me.pos.x, CAM_H, me.pos.z + CAM_BACK);
  camTarget.set(me.pos.x, 0, me.pos.z - 1.5);
  camera.lookAt(camTarget);
  updateHUD();
  if (timeLeft <= 0 && running) endGame();
};

window.__game = {
  scene, camera, renderer, territory, MAP, world, trees, paintLayer,
  get me() { return me; },
  get opp() { return opp; },
  get mode() { return mode; },
  get side() { return side; },
  get running() { return running; },
  get timeLeft() { return timeLeft; },
  get cdTimer() { return cdTimer; },
  get net() { return net; },
  startSolo,
};

updateNames();
updateHUD();
fitCamera();
tick();
