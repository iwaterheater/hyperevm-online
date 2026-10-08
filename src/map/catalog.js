// The model catalog: the asset packs and, for every model, what it is, what it blocks and whether it glows.
// Pure data and maths - no imports, no three, no DOM - so the server, the bake, the game and the editor read one table.

// A model id is 'pack/name'; its file is dir + name + '.' + ext, relative to the site root.
// scale: world units per model unit (P).
export const PACKS = {
  medieval:  { dir: 'assets/medieval/',  ext: 'gltf', scale: 5, label: 'Medieval' },    // modelled for small hex tiles
  halloween: { dir: 'assets/halloween/', ext: 'gltf', scale: 1, label: 'Graveyard' },
  dungeon:   { dir: 'assets/dungeon/',   ext: 'glb',  scale: 1, label: 'Dungeon' },
  forest:    { dir: 'assets/forest/',    ext: 'gltf', scale: 1, label: 'Forest' },
  builtin:   { dir: null, ext: null, scale: 1, label: 'Built-in' },                      // procedural geometry from src/map/builtin.js
};
export const BUILTIN = ['fountain', 'crystal', 'lamp_post', 'bush', 'spike', 'red_crystal', 'lair_ring',
  'grass_tuft', 'flower_white', 'flower_yellow', 'flower_pink', 'flower_violet'];
export const CATEGORIES = ['buildings', 'walls', 'trees', 'rocks', 'props', 'graves', 'lights', 'ruins', 'foliage', 'special'];
export const MODEL_ALIASES = {};   // renamed or removed model id -> current id (applied when a map is loaded)

// ---------------------------------------------------------------- model table

// MODELS[id] = { col, cat, glow?, cast?, lift?, hidden? }. Lengths are in MODEL units: multiply by pack scale and object scale.
// col: what blocks movement -
//     0 nothing | a number: one circle at the origin, that share of the footprint radius (half the larger horizontal extent)
//     | 'box': the horizontal bounding box | [{ x, z, r }]: circles
// cat: palette category. glow: { y, x?, z?, s?, color? } - a halo at that point (lantern and torch models do not shine by themselves).
// cast: false - no shadow. lift: raises a model whose origin is at its centre, so it rests on the ground at any scale.
// hidden: not offered by the palette, but still drawn when a map uses it.
// A file that is missing here still works with the pack defaults and the 'auto' collider (see colliderOf).
export const MODELS = {};
function add(pack, cat, col, names, extra) {
  for (const name of names) MODELS[`${pack}/${name}`] = { col, cat, ...extra };
}
// circles of radius r along the model's local X: wall pieces run that way
const row = (r, ...xs) => xs.map((x) => ({ x, z: 0, r }));

// ---- medieval (P = 5): KayKit Medieval Hexagon Pack. A house is under one model unit wide.
add('medieval', 'buildings', 0.8, ['building_home_A_blue', 'building_home_A_green', 'building_home_A_red',
  'building_home_B_blue', 'building_home_B_green', 'building_home_B_red',
  'building_market_blue', 'building_blacksmith_blue', 'building_church_blue', 'building_tavern_blue']);
add('medieval', 'buildings', 0.75, ['building_windmill_blue', 'building_well_blue', 'building_tower_A_blue', 'tent']);
add('medieval', 'buildings', 0, ['building_grain', 'building_stage_A']);   // low and open: walk-through
add('medieval', 'ruins', 0.75, ['building_destroyed']);
add('medieval', 'walls', row(0.435, -0.68, 0, 0.68), ['wall_straight']);   // 2.0 x 0.8
add('medieval', 'walls', row(0.313, -0.76, 0.76), ['wall_straight_gate']);   // only the posts block: the doors stand open
// hex-edge pieces: the geometry sits one unit off the origin (x about -1), where a circle at the origin would miss it
add('medieval', 'walls', 'box', ['fence_stone_straight', 'fence_wood_straight']);
add('medieval', 'trees', 0.3, ['tree_single_A', 'tree_single_B']);
add('medieval', 'trees', 0, ['tree_single_A_cut', 'tree_single_B_cut']);   // stumps
add('medieval', 'trees', 0.7, ['trees_A_large', 'trees_A_medium', 'trees_A_small', 'trees_B_large', 'trees_B_medium', 'trees_B_small']);   // groves
add('medieval', 'rocks', 0.8, ['rock_single_A', 'rock_single_B', 'rock_single_C', 'rock_single_D', 'rock_single_E']);
add('medieval', 'rocks', 0.75, ['hill_single_A', 'hill_single_B', 'hill_single_C']);
add('medieval', 'rocks', 0.8, ['mountain_A', 'mountain_B', 'mountain_C', 'mountain_A_grass', 'mountain_B_grass', 'mountain_C_grass']);
add('medieval', 'props', 0, ['barrel', 'bucket_water', 'crate_A_big', 'crate_B_small', 'crate_open', 'flag_blue',
  'resource_lumber', 'resource_stone', 'sack', 'target', 'weaponrack', 'wheelbarrow']);

// ---- halloween (P = 1): KayKit Halloween Bits, the graveyard
add('halloween', 'trees', 0.2, ['tree_pine_orange_large', 'tree_pine_orange_medium', 'tree_pine_orange_small',
  'tree_pine_yellow_large', 'tree_pine_yellow_medium', 'tree_pine_yellow_small']);   // wide crowns: only the trunk blocks
add('halloween', 'trees', 0.3, ['tree_dead_large', 'tree_dead_large_decorated', 'tree_dead_medium', 'tree_dead_small']);
add('halloween', 'graves', 0.55, ['grave_A', 'grave_A_destroyed', 'grave_B']);
add('halloween', 'graves', 0.5, ['gravestone']);
add('halloween', 'graves', 0.6, ['gravemarker_A', 'gravemarker_B']);
add('halloween', 'graves', 0.5, ['coffin', 'coffin_decorated']);
add('halloween', 'graves', [{ x: -1.8, z: -2.4, r: 2.3 }, { x: 1.8, z: -2.4, r: 2.3 }, { x: -1.8, z: 2.4, r: 2.3 }, { x: 1.8, z: 2.4, r: 2.3 },
  { x: 0, z: 0, r: 2.3 }], ['crypt']);   // 6 x 8
add('halloween', 'graves', row(0.6, 0), ['pillar']);
add('halloween', 'graves', 0, ['plaque_candles', 'shrine_candles']);
add('halloween', 'graves', 0, ['bone_A', 'bone_B', 'bone_C'], { cast: false, lift: 0.14 });
add('halloween', 'graves', 0, ['skull'], { cast: false });
add('halloween', 'graves', 0, ['ribcage'], { cast: false, lift: 0.39 });
add('halloween', 'walls', row(0.55, -1.4, 0, 1.4), ['fence', 'fence_broken']);   // 4.0 x 0.5
add('halloween', 'walls', 'box', ['fence_seperate', 'fence_seperate_broken']);   // 4.0 x 0.17; the files are spelled this way
add('halloween', 'walls', row(0.45, 0), ['fence_pillar', 'fence_pillar_broken']);
add('halloween', 'walls', row(0.47, -1.76, 1.76), ['arch']);   // 4.22 wide, passable between the posts
add('halloween', 'lights', 0, ['lantern_standing'], { glow: { y: 0.55 } });
add('halloween', 'lights', row(0.35, 0), ['post_lantern'], { glow: { y: 2.25, z: 1, s: 1.3 } });   // the arm reaches along local +Z
add('halloween', 'lights', 0, ['skull_candle']);
add('halloween', 'props', row(0.35, 0), ['post_skull']);
add('halloween', 'props', 0.7, ['pumpkin_orange', 'pumpkin_yellow', 'pumpkin_orange_jackolantern', 'pumpkin_yellow_jackolantern']);
add('halloween', 'props', 0, ['pumpkin_orange_small', 'pumpkin_yellow_small']);

// ---- dungeon (P = 1): KayKit Dungeon Remastered, the Skeleton King's fortress and the cursed-land ruins
add('dungeon', 'walls', row(0.77, -2, 0, 2), ['wall', 'wall_pillar']);   // 4.0 x 1.0 and 4.0 x 1.5
add('dungeon', 'ruins', 0.6, ['wall_broken', 'wall_cracked']);
add('dungeon', 'ruins', 0.5, ['rubble_large', 'rubble_half']);
add('dungeon', 'ruins', 0.9, ['pillar']);
add('dungeon', 'lights', row(0.88, 0), ['pillar_decorated'], { glow: { y: 4.35, s: 1.18, color: 0xff7030 } });
add('dungeon', 'lights', 0, ['torch_mounted'], { glow: { y: 0.71, z: 0.44, s: 0.88, color: 0xff7030 } });
add('dungeon', 'props', row(1, 0), ['barrel_large', 'crates_stacked']);
add('dungeon', 'props', 0, ['banner_red', 'sword_shield', 'sword_shield_broken', 'sword_shield_gold',
  'coin_stack_large', 'coin_stack_medium', 'coin_stack_small']);
// the game uses these for real treasure chests and coin drops; placed as scenery they would be chests that never open
add('dungeon', 'special', 0, ['chest', 'chest_gold', 'coin'], { hidden: true });

// ---- forest (P = 1): KayKit Forest Nature Pack (the free part): trees, bushes, rocks and grass
add('forest', 'trees', 0.14, ['tree_1_a', 'tree_1_b', 'tree_1_c', 'tree_2_a', 'tree_2_b', 'tree_2_c', 'tree_2_d', 'tree_2_e', 'tree_3_a',
  'tree_3_b', 'tree_3_c', 'tree_4_a', 'tree_4_b', 'tree_4_c']);   // wide crowns: only the trunk blocks
add('forest', 'trees', 0.2, ['tree_bare_1_a', 'tree_bare_1_b', 'tree_bare_1_c', 'tree_bare_2_a', 'tree_bare_2_b', 'tree_bare_2_c']);
add('forest', 'foliage', 0, ['bush_1_a', 'bush_1_b', 'bush_1_c', 'bush_1_d', 'bush_1_e', 'bush_1_f', 'bush_1_g', 'bush_2_a', 'bush_2_b',
  'bush_2_c', 'bush_2_d', 'bush_2_e', 'bush_2_f', 'bush_3_a', 'bush_3_b', 'bush_3_c', 'bush_4_a', 'bush_4_b',
  'bush_4_c', 'bush_4_d', 'bush_4_e', 'bush_4_f']);
add('forest', 'rocks', 0.75, ['rock_1_a', 'rock_1_b', 'rock_1_c', 'rock_1_d', 'rock_1_e', 'rock_1_f', 'rock_1_g', 'rock_1_h', 'rock_1_i',
  'rock_1_j', 'rock_1_k', 'rock_1_l', 'rock_1_m', 'rock_1_n', 'rock_1_o', 'rock_1_p', 'rock_1_q', 'rock_2_a',
  'rock_2_b', 'rock_2_c', 'rock_2_d', 'rock_2_e', 'rock_2_f', 'rock_2_g', 'rock_2_h', 'rock_3_a', 'rock_3_b',
  'rock_3_c', 'rock_3_d', 'rock_3_e', 'rock_3_f', 'rock_3_g', 'rock_3_h', 'rock_3_i', 'rock_3_j', 'rock_3_k',
  'rock_3_l', 'rock_3_m', 'rock_3_n', 'rock_3_o', 'rock_3_p', 'rock_3_q', 'rock_3_r']);
add('forest', 'foliage', 0, ['grass_1_a', 'grass_1_b', 'grass_1_c', 'grass_1_d', 'grass_2_a', 'grass_2_b', 'grass_2_c', 'grass_2_d'], { cast: false });

// ---- builtin (P = 1): procedural pieces, origin on the ground
add('builtin', 'special', row(2.6, 0), ['fountain']);
add('builtin', 'special', 0, ['crystal', 'red_crystal', 'lair_ring'], { cast: false });   // the crystal floats and spins in the game
add('builtin', 'lights', 0, ['lamp_post']);
add('builtin', 'foliage', 0, ['bush']);
add('builtin', 'rocks', row(0.5, 0), ['spike']);
// the meshes of automatic foliage, offered so a flower bed can be painted by hand
add('builtin', 'foliage', 0, ['grass_tuft', 'flower_white', 'flower_yellow', 'flower_pink', 'flower_violet'], { cast: false });

// ---------------------------------------------------------------- lookups

const ID = /^([a-z][a-z0-9_]{0,23})\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;   // the pattern a map's `m` must match
const GLOW_COLOR = 0xffb050;   // warm lantern light
const HALO_R = 0.55;           // radius of the halo sphere at glow size 1

// Everything known about a model, defaults filled in: { id, pack, name, label, url, scale, col, glow, cat, cast, lift, hidden }.
// null when no pack can serve the id (malformed, unknown pack, unknown built-in). `col` is 'auto' for a file the table does not list.
// The result is a fresh copy: changing it never changes the table.
export function modelInfo(id) {
  const m = typeof id === 'string' && ID.exec(id);
  if (!m || !Object.hasOwn(PACKS, m[1])) return null;
  const [, pack, name] = m, p = PACKS[pack];
  if (!p.dir && !BUILTIN.includes(name)) return null;
  const e = Object.hasOwn(MODELS, id) ? MODELS[id] : {}, g = e.glow;
  return {
    id, pack, name,
    label: (name[0].toUpperCase() + name.slice(1)).replaceAll('_', ' '),   // 'tree_single_A' -> 'Tree single A'
    url: p.dir ? `${p.dir}${name}.${p.ext}` : null,
    scale: p.scale,
    col: Array.isArray(e.col) ? e.col.map((c) => ({ ...c })) : e.col ?? 'auto',
    glow: g ? { x: g.x ?? 0, y: g.y, z: g.z ?? 0, s: g.s ?? 1, color: g.color ?? GLOW_COLOR } : null,
    cat: e.cat ?? 'props', cast: e.cast ?? true, lift: e.lift ?? 0, hidden: e.hidden ?? false,
  };
}

// Every model a map may use, as sorted ids: the files the server reports (the body of GET /api/assets) plus the built-ins.
// Hidden models are left out unless asked for: the palette takes the default list, validation always the full one.
export function listModels(assets, { hidden = false } = {}) {
  const ids = BUILTIN.map((name) => `builtin/${name}`);
  for (const pack of Object.keys(PACKS)) {
    const names = PACKS[pack].dir && assets?.packs?.[pack];
    if (Array.isArray(names)) for (const name of names) ids.push(`${pack}/${name}`);
  }
  return ids.filter((id) => ID.test(id) && (hidden || !(Object.hasOwn(MODELS, id) && MODELS[id].hidden))).sort();
}

// ---------------------------------------------------------------- colliders and glows

// local (lx, lz) of an item at (x, z) turned by ry -> world
function rot(o, lx, lz) {
  const cos = Math.cos(o.ry), sin = Math.sin(o.ry);
  return { x: o.x + lx * cos + lz * sin, z: o.z - lx * sin + lz * cos };
}

// What an object blocks, in world space: { circles: [{ x, z, r }], boxes: [{ x, z, hw, hd, ry }] }.
// `info` = modelInfo(obj.m); `footprint` = { minX, maxX, minZ, maxZ }, the model's horizontal bounding box in model units.
// The object's own `col` overrides the catalog's. Only x, z, ry and s matter: tilting, stretching or raising an object
// never moves its collider.
export function colliderOf(obj, info, footprint) {
  const out = { circles: [], boxes: [] };
  if (!info) return out;
  let c = obj.col ?? info.col;
  const k = info.scale * obj.s;
  if (Array.isArray(c)) {
    for (const e of c) out.circles.push({ ...rot(obj, e.x * k, e.z * k), r: e.r * k });
    return out;
  }
  if (!c || !footprint) return out;   // every other form is measured from the footprint
  const { minX, maxX, minZ, maxZ } = footprint;
  const W = maxX - minX, D = maxZ - minZ, R = Math.max(W, D) / 2;
  if (c === 'auto') {   // a model the table does not list: small things are walk-through, long things are walls
    if (R * k < 0.6) return out;
    c = Math.max(W, D) >= 2.5 * Math.min(W, D) ? 'box' : 0.45;
  }
  if (c === 'box') out.boxes.push({ ...rot(obj, (minX + maxX) / 2 * k, (minZ + maxZ) / 2 * k), hw: W / 2 * k, hd: D / 2 * k, ry: obj.ry });
  else if (typeof c === 'number' && c > 0) out.circles.push({ x: obj.x, z: obj.z, r: c * R * k });
  return out;
}

// The halo of a lantern or torch in world space: { x, y, z, r, color }; null for a model that does not glow.
export function glowOf(obj, info) {
  const g = info?.glow;
  if (!g) return null;
  const k = info.scale * obj.s, p = rot(obj, g.x * k, g.z * k);
  return { x: p.x, y: obj.y + g.y * k, z: p.z, r: HALO_R * g.s * obj.s, color: g.color };
}
