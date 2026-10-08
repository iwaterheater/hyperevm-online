// The numbers behind the Spawns panel and the Spawn tool (src/editor/spawnstats.js): the rows of the table, the totals
// per region, the level band "Set from spawns" writes, Populate, sorting, filtering and the camp template - and, at the
// end, the gestures of the four marker tools (Spawn, Chest, NPC, Start point), driven without a page: a tool only needs
// a store, a `ui`, the commands and the Hit the viewport would hand it.
// Maps are built with emptyMap() and cmd.make(): nothing here reads map/world.json, and nothing needs a browser.
// Run: node --test test/spawnstats.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { MOB_KEYS, MOB_TYPES, WANDER_R, AGGRO_R, BOSS_AGGRO_R } from '../src/shared.js';
import { GROUND_INDEX, LIMITS, cellIndex, emptyMap, isBlocked, isSafe, regionAt, serialize, spawnCount, stringifyMap, validate } from '../src/map/format.js';
import * as cmd from '../src/editor/commands.js';
import { typesPatch } from '../src/editor/fields.js';
import { createStore } from '../src/editor/store.js';
import { createUi } from '../src/editor/state.js';
import {
  SORT_KEYS, SPAWN_PRESETS, campColor, campText, cleanTemplate, dominantType, expectedByType, filterRows, levelColor, levelsFromSpawns,
  holdRows, levelText, mixText, parseFilter, populate, sameTemplate, shortName, sortRows, spawnRows, templateOf, threatOf, totalsByRegion, typeKeys,
} from '../src/editor/spawnstats.js';
import createSpawnTool from '../src/editor/tools/spawn.js';
import createChestTool from '../src/editor/tools/chest.js';
import createNpcTool from '../src/editor/tools/npc.js';
import createStartTool from '../src/editor/tools/start.js';

// ---------------------------------------------------------------- helpers

// A repeatable random source (mulberry32).
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const circle = (name, r, props = {}) => cmd.make('region', { name, shape: { type: 'circle', x: 0, z: 0, r }, ...props });
const camp = (x, z, props = {}) => cmd.make('spawn', { x, z, ...props });
const bytes = (map) => stringifyMap(serialize(map, { check: false }));

// The layout of the game's island in small: three nested lands and a safe town in the middle, later regions winning.
function island() {
  const map = emptyMap();
  const cursed = circle('Cursed Lands', 260, { levels: [10, 15], mood: 'cursed' });
  const wastes = circle('Graveyard Wastes', 175, { levels: [5, 9], mood: 'graveyard' });
  const meadows = circle('Green Meadows', 95, { levels: [1, 4], mood: 'meadow' });
  const town = circle('Hypercat Town', 24, { safe: true, mood: 'meadow' });
  map.regions.push(cursed, wastes, meadows, town);
  return { map, cursed, wastes, meadows, town };
}

// The island with a handful of camps: two in the meadows, one in the wastes, two in the cursed lands (one the boss).
function populated() {
  const w = island();
  w.a = camp(50, 0, { types: { chaser: 3, runner: 2 }, lvl: [1, 3], count: 4, r: 16 });
  w.b = camp(0, 60, { types: { chaser: 1 }, lvl: [2, 4], count: 2, r: 10 });
  w.c = camp(-130, 0, { types: { chaser: 1, runner: 1, shooter: 2 }, lvl: [6, 8], count: 6, r: 16 });
  w.d = camp(0, -200, { types: { chaser: 1, runner: 1, shooter: 1, tank: 2 }, lvl: [11, 13], count: 5, r: 16 });
  w.boss = camp(0, -228, { types: { boss: 1 }, lvl: [18, 18], count: 1, r: 0, respawn: 90 });
  w.map.spawns.push(w.a, w.b, w.c, w.d, w.boss);
  return w;
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
// fields of one camp, written as a command would write them (the map is not in a store here)
const write = (spawn, patch) => { Object.assign(spawn, patch); };

// ---------------------------------------------------------------- one camp

test('expectedByType: count x weight / the sum of the weights, in MOB_KEYS order', () => {
  const e = expectedByType({ types: { runner: 2, chaser: 3 }, count: 4 });
  assert.deepEqual(Object.keys(e), ['chaser', 'runner']);
  assert.ok(near(e.chaser, 2.4) && near(e.runner, 1.6));
  assert.deepEqual(expectedByType({ types: { boss: 1 }, count: 1 }), { boss: 1 });
  assert.deepEqual(expectedByType({ types: {}, count: 3 }), {});
  assert.deepEqual(expectedByType({ types: { chaser: 0 }, count: 3 }), {});     // a weight of 0 is "absent"
});

test('typeKeys, mixText, levelText, campText, threatOf: how a camp reads', () => {
  assert.deepEqual(typeKeys({ tank: 1, chaser: 2, runner: 0 }), ['chaser', 'tank']);
  assert.equal(mixText({ chaser: 1 }), 'Skeleton Minion');
  assert.equal(mixText({ runner: 2, chaser: 3 }), 'Minion 3 : Rogue 2', 'a mix in the names every panel uses, not in the keys of the file');
  assert.equal(mixText({}), 'no monsters');
  assert.equal(levelText([3, 3]), 'Lv 3');
  assert.equal(levelText([1, 2]), 'Lv 1–2');
  assert.equal(campText(camp(0, 0, { types: { chaser: 1 }, lvl: [1, 2], count: 4 })), '4× Skeleton Minion · Lv 1–2 · 14 s');
  assert.equal(threatOf(camp(0, 0, { r: 8 })), 8 + WANDER_R + AGGRO_R);                       // "a disc of r 8 really threatens r 26"
  assert.equal(threatOf(camp(0, 0, { r: 0, types: { boss: 1 } })), WANDER_R + BOSS_AGGRO_R);
});

test('dominantType, levelColor, campColor: the colour a camp is drawn in', () => {
  assert.equal(dominantType({ chaser: 3, runner: 2 }), 'chaser');
  assert.equal(dominantType({ chaser: 1, runner: 1, shooter: 1, tank: 2 }), 'tank');
  assert.equal(dominantType({ runner: 2, chaser: 2 }), 'chaser');               // a tie: MOB_KEYS order
  assert.equal(dominantType({}), null);
  assert.equal(campColor({ types: { chaser: 3, runner: 2 }, lvl: [1, 2] }), MOB_TYPES.chaser.color);
  assert.equal(campColor({ types: {}, lvl: [1, 2] }), 0xffffff);
  // by level: green at 1, yellow half way, red from 20 on
  assert.equal(levelColor([1, 1]), 0x20df20);
  assert.equal(levelColor([10, 11]), 0xdfdf20);
  assert.equal(levelColor([20, 20]), 0xdf2020);
  assert.equal(levelColor([60, 99]), 0xdf2020);
  assert.equal(campColor({ types: { boss: 1 }, lvl: [20, 20] }, true), 0xdf2020);
});

// ---------------------------------------------------------------- the template

test('cleanTemplate: every value inside LIMITS, owned by the result, never without a monster', () => {
  const src = { types: { runner: 2.4, chaser: 300, tank: 0, goblin: 5 }, lvl: [9, 2], count: 99, r: 500, respawn: 1 };
  const t = cleanTemplate(src);
  assert.deepEqual(t, { types: { chaser: 100, runner: 2 }, lvl: [2, 9], count: 30, r: 80, respawn: 3 });
  assert.notEqual(t.types, src.types);
  assert.deepEqual(cleanTemplate({}), { types: { [MOB_KEYS[0]]: 1 }, lvl: [1, 1], count: 3, r: 8, respawn: 14 });
  assert.deepEqual(cleanTemplate(null).types, { [MOB_KEYS[0]]: 1 });
  assert.deepEqual(cleanTemplate({ types: { boss: 1 }, lvl: [18, 18], count: 1, r: 0, respawn: 90 }),
    { types: { boss: 1 }, lvl: [18, 18], count: 1, r: 0, respawn: 90 });     // a radius of 0 is a legal camp (the boss)
});

test('templateOf / sameTemplate: a camp compared by its five settings, not by its place', () => {
  const a = camp(10, 20, { types: { chaser: 3, runner: 2 }, lvl: [1, 3], count: 4, r: 16 });
  const b = camp(-50, 7, { types: { runner: 2, chaser: 3 }, lvl: [1, 3], count: 4, r: 16, g: 'camp' });
  assert.ok(sameTemplate(templateOf(a), templateOf(b)));
  assert.ok(!sameTemplate(templateOf(a), templateOf(camp(0, 0, { types: { chaser: 3, runner: 2 }, lvl: [1, 3], count: 5, r: 16 }))));
  assert.ok(!sameTemplate(templateOf(a), templateOf(camp(0, 0, { types: { chaser: 3 }, lvl: [1, 3], count: 4, r: 16 }))));
  assert.deepEqual(Object.keys(templateOf(a)), ['types', 'lvl', 'count', 'r', 'respawn']);
});

test('SPAWN_PRESETS: every preset is a clean template that makes a camp without errors', () => {
  const ids = new Set();
  for (const preset of SPAWN_PRESETS) {
    assert.ok(preset.id && preset.label && !ids.has(preset.id));
    ids.add(preset.id);
    assert.deepEqual(cleanTemplate(preset.template), preset.template, preset.id);
    const { map } = island();
    map.spawns.push(cmd.make('spawn', { ...preset.template, x: 0, z: 120 }));
    assert.deepEqual(validate(map).filter((i) => i.level === 'error'), [], preset.id);
  }
  // the boss rule of the editor agrees with the boss preset: a camp turned into the boss alone takes its respawn
  const boss = SPAWN_PRESETS.find((p) => p.id === 'boss').template;
  assert.deepEqual(typesPatch({ types: { chaser: 1 }, respawn: 14 }, boss.types), { types: { boss: 1 }, respawn: boss.respawn });
});

// ---------------------------------------------------------------- rows

test('spawnRows: one row per camp in map order, with the region that wins at its centre', () => {
  const { map, meadows, wastes, cursed, a, b, c, d, boss } = populated();
  const rows = spawnRows(map);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r.spawn), [a, b, c, d, boss]);
  assert.deepEqual(rows.map((r) => r.index), [0, 1, 2, 3, 4]);
  assert.deepEqual(rows.map((r) => r.region), [meadows, meadows, wastes, cursed, cursed]);
  for (const row of rows) assert.equal(row.region, regionAt(map, row.spawn.x, row.spawn.z));
  assert.deepEqual(Object.keys(rows[0]), ['spawn', 'index', 'region', 'types', 'lvl', 'count', 'r', 'respawn']);
  assert.deepEqual([rows[0].types, rows[0].lvl, rows[0].count, rows[0].r, rows[0].respawn], [{ chaser: 3, runner: 2 }, [1, 3], 4, 16, 14]);
});

test('spawnRows: a row is a snapshot - changing it does not reach the map; outside every region is the fallback', () => {
  const { map, a } = populated();
  const before = bytes(map), rows = spawnRows(map);
  rows[0].types.boss = 9;
  rows[0].lvl[0] = 50;
  assert.equal(bytes(map), before);
  assert.deepEqual(a.lvl, [1, 3]);
  const bare = emptyMap();
  bare.spawns.push(camp(100, 0));
  assert.equal(spawnRows(bare)[0].region, bare.fallback);
  assert.deepEqual(spawnRows(emptyMap()), []);
});

// ---------------------------------------------------------------- totals

test('totalsByRegion: every region in file order, then the fallback; the monsters add up to spawnCount', () => {
  const { map, cursed, wastes, meadows, town } = populated();
  const totals = totalsByRegion(map);
  assert.deepEqual(totals.map((t) => t.region), [cursed, wastes, meadows, town, map.fallback]);
  assert.deepEqual(totals.map((t) => t.monsters), [6, 6, 6, 0, 0]);
  assert.deepEqual(totals.map((t) => t.camps), [2, 1, 2, 0, 0]);
  assert.equal(totals.reduce((n, t) => n + t.monsters, 0), spawnCount(map));
  assert.equal(spawnCount(map), 18);
});

test('totalsByRegion: expected monsters by type and the real level range, a boss included', () => {
  const { map } = populated();
  const [cursed, wastes, meadows, town, fallback] = totalsByRegion(map);
  // meadows: 4 x {3, 2} + 2 x {1}
  assert.deepEqual(Object.keys(meadows.byType), ['chaser', 'runner']);
  assert.ok(near(meadows.byType.chaser, 2.4 + 2) && near(meadows.byType.runner, 1.6));
  assert.deepEqual(meadows.lvl, [1, 4]);
  // wastes: 6 x {1, 1, 2}
  assert.ok(near(wastes.byType.chaser, 1.5) && near(wastes.byType.runner, 1.5) && near(wastes.byType.shooter, 3));
  assert.deepEqual(wastes.lvl, [6, 8]);
  // cursed: 5 x {1, 1, 1, 2} + the boss
  assert.deepEqual(Object.keys(cursed.byType), ['chaser', 'runner', 'shooter', 'tank', 'boss']);
  assert.ok(near(cursed.byType.tank, 2) && near(cursed.byType.boss, 1));
  assert.deepEqual(cursed.lvl, [11, 18]);
  for (const t of [cursed, wastes, meadows]) assert.ok(near(Object.values(t.byType).reduce((a, b) => a + b, 0), t.monsters));
  assert.deepEqual([town.byType, town.lvl, fallback.byType, fallback.lvl], [{}, null, {}, null]);
});

test('totalsByRegion: a map without regions puts everything on the fallback', () => {
  const map = emptyMap();
  map.spawns.push(camp(10, 0, { count: 7 }), camp(-40, 30, { count: 2 }));
  const totals = totalsByRegion(map);
  assert.equal(totals.length, 1);
  assert.equal(totals[0].region, map.fallback);
  assert.equal(totals[0].monsters, 9);
  assert.deepEqual(totalsByRegion(emptyMap()), [{ region: emptyMap().fallback, camps: 0, monsters: 0, byType: {}, lvl: null }]);
});

// ---------------------------------------------------------------- levels from spawns

test('levelsFromSpawns: the band of the camps a region wins - not of everything its shape contains', () => {
  const { map, cursed, wastes, meadows, town } = populated();
  assert.deepEqual(levelsFromSpawns(map, meadows), [1, 4]);
  assert.deepEqual(levelsFromSpawns(map, wastes), [6, 8]);
  assert.equal(levelsFromSpawns(map, town), null);
  assert.equal(levelsFromSpawns(map, map.fallback), null);
  // "Cursed Lands" covers the whole island, yet only the outer ring is its own - and the boss does not stretch the band
  assert.deepEqual(levelsFromSpawns(map, cursed), [11, 13]);
});

test('levelsFromSpawns: a region with nothing but the boss takes the boss, and what it writes raises no spawn-levels', () => {
  const { map, cursed, wastes, meadows, d } = populated();
  map.spawns.splice(map.spawns.indexOf(d), 1);
  assert.deepEqual(levelsFromSpawns(map, cursed), [18, 18]);
  map.spawns.push(d);
  for (const region of [cursed, wastes, meadows]) region.levels = levelsFromSpawns(map, region);
  assert.deepEqual(validate(map).filter((i) => i.code === 'spawn-levels'), []);
  assert.equal(levelsFromSpawns(map, cmd.make('region', { name: 'Elsewhere' })), null);     // a region that is not in the map
});

// ---------------------------------------------------------------- sorting and filtering

test('sortRows: by every column, both ways, ties in map order; the input is left alone', () => {
  const { map, a, b, c, d, boss } = populated();
  const rows = spawnRows(map), order = (key, dir) => sortRows(rows, key, dir).map((r) => r.spawn);
  assert.deepEqual(order('index', 1), [a, b, c, d, boss]);
  assert.deepEqual(order('index', -1), [boss, d, c, b, a]);
  assert.deepEqual(order('count', 1), [boss, b, a, d, c]);
  assert.deepEqual(order('count', -1), [c, d, a, b, boss]);
  assert.deepEqual(order('lvl', 1), [a, b, c, d, boss]);
  assert.deepEqual(order('r', 1), [boss, b, a, c, d]);           // a, c, d tie at 16: map order
  assert.deepEqual(order('respawn', -1), [boss, d, c, b, a]);
  assert.deepEqual(order('region', 1), [d, boss, c, a, b]);      // Cursed Lands, Graveyard Wastes, Green Meadows
  assert.deepEqual(order('types', 1), [b, a, c, d, boss]);       // the strongest monster of the mix decides
  assert.deepEqual(order('no-such-column', 1), [a, b, c, d, boss]);
  assert.deepEqual(rows.map((r) => r.spawn), [a, b, c, d, boss]);
  assert.ok(SORT_KEYS.includes('region') && SORT_KEYS.includes('respawn'));
});

test('parseFilter / filterRows: words on the region and the monsters, level terms, one region', () => {
  const { map, meadows, a, b, c, d, boss } = populated();
  const rows = spawnRows(map), pick = (filter) => filterRows(rows, filter).map((r) => r.spawn);
  assert.deepEqual(parseFilter('  Meadow lv5-9 LV3 mage '), { words: ['meadow', 'mage'], levels: [[5, 9], [3, 3]] });
  assert.deepEqual(pick({}), [a, b, c, d, boss]);
  assert.deepEqual(pick({ text: 'meadow' }), [a, b]);
  assert.deepEqual(pick({ text: 'RUNNER' }), [a, c, d]);
  assert.deepEqual(pick({ text: 'king' }), [boss]);                 // the name of the monster, not only its id
  assert.deepEqual(pick({ text: 'cursed tank' }), [d]);             // every word must match
  assert.deepEqual(pick({ text: 'lv3' }), [a, b]);
  assert.deepEqual(pick({ text: 'lv7-12' }), [c, d]);
  assert.deepEqual(pick({ text: 'lv12–20 cursed' }), [d, boss]);
  assert.deepEqual(pick({ region: meadows }), [a, b]);
  assert.deepEqual(pick({ region: meadows, text: 'runner' }), [a]);
  assert.deepEqual(pick({ text: 'dragon' }), []);
  assert.notEqual(filterRows(rows, {}), rows);                      // always a new array
});

test('holdRows: while a value is typed the rows keep their places - whatever the sort and the filter say now', () => {
  const { map, meadows, a, b, c, d, boss } = populated();
  const sorted = () => sortRows(spawnRows(map), 'count', -1), spawns = (rows) => rows.map((r) => r.spawn);
  assert.deepEqual(spawns(sorted()), [c, d, a, b, boss]);
  const held = spawns(sorted());                      // the editor opens on camp c (count 6), the table sorted by N
  // "12" is typed: after the "1" the map has count 1, and the sort would send the row to the end
  write(c, { count: 1 });
  assert.deepEqual(spawns(sorted()), [d, a, b, boss, c], 'what the sort alone would do between two keys');
  assert.deepEqual(spawns(holdRows(spawnRows(map), sorted(), held, [c])), [c, d, a, b, boss], 'the row stays where it was');
  assert.equal(holdRows(spawnRows(map), sorted(), held, [c])[0].count, 1, 'and it is the row of the map as it is now');
  write(c, { count: 12 });
  assert.deepEqual(spawns(holdRows(spawnRows(map), sorted(), held, [c])), [c, d, a, b, boss]);

  // a filter that no longer matches the camp under edit does not take its row away; the others obey it
  const filtered = filterRows(spawnRows(map), { region: meadows });
  assert.deepEqual(spawns(filtered), [a, b]);
  assert.deepEqual(spawns(holdRows(spawnRows(map), filtered, held, [c])), [c, a, b]);
  assert.deepEqual(spawns(holdRows(spawnRows(map), filtered, held, [])), [a, b]);

  // a camp that has gone leaves, one that appeared meanwhile is put after the held rows
  map.spawns.splice(map.spawns.indexOf(d), 1);
  const fresh = camp(10, 10, { count: 9 });
  map.spawns.push(fresh);
  assert.deepEqual(spawns(holdRows(spawnRows(map), sorted(), held, [c])), [c, a, b, boss, fresh]);
  assert.deepEqual(spawns(holdRows(spawnRows(map), sorted(), [], [])), spawns(sorted()), 'nothing held: the table as sorted');
});

test('shortName: the one word a monster type is called by, never the key of the file', () => {
  assert.deepEqual(MOB_KEYS.slice(0, 5).map(shortName), ['Minion', 'Rogue', 'Mage', 'Warrior', 'King']);
  assert.equal(campText({ types: { chaser: 3, shooter: 1 }, lvl: [6, 8], count: 5, respawn: 14 }), '5× Minion 3 : Mage 1 · Lv 6–8 · 14 s');
  assert.equal(campText({ types: { boss: 1 }, lvl: [18, 18], count: 1, respawn: 90 }), '1× Skeleton King · Lv 18 · 90 s');
});

// ---------------------------------------------------------------- populate

const TEMPLATE = { types: { chaser: 3, runner: 2 }, lvl: [1, 3], count: 4, r: 12, respawn: 14 };

test('populate: n new camps inside the region it was asked for, copies of the template, the map untouched', () => {
  const { map, meadows } = island();
  const before = bytes(map);
  const camps = populate(map, meadows, { n: 8, spacing: 30, template: TEMPLATE, rnd: seeded(1) });
  assert.equal(camps.length, 8);
  assert.equal(bytes(map), before);
  assert.equal(map.spawns.length, 0);
  for (const s of camps) {
    assert.equal(regionAt(map, s.x, s.z), meadows);
    assert.ok(!isSafe(map, s.x, s.z));
    assert.deepEqual(templateOf(s), TEMPLATE);
    assert.notEqual(s.types, TEMPLATE.types);
    assert.notEqual(s.lvl, TEMPLATE.lvl);
    assert.equal(s.g, null);
    assert.ok(Math.hypot(s.x, s.z) - s.r > 24 + WANDER_R - 1e-9);     // disc and strolling margin stay out of the town
  }
  assert.equal(new Set(camps.map((s) => s.types)).size, 8);           // every camp owns its values
  // the same seed, the same layout
  assert.deepEqual(populate(map, meadows, { n: 8, spacing: 30, template: TEMPLATE, rnd: seeded(1) }), camps);
  assert.notDeepEqual(populate(map, meadows, { n: 8, spacing: 30, template: TEMPLATE, rnd: seeded(2) }), camps);
});

test('populate: what it returns can be added with one command and leaves the map valid', () => {
  const { map, wastes } = island();
  const camps = populate(map, wastes, { n: 12, spacing: 34, template: { ...TEMPLATE, lvl: [6, 8] }, rnd: seeded(7) });
  assert.equal(camps.length, 12);
  cmd.add('spawn', camps).do(map);
  assert.equal(map.spawns.length, 12);
  const issues = validate(map);
  assert.deepEqual(issues.filter((i) => i.level === 'error'), []);
  assert.deepEqual(issues.filter((i) => ['spawn-near-safe', 'spawn-blocked', 'spawn-unplaceable', 'spawn-levels'].includes(i.code)), []);
  assert.deepEqual(totalsByRegion(map).map((t) => t.monsters), [0, 48, 0, 0, 0]);
});

test('populate: minimum spacing between the new camps and to the camps that are already there', () => {
  const { map, meadows } = island();
  map.spawns.push(camp(60, 0), camp(-60, 0), camp(0, 60));
  const camps = populate(map, meadows, { n: 10, spacing: 28, template: TEMPLATE, rnd: seeded(3) });
  assert.ok(camps.length >= 4);
  const all = [...map.spawns, ...camps];
  for (const s of camps) {
    for (const o of all) if (o !== s) assert.ok(Math.hypot(s.x - o.x, s.z - o.z) >= 28, `camps ${s.x},${s.z} and ${o.x},${o.z} are too close`);
  }
  // without a spacing, discs and their strolling margins do not overlap
  const loose = populate(map, meadows, { n: 6, template: TEMPLATE, rnd: seeded(3) });
  for (const s of loose) for (const o of [...map.spawns, ...loose]) if (o !== s) assert.ok(Math.hypot(s.x - o.x, s.z - o.z) >= 2 * (12 + WANDER_R));
});

test('populate: a keep-out around chests, NPCs and the start disc', () => {
  const { map, meadows } = island();
  map.start = { x: 60, z: 0, r: 6 };
  map.chests.push(cmd.make('chest', { x: -60, z: 0 }), cmd.make('chest', { x: 0, z: -60 }));
  map.npcs.push(cmd.make('npc', { x: 0, z: 60 }), cmd.make('npc', { x: 45, z: 45 }));
  const camps = populate(map, meadows, { n: 40, spacing: 0, template: TEMPLATE, keepOut: 9, rnd: seeded(11) });
  assert.equal(camps.length, 40);                                     // spacing 0: camps may overlap, so all of them fit
  for (const s of camps) {
    for (const p of [...map.chests, ...map.npcs]) assert.ok(Math.hypot(s.x - p.x, s.z - p.z) >= s.r + 9);
    assert.ok(Math.hypot(s.x - map.start.x, s.z - map.start.z) >= map.start.r + s.r + 9);
  }
  // keepOut 0 still keeps a chest out of the disc itself
  const tight = populate(map, meadows, { n: 40, spacing: 0, template: TEMPLATE, keepOut: 0, rnd: seeded(11) });
  for (const s of tight) for (const p of map.chests) assert.ok(Math.hypot(s.x - p.x, s.z - p.z) >= s.r);
});

test('populate: never on blocked ground, never outside the map, never in a region that is not the winner', () => {
  const { map, cursed } = island();
  const g = map.ground;
  // a lake over the whole east of the island
  for (let i = 0; i < g.cells.length; i++) if ((i % g.size) > (g.size - 1) / 2 + 2) g.cells[i] = GROUND_INDEX.water;
  assert.ok(cellIndex(g, 200, 0) >= 0 && isBlocked(map, 200, 0));
  const camps = populate(map, cursed, { n: 30, spacing: 20, template: TEMPLATE, rnd: seeded(5) });
  assert.ok(camps.length >= 10);
  for (const s of camps) {
    assert.ok(!isBlocked(map, s.x, s.z));
    assert.equal(regionAt(map, s.x, s.z), cursed);
    assert.ok(Math.hypot(s.x, s.z) >= 175, 'not in the lands inside it');
    assert.ok(Math.hypot(s.x, s.z) + s.r <= map.radius - LIMITS.spawnMargin + 1e-9, 'the whole disc inside the map');
  }
});

test('populate: the fallback region - whatever no region covers', () => {
  const map = emptyMap();
  const town = circle('Town', 60, { safe: true });
  map.regions.push(town);
  const camps = populate(map, map.fallback, { n: 6, spacing: 40, template: TEMPLATE, rnd: seeded(9) });
  assert.equal(camps.length, 6);
  for (const s of camps) assert.equal(regionAt(map, s.x, s.z), map.fallback);
  assert.deepEqual(populate(map, town, { n: 6, template: TEMPLATE, rnd: seeded(9) }), []);     // a safe region takes no camp
});

test('populate: fewer than asked when the room runs out, none when there is no room or nothing to do', () => {
  const { map, meadows, town } = island();
  const crowded = populate(map, meadows, { n: 200, spacing: 40, template: TEMPLATE, rnd: seeded(4) });
  assert.ok(crowded.length > 3 && crowded.length < 40, `placed ${crowded.length}`);
  assert.deepEqual(populate(map, meadows, { n: 0, template: TEMPLATE }), []);
  assert.deepEqual(populate(map, meadows, { n: -3, template: TEMPLATE }), []);
  assert.deepEqual(populate(map, meadows, { template: TEMPLATE }), []);
  assert.deepEqual(populate(map, meadows, { n: 5 }), []);
  assert.deepEqual(populate(map, null, { n: 5, template: TEMPLATE }), []);
  assert.deepEqual(populate(map, town, { n: 5, template: TEMPLATE, rnd: seeded(1) }), []);
  assert.deepEqual(populate(map, cmd.make('region', { name: 'Not in the map' }), { n: 5, template: TEMPLATE, rnd: seeded(1) }), []);
  // a camp wider than the island
  const tiny = emptyMap({ radius: 40 });
  assert.deepEqual(populate(tiny, tiny.fallback, { n: 3, template: { ...TEMPLATE, r: 60 }, rnd: seeded(1) }), []);
});

test('populate: the collection cap of the format is respected', () => {
  const map = emptyMap();
  for (let i = 0; i < LIMITS.spawns - 2; i++) map.spawns.push(camp(0, 0, { r: 0, count: 1 }));
  const camps = populate(map, map.fallback, { n: 10, spacing: 0, keepOut: 0, template: { ...TEMPLATE, r: 2 }, rnd: seeded(6) });
  assert.equal(camps.length, 2);
  map.spawns.push(...camps);
  assert.deepEqual(populate(map, map.fallback, { n: 10, spacing: 0, template: TEMPLATE, rnd: seeded(6) }), []);
  assert.deepEqual(validate(map).filter((i) => i.code === 'too-many'), []);
});

test('populate: a template is cleaned first - a bad one still makes legal camps', () => {
  const { map, meadows } = island();
  const camps = populate(map, meadows, { n: 3, spacing: 20, template: { types: { chaser: 0 }, lvl: [5, 2], count: 0, r: 10, respawn: 0 }, rnd: seeded(8) });
  assert.equal(camps.length, 3);
  for (const s of camps) assert.deepEqual(templateOf(s), { types: { chaser: 1 }, lvl: [2, 5], count: 1, r: 10, respawn: 3 });
  cmd.add('spawn', camps).do(map);
  assert.deepEqual(validate(map).filter((i) => i.level === 'error'), []);
});

// ---------------------------------------------------------------- the marker tools, without a page

// The island with a store, a `ui` and the four tools - created BEFORE the map is loaded, as the editor does.
function bench() {
  const w = populated();
  const store = createStore(), ui = createUi({ storage: null }), toasts = [];
  ui.attach({ toast: (text, level) => toasts.push([typeof text === 'string' ? text : text.text, level]) });
  const ctx = { store, ui, cmd, tools: {} };
  ctx.tools.spawn = createSpawnTool(ctx);
  ctx.tools.chest = createChestTool(ctx);
  ctx.tools.npc = createNpcTool(ctx);
  ctx.tools.start = createStartTool(ctx);
  store.load(w.map);
  return { ...w, ctx, store, ui, toasts, tools: ctx.tools };
}
// What a tool reads of a pointer event and of a Hit. Ten pixels per world unit, so a drag leaves the click threshold.
// `type` is what the viewport passes: a release is a 'pointerup'; a press that ends without one (the window lost the
// focus, a tool key) ends with the last event of the press instead.
const ev = (x, z, mods = {}, type = 'pointermove') => ({ type, clientX: x * 10, clientY: z * 10, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: false, ctrlKey: false, buttons: 1 });
const up = (x, z, mods) => ev(x, z, mods, 'pointerup');
const hit = (x, z, extra = {}) => ({ x, z, onGround: true, item: null, kind: null, handle: null, ...extra });
const click = (tool, x, z, extra, mods) => { tool.pointerDown(ev(x, z, mods, 'pointerdown'), hit(x, z, extra)); tool.pointerUp(up(x, z, mods), hit(x, z, extra)); };
const drag = (tool, points, extra, mods) => {
  points.forEach(([x, z], i) => (i === 0 ? tool.pointerDown(ev(x, z, mods, 'pointerdown'), hit(x, z, extra)) : tool.pointerMove(ev(x, z, mods), hit(x, z))));
  const [x, z] = points[points.length - 1];
  tool.pointerUp(up(x, z, mods), hit(x, z));
};

test('marker tools: the contract of a tool - id, layer, picks, context, the handlers', () => {
  const { tools } = bench();
  const expected = { spawn: ['spawns', 'spawn'], chest: ['chests', 'chest'], npc: ['npcs', 'npc'], start: ['start', 'start'] };
  for (const id of Object.keys(expected)) {
    const tool = tools[id];
    assert.deepEqual([tool.id, tool.layer, tool.picks, tool.context, tool.hidden], [id, expected[id][0], [expected[id][1]], 'select', false]);
    assert.ok(typeof tool.label === 'string' && tool.label && typeof tool.icon === 'string' && tool.icon);
    for (const fn of ['activate', 'deactivate', 'pointerDown', 'pointerMove', 'pointerUp', 'doubleClick', 'key', 'options']) assert.equal(typeof tool[fn], 'function', `${id}.${fn}`);
  }
});

test('Spawn tool: a click on free ground adds one camp with the template - one undo step, selected', () => {
  const { store, map, tools: { spawn } } = bench();
  spawn.activate();
  spawn.setTemplate({ types: { chaser: 2, shooter: 1 }, lvl: [6, 8], count: 5, r: 12, respawn: 20 });
  const n = map.spawns.length;
  click(spawn, 120, 60);
  assert.equal(map.spawns.length, n + 1);
  const made = map.spawns[n];
  assert.deepEqual([made.x, made.z, templateOf(made)], [120, 60, { types: { chaser: 2, shooter: 1 }, lvl: [6, 8], count: 5, r: 12, respawn: 20 }]);
  assert.deepEqual([...store.selection], [made]);
  assert.equal(store.undo(), 'Add 1 spawn');
  assert.equal(map.spawns.length, n);
  assert.ok(!store.canUndo);
  // the disc of a camp that is NOT selected is no pick: the viewport hands no item, and the press creates
  const a = map.spawns[0];
  store.clearSelection();
  click(spawn, a.x + a.r / 2, a.z);
  assert.equal(map.spawns.length, n + 1);
  spawn.deactivate();
});

test('Spawn tool: press-drag makes a camp from its centre to its radius as ONE undo step; cancel takes it back', () => {
  const { store, map, tools: { spawn } } = bench();
  spawn.activate();
  spawn.setTemplate({ r: 12, count: 4 });
  const n = map.spawns.length;
  drag(spawn, [[120, 60], [124, 60], [130, 60], [129, 60]]);
  const made = map.spawns[n];
  assert.deepEqual([map.spawns.length, made.x, made.z, made.r, made.count], [n + 1, 120, 60, 9, 4]);
  assert.ok(!store.grouping && store.selection.has(made));
  assert.equal(store.undo(), 'Add 1 spawn');
  assert.deepEqual([map.spawns.length, store.canUndo], [n, false]);
  assert.equal(store.redo(), 'Add 1 spawn');
  assert.deepEqual([map.spawns[n], made.r], [made, 9]);
  // Escape in the middle: the camp is gone, the selection is back, the rest of the press is swallowed
  store.select([map.spawns[0]]);
  spawn.pointerDown(ev(150, 60), hit(150, 60));
  spawn.pointerMove(ev(153, 60), hit(153, 60));
  assert.ok(store.grouping && map.spawns.length === n + 2);
  assert.equal(spawn.key('cancel', {}), true);
  assert.deepEqual([map.spawns.length, store.grouping, [...store.selection]], [n + 1, false, [map.spawns[0]]]);
  spawn.pointerMove(ev(158, 60), hit(158, 60));
  spawn.pointerUp(up(158, 60), hit(158, 60));
  assert.equal(map.spawns.length, n + 1);
  assert.equal(spawn.key('cancel', {}), false);                 // nothing left to cancel: Escape goes on to the next step
  // a drag that hardly leaves the spot is a click with a shaky hand: the camp gets the template's radius
  spawn.setTemplate({ r: 12 });
  drag(spawn, [[170, 60], [170.5, 60]]);
  assert.equal(map.spawns[map.spawns.length - 1].r, 12);
  spawn.deactivate();
});

test('Spawn tool: nothing is created in a safe region, off the island, on a locked or hidden layer, or with Shift', () => {
  const { store, ui, map, toasts, tools: { spawn } } = bench();
  spawn.activate();
  const n = map.spawns.length;
  click(spawn, 5, 5);
  assert.match(toasts.at(-1)[0], /safe region \(Hypercat Town\)/);
  drag(spawn, [[5, 5], [9, 5], [14, 5]]);
  click(spawn, 259, 0);
  assert.match(toasts.at(-1)[0], /Outside the island/);
  click(spawn, 120, 60, { onGround: false });
  ui.set('layers', { ...ui.layers, spawns: { visible: true, locked: true } });
  click(spawn, 120, 60);
  assert.equal(toasts.at(-1)[0], 'Layer locked: spawns');
  ui.set('layers', { ...ui.layers, spawns: { visible: false, locked: false } });
  drag(spawn, [[120, 60], [125, 60], [130, 60]]);
  assert.equal(toasts.at(-1)[0], 'Layer hidden: spawns');
  ui.set('layers', { ...ui.layers, spawns: { visible: true, locked: false } });
  click(spawn, 120, 60, {}, { shift: true });                 // Shift adds to the selection: a miss is not a wish
  assert.deepEqual([map.spawns.length, store.grouping, store.canUndo], [n, false, false]);
  // near the shore the disc is cut to what the island allows - and the template keeps its radius
  spawn.setTemplate({ r: 12 });
  click(spawn, 250, 0);
  assert.deepEqual([map.spawns.length, map.spawns[n].r, spawn.opts.r], [n + 1, 7, 12]);
  assert.deepEqual(validate(map).filter((i) => i.level === 'error'), []);
  // the same with the pointer resting on the spot first and the options strip listening, as in the editor: the strip
  // redraws the ghost whenever the template changes, and that redraw must not eat the radius the click asked for
  spawn.onTemplate(() => spawn.refreshGhost());
  spawn.setTemplate({ r: 16 });
  spawn.pointerMove(ev(250, 20), hit(250, 20));
  click(spawn, 250, 20);
  assert.deepEqual([map.spawns.length, map.spawns[n + 1].r, spawn.opts.r], [n + 2, 6.2, 16]);
  // a shaky click there (a drag that hardly leaves the spot) is that click
  drag(spawn, [[250, -20], [250.5, -20]]);
  assert.deepEqual([map.spawns[n + 2].r, spawn.opts.r], [6.2, 16]);
  // a radius drawn by hand IS what the next camp starts from
  drag(spawn, [[150, 60], [154, 60], [159, 60]]);
  assert.deepEqual([map.spawns[n + 3].r, spawn.opts.r], [9, 9]);
  spawn.deactivate();
});

test('Spawn tool: a press on a camp selects it, a drag moves it, the rim resizes it, Alt copies', () => {
  const { store, map, a, b, tools: { spawn } } = bench();
  spawn.activate();
  const n = map.spawns.length;
  click(spawn, a.x, a.z, { item: a, kind: 'spawn' });
  assert.deepEqual([...store.selection], [a]);
  click(spawn, b.x, b.z, { item: b, kind: 'spawn' }, { shift: true });
  assert.deepEqual(store.selected('spawn'), [a, b]);
  click(spawn, b.x, b.z, { item: b, kind: 'spawn' }, { shift: true });
  assert.deepEqual(store.selected('spawn'), [a]);
  assert.equal(map.spawns.length, n);
  // drag from the pin of a camp that is not selected: it is selected and moved, one step
  store.clearSelection();
  drag(spawn, [[b.x, b.z], [b.x + 4, b.z], [b.x + 10, b.z + 5]], { item: b, kind: 'spawn' });
  assert.deepEqual([b.x, b.z, [...store.selection], store.undoLabel], [10, 65, [b], 'Move 1 spawn']);
  store.undo();
  assert.deepEqual([b.x, b.z], [0, 60]);
  // the rim handle of the selected camp
  store.select([a]);
  drag(spawn, [[a.x + a.r, a.z], [a.x + a.r + 2, a.z], [a.x + 20, a.z]], { item: a, kind: 'spawn', handle: { type: 'radius', index: 0 } });
  assert.deepEqual([a.r, store.undoLabel], [20, 'Resize spawn']);
  store.undo();
  assert.equal(a.r, 16);
  // Alt+drag: a copy is moved, the original stays, one step; Alt+click: the eyedropper
  drag(spawn, [[a.x, a.z], [a.x + 5, a.z], [a.x + 40, a.z + 10]], { item: a, kind: 'spawn' }, { alt: true });
  const copy = map.spawns[n];
  assert.deepEqual([map.spawns.length, copy.x, copy.z, a.x, a.z, templateOf(copy), [...store.selection]], [n + 1, 90, 10, 50, 0, templateOf(a), [copy]]);
  assert.equal(store.undo(), 'Duplicate 1 spawn');
  assert.equal(map.spawns.length, n);
  spawn.setTemplate({ follow: false, count: 9 });
  store.clearSelection();
  click(spawn, a.x, a.z, { item: a, kind: 'spawn' }, { alt: true });
  assert.deepEqual([spawn.opts.count, store.selection.size], [a.count, 0]);
  spawn.deactivate();
});

test('Spawn tool: the template follows the camp selected last, and its later edits - unless Follow is off', () => {
  const { store, a, c, tools: { spawn } } = bench();
  store.select([c]);
  assert.deepEqual(spawn.template(), templateOf(c));
  store.exec(cmd.set([c], { count: 2 }));
  assert.equal(spawn.opts.count, 2);
  spawn.setTemplate({ count: 7 });                              // changed by hand: the camp is let go
  store.exec(cmd.set([c], { count: 3 }));
  assert.equal(spawn.opts.count, 7);
  spawn.setTemplate({ follow: false });
  store.select([a]);
  assert.equal(spawn.opts.count, 7);
  spawn.setTemplate({ follow: true });
  store.select([a, c]);
  assert.deepEqual(spawn.template(), templateOf(c));            // the one that joined the selection
  // opts is a plain object: whatever a script writes into it is cleaned at the next use
  Object.assign(spawn.opts, { count: 500, types: {}, lvl: [9, 3] });
  assert.deepEqual([spawn.template().count, spawn.template().types, spawn.template().lvl], [30, { chaser: 1 }, [3, 9]]);
});

test('Spawn tool: the template copies what a step leaves behind - never the radius 0 a drawn camp starts with', () => {
  const { store, map, a, tools: { spawn } } = bench();
  spawn.activate();
  const n = map.spawns.length;
  // a camp drawn by a drag: the template takes its final radius, and keeps it when the camp is undone
  spawn.setTemplate({ r: 10 });
  drag(spawn, [[150, 60], [154, 60], [158, 60]]);
  assert.deepEqual([map.spawns[n].r, spawn.opts.r], [8, 8]);
  assert.equal(store.undo(), 'Add 1 spawn');
  assert.deepEqual([map.spawns.length, spawn.opts.r], [n, 8]);
  assert.equal(store.redo(), 'Add 1 spawn');
  assert.deepEqual([map.spawns[n].r, spawn.opts.r], [8, 8]);
  store.undo();
  // Escape in the middle of the drag: the template is what it was before the press
  spawn.setTemplate({ r: 10 });
  spawn.pointerDown(ev(150, 60, {}, 'pointerdown'), hit(150, 60));
  spawn.pointerMove(ev(153, 60), hit(153, 60));
  assert.ok(store.grouping && map.spawns[n].r === 3);
  assert.equal(spawn.key('cancel', {}), true);
  spawn.pointerUp(up(153, 60), hit(153, 60));
  assert.deepEqual([map.spawns.length, spawn.opts.r], [n, 10]);
  // a click with a shaky hand, undone - and the next click still makes a camp of radius 10, not a pile on one spot
  drag(spawn, [[150, 60], [150.5, 60]]);
  assert.deepEqual([map.spawns[n].r, spawn.opts.r], [10, 10]);
  store.undo();
  assert.equal(spawn.opts.r, 10);
  click(spawn, 150, 60);
  assert.deepEqual([map.spawns.length, map.spawns[n].r], [n + 1, 10]);
  // an edit of the followed camp that is undone is read again once the undo is whole
  store.select([a]);
  store.exec(cmd.set([a], { r: 20 }));
  assert.equal(spawn.opts.r, 20);
  store.undo();
  assert.deepEqual([a.r, spawn.opts.r], [16, 16]);
  // a rim drag that is cancelled: the strip followed it, and follows it back
  spawn.pointerDown(ev(66, 0, {}, 'pointerdown'), hit(66, 0, { item: a, handle: { type: 'radius' } }));
  spawn.pointerMove(ev(72, 0), hit(72, 0));
  assert.deepEqual([a.r, spawn.opts.r], [22, 22]);
  spawn.key('cancel', {});
  spawn.pointerUp(up(72, 0), hit(72, 0));
  assert.deepEqual([a.r, spawn.opts.r, store.grouping], [16, 16, false]);
  // a selection made inside an open group counts when the group closes, with what the item is then
  const fresh = cmd.make('spawn', { x: 100, z: 100, r: 0, count: 9 });
  store.begin('Add by a script');
  store.exec(cmd.add('spawn', [fresh]));
  store.select([fresh]);
  assert.equal(spawn.opts.count, 4);                             // still camp a's: the group is open
  store.exec(cmd.set([fresh], { r: 14 }));
  store.commit();
  assert.deepEqual([spawn.opts.count, spawn.opts.r], [9, 14]);
  spawn.deactivate();
});

test('marker tools: a press that ends without its release creates nothing', () => {
  const { store, map, a, tools: { spawn, chest } } = bench();
  // the window lost the focus, a tool key was pressed, the pointer was cancelled: the viewport ends the press with
  // the LAST event of the press, which is not a 'pointerup'
  spawn.activate();
  const n = map.spawns.length;
  spawn.pointerDown(ev(120, 60, {}, 'pointerdown'), hit(120, 60));
  spawn.pointerUp(ev(120, 60, {}, 'pointerdown'), hit(120, 60));
  assert.deepEqual([map.spawns.length, store.canUndo], [n, false]);
  // a camp that was being drawn is taken back
  spawn.pointerDown(ev(120, 60, {}, 'pointerdown'), hit(120, 60));
  spawn.pointerMove(ev(126, 60), hit(126, 60));
  assert.ok(store.grouping && map.spawns.length === n + 1);
  spawn.pointerUp(ev(126, 60), hit(126, 60));
  assert.deepEqual([map.spawns.length, store.grouping, store.canUndo], [n, false, false]);
  // a move of what exists is kept as far as it got, as in the Select tool
  spawn.pointerDown(ev(a.x, a.z, {}, 'pointerdown'), hit(a.x, a.z, { item: a }));
  spawn.pointerMove(ev(a.x + 5, a.z), hit(a.x + 5, a.z));
  spawn.pointerUp(ev(a.x + 5, a.z), hit(a.x + 5, a.z));
  assert.deepEqual([a.x, store.grouping, store.undoLabel], [55, false, 'Move 1 spawn']);
  spawn.deactivate();
  // the same for a chest: no click, and no chest that was turning under the pointer
  chest.activate();
  chest.pointerDown(ev(60, 60, {}, 'pointerdown'), hit(60, 60));
  chest.pointerUp(ev(60, 60, {}, 'pointerdown'), hit(60, 60));
  chest.pointerDown(ev(60, 60, {}, 'pointerdown'), hit(60, 60));
  chest.pointerMove(ev(64, 60), hit(64, 60));
  assert.ok(store.grouping && map.chests.length === 1);
  chest.pointerUp(ev(64, 60), hit(64, 60));
  assert.deepEqual([map.chests.length, store.grouping], [0, false]);
  click(chest, 60, 60);                                          // a real click still places
  assert.equal(map.chests.length, 1);
  chest.deactivate();
});

test('Spawn tool: with nothing selected the brackets size the next camp; with a selection the keys edit it', () => {
  const { store, a, tools: { spawn } } = bench();
  spawn.activate();
  spawn.setTemplate({ r: 10 });
  assert.equal(spawn.key('scale.up', {}), true);
  assert.equal(spawn.opts.r, 11);
  assert.equal(spawn.key('scale.down', {}), true);
  assert.equal(spawn.key('scale.down', {}), true);
  assert.deepEqual([spawn.opts.r, store.canUndo], [9, false]);
  assert.equal(spawn.key('nudge.right', {}), false);            // not consumed: the arrows pan the camera
  assert.equal(spawn.key('selection.delete', {}), false);       // falls through to edit.delete
  store.select([a]);
  assert.equal(spawn.key('nudge.right', {}), true);
  assert.deepEqual([a.x, store.undoLabel], [51, 'Nudge 1 spawn']);
  assert.equal(spawn.key('scale.up', {}), true);
  assert.equal(a.r, 17.6);
  spawn.deactivate();
  assert.ok(!store.grouping);
});

test('Chest and NPC tools: a click places the template, a press-drag turns the new item to the pointer in one step', () => {
  const { store, map, toasts, tools: { chest, npc } } = bench();
  chest.activate();
  chest.setTemplate({ gold: 400, big: true, respawn: 300 });
  click(chest, 60, 30);
  const first = map.chests[0];
  assert.deepEqual([first.x, first.z, first.gold, first.big, first.respawn, first.ry, store.undoLabel], [60, 30, 400, true, 300, 0, 'Add 1 chest']);
  store.clearSelection();
  drag(chest, [[70, 30], [72, 30], [76, 30]]);                  // towards +X: 90 degrees
  const second = map.chests[1];
  assert.ok(near(second.ry, Math.PI / 2, 1e-6));
  assert.deepEqual([second.gold, store.undoLabel], [400, 'Add 1 chest']);
  store.undo();
  assert.equal(map.chests.length, 1);
  // nothing selected: Q and E turn the chest that is about to be placed, and leave no undo step
  store.clearSelection();
  chest.setTemplate({ ry: 0 });
  const label = store.undoLabel;
  assert.equal(chest.key('rotate.ccw', {}), true);
  assert.ok(near(chest.opts.ry, Math.PI / 12, 1e-6));
  assert.equal(chest.key('rotate.cw', { shiftKey: true }), true);
  assert.ok(near(chest.opts.ry, -5 * Math.PI / 12, 1e-6));
  assert.equal(store.undoLabel, label);
  click(chest, 259.6, 0);
  assert.match(toasts.at(-1)[0], /Outside the island/);
  assert.equal(map.chests.length, 1);
  chest.deactivate();

  npc.activate();
  npc.setTemplate({ kind: 'sage' });
  click(npc, 10, 10);
  assert.deepEqual([map.npcs.length, map.npcs[0].kind, store.undoLabel], [1, 'sage', 'Add 1 NPC']);
  store.clearSelection();
  npc.setTemplate({ kind: 'guard' });
  drag(npc, [[70, 30], [70, 28], [70, 24]]);                    // towards -Z: 180 degrees
  assert.deepEqual([map.npcs[1].kind, Math.abs(map.npcs[1].ry)], ['guard', Math.PI]);
  npc.setTemplate({ kind: 'dragon' });                          // not a kind: the default stands in
  assert.equal(npc.template().kind, 'guard');
  npc.deactivate();
  assert.deepEqual(validate(map).filter((i) => i.level === 'error'), []);
});

test('Start tool: a click moves the start point, a drag makes it follow, the rim sets the radius; it never creates', () => {
  const { store, map, toasts, tools: { start } } = bench();
  const s = map.start, was = { ...s };
  start.activate();
  assert.deepEqual([...store.selection], [s]);                   // activating the tool selects the start point
  click(start, -6, 12);
  assert.deepEqual([s.x, s.z, store.undoLabel, map.start], [-6, 12, 'Move the start point', s]);
  store.undo();
  drag(start, [[10, 15], [11, 15], [13, 16]]);
  assert.deepEqual([s.x, s.z, store.grouping, store.undoLabel], [13, 16, false, 'Move the start point']);
  store.undo();
  assert.deepEqual({ ...s }, was);
  drag(start, [[s.x + s.r, s.z], [s.x + s.r + 1, s.z], [s.x + 6, s.z]], { item: s, kind: 'start', handle: { type: 'radius', index: 0 } });
  assert.equal(s.r, 6);
  store.undo();
  click(start, 255, 0);
  assert.match(toasts.at(-1)[0], /start disc must stay/);
  const g = map.ground;
  g.cells[cellIndex(g, 40, 40)] = GROUND_INDEX.water;
  click(start, 40, 40);
  assert.match(toasts.at(-1)[0], /cannot appear on water/);
  assert.deepEqual({ ...s }, was);
  assert.equal(start.key('selection.delete', {}), false);
  start.deactivate();
});

test('marker tools: a store load in the middle of a gesture leaves nothing open', () => {
  const { store, tools: { spawn } } = bench();
  spawn.activate();
  spawn.pointerDown(ev(120, 60), hit(120, 60));
  spawn.pointerMove(ev(126, 60), hit(126, 60));
  assert.ok(store.grouping);
  const next = island().map;
  store.load(next);
  spawn.pointerMove(ev(130, 60), hit(130, 60));
  spawn.pointerUp(up(130, 60), hit(130, 60));
  assert.deepEqual([next.spawns.length, store.grouping, store.canUndo], [0, false, false]);
  click(spawn, 120, 60);                                         // and the tool works on the new map
  assert.equal(next.spawns.length, 1);
  spawn.deactivate();
});
