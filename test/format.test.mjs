// Unit tests of the pure map-format module. Run: node --test test/format.test.mjs
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import * as format from '../src/map/format.js';
import { MODEL_ALIASES } from '../src/map/catalog.js';
import { MOB_KEYS, MOB_TYPES, SHOP_RANGE, AGGRO_R, BOSS_AGGRO_R, LEASH_R, WANDER_R } from '../src/shared.js';

const {
  FORMAT_VERSION, KINDS, COLLECTION, LAYERS, LAYER_OF, NPC_KINDS, NPC_RADIUS, GROUND_TYPES, GROUND_INDEX, GROUND_ALIASES,
  GROUND_SYMBOLS, MOODS, LIMITS, MapError,
  emptyMap, migrate, normalize, validate, serialize, stringifyMap, encodeItem, decodeItem,
  qPos, qScale, qAngle, toDeg, toRad, quantizeItem,
  inShape, shapeBounds, shapeCentre, regionAt, moodAt, regionLabel, regionColor, isSafe, regionIndex, pushOutOfSafe,
  npcsOf, nearNpc, startPoint, spawnHome, pickType, pickLevel, spawnCount, hasBoss, groupItems,
  groundHalf, groundIx, groundX, cellIndex, cellXZ, groundAt, isBlocked, maxRadius, resizeGround, encodeRows, decodeRows, cellHash,
  layerProblem,
} = format;

// ---------------------------------------------------------------- fixtures

// A small valid world in FILE form: radius 100, a safe town, a water pond, one item of every kind.
// The objects are already sorted by model id, as the canonical writer leaves them. Every call returns a fresh copy.
function sample() {
  const rows = [];
  for (let iz = 0; iz < 121; iz++) {
    rows.push(iz >= 55 && iz <= 65 ? '55a11c55a' : iz >= 100 && iz <= 104 ? '60ab19a10d31a' : '60ab60a');   // plaza, pond, road
  }
  return {
    version: 1,
    name: 'Test Isle',
    radius: 100,
    start: { x: 0, z: 6, r: 10 },
    foliage: true,
    fallback: { name: 'Open Sea', mood: 'meadow' },
    regions: [
      { name: 'Wilds', levels: [1, 9], mood: 'graveyard', shape: { type: 'circle', x: 0, z: 0, r: 100 } },
      { name: 'Town', mood: 'meadow', safe: true, shape: { type: 'circle', x: 0, z: 0, r: 24 } },
      { name: 'Lake', color: '#3a8fb0', shape: { type: 'poly', points: [[40, 40], [60, 44], [52, 60]] } },
    ],
    spawns: [
      { types: { chaser: 3, runner: 2 }, lvl: [1, 2], x: 50, z: 10, r: 12.5, count: 4, respawn: 14 },
      { types: { boss: 1 }, lvl: [18, 18], x: 0, z: -80, r: 0, count: 1, respawn: 90, g: 'fortress' },
    ],
    chests: [
      { x: 46, z: -4.6, gold: 12, respawn: 150 },
      { x: 0, z: -90, ry: 90, gold: 400, big: true, respawn: 300, g: 'fortress' },
    ],
    npcs: [
      { kind: 'blacksmith', x: -4.8, z: 11.5, ry: 157.34, g: 'town' },
      { kind: 'sage', x: 4.2, z: -4.6 },
      { kind: 'guard', x: 22.2, z: 3.4, ry: -90, g: 'town' },
    ],
    ground: { cell: 2, size: 121, types: ['grass', 'dirt', 'paving', 'water'], rows },
    objects: [
      { m: 'dungeon/torch_mounted', x: 3, y: 3.3, z: -85, s: 1.7, g: 'fortress' },
      { m: 'halloween/grave_A', x: 70, z: 40, rx: 5.73, ry: 11.46, rz: -2.86, col: 0 },
      { m: 'halloween/pillar', x: 10, z: 60, sy: 1.25, col: [{ x: 0, z: 0, r: 0.73 }] },
      { m: 'medieval/fence_stone_straight', x: -30.5, z: 20, ry: -45, col: 'box' },
      { m: 'medieval/rock_single_A', x: -40, z: -40, col: 0.5 },
      { m: 'medieval/tree_single_A', x: 31.2, z: -4.5, ry: 74.48, s: 1.1 },
    ],
  };
}
const sampleMap = () => normalize(sample());

// the same file after a change, e.g. patched((f) => { f.radius = 5; })
const patched = (edit) => { const f = sample(); edit(f); return f; };

const errorsOf = (issues) => issues.filter((i) => i.level === 'error');
const warningsOf = (issues) => issues.filter((i) => i.level === 'warning');
const codes = (issues) => [...new Set(issues.map((i) => i.code))].sort();
// the error codes validate reports after `edit` changed a valid runtime map
const errorCodes = (edit, options) => { const m = sampleMap(); edit(m); return codes(errorsOf(validate(m, options))); };
const warningCodes = (edit, options) => { const m = sampleMap(); edit(m); return codes(warningsOf(validate(m, options))); };

// the MapError that normalize / decodeItem / decodeRows throws
function thrown(fn) {
  try { fn(); } catch (e) {
    assert.ok(e instanceof MapError, `expected a MapError, got ${e}`);
    return e;
  }
  return assert.fail('expected a MapError, but nothing was thrown');
}
const decodeError = (edit, options) => thrown(() => normalize(patched(edit), options));

// a deterministic stand-in for Math.random
function lcg(seed = 1337) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
}

// ---------------------------------------------------------------- constants

test('the export list is exactly the one of the spec', () => {
  assert.deepEqual(Object.keys(format).sort(), [
    'COLLECTION', 'FORMAT_VERSION', 'GROUND_ALIASES', 'GROUND_INDEX', 'GROUND_SYMBOLS', 'GROUND_TYPES', 'KINDS', 'LAYERS', 'LAYER_OF',
    'LIMITS', 'MAX_SLOPE', 'MOODS', 'MapError', 'NPC_KINDS', 'NPC_RADIUS', 'WATER_LEVEL',
    'cellHash', 'cellIndex', 'cellXZ', 'clampHeight', 'decodeHeights', 'decodeItem', 'decodeRows', 'emptyMap', 'encodeHeights', 'encodeItem',
    'encodeRows', 'groundAt', 'groundHalf',
    'groundIx', 'groundX', 'groupItems', 'hasBoss', 'heightAt', 'inShape', 'isBlocked', 'isSafe', 'layerProblem', 'maxRadius', 'migrate', 'moodAt', 'nearNpc',
    'normalize', 'npcsOf', 'pickLevel', 'pickType', 'pushOutOfSafe', 'qAngle', 'qHeight', 'qPos', 'qScale', 'quantizeItem', 'rayGround', 'regionAt',
    'regionColor', 'regionIndex', 'regionLabel', 'resizeGround', 'serialize', 'shapeBounds', 'shapeCentre', 'slopeAt', 'spawnCount', 'spawnHome',
    'startPoint', 'stringifyMap', 'toDeg', 'toRad', 'validate',
  ]);
});

test('kinds, collections and layers line up', () => {
  assert.equal(FORMAT_VERSION, 1);
  assert.deepEqual(KINDS, ['object', 'spawn', 'chest', 'npc', 'region', 'start']);
  assert.deepEqual(COLLECTION, { object: 'objects', spawn: 'spawns', chest: 'chests', npc: 'npcs', region: 'regions' });
  assert.deepEqual(LAYERS, ['ground', 'foliage', 'objects', 'spawns', 'chests', 'npcs', 'regions', 'start']);
  for (const kind of KINDS) assert.ok(LAYERS.includes(LAYER_OF[kind]), kind);
  assert.deepEqual(NPC_KINDS, ['blacksmith', 'sage', 'trader', 'guard']);
  assert.equal(NPC_RADIUS, 0.55);
});

test('src/npc.js has a KINDS entry for every NPC kind', () => {
  const text = readFileSync(new URL('../src/npc.js', import.meta.url), 'utf8');
  const table = /\bKINDS\s*=\s*\{([\s\S]*?)\n\};/.exec(text);
  assert.ok(table, 'src/npc.js defines a KINDS table');
  for (const kind of NPC_KINDS) assert.match(table[1], new RegExp(`(^|[{,\\s])${kind}\\s*:\\s*\\{`), `KINDS.${kind}`);
});

test('ground types: the table of the spec, in order', () => {
  assert.deepEqual(GROUND_TYPES.map((t) => t.id),
    ['grass', 'dirt', 'dirt_dark', 'paving', 'dust', 'ash', 'sand', 'stone', 'snow', 'dry_grass', 'swamp', 'lawn', 'water', 'lava']);
  GROUND_TYPES.forEach((t, i) => {
    assert.equal(GROUND_INDEX[t.id], i);
    assert.ok(typeof t.name === 'string' && Number.isInteger(t.a) && Number.isInteger(t.b), t.id);
  });
  assert.deepEqual(GROUND_TYPES.filter((t) => t.block).map((t) => t.id), ['water', 'lava']);
  assert.deepEqual(GROUND_TYPES.filter((t) => t.foliage).map((t) => t.id), ['grass', 'dry_grass']);
  assert.deepEqual(GROUND_TYPES[0], { id: 'grass', name: 'Grass', a: 0x4f8f3a, b: 0x74b04c, foliage: { tuft: 0.14, flower: 0.042 } });
  assert.deepEqual(GROUND_TYPES[12], { id: 'water', name: 'Water', a: 0x2f7d9c, b: 0x3a8fb0, block: true });
  assert.equal(GROUND_SYMBOLS.length, 52);
  assert.equal(new Set(GROUND_SYMBOLS).size, 52);
  assert.ok(GROUND_TYPES.length <= LIMITS.groundTypes);
  assert.deepEqual(GROUND_ALIASES, {});
});

test('moods: the three presets of today plus a radar colour', () => {
  assert.deepEqual(Object.keys(MOODS), ['meadow', 'graveyard', 'cursed']);
  assert.deepEqual(MOODS.meadow,
    { name: 'Meadow', radar: 0x6fbf55, sky: 0x9fd3e6, sun: 0xfff2d6, sunI: 2.0, hemiSky: 0xcfe9ff, hemiGround: 0x4a6b3a, hemiI: 0.95 });
  assert.deepEqual(MOODS.graveyard,
    { name: 'Graveyard', radar: 0xb59a6a, sky: 0x8f887c, sun: 0xffd9a8, sunI: 1.6, hemiSky: 0xd8cbb5, hemiGround: 0x4a4034, hemiI: 0.8 });
  assert.deepEqual(MOODS.cursed,
    { name: 'Cursed', radar: 0xff5a70, sky: 0x3a2230, sun: 0xffb9a0, sunI: 1.7, hemiSky: 0xb98aa6, hemiGround: 0x3a2028, hemiI: 1.05 });
});

test('limits: the numbers of the spec', () => {
  const expected = {
    radius: [40, 600], groundSize: [33, 513], groundMargin: 20, objects: 50000, objectsWarn: 20000, scale: [0.05, 20],
    objectY: [-20, 100], spawns: 300, spawnR: [0, 80], spawnCount: [1, 30], spawnRespawn: [3, 3600], spawnWeight: [1, 100],
    monsters: 1200, monstersWarn: 800, chests: 200, chestGold: [1, 100000], chestRespawn: [10, 86400], npcs: 40, regions: 64,
    polyPoints: [3, 64], level: [1, 99], startR: [0, 40], bodyBytes: 8388608, issues: 100,
  };
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(LIMITS[key], value, key);
  assert.deepEqual(LIMITS.name, [1, 64]);
  assert.deepEqual(LIMITS.regionName, [1, 48]);
  assert.deepEqual(LIMITS.groundCells, [1, 2, 4]);
  assert.deepEqual(LIMITS.regionR, [1, 1200]);
});

test('shared.js exports the monster ranges the checks use', () => {
  assert.deepEqual([AGGRO_R, BOSS_AGGRO_R, LEASH_R, WANDER_R], [13, 20, 30, 5]);
});

// ---------------------------------------------------------------- quantisation

test('qPos and qScale round to their grid and never return -0', () => {
  assert.equal(qPos(1.23456), 1.23);
  assert.equal(qPos(-4.565), -4.57);
  assert.equal(qPos(0.574), 0.57);
  assert.equal(qScale(0.574), 0.574);
  assert.equal(qScale(1.23456), 1.235);
  assert.ok(Object.is(qPos(-0.001), 0));
  assert.ok(Object.is(qScale(-0.0001), 0));
  assert.ok(Object.is(toDeg(-0.00001), 0));
  for (const v of [0.57, 12.34, -99.99, 259.01]) assert.equal(qPos(qPos(v)), qPos(v));
});

test('a finite number stays finite on the grid: no overflow to Infinity, which JSON would write as null', () => {
  for (const v of [1e15, 1e100, 1e306, 1e308, Number.MAX_VALUE, -1e308]) {
    assert.equal(qPos(v), v, `qPos(${v})`);
    assert.equal(qScale(v), v, `qScale(${v})`);
    assert.ok(Number.isFinite(qAngle(v)) && Math.abs(qAngle(v)) <= Math.PI, `qAngle(${v})`);
    assert.ok(Number.isFinite(toDeg(qAngle(toRad(v)))), `an angle of ${v} degrees`);
  }
  assert.equal(qPos(123456789012.345), 123456789012.35, 'a large number that still has hundredths is rounded as ever');
  assert.equal(qPos(Infinity), Infinity);                        // what is not a number of the map is passed through,
  assert.ok(Number.isNaN(qPos(NaN)) && Number.isNaN(qAngle(Infinity)));   // for the decoder and validate() to refuse

  // a hand-edited file: it decodes (the editor's Import and a draft pass check: false), every value is a number that
  // validate() can call out of range - and the map can be written and read again, which is what a draft is
  const file = sample();
  file.objects[0].x = 1e308;
  file.objects[0].ry = 1e307;
  file.spawns[0].x = -1e308;
  file.chests[0].z = 1e308;
  file.regions[0].shape.r = 1e308;
  const map = normalize(file, { check: false });
  assert.deepEqual([map.objects.find((o) => o.x > 1).x, map.spawns[0].x, map.chests[0].z, map.regions[0].shape.r], [1e308, -1e308, 1e308, 1e308]);
  assert.ok(map.objects.every((o) => Number.isFinite(o.ry)));
  assert.ok(validate(map).filter((i) => i.level === 'error').length >= 4);
  const text = JSON.stringify(serialize(map, { check: false }));
  assert.ok(!text.includes('null'), 'nothing the JSON writer had to give up on');
  const again = normalize(JSON.parse(text), { check: false });
  assert.equal(stringifyMap(serialize(again, { check: false })), stringifyMap(serialize(map, { check: false })));
});

test('qAngle wraps into (-180, 180]: 180 stays 180, -180 becomes 180', () => {
  assert.equal(toDeg(qAngle(toRad(180))), 180);
  assert.equal(toDeg(qAngle(toRad(-180))), 180);
  assert.equal(qAngle(toRad(-180)), qAngle(toRad(180)));
  assert.equal(toDeg(qAngle(toRad(270))), -90);
  assert.equal(toDeg(qAngle(toRad(-270))), 90);
  assert.equal(toDeg(qAngle(toRad(540))), 180);
  assert.equal(toDeg(qAngle(toRad(360))), 0);
  assert.equal(toDeg(qAngle(toRad(180.01))), -179.99);
  assert.equal(toDeg(qAngle(toRad(12.3456))), 12.35);
  assert.ok(Object.is(qAngle(0), 0));
  assert.ok(Object.is(qAngle(-1e-9), 0));
  assert.ok(Object.is(qAngle(Math.PI * 2), 0));
  assert.ok(qAngle(toRad(180)) <= Math.PI && qAngle(toRad(-179.99)) > -Math.PI);
  assert.ok(Number.isNaN(qAngle(NaN)));
});

test('degrees survive the trip through radians for every two-decimal value', () => {
  for (let c = -18000; c <= 18000; c++) {
    const deg = c / 100, rad = qAngle(toRad(deg));
    if (toDeg(rad) !== (c === -18000 ? 180 : deg)) assert.fail(`${deg} came back as ${toDeg(rad)}`);
    if (qAngle(rad) !== rad) assert.fail(`qAngle is not stable at ${deg}`);
  }
});

test('qAngle wraps an angle of any size, so a file with an absurd one still round-trips', () => {
  // beyond 2^53 hundredths of a degree a subtraction of whole turns loses digits; the remainder does not
  const wrapped = (deg) => { const rad = qAngle(toRad(deg)); return rad > -Math.PI && rad <= Math.PI && qAngle(rad) === rad; };
  for (const deg of [7964353832865299, -73578320771259410, 36000000180, -(2 ** 60), 1e300, -1e300]) assert.ok(wrapped(deg), `${deg} degrees`);
  const rnd = lcg(3);
  for (let i = 0; i < 20000; i++) {
    const deg = (rnd() - 0.5) * 10 ** (3 + rnd() * 300);
    if (!wrapped(deg)) assert.fail(`${deg} degrees came back as ${toDeg(qAngle(toRad(deg)))}`);
  }
  assert.equal(toDeg(qAngle(toRad(36000000180))), 180);
  assert.equal(toDeg(qAngle(toRad(-36000000180))), 180);
  const map = normalize(patched((f) => { f.objects[0].ry = 7964353832865299; f.chests[0].ry = -73578320771259410; f.npcs[1].ry = 1e300; }));
  assert.deepEqual(validate(map), []);
  for (const item of [map.objects[0], map.chests[0], map.npcs[1]]) assert.ok(item.ry > -Math.PI && item.ry <= Math.PI);
  assert.deepEqual(normalize(serialize(map)), map);
});

test('quantizeItem works in place on every kind', () => {
  const o = { m: 'medieval/barrel', x: 1.234, y: 0.336, z: -5.678, rx: 0, ry: toRad(370.004), rz: toRad(-180), s: 1.23456, sy: 0.99951, col: 0.555, g: null };
  assert.equal(quantizeItem('object', o), o);
  assert.deepEqual([o.x, o.y, o.z, o.s, o.sy, o.col], [1.23, 0.34, -5.68, 1.235, 1, 0.56]);
  assert.equal(toDeg(o.ry), 10);
  assert.equal(toDeg(o.rz), 180);
  const circles = quantizeItem('object', { ...o, col: [{ x: 0.12345, z: -0.00004, r: 0.7306 }] }).col;
  assert.deepEqual(circles, [{ x: 0.123, z: 0, r: 0.731 }]);
  assert.equal(quantizeItem('object', { ...o, col: 'box' }).col, 'box');
  assert.equal(quantizeItem('object', { ...o, col: null }).col, null);

  assert.deepEqual(quantizeItem('spawn', { types: { chaser: 1 }, lvl: [1, 2], x: 1.005, z: 2.004, r: 7.777, count: 3, respawn: 14, g: null }),
    { types: { chaser: 1 }, lvl: [1, 2], x: 1, z: 2, r: 7.78, count: 3, respawn: 14, g: null });
  assert.equal(toDeg(quantizeItem('chest', { x: 0, z: 0, ry: toRad(-90.004), gold: 1, big: false, respawn: 10, g: null }).ry), -90);
  assert.equal(toDeg(quantizeItem('npc', { kind: 'guard', x: 0.126, z: 0, ry: toRad(721), g: null }).ry), 1);
  assert.deepEqual(quantizeItem('start', { x: 0.004, z: 6.006, r: 9.999 }), { x: 0, z: 6.01, r: 10 });

  const circle = { name: 'A', shape: { type: 'circle', x: 1.111, z: 2.222, r: 3.333 } };
  const shape = circle.shape;
  assert.equal(quantizeItem('region', circle).shape, shape);
  assert.deepEqual(shape, { type: 'circle', x: 1.11, z: 2.22, r: 3.33 });
  assert.deepEqual(quantizeItem('region', { name: 'B', shape: { type: 'poly', points: [[0.004, 1.006], [2.5, 3.333], [4, 5]] } }).shape.points,
    [[0, 1.01], [2.5, 3.33], [4, 5]]);
});

// ---------------------------------------------------------------- load / save pipeline

test('normalize fills defaults, converts degrees and builds the cells', () => {
  const map = sampleMap();
  assert.equal(map.version, 1);
  assert.equal(map.name, 'Test Isle');
  assert.equal(map.radius, 100);
  assert.deepEqual(map.start, { x: 0, z: 6, r: 10 });
  assert.equal(map.foliage, true);
  assert.deepEqual(map.fallback, { name: 'Open Sea', levels: null, mood: 'meadow' });
  assert.deepEqual(map.regions[0], { name: 'Wilds', levels: [1, 9], mood: 'graveyard', safe: false, color: null, shape: { type: 'circle', x: 0, z: 0, r: 100 } });
  assert.deepEqual(map.regions[2], { name: 'Lake', levels: null, mood: null, safe: false, color: '#3a8fb0', shape: { type: 'poly', points: [[40, 40], [60, 44], [52, 60]] } });
  assert.deepEqual(map.spawns[0], { types: { chaser: 3, runner: 2 }, lvl: [1, 2], x: 50, z: 10, r: 12.5, count: 4, respawn: 14, g: null, l: null });
  assert.deepEqual(map.chests[0], { x: 46, z: -4.6, ry: 0, gold: 12, big: false, respawn: 150, g: null, l: null });
  assert.deepEqual(map.chests[1], { x: 0, z: -90, ry: Math.PI / 2, gold: 400, big: true, respawn: 300, g: 'fortress', l: null });
  assert.deepEqual(map.npcs[1], { kind: 'sage', x: 4.2, z: -4.6, ry: 0, g: null, l: null });
  assert.deepEqual(map.layers, [], 'a file without layers of its own has an empty list');
  assert.equal(map.npcs[0].ry, toRad(157.34));
  assert.deepEqual(map.objects[5], { m: 'medieval/tree_single_A', x: 31.2, y: 0, z: -4.5, rx: 0, ry: toRad(74.48), rz: 0, s: 1.1, sy: 1, col: null, g: null, l: null });
  assert.deepEqual(map.objects[0], { m: 'dungeon/torch_mounted', x: 3, y: 3.3, z: -85, rx: 0, ry: 0, rz: 0, s: 1.7, sy: 1, col: null, g: 'fortress', l: null });
  assert.equal(map.objects[1].col, 0);
  assert.deepEqual(map.objects[2].col, [{ x: 0, z: 0, r: 0.73 }]);
  assert.equal(map.objects[3].col, 'box');
  assert.equal(map.objects[4].col, 0.5);
  assert.deepEqual(Object.keys(map.ground), ['cell', 'size', 'cells', 'heights']);
  assert.ok(map.ground.heights instanceof Float32Array && map.ground.heights.length === 121 * 121 && map.ground.heights.every((h) => h === 0));
  assert.ok(map.ground.cells instanceof Uint8Array);
  assert.equal(map.ground.cells.length, 121 * 121);
  assert.equal(groundAt(map, 0, 0).id, 'paving');
  assert.equal(groundAt(map, 0, 50).id, 'dirt');
  assert.equal(groundAt(map, 50, 84).id, 'water');
  assert.equal(groundAt(map, -50, -50).id, 'grass');
  assert.deepEqual(validate(map), []);
});

test('normalize builds everything from scratch: the file is not referenced afterwards', () => {
  const file = sample(), map = normalize(file), copy = structuredClone(map);
  file.spawns[0].lvl[0] = 9;
  file.spawns[0].types.chaser = 99;
  file.regions[2].shape.points[0][0] = -1;
  file.objects[2].col[0].r = 9;
  file.start.x = 50;
  file.ground.rows[0] = 'x';
  assert.deepEqual(map, copy);
  assert.notEqual(normalize(sample()).objects[0], map.objects[0]);
});

test('normalize wraps angles, quantises and repairs polygons, and nothing else', () => {
  const map = normalize(patched((f) => {
    f.objects[0].ry = 270;
    f.objects[0].x = 3.14159;
    f.objects[0].s = 1.23456;
    f.objects[1].rz = -180;
    f.objects[2].col = [{ x: 0.12345, z: 0, r: 0.7306 }];
    f.objects[4].col = 0.555;
    f.chests[0].ry = 540;
    f.npcs[1].ry = -0.004;
    f.start.x = -0.001;
    f.spawns[0].r = 12.499;
    f.regions[2].shape.points = [[40, 40], [40.001, 40.002], [60, 44], [60, 44], [52, 60], [40, 40]];   // a repeat, a twin, a closing point
  }));
  assert.equal(toDeg(map.objects[0].ry), -90);
  assert.equal(map.objects[0].x, 3.14);
  assert.equal(map.objects[0].s, 1.235);
  assert.equal(toDeg(map.objects[1].rz), 180);
  assert.deepEqual(map.objects[2].col, [{ x: 0.123, z: 0, r: 0.731 }]);
  assert.equal(map.objects[4].col, 0.56);
  assert.equal(toDeg(map.chests[0].ry), 180);
  assert.ok(Object.is(map.npcs[1].ry, 0));
  assert.ok(Object.is(map.start.x, 0));
  assert.equal(map.spawns[0].r, 12.5);
  assert.deepEqual(map.regions[2].shape.points, [[40, 40], [60, 44], [52, 60]]);

  // it never trims, clamps or rounds a count: those are errors for the author to fix
  assert.deepEqual(codes(decodeError((f) => { f.name = ' Test Isle'; }).issues), ['string']);
  assert.deepEqual(codes(decodeError((f) => { f.spawns[0].count = 3.5; }).issues), ['spawn-count']);
  assert.deepEqual(codes(decodeError((f) => { f.objects[0].s = 25; }).issues), ['object-scale']);
  assert.equal(normalize(patched((f) => { f.spawns[0].count = 3.5; }), { check: false }).spawns[0].count, 3.5);
});

test('null stands for an absent optional value where the runtime form uses null', () => {
  const map = normalize(patched((f) => {
    f.objects[0].g = null; f.objects[0].col = null;
    f.regions[0].levels = null; f.regions[0].mood = null; f.regions[0].color = null;
    f.fallback.levels = null;
  }));
  assert.equal(map.objects[0].g, null);
  assert.equal(map.objects[0].col, null);
  assert.deepEqual([map.regions[0].levels, map.regions[0].mood, map.regions[0].color, map.fallback.levels], [null, null, null, null]);
  assert.deepEqual(codes(decodeError((f) => { f.objects[0].y = null; }).issues), ['type']);
  assert.deepEqual(codes(decodeError((f) => { f.fallback.mood = null; }).issues), ['type']);
});

test('normalize -> serialize -> normalize is deep-equal', () => {
  const file = sample(), map = normalize(file);
  const again = serialize(map);
  assert.deepEqual(again, file, 'a canonical file comes back as it was');
  assert.deepEqual(normalize(again), map);
  assert.deepEqual(serialize(normalize(again)), again);
});

test('serialize sorts objects by model id, stably, and keeps every other order', () => {
  const map = sampleMap(), sorted = structuredClone(map);
  map.objects.reverse();
  map.objects.push({ ...map.objects[0], x: 1 }, { ...map.objects[0], x: 2 });        // two more trees, after the others
  const file = serialize(map);
  assert.deepEqual(file.objects.map((o) => o.m), ['dungeon/torch_mounted', 'halloween/grave_A', 'halloween/pillar',
    'medieval/fence_stone_straight', 'medieval/rock_single_A', 'medieval/tree_single_A', 'medieval/tree_single_A', 'medieval/tree_single_A']);
  assert.deepEqual(file.objects.slice(5).map((o) => o.x), [31.2, 1, 2]);
  assert.equal(map.objects[0].m, 'medieval/tree_single_A', 'the map itself is not reordered');
  assert.deepEqual(file.spawns, sample().spawns);
  assert.deepEqual(file.regions, sample().regions);
  // up to the order of objects, the round trip loses nothing
  const back = normalize(file);
  back.objects.length = 6;
  assert.deepEqual(back, sorted);
});

test('serialize omits defaults and writes keys in canonical order', () => {
  const file = serialize(sampleMap());
  assert.deepEqual(Object.keys(file), ['version', 'name', 'radius', 'start', 'foliage', 'fallback', 'regions', 'spawns', 'chests', 'npcs', 'ground', 'objects']);
  assert.deepEqual(Object.keys(file.objects[0]), ['m', 'x', 'y', 'z', 's', 'g']);
  assert.deepEqual(Object.keys(file.objects[1]), ['m', 'x', 'z', 'rx', 'ry', 'rz', 'col']);
  assert.deepEqual(Object.keys(file.objects[2]), ['m', 'x', 'z', 'sy', 'col']);
  assert.deepEqual(Object.keys(file.chests[0]), ['x', 'z', 'gold', 'respawn']);
  assert.deepEqual(Object.keys(file.chests[1]), ['x', 'z', 'ry', 'gold', 'big', 'respawn', 'g']);
  assert.deepEqual(Object.keys(file.npcs[1]), ['kind', 'x', 'z']);
  assert.deepEqual(Object.keys(file.regions[1]), ['name', 'mood', 'safe', 'shape']);
  assert.deepEqual(Object.keys(file.ground), ['cell', 'size', 'types', 'rows']);
  assert.deepEqual(file.fallback, { name: 'Open Sea', mood: 'meadow' });
  const map = sampleMap();
  map.spawns[0].types = { runner: 2, chaser: 3 };
  map.fallback.levels = [1, 3];
  assert.deepEqual(Object.keys(serialize(map).spawns[0].types), ['chaser', 'runner'], 'weights are written in MOB_KEYS order');
  assert.deepEqual(Object.keys(serialize(map).fallback), ['name', 'levels', 'mood']);
});

test('serialize is pure and checks the map unless told not to', () => {
  const map = sampleMap(), before = structuredClone(map);
  serialize(map);
  validate(map, { models: new Set(), strictModels: true });
  assert.deepEqual(map, before);
  map.spawns[0].count = 99;
  const e = thrown(() => serialize(map));
  assert.deepEqual(codes(e.issues), ['spawn-count']);
  assert.equal(serialize(map, { check: false }).spawns[0].count, 99);
});

test('work in progress is written whole, so the next load can say what is wrong with it', () => {
  const m = sampleMap();
  m.spawns[0].types = JSON.parse('{ "runner": 1, "constructor": 2, "zombie": 3 }');
  m.objects[0].g = undefined;                 // a cleared field reads as absent
  m.objects[0].col = undefined;
  assert.deepEqual(codes(errorsOf(validate(m))), ['spawn-types']);
  const text = stringifyMap(serialize(m, { check: false }));
  assert.ok(text.includes('{ "types": { "runner": 1, "constructor": 2, "zombie": 3 }, "lvl": [1, 2],'), 'unknown ids are not dropped');
  assert.ok(text.includes('{ "m": "dungeon/torch_mounted", "x": 3, "y": 3.3, "z": -85, "s": 1.7 }'));
  const e = thrown(() => normalize(JSON.parse(text), { check: false }));
  assert.deepEqual(e.issues.map((i) => [i.code, i.path]), [['enum', 'spawns[0].types.constructor'], ['enum', 'spawns[0].types.zombie']]);
});

test('a map with a RANGE error still round-trips without the check', () => {
  const m = sampleMap();
  m.spawns[0].x = 5; m.spawns[0].z = 5;                       // dragged into the town
  assert.deepEqual(codes(errorsOf(validate(m))), ['spawn-in-safe']);
  const file = serialize(m, { check: false });
  assert.deepEqual(normalize(file, { check: false }), m);
  const e = thrown(() => normalize(file));
  assert.deepEqual(codes(e.issues), ['spawn-in-safe']);
  assert.throws(() => serialize(m), MapError);
});

// The layout of the spec, written out by hand: the writer must reproduce it byte for byte.
const TINY_ROWS = Array.from({ length: 33 }, (_, iz) => (iz < 4 || iz > 28 ? '33b' : iz === 16 ? '4b25a4b' : '6b21a6b'));
const TINY_TEXT = [
  '{',
  '  "version": 1,',
  '  "name": "Tiny \\"Isle\\"",',
  '  "radius": 40,',
  '  "start": { "x": 0, "z": 6, "r": 10 },',
  '  "foliage": false,',
  '  "fallback": { "name": "Open Sea", "levels": [1, 3], "mood": "meadow" },',
  '  "regions": [',
  '    { "name": "Wilds", "levels": [1, 9], "mood": "cursed", "shape": { "type": "circle", "x": 0, "z": 0, "r": 40 } },',
  '    { "name": "Town", "mood": "meadow", "safe": true, "shape": { "type": "circle", "x": 0, "z": 0, "r": 16.5 } },',
  '    { "name": "Lake", "color": "#3a8fb0", "shape": { "type": "poly", "points": [[10, 20], [30, 24], [22, 30.5]] } }',
  '  ],',
  '  "spawns": [',
  '    { "types": { "chaser": 3, "runner": 2 }, "lvl": [1, 2], "x": -28, "z": 4.5, "r": 6.25, "count": 4, "respawn": 14 },',
  '    { "types": { "boss": 1 }, "lvl": [18, 18], "x": 0, "z": -30, "r": 0, "count": 1, "respawn": 90, "g": "fortress" }',
  '  ],',
  '  "chests": [',
  '    { "x": 20, "z": -4.6, "gold": 12, "respawn": 150 },',
  '    { "x": 0, "z": -36, "ry": 180, "gold": 400, "big": true, "respawn": 300, "g": "fortress" }',
  '  ],',
  '  "npcs": [',
  '    { "kind": "blacksmith", "x": -4.8, "z": 11.5, "ry": 157.34, "g": "town" },',
  '    { "kind": "guard", "x": 12.2, "z": 3.4, "ry": -90 }',
  '  ],',
  '  "ground": {',
  '    "cell": 4,',
  '    "size": 33,',
  '    "types": ["grass", "sand"],',
  '    "rows": [',
  ...TINY_ROWS.map((row, iz) => `      "${row}"${iz < 32 ? ',' : ''}`),
  '    ]',
  '  },',
  '  "objects": [',
  '    { "m": "dungeon/torch_mounted", "x": 3, "y": 3.3, "z": -35, "s": 1.7, "g": "fortress" },',
  '    { "m": "halloween/grave_A", "x": 30, "z": 10, "rx": 5.73, "ry": 11.46, "rz": -2.86, "col": 0 },',
  '    { "m": "halloween/pillar", "x": -20, "z": 20, "sy": 1.25, "col": [{ "x": 0, "z": 0, "r": 0.73 }] },',
  '    { "m": "medieval/fence_stone_straight", "x": 10.5, "z": -20, "ry": -45, "col": "box" },',
  '    { "m": "medieval/tree_single_A", "x": 31.2, "z": -4.5, "ry": 74.48, "s": 1.1 }',
  '  ]',
  '}',
  '',
].join('\n');

// The example of the spec (map-editor-spec.md, section 3.1), which shows two of its 281 ground rows.
test('stringifyMap: the example file of the spec is written back line for line', () => {
  const head = [
    '{',
    '  "version": 1,',
    '  "name": "Hypercat World",',
    '  "radius": 260,',
    '  "start": { "x": 0, "z": 6, "r": 10 },',
    '  "foliage": true,',
    '  "fallback": { "name": "Open Sea", "mood": "meadow" },',
    '  "regions": [',
    '    { "name": "Cursed Lands", "levels": [10, 15], "mood": "cursed", "shape": { "type": "circle", "x": 0, "z": 0, "r": 260 } },',
    '    { "name": "Hypercat Town", "mood": "meadow", "safe": true, "shape": { "type": "circle", "x": 0, "z": 0, "r": 24 } },',
    '    { "name": "Lake", "color": "#3a8fb0", "shape": { "type": "poly", "points": [[10, 40], [30, 44], [22, 60]] } }',
    '  ],',
    '  "spawns": [',
    '    { "types": { "chaser": 3, "runner": 2 }, "lvl": [1, 2], "x": 40, "z": 10, "r": 12.5, "count": 4, "respawn": 14 },',
    '    { "types": { "boss": 1 }, "lvl": [18, 18], "x": 0, "z": -228, "r": 0, "count": 1, "respawn": 90, "g": "fortress" }',
    '  ],',
    '  "chests": [',
    '    { "x": 46, "z": -4.6, "gold": 12, "respawn": 150 },',
    '    { "x": 0, "z": -248, "gold": 400, "big": true, "respawn": 300, "g": "fortress" }',
    '  ],',
    '  "npcs": [',
    '    { "kind": "blacksmith", "x": -4.8, "z": 11.5, "ry": 157.34, "g": "town" },',
    '    { "kind": "guard", "x": 22.2, "z": 3.4, "ry": -90, "g": "town" }',
    '  ],',
    '  "ground": {',
    '    "cell": 2,',
    '    "size": 281,',
  ];
  const tail = [
    '    ]',
    '  },',
    '  "objects": [',
    '    { "m": "dungeon/torch_mounted", "x": 3, "y": 3.3, "z": -250, "s": 1.7, "g": "fortress" },',
    '    { "m": "halloween/grave_A", "x": 120, "z": 40, "rx": 5.73, "ry": 11.46, "rz": -2.86, "col": 0 },',
    '    { "m": "medieval/tree_single_A", "x": 31.2, "z": -4.5, "ry": 74.48, "s": 1.1 }',
    '  ]',
    '}',
    '',
  ];
  const rows = Array.from({ length: 281 }, (_, iz) => `      "${iz === 1 ? '11g40f78e23a75e43f11g' : '281g'}"${iz < 280 ? ',' : ''}`);
  const text = [...head, '    "types": ["grass", "dirt", "dirt_dark", "paving", "dust", "ash", "sand"],', '    "rows": [', ...rows, ...tail].join('\n');
  const map = normalize(JSON.parse(text));
  assert.deepEqual(errorsOf(validate(map)), []);
  const out = stringifyMap(serialize(map)).split('\n');
  assert.equal(out.length, head.length + 2 + 281 + tail.length);
  assert.deepEqual(out.slice(0, head.length), head);
  assert.deepEqual(out.slice(-tail.length), tail);
  // the one difference: the palette is compacted to the types that occur, so the symbols shift
  assert.deepEqual(out.slice(head.length, head.length + 4),
    ['    "types": ["grass", "dust", "ash", "sand"],', '    "rows": [', '      "281d",', '      "11d40c78b23a75b43c11d",']);
});

test('stringifyMap: a canonical file comes back byte for byte', () => {
  const map = normalize(JSON.parse(TINY_TEXT));
  assert.deepEqual(errorsOf(validate(map)), []);
  assert.equal(stringifyMap(serialize(map)), TINY_TEXT);
  const text = stringifyMap(serialize(sampleMap()));
  assert.equal(stringifyMap(serialize(normalize(JSON.parse(text)))), text);
});

test('stringifyMap: the text parses back to the same file object', () => {
  const file = serialize(sampleMap()), text = stringifyMap(file);
  assert.deepEqual(JSON.parse(text), file);
  assert.deepEqual(JSON.parse(text), sample());
  assert.ok(text.startsWith('{\n  "version": 1,\n'));
  assert.ok(text.endsWith('\n}\n'));
  assert.ok(!text.includes('\r') && !text.includes('\t'));
  assert.equal(text.split('\n').length, 1 + 6 + (2 + 3) + (2 + 2) + (2 + 2) + (2 + 3) + (5 + 121 + 2) + (2 + 6) + 2);   // one line per item and row
  for (const line of text.split('\n')) assert.ok(!/\s$/.test(line), `trailing space in: ${line}`);
});

test('stringifyMap: empty lists, key order and odd values', () => {
  const text = stringifyMap(serialize(emptyMap({ radius: 40 })));
  for (const key of ['regions', 'spawns', 'chests', 'npcs', 'objects']) assert.ok(text.includes(`\n  "${key}": []`), key);
  // keys are written in canonical order whatever order the object has them in
  const file = serialize(sampleMap());
  const reversed = (o) => Object.fromEntries(Object.entries(o).reverse());
  const shuffled = { ...reversed(file), start: reversed(file.start), fallback: reversed(file.fallback), ground: reversed(file.ground) };
  shuffled.objects = file.objects.map((o) => (Array.isArray(o.col) ? { ...reversed(o), col: o.col.map(reversed) } : reversed(o)));
  shuffled.spawns = file.spawns.map((sp) => ({ ...reversed(sp), types: reversed(sp.types) }));
  shuffled.regions = file.regions.map((r) => ({ ...reversed(r), shape: reversed(r.shape) }));
  shuffled.chests = file.chests.map(reversed);
  shuffled.npcs = file.npcs.map(reversed);
  assert.deepEqual(Object.keys(shuffled.objects[2].col[0]), ['r', 'z', 'x']);
  assert.equal(stringifyMap(shuffled), stringifyMap(file));
  // -0 is written as 0, and a key the format does not know is kept rather than dropped
  const odd = { ...file, start: { x: -0, z: 6, r: 10 }, extra: { b: [1, 2], a: null } };
  const oddText = stringifyMap(odd);
  assert.ok(oddText.includes('"start": { "x": 0, "z": 6, "r": 10 }'));
  assert.ok(oddText.endsWith(',\n  "extra": { "b": [1, 2], "a": null }\n}\n'));
  assert.deepEqual(JSON.parse(oddText).extra, odd.extra);
});

test('encodeItem / decodeItem round-trip every kind of item', () => {
  const map = sampleMap(), file = sample();
  for (const kind of ['object', 'spawn', 'chest', 'npc', 'region']) {
    map[COLLECTION[kind]].forEach((item, i) => {
      const raw = encodeItem(kind, item);
      assert.deepEqual(raw, file[COLLECTION[kind]][i], `${kind} ${i}`);
      const back = decodeItem(kind, raw);
      assert.deepEqual(back, item);
      assert.notEqual(back, item);
    });
  }
  assert.throws(() => encodeItem('start', map.start), TypeError);
  assert.throws(() => decodeItem('start', { x: 0, z: 0, r: 1 }), TypeError);
  assert.throws(() => decodeItem('constructor', {}), TypeError);
});

test('decodeItem throws on DECODE errors only', () => {
  assert.deepEqual(decodeItem('npc', { kind: 'guard', x: 1.234, z: 2, ry: 450 }), { kind: 'guard', x: 1.23, z: 2, ry: Math.PI / 2, g: null, l: null });
  assert.equal(decodeItem('spawn', { types: { chaser: 1 }, lvl: [1, 1], x: 0, z: 0, r: 500, count: 99, respawn: 1 }).count, 99, 'a RANGE error is not a decode error');
  const e = thrown(() => decodeItem('object', { m: 'medieval/barrel', x: 1, sx: 2 }));
  assert.deepEqual(e.issues.map((i) => [i.code, i.path]), [['unknown-key', 'object.sx'], ['type', 'object.z']]);
  assert.deepEqual(codes(thrown(() => decodeItem('npc', { kind: 'wizard', x: 0, z: 0 })).issues), ['enum']);
  assert.deepEqual(codes(thrown(() => decodeItem('chest', null)).issues), ['type']);
  assert.deepEqual(codes(thrown(() => decodeItem('region', { name: 'A', shape: { type: 'square', x: 0, z: 0, r: 1 } })).issues), ['enum']);
});

test('model and ground aliases are applied on load', () => {
  MODEL_ALIASES['medieval/oak'] = 'medieval/tree_single_A';
  GROUND_ALIASES.meadow = 'grass';
  try {
    const map = normalize(patched((f) => { f.objects[5].m = 'medieval/oak'; f.ground.types[0] = 'meadow'; }));
    assert.equal(map.objects[5].m, 'medieval/tree_single_A');
    assert.equal(decodeItem('object', { m: 'medieval/oak', x: 0, z: 0 }).m, 'medieval/tree_single_A');
    assert.equal(groundAt(map, -50, -50).id, 'grass');
    assert.deepEqual(serialize(map), sample(), 'the next save writes the current ids');
  } finally {
    delete MODEL_ALIASES['medieval/oak'];
    delete GROUND_ALIASES.meadow;
  }
  assert.deepEqual(codes(decodeError((f) => { f.ground.types[0] = 'meadow'; }).issues), ['ground-types']);
});

// ---------------------------------------------------------------- the map's own layers

test('layers: the list and the items on them survive the file, byte for byte, and are absent from a map without any', () => {
  assert.deepEqual([LIMITS.layers, LIMITS.layerName], [64, [1, 32]]);
  const plain = stringifyMap(serialize(sampleMap()));
  assert.equal(plain.includes('"layers"') || /"l":/.test(plain), false, 'no key at all without layers');
  assert.deepEqual(emptyMap().layers, []);
  assert.equal(Object.hasOwn(serialize(emptyMap()), 'layers'), false);

  const file = patched((f) => {
    f.layers = ['Town', 'Bandit camp', 'constructor'];
    f.objects[0].l = 'Bandit camp';
    f.objects[5].l = 'Town';
    f.spawns[1].l = 'Bandit camp';
    f.chests[1].l = 'Bandit camp';
    f.npcs[0].l = 'Town';
  });
  const map = normalize(file);
  assert.deepEqual(map.layers, ['Town', 'Bandit camp', 'constructor']);
  assert.deepEqual([map.objects[0].l, map.objects[1].l, map.spawns[1].l, map.chests[1].l, map.npcs[0].l, map.npcs[1].l], ['Bandit camp', null, 'Bandit camp', 'Bandit camp', 'Town', null]);
  assert.equal('l' in map.regions[0] || 'l' in map.start, false, 'regions and the start are on no layer');
  assert.deepEqual(validate(map).filter((i) => i.level === 'error'), []);

  const out = serialize(map), text = stringifyMap(out);
  assert.deepEqual(out, file);
  assert.deepEqual(Object.keys(out), ['version', 'name', 'radius', 'start', 'foliage', 'fallback', 'layers', 'regions', 'spawns', 'chests', 'npcs', 'ground', 'objects']);
  assert.deepEqual(Object.keys(out.objects[0]), ['m', 'x', 'y', 'z', 's', 'g', 'l']);
  assert.deepEqual(Object.keys(out.spawns[1]), ['types', 'lvl', 'x', 'z', 'r', 'count', 'respawn', 'g', 'l']);
  assert.deepEqual(Object.keys(out.chests[1]), ['x', 'z', 'ry', 'gold', 'big', 'respawn', 'g', 'l']);
  assert.deepEqual(Object.keys(out.npcs[0]), ['kind', 'x', 'z', 'ry', 'g', 'l']);
  assert.ok(text.includes('\n  "layers": ["Town", "Bandit camp", "constructor"],\n  "regions": ['), 'the list is one line of the file');
  assert.ok(text.includes('{ "kind": "blacksmith", "x": -4.8, "z": 11.5, "ry": 157.34, "g": "town", "l": "Town" }'));
  assert.equal(stringifyMap(serialize(normalize(JSON.parse(text)))), text, 'canonical: the text comes back unchanged');
  // keys in any order in a hand-edited file: the writer puts them back
  const shuffled = JSON.parse(text);
  shuffled.npcs[0] = { l: 'Town', g: 'town', ry: 157.34, z: 11.5, x: -4.8, kind: 'blacksmith' };
  assert.equal(stringifyMap(serialize(normalize(shuffled))), text);
  // "layers": [] and "l": null in a file mean the same as leaving them out
  assert.equal(stringifyMap(serialize(normalize(patched((f) => { f.layers = []; f.objects[0].l = null; })))), plain);

  // the clipboard and stamps carry the layer with the item
  assert.deepEqual(encodeItem('chest', map.chests[1]), file.chests[1]);
  assert.equal(decodeItem('chest', file.chests[1]).l, 'Bandit camp');
  assert.equal(decodeItem('npc', { kind: 'guard', x: 0, z: 0 }).l, null);
  assert.throws(() => decodeItem('region', { name: 'A', l: 'Town', shape: { type: 'circle', x: 0, z: 0, r: 5 } }), MapError);
});

test('layers: decode errors, the rules of a name, and one issue per layer that is missing', () => {
  assert.deepEqual(decodeError((f) => { f.layers = 'Town'; }).issues.map((i) => [i.code, i.path]), [['type', 'layers']]);
  assert.deepEqual(decodeError((f) => { f.layers = ['Town', 5, null]; }).issues.map((i) => [i.code, i.path]), [['type', 'layers[1]'], ['type', 'layers[2]']]);
  assert.deepEqual(decodeError((f) => { f.objects[0].l = 5; }).issues.map((i) => [i.code, i.path]), [['type', 'objects[0].l']]);
  assert.deepEqual(decodeError((f) => { f.regions[0].l = 'Town'; }).issues.map((i) => [i.code, i.path]), [['unknown-key', 'regions[0].l']]);

  const issuesOf = (edit) => { const m = sampleMap(); edit(m); return validate(m).filter((i) => i.level === 'error').map((i) => [i.code, i.path]); };
  assert.deepEqual(issuesOf((m) => { m.layers = ['', 'x'.repeat(33), ' a', 'b\u0007', 'ok', 5]; }),
    [['layer-name', 'layers[0]'], ['layer-name', 'layers[1]'], ['layer-name', 'layers[2]'], ['layer-name', 'layers[3]'], ['layer-name', 'layers[5]']]);
  assert.deepEqual(issuesOf((m) => { m.layers = ['Town', 'TOWN', 'x'.repeat(32)]; }), [['layer-duplicate', 'layers[1]']]);
  assert.deepEqual(issuesOf((m) => { m.layers = Array.from({ length: 65 }, (_, i) => `L${i}`); }), [['too-many', 'layers']]);
  assert.deepEqual(issuesOf((m) => { m.layers = Array.from({ length: 64 }, (_, i) => `L${i}`); }), []);
  // every item of a layer the map does not list: ONE issue per name, at the first of them
  const m = sampleMap();
  m.layers = ['Town'];
  for (const o of m.objects) o.l = 'Gone';
  m.spawns[0].l = 'Gone';
  m.npcs[2].l = 'Lost';
  m.chests[0].l = 7;
  m.objects[5].l = 'Town';
  const found = validate(m).filter((i) => i.level === 'error');
  assert.deepEqual(found.map((i) => [i.code, i.path, i.kind, i.index]), [['type', 'chests[0].l', 'chest', 0], ['layer-unknown', 'spawns[0].l', 'spawn', 0], ['layer-unknown', 'npcs[2].l', 'npc', 2]]);
  assert.match(found[1].message, /"Gone".*\(6 items are on it\)/);
  assert.match(found[2].message, /^The layer "Lost" is not among the map's layers\.$/);
  assert.deepEqual([found[1].x, found[1].z], [50, 10]);
  // a map built before layers existed has no list and no `l`: valid, and written without either
  const old = sampleMap();
  delete old.layers;
  for (const list of ['objects', 'spawns', 'chests', 'npcs']) for (const item of old[list]) delete item.l;
  assert.deepEqual(validate(old).filter((i) => i.level === 'error'), []);
  assert.deepEqual(serialize(old), sample());
  assert.equal(validate({ ...sampleMap(), layers: 'Town' })[0].code, 'type');

  assert.equal(layerProblem(['Town'], 'Forest'), null);
  assert.equal(layerProblem([], 'x'.repeat(32)), null);
  assert.equal(layerProblem(undefined, 'Forest'), null);
  assert.match(layerProblem(['Town'], 'town'), /taken/);
  assert.equal(layerProblem(['Town'], 'TOWN', 'Town'), null, 'the layer that is being renamed may keep its name in another case');
  assert.match(layerProblem(['Town', 'Forest'], 'forest', 'Town'), /taken/);
  assert.match(layerProblem([], ''), /empty/);
  assert.match(layerProblem([], ' a'), /white space/);
  assert.match(layerProblem([], 'x'.repeat(33)), /at most 32/);
  assert.match(layerProblem([], 'a\nb'), /control/);
  assert.match(layerProblem([], 5), /empty/);
});

// ---------------------------------------------------------------- DECODE errors

test('migrate: version-invalid and version-newer', () => {
  const file = sample();
  assert.equal(migrate(file), file);
  for (const version of [0, -1, 1.5, '1', null, undefined, 1e999]) {
    const e = decodeError((f) => { f.version = version; });
    assert.deepEqual(e.issues.map((i) => [i.code, i.path]), [['version-invalid', 'version']], String(version));
  }
  const newer = decodeError((f) => { f.version = FORMAT_VERSION + 1; });
  assert.deepEqual(newer.issues.map((i) => i.code), ['version-newer']);
  assert.deepEqual(thrown(() => migrate({ version: 2 })).issues[0].code, 'version-newer');
  assert.deepEqual(decodeError((f) => { f.version = 2; }, { check: false }).issues[0].code, 'version-newer');
  for (const junk of [null, undefined, 7, 'map', [], [sample()]]) {
    assert.deepEqual(thrown(() => normalize(junk)).issues.map((i) => i.code), ['type'], String(junk));
  }
});

test('unknown-key: at every level, with the path', () => {
  const at = (edit) => decodeError(edit).issues.map((i) => `${i.code} ${i.path}`);
  assert.deepEqual(at((f) => { f.author = 'me'; }), ['unknown-key author']);
  assert.deepEqual(at((f) => { f.start.y = 0; }), ['unknown-key start.y']);
  assert.deepEqual(at((f) => { f.fallback.safe = true; }), ['unknown-key fallback.safe']);
  assert.deepEqual(at((f) => { f.regions[1].id = 7; }), ['unknown-key regions[1].id']);
  assert.deepEqual(at((f) => { f.regions[1].shape.radius = 24; }), ['unknown-key regions[1].shape.radius']);
  assert.deepEqual(at((f) => { f.regions[2].shape.r = 4; }), ['unknown-key regions[2].shape.r']);
  assert.deepEqual(at((f) => { f.spawns[0].type = 'chaser'; }), ['unknown-key spawns[0].type']);
  assert.deepEqual(at((f) => { f.chests[1].open = false; }), ['unknown-key chests[1].open']);
  assert.deepEqual(at((f) => { f.npcs[2].name = 'Bob'; }), ['unknown-key npcs[2].name']);
  assert.deepEqual(at((f) => { f.ground.cells = []; }), ['unknown-key ground.cells']);
  assert.deepEqual(at((f) => { f.objects[3].sx = 2; }), ['unknown-key objects[3].sx']);
  assert.deepEqual(at((f) => { f.objects[2].col[0].y = 1; }), ['unknown-key objects[2].col[0].y']);
  assert.deepEqual(at((f) => { f.objects[0]['k'.repeat(100)] = 1; }), [`unknown-key objects[0].${'k'.repeat(40)}…`]);
  // a draft or an import is decoded without the check: the key is still refused
  assert.deepEqual(decodeError((f) => { f.objects[3].sx = 2; }, { check: false }).issues[0].code, 'unknown-key');
});

test('not-finite: 1e999 parses to Infinity', () => {
  const huge = JSON.parse('1e999');
  assert.equal(huge, Infinity);
  const at = (edit) => decodeError(edit).issues.map((i) => `${i.code} ${i.path}`);
  assert.deepEqual(at((f) => { f.objects[0].x = huge; }), ['not-finite objects[0].x']);
  assert.deepEqual(at((f) => { f.radius = huge; }), ['not-finite radius']);
  assert.deepEqual(at((f) => { f.spawns[0].lvl[1] = huge; }), ['not-finite spawns[0].lvl[1]']);
  assert.deepEqual(at((f) => { f.spawns[0].types.chaser = -huge; }), ['not-finite spawns[0].types.chaser']);
  assert.deepEqual(at((f) => { f.regions[2].shape.points[1][0] = huge; }), ['not-finite regions[2].shape.points[1][0]']);
  assert.deepEqual(at((f) => { f.objects[2].col[0].r = huge; }), ['not-finite objects[2].col[0].r']);
  assert.deepEqual(at((f) => { f.objects[4].col = huge; }), ['not-finite objects[4].col']);
  assert.deepEqual(at((f) => { f.chests[0].ry = NaN; }), ['not-finite chests[0].ry']);
});

test('enum: only own keys of a table count', () => {
  const at = (edit) => decodeError(edit).issues.map((i) => `${i.code} ${i.path}`);
  assert.deepEqual(at((f) => { f.spawns[0].types = JSON.parse('{ "constructor": 1 }'); }), ['enum spawns[0].types.constructor']);
  assert.deepEqual(at((f) => { f.spawns[0].types = JSON.parse('{ "chaser": 1, "__proto__": 1, "toString": 2 }'); }),
    ['enum spawns[0].types.__proto__', 'enum spawns[0].types.toString']);
  assert.deepEqual(at((f) => { f.spawns[0].types.zombie = 1; }), ['enum spawns[0].types.zombie']);
  assert.deepEqual(at((f) => { f.npcs[0].kind = 'wizard'; }), ['enum npcs[0].kind']);
  assert.deepEqual(at((f) => { f.npcs[0].kind = 'length'; }), ['enum npcs[0].kind']);
  assert.deepEqual(at((f) => { f.regions[0].mood = 'sunny'; }), ['enum regions[0].mood']);
  assert.deepEqual(at((f) => { f.regions[0].mood = 'hasOwnProperty'; }), ['enum regions[0].mood']);
  assert.deepEqual(at((f) => { f.fallback.mood = 'valueOf'; }), ['enum fallback.mood']);
  assert.deepEqual(at((f) => { f.regions[0].shape.type = 'square'; }), ['enum regions[0].shape.type']);
  assert.deepEqual(at((f) => { f.regions[0].shape.type = 'object'; }), ['enum regions[0].shape.type']);
  for (const key of MOB_KEYS) assert.ok(Object.hasOwn(MOB_TYPES, key));
});

test('type: a wrong JSON type or a missing required key', () => {
  const at = (edit) => decodeError(edit).issues.map((i) => `${i.code} ${i.path}`);
  assert.deepEqual(at((f) => { delete f.radius; }), ['type radius']);
  assert.deepEqual(at((f) => { delete f.npcs; }), ['type npcs']);
  assert.deepEqual(at((f) => { delete f.objects[0].z; }), ['type objects[0].z']);
  assert.deepEqual(at((f) => { delete f.spawns[0].respawn; }), ['type spawns[0].respawn']);
  assert.deepEqual(at((f) => { delete f.regions[0].shape; }), ['type regions[0].shape']);
  assert.deepEqual(at((f) => { delete f.fallback.mood; }), ['type fallback.mood']);
  assert.deepEqual(at((f) => { f.name = 7; }), ['type name']);
  assert.deepEqual(at((f) => { f.foliage = 1; }), ['type foliage']);
  assert.deepEqual(at((f) => { f.regions = {}; }), ['type regions']);
  assert.deepEqual(at((f) => { f.objects[1] = [1, 2]; }), ['type objects[1]']);
  assert.deepEqual(at((f) => { f.objects[0].x = '3'; }), ['type objects[0].x']);
  assert.deepEqual(at((f) => { f.objects[0].m = 5; }), ['type objects[0].m']);
  assert.deepEqual(at((f) => { f.objects[0].g = 5; }), ['type objects[0].g']);
  assert.deepEqual(at((f) => { f.objects[0].col = 'sphere'; }), ['type objects[0].col'], 'a col string other than "box"');
  assert.deepEqual(at((f) => { f.objects[0].col = true; }), ['type objects[0].col']);
  assert.deepEqual(at((f) => { f.objects[2].col = [5]; }), ['type objects[2].col[0]']);
  assert.deepEqual(at((f) => { f.chests[0].big = 'yes'; }), ['type chests[0].big']);
  assert.deepEqual(at((f) => { f.spawns[0].types = ['chaser']; }), ['type spawns[0].types']);
  assert.deepEqual(at((f) => { f.spawns[0].lvl = [1, 2, 3]; }), ['type spawns[0].lvl']);
  assert.deepEqual(at((f) => { f.spawns[0].lvl = 4; }), ['type spawns[0].lvl']);
  assert.deepEqual(at((f) => { f.regions[0].levels = '1-9'; }), ['type regions[0].levels']);
  assert.deepEqual(at((f) => { f.regions[0].safe = 0; }), ['type regions[0].safe']);
  assert.deepEqual(at((f) => { f.regions[0].color = 0x3a8fb0; }), ['type regions[0].color']);
  assert.deepEqual(at((f) => { f.regions[2].shape.points = 'none'; }), ['type regions[2].shape.points']);
  assert.deepEqual(at((f) => { f.regions[2].shape.points[1] = [1, 2, 3]; }), ['type regions[2].shape.points[1]']);
  assert.deepEqual(at((f) => { f.regions[2].shape.type = 3; }), ['type regions[2].shape.type']);
  assert.deepEqual(at((f) => { f.ground.rows[3] = 121; }), ['type ground.rows[3]']);
  assert.deepEqual(at((f) => { f.ground.types = 'grass'; }), ['type ground.types']);
});

test('ground-cell, ground-size, ground-types and ground-rows are decode errors', () => {
  const at = (edit) => decodeError(edit, { check: false }).issues.map((i) => `${i.code} ${i.path}`);
  assert.deepEqual(at((f) => { f.ground.cell = 3; }), ['ground-cell ground.cell']);
  assert.deepEqual(at((f) => { f.ground.cell = 0.5; }), ['ground-cell ground.cell']);
  for (const size of [31, 120, 121.5, 515, -121]) assert.deepEqual(at((f) => { f.ground.size = size; }), ['ground-size ground.size'], String(size));
  assert.deepEqual(at((f) => { f.ground.types[1] = 'mud'; }), ['ground-types ground.types[1]']);
  assert.deepEqual(at((f) => { f.ground.types[1] = 'constructor'; }), ['ground-types ground.types[1]']);
  assert.deepEqual(at((f) => { f.ground.types[3] = 'grass'; }), ['ground-types ground.types[3]'], 'a duplicate id');
  assert.deepEqual(at((f) => { f.ground.types = []; }), ['ground-types ground.types']);
  assert.deepEqual(at((f) => { f.ground.types = Array.from({ length: 53 }, (_, i) => `t${i}`); }), ['ground-types ground.types']);
  assert.deepEqual(at((f) => { f.ground.rows.pop(); }), ['ground-rows ground.rows']);
  assert.deepEqual(at((f) => { f.ground.rows[17] = '120a'; }), ['ground-rows ground.rows[17]']);
  assert.deepEqual(at((f) => { f.ground.rows[17] = '121e'; }), ['ground-rows ground.rows[17]'], 'a symbol past the palette');
  assert.deepEqual(at((f) => { f.ground.rows[0] = ''; f.ground.rows[120] = '12 1a'; }), ['ground-rows ground.rows[0]', 'ground-rows ground.rows[120]']);
});

test('normalize reports every decode error at once, at most 100', () => {
  const e = decodeError((f) => { f.objects[0].x = 'a'; f.objects[1].sx = 1; f.npcs[0].kind = 'cat'; f.ground.cell = 3; f.zzz = 0; });
  assert.deepEqual(e.issues.map((i) => i.code).sort(), ['enum', 'ground-cell', 'type', 'unknown-key', 'unknown-key']);
  assert.ok(e.issues.every((i) => i.level === 'error' && typeof i.message === 'string' && /[.!]$/.test(i.message)));
  assert.equal(e.message, `${e.issues[0].path}: ${e.issues[0].message} (+4 more)`);
  assert.equal(e.name, 'MapError');
  assert.ok(e instanceof Error);

  const one = decodeError((f) => { f.zzz = 0; });
  assert.equal(one.message, 'zzz: Unknown key "zzz".');

  const many = decodeError((f) => { f.objects = Array.from({ length: 500 }, () => ({ m: 'medieval/barrel', x: 'a', z: 0 })); });
  assert.equal(many.issues.length, LIMITS.issues);
  assert.ok(many.message.endsWith('(+99 more)'));
});

test('a decode error wins over range errors; range errors need the check', () => {
  const both = (f) => { f.spawns[0].count = 99; f.objects[0].sx = 1; };
  assert.deepEqual(codes(decodeError(both).issues), ['unknown-key']);
  assert.deepEqual(codes(decodeError(both, { check: false }).issues), ['unknown-key']);
  const range = (f) => { f.spawns[0].count = 99; f.radius = 30; };
  assert.ok(codes(decodeError(range).issues).includes('spawn-count'));
  assert.equal(normalize(patched(range), { check: false }).radius, 30);
});

// ---------------------------------------------------------------- RANGE errors (validate)

const spawnOf = (m, n, count) => Array.from({ length: n }, () => ({ ...structuredClone(m.spawns[0]), count }));

// Each code, produced by editing a valid runtime map; the value is every error code validate must then report.
const RANGE_CASES = {
  radius: [(m) => { m.radius = 99.5; }, ['radius']],
  'ground-size': [(m) => { m.ground = { cell: 2, size: 515, cells: new Uint8Array(515 * 515) }; }, ['ground-size']],
  'ground-cover': [(m) => { m.radius = 101; }, ['ground-cover']],
  start: [(m) => { m.start.r = 41; }, ['start']],
  'start-blocked': [(m) => { m.ground.cells[cellIndex(m.ground, m.start.x, m.start.z)] = GROUND_INDEX.water; }, ['start-blocked']],
  'object-pos': [(m) => { m.objects[0].x = 121; }, ['object-pos']],
  'object-scale': [(m) => { m.objects[0].s = 0.04; }, ['object-scale']],
  col: [(m) => { m.objects[0].col = 4.01; }, ['col']],
  'spawn-types': [(m) => { m.spawns[0].types = {}; }, ['spawn-types']],
  'spawn-lvl': [(m) => { m.spawns[0].lvl = [3, 2]; }, ['spawn-lvl']],
  'spawn-count': [(m) => { m.spawns[0].count = 31; }, ['spawn-count']],
  'spawn-r': [(m) => { m.spawns[0].r = -1; }, ['spawn-r']],
  'spawn-respawn': [(m) => { m.spawns[0].respawn = 2; }, ['spawn-respawn']],
  'spawn-pos': [(m) => { m.spawns[0].x = 90; }, ['spawn-pos']],
  'spawn-in-safe': [(m) => { m.spawns[0].x = 5; m.spawns[0].z = 5; }, ['spawn-in-safe']],
  'spawn-total': [(m) => { m.spawns.push(...spawnOf(m, 40, 30)); }, ['spawn-total']],
  'chest-gold': [(m) => { m.chests[0].gold = 0; }, ['chest-gold']],
  'chest-respawn': [(m) => { m.chests[0].respawn = 9; }, ['chest-respawn']],
  'chest-pos': [(m) => { m.chests[0].x = 99.5; m.chests[0].z = 0; }, ['chest-pos']],
  'npc-pos': [(m) => { m.npcs[2].x = 99.5; }, ['npc-pos']],
  'region-circle': [(m) => { m.regions[1].shape.r = 0.5; }, ['region-circle']],
  'region-poly': [(m) => { m.regions[2].shape.points.length = 2; }, ['region-poly']],
  'region-pos': [(m) => { m.regions[2].shape.points[0][0] = 500; }, ['region-pos']],
  'region-levels': [(m) => { m.regions[0].levels = [5, 100]; }, ['region-levels']],
  'too-many': [(m) => { while (m.npcs.length < 41) m.npcs.push({ kind: 'guard', x: 10, z: m.npcs.length, ry: 0, g: null, l: null }); }, ['too-many']],
  'layer-name': [(m) => { m.layers = ['Town', ' Forest']; }, ['layer-name']],
  'layer-duplicate': [(m) => { m.layers = ['Town', 'Forest', 'town']; }, ['layer-duplicate']],
  'layer-unknown': [(m) => { m.layers = ['Town']; m.objects[0].l = 'Town'; m.chests[0].l = 'Forest'; }, ['layer-unknown']],
  string: [(m) => { m.regions[2].name = ''; }, ['string']],
  enum: [(m) => { m.objects[0].g = 'a b'; }, ['enum']],
  'model-missing': [(m) => { m.objects[0].m = 'dungeon/no_such_file'; }, ['model-missing'],
    { models: new Set(sample().objects.map((o) => o.m)), strictModels: true }],
};

test('every RANGE code is reported by validate after an edit of a valid map', () => {
  assert.deepEqual(Object.keys(RANGE_CASES).sort(), [
    'chest-gold', 'chest-pos', 'chest-respawn', 'col', 'enum', 'ground-cover', 'ground-size', 'layer-duplicate', 'layer-name', 'layer-unknown',
    'model-missing', 'npc-pos', 'object-pos',
    'object-scale', 'radius', 'region-circle', 'region-levels', 'region-poly', 'region-pos', 'spawn-count', 'spawn-in-safe', 'spawn-lvl',
    'spawn-pos', 'spawn-r', 'spawn-respawn', 'spawn-total', 'spawn-types', 'start', 'start-blocked', 'string', 'too-many',
  ]);
  for (const [code, [edit, expected, options]] of Object.entries(RANGE_CASES)) {
    assert.deepEqual(errorCodes(edit, options), expected, code);
    // the same state is refused by normalize and by a checked save, but loads as a draft
    if (options) continue;
    const m = sampleMap();
    edit(m);
    assert.throws(() => serialize(m), MapError, code);
    const file = serialize(m, { check: false });
    assert.ok(codes(thrown(() => normalize(file)).issues).includes(code), code);
    // ground-size is the one code that decoding raises too: the cells cannot be allocated without it
    if (code === 'ground-size') assert.deepEqual(codes(thrown(() => normalize(file, { check: false })).issues), ['ground-size']);
    else assert.deepEqual(normalize(file, { check: false }), m, code);
  }
});

test('issues carry the path, the item and a place to look at', () => {
  const m = sampleMap();
  m.objects[3].s = 50;
  m.spawns[1].count = 0;
  m.regions[2].name = 'Lake ';
  const issues = validate(m);
  assert.deepEqual(issues.map((i) => i.path), ['regions[2].name', 'spawns[1].count', 'objects[3].s']);
  assert.deepEqual(issues[2], { level: 'error', code: 'object-scale', path: 'objects[3].s', message: issues[2].message, kind: 'object', index: 3, x: -30.5, z: 20 });
  assert.deepEqual([issues[1].kind, issues[1].index, issues[1].x, issues[1].z], ['spawn', 1, 0, -80]);
  assert.deepEqual([issues[0].kind, issues[0].index], ['region', 2]);
  assert.ok(Math.abs(issues[0].x - (40 + 60 + 52) / 3) < 1e-9);
  for (const i of issues) assert.match(i.message, /^[A-Z].*[.!]$/);
  assert.deepEqual(JSON.parse(JSON.stringify(issues)), issues, 'issues are plain data');

  // x and z are a place to look at or they are absent: an outline without points has no centre, a lost item no
  // position, and NaN would cross HTTP as null
  const lost = sampleMap();
  lost.regions[2].shape.points = [];
  lost.objects[0].x = NaN;
  lost.chests[0].z = undefined;
  lost.spawns[0].x = Infinity;
  const found = validate(lost), placeless = found.filter((i) => i.x === undefined);
  assert.deepEqual(placeless.map((i) => [i.code, i.kind, i.index]), [['region-poly', 'region', 2], ['spawn-pos', 'spawn', 0],
    ['chest-pos', 'chest', 0], ['object-pos', 'object', 0], ['region-outside', 'region', 2], ['spawn-unplaceable', 'spawn', 0]]);
  for (const i of placeless) assert.deepEqual(Object.keys(i), ['level', 'code', 'path', 'message', 'kind', 'index'], i.code);
  for (const i of found) if (i.x !== undefined && !(Number.isFinite(i.x) && Number.isFinite(i.z))) assert.fail(`${i.code} points at ${i.x}, ${i.z}`);
  assert.deepEqual(JSON.parse(JSON.stringify(found)), found);
});

test('validate lists errors before warnings and never throws', () => {
  const m = sampleMap();
  m.npcs.length = 0;                       // two warnings ...
  m.objects[5].s = 0;                      // ... found before this error
  const levels = validate(m).map((i) => i.level);
  assert.deepEqual(levels, ['error', 'warning', 'warning']);
  for (const junk of [{}, null, undefined, 5, { regions: [] }, { ...sampleMap(), ground: null }, { ...sampleMap(), spawns: [null] }]) {
    const issues = validate(junk);
    assert.ok(Array.isArray(issues) && issues.length >= 1 && issues[0].level === 'error', String(junk));
  }
  // values that are not numbers at all fail the range rule of their field
  assert.deepEqual(errorCodes((x) => { x.objects[0].s = NaN; x.chests[0].gold = '12'; x.spawns[0].r = undefined; }),
    ['chest-gold', 'object-scale', 'spawn-pos', 'spawn-r']);
});

test('validate also reports what only a bug can put into a runtime map', () => {
  // none of these can come out of a file (decoding refuses them) or out of a field of the inspector;
  // each would be written as a file that does not load, so none may pass as "no errors"
  const cases = [
    [(m) => { m.objects[0].ry = NaN; }, 'not-finite', 'objects[0].ry'],
    [(m) => { m.objects[0].rx = undefined; }, 'not-finite', 'objects[0].ry'],
    [(m) => { m.chests[0].ry = Infinity; }, 'not-finite', 'chests[0].ry'],
    [(m) => { m.npcs[0].ry = '90'; }, 'not-finite', 'npcs[0].ry'],
    [(m) => { m.npcs[0].kind = 'wizard'; }, 'enum', 'npcs[0].kind'],
    [(m) => { m.regions[0].mood = ''; }, 'enum', 'regions[0].mood'],
    [(m) => { m.regions[0].mood = 'toString'; }, 'enum', 'regions[0].mood'],
    [(m) => { m.fallback.mood = null; }, 'enum', 'fallback.mood'],
    [(m) => { m.regions[2].shape.type = 'star'; }, 'enum', 'regions[2].shape.type'],
    [(m) => { m.regions[1].safe = 1; }, 'type', 'regions[1].safe'],
    [(m) => { m.chests[1].big = 'yes'; }, 'type', 'chests[1].big'],
    [(m) => { m.foliage = undefined; }, 'type', 'foliage'],
    [(m) => { m.ground.cell = 3; }, 'ground-cell', 'ground.cell'],
    [(m) => { m.ground.cells[121 * 7 + 3] = 99; }, 'ground-types', 'ground.rows[7]'],
    [(m) => { m.chests = { 0: m.chests[0] }; }, 'type', 'map'],
    [(m) => { m.objects[0].x = '3'; }, 'object-pos', 'objects[0]'],
    [(m) => { m.chests[0].z = null; }, 'chest-pos', 'chests[0]'],
    [(m) => { m.start.x = true; }, 'start', 'start'],
  ];
  for (const [edit, code, path] of cases) {
    const m = sampleMap();
    edit(m);
    assert.deepEqual(errorsOf(validate(m)).map((i) => [i.code, i.path]), [[code, path]], `${code} ${path}`);
    assert.throws(() => serialize(m), MapError);
  }
  // null and undefined are the same "nothing" wherever the runtime form allows null
  const m = sampleMap();
  Object.assign(m.objects[0], { g: undefined, col: undefined });
  Object.assign(m.regions[2], { levels: undefined, mood: undefined, color: undefined });
  m.fallback.levels = undefined;
  assert.deepEqual(validate(m), []);
  assert.deepEqual(serialize(m), patched((f) => { delete f.objects[0].g; delete f.regions[2].color; }));
});

test('validate stays quick on a hostile file: lists over their cap are not cross-checked', () => {
  const m = sampleMap();
  const maze = Array.from({ length: 50000 }, (_, i) => [qPos(90 * Math.cos(i / 7958)), qPos(90 * Math.sin(i / 7958))]);
  m.regions = Array.from({ length: 4000 }, (_, i) => region(`R${i}`, { type: 'circle', x: (i % 80) - 40, z: Math.floor(i / 80) - 25, r: 30 }, { safe: i % 2 === 0 }));
  m.regions.unshift(region('Maze', { type: 'poly', points: maze }, { safe: true }));
  m.spawns = Array.from({ length: 4000 }, (_, i) => ({ ...structuredClone(m.spawns[0]), x: 30 + (i % 60), z: (i % 50) - 25 }));
  m.chests = Array.from({ length: 4000 }, () => ({ ...m.chests[0] }));
  const started = performance.now(), issues = validate(m);
  assert.ok(performance.now() - started < 3000, 'a fraction of a second on any machine');
  assert.deepEqual(errorsOf(issues).filter((i) => i.code === 'too-many').map((i) => i.path), ['regions', 'spawns', 'chests']);
  assert.deepEqual(errorsOf(issues).filter((i) => i.code === 'region-poly').map((i) => i.path), ['regions[0].shape.points']);
});

test('string: names', () => {
  assert.deepEqual(errorCodes((m) => { m.regions[2].name = ''; }), ['string']);
  assert.deepEqual(errorCodes((m) => { m.regions[2].name = 'Lake '; }), ['string']);
  assert.deepEqual(errorCodes((m) => { m.regions[2].name = '\tLake'; }), ['string']);
  assert.deepEqual(errorCodes((m) => { m.regions[2].name = 'La\u0007ke'; }), ['string']);
  assert.deepEqual(errorCodes((m) => { m.regions[2].name = 'La\u007fke'; }), ['string']);
  assert.deepEqual(errorCodes((m) => { m.regions[2].name = 'x'.repeat(49); }), ['string']);
  assert.deepEqual(errorCodes((m) => { m.regions[2].name = 'x'.repeat(48); }), []);
  assert.deepEqual(errorCodes((m) => { m.name = 'x'.repeat(65); }), ['string']);
  assert.deepEqual(errorCodes((m) => { m.name = 'x'.repeat(64); }), []);
  assert.deepEqual(errorCodes((m) => { m.name = ''; }), ['string']);
  assert.deepEqual(errorCodes((m) => { m.fallback.name = ' '; }), ['string']);
  assert.deepEqual(errorCodes((m) => { m.fallback.name = 'x'.repeat(49); }), ['string']);
  assert.deepEqual(errorCodes((m) => { m.name = 'Île des Chats · №7'; m.regions[2].name = 'Lake of Tears'; }), []);
  const paths = (edit) => { const m = sampleMap(); edit(m); return validate(m).map((i) => i.path); };
  assert.deepEqual(paths((m) => { m.name = ''; m.fallback.name = ''; m.regions[0].name = ''; }), ['name', 'fallback.name', 'regions[0].name']);
});

test('enum: group names, colours and model ids', () => {
  for (const g of ['a b', '', '-a', 'x'.repeat(33), 'é', 5]) assert.deepEqual(errorCodes((m) => { m.objects[0].g = g; }), ['enum'], String(g));
  for (const g of ['a', 'plot-01', 'Town.wall_2', 'x'.repeat(32), '7']) assert.deepEqual(errorCodes((m) => { m.objects[0].g = g; }), [], g);
  assert.deepEqual(errorCodes((m) => { m.spawns[0].g = 'a b'; }), ['enum']);
  assert.deepEqual(errorCodes((m) => { m.chests[0].g = 'a b'; }), ['enum']);
  assert.deepEqual(errorCodes((m) => { m.npcs[0].g = 'a b'; }), ['enum']);
  for (const color of ['#ABCDEF', '#abc', 'red', '#12345g', '3a8fb0']) assert.deepEqual(errorCodes((m) => { m.regions[2].color = color; }), ['enum'], color);
  assert.deepEqual(errorCodes((m) => { m.regions[2].color = '#00ff7f'; }), []);
  for (const id of ['Medieval/barrel', 'medieval', 'medieval/', 'medieval/a b', '/barrel', 'medieval/../x', 'nopack/thing', 'constructor/x', 'builtin/nothing', '']) {
    assert.deepEqual(errorCodes((m) => { m.objects[0].m = id; }), ['enum'], id);
  }
  for (const id of ['medieval/anything_New-1', 'builtin/fountain', 'dungeon/chest']) assert.deepEqual(errorCodes((m) => { m.objects[0].m = id; }), [], id);
});

test('too-many: the five collection caps', () => {
  const guard = (i) => ({ kind: 'guard', x: 10, z: i, ry: 0, g: null });
  assert.deepEqual(errorCodes((m) => { m.npcs = Array.from({ length: 40 }, (_, i) => guard(i)); }), []);
  assert.deepEqual(errorCodes((m) => { m.npcs = Array.from({ length: 41 }, (_, i) => guard(i)); }), ['too-many']);
  assert.deepEqual(errorCodes((m) => { m.chests = Array.from({ length: 201 }, () => ({ ...m.chests[0] })); }), ['too-many']);
  assert.deepEqual(errorCodes((m) => { m.spawns = spawnOf(m, 301, 1); }), ['too-many']);
  assert.deepEqual(errorCodes((m) => { m.regions = Array.from({ length: 65 }, () => structuredClone(m.regions[0])); }), ['too-many']);
  const trees = (m, n) => Array.from({ length: n }, (_, i) => ({ ...m.objects[5], x: (i % 240) - 120, z: Math.floor(i / 240) - 105 }));
  assert.deepEqual(errorCodes((m) => { m.objects = trees(m, 50001); }), ['too-many']);
  assert.deepEqual(errorCodes((m) => { m.objects = trees(m, 50000); }), []);
  const paths = (edit) => { const m = sampleMap(); edit(m); return errorsOf(validate(m)).map((i) => i.path); };
  assert.deepEqual(paths((m) => { m.npcs = Array.from({ length: 41 }, (_, i) => guard(i)); }), ['npcs']);
});

test('range rules at their boundaries', () => {
  assert.ok(errorCodes((m) => { m.radius = 39; }).includes('radius'));
  assert.ok(errorCodes((m) => { m.radius = 601; }).includes('radius'));
  assert.deepEqual(errorCodes((m) => { m.radius = 100; }), []);
  assert.deepEqual(errorCodes((m) => { m.ground.cells = m.ground.cells.slice(1); }), ['ground-size']);
  assert.deepEqual(errorCodes((m) => { m.start.x = 88; m.start.z = 0; }), [], '88 + 10 = radius - 2');
  assert.deepEqual(errorCodes((m) => { m.start.x = 88.01; m.start.z = 0; }), ['start']);
  assert.deepEqual(errorCodes((m) => { m.start.r = -1; }), ['start']);
  assert.deepEqual(errorCodes((m) => { m.objects[0].x = 120; m.objects[0].z = -120; }), []);
  assert.deepEqual(errorCodes((m) => { m.objects[0].z = 120.01; }), ['object-pos']);
  assert.deepEqual(errorCodes((m) => { m.objects[0].y = 100.01; }), ['object-pos']);
  assert.deepEqual(errorCodes((m) => { m.objects[0].y = -20; m.objects[1].y = 100; }), []);
  assert.deepEqual(errorCodes((m) => { m.objects[0].sy = 20.001; }), ['object-scale']);
  assert.deepEqual(errorCodes((m) => { m.objects[0].s = 0.05; m.objects[0].sy = 20; }), []);
  assert.deepEqual(errorCodes((m) => { m.spawns[0].r = 80.5; }), ['spawn-pos', 'spawn-r']);
  assert.deepEqual(errorCodes((m) => { m.spawns[0].x = 84.5; m.spawns[0].z = 0; }), [], '84.5 + 12.5 = radius - 3');
  assert.deepEqual(errorCodes((m) => { m.spawns[0].x = 84.51; m.spawns[0].z = 0; }), ['spawn-pos']);
  for (const count of [0, 31, 2.5, -1]) assert.deepEqual(errorCodes((m) => { m.spawns[0].count = count; }), ['spawn-count'], String(count));
  for (const respawn of [2, 3601, 14.5]) assert.deepEqual(errorCodes((m) => { m.spawns[0].respawn = respawn; }), ['spawn-respawn'], String(respawn));
  for (const lvl of [[0, 1], [1, 100], [1.5, 2], [3, 2], [1], [1, 2, 3], null]) {
    assert.ok(errorCodes((m) => { m.spawns[0].lvl = lvl; }).includes('spawn-lvl'), String(lvl));
  }
  for (const types of [{}, { chaser: 0 }, { chaser: 101 }, { chaser: 1.5 }, { zombie: 1 }, { constructor: 1 }]) {
    assert.deepEqual(errorCodes((m) => { m.spawns[0].types = types; }), ['spawn-types'], JSON.stringify(types));
  }
  assert.deepEqual(errorCodes((m) => { m.spawns[0].types = { chaser: 1, runner: 100, shooter: 50, tank: 2, boss: 1 }; m.spawns[1].types = { tank: 1 }; }), []);
  for (const gold of [0, 100001, 1.5]) assert.deepEqual(errorCodes((m) => { m.chests[0].gold = gold; }), ['chest-gold'], String(gold));
  for (const respawn of [9, 86401, 10.5]) assert.deepEqual(errorCodes((m) => { m.chests[0].respawn = respawn; }), ['chest-respawn'], String(respawn));
  assert.deepEqual(errorCodes((m) => { m.chests[0].x = 99; m.chests[0].z = 0; m.npcs[2].x = 0; m.npcs[2].z = -99; }), []);
  assert.deepEqual(errorCodes((m) => { m.npcs[2].x = 0; m.npcs[2].z = -99.01; }), ['npc-pos']);
  assert.deepEqual(errorCodes((m) => { m.spawns.push(...spawnOf(m, 39, 30), ...spawnOf(m, 1, 25)); }), [], '4 + 1 + 1170 + 25 = 1200 monsters');
});

test('col: every form and its limits', () => {
  const circles = (n, c = { x: 0, z: 0, r: 1 }) => Array.from({ length: n }, () => ({ ...c }));
  for (const col of [null, 0, 0.01, 4, 'box', circles(1), circles(8), [{ x: -50, z: 50, r: 50 }]]) {
    assert.deepEqual(errorCodes((m) => { m.objects[0].col = col; }), [], JSON.stringify(col));
  }
  const wrong = [-0.5, 4.01, NaN, 'sphere', true, [], circles(9), [{ x: 50.001, z: 0, r: 1 }], [{ x: 0, z: -51, r: 1 }], [{ x: 0, z: 0, r: 0 }],
    [{ x: 0, z: 0, r: 50.5 }], [null]];
  for (const col of wrong) {
    assert.deepEqual(errorCodes((m) => { m.objects[0].col = col; }), ['col'], JSON.stringify(col));
  }
});

test('regions: circles, polygons, levels', () => {
  assert.deepEqual(errorCodes((m) => { m.regions[0].shape.r = 1201; }), ['region-circle']);
  assert.deepEqual(errorCodes((m) => { m.regions[0].shape.r = 1200; m.regions[2].shape = { type: 'circle', x: 240, z: -240, r: 1 }; }), []);
  assert.deepEqual(errorCodes((m) => { m.regions[2].shape = { type: 'circle', x: 240.01, z: 0, r: 5 }; }), ['region-pos']);
  assert.deepEqual(errorCodes((m) => { m.regions[2].shape.points[1][1] = -240.5; }), ['region-pos']);
  const ring = (n, r = 30) => Array.from({ length: n }, (_, i) => [qPos(60 + r * Math.cos(i * 2 * Math.PI / n)), qPos(r * Math.sin(i * 2 * Math.PI / n))]);
  assert.deepEqual(errorCodes((m) => { m.regions[2].shape.points = ring(64); }), []);
  assert.deepEqual(errorCodes((m) => { m.regions[2].shape.points = ring(65); }), ['region-poly'], 'a 65th point is region-poly, not too-many');
  assert.deepEqual(errorCodes((m) => { m.regions[2].shape.points = []; }), ['region-poly']);
  assert.deepEqual(errorCodes((m) => { m.regions[2].shape.points = [[0, 30], [10, 30], [20, 30]]; }), ['region-poly'], 'no area');
  assert.deepEqual(errorCodes((m) => { m.regions[2].shape.points = [[40, 40], [41, 40], [40, 41.9]]; }), ['region-poly'], 'area 0.95');
  assert.deepEqual(errorCodes((m) => { m.regions[2].shape.points = [[40, 40], [42, 40], [40, 41]]; }), [], 'area 1');
  // points are counted as normalize would keep them: a repeated or closing point is not a point of its own
  assert.deepEqual(errorCodes((m) => { m.regions[2].shape.points = [[40, 40], [60, 44], [60, 44], [40, 40]]; }), ['region-poly']);
  assert.deepEqual(errorCodes((m) => { const p = ring(64); m.regions[2].shape.points = [...p, [p[0][0], p[0][1]]]; }), []);
  for (const levels of [[0, 4], [3, 2], [1, 100], [1.5, 2], [1], 'x']) {
    assert.deepEqual(errorCodes((m) => { m.regions[0].levels = levels; }), ['region-levels'], String(levels));
  }
  assert.deepEqual(errorCodes((m) => { m.fallback.levels = [9, 1]; }), ['region-levels']);
  assert.deepEqual(errorCodes((m) => { m.fallback.levels = [1, 99]; m.regions[0].levels = [7, 7]; }), []);
});

test('a polygon is written as normalize would keep it, so the text of a valid map is always canonical', () => {
  const m = sampleMap(), lake = [[40, 40], [60, 44], [52, 60]];
  m.regions[2].shape.points = [[40, 40], [60, 44], [60, 44], [52, 60], [40, 40]];       // a repeated point and a closing one
  assert.deepEqual(validate(m), [], 'such an outline is valid: it has three distinct points');
  assert.deepEqual(serialize(m).regions[2].shape.points, lake);
  assert.deepEqual(encodeItem('region', m.regions[2]).shape.points, lake);
  assert.equal(m.regions[2].shape.points.length, 5, 'the map itself is not repaired');
  const text = stringifyMap(serialize(m));
  assert.ok(stringifyMap(serialize(normalize(JSON.parse(text)))) === text, 'the text does not come back byte for byte');
  assert.ok(text === stringifyMap(sample()));
  // the round trip differs from the map by that repair and by nothing else
  const back = normalize(serialize(m));
  m.regions[2].shape.points = lake;
  assert.deepEqual(back, m);
  // work in progress goes the same way: two points are still two points
  m.regions[2].shape.points = [[40, 40], [40, 40], [60, 44], [40, 40]];
  assert.deepEqual(serialize(m, { check: false }).regions[2].shape.points, [[40, 40], [60, 44]]);
  assert.throws(() => serialize(m), MapError);
});

test('model-missing: an error with strictModels, else a warning, one per model', () => {
  const models = new Set(['medieval/tree_single_A', 'halloween/grave_A', 'halloween/pillar', 'medieval/rock_single_A', 'dungeon/torch_mounted']);
  const m = sampleMap();
  m.objects.push({ ...m.objects[3], x: 0 }, { ...m.objects[3], x: 5 });
  const strict = validate(m, { models, strictModels: true });
  assert.deepEqual(strict.map((i) => [i.level, i.code, i.path, i.index]), [['error', 'model-missing', 'objects[3].m', 3]]);
  assert.match(strict[0].message, /medieval\/fence_stone_straight.*3 objects/);
  assert.deepEqual(validate(m, { models }).map((i) => [i.level, i.code]), [['warning', 'model-missing']]);
  assert.deepEqual(validate(m), [], 'without a model list the check is off');
  assert.deepEqual(validate(m, { strictModels: true }), []);
  assert.deepEqual(codes(validate(m, { models: new Set(), strictModels: true })), ['model-missing']);
  assert.equal(validate(m, { models: new Set(), strictModels: true }).length, 6);
});

// ---------------------------------------------------------------- warnings

test('warnings: regions, start and NPCs', () => {
  assert.deepEqual(warningCodes(() => {}), []);
  assert.deepEqual(warningCodes((m) => { m.regions[1].safe = false; }), ['no-safe-region', 'npc-unsafe', 'start-unsafe']);
  assert.deepEqual(warningCodes((m) => { m.start.r = 20; }), ['start-unsafe'], 'the rim leaves the town');
  assert.deepEqual(warningCodes((m) => { m.start.z = 4; m.start.r = 20; }), [], '(0, 4) + 20 = the town edge, which is inclusive');
  assert.deepEqual(warningCodes((m) => { m.npcs.length = 0; }), ['no-blacksmith', 'no-sage']);
  const messages = (edit) => { const m = sampleMap(); edit(m); return warningsOf(validate(m)).map((i) => i.message); };
  assert.deepEqual(messages((m) => { m.npcs.length = 0; }), ['No Blacksmith on the map: weapon upgrades are unavailable.',
    'No Sage on the map: players cannot learn skills or choose a profession.']);
  assert.deepEqual(warningCodes((m) => { m.npcs[1].x = 40; }), ['npc-unsafe']);
  assert.deepEqual(warningCodes((m) => { m.npcs[2].x = 40; }), [], 'a guard may stand outside');
  assert.deepEqual(warningCodes((m) => { m.npcs[2].x = 50; m.npcs[2].z = 84; }), ['npc-blocked']);
  assert.deepEqual(warningCodes((m) => { m.chests[0].x = 50; m.chests[0].z = 84; }), ['chest-blocked']);
  assert.deepEqual(warningCodes((m) => { m.regions[2].shape.points = [[40, 40], [70, 60], [70, 40], [40, 50]]; }), ['region-self-intersect']);
  assert.deepEqual(warningCodes((m) => { m.regions[2].shape.points = [[40, 40], [70, 40], [70, 60], [40, 50]]; }), []);
  assert.deepEqual(warningCodes((m) => { m.regions[2].shape = { type: 'circle', x: 130, z: 0, r: 29 }; }), ['region-outside']);
  assert.deepEqual(warningCodes((m) => { m.regions[2].shape = { type: 'circle', x: 130, z: 0, r: 30 }; }), []);
  assert.deepEqual(warningCodes((m) => { m.regions[2].shape.points = [[150, 150], [170, 150], [160, 170]]; }), ['region-outside']);
});

test('region-self-intersect: an outline that passes through itself at a vertex crosses, one that touches itself does not', () => {
  const crosses = (points) => warningCodes((m) => { m.regions[2].shape.points = points; }).includes('region-self-intersect');
  // the same answer wherever the outline starts, whichever way it runs, and at any place on the 0.01 grid
  const all = (points, expected, why) => {
    for (let k = 0; k < points.length; k++) {
      const turned = [...points.slice(k), ...points.slice(0, k)];
      for (const list of [turned, [...turned].reverse(), turned.map(([x, z]) => [qPos(x * 0.07 + 1.13), qPos(z * 0.07 - 2.41)])]) {
        assert.equal(crosses(list), expected, `${why}: ${JSON.stringify(list)}`);
      }
    }
  };
  // the vertex (10, 10) lies on the edge (0, 0) - (20, 20) and the outline goes on to the other side of it
  all([[0, 0], [20, 20], [30, 0], [10, 10], [0, 40]], true, 'through an edge at a vertex');
  all([[0, 0], [20, 20], [30, 0], [10, 10.01], [0, 40]], true, 'just short of the edge');
  all([[0, 0], [20, 20], [30, 0], [10, 9.99], [0, 40]], true, 'just past the edge');
  all([[0, 0], [20, 20], [30, 0], [10, 10], [20, -10]], false, 'the vertex touches the edge and turns back');
  // two vertices on one spot
  all([[0, 0], [5, 5], [10, 10], [10, 0], [5, 5], [0, 10]], true, 'two strands cross at a shared vertex');
  all([[0, 0], [5, 5], [10, 0], [10, 10], [5, 5], [0, 10]], false, 'two triangles meet at a point');
  all([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0], [3, 3], [3, 7], [7, 7], [7, 3], [3, 3]], false, 'a hole reached over a bridge');
  all([[0, 0], [10, 0], [10, 10], [0, 10]], false, 'a square');
  all([[0, 0], [10, 0], [10, 10], [5, 10], [5, 0]], false, 'a vertex on an edge, coming from one side only');
  all([[0, 0], [10, 10], [10, 0], [0, 10]], true, 'a bowtie');
});

test('warnings: spawns', () => {
  assert.deepEqual(warningCodes((m) => { m.spawns.length = 0; }), ['no-spawns']);
  assert.deepEqual(warningCodes((m) => { m.spawns[0].types.boss = 1; }), ['multi-boss']);
  assert.deepEqual(warningCodes((m) => { m.spawns[0].r = 0; }), ['spawn-stacked']);
  assert.deepEqual(warningCodes((m) => { m.spawns[0].r = 0; m.spawns[0].count = 1; }), []);
  assert.deepEqual(warningCodes((m) => { m.spawns[0].x = 50; m.spawns[0].z = 84; m.spawns[0].r = 30; }), ['spawn-blocked']);
  assert.deepEqual(warningCodes((m) => { m.spawns[0].x = 50; m.spawns[0].z = 84; m.spawns[0].r = 2; }), ['spawn-blocked', 'spawn-unplaceable']);
  assert.deepEqual(warningCodes((m) => { m.spawns[0].lvl = [8, 10]; }), ['spawn-levels']);
  assert.deepEqual(warningCodes((m) => { m.spawns[0].lvl = [1, 9]; }), []);
  // the town is r 24: a disc of r 12.5 wanders 5 further, so its centre must be more than 41.5 away
  assert.deepEqual(warningCodes((m) => { m.spawns[0].x = 41; m.spawns[0].z = 0; }), ['spawn-near-safe']);
  assert.deepEqual(warningCodes((m) => { m.spawns[0].x = 42; m.spawns[0].z = 0; }), []);
  // 300 monsters inside one view radius; under 800 in total
  assert.deepEqual(warningCodes((m) => { m.spawns.push(...spawnOf(m, 10, 30)); }), ['spawn-dense']);
  assert.deepEqual(warningCodes((m) => { m.spawns.push(...spawnOf(m, 2, 30)); }), [], '4 + 60 monsters is not dense');
  assert.deepEqual(warningCodes((m) => { m.spawns.push(...spawnOf(m, 27, 30)); }), ['many-monsters', 'spawn-dense'], '815 monsters');
});

test('no spawn-levels for a boss spawn', () => {
  const m = sampleMap();
  assert.deepEqual(m.spawns[1].lvl, [18, 18]);
  assert.deepEqual(regionAt(m, 0, -80).levels, [1, 9], 'the boss is far above the levels of its region');
  assert.ok(!codes(validate(m)).includes('spawn-levels'));
  // the same spawn without the boss is a mismatch
  assert.deepEqual(warningCodes((x) => { x.spawns[1].types = { tank: 1 }; }), ['spawn-levels']);
  assert.deepEqual(warningCodes((x) => { x.spawns[1].types = { tank: 1, boss: 1 }; }), []);
  // a region without levels asks for nothing
  assert.deepEqual(warningCodes((x) => { x.spawns[1].types = { tank: 1 }; x.regions[0].levels = null; }), []);
});

test('spawn-threat-start only for start points a monster can reach', () => {
  // a camp 30 units from the centre threatens r + wander + aggro = 5 + 5 + 13 = 23 units around it, deep into the town ...
  const camp = (m) => { Object.assign(m.spawns[0], { x: 30, z: 0, r: 5 }); };
  assert.ok(Math.hypot(30 - 10, 6) < 5 + WANDER_R + AGGRO_R);
  // ... but the start disc is wholly safe, and monsters neither target nor enter safe points
  assert.deepEqual(warningCodes(camp), ['spawn-near-safe']);
  // once part of the start disc sticks out of the town, the same camp is a threat
  assert.deepEqual(warningCodes((m) => { camp(m); m.start.x = 12; m.start.z = 0; m.start.r = 14; }), ['spawn-near-safe', 'spawn-threat-start', 'start-unsafe']);
  // a boss notices players from further away
  const far = (types) => (m) => { m.start.x = 12; m.start.z = 0; m.start.r = 14; Object.assign(m.spawns[0], { x: 55, z: 0, r: 5, types }); };
  assert.ok(55 - 26 > 5 + WANDER_R + AGGRO_R && 55 - 26 <= 5 + WANDER_R + BOSS_AGGRO_R);
  assert.deepEqual(warningCodes(far({ chaser: 1 })), ['start-unsafe']);
  assert.deepEqual(warningCodes(far({ boss: 1 })), ['multi-boss', 'spawn-threat-start', 'start-unsafe']);
});

test('warnings: objects', () => {
  assert.deepEqual(warningCodes((m) => { m.objects[0].x = 0; m.objects[0].z = -110.5; }), ['object-outside']);
  assert.deepEqual(warningCodes((m) => { m.objects[0].x = 0; m.objects[0].z = -110; }), []);
  const twin = (dx, dz, m = 'medieval/tree_single_A') => (map) => { map.objects.push({ ...map.objects[5], m, x: qPos(31.2 + dx), z: qPos(-4.5 + dz) }); };
  assert.deepEqual(warningCodes(twin(0, 0)), ['object-duplicate']);
  assert.deepEqual(warningCodes(twin(0.05, -0.05)), ['object-duplicate']);
  assert.deepEqual(warningCodes(twin(0.06, 0)), []);
  assert.deepEqual(warningCodes(twin(0, 0.06)), []);
  assert.deepEqual(warningCodes(twin(0, 0, 'medieval/tree_single_B')), [], 'another model may share the spot');
  const m = sampleMap();
  for (let i = 0; i < 4; i++) twin(0.01 * i, 0)(m);
  const dup = warningsOf(validate(m));
  assert.deepEqual(dup.map((i) => [i.code, i.path, i.index]), [6, 7, 8, 9].map((i) => ['object-duplicate', `objects[${i}]`, i]));
  // every pair across the 0.05 grid lines is found, whatever the order
  for (const [a, b] of [[0.14, 0.19], [0.19, 0.14], [0.15, 0.2], [-0.03, 0.02], [-0.05, 0], [9.99, 10.04]]) {
    const pair = sampleMap();
    pair.objects.push({ ...pair.objects[4], x: a, z: a }, { ...pair.objects[4], x: b, z: b });
    assert.deepEqual(codes(warningsOf(validate(pair))), ['object-duplicate'], `${a} ${b}`);
  }
  const big = sampleMap();
  big.objects = Array.from({ length: 20001 }, (_, i) => ({ ...big.objects[5], x: (i % 150) - 75, z: Math.floor(i / 150) - 67 }));
  assert.deepEqual(codes(validate(big)), ['many-objects']);
  big.objects.length = 20000;
  assert.deepEqual(validate(big), []);
});

test('object-duplicate: every pile is found, and a hostile pile costs no more than a spread-out map', () => {
  const rock = sampleMap().objects[4], rnd = lcg(11);
  const hundredths = (v) => Math.round(v * 100);
  const near = (a, b) => a.m === b.m && Math.abs(hundredths(a.x) - hundredths(b.x)) <= 5 && Math.abs(hundredths(a.z) - hundredths(b.z)) <= 5;
  // random piles of two models, from packed to loose, against the plain definition: an EARLIER object of the model within 0.05
  for (let round = 0; round < 40; round++) {
    const m = sampleMap(), span = [0.1, 0.3, 1, 3][round % 4];
    m.objects = Array.from({ length: 300 }, () => ({ ...rock, m: `medieval/rock_single_${rnd() < 0.5 ? 'A' : 'B'}`,
      x: qPos(-40 + (rnd() - 0.5) * span), z: qPos(-40 + (rnd() - 0.5) * span) }));
    const issues = validate(m), twins = new Map(issues.map((i) => [i.index, Number(/objects\[(\d+)\]/.exec(i.message)[1])]));
    assert.deepEqual(codes(issues), ['object-duplicate']);
    m.objects.forEach((o, i) => {
      const expected = m.objects.slice(0, i).some((earlier) => near(o, earlier)), twin = twins.get(i);
      if (expected !== twins.has(i)) assert.fail(`objects[${i}] of round ${round} ${expected ? 'is not reported' : 'is reported for nothing'}`);
      if (expected && !(twin < i && near(o, m.objects[twin]))) assert.fail(`objects[${i}] of round ${round} is said to sit on objects[${twin}]`);
    });
  }
  // 25,000 objects on one spot beside 24,999 on another, in a file well under the size limit. A spot kept once per
  // object, not once per place, made every later object walk the whole pile: seconds in which the server does nothing else.
  const timed = (objects) => {
    const m = sampleMap();
    m.objects = objects;
    const started = performance.now(), issues = validate(m);
    return [performance.now() - started, issues.filter((i) => i.code === 'object-duplicate').length];
  };
  const at = (x) => ({ ...rock, x, z: 0 });
  const [spread] = timed(Array.from({ length: 50000 }, (_, i) => ({ ...rock, x: (i % 240) - 120, z: Math.floor(i / 240) - 105 })));
  const [pile, reported] = timed([at(0.04), ...Array.from({ length: 25000 }, () => at(0.05)), ...Array.from({ length: 24999 }, () => at(0.11))]);
  assert.equal(reported, 49998);
  assert.ok(pile < 10 * spread + 500, `the pile took ${Math.round(pile)} ms, 50,000 objects apart ${Math.round(spread)} ms`);
});

// ---------------------------------------------------------------- a blank map

test('emptyMap is valid: warnings only', () => {
  const map = emptyMap();
  assert.deepEqual(errorsOf(validate(map)), []);
  assert.deepEqual(codes(validate(map)), ['no-blacksmith', 'no-safe-region', 'no-sage', 'no-spawns', 'start-unsafe']);
  assert.equal(map.radius, 260);
  assert.deepEqual(map.ground.cell, 2);
  assert.deepEqual(map.ground.size, 281);
  assert.deepEqual(map.start, { x: 0, z: 0, r: 5 });
  assert.deepEqual(map.fallback, { name: 'Open Sea', levels: null, mood: 'meadow' });
  assert.equal(map.foliage, true);
  assert.deepEqual([map.regions, map.spawns, map.chests, map.npcs, map.objects], [[], [], [], [], []]);
  assert.equal(groundAt(map, 0, 0).id, 'grass');
  assert.equal(groundAt(map, 258, 0).id, 'grass');
  assert.equal(groundAt(map, 260, 0).id, 'sand');
  assert.equal(groundAt(map, 200, 200).id, 'sand');
  assert.deepEqual(normalize(serialize(map)), map);
  assert.notEqual(emptyMap().ground.cells, map.ground.cells);
});

test('emptyMap rounds and clamps the radius to what a cell-2 grid covers', () => {
  const big = emptyMap({ radius: 600 });
  assert.equal(big.radius, 492);
  assert.equal(big.ground.size, 513);
  assert.deepEqual(errorsOf(validate(big)), []);
  const small = emptyMap({ radius: 3 });
  assert.equal(small.radius, 40);
  assert.equal(small.ground.size, 61);
  assert.deepEqual(errorsOf(validate(small)), []);
  assert.equal(emptyMap({ radius: 99.6 }).radius, 100);
  assert.equal(emptyMap({ radius: NaN }).radius, 260);
  for (const radius of [40, 41, 77, 259, 260, 261, 491, 492]) {
    const map = emptyMap({ radius });
    assert.deepEqual(errorsOf(validate(map)), [], String(radius));
    assert.ok(groundHalf(map.ground) >= radius + 20 && groundHalf(map.ground) < radius + 22, 'the smallest odd size that covers radius + 20');
  }
});

// ---------------------------------------------------------------- ground

test('groundIx, groundX and cellIndex at the grid edges', () => {
  const g = { cell: 2, size: 33, cells: new Uint8Array(33 * 33) };
  assert.equal(groundHalf(g), 32);
  assert.equal(groundIx(g, -32), 0);
  assert.equal(groundIx(g, 32), 32);
  assert.equal(groundIx(g, 0), 16);
  assert.equal(groundIx(g, -1000), 0, 'clamped');
  assert.equal(groundIx(g, 1000), 32, 'clamped');
  assert.equal(groundIx(g, 0.99), 16);
  assert.equal(groundIx(g, 1), 17, 'halfway rounds up');
  assert.equal(groundIx(g, -1), 16);
  assert.equal(groundIx(g, -1.01), 15);
  assert.equal(groundX(g, 0), -32);
  assert.equal(groundX(g, 32), 32);
  assert.equal(groundX(g, 16), 0);
  for (let ix = 0; ix < 33; ix++) assert.equal(groundIx(g, groundX(g, ix)), ix);

  assert.equal(cellIndex(g, -32, -32), 0);
  assert.equal(cellIndex(g, 32, -32), 32);
  assert.equal(cellIndex(g, -32, 32), 32 * 33);
  assert.equal(cellIndex(g, 32, 32), 33 * 33 - 1);
  assert.equal(cellIndex(g, 0, 0), 16 * 33 + 16);
  assert.equal(cellIndex(g, 33, 0), 16 * 33 + 32, 'half a cell outside still belongs to the edge vertex');
  assert.equal(cellIndex(g, -33, -33), 0);
  assert.equal(cellIndex(g, 33.01, 0), -1);
  assert.equal(cellIndex(g, 0, -33.01), -1);
  assert.equal(cellIndex(g, NaN, 0), -1);
  assert.deepEqual(cellXZ(g, 0), { x: -32, z: -32, ix: 0, iz: 0 });
  assert.deepEqual(cellXZ(g, 33 * 33 - 1), { x: 32, z: 32, ix: 32, iz: 32 });
  assert.deepEqual(cellXZ(g, 2 * 33 + 5), { x: -22, z: -28, ix: 5, iz: 2 });
  for (const i of [0, 1, 32, 33, 500, 1088]) { const c = cellXZ(g, i); assert.equal(cellIndex(g, c.x, c.z), i); }
});

test('groundAt and isBlocked use the nearest vertex, clamped to the edge', () => {
  const map = sampleMap();
  assert.equal(isBlocked(map, 50, 84), true);
  assert.equal(isBlocked(map, 39.1, 79.1), true, 'a blocked vertex blocks the cell-sized square around it');
  assert.equal(isBlocked(map, 38.9, 84), false);
  assert.equal(isBlocked(map, 0, 0), false);
  assert.equal(groundAt(map, 5000, -5000).id, 'grass');
  map.ground.cells[map.ground.cells.length - 1] = GROUND_INDEX.lava;
  assert.equal(groundAt(map, 5000, 5000).id, 'lava');
  assert.equal(isBlocked(map, 121, 121), true);
  assert.equal(isBlocked(map, NaN, 0), false, 'a broken coordinate is not a crash');
});

test('maxRadius is 236 / 492 / 1004 for cell 1 / 2 / 4', () => {
  assert.equal(maxRadius({ cell: 1 }), 236);
  assert.equal(maxRadius({ cell: 2 }), 492);
  assert.equal(maxRadius({ cell: 4 }), 1004);
});

test('resizeGround grows around the centre and copies the old edge outwards', () => {
  const g = { cell: 4, size: 33, cells: new Uint8Array(33 * 33) };
  for (let i = 0; i < g.cells.length; i++) g.cells[i] = i % 14;
  assert.equal(resizeGround(g, 44), g, 'already covers 44 + 20');
  assert.equal(resizeGround(g, 20), g, 'never shrinks');
  const big = resizeGround(g, 60);
  assert.notEqual(big, g);
  assert.deepEqual([big.cell, big.size, big.cells.length], [4, 41, 41 * 41]);
  assert.ok(groundHalf(big) >= 80 && groundHalf({ ...big, size: 39 }) < 80, 'the smallest odd size that covers 60 + 20');
  assert.equal(g.cells.length, 33 * 33, 'the old ground is untouched');
  for (let iz = 0; iz < 41; iz++) {
    for (let ix = 0; ix < 41; ix++) {
      const ox = Math.max(0, Math.min(32, ix - 4)), oz = Math.max(0, Math.min(32, iz - 4));
      if (big.cells[iz * 41 + ix] !== g.cells[oz * 33 + ox]) assert.fail(`vertex ${ix}, ${iz}`);
    }
  }
  // the same world point keeps its ground type
  const before = { ground: g }, after = { ground: big };
  for (const [x, z] of [[0, 0], [-64, 64], [12, -40], [63, 1]]) assert.equal(groundAt(after, x, z), groundAt(before, x, z));
  const map = emptyMap({ radius: 40 });
  const grown = resizeGround(map.ground, maxRadius(map.ground));
  assert.equal(grown.size, 513);
  assert.equal(groundAt({ ground: grown }, 400, 0).id, 'sand');
});

test('rows codec: random grids survive the round trip in canonical form', () => {
  const rnd = lcg(7);
  for (const size of [33, 35, 121]) {
    const cells = new Uint8Array(size * size);
    const palette = [0, 3, 6, 12, 13].slice(0, 2 + Math.floor(rnd() * 4));
    for (let i = 0; i < cells.length;) {
      const run = 1 + Math.floor(rnd() * rnd() * 40), type = palette[Math.floor(rnd() * palette.length)];
      for (let k = 0; k < run && i < cells.length; k++) cells[i++] = type;
    }
    const { types, rows } = encodeRows(cells, size);
    assert.equal(rows.length, size);
    assert.deepEqual(types, GROUND_TYPES.filter((t, i) => cells.includes(i)).map((t) => t.id), 'the ids that occur, in table order');
    for (const row of rows) {
      assert.match(row, /^(?:(?:[1-9]\d*)?[a-zA-Z])+$/);
      assert.ok(!/(^|\D)1[a-zA-Z]/.test(row), `a count of 1 is never written: ${row}`);
      assert.ok(!/([a-zA-Z])\d*\1/.test(row), `runs are maximal: ${row}`);
    }
    assert.deepEqual(decodeRows(types, rows, size), cells);
    assert.deepEqual(encodeRows(decodeRows(types, rows, size), size), { types, rows });
  }
});

test('rows codec: bad rows are rejected with their index', () => {
  const good = () => Array.from({ length: 281 }, () => '140a141b');
  assert.equal(decodeRows(['grass', 'sand'], good(), 281).length, 281 * 281);
  for (const bad of ['0a281b', '280a', '282a', '28 1a', '', '281', 'a281', '281c', '140a-141b', '99999999999999999999a', '140a141b1a', '1e3a', '281ä']) {
    const rows = good();
    rows[17] = bad;
    const e = thrown(() => decodeRows(['grass', 'sand'], rows, 281));
    assert.deepEqual(e.issues.map((i) => [i.code, i.path]), [['ground-rows', 'ground.rows[17]']], JSON.stringify(bad));
  }
  assert.deepEqual(thrown(() => decodeRows(['grass'], good().slice(1), 281)).issues.map((i) => [i.code, i.path]), [['ground-rows', 'ground.rows']]);
  assert.deepEqual(thrown(() => decodeRows(['grass', 'sand'], good(), 280)).issues[0].code, 'ground-size');
  assert.deepEqual(thrown(() => decodeRows(['grass', 'grass'], good(), 281)).issues[0].code, 'ground-types');
  assert.deepEqual(thrown(() => decodeRows(['grass', 'toString'], good(), 281)).issues[0].code, 'ground-types');
});

test('rows codec: non-canonical rows are accepted, symbols follow the palette', () => {
  const rows = Array.from({ length: 33 }, () => '33a');
  rows[0] = '1a1a31a';                    // counts of 1 and split runs
  rows[1] = 'a10b5b17a';
  const cells = decodeRows(['water', 'grass'], rows, 33);      // the palette is the file's own: here "a" is water
  assert.deepEqual([...cells.slice(0, 33)], Array(33).fill(GROUND_INDEX.water));
  assert.deepEqual([...cells.slice(33, 66)], [GROUND_INDEX.water, ...Array(15).fill(GROUND_INDEX.grass), ...Array(17).fill(GROUND_INDEX.water)]);
  assert.deepEqual(encodeRows(cells, 33).rows.slice(0, 2), ['33b', 'b15a17b'], 'and written back canonically, in table order');
  // an upper-case letter is position 26 and up: fine with that many types, an error with two
  rows[1] = 'a10b5b17A';
  assert.deepEqual(thrown(() => decodeRows(['water', 'grass'], rows, 33)).issues.map((i) => i.path), ['ground.rows[1]']);
  assert.equal(GROUND_SYMBOLS.indexOf('A'), 26);
});

test('palette compaction: unused and reordered types are rewritten on save', () => {
  const file = patched((f) => {
    f.ground.types = ['water', 'lava', 'grass', 'snow', 'paving', 'dirt'];      // lava and snow are listed but unused
    f.ground.rows = f.ground.rows.map((row) => row.replace(/[a-d]/g, (s) => ({ a: 'c', b: 'f', c: 'e', d: 'a' }[s])));
  });
  const map = normalize(file);
  assert.deepEqual(map, sampleMap(), 'the palette is local to the file: the cells are the same');
  const out = serialize(map);
  assert.deepEqual(out.ground.types, ['grass', 'dirt', 'paving', 'water'], 'the ids that occur, in GROUND_TYPES order');
  assert.deepEqual(out.ground, sample().ground);
  // painting the pond over removes water from the palette and shifts nothing else
  for (let i = 0; i < map.ground.cells.length; i++) if (map.ground.cells[i] === GROUND_INDEX.water) map.ground.cells[i] = GROUND_INDEX.grass;
  const dry = serialize(map).ground;
  assert.deepEqual(dry.types, ['grass', 'dirt', 'paving']);
  assert.equal(dry.rows[100], '60ab60a');
  assert.equal(dry.rows[60], '55a11c55a');
  assert.deepEqual(encodeRows(new Uint8Array(33 * 33).fill(GROUND_INDEX.lava), 33), { types: ['lava'], rows: Array(33).fill('33a') });
  assert.throws(() => encodeRows(new Uint8Array(33 * 33).fill(99), 33), MapError);
});

test('cellHash is deterministic, in [0, 1) and well spread', () => {
  assert.equal(cellHash(3, 7, 1), cellHash(3, 7, 1));
  assert.notEqual(cellHash(3, 7, 1), cellHash(7, 3, 1));
  assert.notEqual(cellHash(3, 7, 1), cellHash(3, 7, 2));
  let sum = 0, n = 0;
  const seen = new Set();
  for (let ix = 0; ix < 100; ix++) {
    for (let iz = 0; iz < 100; iz++) {
      const h = cellHash(ix, iz, 12);
      assert.ok(h >= 0 && h < 1);
      sum += h; n++;
      seen.add(h);
    }
  }
  assert.ok(Math.abs(sum / n - 0.5) < 0.02, `mean ${sum / n}`);
  assert.ok(seen.size > 9900);
  // the formula of the spec, spelled out
  const reference = (ix, iz, salt) => {
    let v = Math.imul(ix + salt * 374761393, 73856093) ^ Math.imul(iz, 19349663);
    v = Math.imul(v ^ (v >>> 13), 0x5bd1e995);
    return ((v ^ (v >>> 15)) >>> 0) / 4294967296;
  };
  for (const [ix, iz, salt] of [[0, 0, 0], [140, 140, 1], [280, 0, 52], [17, 255, 3]]) assert.equal(cellHash(ix, iz, salt), reference(ix, iz, salt));
});

// ---------------------------------------------------------------- regions

const circle = (x, z, r) => ({ type: 'circle', x, z, r });
const poly = (...points) => ({ type: 'poly', points });
const SQUARE = poly([-10, -10], [10, -10], [10, 10], [-10, 10]);
const region = (name, shape, more = {}) => ({ name, levels: null, mood: null, safe: false, color: null, shape, ...more });
const world = (...regions) => ({ regions, fallback: { name: 'Open Sea', levels: null, mood: 'meadow' } });

test('inShape: circles include their edge, polygons use the even-odd rule', () => {
  assert.equal(inShape(circle(1, 2, 5), 6, 2), true);
  assert.equal(inShape(circle(1, 2, 5), 4, 6), true, '3-4-5: exactly on the edge');
  assert.equal(inShape(circle(1, 2, 5), 6.01, 2), false);
  assert.equal(inShape(SQUARE, 0, 0), true);
  assert.equal(inShape(SQUARE, 9.99, -9.99), true);
  assert.equal(inShape(SQUARE, 10.01, 0), false);
  assert.equal(inShape(SQUARE, 0, -10.01), false);
  assert.equal(inShape({ type: 'poly', points: [...SQUARE.points].reverse() }, 3, 3), true, 'either winding');
  const bowtie = poly([0, 0], [10, 10], [10, 0], [0, 10]);
  assert.equal(inShape(bowtie, 2, 5), true);
  assert.equal(inShape(bowtie, 5, 2), false);
  const frame = poly([0, 0], [10, 0], [10, 10], [0, 10], [0, 0], [3, 3], [3, 7], [7, 7], [7, 3], [3, 3]);
  assert.equal(inShape(frame, 5, 5), false, 'even-odd: the inner loop is a hole');
  assert.equal(inShape(frame, 1, 5), true);
  assert.equal(inShape(poly(), 0, 0), false);
});

test('shapeBounds and shapeCentre', () => {
  assert.deepEqual(shapeBounds(circle(1, 2, 5)), { minX: -4, maxX: 6, minZ: -3, maxZ: 7 });
  assert.deepEqual(shapeBounds(poly([40, 40], [60, 44], [52, 60])), { minX: 40, maxX: 60, minZ: 40, maxZ: 60 });
  assert.deepEqual(shapeCentre(circle(1, 2, 5)), { x: 1, z: 2 });
  assert.deepEqual(shapeCentre(SQUARE), { x: 0, z: 0 });
  assert.deepEqual(shapeCentre(poly([0, 0], [6, 0], [0, 9])), { x: 2, z: 3 });
});

test('regionAt: the last containing region wins, else the fallback', () => {
  const outer = region('Outer', circle(0, 0, 100)), inner = region('Inner', circle(0, 0, 50)), lake = region('Lake', poly([0, 0], [20, 0], [20, 20], [0, 20]));
  const map = world(outer, inner, lake);
  assert.equal(regionAt(map, 10, 10), lake);
  assert.equal(regionAt(map, -10, 10), inner);
  assert.equal(regionAt(map, 70, 0), outer);
  assert.equal(regionAt(map, 100, 0), outer, 'the edge is inside');
  assert.equal(regionAt(map, 101, 0), map.fallback);
  assert.equal(regionAt(world(lake, inner, outer), 10, 10), outer, 'list order is the priority, not size');
  assert.equal(regionAt(world(), 0, 0).name, 'Open Sea');
});

test('isSafe: ANY safe region counts, even with a non-safe region listed after it', () => {
  const town = region('Town', circle(0, 0, 24), { safe: true }), market = region('Market', circle(5, 5, 4));
  const map = world(region('Wilds', circle(0, 0, 100)), town, market);
  assert.equal(regionAt(map, 5, 5), market);
  assert.equal(isSafe(map, 5, 5), true, 'naming a corner of the town does not make it unsafe');
  assert.equal(isSafe(map, 24, 0), true);
  assert.equal(isSafe(map, 24.01, 0), false);
  assert.equal(isSafe(map, 60, 0), false);
  assert.equal(isSafe(world(), 0, 0), false, 'the fallback is never safe');
  assert.equal(isSafe(sampleMap(), 0, 6), true);
});

test('moodAt: the last containing region that has a mood, else the fallback mood', () => {
  const map = world(region('Wilds', circle(0, 0, 100), { mood: 'cursed' }), region('Graves', circle(0, 0, 50), { mood: 'graveyard' }), region('Shrine', circle(0, 0, 5)));
  assert.equal(regionAt(map, 1, 1).name, 'Shrine');
  assert.equal(moodAt(map, 1, 1), 'graveyard', 'a naming region without a mood does not change the sky');
  assert.equal(moodAt(map, 60, 0), 'cursed');
  assert.equal(moodAt(map, 200, 0), 'meadow');
  assert.equal(moodAt(world(region('Shrine', circle(0, 0, 5))), 0, 0), 'meadow');
});

test('regionLabel: the three forms', () => {
  assert.equal(regionLabel({ name: 'Hypercat Town', levels: null }), 'Hypercat Town');
  assert.equal(regionLabel({ name: 'Throne', levels: [18, 18] }), 'Throne · Lv 18');
  assert.equal(regionLabel({ name: 'Green Meadows', levels: [1, 4] }), 'Green Meadows · Lv 1–4');
  assert.equal(regionLabel({ name: 'Open Sea', levels: null, mood: 'meadow' }), 'Open Sea');
});

test('regionColor: own colour, then safe, then the radar colour of the mood in force', () => {
  const map = sampleMap(), [wilds, town, lake] = map.regions;
  assert.equal(regionColor(map, lake), '#3a8fb0');
  assert.equal(regionColor(map, town), '#7fe8d6');
  assert.equal(regionColor(map, wilds), '#b59a6a');
  assert.equal(regionColor(map, map.fallback), '#6fbf55');
  lake.color = null;
  assert.equal(regionColor(map, lake), '#b59a6a', 'no mood of its own: the mood at its centre');
  lake.mood = 'cursed';
  assert.equal(regionColor(map, lake), '#ff5a70');
  town.color = '#000a0b';
  assert.equal(regionColor(map, town), '#000a0b');
  assert.match(regionColor(world(region('Nowhere', circle(500, 500, 1))), region('Nowhere', circle(500, 500, 1))), /^#[0-9a-f]{6}$/);
});

test('regionIndex agrees with the plain lookups everywhere', () => {
  const map = sampleMap();
  map.regions.push(region('Dock', poly([-60, -20], [-30, -25], [-28, 10], [-55, 14]), { safe: true, mood: 'cursed' }), region('Hut', circle(-40, 0, 3)));
  const index = regionIndex(map);
  assert.deepEqual(Object.keys(index).sort(), ['isSafe', 'moodAt', 'regionAt']);
  for (let x = -110; x <= 110; x += 3.5) {
    for (let z = -110; z <= 110; z += 3.5) {
      if (index.regionAt(x, z) !== regionAt(map, x, z) || index.moodAt(x, z) !== moodAt(map, x, z) || index.isSafe(x, z) !== isSafe(map, x, z)) {
        assert.fail(`differs at ${x}, ${z}`);
      }
    }
  }
  for (const [x, z] of [[24, 0], [0, -24], [100, 0], [-100, 0], [0, 100], [-40, 3], [-37, 0]]) {
    assert.equal(index.isSafe(x, z), isSafe(map, x, z));
    assert.equal(index.regionAt(x, z), regionAt(map, x, z));
  }
  assert.equal(index.regionAt(500, 500), map.fallback);
  // it is a snapshot: rebuild after a region change
  map.regions.length = 0;
  assert.equal(index.isSafe(0, 0), true);
  assert.equal(regionIndex(map).isSafe(0, 0), false);
});

test('pushOutOfSafe: a circle', () => {
  const map = world(region('Wilds', circle(0, 0, 100)), region('Town', circle(0, 0, 24), { safe: true }));
  let p = { x: 3, z: 4 };
  assert.equal(pushOutOfSafe(map, p, 1.2), true);
  assert.ok(Math.abs(Math.hypot(p.x, p.z) - 25.2) < 1e-9);
  assert.ok(Math.abs(p.x / p.z - 0.75) < 1e-9, 'pushed straight out');
  assert.equal(pushOutOfSafe(map, p, 1.2), false, 'already outside by the margin');
  p = { x: 0, z: -24.5 };
  assert.equal(pushOutOfSafe(map, p, 1.2), true, 'outside, but closer than the margin');
  assert.deepEqual([p.x, qPos(p.z)], [0, -25.2]);
  p = { x: 40, z: 0 };
  assert.equal(pushOutOfSafe(map, p, 1.2), false);
  assert.deepEqual(p, { x: 40, z: 0 });
  p = { x: 5, z: 5 };
  assert.equal(pushOutOfSafe(world(region('Wilds', circle(0, 0, 100))), p, 1.2), false, 'only safe regions eject');
  assert.deepEqual(p, { x: 5, z: 5 });
});

test('pushOutOfSafe: a point at the exact centre goes along +x', () => {
  const map = world(region('Town', circle(7, -3, 24), { safe: true }));
  const p = { x: 7, z: -3 };
  assert.equal(pushOutOfSafe(map, p, 0.5), true);
  assert.deepEqual(p, { x: 31.5, z: -3 });
});

test('pushOutOfSafe: a square', () => {
  const map = world(region('Yard', SQUARE, { safe: true }));
  const moved = (x, z, margin = 1) => { const p = { x, z }; return [pushOutOfSafe(map, p, margin), qPos(p.x), qPos(p.z)]; };
  assert.deepEqual(moved(8, 0), [true, 11, 0], 'inside: out through the nearest edge');
  assert.deepEqual(moved(0, -7), [true, 0, -11]);
  assert.deepEqual(moved(10.5, 3), [true, 11, 3], 'outside, within the margin');
  assert.deepEqual(moved(12, 3), [false, 12, 3]);
  assert.deepEqual(moved(11, 3), [false, 11, 3], 'exactly at the margin');
  assert.deepEqual(moved(10, 3), [true, 11, 3], 'on the outline: along the edge normal, outwards');
  assert.deepEqual(moved(-10, 3), [true, -11, 3]);
  assert.deepEqual(moved(3, 10), [true, 3, 11]);
  const [, x, z] = moved(10.3, 10.4);
  assert.ok(Math.abs(Math.hypot(x - 10, z - 10) - 1) < 0.01, 'beyond a corner: away from the corner');
  const reversed = world(region('Yard', { type: 'poly', points: [...SQUARE.points].reverse() }, { safe: true }));
  const q = { x: 10, z: 3 };
  assert.equal(pushOutOfSafe(reversed, q, 1), true);
  assert.deepEqual([qPos(q.x), qPos(q.z)], [11, 3], 'the winding does not matter');
});

test('pushOutOfSafe: two overlapping safe regions', () => {
  const a = circle(0, 0, 10), b = circle(12, 0, 10);
  const map = world(region('A', a, { safe: true }), region('B', b, { safe: true }));
  const clear = (p) => Math.hypot(p.x, p.z) >= 11 - 1e-6 && Math.hypot(p.x - 12, p.z) >= 11 - 1e-6;
  const p = { x: 6, z: 3 };       // in both circles: leaving A lands in B, so one pass is not enough
  assert.equal(pushOutOfSafe(map, p, 1), true);
  assert.ok(clear(p) && !isSafe(map, p.x, p.z), `${p.x}, ${p.z}`);
  assert.equal(pushOutOfSafe(map, p, 1), false);
  const rnd = lcg(42);
  for (let i = 0; i < 1000; i++) {
    const q = { x: -12 + rnd() * 36, z: -12 + rnd() * 24 }, start = { ...q };
    const moved = pushOutOfSafe(map, q, 1);
    assert.equal(moved, !clear(start), `${start.x}, ${start.z}`);
    if (!moved) assert.deepEqual(q, start);
    if (!clear(q)) assert.fail(`${start.x}, ${start.z} ended at ${q.x}, ${q.z}`);
  }
});

test('pushOutOfSafe: safe regions that push a point back into each other still let it go', () => {
  // how far (x, z) is from an upright rectangle; 0 inside
  const rect = (x0, z0, x1, z1) => ({
    shape: poly([x0, z0], [x1, z0], [x1, z1], [x0, z1]),
    gap: (x, z) => Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1)),
  });
  const disc = (x0, z0, r) => ({ shape: circle(x0, z0, r), gap: (x, z) => Math.max(0, Math.hypot(x - x0, z - z0) - r) });
  // every point of a grid over the shapes ends `margin` clear of all of them, and a point that already was does not move
  const sweep = (margin, ...safe) => {
    const map = world(...safe.map((s, i) => region(`Safe ${i}`, s.shape, { safe: true })));
    const clear = (p) => safe.every((s) => s.gap(p.x, p.z) >= margin - 1e-6) && !isSafe(map, p.x, p.z);
    for (let x = -4; x <= 26; x += 0.5) {
      for (let z = -14; z <= 14; z += 0.5) {
        const p = { x, z }, moved = pushOutOfSafe(map, p, margin);
        if (moved !== !clear({ x, z }) || !clear(p)) assert.fail(`${x}, ${z} ${moved ? 'was moved to' : 'was left at'} ${p.x}, ${p.z}`);
        if (!moved && (p.x !== x || p.z !== z)) assert.fail(`${x}, ${z} moved although it was clear`);
        if (pushOutOfSafe(map, p, margin)) assert.fail(`${x}, ${z} was moved twice`);
      }
    }
    return map;
  };
  // two yards sharing the strip x 8..10: out of one means into the other, pass after pass
  const yards = sweep(1.3, rect(0, 0, 10, 10), rect(8, 0, 18, 10));
  const p = { x: 9, z: 5 };
  assert.equal(pushOutOfSafe(yards, p, 1.3), true);
  assert.equal(isSafe(yards, p.x, p.z), false, `${p.x}, ${p.z}`);
  // two towns in a row: on the line of centres each pushes the point straight back at the other
  const towns = sweep(1, disc(0, 0, 10), disc(12, 0, 10));
  const q = { x: 1, z: 0 };
  assert.equal(pushOutOfSafe(towns, q, 1), true);
  assert.equal(isSafe(towns, q.x, q.z), false, `${q.x}, ${q.z}`);
  // a lane 1 unit wide between two yards, too narrow for a margin of 1.3 on either side
  sweep(1.3, rect(0, -5, 10, 5), rect(11, -5, 21, 5));
  sweep(0.7, rect(0, -5, 10, 5), disc(13, 0, 4), rect(9, 2, 20, 9));
  // a point that is no place at all is not a reason to search for ever
  assert.equal(typeof pushOutOfSafe(towns, { x: NaN, z: 0 }, 1), 'boolean');
});

// ---------------------------------------------------------------- queries

test('nearNpc and npcsOf: any NPC of the kind counts, none is not an error', () => {
  const map = sampleMap();
  assert.equal(nearNpc(map, { x: -4.8, z: 9 }, 'blacksmith'), true);
  assert.equal(nearNpc(map, { x: -4.8, z: 11.5 + SHOP_RANGE }, 'blacksmith'), false, 'the range is exclusive');
  assert.equal(nearNpc(map, { x: -4.8, z: 11.5 + SHOP_RANGE }, 'blacksmith', 6), true);
  assert.equal(nearNpc(map, { x: -4.8, z: 9 }, 'sage'), false);
  map.npcs.push({ kind: 'blacksmith', x: 60, z: 60, ry: 0, g: null });
  assert.equal(nearNpc(map, { x: 61, z: 61 }, 'blacksmith'), true, 'the second blacksmith serves too');
  assert.deepEqual(npcsOf(map, 'blacksmith').map((n) => n.x), [-4.8, 60]);
  assert.deepEqual(npcsOf(map, 'trader'), []);
  const empty = emptyMap();
  assert.equal(nearNpc(empty, { x: 0, z: 0 }, 'blacksmith'), false);
  assert.equal(nearNpc(empty, { x: 0, z: 0 }, 'sage'), false);
  assert.equal(nearNpc(empty, { x: 0, z: 0 }, 'constructor'), false);
  assert.deepEqual(npcsOf(empty, 'sage'), []);
});

test('startPoint: uniform over the start disc, never on blocked ground', () => {
  const map = sampleMap(), rnd = lcg(1);
  let far = 0;
  for (let i = 0; i < 2000; i++) {
    const p = startPoint(map, rnd), d = Math.hypot(p.x - 0, p.z - 6);
    assert.ok(d <= 10 + 1e-9);
    if (d > 10 * Math.SQRT1_2) far++;
  }
  assert.ok(far > 900 && far < 1100, `half of the points lie in the outer half of the area (${far})`);
  assert.deepEqual(Object.keys(startPoint(map)), ['x', 'z']);
  map.start.r = 0;
  assert.deepEqual(startPoint(map, rnd), { x: 0, z: 6 });
  // a pond under half of the disc: every point is still on dry ground
  Object.assign(map.start, { x: 39, z: 84, r: 6 });
  for (let i = 0; i < 500; i++) { const p = startPoint(map, rnd); assert.equal(isBlocked(map, p.x, p.z), false); }
  // wholly in the pond: the centre after 20 tries
  Object.assign(map.start, { x: 50, z: 84, r: 2 });
  let draws = 0;
  assert.deepEqual(startPoint(map, () => { draws++; return 0.5; }), { x: 50, z: 84 });
  assert.equal(draws, 40);
});

test('spawnHome: inside the disc and the world, off blocked ground, clear of safe regions', () => {
  const map = sampleMap(), rnd = lcg(5);
  for (let i = 0; i < 500; i++) {
    const p = spawnHome(map, map.spawns[0], 0.7, rnd);
    assert.ok(Math.hypot(p.x - 50, p.z - 10) <= 12.5 + 1e-9);
  }
  assert.deepEqual(spawnHome(map, map.spawns[1], 2.8, rnd), { x: 0, z: -80 }, 'a spawn of radius 0 is its centre');
  // next to the town: no home inside the town or closer to it than the monster's radius + 0.5
  const camp = { ...map.spawns[0], x: 30, z: 0, r: 10 };
  for (let i = 0; i < 500; i++) {
    const p = spawnHome(map, camp, 1.3, rnd);
    if (p) assert.ok(Math.hypot(p.x, p.z) >= 24 + 1.3 + 0.5 - 1e-9, `${p.x}, ${p.z}`);
  }
  // at the shore: no home beyond radius - mobR
  const shore = { ...map.spawns[0], x: 96, z: 0, r: 10 };
  for (let i = 0; i < 500; i++) {
    const p = spawnHome(map, shore, 1.3, rnd);
    if (p) assert.ok(Math.hypot(p.x, p.z) <= 100 - 1.3 + 1e-9);
  }
  // in the pond, in the town, in the sea: give up after 20 draws
  let draws = 0;
  const count = () => { draws++; return 0.25; };
  assert.equal(spawnHome(map, { ...camp, x: 50, z: 84, r: 2 }, 0.7, count), null);
  assert.equal(draws, 40);
  assert.equal(spawnHome(map, { ...camp, x: 0, z: 0, r: 5 }, 0.7, rnd), null);
  assert.equal(spawnHome(map, { ...camp, x: 150, z: 0, r: 5 }, 0.7, rnd), null);
});

test('pickType walks the weights in MOB_KEYS order', () => {
  const types = { runner: 2, chaser: 3 };
  assert.equal(pickType(types, 0), 'chaser');
  assert.equal(pickType(types, 0.59), 'chaser');
  assert.equal(pickType(types, 0.6), 'runner');
  assert.equal(pickType(types, 0.999999), 'runner');
  assert.equal(pickType({ boss: 1 }, 0.5), 'boss');
  const all = { boss: 1, tank: 1, shooter: 1, runner: 1, chaser: 1 };
  assert.deepEqual([0.1, 0.3, 0.5, 0.7, 0.9].map((u) => pickType(all, u)), MOB_KEYS);
  const rnd = lcg(9), n = { chaser: 0, runner: 0 };
  for (let i = 0; i < 5000; i++) n[pickType(types, rnd())]++;
  assert.ok(Math.abs(n.chaser / 5000 - 0.6) < 0.03);
  assert.ok(MOB_KEYS.includes(pickType({}, 0.5)), 'an empty table is not a crash');
});

test('pickLevel, spawnCount, hasBoss, groupItems', () => {
  assert.deepEqual([0, 0.33, 0.34, 0.66, 0.67, 0.999].map((u) => pickLevel([3, 5], u)), [3, 3, 4, 4, 5, 5]);
  assert.equal(pickLevel([7, 7], 0.9), 7);
  const map = sampleMap();
  assert.equal(spawnCount(map), 5);
  assert.equal(spawnCount(emptyMap()), 0);
  assert.deepEqual(map.spawns.map(hasBoss), [false, true]);
  assert.equal(hasBoss({ types: JSON.parse('{ "chaser": 1 }') }), false);
  const fortress = groupItems(map, 'fortress');
  assert.deepEqual(fortress.map((e) => e.kind), ['object', 'spawn', 'chest']);
  assert.deepEqual(fortress.map((e) => e.item), [map.objects[0], map.spawns[1], map.chests[1]], 'the items themselves, not copies');
  assert.deepEqual(groupItems(map, 'town').map((e) => e.kind), ['npc', 'npc']);
  assert.deepEqual(groupItems(map, 'nobody'), []);
  assert.deepEqual(groupItems(map, null), [], 'no group is not a group');
});

// ---------------------------------------------------------------- relief

test('heights: a flat ground writes no key; hills round-trip on the 0.1 grid, run-length encoded', () => {
  const map = format.emptyMap({ radius: 40 }), g = map.ground, mid = (g.size - 1) / 2;
  assert.equal(format.serialize(map).ground.heights, undefined);
  assert.ok(!format.stringifyMap(format.serialize(map)).includes('heights'));
  g.heights[mid * g.size + mid] = 5;
  g.heights[mid * g.size + mid + 1] = 2.5;
  g.heights[(mid + 1) * g.size + mid] = -0.7;
  map.start = { x: -20, z: -20, r: 3 };                       // away from the bump: a start on a cliff is an error
  const file = format.serialize(map), text = format.stringifyMap(file);
  assert.equal(file.ground.heights.length, g.size);
  assert.equal(file.ground.heights[0], `0*${g.size}`);
  assert.equal(file.ground.heights[mid], `0*${mid},50,25,0*${mid - 1}`);
  const back = format.normalize(JSON.parse(text));
  assert.deepEqual(Array.from(back.ground.heights), Array.from(g.heights));
  assert.equal(format.stringifyMap(format.serialize(back)), text);
});

test('heights: decode errors and the range check', () => {
  const file = format.serialize(format.emptyMap({ radius: 40 })), size = file.ground.size;
  const codesOf = (heights) => {
    try { format.normalize({ ...file, ground: { ...file.ground, heights } }); return []; } catch (e) { return e.issues.map((i) => i.code); }
  };
  assert.deepEqual(codesOf(Array(size).fill(`0*${size}`)), []);
  assert.deepEqual(codesOf(Array(size - 1).fill(`0*${size}`)), ['ground-heights']);
  assert.deepEqual(codesOf(Array(size).fill(`0*${size - 1}`)).slice(0, 1), ['ground-heights']);
  assert.deepEqual(codesOf(Array(size).fill('abc')).slice(0, 1), ['ground-heights']);
  assert.deepEqual(codesOf('flat'), ['type']);
  assert.deepEqual(codesOf(Array(size).fill(`9999*${size}`)), ['ground-heights']);   // 999.9 units: out of range
  assert.equal(format.clampHeight(1000), format.LIMITS.height[1]);
  assert.equal(format.clampHeight(-50), format.LIMITS.height[0]);
  assert.equal(format.qHeight(1.26), 1.3);
});

test('heightAt follows the two triangles of a ground cell; rayGround lands on that surface', () => {
  const map = format.emptyMap({ radius: 40 }), g = map.ground, mid = (g.size - 1) / 2, at = (ix, iz) => (mid + iz) * g.size + mid + ix;
  assert.equal(format.heightAt({ ground: { ...g, heights: undefined } }, 3, 4), 0);
  g.heights[at(0, 0)] = 4;                                  // one peak at the origin, cell 2
  assert.equal(format.heightAt(map, 0, 0), 4);
  assert.equal(format.heightAt(map, 1, 0), 2);
  assert.equal(format.heightAt(map, 0, -1), 2);
  assert.equal(format.heightAt(map, 2, 0), 0);
  assert.equal(format.heightAt(map, 1, 1), 0);              // on the diagonal from (0, 1) to (1, 0): both ends are 0
  assert.equal(format.heightAt(map, 0.5, 0.5), 2);          // inside the triangle that holds the peak
  assert.equal(format.heightAt(map, 1000, 1000), 0);        // clamped to the edge of the grid
  const down = format.rayGround(map, { x: 0, y: 50, z: 0 }, { x: 0, y: -1, z: 0 });
  assert.deepEqual([down.x, down.y, down.z], [0, 4, 0]);
  const slant = format.rayGround(map, { x: -20, y: 10, z: 0.4 }, { x: 2, y: -1, z: 0 });
  assert.ok(Math.abs(slant.y - format.heightAt(map, slant.x, slant.z)) < 1e-3 && Math.abs(slant.y - (10 - (slant.x + 20) / 2)) < 1e-3);
  assert.equal(format.rayGround(map, { x: 0, y: 50, z: 0 }, { x: 0, y: 1, z: 0 }), null);
  const flat = format.emptyMap({ radius: 40 });
  flat.ground.heights = undefined;
  assert.deepEqual(format.rayGround(flat, { x: 1, y: 10, z: 2 }, { x: 0, y: -2, z: 0 }), { x: 1, y: 0, z: 2 });
});

test('resizeGround carries the heights along', () => {
  const map = format.emptyMap({ radius: 40 }), g = map.ground;
  g.heights.fill(3);
  const big = format.resizeGround(g, 80);
  assert.ok(big !== g && big.heights.length === big.size * big.size && big.heights.every((h) => h === 3));
});

test('a pit below the waterline is a lake: deep water blocks, a shallow shore does not', () => {
  const map = format.emptyMap({ radius: 40 }), g = map.ground, mid = (g.size - 1) / 2;
  assert.equal(format.isBlocked(map, 0, 0), false);
  for (let iz = -3; iz <= 3; iz++) for (let ix = -3; ix <= 3; ix++) g.heights[(mid + iz) * g.size + mid + ix] = -4;
  assert.equal(format.isBlocked(map, 0, 0), true);
  assert.equal(format.isBlocked(map, 20, 0), false);
  g.heights.fill(format.WATER_LEVEL - 0.3);                 // ankle deep everywhere
  assert.equal(format.isBlocked(map, 0, 0), false);
  assert.equal(format.clampHeight(-100), format.LIMITS.height[0]);
  assert.ok(format.LIMITS.height[0] < format.WATER_LEVEL);
});

test('a slope steeper than 45 degrees cannot be walked on; a ramp can', () => {
  const map = format.emptyMap({ radius: 40 }), g = map.ground, mid = (g.size - 1) / 2;
  assert.equal(format.slopeAt(map, 3, 3), 0);
  // a plateau 6 high for x >= 10: the cliff face is the one column of cells between x = 8 and x = 10
  for (let iz = 0; iz < g.size; iz++) for (let ix = mid + 5; ix < g.size; ix++) g.heights[iz * g.size + ix] = 6;
  assert.equal(format.slopeAt(map, 9, 0.5), 3);
  assert.equal(format.isBlocked(map, 9, 0.5), true);
  assert.equal(format.isBlocked(map, 7, 0.5), false);       // the foot of the cliff
  assert.equal(format.isBlocked(map, 12, 0.5), false);      // the top
  // a ramp: 6 up over 12 units (rise over run 0.5) along the row z = 10..12
  for (let k = 0; k <= 6; k++) for (const iz of [mid + 5, mid + 6]) g.heights[iz * g.size + mid - 1 + k] = k;
  assert.equal(format.slopeAt(map, 4, 11), 0.5);
  assert.equal(format.isBlocked(map, 4, 11), false);
  assert.equal(format.MAX_SLOPE, 1);
});
