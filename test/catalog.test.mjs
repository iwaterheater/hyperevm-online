// Tests of the model catalog (src/map/catalog.js): the table against the asset folders, lookups, collider and glow resolution.
// Run: node --test test/catalog.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKS, BUILTIN, CATEGORIES, MODEL_ALIASES, MODELS, modelInfo, listModels, colliderOf, glowOf } from '../src/map/catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// What GET /api/assets reports: per pack, the plain files with the pack's extension, extension stripped, sorted.
function scanAssets() {
  const packs = {};
  for (const [pack, p] of Object.entries(PACKS)) {
    if (!p.dir) continue;
    packs[pack] = fs.readdirSync(path.join(ROOT, p.dir), { withFileTypes: true })
      .filter((f) => f.isFile() && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.(gltf|glb)$/.test(f.name) && f.name.endsWith('.' + p.ext))
      .map((f) => f.name.slice(0, -p.ext.length - 1)).sort();
  }
  return { packs };
}
const ASSETS = scanAssets();
const DISK_IDS = Object.entries(ASSETS.packs).flatMap(([pack, names]) => names.map((name) => `${pack}/${name}`));

// a runtime object: every field present, angles in radians
const obj = (m, props) => ({ m, x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, s: 1, sy: 1, col: null, g: null, ...props });
const collide = (o, footprint) => colliderOf(o, modelInfo(o.m), footprint);

// same keys, numbers equal within eps
function close(actual, expected, eps = 1e-9) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
  for (const k of Object.keys(expected)) assert.ok(Math.abs(actual[k] - expected[k]) <= eps, `${k}: ${actual[k]} is not ${expected[k]}`);
}

// Footprints in model units, measured from the asset files.
const FP = {
  fenceStone: { minX: -1.1, maxX: -0.9, minZ: -0.577, maxZ: 0.577 },   // medieval/fence_stone_straight: a hex-edge piece, off the origin
  treeA: { minX: -0.288, maxX: 0.286, minZ: -0.302, maxZ: 0.245 },     // medieval/tree_single_A: R 0.287
  grave: { minX: -1, maxX: 1, minZ: -0.5, maxZ: 0.5 },                 // halloween/grave_A: 2 x 1, R 1
  pumpkin: { minX: -0.75, maxX: 0.75, minZ: -0.7, maxZ: 0.7 },         // halloween/pumpkin_orange_jackolantern: R 0.75
  rubbleHalf: { minX: 0, maxX: 4, minZ: -1.516, maxZ: 1.484 },         // dungeon/rubble_half: all of it on one side of the origin, R 2
  wall: { minX: -2, maxX: 2, minZ: -0.5, maxZ: 0.5 },                  // dungeon/wall: 4 x 1
  fenceSeparate: { minX: -2, maxX: 2, minZ: -0.085, maxZ: 0.085 },     // halloween/fence_seperate: 4 x 0.17
};

// ---------------------------------------------------------------- constants and the table

test('packs, built-ins and categories', () => {
  assert.deepEqual(Object.keys(PACKS), ['medieval', 'halloween', 'dungeon', 'builtin']);
  assert.deepEqual(PACKS.medieval, { dir: 'assets/medieval/', ext: 'gltf', scale: 5, label: 'Medieval' });
  assert.deepEqual(PACKS.halloween, { dir: 'assets/halloween/', ext: 'gltf', scale: 1, label: 'Graveyard' });
  assert.deepEqual(PACKS.dungeon, { dir: 'assets/dungeon/', ext: 'glb', scale: 1, label: 'Dungeon' });
  assert.deepEqual(PACKS.builtin, { dir: null, ext: null, scale: 1, label: 'Built-in' });
  assert.deepEqual(BUILTIN, ['fountain', 'crystal', 'lamp_post', 'bush', 'spike', 'red_crystal', 'lair_ring',
    'grass_tuft', 'flower_white', 'flower_yellow', 'flower_pink', 'flower_violet']);
  assert.deepEqual(CATEGORIES, ['buildings', 'walls', 'trees', 'rocks', 'props', 'graves', 'lights', 'ruins', 'foliage', 'special']);
});

test('catalog.js is pure: it imports nothing', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/map/catalog.js'), 'utf8');
  assert.doesNotMatch(src, /^\s*import\b|\bimport\s*\(|\brequire\s*\(|\bBuffer\b/m);
});

test('every model file on disk resolves', () => {
  assert.ok(DISK_IDS.length > 0);
  const listed = new Set(listModels(ASSETS, { hidden: true }));
  for (const id of DISK_IDS) {
    const [pack, name] = id.split('/'), info = modelInfo(id);
    assert.ok(info, `${id} does not resolve`);
    assert.equal(info.id, id);
    assert.equal(info.pack, pack);
    assert.equal(info.name, name);
    assert.equal(info.url, `assets/${pack}/${name}.${PACKS[pack].ext}`);
    assert.ok(fs.existsSync(path.join(ROOT, info.url)), `${info.url} does not exist`);
    assert.equal(info.scale, PACKS[pack].scale);
    assert.ok(listed.has(id), `${id} is not listed`);
  }
});

test('every table entry names an existing file or a built-in', () => {
  for (const id of Object.keys(MODELS)) {
    const info = modelInfo(id);
    assert.ok(info, `${id} does not resolve`);
    if (info.pack === 'builtin') {
      assert.ok(BUILTIN.includes(info.name), `${id} is not a built-in`);
      assert.equal(info.url, null);
    } else {
      assert.ok(fs.existsSync(path.join(ROOT, info.url)), `${id}: ${info.url} does not exist`);
    }
  }
});

test('the table lists every model file and every built-in', () => {
  // a file dropped into an asset folder works without a row (auto collider), but it should get one: add it to MODELS
  for (const id of DISK_IDS) assert.ok(Object.hasOwn(MODELS, id), `${id} has no row in MODELS`);
  for (const name of BUILTIN) assert.ok(Object.hasOwn(MODELS, `builtin/${name}`), `builtin/${name} has no row in MODELS`);
  const count = (pack) => Object.keys(MODELS).filter((id) => id.startsWith(pack + '/')).length;
  assert.deepEqual([count('medieval'), count('halloween'), count('dungeon'), count('builtin')], [57, 44, 21, 12]);
  assert.equal(Object.keys(MODELS).length, 134);
  assert.deepEqual([ASSETS.packs.medieval.length, ASSETS.packs.halloween.length, ASSETS.packs.dungeon.length], [57, 44, 21]);
});

test('table entries are well-formed', () => {
  for (const [id, e] of Object.entries(MODELS)) {
    for (const key of Object.keys(e)) assert.ok(['col', 'cat', 'glow', 'cast', 'lift', 'hidden'].includes(key), `${id}: unknown field ${key}`);
    assert.ok(CATEGORIES.includes(e.cat), `${id}: category ${e.cat}`);
    // the collider forms a map accepts: 0, a factor up to 4, 'box', or 1..8 circles
    if (Array.isArray(e.col)) {
      assert.ok(e.col.length >= 1 && e.col.length <= 8, `${id}: ${e.col.length} circles`);
      for (const c of e.col) {
        assert.deepEqual(Object.keys(c), ['x', 'z', 'r'], `${id}: circle keys`);
        assert.ok(Math.abs(c.x) <= 50 && Math.abs(c.z) <= 50 && c.r > 0 && c.r <= 50, `${id}: circle ${JSON.stringify(c)}`);
      }
    } else if (e.col !== 'box') {
      assert.ok(typeof e.col === 'number' && e.col >= 0 && e.col <= 4, `${id}: col ${e.col}`);
    }
    if ('glow' in e) {
      for (const key of Object.keys(e.glow)) assert.ok(['x', 'y', 'z', 's', 'color'].includes(key), `${id}: unknown glow field ${key}`);
      assert.ok(Number.isFinite(e.glow.y), `${id}: glow needs a height`);
    }
    if ('cast' in e) assert.equal(typeof e.cast, 'boolean', id);
    if ('lift' in e) assert.ok(Number.isFinite(e.lift), id);
    if ('hidden' in e) assert.equal(typeof e.hidden, 'boolean', id);
  }
});

test('every alias points at a model that resolves', () => {
  for (const [from, to] of Object.entries(MODEL_ALIASES)) assert.ok(modelInfo(to), `${from} -> ${to}`);
});

// ---------------------------------------------------------------- modelInfo

test('modelInfo fills in the defaults', () => {
  assert.deepEqual(modelInfo('medieval/barrel'), {
    id: 'medieval/barrel', pack: 'medieval', name: 'barrel', label: 'Barrel', url: 'assets/medieval/barrel.gltf', scale: 5,
    col: 0, glow: null, cat: 'props', cast: true, lift: 0, hidden: false,
  });
  assert.deepEqual(modelInfo('halloween/lantern_standing').glow, { x: 0, y: 0.55, z: 0, s: 1, color: 0xffb050 });
  assert.deepEqual(modelInfo('halloween/post_lantern').glow, { x: 0, y: 2.25, z: 1, s: 1.3, color: 0xffb050 });
  assert.deepEqual(modelInfo('dungeon/torch_mounted').glow, { x: 0, y: 0.71, z: 0.44, s: 0.88, color: 0xff7030 });
  assert.deepEqual(modelInfo('dungeon/pillar_decorated').glow, { x: 0, y: 4.35, z: 0, s: 1.18, color: 0xff7030 });
});

test('modelInfo: labels and urls', () => {
  assert.equal(modelInfo('medieval/tree_single_A').label, 'Tree single A');
  assert.equal(modelInfo('halloween/fence_seperate_broken').label, 'Fence seperate broken');
  assert.equal(modelInfo('builtin/lamp_post').label, 'Lamp post');
  assert.equal(modelInfo('halloween/grave_A').url, 'assets/halloween/grave_A.gltf');
  assert.equal(modelInfo('dungeon/wall_pillar').url, 'assets/dungeon/wall_pillar.glb');
  assert.equal(modelInfo('builtin/fountain').url, null);
  assert.equal(modelInfo('builtin/fountain').scale, 1);
});

test('modelInfo: table values', () => {
  assert.equal(modelInfo('medieval/building_home_A_red').col, 0.8);
  assert.equal(modelInfo('medieval/building_home_A_red').cat, 'buildings');
  assert.equal(modelInfo('medieval/fence_stone_straight').col, 'box');
  assert.deepEqual(modelInfo('medieval/wall_straight').col, [{ x: -0.68, z: 0, r: 0.435 }, { x: 0, z: 0, r: 0.435 }, { x: 0.68, z: 0, r: 0.435 }]);
  assert.deepEqual(modelInfo('medieval/wall_straight_gate').col, [{ x: -0.76, z: 0, r: 0.313 }, { x: 0.76, z: 0, r: 0.313 }]);
  assert.deepEqual(modelInfo('halloween/crypt').col, [{ x: -1.8, z: -2.4, r: 2.3 }, { x: 1.8, z: -2.4, r: 2.3 },
    { x: -1.8, z: 2.4, r: 2.3 }, { x: 1.8, z: 2.4, r: 2.3 }, { x: 0, z: 0, r: 2.3 }]);
  assert.deepEqual(modelInfo('builtin/fountain').col, [{ x: 0, z: 0, r: 2.6 }]);
  for (const name of ['bone_A', 'bone_B', 'bone_C']) {
    assert.equal(modelInfo(`halloween/${name}`).lift, 0.14);
    assert.equal(modelInfo(`halloween/${name}`).cast, false);
  }
  assert.equal(modelInfo('halloween/ribcage').lift, 0.39);
  assert.equal(modelInfo('halloween/skull').cast, false);
  assert.equal(modelInfo('halloween/skull').lift, 0);
  assert.equal(modelInfo('builtin/crystal').cast, false);
  assert.equal(modelInfo('builtin/lamp_post').cat, 'lights');
  assert.equal(modelInfo('builtin/spike').cat, 'rocks');
});

test('modelInfo: a file the table does not list gets the pack defaults and the auto collider', () => {
  assert.equal(Object.hasOwn(MODELS, 'medieval/new_house'), false);
  assert.deepEqual(modelInfo('medieval/new_house'), {
    id: 'medieval/new_house', pack: 'medieval', name: 'new_house', label: 'New house', url: 'assets/medieval/new_house.gltf', scale: 5,
    col: 'auto', glow: null, cat: 'props', cast: true, lift: 0, hidden: false,
  });
  assert.equal(modelInfo('dungeon/Statue-2').url, 'assets/dungeon/Statue-2.glb');
  // 'auto' is only ever the answer for an unlisted model
  for (const id of Object.keys(MODELS)) assert.notEqual(modelInfo(id).col, 'auto', id);
});

test('modelInfo returns null for an id no pack can serve', () => {
  for (const id of ['castle/tower', 'builtin/dragon', 'builtin/chest', 'constructor/x', 'constructor/fountain', '__proto__/x', 'toString/barrel',
    'barrel', 'medieval', 'medieval/', '/barrel', 'medieval/a/b', 'medieval/../dungeon/chest', 'medieval/barrel.gltf',
    'Medieval/barrel', ' medieval/barrel', 'medieval/barrel\n', 'medieval/' + 'a'.repeat(65), '', null, undefined, 7, {}, ['medieval/barrel']]) {
    assert.equal(modelInfo(id), null, String(id));
  }
  assert.ok(modelInfo('medieval/' + 'a'.repeat(64)));
});

test('modelInfo returns a copy: changing it leaves the table alone', () => {
  const info = modelInfo('medieval/wall_straight');
  info.col[0].r = 99;
  info.col.length = 1;
  info.cat = 'special';
  const glow = modelInfo('dungeon/torch_mounted').glow;
  glow.y = 99;
  assert.equal(MODELS['medieval/wall_straight'].col.length, 3);
  assert.equal(modelInfo('medieval/wall_straight').col[0].r, 0.435);
  assert.equal(modelInfo('medieval/wall_straight').cat, 'walls');
  assert.equal(modelInfo('dungeon/torch_mounted').glow.y, 0.71);
});

// ---------------------------------------------------------------- listModels

test('listModels: 131 ids for the palette, 134 with the hidden ones', () => {
  const shown = listModels(ASSETS), all = listModels(ASSETS, { hidden: true });
  assert.equal(shown.length, 57 + 44 + 18 + 12);
  assert.equal(all.length, 134);
  assert.deepEqual(all, Object.keys(MODELS).sort());
  for (const list of [shown, all]) {
    assert.deepEqual(list, [...list].sort());
    assert.equal(new Set(list).size, list.length);
    for (const id of list) assert.ok(modelInfo(id), id);
    for (const name of BUILTIN) assert.ok(list.includes(`builtin/${name}`), name);
  }
});

test('listModels hides the chest and coin models from the palette', () => {
  const HIDDEN = ['dungeon/chest', 'dungeon/chest_gold', 'dungeon/coin'];
  assert.deepEqual(Object.keys(MODELS).filter((id) => MODELS[id].hidden).sort(), HIDDEN);
  for (const id of HIDDEN) {
    assert.equal(modelInfo(id).hidden, true);
    assert.equal(modelInfo(id).cat, 'special');
  }
  const shown = listModels(ASSETS), all = listModels(ASSETS, { hidden: true });
  assert.deepEqual(all.filter((id) => !shown.includes(id)), HIDDEN);
  assert.deepEqual(listModels(ASSETS, {}), shown);
  assert.deepEqual(listModels(ASSETS, { hidden: false }), shown);
  // hidden models are valid map content: a visible scenery piece is of course not hidden
  assert.equal(modelInfo('dungeon/coin_stack_small').hidden, false);
});

test('listModels: lists what the server reports, new files included', () => {
  const list = listModels({ packs: { medieval: ['barrel', 'new_house'], halloween: [], dungeon: ['chest', 'wall'] } });
  assert.deepEqual(list, [...BUILTIN.map((name) => `builtin/${name}`), 'dungeon/wall', 'medieval/barrel', 'medieval/new_house'].sort());
  assert.ok(listModels({ packs: { dungeon: ['chest'] } }, { hidden: true }).includes('dungeon/chest'));
});

test('listModels: nothing but the built-ins without assets, and never an id that does not resolve', () => {
  const builtins = BUILTIN.map((name) => `builtin/${name}`).sort();
  for (const assets of [undefined, null, {}, { packs: {} }, { packs: { medieval: 'barrel' } }]) assert.deepEqual(listModels(assets), builtins);
  // packs the catalog does not know, built-ins the page does not have and names that are not file names are left out
  assert.deepEqual(listModels({ packs: { castle: ['tower'], builtin: ['dragon'], medieval: ['../secret', '', 'a b', 'barrel.gltf'] } }), builtins);
});

// ---------------------------------------------------------------- colliderOf

test('colliderOf: 0 blocks nothing', () => {
  assert.deepEqual(collide(obj('halloween/lantern_standing', { x: 5, z: 5 }), FP.pumpkin), { circles: [], boxes: [] });
  // an explicit 0 on the object wins over the catalog collider (the pumpkins of the cemetery plots)
  const pumpkin = obj('halloween/pumpkin_orange_jackolantern', { x: 8, z: 4 });
  close(collide(pumpkin, FP.pumpkin).circles[0], { x: 8, z: 4, r: 0.7 * 0.75 });
  assert.deepEqual(collide({ ...pumpkin, col: 0 }, FP.pumpkin), { circles: [], boxes: [] });
});

test('colliderOf: a factor is one circle at the object origin, a share of the footprint radius', () => {
  const out = collide(obj('halloween/grave_A', { x: 120, z: 40, ry: 0.2, s: 1.2 }), FP.grave);
  assert.equal(out.circles.length, 1);
  assert.deepEqual(out.boxes, []);
  close(out.circles[0], { x: 120, z: 40, r: 0.55 * 1 * 1.2 });
  // the circle sits on the origin even when the geometry does not
  close(collide(obj('dungeon/rubble_half', { x: 10, z: -200, ry: 1, s: 0.8 }), FP.rubbleHalf).circles[0], { x: 10, z: -200, r: 0.5 * 2 * 0.8 });
});

test('colliderOf: a factor above 1 reaches beyond the footprint', () => {
  close(collide(obj('halloween/grave_A', { x: 1, z: 2, col: 2.5 }), FP.grave).circles[0], { x: 1, z: 2, r: 2.5 });
  close(collide(obj('medieval/barrel', { col: 4, s: 2 }), { minX: -0.1, maxX: 0.1, minZ: -0.1, maxZ: 0.1 }).circles[0], { x: 0, z: 0, r: 4 * 0.1 * 5 * 2 });
});

test('colliderOf: the medieval pack scale multiplies every length', () => {
  // tree_single_A: 0.3 of R 0.287, pack scale 5, object scale 1.1
  close(collide(obj('medieval/tree_single_A', { x: 31.2, z: -4.5, ry: 1.3, s: 1.1 }), FP.treeA).circles[0], { x: 31.2, z: -4.5, r: 0.3 * 0.287 * 5 * 1.1 });
  // the same footprint in a pack at scale 1 gives a fifth of it
  const r5 = colliderOf(obj('x', { col: 0.3 }), { scale: 5, col: 0 }, FP.treeA).circles[0].r;
  const r1 = colliderOf(obj('x', { col: 0.3 }), { scale: 1, col: 0 }, FP.treeA).circles[0].r;
  assert.ok(Math.abs(r5 - 5 * r1) < 1e-9);
});

test('colliderOf: box is the footprint, turned and scaled with the object', () => {
  const out = collide(obj('halloween/fence_seperate', { x: 7, z: -3, ry: 0.5, s: 2 }), FP.fenceSeparate);
  assert.deepEqual(out.circles, []);
  assert.equal(out.boxes.length, 1);
  close(out.boxes[0], { x: 7, z: -3, hw: 4, hd: 0.17, ry: 0.5 });
  // a per-object 'box' replaces the catalog circles
  const wall = collide(obj('dungeon/wall', { x: 1, z: 1, col: 'box', s: 1.5 }), FP.wall);
  assert.deepEqual(wall.circles, []);
  close(wall.boxes[0], { x: 1, z: 1, hw: 3, hd: 0.75, ry: 0 });
});

test('colliderOf: the off-centre box of medieval/fence_stone_straight sits where the fence is drawn', () => {
  // the geometry is one model unit (5 world units) off the origin, along local -X
  close(collide(obj('medieval/fence_stone_straight', { x: 10, z: 20 }), FP.fenceStone).boxes[0], { x: 5, z: 20, hw: 0.5, hd: 2.885, ry: 0 });
  close(collide(obj('medieval/fence_stone_straight', { x: 10, z: 20, ry: Math.PI / 2 }), FP.fenceStone).boxes[0],
    { x: 10, z: 25, hw: 0.5, hd: 2.885, ry: Math.PI / 2 });
  close(collide(obj('medieval/fence_stone_straight', { x: 10, z: 20, ry: Math.PI }), FP.fenceStone).boxes[0], { x: 15, z: 20, hw: 0.5, hd: 2.885, ry: Math.PI });
  // any angle: seen from the box, the object origin is 5.5 units along local +X
  const o = obj('medieval/fence_stone_straight', { x: -40, z: 12, ry: 0.7, s: 1.1 }), box = collide(o, FP.fenceStone).boxes[0];
  close({ hw: box.hw, hd: box.hd, ry: box.ry }, { hw: 0.55, hd: 3.1735, ry: 0.7 });
  const dx = o.x - box.x, dz = o.z - box.z, cos = Math.cos(box.ry), sin = Math.sin(box.ry);
  close({ lx: dx * cos - dz * sin, lz: dx * sin + dz * cos }, { lx: 5.5, lz: 0 });
});

test('colliderOf: circles are placed in the model frame', () => {
  // a town wall piece: s 0.574, length along local X; at ry = 90 degrees local +X points to world -Z
  const out = collide(obj('medieval/wall_straight', { x: 25.6, z: 0, ry: Math.PI / 2, s: 0.574 }));
  assert.deepEqual(out.boxes, []);
  assert.equal(out.circles.length, 3);
  close(out.circles[0], { x: 25.6, z: 1.9516, r: 1.24845 });
  close(out.circles[1], { x: 25.6, z: 0, r: 1.24845 });
  close(out.circles[2], { x: 25.6, z: -1.9516, r: 1.24845 });
  // which is today's hand-built wall: circles of 1.25 every 0.34 of a 5.745 long segment
  const segLen = 2 * Math.PI * 25.6 / 28;
  close(out.circles[0], { x: 25.6, z: 0.34 * segLen, r: 1.25 }, 0.01);

  const crypt = collide(obj('halloween/crypt', { x: 40, z: -128, ry: Math.PI / 2 })).circles;
  assert.equal(crypt.length, 5);
  close(crypt[0], { x: 40 - 2.4, z: -128 + 1.8, r: 2.3 });
  close(crypt[3], { x: 40 + 2.4, z: -128 - 1.8, r: 2.3 });
  close(crypt[4], { x: 40, z: -128, r: 2.3 });

  // unturned: local axes are the world axes
  const arch = collide(obj('halloween/arch', { x: 97, z: 0, s: 1.7 })).circles;
  close(arch[0], { x: 97 - 2.992, z: 0, r: 0.799 });
  close(arch[1], { x: 97 + 2.992, z: 0, r: 0.799 });
  close(collide(obj('builtin/fountain')).circles[0], { x: 0, z: 0, r: 2.6 });
  close(collide(obj('builtin/spike', { x: 3, z: 200, s: 1.9 })).circles[0], { x: 3, z: 200, r: 0.95 });
});

test('colliderOf: circles on the object replace the catalog collider', () => {
  // the colonnade of the fortress: a fixed 0.73 instead of 0.9 of the footprint
  const pillar = obj('dungeon/pillar', { x: 15, z: -228, s: 1.5, col: [{ x: 0, z: 0, r: 0.73 }] });
  const out = collide(pillar, { minX: -0.75, maxX: 0.75, minZ: -0.75, maxZ: 0.75 });
  assert.equal(out.circles.length, 1);
  close(out.circles[0], { x: 15, z: -228, r: 1.095 });
  close(collide({ ...pillar, col: null }, { minX: -0.75, maxX: 0.75, minZ: -0.75, maxZ: 0.75 }).circles[0], { x: 15, z: -228, r: 0.9 * 0.75 * 1.5 });
  // a ruined ring piece of the fortress wall blocks like an intact one
  const ring = [{ x: -2, z: 0, r: 0.77 }, { x: 0, z: 0, r: 0.77 }, { x: 2, z: 0, r: 0.77 }];
  const broken = collide(obj('dungeon/wall_broken', { x: 0, z: -202, s: 1.5, col: ring }), FP.wall).circles;
  assert.deepEqual(broken, collide(obj('dungeon/wall', { x: 0, z: -202, s: 1.5 }), FP.wall).circles);
  close(broken[2], { x: 3, z: -202, r: 1.155 });
});

test('colliderOf: auto leaves small models walk-through', () => {
  assert.equal(modelInfo('halloween/new_statue').col, 'auto');
  const small = { minX: -0.5, maxX: 0.5, minZ: -0.5, maxZ: 0.5 };   // R 0.5: under the 0.6 limit at scale 1
  assert.deepEqual(collide(obj('halloween/new_statue'), small), { circles: [], boxes: [] });
  // the limit is in world units: object scale and pack scale both count
  close(collide(obj('halloween/new_statue', { x: 4, z: 5, s: 2 }), small).circles[0], { x: 4, z: 5, r: 0.45 * 0.5 * 2 });
  const tiny = { minX: -0.15, maxX: 0.15, minZ: -0.15, maxZ: 0.15 };
  assert.deepEqual(collide(obj('halloween/new_statue'), tiny), { circles: [], boxes: [] });
  close(collide(obj('medieval/new_statue'), tiny).circles[0], { x: 0, z: 0, r: 0.45 * 0.15 * 5 });
  // the limit itself collides, just under it does not
  close(collide(obj('halloween/new_statue'), { minX: -0.6, maxX: 0.6, minZ: -0.6, maxZ: 0.6 }).circles[0], { x: 0, z: 0, r: 0.45 * 0.6 });
  assert.deepEqual(collide(obj('halloween/new_statue'), { minX: -0.59, maxX: 0.59, minZ: -0.59, maxZ: 0.59 }), { circles: [], boxes: [] });
  // small wins over long
  assert.deepEqual(collide(obj('halloween/new_statue'), { minX: -0.5, maxX: 0.5, minZ: -0.05, maxZ: 0.05 }), { circles: [], boxes: [] });
});

test('colliderOf: auto boxes long models and circles the rest', () => {
  const long = collide(obj('dungeon/new_wall', { x: 10, z: 10, ry: Math.PI / 2 }), { minX: 0, maxX: 4, minZ: -0.5, maxZ: 0.5 });
  assert.deepEqual(long.circles, []);
  close(long.boxes[0], { x: 10, z: 8, hw: 2, hd: 0.5, ry: Math.PI / 2 });
  // the limit is 2.5 : 1, in either direction
  const edge = collide(obj('dungeon/new_wall'), { minX: -0.5, maxX: 0.5, minZ: -1.25, maxZ: 1.25 });
  close(edge.boxes[0], { x: 0, z: 0, hw: 0.5, hd: 1.25, ry: 0 });
  const round = collide(obj('dungeon/new_wall', { x: 1, z: 2 }), { minX: -1.2, maxX: 1.2, minZ: -0.5, maxZ: 0.5 });
  assert.deepEqual(round.boxes, []);
  close(round.circles[0], { x: 1, z: 2, r: 0.45 * 1.2 });
  // an unlisted model still takes a per-object collider
  assert.deepEqual(collide(obj('dungeon/new_wall', { col: 0 }), FP.wall), { circles: [], boxes: [] });
  close(collide(obj('dungeon/new_wall', { col: 1 }), FP.wall).circles[0], { x: 0, z: 0, r: 2 });
});

test('colliderOf: tilt, height and stretch never move a collider', () => {
  const tilted = { rx: 0.4, rz: -0.3, sy: 2.5, y: 7 };
  for (const [o, fp] of [
    [obj('halloween/grave_A', { x: 3, z: 4, ry: 1, s: 1.3 }), FP.grave],
    [obj('medieval/fence_stone_straight', { x: 3, z: 4, ry: 1, s: 1.3 }), FP.fenceStone],
    [obj('halloween/crypt', { x: 3, z: 4, ry: 1, s: 1.3 }), undefined],
    [obj('dungeon/new_wall', { x: 3, z: 4, ry: 1, s: 1.3 }), FP.wall],
  ]) {
    assert.deepEqual(collide({ ...o, ...tilted }, fp), collide(o, fp), o.m);
  }
});

test('colliderOf: without a footprint only circles given in model units exist', () => {
  // a model that has not loaded yet has no footprint; an id that does not resolve has no info
  for (const m of ['halloween/grave_A', 'medieval/fence_stone_straight', 'halloween/new_statue']) {
    assert.deepEqual(collide(obj(m)), { circles: [], boxes: [] });
    assert.deepEqual(collide(obj(m), null), { circles: [], boxes: [] });
  }
  assert.equal(collide(obj('halloween/crypt'), null).circles.length, 5);
  assert.deepEqual(colliderOf(obj('castle/tower', { col: 1 }), modelInfo('castle/tower'), FP.wall), { circles: [], boxes: [] });
});

test('colliderOf changes neither the object nor the info', () => {
  const o = obj('medieval/wall_straight', { x: 1, z: 2, ry: 0.3, s: 0.574 }), info = modelInfo(o.m);
  const before = JSON.stringify([o, info]);
  colliderOf(o, info, FP.wall);
  glowOf(o, info);
  assert.equal(JSON.stringify([o, info]), before);
});

// ---------------------------------------------------------------- glowOf

const glow = (o) => glowOf(o, modelInfo(o.m));

test('glowOf: a standing lantern glows above its origin', () => {
  assert.deepEqual(glow(obj('halloween/lantern_standing', { x: 3, z: 4 })), { x: 3, y: 0.55, z: 4, r: 0.55, color: 0xffb050 });
});

test('glowOf: the glow turns with the object', () => {
  // the lantern of a road post hangs one unit along local +Z: forward is (sin ry, cos ry)
  close(glow(obj('halloween/post_lantern', { x: 107, z: -3.8 })), { x: 107, y: 2.25, z: -2.8, r: 0.55 * 1.3, color: 0xffb050 });
  close(glow(obj('halloween/post_lantern', { x: 107, z: -3.8, ry: Math.PI / 2 })), { x: 108, y: 2.25, z: -3.8, r: 0.715, color: 0xffb050 });
  close(glow(obj('halloween/post_lantern', { x: 107, z: -3.8, ry: Math.PI })), { x: 107, y: 2.25, z: -4.8, r: 0.715, color: 0xffb050 });
  close(glow(obj('halloween/post_lantern', { x: 107, z: -3.8, ry: -Math.PI / 2 })), { x: 106, y: 2.25, z: -3.8, r: 0.715, color: 0xffb050 });
});

test('glowOf: offset, height and radius scale with the object, and y is added', () => {
  // a fortress torch: s 1.7, mounted 3.3 up the wall; today's flame is 0.75 in front at y 4.5 with a halo of 0.825
  const torch = glow(obj('dungeon/torch_mounted', { x: 0, y: 3.3, z: -253.15, s: 1.7 }));
  close(torch, { x: 0, y: 3.3 + 0.71 * 1.7, z: -253.15 + 0.44 * 1.7, r: 0.55 * 0.88 * 1.7, color: 0xff7030 });
  close(torch, { x: 0, y: 4.5, z: -253.15 + 0.75, r: 0.825, color: 0xff7030 }, 0.01);
  // a gate post: today's flame is at y 7.4 with a halo of 1.1
  const post = glow(obj('dungeon/pillar_decorated', { x: 10.4, z: -204.2, s: 1.7 }));
  close(post, { x: 10.4, y: 7.395, z: -204.2, r: 1.1033, color: 0xff7030 });
});

test('glowOf: tilt and stretch do not move a glow', () => {
  const o = obj('dungeon/torch_mounted', { x: 1, y: 3.3, z: 2, ry: 0.4, s: 1.7 });
  assert.deepEqual(glow({ ...o, rx: 0.5, rz: -0.2, sy: 3 }), glow(o));
});

test('glowOf: the position follows the pack scale, the radius only the object scale', () => {
  const info = { scale: 5, glow: { x: 0.1, y: 0.2, z: 0, s: 1, color: 0x123456 } };
  close(glowOf(obj('x', { x: 1, y: 1, z: 1, s: 2 }), info), { x: 2, y: 3, z: 1, r: 1.1, color: 0x123456 });
});

test('glowOf: null for a model that does not glow', () => {
  for (const m of ['medieval/barrel', 'halloween/skull_candle', 'builtin/lamp_post', 'medieval/new_house']) assert.equal(glow(obj(m)), null, m);
  assert.equal(glowOf(obj('castle/tower'), modelInfo('castle/tower')), null);
  // exactly four models glow
  assert.deepEqual(Object.keys(MODELS).filter((id) => modelInfo(id).glow).sort(),
    ['dungeon/pillar_decorated', 'dungeon/torch_mounted', 'halloween/lantern_standing', 'halloween/post_lantern']);
});
