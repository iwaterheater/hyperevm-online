import * as THREE from 'three';
import { part, merge, box, cyl, cone, ball } from './geo.js';
import { WORLD_R, TOWN_R, ZONES, BOSS } from './shared.js';

// The visible world: terrain, water, town, per-zone scenery, lighting and zone mood.
// Scenery is generated from a fixed seed so every client sees the same landscape.

const HALF_PI = Math.PI / 2;
const Z1 = ZONES[1].r, Z2 = ZONES[2].r;
const smooth = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function grainTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#dcdcdc';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5000; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.16)';
    g.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 2, 1 + Math.random() * 3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Zone moods, blended by how far the player is from the town.
const MOODS = [
  { sky: 0x9fd3e6, sun: 0xfff2d6, sunI: 2.0, hemiSky: 0xcfe9ff, hemiGround: 0x4a6b3a, hemiI: 0.95 },   // meadows
  { sky: 0x8f887c, sun: 0xffd9a8, sunI: 1.6, hemiSky: 0xd8cbb5, hemiGround: 0x4a4034, hemiI: 0.8 },    // graveyard
  { sky: 0x1c1016, sun: 0xff8a70, sunI: 1.1, hemiSky: 0x7a5068, hemiGround: 0x1a0c10, hemiI: 0.6 },    // cursed lands
].map((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, k.endsWith('I') ? v : new THREE.Color(v)])));

export function createWorld(scene) {
  let seed = 1337;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

  // ---- lighting
  scene.background = MOODS[0].sky.clone();
  scene.fog = new THREE.Fog(scene.background.getHex(), 45, 150);
  const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 80 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(hemi, sun, sun.target);

  // ---- terrain
  const SIZE = (WORLD_R + 20) * 2, SEG = Math.round(SIZE / 2);
  const ground = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  ground.rotateX(-HALF_PI);
  {
    const pos = ground.attributes.position, colors = new Float32Array(pos.count * 3);
    const C = (hex) => new THREE.Color(hex);
    const grass = [C(0x4f8f3a), C(0x74b04c)], dust = [C(0x6f6150), C(0x8d7c64)], ash = [C(0x2b2329), C(0x47303a)];
    const road = C(0xa08a62), roadDark = C(0x5a4b46), paving = [C(0x9a9484), C(0xb3ad9c)], sand = C(0xd2c391);
    const col = new THREE.Color(), tmp = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i), r = Math.hypot(x, z);
      const n = noise(x * 0.08, z * 0.08) * 0.6 + noise(x * 0.31, z * 0.31) * 0.4;
      const rr = r + (noise(x * 0.05 + 40, z * 0.05) - 0.5) * 16;   // wobble the zone borders
      const t1 = smooth(Z1 - 6, Z1 + 6, rr), t2 = smooth(Z2 - 6, Z2 + 6, rr);
      col.lerpColors(grass[0], grass[1], n);
      col.lerp(tmp.lerpColors(dust[0], dust[1], n), t1);
      col.lerp(tmp.lerpColors(ash[0], ash[1], n), t2);
      const onRoad = 1 - smooth(1.4, 3.0, Math.min(Math.abs(x), Math.abs(z)) + (n - 0.5) * 1.6);
      col.lerp(tmp.lerpColors(road, roadDark, t2), onRoad * 0.85);
      col.lerp(tmp.lerpColors(paving[0], paving[1], n), 1 - smooth(TOWN_R - 2.5, TOWN_R + 0.5, r));
      col.lerp(sand, smooth(WORLD_R - 4, WORLD_R, r));
      colors.set([col.r, col.g, col.b], i * 3);
      if (r > WORLD_R) pos.setY(i, -Math.min(4, (r - WORLD_R) * 0.3));   // beach sloping into the sea
    }
    ground.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    ground.computeVertexNormals();
  }
  const grain = grainTexture();
  grain.repeat.set(SIZE / 4, SIZE / 4);
  const groundMesh = new THREE.Mesh(ground, new THREE.MeshStandardMaterial({ vertexColors: true, map: grain, roughness: 1 }));
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);

  const sea = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: 0x2f7d9c, roughness: 0.25 }));
  sea.rotation.x = -HALF_PI;
  sea.position.y = -1.2;
  scene.add(sea);

  // ---- scenery helpers
  const obstacles = [];
  const flat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 });
  const dummy = new THREE.Object3D(), tint = new THREE.Color();

  function scatter(count, rMin, rMax, { sMin = 0.8, sMax = 1.3, road = 3.6 } = {}) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rMin * rMin + rnd() * (rMax * rMax - rMin * rMin));
      const it = { x: Math.cos(a) * r, z: Math.sin(a) * r, s: sMin + rnd() * (sMax - sMin), ry: rnd() * Math.PI * 2 };
      if (Math.min(Math.abs(it.x), Math.abs(it.z)) < road) continue;
      if (Math.hypot(it.x - BOSS.x, it.z - BOSS.z) < 19) continue;
      out.push(it);
    }
    return out;
  }

  function instanced(geo, items, { mat = flat, cast = true, solid = 0 } = {}) {
    const mesh = new THREE.InstancedMesh(geo, mat, items.length);
    items.forEach((it, i) => {
      dummy.position.set(it.x, it.y || 0, it.z);
      dummy.rotation.set(it.rx || 0, it.ry || 0, it.rz || 0);
      dummy.scale.set(it.sx ?? it.s, it.sy ?? it.s, it.sz ?? it.s);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      if (it.color) mesh.setColorAt(i, tint.set(it.color));
      if (solid) obstacles.push({ x: it.x, z: it.z, r: solid * it.s });
    });
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  }

  // ---- town
  {
    const parts = [];
    const add = (geo, color, pos, rot, scale) => parts.push(part(geo, color, { pos, rot, scale }));
    // fountain
    add(cyl(2.3, 2.5, 0.55, 20), 0x9c9a94, [0, 0.27, 0]);
    add(cyl(1.95, 1.95, 0.1, 20), 0x4fb3d9, [0, 0.56, 0]);
    add(cyl(0.4, 0.55, 1.5, 10), 0x8b8983, [0, 1.0, 0]);
    obstacles.push({ x: 0, z: 0, r: 2.6 });

    const house = (roof) => merge([
      part(box(3.2, 2.2, 3), 0xe6dcc3, { pos: [0, 1.1, 0] }),
      part(cone(2.75, 1.7, 4), roof, { pos: [0, 3.05, 0], rot: [0, Math.PI / 4, 0] }),
      part(box(0.75, 1.3, 0.1), 0x6b4a2e, { pos: [0, 0.65, 1.52] }),
      part(box(0.55, 0.55, 0.1), 0xffe9a6, { pos: [-1.0, 1.35, 1.52] }),
      part(box(0.55, 0.55, 0.1), 0xffe9a6, { pos: [1.0, 1.35, 1.52] }),
      part(box(0.4, 0.9, 0.4), 0x8b6f5a, { pos: [0.9, 3.2, -0.5] }),
    ]);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 8; i++) {
      const a = (i + 0.5) / 8 * Math.PI * 2, x = Math.cos(a) * 11.5, z = Math.sin(a) * 11.5;
      const h = house(i % 2 ? 0xb5533c : 0x3c8f86);
      h.applyMatrix4(m.makeRotationY(Math.atan2(-x, -z)).setPosition(x, 0, z));   // doors face the plaza
      parts.push(h);
      obstacles.push({ x, z, r: 2.3 });
    }
    // lamp posts and the low posts that mark the safe zone
    const bulbs = [];
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2 + 0.2, x = Math.cos(a) * 6.5, z = Math.sin(a) * 6.5;
      add(cyl(0.06, 0.09, 2.7, 6), 0x2f2b2a, [x, 1.35, z]);
      bulbs.push(part(ball(0.2), 0xffffff, { pos: [x, 2.8, z] }));
    }
    for (let i = 0; i < 56; i++) {
      const a = i / 56 * Math.PI * 2, x = Math.cos(a) * TOWN_R, z = Math.sin(a) * TOWN_R;
      if (Math.min(Math.abs(x), Math.abs(z)) > 2.6) add(box(0.45, 0.9, 0.45), 0x8f8a7e, [x, 0.45, z], [0, -a, 0]);
    }
    const town = new THREE.Mesh(merge(parts), flat);
    town.castShadow = town.receiveShadow = true;
    scene.add(town, new THREE.Mesh(merge(bulbs), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd9a0).multiplyScalar(2.2) })));
  }
  const crystal = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.7),
    new THREE.MeshStandardMaterial({ color: 0x0b2a25, emissive: 0x7fe8d6, emissiveIntensity: 1.6, flatShading: true }),
  );
  crystal.scale.y = 1.7;
  scene.add(crystal);

  // ---- meadows
  const pine = merge([
    part(cyl(0.18, 0.26, 1.4, 6), 0x6b4a2e, { pos: [0, 0.7, 0] }),
    part(cone(1.25, 1.8, 7), 0x3f7d3a, { pos: [0, 2.1, 0] }),
    part(cone(0.98, 1.5, 7), 0x4c9444, { pos: [0, 3.0, 0] }),
    part(cone(0.62, 1.2, 7), 0x5aa64e, { pos: [0, 3.85, 0] }),
  ]);
  const oak = merge([
    part(cyl(0.2, 0.3, 1.8, 6), 0x70502f, { pos: [0, 0.9, 0] }),
    part(new THREE.IcosahedronGeometry(1.35, 1), 0x4f9a45, { pos: [0, 2.7, 0] }),
    part(new THREE.IcosahedronGeometry(0.9, 0), 0x5fae52, { pos: [0.7, 3.2, 0.3] }),
    part(new THREE.IcosahedronGeometry(0.8, 0), 0x448a3c, { pos: [-0.7, 2.4, -0.4] }),
  ]);
  const rock = part(new THREE.DodecahedronGeometry(1, 0), 0x8a8d8f, { pos: [0, 0.45, 0], scale: [1, 0.7, 0.85] });
  const tuft = merge([0, 2.1, 4.2].map((a) => part(cone(0.07, 0.42, 3), 0x7cc65c, { pos: [Math.cos(a) * 0.09, 0.2, Math.sin(a) * 0.09], rot: [Math.cos(a) * 0.25, 0, Math.sin(a) * 0.25] })));
  const FLOWERS = [0xffffff, 0xffe066, 0xff8fb3, 0xb18cff];

  instanced(pine, scatter(330, TOWN_R + 4, Z1 + 4), { solid: 0.4 });
  instanced(oak, scatter(190, TOWN_R + 4, Z1 - 4, { sMin: 0.9, sMax: 1.5 }), { solid: 0.45 });
  instanced(new THREE.IcosahedronGeometry(0.6, 0), scatter(260, TOWN_R + 2, Z1).map((it) => ({ ...it, y: 0.3 * it.s, sy: it.s * 0.75, color: 0x3d7a36 })),
    { mat: new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9 }) });
  instanced(rock, scatter(150, TOWN_R + 2, Z1, { sMin: 0.5, sMax: 1.4 }), { solid: 0.85 });
  instanced(tuft, scatter(4200, TOWN_R, Z1 + 6, { sMin: 0.7, sMax: 1.5, road: 2.6 }), { cast: false });
  instanced(part(new THREE.IcosahedronGeometry(0.1, 0), 0xffffff, { pos: [0, 0.28, 0] }),
    scatter(1100, TOWN_R, Z1, { road: 2.6 }).map((it, i) => ({ ...it, color: FLOWERS[i % 4] })), { cast: false });

  // ---- graveyard wastes
  const deadTree = merge([
    part(cyl(0.1, 0.22, 2.6, 6), 0x3d2f26, { pos: [0, 1.3, 0] }),
    part(cyl(0.04, 0.08, 1.3, 5), 0x3d2f26, { pos: [0.45, 2.3, 0], rot: [0, 0, -0.9] }),
    part(cyl(0.04, 0.07, 1.1, 5), 0x3d2f26, { pos: [-0.38, 1.9, 0.1], rot: [0.2, 0, 0.95] }),
    part(cyl(0.03, 0.06, 0.9, 5), 0x3d2f26, { pos: [0.05, 2.9, -0.25], rot: [-0.7, 0, 0.1] }),
  ]);
  const tomb = merge([
    part(box(0.62, 0.8, 0.16), 0x7d7f80, { pos: [0, 0.4, 0] }),
    part(cyl(0.31, 0.31, 0.16, 12), 0x7d7f80, { pos: [0, 0.8, 0], rot: [HALF_PI, 0, 0] }),
    part(box(0.8, 0.12, 0.3), 0x66686a, { pos: [0, 0.06, 0] }),
  ]);
  const cross = merge([
    part(box(0.14, 1.3, 0.14), 0x5a4a3c, { pos: [0, 0.65, 0] }),
    part(box(0.7, 0.14, 0.14), 0x5a4a3c, { pos: [0, 0.95, 0] }),
  ]);
  const bonePile = merge([
    part(ball(0.16, 8, 6), 0xe9e3d2, { pos: [0.1, 0.14, 0] }),
    part(cyl(0.035, 0.035, 0.6, 5), 0xe9e3d2, { pos: [-0.15, 0.05, 0.1], rot: [0, 0.6, HALF_PI] }),
    part(cyl(0.035, 0.035, 0.5, 5), 0xe9e3d2, { pos: [0, 0.05, -0.2], rot: [0, -0.8, HALF_PI] }),
  ]);
  const tilt = (it) => ({ ...it, rx: (rnd() - 0.5) * 0.3, rz: (rnd() - 0.5) * 0.3 });
  instanced(deadTree, scatter(380, Z1 - 2, Z2 + 4, { sMin: 0.8, sMax: 1.5 }), { solid: 0.3 });
  instanced(tomb, scatter(420, Z1, Z2).map(tilt), { solid: 0.42 });
  instanced(cross, scatter(200, Z1, Z2).map(tilt), { solid: 0.25 });
  instanced(bonePile, scatter(500, Z1 - 10, WORLD_R - 4), { cast: false });
  instanced(part(new THREE.DodecahedronGeometry(1, 0), 0x74685a, { pos: [0, 0.45, 0], scale: [1, 0.7, 0.85] }),
    scatter(300, Z1, Z2, { sMin: 0.5, sMax: 1.7 }), { solid: 0.85 });

  // ---- cursed lands
  const spike = merge([
    part(cone(0.55, 2.8, 5), 0x1f191e, { pos: [0, 1.4, 0] }),
    part(cone(0.3, 1.5, 5), 0x2a2028, { pos: [0.45, 0.7, 0.15], rot: [0, 0, -0.35] }),
  ]);
  const pillar = merge([
    part(cyl(0.5, 0.6, 3.4, 8), 0x4d464b, { pos: [0, 1.7, 0] }),
    part(box(1.4, 0.3, 1.4), 0x3d373b, { pos: [0, 0.15, 0] }),
    part(box(1.2, 0.25, 1.2), 0x3d373b, { pos: [0, 3.5, 0], rot: [0.1, 0.3, 0.12] }),
  ]);
  instanced(spike, scatter(620, Z2 - 2, WORLD_R - 2, { sMin: 0.7, sMax: 1.9 }), { solid: 0.5 });
  instanced(pillar, scatter(170, Z2, WORLD_R - 6), { solid: 0.65 });
  instanced(new THREE.OctahedronGeometry(0.5), scatter(260, Z2, WORLD_R - 2, { sMin: 0.5, sMax: 1.4 }).map((it) => ({ ...it, y: 0.5 * it.s, sy: it.s * 2.2 })),
    { cast: false, mat: new THREE.MeshStandardMaterial({ color: 0x1a0508, emissive: 0xff3040, emissiveIntensity: 1.5, flatShading: true }) });

  // boss arena: a ring of tall pillars
  instanced(pillar, Array.from({ length: 12 }, (_, i) => {
    const a = i / 12 * Math.PI * 2;
    return { x: BOSS.x + Math.cos(a) * 14, z: BOSS.z + Math.sin(a) * 14, s: 1.8, ry: a };
  }), { solid: 0.65 });
  const lair = new THREE.Mesh(new THREE.TorusGeometry(13, 0.1, 8, 64), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2244).multiplyScalar(1.8) }));
  lair.rotation.x = HALF_PI;
  lair.position.set(BOSS.x, 0.08, BOSS.z);
  scene.add(lair);

  // ---- collision grid
  const CELL = 8, grid = new Map();
  for (const o of obstacles) {
    const key = `${Math.floor(o.x / CELL)},${Math.floor(o.z / CELL)}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(o);
  }

  // Pushes a circle (object with x/z) out of trees, rocks and buildings.
  function collide(p, radius = 0.4) {
    const cx = Math.floor(p.x / CELL), cz = Math.floor(p.z / CELL);
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cz - 1; j <= cz + 1; j++) {
        const cell = grid.get(`${i},${j}`);
        if (!cell) continue;
        for (const o of cell) {
          const dx = p.x - o.x, dz = p.z - o.z, d = Math.hypot(dx, dz), min = o.r + radius;
          if (d < min) {
            if (d < 0.001) { p.x += min; continue; }
            p.x = o.x + dx / d * min; p.z = o.z + dz / d * min;
          }
        }
      }
    }
  }

  const sky = new THREE.Color(), c2 = new THREE.Color();
  const mix = (key, t1, t2, out) => out.copy(MOODS[0][key]).lerp(MOODS[1][key], t1).lerp(MOODS[2][key], t2);
  const mixN = (key, t1, t2) => { const a = MOODS[0][key] + (MOODS[1][key] - MOODS[0][key]) * t1; return a + (MOODS[2][key] - a) * t2; };

  function update(time, x, z) {
    const d = Math.hypot(x, z);
    const t1 = smooth(Z1 - 14, Z1 + 14, d), t2 = smooth(Z2 - 14, Z2 + 14, d);
    mix('sky', t1, t2, sky);
    scene.background.copy(sky);
    scene.fog.color.copy(sky);
    mix('sun', t1, t2, sun.color);
    sun.intensity = mixN('sunI', t1, t2);
    mix('hemiSky', t1, t2, hemi.color);
    mix('hemiGround', t1, t2, c2);
    hemi.groundColor.copy(c2);
    hemi.intensity = mixN('hemiI', t1, t2);

    // the shadow frustum follows the player
    sun.position.set(x + 14, 26, z + 9);
    sun.target.position.set(x, 0, z);

    crystal.rotation.y = time * 0.7;
    crystal.position.y = 2.7 + Math.sin(time * 1.5) * 0.2;
  }

  return { update, collide };
}
