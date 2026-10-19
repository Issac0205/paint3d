/* ============================================================
   world.js —— 把地图数据变成能看的东西
   ------------------------------------------------------------
   分工：map.js 只管"哪里有水、哪里有楼"，本文件只管"长什么样"。
   所有材质都走 MeshStandardMaterial + 程序化贴图，配合方向光阴影，
   让俯视角也能看出体积感。
   ============================================================ */

import * as THREE from 'three';
import { MAP } from './map.js';
import * as TEX from './textures.js';

const WORLD = MAP.world;

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

/* 复制一份贴图并改平铺次数（repeat 是贴图级属性，不能共用） */
function rep(tex, rx, ry) {
  const t = tex.clone();
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(rx, ry);
  t.needsUpdate = true;
  return t;
}

/* 多边形沿外法线外扩，用来做河岸的浅滩
   （按质心缩放对狭长河道几乎不生效，必须用真正的边法线） */
function offsetPoly(poly, amount) {
  const n = poly.length;

  let area = 0;
  for (let i = 0; i < n; i++) {
    const [x1, z1] = poly[i];
    const [x2, z2] = poly[(i + 1) % n];
    area += x1 * z2 - x2 * z1;
  }
  const sign = area > 0 ? 1 : -1;

  const out = [];
  for (let i = 0; i < n; i++) {
    const [px, pz] = poly[(i - 1 + n) % n];
    const [cx, cz] = poly[i];
    const [nx2, nz2] = poly[(i + 1) % n];

    let ax = cx - px, az = cz - pz;
    let bx = nx2 - cx, bz = nz2 - cz;
    const la = Math.hypot(ax, az) || 1;
    const lb = Math.hypot(bx, bz) || 1;
    ax /= la; az /= la; bx /= lb; bz /= lb;

    // 边方向的法线 = (sign*dz, -sign*dx)
    let ox = sign * az + sign * bz;
    let oz = -sign * ax - sign * bx;
    const lo = Math.hypot(ox, oz) || 1;

    out.push([cx + (ox / lo) * amount, cz + (oz / lo) * amount]);
  }
  return out;
}

function shapeFromPoly(poly) {
  const s = new THREE.Shape();
  poly.forEach(([x, z], i) => {
    // 绕 X 轴转 -90° 之后 world.z = -shape.y
    if (i === 0) s.moveTo(x, -z);
    else s.lineTo(x, -z);
  });
  return s;
}

export function buildWorld(scene, renderer, trees, lamps) {
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  TEX.setAnisotropy(aniso);

  const group = new THREE.Group();
  scene.add(group);

  const dummy = new THREE.Object3D();

  /* ---------------- 地面 ---------------- */
  const grass = TEX.grassTexture();
  grass.repeat.set(9, 9);

  // 地面画得比战场大得多，边界之外直接融进雾里，不留接缝
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD * 3.2, WORLD * 3.2),
    new THREE.MeshStandardMaterial({ map: rep(grass, 29, 29), roughness: 1, metalness: 0 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  /* ---------------- 边界石牙 ---------------- */
  {
    const curbTex = TEX.stoneTexture();
    const curbMat = new THREE.MeshStandardMaterial({ map: rep(curbTex, 24, 1), roughness: 0.95 });
    const h = WORLD / 2;
    for (const [px, pz, len, rot] of [
      [0, -h, WORLD, 0], [0, h, WORLD, 0], [-h, 0, WORLD, Math.PI / 2], [h, 0, WORLD, Math.PI / 2],
    ]) {
      const curb = new THREE.Mesh(new THREE.BoxGeometry(len, 0.26, 0.34), curbMat);
      curb.position.set(px, 0.11, pz);
      curb.rotation.y = rot;
      curb.castShadow = true;
      curb.receiveShadow = true;
      group.add(curb);
    }
  }

  /* ---------------- 步道 ---------------- */
  const plazaTex = TEX.plazaTexture();
  const promTex = TEX.plazaTexture(512, 0.92);

  for (const p of MAP.paths) {
    const w = p.x1 - p.x0, d = p.z1 - p.z0;
    const tex = p.kind === 'plaza' ? rep(plazaTex, w / 4.5, d / 4.5) : rep(promTex, w / 3.4, d / 3.4);
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0 })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set((p.x0 + p.x1) / 2, 0.002, (p.z0 + p.z1) / 2);
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  /* ---------------- 河岸浅滩 + 水面 ---------------- */
  const shoreMat = new THREE.MeshStandardMaterial({
    color: 0xb6a684,
    map: rep(plazaTex, 0.6, 0.6),
    roughness: 1,
  });

  const waterNormal = TEX.waterNormalTexture();
  waterNormal.repeat.set(0.55, 0.55);   // ShapeGeometry 的 UV 就是世界坐标

  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x2f7f9e,
    roughness: 0.07,
    metalness: 0.34,
    normalMap: waterNormal,
    normalScale: new THREE.Vector2(0.62, 0.62),
    transparent: true,
    opacity: 0.93,
  });

  for (const poly of MAP.waters) {
    const shore = new THREE.Mesh(new THREE.ShapeGeometry(shapeFromPoly(offsetPoly(poly, 1.05))), shoreMat);
    shore.rotation.x = -Math.PI / 2;
    shore.position.y = 0.0035;
    group.add(shore);

    const water = new THREE.Mesh(new THREE.ShapeGeometry(shapeFromPoly(poly)), waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0.006;
    group.add(water);
  }

  /* ---------------- 桥 ---------------- */
  const woodTex = TEX.woodTexture();
  const stoneTex = TEX.stoneTexture();

  for (const b of MAP.bridges) {
    const w = b.x1 - b.x0, d = b.z1 - b.z0;
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
    const alongX = w >= d;

    // 桥面
    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.12, d),
      new THREE.MeshStandardMaterial({ map: rep(woodTex, w / 2.4, d / 2.4), roughness: 0.85 })
    );
    deck.position.set(cx, -0.05, cz);     // 顶面 = 0.01，低于涂色层
    deck.castShadow = true;
    deck.receiveShadow = true;
    group.add(deck);

    // 栏杆：沿长边两道
    const railMat = new THREE.MeshStandardMaterial({
      map: rep(woodTex, alongX ? w / 2 : d / 2, 1),
      roughness: 0.8,
    });
    const railLen = alongX ? w : d;
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(railLen, 0.42, 0.14), railMat);
      if (alongX) {
        rail.position.set(cx, 0.22, cz + side * (d / 2 - 0.07));
      } else {
        rail.position.set(cx + side * (w / 2 - 0.07), 0.22, cz);
        rail.rotation.y = Math.PI / 2;
      }
      rail.castShadow = true;
      group.add(rail);
    }

    // 桥墩：跨到水里才有支撑感
    const pierMat = new THREE.MeshStandardMaterial({ map: rep(stoneTex, 1, 2), roughness: 0.95 });
    for (const t of [0.3, 0.7]) {
      const pier = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.2, 0.7), pierMat);
      pier.position.set(
        b.x0 + w * t,
        -0.55,
        cz
      );
      pier.castShadow = true;
      group.add(pier);
    }
  }

  /* ---------------- 建筑 ---------------- */
  /* 每栋楼的材质都做成"可淡出"的：玩家走到楼后面时，
     镜头到玩家的连线被楼挡住，这栋楼就淡下去，不会把人挡没。 */
  const roofTex = TEX.roofTexture();
  const buildings = [];

  const fadeable = (mat) => {
    mat.transparent = true;
    mat.opacity = 1;
    mat.depthWrite = true;
    return mat;
  };

  const acBoxGeo = new THREE.BoxGeometry(1, 1, 1);
  const acFanGeo = new THREE.CircleGeometry(1, 12);
  acFanGeo.rotateX(-Math.PI / 2);

  for (const b of MAP.buildings) {
    const w = b.x1 - b.x0, d = b.z1 - b.z0, h = b.h;
    const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;

    const g = new THREE.Group();
    const mats = [];
    const track = (m) => { mats.push(m); return m; };

    // 主体：立面按窗户模块平铺
    const facade = TEX.facadeTexture(256, [104, 114, 130]);
    const nx = Math.max(2, Math.round(w / 4.2));
    const ny = Math.max(1, Math.round(h / 3.0));
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      track(fadeable(new THREE.MeshStandardMaterial({
        map: rep(facade, nx, ny), roughness: 0.82, metalness: 0.04,
      })))
    );
    body.position.set(cx, h / 2, cz);
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    // 屋顶板（出挑一点，形成檐口阴影）
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(w + 0.55, 0.14, d + 0.55),
      track(fadeable(new THREE.MeshStandardMaterial({
        map: rep(roofTex, w / 1.9, d / 1.9), roughness: 0.95,
      })))
    );
    roof.position.set(cx, h + 0.07, cz);
    roof.castShadow = true;
    roof.receiveShadow = true;
    g.add(roof);

    // 女儿墙：带洞的矩形挤出成环
    const ow = w + 0.55, od = d + 0.55;
    const shape = new THREE.Shape();
    shape.moveTo(-ow / 2, -od / 2);
    shape.lineTo(ow / 2, -od / 2);
    shape.lineTo(ow / 2, od / 2);
    shape.lineTo(-ow / 2, od / 2);
    shape.closePath();
    const hole = new THREE.Path();
    const iw = w + 0.18, id = d + 0.18;
    hole.moveTo(-iw / 2, -id / 2);
    hole.lineTo(-iw / 2, id / 2);
    hole.lineTo(iw / 2, id / 2);
    hole.lineTo(iw / 2, -id / 2);
    hole.closePath();
    shape.holes.push(hole);

    const parapetGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.34, bevelEnabled: false });
    parapetGeo.rotateX(-Math.PI / 2);
    const parapetMat = track(fadeable(new THREE.MeshStandardMaterial({ color: 0x8a94a4, roughness: 0.9 })));
    const parapet = new THREE.Mesh(parapetGeo, parapetMat);
    parapet.position.set(cx, h + 0.14, cz);
    parapet.castShadow = true;
    g.add(parapet);

    // 入口朝向地图中心
    let nxDir = 0, nzDir = 0;
    if (Math.abs(cx) >= Math.abs(cz)) nxDir = cx > 0 ? -1 : 1;
    else nzDir = cz > 0 ? -1 : 1;

    const rotY = nxDir === 1 ? Math.PI / 2 : nxDir === -1 ? -Math.PI / 2 : nzDir === 1 ? 0 : Math.PI;
    const span = Math.min(nxDir ? d : w, 6.4);
    const faceOff = nxDir ? w / 2 : d / 2;

    // 门
    const door = new THREE.Mesh(
      new THREE.BoxGeometry(1.9, 1.85, 0.1),
      track(fadeable(new THREE.MeshStandardMaterial({ color: 0x18242e, roughness: 0.25, metalness: 0.5 })))
    );
    door.position.set(cx + nxDir * (faceOff + 0.04), 0.93, cz + nzDir * (faceOff + 0.04));
    door.rotation.y = rotY;
    g.add(door);

    // 雨棚
    const canopy = new THREE.Mesh(
      new THREE.BoxGeometry(span, 0.13, 1.5),
      track(fadeable(new THREE.MeshStandardMaterial({ color: 0x5c6675, roughness: 0.8 })))
    );
    canopy.position.set(cx + nxDir * (faceOff + 0.72), Math.min(h * 0.66, 2.55), cz + nzDir * (faceOff + 0.72));
    canopy.rotation.y = rotY;
    canopy.castShadow = true;
    g.add(canopy);

    // 高层楼顶加个设备房，俯视时屋顶不至于太干净
    if (h >= 2.8) {
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(Math.min(w * 0.3, 3.4), 0.9, Math.min(d * 0.3, 3)),
        parapetMat
      );
      box.position.set(cx + w * 0.16, h + 0.59, cz - d * 0.16);
      box.castShadow = true;
      g.add(box);
    }

    // 屋顶机组：这个视角主要看的就是屋顶，空着会很假
    const rr = mulberry32(Math.round((cx + 40) * 131 + (cz + 40) * 17));
    const nAC = 2 + Math.floor(rr() * 3);

    const acMat = track(fadeable(new THREE.MeshStandardMaterial({ color: 0x9ba6b4, roughness: 0.72, metalness: 0.22 })));
    const fanMat = track(fadeable(new THREE.MeshStandardMaterial({ color: 0x2f3742, roughness: 0.85 })));

    const acMesh = new THREE.InstancedMesh(acBoxGeo, acMat, nAC);
    const fanMesh = new THREE.InstancedMesh(acFanGeo, fanMat, nAC);
    acMesh.castShadow = true;
    acMesh.receiveShadow = true;

    for (let i = 0; i < nAC; i++) {
      const aw = 0.75 + rr() * 1.0;
      const ad = 0.7 + rr() * 1.0;
      const ah = 0.34 + rr() * 0.22;
      const ax = cx + (rr() - 0.5) * Math.max(0.5, w - aw - 1.6);
      const az = cz + (rr() - 0.5) * Math.max(0.5, d - ad - 1.6);
      const ay = h + 0.14 + ah / 2;

      dummy.position.set(ax, ay, az);
      dummy.rotation.set(0, rr() > 0.5 ? 0 : Math.PI / 2, 0);
      dummy.scale.set(aw, ah, ad);
      dummy.updateMatrix();
      acMesh.setMatrixAt(i, dummy.matrix);

      const fr = Math.min(aw, ad) * 0.33;
      dummy.position.set(ax, ay + ah / 2 + 0.006, az);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(fr, 1, fr);
      dummy.updateMatrix();
      fanMesh.setMatrixAt(i, dummy.matrix);
    }
    acMesh.instanceMatrix.needsUpdate = true;
    fanMesh.instanceMatrix.needsUpdate = true;
    g.add(acMesh, fanMesh);

    group.add(g);

    const casters = [];
    g.traverse(o => { if (o.isMesh && o.castShadow) casters.push(o); });

    buildings.push({
      group: g,
      mats,
      casters,
      lastGoal: 1,
      box: new THREE.Box3(
        new THREE.Vector3(b.x0 - 0.05, 0, b.z0 - 0.05),
        new THREE.Vector3(b.x1 + 0.05, h + 0.5, b.z1 + 0.05)
      ),
    });
  }

  /* 线段与 AABB 求交（slab 法）：判断镜头到玩家的视线有没有被楼挡住 */
  function segHitsBox(p0, p1, box) {
    const o = [p0.x, p0.y, p0.z];
    const dir = [p1.x - p0.x, p1.y - p0.y, p1.z - p0.z];
    const mn = [box.min.x, box.min.y, box.min.z];
    const mx = [box.max.x, box.max.y, box.max.z];

    let t0 = 0, t1 = 1;
    for (let i = 0; i < 3; i++) {
      if (Math.abs(dir[i]) < 1e-8) {
        if (o[i] < mn[i] || o[i] > mx[i]) return false;
        continue;
      }
      let a = (mn[i] - o[i]) / dir[i];
      let b = (mx[i] - o[i]) / dir[i];
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return false;
    }
    return true;
  }

  function updateOcclusion(camPos, target, dt) {
    const k = 1 - Math.pow(0.0006, dt);
    for (const b of buildings) {
      const goal = segHitsBox(camPos, target, b.box) ? 0.14 : 1;

      // 淡出时把投影也关掉，不然楼影还留在地上，像块脏斑
      if (goal !== b.lastGoal) {
        b.lastGoal = goal;
        const on = goal > 0.9;
        for (const o of b.casters) o.castShadow = on;
      }

      for (const m of b.mats) {
        if (Math.abs(m.opacity - goal) < 0.004) {
          if (m.opacity !== goal) {
            m.opacity = goal;
            m.depthWrite = goal > 0.9;
          }
          continue;
        }
        m.opacity += (goal - m.opacity) * k;
        m.depthWrite = m.opacity > 0.9;
      }
    }
  }

  /* ---------------- 树 ---------------- */
  const trunkGeo = new THREE.CylinderGeometry(0.13, 0.19, 1, 6);
  const canopyGeo = new THREE.IcosahedronGeometry(1, 0);

  const trunkMesh = new THREE.InstancedMesh(
    trunkGeo,
    new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 1, flatShading: true }),
    trees.length
  );
  const canopyMesh = new THREE.InstancedMesh(
    canopyGeo,
    new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }),
    trees.length * 2
  );
  trunkMesh.castShadow = true;
  canopyMesh.castShadow = true;
  canopyMesh.receiveShadow = true;
  trunkMesh.frustumCulled = false;
  canopyMesh.frustumCulled = false;

  const col = new THREE.Color();

  trees.forEach((t, i) => {
    const th = 1.5 * t.s;

    dummy.position.set(t.x, th / 2, t.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(t.s, th, t.s);
    dummy.updateMatrix();
    trunkMesh.setMatrixAt(i, dummy.matrix);

    // 主树冠
    const cs = 0.92 * t.s;
    dummy.position.set(t.x, th + cs * 0.55, t.z);
    dummy.rotation.set(0, t.s * 7.3, 0);
    dummy.scale.set(cs, cs * 0.88, cs);
    dummy.updateMatrix();
    canopyMesh.setMatrixAt(i * 2, dummy.matrix);
    col.setHSL(0.29 + Math.random() * 0.03, 0.44, 0.11 + Math.random() * 0.05);
    canopyMesh.setColorAt(i * 2, col);

    // 副树冠：偏一点，破掉"一个球"的感觉
    const cs2 = cs * 0.66;
    dummy.position.set(t.x + cs * 0.42, th + cs * 0.32, t.z - cs * 0.3);
    dummy.rotation.set(0, t.s * 3.1, 0);
    dummy.scale.set(cs2, cs2 * 0.9, cs2);
    dummy.updateMatrix();
    canopyMesh.setMatrixAt(i * 2 + 1, dummy.matrix);
    col.setHSL(0.28 + Math.random() * 0.03, 0.42, 0.09 + Math.random() * 0.04);
    canopyMesh.setColorAt(i * 2 + 1, col);
  });

  trunkMesh.instanceMatrix.needsUpdate = true;
  canopyMesh.instanceMatrix.needsUpdate = true;
  if (canopyMesh.instanceColor) canopyMesh.instanceColor.needsUpdate = true;

  group.add(trunkMesh, canopyMesh);

  /* ---------------- 路灯 ---------------- */
  const postGeo = new THREE.CylinderGeometry(0.055, 0.075, 3.1, 6);
  const headGeo = new THREE.BoxGeometry(0.28, 0.14, 0.28);
  const haloGeo = new THREE.SphereGeometry(0.42, 10, 8);

  const postMesh = new THREE.InstancedMesh(
    postGeo,
    new THREE.MeshStandardMaterial({ color: 0x2a2f38, roughness: 0.6, metalness: 0.6 }),
    lamps.length
  );
  const headMat = new THREE.MeshStandardMaterial({
    color: 0xffe0a8,
    emissive: 0xffb955,
    emissiveIntensity: 0.6,
    roughness: 0.4,
  });
  const headMesh = new THREE.InstancedMesh(headGeo, headMat, lamps.length);
  const haloMat = new THREE.MeshBasicMaterial({
    color: 0xffc978,
    transparent: true,
    opacity: 0.11,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  });
  const haloMesh = new THREE.InstancedMesh(haloGeo, haloMat, lamps.length);

  lamps.forEach((l, i) => {
    dummy.position.set(l.x, 1.55, l.z);
    dummy.rotation.set(0, 0, 0);
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    postMesh.setMatrixAt(i, dummy.matrix);

    dummy.position.set(l.x, 3.16, l.z);
    dummy.updateMatrix();
    headMesh.setMatrixAt(i, dummy.matrix);
    haloMesh.setMatrixAt(i, dummy.matrix);
  });

  postMesh.instanceMatrix.needsUpdate = true;
  headMesh.instanceMatrix.needsUpdate = true;
  haloMesh.instanceMatrix.needsUpdate = true;
  postMesh.castShadow = true;

  group.add(postMesh, headMesh, haloMesh);

  /* ---------------- 每帧更新 ---------------- */
  let t = 0;
  function update(dt, camPos, lookAt) {
    t += dt;
    if (camPos && lookAt) updateOcclusion(camPos, lookAt, dt);
    // 水面缓慢流动：两层不同速度叠加，避免看出规律
    waterNormal.offset.x += dt * 0.014;
    waterNormal.offset.y += dt * 0.009;
    // 灯光轻微呼吸
    haloMat.opacity = 0.10 + Math.sin(t * 1.7) * 0.025;
    headMat.emissiveIntensity = 0.58 + Math.sin(t * 1.7) * 0.1;
  }

  return { group, update, waterMat, ground };
}
