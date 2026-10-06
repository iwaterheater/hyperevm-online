// Bakes the world the game used to generate in code into a map file: the terrain formula, the seeded scenery, the
// hand-built town, graveyard and fortress, the roadside chests, the townsfolk and the monster zones.
// This is how map/world.json was BORN, not how it is maintained - afterwards the map is edited in the map editor.
// So the bake never overwrites a file that differs from its own output unless it is told to.
// Run: node tools/bake-map.mjs [--out <path>] [--force]
//   --out <path>  the file to write (default: map/world.json of this repository, wherever the script is run from)
//   --force       overwrite a target whose content differs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MOB_TYPES } from '../src/shared.js';
import { FORMAT_VERSION, GROUND_INDEX, cellXZ, quantizeItem, serialize, spawnCount, stringifyMap, validate } from '../src/map/format.js';
import { MODELS, PACKS } from '../src/map/catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- the old world constants

// Own copies: src/shared.js loses these once the game reads the map, and the bake has to keep running after that.
const WORLD_R = 260;
const TOWN_R = 24;
const BOSS = { x: 0, z: -228, lvl: 18 };
const FORT_R = 26;   // radius of the Skeleton King's fortress wall
const BLACKSMITH = { x: -4.8, z: 11.5 };
const SAGE = { x: 4.2, z: -4.6 };

// One seamless world: concentric zones around the town, harder the further out you go.
// types: the weighted list monsters were rolled from. camp: how many monsters share one camp, [min, max].
const ZONES = [
  { r: TOWN_R, name: 'Hypercat Town', mood: 'meadow', safe: true },
  { r: 95, name: 'Green Meadows', mood: 'meadow', lvl: [1, 4], mobs: 110, types: ['chaser', 'chaser', 'chaser', 'runner', 'runner'], camp: [2, 4] },
  { r: 175, name: 'Graveyard Wastes', mood: 'graveyard', lvl: [5, 9], mobs: 130, types: ['chaser', 'runner', 'shooter', 'shooter'], camp: [3, 6] },
  { r: WORLD_R, name: 'Cursed Lands', mood: 'cursed', lvl: [10, 15], mobs: 150, types: ['chaser', 'runner', 'shooter', 'tank', 'tank'], camp: [3, 6] },
];
const Z1 = ZONES[1].r, Z2 = ZONES[2].r;

// Treasure chests: beside the four roads, richer the further from town, plus the King's hoard in the fortress.
const CHESTS = [];
for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
  let side = 1;
  for (let r = 46; r < WORLD_R - 12; r += 24) {
    side = -side;
    const x = dx * r + dz * side * 4.6, z = dz * r + dx * side * 4.6;
    if (Math.hypot(x - BOSS.x, z - BOSS.z) < FORT_R + 10) continue;
    CHESTS.push({ x, z, gold: r < Z1 ? 12 : r < Z2 ? 40 : 90 });
  }
}
CHESTS.push({ x: BOSS.x, z: BOSS.z - FORT_R + 6, gold: 400, big: true });

// ---------------------------------------------------------------- helpers

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// The scenery is generated from a fixed seed. The client drew from this sequence in whatever order its three model packs
// arrived, so the layout changed between page loads; the bake fixes ONE order: the order of this file.
let seed = 1337;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

// landmarks placed by hand; scattered scenery keeps clear of them
const keepOut = [{ x: BOSS.x, z: BOSS.z, r: FORT_R + 8 }, ...CHESTS.map((c) => ({ x: c.x, z: c.z, r: 2.5 }))];

// Random spots in the ring rMin..rMax, off the roads. Four numbers are drawn per spot whether or not it is kept,
// so what a call rejects never shifts the sequence for the calls after it.
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

// One scenery object in runtime form. What it blocks, whether it glows and how far it is lifted are NOT baked:
// the catalog answers that when the map is loaded. `col` and `y` are set only where a piece differs from its model.
const objects = [];
function put(m, x, z, { ry = 0, s = 1, y = 0, col = null, g = null } = {}) {
  if (!Object.hasOwn(MODELS, m)) throw new Error(`bake: the model catalog does not list "${m}"`);
  objects.push(quantizeItem('object', { m, x, y, z, rx: 0, ry, rz: 0, s, sy: 1, col, g }));
}
// scattered copies of one model
const many = (m, items) => { for (const it of items) put(m, it.x, it.z, { ry: it.ry, s: it.s }); };
// local (lx, lz) of an object at (ox, oz) turned by ry -> world
const at = (ox, oz, ry, lx, lz) => [ox + lx * Math.cos(ry) + lz * Math.sin(ry), oz - lx * Math.sin(ry) + lz * Math.cos(ry)];
// a collider of circles of radius r along a piece's local X, in model units
const row = (r, ...xs) => xs.map((x) => ({ x, z: 0, r }));

// ---------------------------------------------------------------- ground

// The terrain was a 560-unit plane with a vertex every 2 units, coloured by a formula. Each vertex takes the ground
// type whose colour dominates that formula there; the map view softens the borders again.
const ground = { cell: 2, size: 281, cells: new Uint8Array(281 * 281) };
for (let i = 0; i < ground.cells.length; i++) {
  const { x, z } = cellXZ(ground, i), r = Math.hypot(x, z);
  const n = noise(x * 0.08, z * 0.08) * 0.6 + noise(x * 0.31, z * 0.31) * 0.4;
  const rr = r + (noise(x * 0.05 + 40, z * 0.05) - 0.5) * 16;   // wobble the zone borders
  const t1 = smooth(Z1 - 6, Z1 + 6, rr), t2 = smooth(Z2 - 6, Z2 + 6, rr);
  const onRoad = 1 - smooth(1.4, 3.0, Math.min(Math.abs(x), Math.abs(z)) + (n - 0.5) * 1.6);
  let type = 'grass';
  if (r > WORLD_R - 2) type = 'sand';                     // the beach
  else if (r < TOWN_R - 1) type = 'paving';
  else if (onRoad >= 0.5) type = t2 >= 0.5 ? 'dirt_dark' : 'dirt';
  else if (t2 >= 0.5) type = 'ash';
  else if (t1 >= 0.5) type = 'dust';
  ground.cells[i] = GROUND_INDEX[type];
}

// ---------------------------------------------------------------- town plaza, meadows, cursed lands

put('builtin/fountain', 0, 0, { g: 'town' });
put('builtin/crystal', 0, 0, { g: 'town' });
for (let i = 0; i < 8; i++) {   // lamp posts
  const a = i / 8 * Math.PI * 2 + 0.2;
  put('builtin/lamp_post', Math.cos(a) * 6.5, Math.sin(a) * 6.5, { g: 'town' });
}

many('builtin/bush', scatter(260, TOWN_R + 6, Z1));
// Grass tufts and flowers are not objects any more: they grow by themselves on every grass vertex.
// The two calls are still made, and their spots thrown away, so everything after them gets the numbers it always got.
scatter(4200, TOWN_R + 4, Z1 + 6, { sMin: 0.7, sMax: 1.5, road: 2.6 });
scatter(1100, TOWN_R + 4, Z1, { road: 2.6 });

many('builtin/spike', scatter(620, Z2 - 2, WORLD_R - 2, { sMin: 0.7, sMax: 1.9 }));
many('builtin/red_crystal', scatter(260, Z2, WORLD_R - 2, { sMin: 0.5, sMax: 1.4 }));

// the red circle in the middle of the King's fortress
put('builtin/lair_ring', BOSS.x, BOSS.z, { g: 'fortress' });

// ---------------------------------------------------------------- hand-placed sites

// [model, x, z, scale, ry]
const LANDMARKS = [
  ['building_windmill_blue', 36, -32, 1.2, 0.6], ['building_grain', 46, -34, 1, 0], ['building_grain', 37, -43, 1, 1.57],
  ['building_well_blue', -9, -34, 0.8, 0], ['building_stage_A', 11, 35, 1.2, 3.14],
  ['tent', 35, 9, 1.4, -1.2], ['tent', 37, -8, 1.4, -1.9], ['tent', -35, 10, 1.4, 1.3],
  ['building_tower_A_blue', 7, -62, 1, 0], ['building_tower_A_blue', 62, 7, 1, 1.57],
  ['building_tower_A_blue', -7, 62, 1, 3.14], ['building_tower_A_blue', -62, -7, 1, -1.57],
];
for (const [, x, z] of LANDMARKS) keepOut.push({ x, z, r: 8 });

// [x, z, ry]
const CRYPTS = [[40, -128, 0.3], [-46, 122, 3.4], [130, 40, -1.3], [-127, -44, 1.8], [96, 98, -0.8], [-99, -94, 2.4]];
for (const [x, z] of CRYPTS) keepOut.push({ x, z, r: 12 });
const PLOTS = scatter(18, Z1 + 14, Z2 - 14, { road: 17 });   // fenced cemeteries
for (const p of PLOTS) keepOut.push({ x: p.x, z: p.z, r: 13 });

// ---------------------------------------------------------------- medieval pack: the town and the meadows

{
  // town: buildings around the plaza, doors towards the fountain
  // low buildings on the south side (nearer the camera), tall ones on the north, so the plaza stays visible
  const TOWN = ['building_home_A_red', 'building_market_blue', 'building_blacksmith_blue', 'building_home_A_blue',
    'building_home_B_green', 'building_church_blue', 'building_tavern_blue', 'building_home_B_red'];
  const PROPS = ['barrel', 'crate_A_big', 'sack', 'crate_open', 'bucket_water', 'weaponrack', 'wheelbarrow', 'resource_lumber',
    'crate_B_small', 'target', 'resource_stone', 'barrel', 'flag_blue', 'crate_A_big', 'barrel', 'sack'];
  TOWN.forEach((name, i) => {
    const a = (i + 0.5) / 8 * Math.PI * 2, x = Math.cos(a) * 17.5, z = Math.sin(a) * 17.5;
    put(`medieval/${name}`, x, z, { s: 1.25, ry: Math.atan2(-x, -z), g: 'town' });
    for (const [k, side] of [[0, -1], [1, 1]]) {   // clutter beside each building
      const pa = a + side * 0.36, pr = 13.5 + k * 2;
      put(`medieval/${PROPS[i * 2 + k]}`, Math.cos(pa) * pr, Math.sin(pa) * pr, { ry: a * 3 + k, g: 'town' });
    }
  });

  // town wall with a gate on each road
  const WALL_R = TOWN_R + 1.6, WALL_SEGMENTS = 28;
  const ws = 2 * Math.PI * WALL_R / WALL_SEGMENTS / 2 / PACKS.medieval.scale;   // wall models are 2 units long
  for (let i = 0; i < WALL_SEGMENTS; i++) {
    const a = i / WALL_SEGMENTS * Math.PI * 2, gate = i % 7 === 0;
    put(gate ? 'medieval/wall_straight_gate' : 'medieval/wall_straight', Math.cos(a) * WALL_R, Math.sin(a) * WALL_R,
      { s: ws, ry: Math.PI / 2 - a, g: 'town-wall' });
  }

  for (const [name, x, z, s, ry] of LANDMARKS) put(`medieval/${name}`, x, z, { s, ry });
  for (const [x, z] of [[33, 5], [34.5, 3], [36, 0], [-33, 6], [13, 33], [15, 35]]) put(`medieval/${PROPS[Math.abs(x + z) % 8 | 0]}`, x, z, { ry: x });

  // meadows: single trees, groves, stumps, rocks, hills
  many('medieval/tree_single_A', scatter(320, TOWN_R + 6, Z1 + 4, { sMin: 0.85, sMax: 1.35 }));
  many('medieval/tree_single_B', scatter(240, TOWN_R + 6, Z1 - 2, { sMin: 0.85, sMax: 1.35 }));
  for (const name of ['trees_A_large', 'trees_A_medium', 'trees_A_small', 'trees_B_large', 'trees_B_medium', 'trees_B_small']) {
    many(`medieval/${name}`, scatter(9, TOWN_R + 14, Z1 - 6, { sMin: 0.9, sMax: 1.2, road: 9 }));
  }
  many('medieval/tree_single_A_cut', scatter(70, TOWN_R + 6, Z2, { sMin: 0.9, sMax: 1.3 }));
  many('medieval/tree_single_B_cut', scatter(70, TOWN_R + 6, Z2, { sMin: 0.9, sMax: 1.3 }));
  for (const name of ['hill_single_A', 'hill_single_B', 'hill_single_C']) many(`medieval/${name}`, scatter(9, TOWN_R + 18, Z1, { sMin: 1.1, sMax: 1.8, road: 8 }));
  for (const name of ['mountain_A_grass', 'mountain_B_grass', 'mountain_C_grass']) many(`medieval/${name}`, scatter(2, 55, Z1 - 8, { sMin: 1.2, sMax: 1.5, road: 12 }));

  // rocks everywhere, ruins and bare mountains further out
  for (const name of ['rock_single_A', 'rock_single_B', 'rock_single_C', 'rock_single_D', 'rock_single_E']) {
    many(`medieval/${name}`, scatter(45, TOWN_R + 6, Z1, { sMin: 1.2, sMax: 2.4 }));
    many(`medieval/${name}`, scatter(70, Z1, WORLD_R - 3, { sMin: 1.4, sMax: 3 }));
  }
  many('medieval/building_destroyed', scatter(14, Z1 + 4, Z2 - 4, { sMin: 0.8, sMax: 1.1, road: 7 }));
  many('medieval/building_destroyed', scatter(12, Z2 + 4, WORLD_R - 12, { sMin: 0.9, sMax: 1.3, road: 7 }));
  many('medieval/fence_stone_straight', scatter(60, Z1, Z2, { sMin: 0.9, sMax: 1.1 }));
  many('medieval/fence_wood_straight', scatter(40, TOWN_R + 8, Z1, { sMin: 0.9, sMax: 1.1 }));
  many('medieval/mountain_A', scatter(4, Z1 + 12, Z2 - 10, { sMin: 1.2, sMax: 1.6, road: 12 }));
  for (const name of ['mountain_A', 'mountain_B', 'mountain_C']) many(`medieval/${name}`, scatter(5, Z2 + 8, WORLD_R - 14, { sMin: 1.3, sMax: 1.9, road: 12 }));
}

// ---------------------------------------------------------------- halloween pack: the graveyard wastes

{
  // autumn pines where the meadows give way to the wastes, dead trees beyond
  for (const name of ['tree_pine_orange_large', 'tree_pine_orange_medium', 'tree_pine_orange_small',
    'tree_pine_yellow_large', 'tree_pine_yellow_medium', 'tree_pine_yellow_small']) {
    many(`halloween/${name}`, scatter(42, Z1 - 18, Z1 + 16, { sMin: 0.8, sMax: 1.25 }));
  }
  many('halloween/tree_dead_large', scatter(150, Z1, Z2 + 6, { sMin: 1, sMax: 1.6 }));
  many('halloween/tree_dead_medium', scatter(150, Z1, Z2 + 6, { sMin: 1, sMax: 1.6 }));
  many('halloween/tree_dead_small', scatter(120, Z1 - 6, WORLD_R - 6, { sMin: 1, sMax: 1.6 }));
  many('halloween/tree_dead_large_decorated', scatter(30, Z1, Z2, { sMin: 1, sMax: 1.4 }));

  // loose graves, coffins, bones and pumpkins
  for (const name of ['grave_A', 'grave_B', 'grave_A_destroyed']) many(`halloween/${name}`, scatter(65, Z1, Z2));
  many('halloween/gravestone', scatter(120, Z1, Z2));
  many('halloween/gravemarker_A', scatter(90, Z1 - 4, Z2 + 4));
  many('halloween/gravemarker_B', scatter(90, Z1 - 4, Z2 + 4));
  many('halloween/coffin', scatter(16, Z1, Z2));
  many('halloween/coffin_decorated', scatter(10, Z1, Z2));
  // bones and ribcages get no height: the catalog lifts them, so they rest on the ground at any scale
  for (const name of ['bone_A', 'bone_B', 'bone_C']) many(`halloween/${name}`, scatter(110, Z1 - 6, WORLD_R - 4));
  many('halloween/skull', scatter(90, Z1 - 6, WORLD_R - 4, { sMin: 0.5, sMax: 0.8 }));
  many('halloween/ribcage', scatter(45, Z1, WORLD_R - 4));
  for (const name of ['pumpkin_orange', 'pumpkin_orange_jackolantern', 'pumpkin_orange_small',
    'pumpkin_yellow', 'pumpkin_yellow_jackolantern', 'pumpkin_yellow_small']) {
    many(`halloween/${name}`, scatter(12, Z1, Z2));
  }

  // fenced cemeteries: 20 x 12, a gap in the south fence, two rows of graves inside
  const GRAVES = ['grave_A', 'grave_B', 'grave_A_destroyed', 'grave_B', 'grave_A'];
  PLOTS.forEach((p, n) => {
    const g = `plot-${String(n + 1).padStart(2, '0')}`;
    const L = (lx, lz) => at(p.x, p.z, p.ry, lx, lz);
    const fence = (lx, lz, turn) => put(rnd() < 0.2 ? 'halloween/fence_broken' : 'halloween/fence', ...L(lx, lz), { ry: p.ry + turn, g });
    for (const lx of [-8, -4, 0, 4, 8]) {
      fence(lx, -6, 0);
      if (lx !== 0) fence(lx, 6, 0);
    }
    for (const lz of [-4, 0, 4]) { fence(-10, lz, Math.PI / 2); fence(10, lz, Math.PI / 2); }
    for (const [lx, lz] of [[-10, -6], [10, -6], [-10, 6], [10, 6], [-2, 6], [2, 6]]) {
      put(rnd() < 0.15 ? 'halloween/fence_pillar_broken' : 'halloween/fence_pillar', ...L(lx, lz), { ry: p.ry, g });
    }
    for (const lz of [-3.2, 2]) {
      [-7, -3.5, 0, 3.5, 7].forEach((lx, i) => put(`halloween/${GRAVES[(i + (lz > 0 ? 2 : 0)) % GRAVES.length]}`, ...L(lx, lz), { ry: p.ry, g }));
    }
    put('halloween/plaque_candles', ...L(0, -0.6), { ry: p.ry, g });
    put('halloween/lantern_standing', ...L(-3.2, 7.3), { g });
    put('halloween/lantern_standing', ...L(3.2, 7.3), { g });
    // decoration by the fence: it never blocked the way, although loose pumpkins of this model do
    if (rnd() < 0.6) put('halloween/pumpkin_orange_jackolantern', ...L(8.3, 4.3), { ry: p.ry + 0.4, col: 0, g });
  });

  // crypts with pillars, candles and lanterns at the front
  CRYPTS.forEach(([x, z, ry], n) => {
    const g = `crypt-${n + 1}`;
    put('halloween/crypt', x, z, { ry, g });
    for (const lx of [-4.6, 4.6]) {
      for (const lz of [5.6, -5.6]) put('halloween/pillar', ...at(x, z, ry, lx, lz), { ry, g });
      put('halloween/lantern_standing', ...at(x, z, ry, lx * 0.5, 6.2), { g });
      put('halloween/skull_candle', ...at(x, z, ry, lx * 0.8, 7.4), { ry: ry + lx, g });
    }
    put('halloween/shrine_candles', ...at(x, z, ry, 0, 8.2), { ry, g });
  });

  // roads: an arch at each zone border, lantern posts through the wastes, skull posts through the cursed lands
  for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    const turn = dx ? Math.PI / 2 : 0;   // arches span the road
    for (const r of [Z1 + 2, Z2 + 2]) put('halloween/arch', dx * r, dz * r, { ry: turn, s: 1.7 });
    let side = 1;
    for (let r = Z1 + 12; r < WORLD_R - 16; r += 14) {
      if (Math.abs(r - Z2) < 8 || Math.hypot(dx * r - BOSS.x, dz * r - BOSS.z) < 20) continue;
      side = -side;
      const ry = Math.atan2(-dz * side, -dx * side);   // the arm (local +Z) reaches over the road
      put(r < Z2 ? 'halloween/post_lantern' : 'halloween/post_skull', dx * r + dz * side * 3.8, dz * r + dx * side * 3.8, { ry });
    }
  }

  // loose lanterns, all one size
  for (const it of scatter(60, Z1, Z2)) put('halloween/lantern_standing', it.x, it.z, { ry: it.ry });
}

// ---------------------------------------------------------------- dungeon pack: the Skeleton King's fortress, cursed-land ruins

{
  const g = 'fortress';
  // The catalog gives a ruined wall one round collider, which is right for a loose ruin but would leave gaps a cat walks
  // through here: in the ring these pieces block along their whole length, like the intact walls beside them.
  const RING_COL = { wall_broken: [0.77, -2, 0, 2], wall_cracked: [0.77, -2, 0, 2], rubble_large: [1.53, -4, 0, 4] };

  // ring wall: intact with banners and torches in the north, ruined towards the gate in the south
  const S = 1.5, N = Math.round(2 * Math.PI * FORT_R / (4 * S));
  for (let i = 0; i < N; i++) {
    const a = i / N * Math.PI * 2, cx = Math.cos(a), cz = Math.sin(a);
    if (cz > 0.94) continue;   // the gate faces the road from town
    const x = BOSS.x + cx * FORT_R, z = BOSS.z + cz * FORT_R, ry = Math.atan2(-cx, -cz);   // local +Z looks inwards
    const ruined = cz > 0.3;
    const name = ruined ? ['wall_broken', 'rubble_large', 'wall_cracked'][i % 3] : ['wall', 'wall_pillar', 'wall_cracked', 'wall'][i % 4];
    put(`dungeon/${name}`, x, z, { ry, s: name === 'rubble_large' ? S * 0.5 : S, col: RING_COL[name] ? row(...RING_COL[name]) : null, g });
    if (ruined) continue;
    const ix = x - cx * 0.85, iz = z - cz * 0.85;   // just inside the wall face
    if (i % 4 === 1) put('dungeon/banner_red', x, z, { ry, s: S, g });
    else if (i % 2) put('dungeon/sword_shield_gold', ix, iz, { ry, s: S, y: 3.6, g });
    else put('dungeon/torch_mounted', ix, iz, { ry, s: 1.7, y: 3.3, g });
  }
  for (const side of [-1, 1]) {   // gate posts
    const a = Math.PI / 2 + side * 0.41, x = BOSS.x + Math.cos(a) * FORT_R, z = BOSS.z + Math.sin(a) * FORT_R;
    put('dungeon/pillar_decorated', x, z, { s: 1.7, g });
    put(side < 0 ? 'dungeon/barrel_large' : 'dungeon/crates_stacked', x + side * 4, z + 3.5, { ry: side, g });
  }
  for (let i = 0; i < 8; i++) {   // inner colonnade around the King; these pillars block a little wider than loose ones
    const a = (i + 0.5) / 8 * Math.PI * 2;
    put('dungeon/pillar', BOSS.x + Math.cos(a) * 15, BOSS.z + Math.sin(a) * 15, { ry: a, s: 1.5, col: row(0.73, 0), g });
  }
  const hoard = CHESTS.find((c) => c.big);   // gold piled around the King's chest
  put('dungeon/coin_stack_large', hoard.x - 2.6, hoard.z + 0.4, { ry: 0.5, s: 1.2, g });
  put('dungeon/coin_stack_medium', hoard.x + 2.5, hoard.z + 0.2, { ry: 2, s: 1.3, g });
  put('dungeon/coin_stack_small', hoard.x + 1.2, hoard.z + 2.2, { ry: 4, s: 1.3, g });
  put('dungeon/coin_stack_small', hoard.x - 1.5, hoard.z + 2, { ry: 1, s: 1.1, g });
  put('dungeon/sword_shield_broken', hoard.x - 4.5, hoard.z + 1, { ry: 0.4, s: 1.3, y: 1, g });

  // ruins scattered over the cursed lands
  many('dungeon/pillar', scatter(60, Z2, WORLD_R - 6, { sMin: 0.9, sMax: 1.5 }));
  many('dungeon/wall_broken', scatter(24, Z2 + 6, WORLD_R - 10, { sMin: 1, sMax: 1.4, road: 6 }));
  many('dungeon/wall_cracked', scatter(14, Z2 + 6, WORLD_R - 10, { sMin: 1, sMax: 1.4, road: 6 }));
  many('dungeon/rubble_large', scatter(16, Z2 + 6, WORLD_R - 10, { sMin: 0.5, sMax: 0.8, road: 8 }));
  many('dungeon/rubble_half', scatter(20, Z1 + 20, WORLD_R - 10, { sMin: 0.6, sMax: 1, road: 6 }));
}

// ---------------------------------------------------------------- regions, chests, townsfolk

// later regions win, so the zones are listed from the outside in
const regions = ZONES.map((zone) => ({
  name: zone.name, levels: zone.lvl ? [...zone.lvl] : null, mood: zone.mood, safe: zone.safe === true, color: null,
  shape: { type: 'circle', x: 0, z: 0, r: zone.r },
})).reverse();

// roadside chests face the road, the King's hoard faces the fortress gate; the order is the index clients know a chest by
const chests = CHESTS.map((c) => quantizeItem('chest', {
  x: c.x, z: c.z,
  ry: c.big ? 0 : Math.abs(c.x) < Math.abs(c.z) ? Math.atan2(-Math.sign(c.x), 0) : Math.atan2(0, -Math.sign(c.z)),
  gold: c.gold, big: c.big === true, respawn: c.big ? 300 : 150, g: c.big ? 'fortress' : null,
}));

// [kind, x, z, yaw]; guards stand in pairs just inside each gate, facing the plaza
const SPOTS = [
  ['blacksmith', BLACKSMITH.x, BLACKSMITH.z, Math.atan2(-BLACKSMITH.x, -BLACKSMITH.z)],
  ['trader', 4.8, 11.5, Math.atan2(-4.8, -11.5)],
  ['sage', SAGE.x, SAGE.z, Math.atan2(-SAGE.x, -SAGE.z)],
];
for (let i = 0; i < 4; i++) {
  const a = i * Math.PI / 2, r = TOWN_R - 1.8;
  for (const side of [-3.4, 3.4]) {
    const x = Math.cos(a) * r - Math.sin(a) * side, z = Math.sin(a) * r + Math.cos(a) * side;
    SPOTS.push(['guard', x, z, Math.atan2(-Math.cos(a), -Math.sin(a))]);
  }
}
const npcs = SPOTS.map(([kind, x, z, ry]) => quantizeItem('npc', { kind, x, z, ry, g: 'town' }));

// ---------------------------------------------------------------- monster camps

// The server used to drop every monster at a random point of its zone. A map holds camps instead: a disc that a few
// monsters call home. Each zone's population is dealt out into camps at random points of its ring, and a camp is as
// wide as that many monsters used to occupy (never under 10 units, nor over 16, so its levels stay close together).
// The level still rises with the distance from town: a camp's range is the old formula at its near and far edge.
const spawns = [];
for (let i = 1; i < ZONES.length; i++) {
  const zone = ZONES[i], [lMin, lMax] = zone.lvl, [cMin, cMax] = zone.camp;
  const lo = ZONES[i - 1].r + 4, hi = zone.r - 4, area = Math.PI * (hi * hi - lo * lo);
  const level = (d) => clamp(Math.round(lMin + (lMax - lMin) * (d - lo) / (hi - lo)), lMin, lMax);
  const types = {};   // the weighted list as weights
  for (const type of zone.types) {
    if (!Object.hasOwn(MOB_TYPES, type)) throw new Error(`bake: unknown monster type "${type}"`);
    types[type] = (types[type] || 0) + 1;
  }
  for (let left = zone.mobs; left > 0;) {
    const count = Math.min(left, cMin + Math.floor(rnd() * (cMax - cMin + 1)));
    const rc = clamp(Math.sqrt(count * area / (Math.PI * zone.mobs)), 10, 16);
    const a = rnd() * Math.PI * 2, d = Math.sqrt((lo + rc) * (lo + rc) + rnd() * ((hi - rc) * (hi - rc) - (lo + rc) * (lo + rc)));
    const x = Math.cos(a) * d, z = Math.sin(a) * d;
    if (Math.hypot(x - BOSS.x, z - BOSS.z) < FORT_R + 4 + rc) continue;   // the fortress belongs to the King
    spawns.push(quantizeItem('spawn', { types: { ...types }, lvl: [level(d - rc), level(d + rc)], x, z, r: rc, count, respawn: 14, g: null }));
    left -= count;
  }
}
spawns.push({ types: { boss: 1 }, lvl: [BOSS.lvl, BOSS.lvl], x: BOSS.x, z: BOSS.z, r: 0, count: 1, respawn: 90, g: 'fortress' });   // the Skeleton King, last

// ---------------------------------------------------------------- the map file

const map = {
  version: FORMAT_VERSION,
  name: 'Hypercat World',
  radius: WORLD_R,
  start: { x: 0, z: 6, r: 10 },   // where the menu cat stood, in front of the fountain
  foliage: true,
  fallback: { name: 'Open Sea', levels: null, mood: 'meadow' },
  regions, spawns, chests, npcs, ground, objects,
};
const text = stringifyMap(serialize(map));   // serialize throws, listing what is wrong, if the bake broke a rule of the format

let out = null, force = false;
for (let args = process.argv.slice(2), i = 0; i < args.length; i++) {
  if (args[i] === '--force') force = true;
  else if (args[i] === '--out' && i + 1 < args.length) out = args[++i];
  else {
    console.error('usage: node tools/bake-map.mjs [--out <path>] [--force]');
    process.exit(1);
  }
}
// the default is this repository's map wherever the script is run from; a path given with --out is taken as typed
const target = out === null ? path.join(ROOT, 'map', 'world.json') : path.resolve(out);
const name = out ?? 'map/world.json';
if (fs.existsSync(target)) {
  if (fs.readFileSync(target).equals(Buffer.from(text))) {
    console.log(`${name} is already the baked world: nothing to write`);
    process.exit(0);
  }
  // It may be the hand-edited world, and the bake keeps no backup.
  if (!force) {
    console.error(`${name} exists; pass --force to overwrite`);
    process.exit(1);
  }
}
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, text);
console.log(`${name}: ${objects.length} objects, ${spawnCount(map)} monsters in ${spawns.length} spawns, ${chests.length} chests, ${npcs.length} NPCs, `
  + `${PLOTS.length} cemetery plots, ${Math.round(Buffer.byteLength(text) / 1024)} KB`);
for (const w of validate(map)) console.log(`  warning ${w.code} ${w.path}: ${w.message}`);
