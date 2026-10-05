import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { part, merge, box, cyl, cone, ball } from './geo.js';
import { WORLD_R, TOWN_R, ZONES, BOSS, FORT_R, CHESTS } from './shared.js';

// The visible world: terrain, water, town, per-zone scenery, lighting and zone mood.
// Scenery is generated from a fixed seed so every client sees the same landscape.
// Buildings, trees, rocks and props come from the KayKit Medieval Hexagon Pack (CC0, Kay Lousberg);
// the graveyard comes from KayKit Halloween Bits and the Skeleton King's fortress from KayKit Dungeon Remastered (both CC0).

const MODEL_DIR = './assets/medieval/';
const GRAVEYARD_DIR = './assets/halloween/';
const DUNGEON_DIR = './assets/dungeon/';
const MODEL_SCALE = 5;   // the pack is modelled for small hex tiles

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
  { sky: 0x3a2230, sun: 0xffb9a0, sunI: 1.7, hemiSky: 0xb98aa6, hemiGround: 0x3a2028, hemiI: 1.05 },   // cursed lands: dusk, but readable
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
  const CELL = 8, grid = new Map();
  const obstacles = {
    push(o) {
      const key = `${Math.floor(o.x / CELL)},${Math.floor(o.z / CELL)}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(o);
    },
  };
  // landmarks placed by hand; scattered scenery keeps clear of them
  const keepOut = [{ x: BOSS.x, z: BOSS.z, r: FORT_R + 8 }, ...CHESTS.map((c) => ({ x: c.x, z: c.z, r: 2.5 }))];
  const flat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 });
  const dummy = new THREE.Object3D(), tint = new THREE.Color();

  function scatter(count, rMin, rMax, { sMin = 0.8, sMax = 1.3, road = 3.6 } = {}) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rMin * rMin + rnd() * (rMax * rMax - rMin * rMin));
      const it = { x: Math.cos(a) * r, z: Math.sin(a) * r, s: sMin + rnd() * (sMax - sMin), ry: rnd() * Math.PI * 2 };
      if (Math.min(Math.abs(it.x), Math.abs(it.z)) < road) continue;
      if (keepOut.some((k) => Math.hypot(it.x - k.x, it.z - k.z) < k.r)) continue;
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

    // lamp posts
    const bulbs = [];
    for (let i = 0; i < 8; i++) {
      const a = i / 8 * Math.PI * 2 + 0.2, x = Math.cos(a) * 6.5, z = Math.sin(a) * 6.5;
      add(cyl(0.06, 0.09, 2.7, 6), 0x2f2b2a, [x, 1.35, z]);
      bulbs.push(part(ball(0.2), 0xffffff, { pos: [x, 2.8, z] }));
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
  const tuft = merge([0, 2.1, 4.2].map((a) => part(cone(0.07, 0.42, 3), 0x7cc65c, { pos: [Math.cos(a) * 0.09, 0.2, Math.sin(a) * 0.09], rot: [Math.cos(a) * 0.25, 0, Math.sin(a) * 0.25] })));
  const FLOWERS = [0xffffff, 0xffe066, 0xff8fb3, 0xb18cff];

  instanced(new THREE.IcosahedronGeometry(0.6, 0), scatter(260, TOWN_R + 6, Z1).map((it) => ({ ...it, y: 0.3 * it.s, sy: it.s * 0.75, color: 0x3d7a36 })),
    { mat: new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9 }) });
  instanced(tuft, scatter(4200, TOWN_R + 4, Z1 + 6, { sMin: 0.7, sMax: 1.5, road: 2.6 }), { cast: false });
  instanced(part(new THREE.IcosahedronGeometry(0.1, 0), 0xffffff, { pos: [0, 0.28, 0] }),
    scatter(1100, TOWN_R + 4, Z1, { road: 2.6 }).map((it, i) => ({ ...it, color: FLOWERS[i % 4] })), { cast: false });

  // ---- cursed lands
  const spike = merge([
    part(cone(0.55, 2.8, 5), 0x1f191e, { pos: [0, 1.4, 0] }),
    part(cone(0.3, 1.5, 5), 0x2a2028, { pos: [0.45, 0.7, 0.15], rot: [0, 0, -0.35] }),
  ]);
  instanced(spike, scatter(620, Z2 - 2, WORLD_R - 2, { sMin: 0.7, sMax: 1.9 }), { solid: 0.5 });
  instanced(new THREE.OctahedronGeometry(0.5), scatter(260, Z2, WORLD_R - 2, { sMin: 0.5, sMax: 1.4 }).map((it) => ({ ...it, y: 0.5 * it.s, sy: it.s * 2.2 })),
    { cast: false, mat: new THREE.MeshStandardMaterial({ color: 0x1a0508, emissive: 0xff3040, emissiveIntensity: 1.5, flatShading: true }) });

  // the red circle in the middle of the King's fortress
  const lair = new THREE.Mesh(new THREE.TorusGeometry(13, 0.1, 8, 64), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2244).multiplyScalar(1.8) }));
  lair.rotation.x = HALF_PI;
  lair.position.set(BOSS.x, 0.08, BOSS.z);
  scene.add(lair);

  // ---- collision grid

  // ---- models from the KayKit Medieval Hexagon Pack
  const WALL_R = TOWN_R + 1.6, WALL_SEGMENTS = 28;
  const LANDMARKS = [
    ['building_windmill_blue', 36, -32, 1.2, 0.6], ['building_grain', 46, -34, 1, 0], ['building_grain', 37, -43, 1, 1.57],
    ['building_well_blue', -9, -34, 0.8, 0], ['building_stage_A', 11, 35, 1.2, 3.14],
    ['tent', 35, 9, 1.4, -1.2], ['tent', 37, -8, 1.4, -1.9], ['tent', -35, 10, 1.4, 1.3],
    ['building_tower_A_blue', 7, -62, 1, 0], ['building_tower_A_blue', 62, 7, 1, 1.57],
    ['building_tower_A_blue', -7, 62, 1, 3.14], ['building_tower_A_blue', -62, -7, 1, -1.57],
  ];
  for (const [, x, z] of LANDMARKS) keepOut.push({ x, z, r: 8 });

  // Lantern and torch models do not shine by themselves: a soft additive halo around each one sells the light.
  function addHalos(items, hex) {
    instanced(new THREE.SphereGeometry(0.55, 12, 8), items, {
      cast: false,
      mat: new THREE.MeshBasicMaterial({
        color: new THREE.Color(hex).multiplyScalar(1.6), transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false,
      }),
    });
  }

  // ---- graveyard wastes: models from KayKit Halloween Bits (already at world scale)
  const CRYPTS = [[40, -128, 0.3], [-46, 122, 3.4], [130, 40, -1.3], [-127, -44, 1.8], [96, 98, -0.8], [-99, -94, 2.4]];
  for (const [x, z] of CRYPTS) keepOut.push({ x, z, r: 12 });
  const PLOTS = scatter(18, Z1 + 14, Z2 - 14, { road: 17 });   // fenced cemeteries
  for (const p of PLOTS) keepOut.push({ x: p.x, z: p.z, r: 13 });

  async function addGraveyard() {
    const names = [
      'arch', 'bone_A', 'bone_B', 'bone_C', 'coffin', 'coffin_decorated', 'crypt', 'fence', 'fence_broken', 'fence_pillar', 'fence_pillar_broken',
      'grave_A', 'grave_A_destroyed', 'grave_B', 'gravemarker_A', 'gravemarker_B', 'gravestone', 'lantern_standing', 'pillar', 'plaque_candles',
      'post_lantern', 'post_skull', 'pumpkin_orange', 'pumpkin_orange_jackolantern', 'pumpkin_orange_small', 'pumpkin_yellow',
      'pumpkin_yellow_jackolantern', 'pumpkin_yellow_small', 'ribcage', 'shrine_candles', 'skull', 'skull_candle',
      'tree_dead_large', 'tree_dead_large_decorated', 'tree_dead_medium', 'tree_dead_small',
      'tree_pine_orange_large', 'tree_pine_orange_medium', 'tree_pine_orange_small', 'tree_pine_yellow_large', 'tree_pine_yellow_medium', 'tree_pine_yellow_small',
    ];
    const { many } = await loadPack(GRAVEYARD_DIR, names, 1);

    // autumn pines where the meadows give way to the wastes, dead trees beyond
    for (const name of names.filter((n) => n.startsWith('tree_pine'))) many(name, scatter(42, Z1 - 18, Z1 + 16, { sMin: 0.8, sMax: 1.25 }), 0.2);
    many('tree_dead_large', scatter(150, Z1, Z2 + 6, { sMin: 1, sMax: 1.6 }), 0.3);
    many('tree_dead_medium', scatter(150, Z1, Z2 + 6, { sMin: 1, sMax: 1.6 }), 0.3);
    many('tree_dead_small', scatter(120, Z1 - 6, WORLD_R - 6, { sMin: 1, sMax: 1.6 }), 0.3);
    many('tree_dead_large_decorated', scatter(30, Z1, Z2, { sMin: 1, sMax: 1.4 }), 0.3);

    // loose graves, coffins, bones and pumpkins
    for (const name of ['grave_A', 'grave_B', 'grave_A_destroyed']) many(name, scatter(65, Z1, Z2), 0.55);
    many('gravestone', scatter(120, Z1, Z2), 0.5);
    many('gravemarker_A', scatter(90, Z1 - 4, Z2 + 4), 0.6);
    many('gravemarker_B', scatter(90, Z1 - 4, Z2 + 4), 0.6);
    many('coffin', scatter(16, Z1, Z2), 0.5);
    many('coffin_decorated', scatter(10, Z1, Z2), 0.5);
    for (const name of ['bone_A', 'bone_B', 'bone_C']) many(name, scatter(110, Z1 - 6, WORLD_R - 4).map((it) => ({ ...it, y: 0.14 })), 0, false);
    many('skull', scatter(90, Z1 - 6, WORLD_R - 4, { sMin: 0.5, sMax: 0.8 }), 0, false);
    many('ribcage', scatter(45, Z1, WORLD_R - 4).map((it) => ({ ...it, y: 0.39 })), 0, false);
    for (const name of names.filter((n) => n.startsWith('pumpkin'))) many(name, scatter(12, Z1, Z2), name.includes('small') ? 0 : 0.7);

    // hand-placed pieces are batched per model so each model stays one draw call
    const batch = {}, glows = [];
    const put = (name, x, z, ry = 0, s = 1) => (batch[name] ||= []).push({ x, z, ry, s });
    const solid = (x, z, r) => obstacles.push({ x, z, r });
    // local (lx, lz) of an object at (ox, oz) turned by ry -> world
    const at = (ox, oz, ry, lx, lz) => [ox + lx * Math.cos(ry) + lz * Math.sin(ry), oz - lx * Math.sin(ry) + lz * Math.cos(ry)];
    const lantern = (x, z) => { put('lantern_standing', x, z); glows.push({ x, y: 0.55, z, s: 1 }); };

    // fenced cemeteries: 20 x 12, a gap in the south fence, two rows of graves inside
    const GRAVES = ['grave_A', 'grave_B', 'grave_A_destroyed', 'grave_B', 'grave_A'];
    for (const p of PLOTS) {
      const L = (lx, lz) => at(p.x, p.z, p.ry, lx, lz);
      const fence = (lx, lz, turn) => {
        const [x, z] = L(lx, lz);
        put(rnd() < 0.2 ? 'fence_broken' : 'fence', x, z, p.ry + turn);
        for (const t of [-1.4, 0, 1.4]) solid(...L(lx + (turn ? 0 : t), lz + (turn ? t : 0)), 0.55);
      };
      for (const lx of [-8, -4, 0, 4, 8]) {
        fence(lx, -6, 0);
        if (lx !== 0) fence(lx, 6, 0);
      }
      for (const lz of [-4, 0, 4]) { fence(-10, lz, Math.PI / 2); fence(10, lz, Math.PI / 2); }
      for (const [lx, lz] of [[-10, -6], [10, -6], [-10, 6], [10, 6], [-2, 6], [2, 6]]) {
        const [x, z] = L(lx, lz);
        put(rnd() < 0.15 ? 'fence_pillar_broken' : 'fence_pillar', x, z, p.ry);
        solid(x, z, 0.45);
      }
      for (const lz of [-3.2, 2]) {
        [-7, -3.5, 0, 3.5, 7].forEach((lx, i) => {
          const [x, z] = L(lx, lz);
          put(GRAVES[(i + (lz > 0 ? 2 : 0)) % GRAVES.length], x, z, p.ry);
          solid(x, z, 0.6);
        });
      }
      put('plaque_candles', ...L(0, -0.6), p.ry);
      lantern(...L(-3.2, 7.3));
      lantern(...L(3.2, 7.3));
      if (rnd() < 0.6) put('pumpkin_orange_jackolantern', ...L(8.3, 4.3), p.ry + 0.4);
    }

    // crypts with pillars, candles and lanterns at the front
    for (const [x, z, ry] of CRYPTS) {
      put('crypt', x, z, ry);
      for (const [lx, lz] of [[-1.8, -2.4], [1.8, -2.4], [-1.8, 2.4], [1.8, 2.4], [0, 0]]) solid(...at(x, z, ry, lx, lz), 2.3);
      for (const lx of [-4.6, 4.6]) {
        for (const lz of [5.6, -5.6]) { const q = at(x, z, ry, lx, lz); put('pillar', ...q, ry); solid(...q, 0.6); }
        lantern(...at(x, z, ry, lx * 0.5, 6.2));
        put('skull_candle', ...at(x, z, ry, lx * 0.8, 7.4), ry + lx);
      }
      put('shrine_candles', ...at(x, z, ry, 0, 8.2), ry);
    }

    // roads: an arch at each zone border, lantern posts through the wastes, skull posts through the cursed lands
    const ROADS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    for (const [dx, dz] of ROADS) {
      const turn = dx ? Math.PI / 2 : 0;   // arches span the road
      for (const r of [Z1 + 2, Z2 + 2]) {
        put('arch', dx * r, dz * r, turn, 1.7);
        for (const side of [-3, 3]) solid(dx * r + dz * side, dz * r + dx * side, 0.8);
      }
      let side = 1;
      for (let r = Z1 + 12; r < WORLD_R - 16; r += 14) {
        if (Math.abs(r - Z2) < 8 || Math.hypot(dx * r - BOSS.x, dz * r - BOSS.z) < 20) continue;
        side = -side;
        const x = dx * r + dz * side * 3.8, z = dz * r + dx * side * 3.8;
        const ry = Math.atan2(-dz * side, -dx * side);   // the arm (local +Z) reaches over the road
        put(r < Z2 ? 'post_lantern' : 'post_skull', x, z, ry);
        solid(x, z, 0.35);
        if (r < Z2) glows.push({ x: x + Math.sin(ry), y: 2.25, z: z + Math.cos(ry), s: 1.3 });
      }
    }

    for (const [name, items] of Object.entries(batch)) many(name, items);
    for (const it of scatter(60, Z1, Z2)) { (batch.loose ||= []).push(it); glows.push({ x: it.x, y: 0.55, z: it.z, s: 1 }); }
    many('lantern_standing', batch.loose.map((it) => ({ ...it, s: 1 })));
    addHalos(glows, 0xffb050);
  }

  // ---- the Skeleton King's fortress and cursed-land ruins: models from KayKit Dungeon Remastered (world scale)
  async function addFortress() {
    const names = ['wall', 'wall_broken', 'wall_cracked', 'wall_pillar', 'pillar', 'pillar_decorated', 'banner_red', 'torch_mounted',
      'rubble_large', 'rubble_half', 'sword_shield', 'sword_shield_broken', 'sword_shield_gold', 'barrel_large', 'crates_stacked',
      'coin_stack_small', 'coin_stack_medium', 'coin_stack_large'];
    const { many } = await loadPack(DUNGEON_DIR, names, 1, 'glb');
    const batch = {}, flames = [];
    const put = (name, x, z, ry = 0, s = 1, y = 0) => (batch[name] ||= []).push({ x, z, ry, s, y });
    const solid = (x, z, r) => obstacles.push({ x, z, r });

    // ring wall: intact with banners and torches in the north, ruined towards the gate in the south
    const S = 1.5, N = Math.round(2 * Math.PI * FORT_R / (4 * S));
    for (let i = 0; i < N; i++) {
      const a = i / N * Math.PI * 2, cx = Math.cos(a), cz = Math.sin(a);
      if (cz > 0.94) continue;   // the gate faces the road from town
      const x = BOSS.x + cx * FORT_R, z = BOSS.z + cz * FORT_R, ry = Math.atan2(-cx, -cz);   // local +Z looks inwards
      const ruined = cz > 0.3;
      const name = ruined ? ['wall_broken', 'rubble_large', 'wall_cracked'][i % 3] : ['wall', 'wall_pillar', 'wall_cracked', 'wall'][i % 4];
      put(name, x, z, ry, name === 'rubble_large' ? S * 0.5 : S);
      for (const t of [-2, 0, 2]) solid(x - cz * t * S, z + cx * t * S, 1.15);
      if (ruined) continue;
      const ix = x - cx * 0.85, iz = z - cz * 0.85;   // just inside the wall face
      if (i % 2) {
        put(i % 4 === 1 ? 'banner_red' : 'sword_shield_gold', i % 4 === 1 ? x : ix, i % 4 === 1 ? z : iz, ry, S, i % 4 === 1 ? 0 : 3.6);
      } else {
        put('torch_mounted', ix, iz, ry, 1.7, 3.3);
        flames.push({ x: ix - cx * 0.75, y: 4.5, z: iz - cz * 0.75, s: 1.5 });
      }
    }
    for (const side of [-1, 1]) {   // gate posts
      const a = Math.PI / 2 + side * 0.41, x = BOSS.x + Math.cos(a) * FORT_R, z = BOSS.z + Math.sin(a) * FORT_R;
      put('pillar_decorated', x, z, 0, 1.7);
      solid(x, z, 1.5);
      flames.push({ x, y: 7.4, z, s: 2 });
      put(side < 0 ? 'barrel_large' : 'crates_stacked', x + side * 4, z + 3.5, side, 1);
      solid(x + side * 4, z + 3.5, 1);
    }
    for (let i = 0; i < 8; i++) {   // inner colonnade around the King
      const a = (i + 0.5) / 8 * Math.PI * 2, x = BOSS.x + Math.cos(a) * 15, z = BOSS.z + Math.sin(a) * 15;
      put('pillar', x, z, a, 1.5);
      solid(x, z, 1.1);
    }
    const hoard = CHESTS.find((c) => c.big);   // gold piled around the King's chest
    put('coin_stack_large', hoard.x - 2.6, hoard.z + 0.4, 0.5, 1.2);
    put('coin_stack_medium', hoard.x + 2.5, hoard.z + 0.2, 2, 1.3);
    put('coin_stack_small', hoard.x + 1.2, hoard.z + 2.2, 4, 1.3);
    put('coin_stack_small', hoard.x - 1.5, hoard.z + 2, 1, 1.1);
    put('sword_shield_broken', hoard.x - 4.5, hoard.z + 1, 0.4, 1.3, 1);

    for (const [name, items] of Object.entries(batch)) many(name, items);
    addHalos(flames, 0xff7030);

    // ruins scattered over the cursed lands
    many('pillar', scatter(60, Z2, WORLD_R - 6, { sMin: 0.9, sMax: 1.5 }), 0.9);
    many('wall_broken', scatter(24, Z2 + 6, WORLD_R - 10, { sMin: 1, sMax: 1.4, road: 6 }), 0.6);
    many('wall_cracked', scatter(14, Z2 + 6, WORLD_R - 10, { sMin: 1, sMax: 1.4, road: 6 }), 0.6);
    many('rubble_large', scatter(16, Z2 + 6, WORLD_R - 10, { sMin: 0.5, sMax: 0.8, road: 8 }), 0.5);
    many('rubble_half', scatter(20, Z1 + 20, WORLD_R - 10, { sMin: 0.6, sMax: 1, road: 6 }), 0.5);
  }

  // Loads a pack of glTF models. A pack shares one palette texture, so one material serves all its models.
  // `scale` converts the pack's units to world units.
  async function loadPack(dir, names, scale, ext = 'gltf') {
    const loader = new GLTFLoader();
    const geo = {}, radius = {};
    let material = null;
    await Promise.all(names.map(async (name) => {
      const gltf = await loader.loadAsync(`${dir}${name}.${ext}`);
      // gate models ship with their doors shut; swing both leaves open so the passage reads as passable
      gltf.scene.traverse((o) => {
        if (o.name.endsWith('_door_left')) o.rotation.y = 1.4;
        if (o.name.endsWith('_door_right')) o.rotation.y = -1.4;
      });
      gltf.scene.updateMatrixWorld(true);
      const parts = [];
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        material ||= o.material;
        parts.push(o.geometry.clone().applyMatrix4(o.matrixWorld));
      });
      const g = (parts.length > 1 && mergeGeometries(parts)) || parts[0];
      g.computeBoundingBox();
      const b = g.boundingBox;
      geo[name] = g;
      radius[name] = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) / 2;   // footprint radius at scale 1
    }));

    // one object; `solid` is the share of its footprint that blocks movement
    function place(name, x, z, { s = 1, ry = 0, solid = 0 } = {}) {
      const mesh = new THREE.Mesh(geo[name], material);
      mesh.position.set(x, 0, z);
      mesh.rotation.y = ry;
      mesh.scale.setScalar(s * scale);
      mesh.castShadow = mesh.receiveShadow = true;
      scene.add(mesh);
      if (solid) obstacles.push({ x, z, r: radius[name] * s * scale * solid });
      return mesh;
    }
    // many copies of one model in a single draw call
    const many = (name, items, solid = 0, cast = true) => instanced(geo[name], items.map((it) => ({ ...it, s: it.s * scale })), {
      mat: material, cast, solid: solid * radius[name],
    });
    return { place, many };
  }

  async function addModels() {
    const names = [
      'building_home_A_blue', 'building_home_B_blue', 'building_home_A_red', 'building_home_B_red', 'building_home_A_green', 'building_home_B_green',
      'building_tavern_blue', 'building_market_blue', 'building_blacksmith_blue', 'building_church_blue', 'building_well_blue',
      'building_windmill_blue', 'building_tower_A_blue', 'building_destroyed', 'building_grain', 'building_stage_A',
      'fence_stone_straight', 'fence_wood_straight', 'wall_straight', 'wall_straight_gate',
      'tree_single_A', 'tree_single_B', 'tree_single_A_cut', 'tree_single_B_cut',
      'trees_A_large', 'trees_A_medium', 'trees_A_small', 'trees_B_large', 'trees_B_medium', 'trees_B_small',
      'rock_single_A', 'rock_single_B', 'rock_single_C', 'rock_single_D', 'rock_single_E',
      'hill_single_A', 'hill_single_B', 'hill_single_C',
      'mountain_A', 'mountain_B', 'mountain_C', 'mountain_A_grass', 'mountain_B_grass', 'mountain_C_grass',
      'barrel', 'crate_A_big', 'crate_B_small', 'crate_open', 'sack', 'tent', 'weaponrack', 'wheelbarrow', 'flag_blue', 'target',
      'bucket_water', 'resource_lumber', 'resource_stone',
    ];
    const { place, many } = await loadPack(MODEL_DIR, names, MODEL_SCALE);

    // town: buildings around the plaza, doors towards the fountain
    // low buildings on the south side (nearer the camera), tall ones on the north, so the plaza stays visible
    const TOWN = ['building_home_A_red', 'building_market_blue', 'building_blacksmith_blue', 'building_home_A_blue',
      'building_home_B_green', 'building_church_blue', 'building_tavern_blue', 'building_home_B_red'];
    const PROPS = ['barrel', 'crate_A_big', 'sack', 'crate_open', 'bucket_water', 'weaponrack', 'wheelbarrow', 'resource_lumber',
      'crate_B_small', 'target', 'resource_stone', 'barrel', 'flag_blue', 'crate_A_big', 'barrel', 'sack'];
    TOWN.forEach((name, i) => {
      const a = (i + 0.5) / 8 * Math.PI * 2, x = Math.cos(a) * 17.5, z = Math.sin(a) * 17.5;
      place(name, x, z, { s: 1.25, ry: Math.atan2(-x, -z), solid: 0.8 });
      for (const [k, side] of [[0, -1], [1, 1]]) {   // clutter beside each building
        const pa = a + side * 0.36, pr = 13.5 + k * 2;
        place(PROPS[i * 2 + k], Math.cos(pa) * pr, Math.sin(pa) * pr, { ry: a * 3 + k });
      }
    });

    // town wall with a gate on each road
    const segLen = 2 * Math.PI * WALL_R / WALL_SEGMENTS, ws = segLen / 2 / MODEL_SCALE;   // wall models are 2 units long
    for (let i = 0; i < WALL_SEGMENTS; i++) {
      const a = i / WALL_SEGMENTS * Math.PI * 2, x = Math.cos(a) * WALL_R, z = Math.sin(a) * WALL_R, gate = i % 7 === 0;
      place(gate ? 'wall_straight_gate' : 'wall_straight', x, z, { s: ws, ry: Math.PI / 2 - a });
      const tx = -Math.sin(a), tz = Math.cos(a);
      if (gate) {   // only the gate posts block the way
        for (const t of [-0.38, 0.38]) obstacles.push({ x: x + tx * t * segLen, z: z + tz * t * segLen, r: 0.9 });
        continue;
      }
      for (const t of [-0.34, 0, 0.34]) obstacles.push({ x: x + tx * t * segLen, z: z + tz * t * segLen, r: 1.25 });
    }

    for (const [name, x, z, s, ry] of LANDMARKS) place(name, x, z, { s, ry, solid: name === 'building_grain' || name === 'building_stage_A' ? 0 : 0.75 });
    for (const [x, z] of [[33, 5], [34.5, 3], [36, 0], [-33, 6], [13, 33], [15, 35]]) place(PROPS[Math.abs(x + z) % 8 | 0], x, z, { ry: x });

    // meadows: single trees, groves, stumps, rocks, hills
    many('tree_single_A', scatter(320, TOWN_R + 6, Z1 + 4, { sMin: 0.85, sMax: 1.35 }), 0.3);
    many('tree_single_B', scatter(240, TOWN_R + 6, Z1 - 2, { sMin: 0.85, sMax: 1.35 }), 0.3);
    for (const name of ['trees_A_large', 'trees_A_medium', 'trees_A_small', 'trees_B_large', 'trees_B_medium', 'trees_B_small']) {
      many(name, scatter(9, TOWN_R + 14, Z1 - 6, { sMin: 0.9, sMax: 1.2, road: 9 }), 0.7);
    }
    many('tree_single_A_cut', scatter(70, TOWN_R + 6, Z2, { sMin: 0.9, sMax: 1.3 }));
    many('tree_single_B_cut', scatter(70, TOWN_R + 6, Z2, { sMin: 0.9, sMax: 1.3 }));
    for (const name of ['hill_single_A', 'hill_single_B', 'hill_single_C']) many(name, scatter(9, TOWN_R + 18, Z1, { sMin: 1.1, sMax: 1.8, road: 8 }), 0.75);
    for (const name of ['mountain_A_grass', 'mountain_B_grass', 'mountain_C_grass']) many(name, scatter(2, 55, Z1 - 8, { sMin: 1.2, sMax: 1.5, road: 12 }), 0.8);

    // rocks everywhere, ruins and bare mountains further out
    for (const name of ['rock_single_A', 'rock_single_B', 'rock_single_C', 'rock_single_D', 'rock_single_E']) {
      many(name, scatter(45, TOWN_R + 6, Z1, { sMin: 1.2, sMax: 2.4 }), 0.8);
      many(name, scatter(70, Z1, WORLD_R - 3, { sMin: 1.4, sMax: 3 }), 0.8);
    }
    many('building_destroyed', scatter(14, Z1 + 4, Z2 - 4, { sMin: 0.8, sMax: 1.1, road: 7 }), 0.75);
    many('building_destroyed', scatter(12, Z2 + 4, WORLD_R - 12, { sMin: 0.9, sMax: 1.3, road: 7 }), 0.75);
    many('fence_stone_straight', scatter(60, Z1, Z2, { sMin: 0.9, sMax: 1.1 }), 0.5);
    many('fence_wood_straight', scatter(40, TOWN_R + 8, Z1, { sMin: 0.9, sMax: 1.1 }), 0.5);
    many('mountain_A', scatter(4, Z1 + 12, Z2 - 10, { sMin: 1.2, sMax: 1.6, road: 12 }), 0.8);
    for (const name of ['mountain_A', 'mountain_B', 'mountain_C']) many(name, scatter(5, Z2 + 8, WORLD_R - 14, { sMin: 1.3, sMax: 1.9, road: 12 }), 0.8);
  }
  const ready = Promise.all([addModels(), addGraveyard(), addFortress()]);

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

  return { update, collide, ready, plots: PLOTS, block: (x, z, r) => obstacles.push({ x, z, r }) };
}
