// Invariants of a FRESH bake (tools/bake-map.mjs): the script runs as a child process and writes into a temp directory.
// Nothing here reads the committed map/world.json: that file is edited by hand in the map editor, and a bake fact
// asserted on it would fail for good after the first save.
// Run: node --test test/bake.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { COLLECTION, GROUND_TYPES, groupItems, hasBoss, isSafe, normalize, regionAt, serialize, spawnCount, stringifyMap, validate } from '../src/map/format.js';
import { MODELS, PACKS, colliderOf, listModels, modelInfo } from '../src/map/catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hypercat-bake-'));
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));

// Runs from the temp directory, so a stray relative path could never touch the repository.
const bake = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'bake-map.mjs'), ...args], { cwd: DIR, encoding: 'utf8' });

const FIRST = path.join(DIR, 'world.json'), SECOND = path.join(DIR, 'again.json');
const run = bake('--out', FIRST);
assert.equal(run.status, 0, `the bake failed: ${run.stderr}`);
const TEXT = fs.readFileSync(FIRST, 'utf8');
const map = normalize(JSON.parse(TEXT));

// ---------------------------------------------------------------- helpers

const ofModel = (m, list = map.objects) => list.filter((o) => o.m === m);
const inGroup = (g) => map.objects.filter((o) => o.g === g);
const tally = (list, key) => {
  const out = {};
  for (const it of list) out[key(it)] = (out[key(it)] || 0) + 1;
  return out;
};
const errorsOf = (issues) => issues.filter((i) => i.level === 'error');
const PLOT = /^plot-\d\d$/;
const plots = [...new Set(map.objects.map((o) => o.g).filter((g) => g && PLOT.test(g)))].sort();
// a collider of circles of radius r along a piece's local X
const row = (r, ...xs) => xs.map((x) => ({ x, z: 0, r }));

// What the scatter calls of the old world could place at most: [copies, road strip, pack, models].
// A call drew that many spots and dropped those within `road` units of a road axis or inside a hand-built site.
const SCATTER = [
  [260, 3.6, 'builtin', 'bush red_crystal'],
  [620, 3.6, 'builtin', 'spike'],
  [320, 3.6, 'medieval', 'tree_single_A'],
  [240, 3.6, 'medieval', 'tree_single_B'],
  [9, 9, 'medieval', 'trees_A_large trees_A_medium trees_A_small trees_B_large trees_B_medium trees_B_small'],
  [70, 3.6, 'medieval', 'tree_single_A_cut tree_single_B_cut'],
  [9, 8, 'medieval', 'hill_single_A hill_single_B hill_single_C'],
  [2, 12, 'medieval', 'mountain_A_grass mountain_B_grass mountain_C_grass'],
  [45 + 70, 3.6, 'medieval', 'rock_single_A rock_single_B rock_single_C rock_single_D rock_single_E'],
  [14 + 12, 7, 'medieval', 'building_destroyed'],
  [60, 3.6, 'medieval', 'fence_stone_straight'],
  [40, 3.6, 'medieval', 'fence_wood_straight'],
  [4 + 5, 12, 'medieval', 'mountain_A'],
  [5, 12, 'medieval', 'mountain_B mountain_C'],
  [42, 3.6, 'halloween', 'tree_pine_orange_large tree_pine_orange_medium tree_pine_orange_small tree_pine_yellow_large tree_pine_yellow_medium tree_pine_yellow_small'],
  [150, 3.6, 'halloween', 'tree_dead_large tree_dead_medium'],
  [120, 3.6, 'halloween', 'tree_dead_small gravestone'],
  [30, 3.6, 'halloween', 'tree_dead_large_decorated'],
  [65, 3.6, 'halloween', 'grave_A grave_B grave_A_destroyed'],
  [90, 3.6, 'halloween', 'gravemarker_A gravemarker_B skull'],
  [16, 3.6, 'halloween', 'coffin'],
  [10, 3.6, 'halloween', 'coffin_decorated'],
  [110, 3.6, 'halloween', 'bone_A bone_B bone_C'],
  [45, 3.6, 'halloween', 'ribcage'],
  [12, 3.6, 'halloween', 'pumpkin_orange pumpkin_orange_jackolantern pumpkin_orange_small pumpkin_yellow pumpkin_yellow_jackolantern pumpkin_yellow_small'],
  [60, 3.6, 'halloween', 'lantern_standing'],
  [60, 3.6, 'dungeon', 'pillar'],
  [24, 6, 'dungeon', 'wall_broken'],
  [14, 6, 'dungeon', 'wall_cracked'],
  [16, 8, 'dungeon', 'rubble_large'],
  [20, 6, 'dungeon', 'rubble_half'],
].flatMap(([most, road, pack, names]) => names.split(' ').map((name) => ({ m: `${pack}/${name}`, most, road })));

// ---------------------------------------------------------------- the command

test('two bakes are byte-identical', () => {
  const again = bake('--out', SECOND);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(fs.readFileSync(SECOND).equals(fs.readFileSync(FIRST)), 'the second bake differs from the first');
});

test('a target with other content is left alone unless --force is given', () => {
  const file = path.join(DIR, 'edited.json'), edited = TEXT.replace('"Hypercat World"', '"Edited by hand"');
  fs.writeFileSync(file, edited);
  const refused = bake('--out', file);
  assert.equal(refused.status, 1);
  assert.ok((refused.stdout + refused.stderr).includes(`${file} exists; pass --force to overwrite`), refused.stdout + refused.stderr);
  assert.ok(fs.readFileSync(file, 'utf8') === edited, 'the refused bake changed the file');
  assert.deepEqual(fs.readdirSync(DIR).filter((f) => f.startsWith('edited')), ['edited.json']);   // and it kept no backup
  const forced = bake('--out', file, '--force');
  assert.equal(forced.status, 0, forced.stderr);
  assert.ok(fs.readFileSync(file, 'utf8') === TEXT, 'the forced bake did not write the baked world');
});

test('an identical target is not rewritten, a missing directory is created', () => {
  const written = () => fs.statSync(FIRST, { bigint: true }).mtimeNs;
  const before = written();
  for (const args of [['--out', FIRST], ['--out', FIRST, '--force']]) {
    const same = bake(...args);
    assert.equal(same.status, 0, same.stderr);
    assert.equal(written(), before);
  }
  const deep = path.join('not', 'yet', 'world.json');   // a relative path is taken from the current directory
  assert.equal(bake('--out', deep).status, 0);
  assert.ok(fs.readFileSync(path.join(DIR, deep), 'utf8') === TEXT);
});

test('an unknown argument is an error, not a bake', () => {
  for (const args of [['--owt', path.join(DIR, 'typo.json')], ['--out']]) assert.equal(bake(...args).status, 1);
  assert.equal(fs.existsSync(path.join(DIR, 'typo.json')), false);
});

// ---------------------------------------------------------------- the file

test('the output is canonical', () => {
  assert.ok(TEXT.endsWith('}\n') && !TEXT.includes('\r'));
  assert.ok(stringifyMap(serialize(normalize(JSON.parse(TEXT)))) === TEXT, 'the baked text is not what the canonical writer produces');
});

test('validate: no error, and neither spawn-levels nor spawn-threat-start', () => {
  const issues = validate(map);
  assert.deepEqual(errorsOf(issues), []);
  assert.deepEqual(issues.filter((i) => i.code === 'spawn-levels' || i.code === 'spawn-threat-start'), []);
});

test('every model exists as a file and has an explicit collider in the catalog', () => {
  const ids = [...new Set(map.objects.map((o) => o.m))];
  assert.ok(ids.length > 100);
  for (const id of ids) assert.ok(Object.hasOwn(MODELS, id) && MODELS[id].col !== undefined, `${id} has no col in MODELS`);
  // what GET /api/assets reports: the model files of every pack
  const packs = {};
  for (const [pack, p] of Object.entries(PACKS)) {
    if (p.dir) packs[pack] = fs.readdirSync(path.join(ROOT, p.dir)).filter((f) => f.endsWith(`.${p.ext}`)).map((f) => f.slice(0, -p.ext.length - 1));
  }
  const models = new Set(listModels({ packs }, { hidden: true }));
  assert.deepEqual(validate(map, { models, strictModels: true }).filter((i) => i.level === 'error' || i.code === 'model-missing'), []);
});

test('map, start and regions', () => {
  assert.equal(map.name, 'Hypercat World');
  assert.equal(map.radius, 260);
  assert.equal(map.foliage, true);
  assert.deepEqual(map.start, { x: 0, z: 6, r: 10 });
  assert.deepEqual(map.fallback, { name: 'Open Sea', levels: null, mood: 'meadow' });
  const circle = (r) => ({ type: 'circle', x: 0, z: 0, r });
  assert.deepEqual(map.regions, [   // later regions win: from the outside in
    { name: 'Cursed Lands', levels: [10, 15], mood: 'cursed', safe: false, color: null, shape: circle(260) },
    { name: 'Graveyard Wastes', levels: [5, 9], mood: 'graveyard', safe: false, color: null, shape: circle(175) },
    { name: 'Green Meadows', levels: [1, 4], mood: 'meadow', safe: false, color: null, shape: circle(95) },
    { name: 'Hypercat Town', levels: null, mood: 'meadow', safe: true, color: null, shape: circle(24) },
  ]);
  assert.ok(isSafe(map, 0, 6) && isSafe(map, 24, 0) && !isSafe(map, 24.1, 0));
  assert.ok(isSafe(map, 0, 16) && isSafe(map, 10, 6), 'the whole start disc lies in the town');
});

test('ground: the vertex counts of the terrain formula', () => {
  assert.equal(map.ground.cell, 2);
  assert.equal(map.ground.size, 281);
  const counts = tally(map.ground.cells, (c) => GROUND_TYPES[c].id);
  assert.deepEqual(counts, { sand: 26704, ash: 27954, dust: 16258, grass: 6429, dirt: 758, dirt_dark: 437, paving: 421 });
});

// ---------------------------------------------------------------- chests, townsfolk, monsters

test('35 chests, the hoard among them', () => {
  assert.equal(map.chests.length, 35);
  const big = map.chests.filter((c) => c.big);
  assert.deepEqual(big, [{ x: 0, z: -248, ry: 0, gold: 400, big: true, respawn: 300, g: 'fortress' }]);
  assert.equal(map.chests.indexOf(big[0]), 34);   // the order is the wire index: the hoard was always the last chest
  assert.deepEqual(tally(map.chests, (c) => c.gold), { 12: 12, 40: 12, 90: 10, 400: 1 });
  for (const c of map.chests.filter((q) => !q.big)) {
    assert.equal(c.respawn, 150);
    assert.equal(c.g, null);
    assert.equal(Math.min(Math.abs(c.x), Math.abs(c.z)), 4.6);   // beside a road
    const ahead = { x: c.x + Math.sin(c.ry) * 4.6, z: c.z + Math.cos(c.ry) * 4.6 };
    assert.ok(Math.min(Math.abs(ahead.x), Math.abs(ahead.z)) < 1e-9, `the chest at ${c.x}, ${c.z} does not face the road`);
  }
});

test('11 townsfolk: a blacksmith, a sage, a trader and eight gate guards', () => {
  assert.equal(map.npcs.length, 11);
  assert.deepEqual(tally(map.npcs, (n) => n.kind), { blacksmith: 1, trader: 1, sage: 1, guard: 8 });
  const spot = (kind) => { const n = map.npcs.find((q) => q.kind === kind); return [n.x, n.z]; };
  assert.deepEqual(spot('blacksmith'), [-4.8, 11.5]);
  assert.deepEqual(spot('sage'), [4.2, -4.6]);
  assert.deepEqual(spot('trader'), [4.8, 11.5]);
  for (const n of map.npcs) {
    assert.equal(n.g, 'town');
    assert.ok(isSafe(map, n.x, n.z));
    // everybody looks at the plaza: guards straight down their road, the others at the fountain
    const ahead = n.kind === 'guard' ? 22.2 : Math.hypot(n.x, n.z);
    const x = n.x + Math.sin(n.ry) * ahead, z = n.z + Math.cos(n.ry) * ahead;
    assert.ok(Math.hypot(x, z) <= (n.kind === 'guard' ? 3.41 : 0.01), `the ${n.kind} at ${n.x}, ${n.z} looks away from the plaza`);
  }
});

test('391 monsters: camps in three zones and the boss', () => {
  assert.equal(spawnCount(map), 391);
  const bosses = map.spawns.filter(hasBoss);
  assert.equal(bosses.length, 1);
  assert.deepEqual(bosses[0], { types: { boss: 1 }, lvl: [18, 18], x: 0, z: -228, r: 0, count: 1, respawn: 90, g: 'fortress' });
  assert.equal(map.spawns.at(-1), bosses[0]);   // written last
  const ZONES = {
    'Green Meadows': { mobs: 110, types: { chaser: 3, runner: 2 }, camp: 4 },
    'Graveyard Wastes': { mobs: 130, types: { chaser: 1, runner: 1, shooter: 2 }, camp: 6 },
    'Cursed Lands': { mobs: 150, types: { chaser: 1, runner: 1, shooter: 1, tank: 2 }, camp: 6 },
  };
  const mobs = {};
  for (const s of map.spawns.slice(0, -1)) {
    const region = regionAt(map, s.x, s.z), zone = ZONES[region.name];
    assert.ok(zone, `a camp stands in ${region.name}`);
    mobs[region.name] = (mobs[region.name] || 0) + s.count;
    assert.deepEqual(s.types, zone.types);
    assert.ok(s.count >= 1 && s.count <= zone.camp);
    assert.ok(s.r >= 10 && s.r <= 16);
    assert.ok(region.levels[0] <= s.lvl[0] && s.lvl[0] <= s.lvl[1] && s.lvl[1] <= region.levels[1]);
    assert.equal(s.respawn, 14);
    assert.equal(s.g, null);
    // the whole camp lies in its zone, 4 units clear of its borders, and the fortress belongs to the King
    const d = Math.hypot(s.x, s.z), inner = Math.max(...map.regions.map((r) => r.shape.r).filter((r) => r < region.shape.r));
    assert.ok(d - s.r >= inner + 4 - 0.02 && d + s.r <= region.shape.r - 4 + 0.02);
    assert.ok(Math.hypot(s.x, s.z + 228) >= 26 + 4 + s.r - 0.02);
  }
  assert.deepEqual(mobs, { 'Green Meadows': 110, 'Graveyard Wastes': 130, 'Cursed Lands': 150 });
  // the distance gradient survives: the meadows still have level-1 camps near the town
  assert.ok(map.spawns.some((s) => s.lvl[0] === 1) && map.spawns.some((s) => s.lvl[1] === 15));
});

// ---------------------------------------------------------------- scenery

test('hand-built structures: the exact piece counts', () => {
  const counts = tally(map.objects, (o) => o.m);
  const EXACT = {
    'medieval/wall_straight': 24, 'medieval/wall_straight_gate': 4,
    'halloween/crypt': 6, 'halloween/arch': 8, 'halloween/pillar': 24, 'halloween/post_lantern': 20, 'halloween/post_skull': 14,
    'dungeon/wall': 7, 'dungeon/wall_pillar': 5, 'dungeon/torch_mounted': 8, 'dungeon/banner_red': 5, 'dungeon/sword_shield_gold': 3,
    'dungeon/pillar_decorated': 2,
    'builtin/fountain': 1, 'builtin/crystal': 1, 'builtin/lamp_post': 8, 'builtin/lair_ring': 1,
  };
  for (const [m, n] of Object.entries(EXACT)) assert.equal(counts[m], n, m);
  const P = plots.length;
  assert.ok(P >= 1 && P <= 18);
  assert.equal(counts['halloween/fence'] + counts['halloween/fence_broken'], 15 * P);
  assert.equal(counts['halloween/fence_pillar'] + counts['halloween/fence_pillar_broken'], 6 * P);
  assert.equal(counts['halloween/plaque_candles'], P);
});

test('scattered scenery: no model exceeds its scatter count, none stands on a road', () => {
  const loose = map.objects.filter((o) => o.g === null), scattered = new Set(SCATTER.map((e) => e.m));
  assert.equal(scattered.size, SCATTER.length);
  for (const { m, most, road } of SCATTER) {
    const list = ofModel(m, loose);
    assert.ok(list.length >= 1 && list.length <= most, `${m}: ${list.length} scattered copies, at most ${most} were drawn`);
    // 2.6 was the narrowest road strip of the old world (grass and flowers); every model kept at least 3.6 clear
    for (const o of list) assert.ok(Math.min(Math.abs(o.x), Math.abs(o.z)) >= road, `${m} at ${o.x}, ${o.z} stands in the road strip`);
  }
  assert.ok(ofModel('medieval/tree_single_A').length <= 320 && ofModel('builtin/spike').length <= 620);
  // the hand-built pieces without a group: 12 landmarks, 6 props beside them, 8 arches, 34 road posts
  assert.equal(loose.filter((o) => !scattered.has(o.m)).length, 12 + 6 + 8 + 34);
  assert.ok(map.objects.length > 4000);
});

test('groups: the town, its wall, the cemetery plots, the crypts and the fortress', () => {
  const members = (g) => tally(groupItems(map, g), (e) => (e.kind === 'object' ? e.item.m : e.kind));
  const town = members('town');
  assert.equal(groupItems(map, 'town').length, 1 + 1 + 8 + 8 + 16 + 11);
  assert.equal(town.npc, 11);
  assert.deepEqual([town['builtin/fountain'], town['builtin/crystal'], town['builtin/lamp_post']], [1, 1, 8]);
  assert.equal(inGroup('town').filter((o) => o.m.startsWith('medieval/building_')).length, 8);
  assert.deepEqual(members('town-wall'), { 'medieval/wall_straight': 24, 'medieval/wall_straight_gate': 4 });

  assert.deepEqual(plots, plots.map((_, i) => `plot-${String(i + 1).padStart(2, '0')}`));   // numbered in plot order, no gaps
  for (const g of plots) {
    const c = members(g), n = (m) => c[`halloween/${m}`] || 0;
    assert.equal(n('fence') + n('fence_broken'), 15, g);
    assert.equal(n('fence_pillar') + n('fence_pillar_broken'), 6, g);
    assert.deepEqual([n('grave_A'), n('grave_B'), n('grave_A_destroyed'), n('plaque_candles'), n('lantern_standing')], [4, 4, 2, 1, 2], g);
    assert.ok(n('pumpkin_orange_jackolantern') <= 1, g);
    assert.equal(groupItems(map, g).length, 34 + n('pumpkin_orange_jackolantern'), g);
  }
  for (let i = 1; i <= 6; i++) {
    assert.deepEqual(members(`crypt-${i}`), { 'halloween/crypt': 1, 'halloween/pillar': 4, 'halloween/lantern_standing': 2,
      'halloween/skull_candle': 2, 'halloween/shrine_candles': 1 });
  }

  const fortress = groupItems(map, 'fortress');
  assert.equal(fortress.filter((e) => e.kind === 'spawn' && hasBoss(e.item)).length, 1);
  assert.equal(fortress.filter((e) => e.kind === 'chest' && e.item.big).length, 1);
  assert.deepEqual(members('fortress'), {
    'dungeon/wall': 7, 'dungeon/wall_pillar': 5, 'dungeon/wall_cracked': 7, 'dungeon/wall_broken': 3, 'dungeon/rubble_large': 2,
    'dungeon/banner_red': 5, 'dungeon/sword_shield_gold': 3, 'dungeon/torch_mounted': 8,
    'dungeon/pillar_decorated': 2, 'dungeon/barrel_large': 1, 'dungeon/crates_stacked': 1, 'dungeon/pillar': 8,
    'dungeon/coin_stack_large': 1, 'dungeon/coin_stack_medium': 1, 'dungeon/coin_stack_small': 2, 'dungeon/sword_shield_broken': 1,
    'builtin/lair_ring': 1, spawn: 1, chest: 1,
  });

  const groups = new Set(['object', 'spawn', 'chest', 'npc'].flatMap((kind) => map[COLLECTION[kind]].map((it) => it.g)).filter((g) => g !== null));
  assert.deepEqual([...groups].sort(), ['crypt-1', 'crypt-2', 'crypt-3', 'crypt-4', 'crypt-5', 'crypt-6', 'fortress', ...plots, 'town', 'town-wall']);
});

test('per-object overrides: fortress colliders, raised pieces, the hoard, plot pumpkins', () => {
  const fortress = inGroup('fortress');
  const ruined = [...ofModel('dungeon/wall_broken', fortress), ...ofModel('dungeon/wall_cracked', fortress)];
  assert.equal(ruined.length, 10);
  for (const o of ruined) assert.deepEqual(o.col, row(0.77, -2, 0, 2));
  for (const o of ofModel('dungeon/rubble_large', fortress)) assert.deepEqual(o.col, row(1.53, -4, 0, 4));
  assert.deepEqual(ofModel('dungeon/pillar', fortress).map((o) => o.col), new Array(8).fill(row(0.73, 0)));
  assert.deepEqual(ofModel('dungeon/torch_mounted', fortress).map((o) => o.y), new Array(8).fill(3.3));
  assert.deepEqual(ofModel('dungeon/sword_shield_gold', fortress).map((o) => o.y), [3.6, 3.6, 3.6]);
  const hoard = ['coin_stack_large', 'coin_stack_medium', 'coin_stack_small', 'sword_shield_broken'].flatMap((name) => ofModel(`dungeon/${name}`, fortress));
  assert.deepEqual(hoard.map((o) => o.s), [1.2, 1.3, 1.3, 1.1, 1.3]);
  assert.deepEqual(hoard.map((o) => o.y), [0, 0, 0, 0, 1]);
  const pumpkins = ofModel('halloween/pumpkin_orange_jackolantern').filter((o) => o.g !== null);
  assert.ok(pumpkins.length >= 1 && pumpkins.every((o) => PLOT.test(o.g) && o.col === 0));

  // and nothing else is overridden: every other piece takes its collider from the catalog and stands on the ground
  assert.equal(map.objects.filter((o) => o.col !== null).length, 10 + 2 + 8 + pumpkins.length);
  assert.equal(map.objects.filter((o) => o.y !== 0).length, 8 + 3 + 1);   // bones and ribcages are lifted by the catalog
  assert.ok(map.objects.every((o) => o.rx === 0 && o.rz === 0 && o.sy === 1));
  assert.ok(ofModel('halloween/lantern_standing').every((o) => o.s === 1));
  assert.ok(ofModel('medieval/wall_straight').every((o) => o.s === 0.574));   // 2 decimals would open a gap at every joint
});

test('the fortress wall is closed except for its gate', () => {
  const WALLS = ['dungeon/wall', 'dungeon/wall_pillar', 'dungeon/wall_broken', 'dungeon/wall_cracked', 'dungeon/rubble_large'];
  const ring = inGroup('fortress').filter((o) => WALLS.includes(o.m));
  assert.equal(ring.length, 24);
  // wall pieces block with circles, which need no footprint; walk them round the ring, starting just past the gate (south)
  const circles = ring.flatMap((o) => colliderOf(o, modelInfo(o.m), null).circles);
  assert.equal(circles.length, 72);
  const angle = (c) => (Math.atan2(c.z + 228, c.x) - Math.PI / 2 + 4 * Math.PI) % (2 * Math.PI);
  circles.sort((a, b) => angle(a) - angle(b));
  const gap = (a, b) => Math.hypot(a.x - b.x, a.z - b.z) - a.r - b.r;
  for (let i = 1; i < circles.length; i++) assert.ok(gap(circles[i - 1], circles[i]) < 0.8, 'a cat (0.8 units wide) fits through the ring wall');
  assert.ok(gap(circles.at(-1), circles[0]) > 10, 'the gate is shut');
});
