// The editor's pure core, part 2: the commands (the only code that writes to a map) and the field schema.
// The rule tested hardest: undo leaves a BYTE-IDENTICAL map - stringifyMap(serialize(map)) before and after - with the
// same item references at the same indices, for every command constructor, on small maps built with emptyMap() and
// cmd.make() and on the real world: a fresh bake written to a temp directory. Nothing here reads the committed
// map/world.json (it is edited by hand in the editor), and nothing needs a browser.
// Run: node --test test/commands.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MOB_KEYS } from '../src/shared.js';
import {
  COLLECTION, GROUND_INDEX, GROUND_TYPES, LIMITS, MOODS, NPC_KINDS, cellIndex, cellXZ, decodeItem, emptyMap, encodeItem, groundAt,
  groundHalf, heightAt as heightOf, maxRadius, normalize, qAngle, qPos, qScale, regionAt, serialize, stringifyMap, toDeg, toRad, validate,
} from '../src/map/format.js';
import { createStore, isEmptyChange } from '../src/editor/store.js';
import * as cmd from '../src/editor/commands.js';
import { FIELDS, GROUP_PATTERN, typesPatch, withEnd } from '../src/editor/fields.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LISTS = Object.values(COLLECTION);
const DEG = Math.PI / 180;

// ---------------------------------------------------------------- helpers

const text = (map) => stringifyMap(serialize(map));                       // throws when the map has an error
const raw = (map) => stringifyMap(serialize(map, { check: false }));      // any state a command can leave behind
const errors = (map) => validate(map).filter((i) => i.level === 'error').map((i) => i.code);

// A small valid island with a few items of every kind and every optional field in use somewhere.
function world() {
  const map = emptyMap();
  const o = [
    cmd.make('object', { m: 'medieval/barrel', x: 10, z: 10 }),
    cmd.make('object', { m: 'medieval/barrel', x: 12, z: 10, g: 'camp' }),
    cmd.make('object', { m: 'medieval/tree_single_A', x: -30, z: 40, ry: 74.48 * DEG, s: 1.1 }),
    cmd.make('object', { m: 'dungeon/pillar', x: 50, z: -20, y: 1.5, rx: 5.73 * DEG, rz: -2.86 * DEG, sy: 1.25, col: [{ x: 0, z: 0, r: 0.73 }], g: 'g2' }),
    cmd.make('object', { m: 'medieval/barrel', x: -8, z: -8, col: 0 }),
    cmd.make('object', { m: 'halloween/grave_A', x: 120, z: 40, col: 'box' }),
  ];
  const s = [
    cmd.make('spawn', { x: 100, z: 0 }),
    cmd.make('spawn', { x: -100, z: 50, r: 12, types: { chaser: 2, runner: 1 }, lvl: [3, 5], g: 'camp' }),
    cmd.make('spawn', { x: 0, z: -200, r: 0, count: 1, respawn: 90, types: { boss: 1 }, lvl: [18, 18] }),
  ];
  const c = [cmd.make('chest', { x: 20, z: 20 }), cmd.make('chest', { x: -20, z: 20, ry: Math.PI / 2, big: true, gold: 400, g: 'camp' })];
  const n = [cmd.make('npc', { x: 5, z: 5 }), cmd.make('npc', { kind: 'blacksmith', x: -5, z: 5, ry: -Math.PI / 2, g: 'camp' })];
  const r = [
    cmd.make('region', { name: 'Wilds', levels: [1, 5], mood: 'graveyard', shape: { type: 'circle', x: 0, z: 0, r: 200 } }),
    cmd.make('region', { name: 'Town', safe: true, mood: 'meadow', shape: { type: 'circle', x: 0, z: 0, r: 30 } }),
    cmd.make('region', { name: 'Lake', color: '#3a8fb0', shape: { type: 'poly', points: [[60, 60], [90, 60], [90, 90], [60, 90]] } }),
  ];
  map.objects.push(...o);
  map.spawns.push(...s);
  map.chests.push(...c);
  map.npcs.push(...n);
  map.regions.push(...r);
  const store = createStore();
  store.load(map);
  return { map, store, o, s, c, n, r };
}

// Who is where: every list as it stands, and the objects a command may replace but undo must hand back.
const identity = (map) => ({ lists: LISTS.map((list) => map[list].slice()), ground: map.ground, cells: map.ground.cells, fallback: map.fallback, start: map.start });
function assertIdentity(map, id) {
  LISTS.forEach((list, k) => {
    assert.equal(map[list].length, id.lists[k].length, `${list}: the length differs`);
    for (let i = 0; i < map[list].length; i++) if (map[list][i] !== id.lists[k][i]) assert.fail(`${list}[${i}] is another object`);
  });
  assert.equal(map.ground, id.ground, 'the ground object');
  assert.equal(map.ground.cells, id.cells, 'the cells array');
  assert.equal(map.fallback, id.fallback, 'the fallback object');
  assert.equal(map.start, id.start, 'the start object');
}

// do -> undo -> redo -> undo through the store: the map comes back byte for byte and reference for reference.
// `run` executes the edit (one exec, or a whole group); `before` is the canonical text the map has now.
function roundTrip(store, map, run, before = text(map)) {
  const id = identity(map);
  run();
  const after = raw(map);
  assert.notEqual(after, before, 'the edit changed nothing: this case tests nothing');
  assert.ok(store.canUndo);
  store.undo();
  assert.equal(raw(map), before, 'undo did not restore the bytes');
  assertIdentity(map, id);
  assert.equal(store.redo() !== null, true);
  assert.equal(raw(map), after, 'redo did not repeat the edit');
  store.undo();
  assert.equal(raw(map), before, 'the second undo did not restore the bytes');
  assertIdentity(map, id);
}

const mulberry = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// ---------------------------------------------------------------- make, clone

test('make: the defaults of the format, in the key order of the runtime form', () => {
  const made = {
    object: cmd.make('object', { m: 'medieval/barrel', x: 1, z: 2 }),
    spawn: cmd.make('spawn', {}),
    chest: cmd.make('chest'),
    npc: cmd.make('npc', { x: 0, z: 0 }),
    region: cmd.make('region'),
  };
  assert.deepEqual(made.object, { m: 'medieval/barrel', x: 1, y: 0, z: 2, rx: 0, ry: 0, rz: 0, s: 1, sy: 1, col: null, g: null });
  assert.deepEqual(made.spawn, { types: { chaser: 1 }, lvl: [1, 1], x: 0, z: 0, r: 8, count: 3, respawn: 14, g: null });
  assert.deepEqual(made.chest, { x: 0, z: 0, ry: 0, gold: 12, big: false, respawn: 150, g: null });
  assert.deepEqual(made.npc, { kind: 'guard', x: 0, z: 0, ry: 0, g: null });
  assert.deepEqual(made.region, { name: 'New region', levels: null, mood: null, safe: false, color: null, shape: { type: 'circle', x: 0, z: 0, r: 20 } });
  assert.deepEqual(Object.keys(made.object), ['m', 'x', 'y', 'z', 'rx', 'ry', 'rz', 's', 'sy', 'col', 'g']);
  assert.deepEqual(Object.keys(made.spawn), ['types', 'lvl', 'x', 'z', 'r', 'count', 'respawn', 'g']);
  assert.deepEqual(Object.keys(made.chest), ['x', 'z', 'ry', 'gold', 'big', 'respawn', 'g']);
  assert.deepEqual(Object.keys(made.npc), ['kind', 'x', 'z', 'ry', 'g']);
  assert.deepEqual(Object.keys(made.region), ['name', 'levels', 'mood', 'safe', 'color', 'shape']);

  // exactly what the file decoder builds for the same item, and valid in a map
  const map = emptyMap();
  for (const kind of Object.keys(made)) {
    assert.deepEqual(decodeItem(kind, encodeItem(kind, made[kind])), made[kind], kind);
    map[COLLECTION[kind]].push(made[kind]);
  }
  assert.deepEqual(errors(map), []);

  // nothing is shared between two items
  assert.notEqual(cmd.make('spawn').types, cmd.make('spawn').types);
  assert.notEqual(cmd.make('spawn').lvl, cmd.make('spawn').lvl);
  assert.notEqual(cmd.make('region').shape, cmd.make('region').shape);
  const types = { runner: 2, chaser: 1 }, points = [[0, 0], [10, 0], [0, 10]];
  const spawn = cmd.make('spawn', { types }), region = cmd.make('region', { shape: { type: 'poly', points } });
  assert.notEqual(spawn.types, types);
  assert.deepEqual(Object.keys(spawn.types), ['chaser', 'runner'], 'monster types in MOB_KEYS order, as normalize() gives them');
  assert.notEqual(region.shape.points, points);
  assert.notEqual(region.shape.points[0], points[0]);
});

test('make and clone return quantised items', () => {
  const o = cmd.make('object', { m: 'medieval/barrel', x: 1.23456, y: 0.005, z: -0.001, ry: 7, rx: 0.1, s: 0.57449, sy: 1.0004, col: 0.456 });
  assert.equal(o.x, 1.23);
  assert.equal(o.y, 0.01);
  assert.ok(Object.is(o.z, 0), 'never -0');
  assert.equal(o.ry, qAngle(7));
  assert.ok(o.ry > -Math.PI && o.ry <= Math.PI);
  assert.equal(o.rx, qAngle(0.1));
  assert.equal(o.s, 0.574);
  assert.equal(o.sy, 1);
  assert.equal(o.col, 0.46);
  assert.deepEqual(cmd.make('object', { m: 'a/b', col: [{ x: 0.12345, z: -0.5, r: 0.7306 }] }).col, [{ x: 0.123, z: -0.5, r: 0.731 }]);
  assert.equal(cmd.make('spawn', { x: 0.004, z: 9.999, r: 7.777 }).r, 7.78);
  assert.equal(cmd.make('chest', { ry: 90.004 * DEG }).ry, toRad(90));
  assert.deepEqual(cmd.make('region', { shape: { type: 'poly', points: [[0.004, 1.006], [5, 5], [0, 9.999]] } }).shape.points, [[0, 1.01], [5, 5], [0, 10]]);

  const dirty = { m: 'a/b', x: 1.006, y: 0, z: 2, rx: 0, ry: 0.5, rz: 0, s: 1.00049, sy: 1, col: null, g: null };
  const copy = cmd.clone(dirty);
  assert.equal(copy.x, 1.01);
  assert.equal(copy.ry, qAngle(0.5));
  assert.equal(copy.s, 1);
  assert.equal(dirty.x, 1.006, 'the original is not touched');
});

test('make refuses what would leave no file form', () => {
  assert.throws(() => cmd.make('start'), TypeError, 'a map has exactly one start');
  assert.throws(() => cmd.make('tree'), TypeError);
  assert.throws(() => cmd.make('object', { x: 1, z: 2 }), /m/, 'an object needs its model');
  assert.throws(() => cmd.make('object', { m: 'a/b', x: NaN }), /finite number/);
  assert.throws(() => cmd.make('object', { m: 'a/b', x: '1' }), TypeError);
  assert.throws(() => cmd.make('object', { m: 'a/b', s: Infinity }), TypeError);
  assert.throws(() => cmd.make('object', { m: 'a/b', col: 'sphere' }), TypeError);
  assert.throws(() => cmd.make('object', { m: 'a/b', col: [{ x: 0, z: 0 }] }), TypeError);
  assert.throws(() => cmd.make('object', { m: 7 }), TypeError);
  assert.throws(() => cmd.make('npc', { kind: 'wizard' }), TypeError);
  assert.throws(() => cmd.make('npc', { kind: 'constructor' }), TypeError);
  assert.throws(() => cmd.make('npc', { rot: 1 }), /'rot'/, 'an unknown key is a typo, not a default');
  assert.throws(() => cmd.make('region', { mood: 'sunny' }), TypeError);
  assert.throws(() => cmd.make('region', { mood: 'constructor' }), TypeError);
  assert.throws(() => cmd.make('region', { shape: { type: 'square', x: 0, z: 0, r: 1 } }), TypeError);
  assert.throws(() => cmd.make('region', { shape: { type: 'poly', points: [[0, 0], [1]] } }), TypeError);
  assert.throws(() => cmd.make('region', { levels: [1] }), TypeError);
  assert.throws(() => cmd.make('spawn', { types: { dragon: 1 } }), TypeError);
  assert.throws(() => cmd.make('spawn', { types: { chaser: '3' } }), TypeError);
  assert.throws(() => cmd.make('spawn', { lvl: [1, NaN] }), TypeError);
  assert.throws(() => cmd.make('chest', { big: 1 }), TypeError);
  assert.throws(() => cmd.make('chest', { g: 5 }), TypeError);
  // ... but ranges are not its business: validate() reports them
  const far = cmd.make('object', { m: 'nopack/x', x: 1e6, z: 0, s: 500 });
  assert.equal(far.s, 500);
  assert.deepEqual(cmd.make('spawn', { count: 999, lvl: [50, 2], types: {} }).lvl, [50, 2]);
});

test('clone: a deep copy that shares nothing with the original', () => {
  const { map, o, s, c, n, r } = world();
  for (const item of [...o, ...s, ...c, ...n, ...r, map.start]) {
    const copy = cmd.clone(item);
    assert.notEqual(copy, item);
    assert.deepEqual(copy, item);
    assert.deepEqual(Object.keys(copy), Object.keys(item));
  }
  const spawn = cmd.clone(s[1]);
  assert.notEqual(spawn.types, s[1].types);
  assert.notEqual(spawn.lvl, s[1].lvl);
  const poly = cmd.clone(r[2]);
  assert.notEqual(poly.shape, r[2].shape);
  assert.notEqual(poly.shape.points, r[2].shape.points);
  assert.notEqual(poly.shape.points[0], r[2].shape.points[0]);
  const pillar = cmd.clone(o[3]);
  assert.notEqual(pillar.col, o[3].col);
  assert.notEqual(pillar.col[0], o[3].col[0]);
  pillar.col[0].r = 5;
  poly.shape.points[0][0] = -1;
  assert.equal(o[3].col[0].r, 0.73);
  assert.equal(r[2].shape.points[0][0], 60);
  assert.throws(() => cmd.clone(null), TypeError);
  assert.throws(() => cmd.clone({ name: 'not an item' }), TypeError);
  assert.throws(() => cmd.clone({ m: 'a/b', x: 0, z: 0 }), TypeError, 'an item that was not made with make() lacks fields');
});

// ---------------------------------------------------------------- set, setEach

test('set quantises with qPos - and undo restores the exact double (the first acceptance lines of step 3)', () => {
  const { map, store, o } = world();
  const obj = o[2], x = obj.x;
  store.exec(cmd.set([obj], { x: x + 5 }));
  assert.ok(obj.x === qPos(x + 5) && store.dirty);
  store.undo();
  assert.ok(obj.x === x && !store.dirty);

  // for some two-decimal x, x + 5 is not the double that the file holds: the command must write the quantised one
  let off = 0;
  for (let k = -13000; k <= 13000; k += 7) {
    const from = k / 100;
    obj.x = from;                                   // (test set-up: placing the object, not an edit)
    const command = cmd.set([obj], { x: from + 5 });
    command.do(map);
    if (from + 5 !== qPos(from + 5)) off++;
    assert.equal(obj.x, qPos(from + 5));
    assert.equal(obj.x, Number((from + 5).toFixed(2)));
    command.undo(map);
    assert.ok(Object.is(obj.x, from === 0 ? 0 : from), `undo of x = ${from}`);
  }
  assert.ok(off > 20, `only ${off} sums were off the grid: the loop tests nothing`);
});

test('set quantises every kind of number it writes', () => {
  const { map, store, o, s, c, n, r } = world();
  store.exec(cmd.set([o[0]], { x: -0.001, y: 3.14159, z: 2.005, ry: 90 * DEG, rx: 0.123456, rz: -4, s: 0.57449, sy: 2.0006, col: 0.4567 }));
  assert.ok(Object.is(o[0].x, 0));
  assert.equal(o[0].y, 3.14);
  assert.equal(o[0].z, qPos(2.005));
  assert.ok(Math.abs(o[0].ry - Math.PI / 2) < 1e-6);
  assert.equal(toDeg(o[0].ry), 90);
  assert.equal(o[0].rx, qAngle(0.123456));
  assert.equal(o[0].rz, qAngle(-4));
  assert.ok(o[0].rz > -Math.PI && o[0].rz <= Math.PI, 'angles are wrapped');
  assert.equal(o[0].s, 0.574);
  assert.equal(o[0].sy, 2.001);
  assert.equal(o[0].col, 0.46);
  store.exec(cmd.set([o[1]], { col: [{ x: 0.12345, z: 1, r: 0.7306 }] }));
  assert.deepEqual(o[1].col, [{ x: 0.123, z: 1, r: 0.731 }]);
  store.exec(cmd.set([s[0], map.start], { r: 3.14159 }));
  assert.equal(s[0].r, 3.14);
  assert.equal(map.start.r, 3.14);
  store.exec(cmd.set([c[0], n[0]], { ry: -180 * DEG, x: 7.777 }));
  assert.equal(toDeg(c[0].ry), 180, '-180 is written as 180');
  assert.equal(n[0].ry, c[0].ry);
  assert.equal(c[0].x, 7.78);
  store.exec(cmd.set([r[1]], { shape: { type: 'circle', x: 1.006, z: -0.004, r: 9.999 } }));
  assert.deepEqual(r[1].shape, { type: 'circle', x: 1.01, z: 0, r: 10 });
  assert.ok(Object.is(r[1].shape.z, 0));
  store.exec(cmd.set([r[2]], { shape: { type: 'poly', points: [[0.004, 0], [10.006, 0], [0, 9.994]] } }));
  assert.deepEqual(r[2].shape.points, [[0, 0], [10.01, 0], [0, 9.99]]);
  // whatever a command leaves in the map is exactly what a save and a load would give back
  assert.equal(raw(normalize(JSON.parse(raw(map)), { check: false })), raw(map));
});

test('set: the same patch on every item, in place; undefined resets a key to its default', () => {
  const { map, store, o, s, c, n, r } = world();
  const before = text(map), refs = [...o];
  store.exec(cmd.set(o, { s: 2, g: 'row' }));
  assert.ok(o.every((it) => it.s === 2 && it.g === 'row'));
  assert.ok(o.every((it, i) => it === refs[i] && map.objects[i] === it), 'the items are mutated in place');
  store.exec(cmd.set(o, { g: undefined, col: undefined, s: undefined, y: undefined, rx: undefined, ry: undefined, rz: undefined, sy: undefined }));
  assert.ok(o.every((it) => it.g === null && it.col === null && it.s === 1 && it.y === 0 && it.rx === 0 && it.ry === 0 && it.rz === 0 && it.sy === 1));
  store.exec(cmd.set([c[1], n[1], s[1]], { g: undefined, ry: undefined, big: undefined }));
  assert.deepEqual([c[1].g, c[1].ry, c[1].big, n[1].g, n[1].ry, s[1].g], [null, 0, false, null, 0, null]);
  store.exec(cmd.set([r[0], r[2]], { levels: undefined, mood: undefined, safe: undefined, color: undefined }));
  assert.deepEqual([r[0].levels, r[0].mood, r[0].safe, r[2].color], [null, null, false, null]);
  assert.throws(() => cmd.set([o[0]], { m: undefined }), /no default/);
  assert.throws(() => cmd.set([o[0]], { x: undefined }), /no default/);
  assert.throws(() => cmd.set([s[0]], { count: undefined }), /no default/);
  for (let i = 0; i < 4; i++) store.undo();
  assert.equal(raw(map), before);
});

test('set skips the keys a kind does not have, so one patch serves a mixed selection', () => {
  const { map, store, o, s, c, n, r } = world();
  const all = [o[0], s[0], c[0], n[0], r[0], map.start];
  const change = store.exec(cmd.set(all, { g: 'mix', ry: 1, r: 4, kind: 'sage', name: 'Named', gold: 77 }));
  assert.deepEqual(Object.keys(o[0]), ['m', 'x', 'y', 'z', 'rx', 'ry', 'rz', 's', 'sy', 'col', 'g'], 'no stray key on any item');
  assert.deepEqual(Object.keys(s[0]), ['types', 'lvl', 'x', 'z', 'r', 'count', 'respawn', 'g']);
  assert.deepEqual(Object.keys(c[0]), ['x', 'z', 'ry', 'gold', 'big', 'respawn', 'g']);
  assert.deepEqual(Object.keys(n[0]), ['kind', 'x', 'z', 'ry', 'g']);
  assert.deepEqual(Object.keys(r[0]), ['name', 'levels', 'mood', 'safe', 'color', 'shape']);
  assert.deepEqual(Object.keys(map.start), ['x', 'z', 'r']);
  assert.deepEqual([o[0].g, o[0].ry, s[0].g, s[0].r, c[0].gold, c[0].ry, n[0].kind, r[0].name, map.start.r], ['mix', qAngle(1), 'mix', 4, 77, qAngle(1), 'sage', 'Named', 4]);
  assert.deepEqual(change.updated, { objects: [o[0]], spawns: [s[0]], chests: [c[0]], npcs: [n[0]], regions: [r[0]], start: [map.start] });
  // a patch with nothing for an item leaves it out of the Change
  const part = store.exec(cmd.set(all, { gold: 5 }));
  assert.deepEqual(part.updated, { objects: [], spawns: [], chests: [c[0]], npcs: [], regions: [], start: [] });
});

test('set: object values are copied per item and replace the old ones; the region stays the same object', () => {
  const { map, store, s, r } = world();
  const types = { chaser: 4, tank: 1 }, lvl = [2, 6];
  store.exec(cmd.set(s, { types, lvl }));
  assert.deepEqual(s[0].types, types);
  assert.notEqual(s[0].types, types, 'not the object the caller holds');
  assert.notEqual(s[0].types, s[1].types, 'and not one object inside two items');
  assert.notEqual(s[0].lvl, s[1].lvl);
  types.chaser = 99;
  lvl[0] = 99;
  assert.equal(s[0].types.chaser, 4);
  assert.equal(s[1].lvl[0], 2);

  // region geometry: the shape object is replaced, the region is kept (§10.6 rule 3)
  const region = r[2], old = region.shape, shape = { type: 'poly', points: [[0, 0], [20, 0], [20, 20], [0, 20]] };
  store.exec(cmd.set([region], { shape }));
  assert.equal(map.regions[2], region);
  assert.notEqual(region.shape, old);
  assert.notEqual(region.shape, shape);
  assert.deepEqual(region.shape, shape);
  assert.deepEqual(old.points, [[60, 60], [90, 60], [90, 90], [60, 90]], 'the old shape is not written to');
  const set2 = region.shape;
  // the same geometry once more changes nothing - not even which object the region holds
  assert.ok(isEmptyChange(store.exec(cmd.set([region], { shape: { type: 'poly', points: [[0, 0], [20, 0], [20, 20], [0, 20.001]] } }))));
  assert.equal(region.shape, set2);
  assert.equal(store.undoLabel, 'Reshape 1 region', 'and it left no step');
  store.exec(cmd.set([region], { shape: { type: 'circle', x: 5, z: 5, r: 9 } }));
  assert.equal(region.shape.type, 'circle');
  store.undo();
  assert.equal(region.shape, set2, 'undo hands back the very object');
  store.undo();
  assert.equal(region.shape, old);
  store.redo();
  assert.equal(region.shape, set2);
});

test('set refuses values that would leave no file form, before anything is written', () => {
  const { map, o, s, n, r } = world();
  const before = text(map);
  const bad = [
    [o, { x: NaN }], [o, { s: Infinity }], [o, { ry: '90' }], [o, { m: null }], [o, { g: 7 }], [o, { col: 'round' }], [o, { col: [{ x: 0, z: 0, r: NaN }] }],
    [s, { types: { ghost: 1 } }], [s, { types: [] }], [s, { lvl: [1] }], [s, { count: '3' }], [s, { r: null }],
    [n, { kind: 'wizard' }], [r, { mood: 'sunny' }], [r, { safe: 'yes' }], [r, { name: null }], [r, { levels: 5 }],
    [r, { shape: null }], [r, { shape: { type: 'circle', x: 0, z: 0 } }], [r, { shape: { type: 'poly', points: [[0, 0], [1, 'a']] } }],
    [[map.start], { r: NaN }],
  ];
  for (const [items, patch] of bad) assert.throws(() => cmd.set(items, patch), TypeError, JSON.stringify(patch));
  assert.throws(() => cmd.set(o, null), TypeError);
  assert.throws(() => cmd.set([{ foo: 1 }], { x: 1 }), TypeError, 'not a map item');
  assert.throws(() => cmd.setEach(o, [{ x: 1 }]), /one patch per item/);
  assert.throws(() => cmd.setEach([o[0]], [{ x: NaN }]), TypeError);
  assert.equal(text(map), before);
  // out-of-range is fine here: the Issues panel shows it
  assert.doesNotThrow(() => cmd.set(o, { s: 500, y: -999 }));
});

test('setEach: patches[i] for items[i]', () => {
  const { map, store, o, s, c } = world();
  const before = text(map);
  const change = store.exec(cmd.setEach([o[0], o[1], s[0], c[0], o[2]], [{ x: 1 }, { x: 2, ry: 1 }, { count: 9 }, {}, { name: 'no such field' }]));
  assert.deepEqual([o[0].x, o[1].x, o[1].ry, s[0].count], [1, 2, qAngle(1), 9]);
  assert.deepEqual(change.updated.objects, [o[0], o[1]]);
  assert.deepEqual(change.updated.spawns, [s[0]]);
  assert.deepEqual(change.updated.chests, [], 'an empty patch touches nothing');
  // an item given twice gets both patches, the later one winning key by key
  store.exec(cmd.setEach([o[3], o[3]], [{ x: 1, y: 1 }, { x: 2 }]));
  assert.deepEqual([o[3].x, o[3].y], [2, 1]);
  store.undo();
  assert.deepEqual([o[3].x, o[3].y], [50, 1.5]);
  store.undo();
  assert.equal(text(map), before);
});

test('typesPatch through setEach: the boss respawn rule lands in the same undo step', () => {
  const { map, store, s } = world();
  const before = text(map), field = FIELDS.spawn.find((f) => f.key === 'types');
  assert.equal(field.patch, typesPatch);
  const value = { boss: 1 };
  store.exec(cmd.setEach(s, s.map((it) => field.patch(it, value))));
  assert.deepEqual(s.map((it) => it.respawn), [90, 90, 90], 'two camps took the boss respawn; the boss kept its own');
  assert.ok(s.every((it) => Object.keys(it.types).join() === 'boss'));
  store.exec(cmd.setEach(s, s.map((it) => field.patch(it, { chaser: 3, runner: 2 }))));
  assert.deepEqual(s.map((it) => it.respawn), [14, 14, 14]);
  store.undo();
  store.undo();
  assert.equal(text(map), before);
  assert.deepEqual(s.map((it) => it.respawn), [14, 14, 90]);
});

test('the start point of another map is not this map\'s business', () => {
  const { map, store, o } = world();
  const before = text(map), foreign = emptyMap().start;
  assert.ok(isEmptyChange(store.exec(cmd.set([foreign], { x: 5, r: 9 }))));
  assert.ok(isEmptyChange(store.exec(cmd.transform(cmd.snapshot([foreign]), { dx: 5, scale: 2 }))));
  assert.ok(isEmptyChange(store.exec(cmd.remove([foreign]))));
  assert.deepEqual(foreign, { x: 0, z: 0, r: 5 }, 'not written to');
  // together with real items, only those change
  const change = store.exec(cmd.set([foreign, o[0], map.start], { x: 5 }));
  assert.deepEqual([change.updated.objects, change.updated.start], [[o[0]], [map.start]]);
  assert.equal(foreign.x, 0);
  store.undo();
  assert.equal(text(map), before);
  assert.equal(store.canUndo, false);
});

test('set labels say what happened', () => {
  const { map, o, s, n, r } = world();
  const label = (items, patch) => cmd.set(items, patch).label;
  assert.equal(label([o[0]], { x: 1, z: 2 }), 'Move 1 object');
  assert.equal(label(o, { ry: 1 }), 'Rotate 6 objects');
  assert.equal(label([o[0], o[1]], { s: 2 }), 'Scale 2 objects');
  assert.equal(label([s[0]], { r: 2 }), 'Resize 1 spawn');
  assert.equal(label([o[0], s[0], n[0]], { g: 'a' }), 'Group 3 items');
  assert.equal(label([o[0], n[0]], { g: undefined }), 'Ungroup 2 items');
  assert.equal(label([o[0], o[1]], { m: 'medieval/crate' }), 'Replace the model of 2 objects');
  assert.equal(label([r[0]], { name: 'X' }), 'Rename 1 region');
  assert.equal(label([r[0]], { shape: { type: 'circle', x: 0, z: 0, r: 5 } }), 'Reshape 1 region');
  assert.equal(label([n[0], n[1]], { kind: 'sage' }), 'Edit 2 NPCs');
  assert.equal(label([map.start], { x: 1 }), 'Move the start point');
  assert.equal(label(Array.from({ length: 1500 }, () => cmd.make('chest')), { gold: 5 }), 'Edit 1,500 chests');
  for (const command of [cmd.set(o, { x: 1 }), cmd.setEach(o, o.map(() => ({ y: 1 })))]) {
    assert.equal(typeof command.label, 'string');
    assert.ok(Number.isFinite(command.bytes) && command.bytes > 0);
  }
});

// ---------------------------------------------------------------- add, remove

test('add inserts the GIVEN references: at the end, at one index, at ascending indices', () => {
  const { map, store, o } = world();
  const before = text(map), mk = (x) => cmd.make('object', { m: 'medieval/crate', x, z: 70 });
  const a = mk(1), b = mk(2), c1 = mk(3), d = mk(4), e = mk(5), f = mk(6), g = mk(7);

  store.exec(cmd.add('object', [a, b]));
  assert.deepEqual(map.objects, [...o, a, b]);
  assert.equal(map.objects[6], a, 'the reference itself, not a copy');

  store.exec(cmd.add('object', [c1, d], 1));
  assert.deepEqual(map.objects, [o[0], c1, d, o[1], o[2], o[3], o[4], o[5], a, b]);

  const change = store.exec(cmd.add('object', [e, f, g], [0, 2, 12]));
  assert.deepEqual(map.objects, [e, o[0], f, c1, d, o[1], o[2], o[3], o[4], o[5], a, b, g]);
  assert.deepEqual(change.added.objects, [e, f, g]);

  const late = mk(8);
  store.exec(cmd.add('object', [late], 999));
  assert.equal(map.objects.at(-1), late, 'one index beyond the end means the end');

  store.undo();
  assert.equal(store.undo(), 'Add 3 objects');
  assert.deepEqual(map.objects, [o[0], c1, d, o[1], o[2], o[3], o[4], o[5], a, b]);
  store.undo();
  assert.deepEqual(map.objects, [...o, a, b]);
  store.undo();
  assert.equal(text(map), before);
  for (let i = 0; i < 4; i++) store.redo();
  assert.deepEqual(map.objects, [e, o[0], f, c1, d, o[1], o[2], o[3], o[4], o[5], a, b, g, late]);
});

test('add quantises what it inserts and checks what it is given', () => {
  const { map, store, o, s } = world();
  const before = text(map);
  const rough = cmd.make('object', { m: 'medieval/crate', x: 1, z: 1 });
  rough.x = 3.14159;                                // (somebody computed a position after make)
  store.exec(cmd.add('object', [rough, rough]));
  assert.equal(rough.x, 3.14);
  assert.equal(map.objects.filter((q) => q === rough).length, 1, 'an item given twice is added once');
  store.undo();

  assert.throws(() => cmd.add('start', [map.start]), TypeError);
  assert.throws(() => cmd.add('tree', []), TypeError);
  assert.throws(() => cmd.add('object', [cmd.make('spawn')]), /items of that kind/, 'a spawn in the object list would corrupt the map');
  assert.throws(() => cmd.add('spawn', [cmd.clone(o[0])]), TypeError);
  assert.throws(() => cmd.add('object', [{ m: 'a/b', x: 0, z: 0 }]), /finite number/, 'a literal that lacks fields: use make()');
  assert.throws(() => cmd.add('object', [cmd.clone(o[0])], -1), TypeError);
  assert.throws(() => cmd.add('object', [cmd.clone(o[0])], 1.5), TypeError);
  assert.throws(() => cmd.add('object', [cmd.clone(o[0])], [0, 1]), /one index per item/);
  assert.throws(() => cmd.add('object', [cmd.clone(o[0]), cmd.clone(o[0])], [2, 2]), /ascending/);
  // an index list that would leave a hole is refused when the command meets the map - and nothing is written
  const hole = cmd.add('spawn', [cmd.clone(s[0]), cmd.clone(s[0])], [0, 9]);
  assert.throws(() => store.exec(hole), RangeError);
  assert.equal(text(map), before);
  assert.equal(store.canUndo, false);
});

test('add: a following add of the same kind at the end merges', () => {
  const { map, o, s } = world();
  const mk = () => cmd.make('object', { m: 'medieval/crate', x: 1, z: 1 });
  const first = cmd.add('object', [mk()]), second = cmd.add('object', [mk(), mk()]);
  first.do(map);
  assert.equal(first.merge(second), true);
  second.do(map);
  assert.equal(first.label, 'Add 3 objects');
  assert.equal(first.merge(cmd.add('spawn', [cmd.clone(s[0])])), false, 'another kind');
  assert.equal(first.merge(cmd.add('object', [mk()], 0)), false, 'not at the end');
  assert.equal(cmd.add('object', [mk()], 0).merge(cmd.add('object', [mk()])), false);
  assert.equal(first.merge(cmd.remove([o[0]])), false);
  assert.equal(first.undo(map).removed.objects.length, 3);
  assert.deepEqual(map.objects, o);
  assert.equal(first.do(map).added.objects.length, 3, 'the redo adds all three');
  assert.equal(map.objects.length, 9);
});

test('remove: undo re-inserts the SAME references at the SAME indices', () => {
  const { map, store, o, s, c, n, r } = world();
  const before = text(map), id = identity(map);
  const change = store.exec(cmd.remove([o[4], map.start, r[1], o[0], s[2], c[0], n[1], o[5], o[0]]));
  assert.deepEqual(map.objects, [o[1], o[2], o[3]]);
  assert.deepEqual(map.spawns, [s[0], s[1]]);
  assert.deepEqual(map.chests, [c[1]]);
  assert.deepEqual(map.npcs, [n[0]]);
  assert.deepEqual(map.regions, [r[0], r[2]]);
  assert.deepEqual(change.removed, { objects: [o[0], o[4], o[5]], spawns: [s[2]], chests: [c[0]], npcs: [n[1]], regions: [r[1]] }, 'in ascending index order');
  assert.equal(map.start, id.start, 'the start point is skipped');
  assert.equal(store.undoLabel, 'Delete 7 items');

  const back = [];
  store.on('change', (ch) => back.push(ch));
  store.undo();
  assertIdentity(map, id);
  assert.equal(text(map), before);
  assert.deepEqual(back[0].added.objects, [o[0], o[4], o[5]]);
  store.redo();
  assert.deepEqual(map.objects, [o[1], o[2], o[3]]);
  store.undo();
  assertIdentity(map, id);
});

test('remove ignores what is not in the map, and the start', () => {
  const { map, store, o } = world();
  const stranger = cmd.clone(o[0]);
  assert.equal(cmd.remove([map.start]).label, 'Delete 0 items');
  assert.ok(isEmptyChange(store.exec(cmd.remove([map.start, stranger]))));
  const command = cmd.remove([o[1], stranger]);
  assert.equal(command.label, 'Delete 2 objects');
  store.exec(command);
  assert.equal(command.label, 'Delete 1 object', 'the label counts what was really removed');
  assert.equal(map.objects.length, 5);
  assert.throws(() => cmd.remove([{ foo: 1 }]), TypeError);
  assert.throws(() => cmd.remove([null]), TypeError);
});

test('removing thousands of objects is one pass per list: no splice, no indexOf', () => {
  const map = emptyMap(), N = 20000;
  for (let i = 0; i < N; i++) map.objects.push(cmd.make('object', { m: 'medieval/barrel', x: (i % 200) - 100, z: Math.floor(i / 200) - 50 }));
  const store = createStore();
  store.load(map);
  const original = map.objects.slice(), rnd = mulberry(7);
  const gone = new Set(original.filter(() => rnd() < 0.6)), left = original.filter((it) => !gone.has(it));
  const command = cmd.remove([...gone].reverse());        // in any order: the indices are found, not given

  const { splice, indexOf } = Array.prototype;
  let calls = 0;
  Array.prototype.splice = function counted(...args) { calls++; return splice.apply(this, args); };
  Array.prototype.indexOf = function counted(...args) { calls++; return indexOf.apply(this, args); };
  try {
    store.exec(command);
    store.undo();
    store.redo();
    store.undo();
    store.redo();
  } finally {
    Array.prototype.splice = splice;
    Array.prototype.indexOf = indexOf;
  }
  assert.equal(calls, 0);
  assert.ok(gone.size > N / 2 && left.length > N / 4);
  assert.equal(map.objects.length, left.length);
  for (let i = 0; i < left.length; i++) if (map.objects[i] !== left[i]) assert.fail(`objects[${i}] is not the object that should be left there`);
  store.undo();
  assert.equal(map.objects.length, N);
  for (let i = 0; i < N; i++) if (map.objects[i] !== original[i]) assert.fail(`objects[${i}] moved`);
});

// ---------------------------------------------------------------- snapshot, transform

test('transform: move, per kind (the table of §9.3)', () => {
  const { map, store, o, s, c, n, r } = world();
  const before = text(map), all = [o[3], s[1], c[1], n[1], r[1], r[2], map.start];
  const was = all.map((it) => cmd.clone(it));
  store.exec(cmd.transform(cmd.snapshot(all), { dx: 2.5, dz: -1.25, dy: 3 }));
  assert.deepEqual([o[3].x, o[3].z, o[3].y], [52.5, -21.25, 4.5], 'an object moves in x, z and y');
  assert.deepEqual([o[3].ry, o[3].s, o[3].rx, o[3].sy], [was[0].ry, was[0].s, was[0].rx, was[0].sy]);
  assert.deepEqual([s[1].x, s[1].z, s[1].r], [-97.5, 48.75, 12], 'dy means nothing to a spawn');
  assert.deepEqual([c[1].x, c[1].z, c[1].ry], [-17.5, 18.75, was[2].ry]);
  assert.deepEqual([n[1].x, n[1].z, n[1].ry], [-2.5, 3.75, was[3].ry]);
  assert.deepEqual(r[1].shape, { type: 'circle', x: 2.5, z: -1.25, r: 30 });
  assert.deepEqual(r[2].shape.points, [[62.5, 58.75], [92.5, 58.75], [92.5, 88.75], [62.5, 88.75]], 'a polygon moves all its points');
  assert.deepEqual(map.start, { x: 2.5, z: -1.25, r: 5 });
  assert.equal(store.undoLabel, 'Move 7 items');
  store.undo();
  assert.equal(text(map), before);
});

test('transform: rotation about the pivot - a positive angle takes +Z towards +X, as ry does', () => {
  const { map, store, o, s, c, n, r } = world();
  const before = text(map), pivot = { x: 0, z: 0 };
  const south = cmd.make('object', { m: 'medieval/crate', x: 0, z: 10 });
  store.exec(cmd.add('object', [south]));
  const all = [south, o[2], s[1], c[1], n[1], r[1], r[2], map.start], was = all.map((it) => cmd.clone(it));
  store.exec(cmd.transform(cmd.snapshot(all), { rot: Math.PI / 2, pivot }));
  assert.deepEqual([south.x, south.z], [10, 0], 'south of the pivot ends up east of it');
  assert.equal(toDeg(south.ry), 90, 'and the object turns with it');
  assert.deepEqual([o[2].x, o[2].z], [40, 30]);                 // (-30, 40) -> (40, 30)
  assert.equal(toDeg(o[2].ry), qPos(74.48 + 90));
  assert.equal(o[2].s, 1.1);
  assert.deepEqual([s[1].x, s[1].z, s[1].r], [50, 100, 12], 'a spawn turns about the pivot; it has no facing');
  assert.deepEqual([c[1].x, c[1].z], [20, 20]);
  assert.equal(toDeg(c[1].ry), 180);
  assert.deepEqual([n[1].x, n[1].z], [5, 5]);
  assert.equal(toDeg(n[1].ry), 0);
  assert.deepEqual(r[1].shape, was[5].shape, 'a circle on the pivot does not change');
  assert.deepEqual(r[2].shape.points, [[60, -60], [60, -90], [90, -90], [90, -60]], 'all points of a polygon turn');
  assert.deepEqual(map.start, was[7]);
  assert.equal(store.undoLabel, 'Rotate 8 items');
  store.undo();
  store.undo();
  assert.equal(text(map), before);

  // every angle lands on the 0.01 degree grid, wrapped into (-180, 180]
  store.exec(cmd.set([o[0]], { ry: 170 * DEG }));
  store.exec(cmd.transform(cmd.snapshot([o[0]]), { rot: 20 * DEG }));
  assert.equal(toDeg(o[0].ry), -170);
  store.exec(cmd.transform(cmd.snapshot([o[0]]), { rot: -10 * DEG }));
  assert.equal(toDeg(o[0].ry), 180);
  // 24 steps of 15 degrees are a full turn: the angle is exactly where it started (the Q key, 24 times)
  const ry = o[2].ry;
  for (let i = 0; i < 24; i++) store.exec(cmd.transform(cmd.snapshot([o[2]]), { rot: 15 * DEG }));
  assert.equal(o[2].ry, ry);
  assert.deepEqual([o[2].x, o[2].z], [-30, 40], 'alone, it turns about its own origin');
});

test('transform: scale about the pivot', () => {
  const { map, store, o, s, c, n, r } = world();
  const before = text(map), all = [o[2], s[1], c[1], n[1], r[1], r[2], map.start];
  store.exec(cmd.set([map.start], { x: 4, z: 2 }));
  store.exec(cmd.transform(cmd.snapshot(all), { scale: 2, pivot: { x: 0, z: 0 } }));
  assert.deepEqual([o[2].x, o[2].z, o[2].s], [-60, 80, 2.2], 'position and s scale');
  assert.deepEqual([o[2].sy, toDeg(o[2].ry)], [1, 74.48], 'sy is relative to s and stays');
  assert.deepEqual([s[1].x, s[1].z, s[1].r], [-200, 100, 24]);
  assert.deepEqual([c[1].x, c[1].z, c[1].gold], [-40, 40, 400], 'a chest only moves');
  assert.deepEqual([n[1].x, n[1].z], [-10, 10]);
  assert.deepEqual(r[1].shape, { type: 'circle', x: 0, z: 0, r: 60 });
  assert.deepEqual(r[2].shape.points, [[120, 120], [180, 120], [180, 180], [120, 180]]);
  assert.deepEqual(map.start, { x: 8, z: 4, r: 10 });
  assert.equal(store.undoLabel, 'Scale 7 items');
  store.undo();
  store.undo();
  assert.equal(text(map), before);
  // scales land on their own grid: 3 decimals for s, 2 for a radius
  store.exec(cmd.transform(cmd.snapshot([o[2], s[1]]), { scale: 0.9 }));
  assert.equal(o[2].s, qScale(1.1 * 0.9));
  assert.equal(s[1].r, qPos(12 * 0.9));
});

test('transform: the default pivot is the middle of the origins; `individual` keeps positions', () => {
  const { map, store, o, s, c, r } = world();
  const before = text(map);
  store.exec(cmd.transform(cmd.snapshot([o[0], o[1]]), { rot: Math.PI }));      // (10, 10) and (12, 10): pivot (11, 10)
  assert.deepEqual([o[0].x, o[0].z, o[1].x, o[1].z], [12, 10, 10, 10], 'the two swap places');
  assert.equal(toDeg(o[0].ry), 180);
  store.undo();

  const all = [o[2], s[1], c[1], r[1], r[2], map.start], was = all.map((it) => cmd.clone(it));
  store.exec(cmd.transform(cmd.snapshot(all), { rot: Math.PI / 2, scale: 2, individual: true }));
  assert.deepEqual([o[2].x, o[2].z, s[1].x, s[1].z, c[1].x, c[1].z], [-30, 40, -100, 50, -20, 20], 'positions stay');
  assert.equal(toDeg(o[2].ry), qPos(74.48 + 90));
  assert.equal(o[2].s, 2.2);
  assert.equal(s[1].r, 24);
  assert.equal(toDeg(c[1].ry), 180);
  assert.deepEqual(r[1].shape, { type: 'circle', x: 0, z: 0, r: 60 });
  assert.deepEqual(map.start, { x: 0, z: 0, r: 10 });
  // a polygon turns and grows about its own centre (75, 75), which stays
  assert.deepEqual(r[2].shape.points, [[45, 105], [45, 45], [105, 45], [105, 105]]);
  assert.deepEqual(was[4].shape.points, [[60, 60], [90, 60], [90, 90], [60, 90]]);
  // with a translation on top, everything still moves together
  store.undo();
  store.exec(cmd.transform(cmd.snapshot([o[2], s[1]]), { dx: 1, dz: 1, rot: 0.5, individual: true }));
  assert.deepEqual([o[2].x, o[2].z, s[1].x, s[1].z], [-29, 41, -99, 51]);
  store.undo();
  assert.equal(text(map), before);
});

test('transform is always relative to the snapshot, and undo to what the command found', () => {
  const { map, store, o } = world();
  const before = text(map), snap = cmd.snapshot([o[0], o[1]]);
  store.exec(cmd.transform(snap, { dx: 1 }));
  store.exec(cmd.transform(snap, { dx: 1 }));
  assert.equal(o[0].x, 11, 'twice the same t is not twice the move');
  store.exec(cmd.transform(snap, { dx: 0.004 }));
  assert.equal(o[0].x, 10, 'back on the snapshot values (quantised)');
  store.exec(cmd.transform(snap, { dz: 7 }));
  assert.deepEqual([o[0].x, o[0].z], [10, 17]);
  while (store.undo() !== null);
  assert.equal(text(map), before);

  // the items moved between the snapshot and the transform: undo still restores what the command found
  const late = cmd.snapshot([o[2]]);
  store.exec(cmd.set([o[2]], { x: 0, s: 3 }));
  store.exec(cmd.transform(late, { dx: 5 }));
  assert.deepEqual([o[2].x, o[2].s], [-25, 1.1], 'relative to the snapshot');
  store.undo();
  assert.deepEqual([o[2].x, o[2].s], [0, 3]);
  store.undo();
  assert.equal(text(map), before);

  // a snapshot is a copy: editing the items afterwards does not change it
  const copy = cmd.snapshot([o[3]]);
  assert.deepEqual(copy.items, [o[3]]);
  assert.deepEqual(cmd.snapshot([o[3], o[3]]).items, [o[3]], 'an item given twice is in it once');
  assert.throws(() => cmd.snapshot([{ foo: 1 }]), TypeError);
});

test('transform: merging, validation, labels', () => {
  const { map, o, n } = world();
  const snap = cmd.snapshot([o[0], o[1]]), a = cmd.transform(snap, { dx: 1 }), b = cmd.transform(snap, { dx: 2 });
  a.do(map);
  assert.equal(a.merge(b), true);
  b.do(map);
  assert.equal(o[0].x, 12);
  assert.equal(a.merge(cmd.transform(cmd.snapshot([o[0], o[1]]), { dx: 3 })), false, 'another snapshot');
  assert.equal(a.merge(cmd.set([o[0]], { x: 1 })), false);
  a.undo(map);
  assert.equal(o[0].x, 10);
  a.do(map);
  assert.equal(o[0].x, 12, 'the redo applies the merged t');
  a.undo(map);

  assert.equal(cmd.transform(snap, { dx: 1 }).label, 'Move 2 objects');
  assert.equal(cmd.transform(snap, { dy: 1 }).label, 'Move 2 objects');
  assert.equal(cmd.transform(cmd.snapshot([n[0]]), { rot: 1 }).label, 'Rotate 1 NPC');
  assert.equal(cmd.transform(cmd.snapshot([o[0], n[0], map.start]), { scale: 2 }).label, 'Scale 3 items');
  assert.equal(cmd.transform(cmd.snapshot([map.start]), { dx: 1 }).label, 'Move the start point');
  assert.equal(cmd.transform(snap, { dx: 1, rot: 1 }).label, 'Transform 2 objects');
  assert.ok(cmd.transform(snap, {}).bytes >= 64 * 2, 'about 64 bytes per item');

  for (const t of [{ dx: NaN }, { dz: Infinity }, { dy: '1' }, { rot: null }, { scale: undefined + 1 }, { pivot: { x: 0 } }, { pivot: 5 }]) {
    assert.throws(() => cmd.transform(snap, t), TypeError, JSON.stringify(t));
  }
  assert.throws(() => cmd.transform(null, {}), TypeError);
  assert.throws(() => cmd.transform([o[0]], { dx: 1 }), TypeError, 'items are not a snapshot');
  assert.throws(() => cmd.transform(snap, null), TypeError);
});

test('unchanged(map): transform and set can tell that they ended where they started', () => {
  const { map, o, s, c, r } = world();
  const before = text(map);

  // a drag of every kind that turns, grows and comes home: merged transforms of one snapshot
  const items = [o[2], o[3], s[1], c[1], r[1], r[2], map.start], shapes = [r[1].shape, r[2].shape];
  const snap = cmd.snapshot(items), drag = cmd.transform(snap, { dx: 3, dz: -2, dy: 1, rot: 0.5, scale: 1.5 });
  assert.equal(drag.unchanged(map), true, 'a command that never ran has changed nothing');
  drag.do(map);
  assert.equal(drag.unchanged(map), false);
  for (const t of [{ dx: 1 }, { dy: 0.01 }, { rot: 0.01 }, { scale: 1.01 }]) {
    const next = cmd.transform(snap, t);
    assert.equal(drag.merge(next), true);
    next.do(map);
    assert.equal(drag.unchanged(map), false, JSON.stringify(t));
  }
  const home = cmd.transform(snap, { dx: 0.004 });      // back on the snapshot values once quantised
  drag.merge(home);
  home.do(map);
  assert.equal(drag.unchanged(map), true);
  assert.equal(text(map), before);
  assert.notEqual(r[2].shape, shapes[1], 'a region holds an equal shape, not the old object: compared by value');
  drag.undo(map);
  assert.deepEqual([r[1].shape, r[2].shape], shapes);
  assert.equal(r[1].shape, shapes[0], 'undo hands the old shape objects back all the same');

  // one changed number of one kind is a change: x, z, y, ry, s of an object; ry of a chest; r of a spawn; a region's point
  for (const [item, t] of [[o[0], { dx: 1 }], [o[0], { dz: 1 }], [o[0], { dy: 1 }], [o[0], { rot: 1, individual: true }], [o[0], { scale: 2, individual: true }],
    [c[0], { rot: 1, individual: true }], [s[0], { scale: 2, individual: true }], [r[2], { dx: 1 }], [map.start, { scale: 2, individual: true }]]) {
    const one = cmd.transform(cmd.snapshot([item]), t);
    one.do(map);
    assert.equal(one.unchanged(map), false, JSON.stringify(t));
    one.undo(map);
    assert.equal(one.unchanged(map), true);
  }
  assert.equal(text(map), before);

  // a field that is scrubbed and put back: merged sets of the same keys on the same items
  const scrub = cmd.set([o[0], o[1]], { s: 1.2 });
  assert.equal(scrub.unchanged(map), true, 'never ran');
  scrub.do(map);
  assert.equal(scrub.unchanged(map), false);
  const back = cmd.set([o[0], o[1]], { s: 1 });
  assert.equal(scrub.merge(back), true);
  back.do(map);
  assert.equal(scrub.unchanged(map), true);
  const half = cmd.setEach([o[0], o[1]], [{ s: 1 }, { s: 3 }]);
  scrub.merge(half);
  half.do(map);
  assert.equal(scrub.unchanged(map), false, 'one item of two differs');
  scrub.undo(map);

  // object values count by value: a rim dragged out and home, a level range typed and restored
  const rim = cmd.set([r[1]], { shape: { type: 'circle', x: 0, z: 0, r: 44 } });
  rim.do(map);
  const rimHome = cmd.set([r[1]], { shape: { type: 'circle', x: 0, z: 0, r: 30 } });
  rim.merge(rimHome);
  rimHome.do(map);
  assert.equal(rim.unchanged(map), true);
  const lvl = cmd.set([s[1]], { lvl: [3, 6] });
  lvl.do(map);
  assert.equal(lvl.unchanged(map), false);
  lvl.undo(map);
  rim.undo(map);

  // the start point of another map was never written: it cannot have changed
  const other = emptyMap(), foreign = cmd.set([other.start, o[0]], { x: 77 });
  foreign.do(map);
  assert.equal(foreign.unchanged(map), false);
  foreign.undo(map);
  assert.equal(foreign.unchanged(map), true);
  const far = cmd.transform(cmd.snapshot([other.start]), { dx: 5 });
  far.do(map);
  assert.equal(far.unchanged(map), true);
  assert.equal(text(map), before);

  // the commands that add, remove or paint never claim it: the store keeps their steps
  for (const command of [cmd.add('object', []), cmd.remove([o[0]]), cmd.paint([0], GROUND_INDEX.dirt), cmd.setProps({ name: 'x' }), cmd.reorder('region', r[0], 1), cmd.batch('b', [])]) {
    assert.equal(typeof command.unchanged, 'undefined', command.label);
  }
});

// ---------------------------------------------------------------- reorder

test('reorder moves a region to an index: later regions win', () => {
  const { map, store, r } = world();
  const before = text(map);
  assert.equal(regionAt(map, 0, 0), r[1], 'the town is listed after the wilds');
  const change = store.exec(cmd.reorder('region', r[1], 0));
  assert.deepEqual(map.regions, [r[1], r[0], r[2]]);
  assert.equal(regionAt(map, 0, 0), r[0]);
  assert.deepEqual(change.order, ['regions']);
  assert.deepEqual(change.updated.regions, []);
  assert.equal(store.undoLabel, 'Reorder regions');
  store.exec(cmd.reorder('region', r[1], 2));
  assert.deepEqual(map.regions, [r[0], r[2], r[1]]);
  store.exec(cmd.reorder('region', r[0], 99));
  assert.deepEqual(map.regions, [r[2], r[1], r[0]], 'the index is clamped');
  store.exec(cmd.reorder('region', r[0], -5));
  assert.deepEqual(map.regions, [r[0], r[2], r[1]]);
  assert.ok(isEmptyChange(store.exec(cmd.reorder('region', r[0], 0))), 'already there');
  assert.ok(isEmptyChange(store.exec(cmd.reorder('region', cmd.clone(r[0]), 1))), 'not in the map');
  for (let i = 0; i < 4; i++) store.undo();
  assert.deepEqual(map.regions, r);
  assert.equal(text(map), before);
  for (let i = 0; i < 4; i++) store.redo();
  assert.deepEqual(map.regions, [r[0], r[2], r[1]]);
  assert.throws(() => cmd.reorder('start', map.start, 0), TypeError);
  assert.throws(() => cmd.reorder('region', map.objects[0], 0), TypeError);
  assert.throws(() => cmd.reorder('region', r[0], 0.5), TypeError);
});

// ---------------------------------------------------------------- paint

test('paint: only cells of another type change; Change.ground is their inclusive rectangle', () => {
  const { map, store } = world();
  const before = text(map), g = map.ground, size = g.size, at = (x, z) => cellIndex(g, x, z);
  const { ix, iz } = cellXZ(g, at(10, 20));
  const cells = [at(10, 20), at(12, 20), at(14, 22), at(10, 20)];
  const change = store.exec(cmd.paint(cells, GROUND_INDEX.dirt));
  assert.deepEqual(change.ground, { ix0: ix, iz0: iz, ix1: ix + 2, iz1: iz + 1 });
  assert.equal(groundAt(map, 10, 20).id, 'dirt');
  assert.equal(groundAt(map, 14, 22).id, 'dirt');
  assert.equal(groundAt(map, 14, 20).id, 'grass');
  assert.equal(store.undoLabel, 'Paint');

  // a second stroke over them: only the new cell is reported
  const more = store.exec(cmd.paint(Int32Array.from([at(10, 20), at(16, 20)]), GROUND_INDEX.dirt));
  assert.deepEqual(more.ground, { ix0: ix + 3, iz0: iz, ix1: ix + 3, iz1: iz });
  assert.ok(isEmptyChange(store.exec(cmd.paint(cells, GROUND_INDEX.dirt))), 'cells already of that type are skipped');
  // indices off the grid are ignored (cellIndex gives -1 outside)
  const edge = store.exec(cmd.paint([-1, size * size, size * size + 5, 0], GROUND_INDEX.water));
  assert.deepEqual(edge.ground, { ix0: 0, iz0: 0, ix1: 0, iz1: 0 });
  assert.equal(g.cells[0], GROUND_INDEX.water);

  const undone = [];
  store.on('change', (c) => undone.push(c.ground));
  for (let i = 0; i < 3; i++) store.undo();
  assert.deepEqual(undone, [{ ix0: 0, iz0: 0, ix1: 0, iz1: 0 }, { ix0: ix + 3, iz0: iz, ix1: ix + 3, iz1: iz }, { ix0: ix, iz0: iz, ix1: ix + 2, iz1: iz + 1 }]);
  assert.equal(text(map), before);

  assert.throws(() => cmd.paint([0], GROUND_TYPES.length), TypeError, 'a cell of no known type could never be saved');
  assert.throws(() => cmd.paint([0], -1), TypeError);
  assert.throws(() => cmd.paint([0], 1.5), TypeError);
  assert.throws(() => cmd.paint(null, 0), TypeError);
});

test('paint: the brush may reuse its buffer; a merged stroke keeps the first `before` and the latest type', () => {
  const { map, store } = world();
  const before = text(map), g = map.ground, a = cellIndex(g, 0, 40), b = a + 1, c = a + 2;
  const buffer = new Int32Array([a, b]);
  const first = cmd.paint(buffer, GROUND_INDEX.dirt);
  buffer.fill(c);                                   // the brush moves on before the command runs
  store.begin('Paint');
  store.exec(first);
  assert.deepEqual([g.cells[a], g.cells[b], g.cells[c]], [GROUND_INDEX.dirt, GROUND_INDEX.dirt, GROUND_INDEX.grass]);
  store.exec(cmd.paint([b, c], GROUND_INDEX.sand));           // b changes type a second time
  store.exec(cmd.paint([c], GROUND_INDEX.stone));
  store.exec(cmd.paint([a, b, c], GROUND_INDEX.stone));       // a: dirt -> stone, b: sand -> stone, c: nothing
  store.commit();
  const done = raw(map);
  assert.deepEqual([g.cells[a], g.cells[b], g.cells[c]], [GROUND_INDEX.stone, GROUND_INDEX.stone, GROUND_INDEX.stone]);

  let changes = 0;
  const off = store.on('change', () => changes++);
  store.undo();
  off();
  assert.equal(changes, 1, 'four paints, one command');
  assert.equal(text(map), before, 'every cell is back at what it was before the stroke');
  store.redo();
  assert.equal(raw(map), done);
  store.undo();
  assert.equal(text(map), before);

  const one = cmd.paint([a], 1), two = cmd.paint([b], 2);
  one.do(map);
  assert.equal(one.merge(two), true);
  two.do(map);
  assert.ok(one.bytes >= 5 * 2, 'about 5 bytes per painted cell');
  assert.equal(one.merge(cmd.setProps({ name: 'x' })), false);
  one.undo(map);
  assert.equal(text(map), before);
});

// ---------------------------------------------------------------- heights

test('heights: written on the 0.1 grid and inside LIMITS.height; Change.ground is the rectangle that moved, marked as relief', () => {
  const { map, store } = world();
  const before = text(map), g = map.ground, at = (x, z) => cellIndex(g, x, z);
  const { ix, iz } = cellXZ(g, at(10, 20));
  const a = at(10, 20), b = at(12, 20), c = at(14, 22);
  const change = store.exec(cmd.heights([a, b, c, a], [1.234, 100, -700, 1.26]));
  assert.deepEqual(change.ground, { ix0: ix, iz0: iz, ix1: ix + 2, iz1: iz + 1, relief: true });
  assert.equal(g.heights[a], Math.fround(1.3), 'on the 0.1 grid; of an index given twice the later value wins');
  assert.equal(g.heights[b], LIMITS.height[1], 'clamped to the highest ground a map can have');
  assert.equal(g.heights[c], LIMITS.height[0], 'and to the lowest');
  assert.equal(store.undoLabel, 'Sculpt');
  assert.deepEqual(errors(map), []);
  assert.notEqual(raw(map), before);
  assert.ok(serialize(map).ground.heights, 'a hilly ground is written to the file');

  // a height that is there already changes nothing, and neither does an index off the grid
  assert.ok(isEmptyChange(store.exec(cmd.heights([a, b], [1.3, 60]))));
  assert.ok(isEmptyChange(store.exec(cmd.heights([-1, g.size * g.size], 5))));
  assert.equal(store.undoLabel, 'Sculpt');
  // one number for every index, and a label of its own
  const flat = store.exec(cmd.heights(Int32Array.from([a, b, c]), 3, 'Flatten'));
  assert.deepEqual(flat.ground, { ix0: ix, iz0: iz, ix1: ix + 2, iz1: iz + 1, relief: true });
  assert.deepEqual([g.heights[a], g.heights[b], g.heights[c]], [3, 3, 3]);
  assert.equal(store.undoLabel, 'Flatten');

  store.undo();
  assert.deepEqual([g.heights[a], g.heights[b], g.heights[c]], [Math.fround(1.3), 60, LIMITS.height[0]]);
  store.undo();
  assert.equal(text(map), before, 'byte-identical after undo');
  assert.equal(serialize(map).ground.heights, undefined, 'a flat ground carries no heights in the file');
  store.redo();
  store.redo();
  assert.deepEqual([g.heights[a], g.heights[b], g.heights[c]], [3, 3, 3]);
  while (store.undo() !== null);
  assert.equal(text(map), before);

  assert.throws(() => cmd.heights(null, 1), TypeError);
  assert.throws(() => cmd.heights([0, 1], [1]), TypeError, 'one height per index');
  assert.throws(() => cmd.heights([0], [NaN]), TypeError, 'a height with no file form');
  assert.throws(() => cmd.heights([0], Infinity), TypeError);
});

test('heights: a stroke inside a group is ONE undo step that keeps the first `before` of every vertex', () => {
  const { map, store } = world();
  const before = text(map), g = map.ground, a = cellIndex(g, 0, 40), b = a + 1, c = a + 2;
  const buffer = new Int32Array([a, b]), values = new Float32Array([0.5, 0.5]);
  const first = cmd.heights(buffer, values);
  buffer.fill(c);                                   // the brush moves on before the command runs
  values.fill(9);
  store.begin('Raise');
  store.exec(first);
  assert.deepEqual([g.heights[a], g.heights[b], g.heights[c]], [0.5, 0.5, 0]);
  // sixty frames of a held brush: the same vertices, a little higher each time
  for (let f = 1; f <= 60; f++) store.exec(cmd.heights([a, b, c], [0.5 + f * 0.1, 0.5 + f * 0.05, f * 0.1]));
  assert.equal(store.commit(), true);
  const done = raw(map);
  assert.deepEqual([g.heights[a], g.heights[b], g.heights[c]], [6.5, 3.5, 6]);
  assert.equal(store.undoLabel, 'Raise');

  let changes = 0;
  const off = store.on('change', () => changes++);
  assert.equal(store.undo(), 'Raise');
  off();
  assert.equal(changes, 1, 'sixty-one commands, one step');
  assert.equal(text(map), before, 'every vertex is back at the height it had before the stroke');
  assert.equal(store.canUndo, false);
  store.redo();
  assert.equal(raw(map), done);
  store.undo();
  assert.equal(text(map), before);

  const one = cmd.heights([a], 1), two = cmd.heights([a, b], 2);
  one.do(map);
  assert.equal(one.merge(two), true);
  two.do(map);
  assert.ok(one.bytes < 64 + 100, 'a vertex is recorded once, however often the stroke writes it');
  assert.equal(one.merge(cmd.paint([a], 1)), false);
  assert.equal(one.merge(cmd.setProps({ name: 'x' })), false);
  one.undo(map);
  assert.equal(text(map), before);
});

test('heights: a stroke that changes nothing leaves no step, and neither does one that ends where it began', () => {
  const { map, store } = world();
  const before = text(map), g = map.ground, a = cellIndex(g, 20, 20);
  store.begin('Smooth');
  for (let f = 0; f < 10; f++) assert.ok(isEmptyChange(store.exec(cmd.heights([a, a + 1], 0))), 'flat ground smoothed stays flat');
  assert.equal(store.commit(), false);
  assert.equal(store.canUndo, false);
  assert.equal(store.dirty, false);

  store.begin('Raise');
  store.exec(cmd.heights([a], 2));
  store.exec(cmd.heights([a], 0.04));               // 0.04 is 0 on the grid: back where it started
  assert.equal(g.heights[a], 0);
  assert.equal(store.commit(), false, 'up and down again: nothing to undo');
  assert.equal(store.canUndo, false);

  store.begin('Raise');
  store.exec(cmd.heights([a], 2));
  assert.equal(store.cancel(), true);
  assert.equal(text(map), before, 'Esc takes the stroke back');
  assert.equal(store.canUndo, false);
});

test('heights: whatever replaces the ground keeps the hills, and a ground without the array gets one for the stroke only', () => {
  const map = emptyMap(), store = createStore();
  store.load(map);
  const before = text(map), ground = map.ground, mid = cellIndex(ground, 0, 0), rim = cellIndex(ground, 200, 0);
  store.exec(cmd.heights([mid, rim], [12, 4]));
  assert.equal(heightOf(map, 0, 0), 12);
  // a larger island: the grid grows around the old one and the hills stay where they are
  assert.deepEqual(store.exec(cmd.setProps({ radius: 300 })).props, ['radius', 'ground']);
  assert.notEqual(map.ground, ground);
  assert.equal(map.ground.heights.length, map.ground.cells.length);
  assert.equal(heightOf(map, 0, 0), 12);
  assert.equal(heightOf(map, 200, 0), 4);
  store.exec(cmd.heights([cellIndex(map.ground, 290, 0)], 7));
  assert.equal(heightOf(map, 290, 0), 7);
  assert.deepEqual(errors(map), []);
  const again = normalize(JSON.parse(text(map)));
  assert.equal(heightOf(again, 290, 0), 7, 'the file brings the hills back');
  assert.equal(heightOf(again, 0, 0), 12);
  // a batch reports the union of its rectangles and still says that the relief moved
  const both = store.exec(cmd.batch('Paint and raise', [cmd.paint([0], GROUND_INDEX.snow), cmd.heights([5], 1)]));
  assert.deepEqual(both.ground, { ix0: 0, iz0: 0, ix1: 5, iz1: 0, relief: true });
  assert.equal(store.exec(cmd.paint([1], GROUND_INDEX.snow)).ground.relief, undefined, 'paint alone moves no ground');
  while (store.undo() !== null);
  assert.equal(map.ground, ground);
  assert.equal(text(map), before);

  // a runtime map of before the relief: no heights array at all
  const old = emptyMap();
  delete old.ground.heights;
  const st = createStore();
  st.load(old);
  const flat = text(old);
  st.exec(cmd.heights([cellIndex(old.ground, 10, 10)], 3));
  assert.equal(heightOf(old, 10, 10), 3);
  st.undo();
  assert.equal(old.ground.heights, undefined, 'undo leaves the ground as it was found');
  assert.equal(text(old), flat);
  st.redo();
  assert.equal(heightOf(old, 10, 10), 3);
});

// ---------------------------------------------------------------- setProps

test('setProps({ radius: 600 }) on emptyMap(): clamped to 492, the ground grows, validate has no error; undo restores radius 260 and the original ground object', () => {
  const map = emptyMap(), store = createStore();
  store.load(map);
  const before = text(map), ground = map.ground, cells = ground.cells, copy = cells.slice();
  assert.equal(map.radius, 260);
  assert.equal(ground.cell, 2);
  const change = store.exec(cmd.setProps({ radius: 600 }));
  assert.equal(map.radius, 492);
  assert.equal(map.radius, maxRadius(ground));
  assert.deepEqual(change.props, ['radius', 'ground']);
  assert.notEqual(map.ground, ground, 'a new ground object');
  assert.equal(map.ground.size, LIMITS.groundSize[1], 'never asked for more than 513 vertices');
  assert.ok(groundHalf(map.ground) >= map.radius + LIMITS.groundMargin);
  assert.deepEqual(errors(map), []);
  assert.equal(groundAt(map, 0, 0).id, 'grass', 'the old cells stay centred');
  assert.equal(groundAt(map, 300, 0).id, 'sand', 'new vertices take the nearest old edge value');
  assert.equal(store.undoLabel, 'Resize the map');

  store.undo();
  assert.equal(map.radius, 260);
  assert.equal(map.ground, ground);
  assert.equal(map.ground.cells, cells);
  assert.deepEqual(map.ground.cells, copy);
  assert.equal(text(map), before);
  const grown = (store.redo(), map.ground);
  assert.equal(map.radius, 492);
  store.undo();
  store.redo();
  assert.equal(map.ground, grown, 'redo brings the same grown ground back, with whatever was painted on it');
});

test('setProps: radius within, below and beyond the ground; other cell sizes', () => {
  const { map, store } = world();
  const ground = map.ground;
  assert.deepEqual(store.exec(cmd.setProps({ radius: 200 })).props, ['radius'], 'a smaller island keeps its ground');
  assert.equal(map.ground, ground);
  assert.deepEqual(store.exec(cmd.setProps({ radius: 260 })).props, ['radius']);
  assert.deepEqual(store.exec(cmd.setProps({ radius: 300 })).props, ['radius', 'ground']);
  assert.equal(map.ground.size, 321, 'the smallest odd size that reaches radius + 20');
  assert.equal(map.ground.cell, 2);
  // paint on the grown ground, then undo both: each step finds the ground it worked on
  store.exec(cmd.paint([0, 1, 2], GROUND_INDEX.snow));
  store.undo();
  store.undo();
  assert.equal(map.ground, ground);
  store.redo();
  store.redo();
  assert.equal(map.ground.cells[1], GROUND_INDEX.snow);
  while (store.undo() !== null);
  assert.equal(map.radius, 260);

  // cell 1: at most 236. cell 4: the grid could carry 1004, so nothing is clamped here - validate reports 'radius'
  for (const [cell, radius, expected] of [[1, 500, 236], [4, 500, 500], [4, 2000, 1004]]) {
    const small = emptyMap({ radius: 60 });
    small.ground = { cell, size: 161, cells: new Uint8Array(161 * 161) };
    const st = createStore();
    st.load(small);
    st.exec(cmd.setProps({ radius }));
    assert.equal(small.radius, expected, `cell ${cell}`);
    assert.ok(small.ground.size <= LIMITS.groundSize[1]);
    assert.ok(groundHalf(small.ground) >= small.radius + LIMITS.groundMargin);
    assert.equal(errors(small).includes('ground-size'), false);
    assert.equal(errors(small).includes('ground-cover'), false);
  }
});

test('setProps: name, foliage, fallback', () => {
  const { map, store } = world();
  const before = text(map), fallback = map.fallback;
  assert.deepEqual(store.exec(cmd.setProps({ name: 'Hypercat World', foliage: false })).props, ['name', 'foliage']);
  assert.deepEqual([map.name, map.foliage], ['Hypercat World', false]);
  assert.equal(store.undoLabel, 'Edit the map');
  assert.equal(cmd.setProps({ name: 'x' }).label, 'Rename the map');
  assert.equal(cmd.setProps({ foliage: true }).label, 'Toggle foliage');
  assert.equal(cmd.setProps({ fallback: { name: 'x' } }).label, 'Edit the fallback region');

  // the fallback is replaced, never written to; a partial patch keeps the rest
  const levels = [2, 9];
  assert.deepEqual(store.exec(cmd.setProps({ fallback: { mood: 'cursed', levels } })).props, ['fallback']);
  assert.deepEqual(map.fallback, { name: 'Open Sea', levels: [2, 9], mood: 'cursed' });
  assert.notEqual(map.fallback, fallback);
  assert.notEqual(map.fallback.levels, levels);
  assert.deepEqual(fallback, { name: 'Open Sea', levels: null, mood: 'meadow' });
  store.exec(cmd.setProps({ fallback: { name: 'The Deep', levels: null, mood: 'cursed' } }));
  assert.deepEqual(map.fallback, { name: 'The Deep', levels: null, mood: 'cursed' });
  store.exec(cmd.setProps({ fallback: { levels: [5, 5] } }));
  assert.deepEqual(map.fallback, { name: 'The Deep', levels: [5, 5], mood: 'cursed' }, 'a partial patch keeps the name and the mood');
  for (let i = 0; i < 4; i++) store.undo();
  assert.equal(map.fallback, fallback, 'undo hands back the very object');
  assert.equal(text(map), before);

  for (const patch of [{ start: { x: 1 } }, { version: 2 }, { name: 5 }, { radius: NaN }, { radius: '300' }, { foliage: 1 }, { fallback: 'sea' },
    { fallback: { mood: 'sunny' } }, { fallback: { mood: null } }, { fallback: { levels: [1] } }, { fallback: { safe: true } }]) {
    assert.throws(() => cmd.setProps(patch), TypeError, JSON.stringify(patch));
  }
  assert.throws(() => cmd.setProps(null), TypeError);
});

// ---------------------------------------------------------------- batch

test('batch: do in order, undo in reverse, one step, the Change is the union', () => {
  const { map, store, o, s } = world();
  const before = text(map);
  const fresh = cmd.make('object', { m: 'medieval/crate', x: 0, z: 70 }), gone = cmd.make('npc', { x: 9, z: 9 });
  const i = cellIndex(map.ground, 0, 80), size = map.ground.size;
  const command = cmd.batch('Build a camp', [
    cmd.add('object', [fresh]),
    cmd.set([fresh, o[0]], { s: 2 }),                 // fresh is new: it is reported as added, not also as updated
    cmd.add('npc', [gone]),
    cmd.remove([gone]),                               // added and removed again: in neither list
    cmd.remove([o[1]]),
    cmd.add('object', [o[1]], 1),                     // removed and put back: updated, and its list reordered
    cmd.remove([s[0]]),
    cmd.paint([i], GROUND_INDEX.dirt),
    cmd.paint([i + size + 2], GROUND_INDEX.dirt),
    cmd.setProps({ name: 'Camp' }),
    cmd.set([map.start], { r: 6 }),
    cmd.reorder('region', map.regions[0], 1),
  ]);
  assert.equal(command.label, 'Build a camp');
  assert.ok(command.bytes > 64 * 5);
  const change = store.exec(command);
  const { ix, iz } = cellXZ(map.ground, i);
  assert.deepEqual(change.added, { objects: [fresh], spawns: [], chests: [], npcs: [], regions: [] });
  assert.deepEqual(change.removed, { objects: [], spawns: [s[0]], chests: [], npcs: [], regions: [] });
  assert.deepEqual(change.updated, { objects: [o[0], o[1]], spawns: [], chests: [], npcs: [], regions: [], start: [map.start] });
  assert.deepEqual(change.order.sort(), ['objects', 'regions']);
  assert.deepEqual(change.ground, { ix0: ix, iz0: iz, ix1: ix + 2, iz1: iz + 1 });
  assert.deepEqual(change.props, ['name']);
  assert.equal(store.undoLabel, 'Build a camp');
  assert.equal(store.kindOf(gone), null);
  assert.equal(store.kindOf(o[1]), 'object');
  const done = raw(map);
  store.undo();
  assert.equal(text(map), before);
  assert.equal(store.canUndo, false, 'one step');
  store.redo();
  assert.equal(raw(map), done);
  store.undo();

  // a ground rectangle from before a resize says nothing about the new grid
  const resize = store.exec(cmd.batch('Paint and grow', [cmd.paint([i], GROUND_INDEX.dirt), cmd.setProps({ radius: 300 }), cmd.paint([5], GROUND_INDEX.snow)]));
  assert.deepEqual(resize.props, ['radius', 'ground']);
  assert.deepEqual(resize.ground, { ix0: 5, iz0: 0, ix1: 5, iz1: 0 });
  store.undo();
  assert.equal(text(map), before);
});

test('batch is all or nothing: a command that throws undoes the ones before it', () => {
  const { map, store, o } = world();
  const before = text(map), id = identity(map);
  const broken = { label: 'Broken', bytes: 0, do() { throw new Error('half-written command'); }, undo() {} };
  const command = cmd.batch('Risky', [cmd.set([o[0]], { x: 99 }), cmd.remove([o[1], o[2]]), cmd.paint([0, 1], GROUND_INDEX.lava), broken, cmd.setProps({ name: 'never' })]);
  assert.throws(() => store.exec(command), /half-written command/);
  assert.equal(text(map), before);
  assertIdentity(map, id);
  assert.equal(store.canUndo, false);
  assert.throws(() => cmd.batch('Bad', [{ label: 'no methods' }]), TypeError);
  // batches nest
  store.exec(cmd.batch('Outer', [cmd.batch('Inner', [cmd.set([o[0]], { x: 1 })]), cmd.set([o[0]], { z: 1 })]));
  assert.deepEqual([o[0].x, o[0].z], [1, 1]);
  store.undo();
  assert.equal(text(map), before);
});

// ---------------------------------------------------------------- limits (§3.11): commands write, validate judges

test('commands do not range-check: what breaks a limit shows up in validate, and undo clears it', () => {
  const { map, store, o, s, c, n, r } = world();
  const before = text(map);
  const cases = [
    ['object-scale', () => cmd.set([o[0]], { s: 20.5 })],
    ['object-scale', () => cmd.set([o[0]], { sy: 0.01 })],
    ['object-pos', () => cmd.set([o[0]], { y: 101 })],
    ['object-pos', () => cmd.set([o[0]], { x: groundHalf(map.ground) + 1 })],
    ['col', () => cmd.set([o[0]], { col: 4.5 })],
    ['col', () => cmd.set([o[0]], { col: Array.from({ length: 9 }, () => ({ x: 0, z: 0, r: 1 })) })],
    ['enum', () => cmd.set([o[0]], { g: 'a b' })],
    ['enum', () => cmd.set([o[0]], { m: 'nopack/thing' })],
    ['spawn-count', () => cmd.set([s[0]], { count: 31 })],
    ['spawn-count', () => cmd.set([s[0]], { count: 2.5 })],
    ['spawn-r', () => cmd.set([s[0]], { r: 80.5 })],
    ['spawn-respawn', () => cmd.set([s[0]], { respawn: 2 })],
    ['spawn-lvl', () => cmd.set([s[0]], { lvl: [5, 2] })],
    ['spawn-lvl', () => cmd.set([s[0]], { lvl: [1, 100] })],
    ['spawn-types', () => cmd.set([s[0]], { types: {} })],
    ['spawn-types', () => cmd.set([s[0]], { types: { chaser: 101 } })],
    ['spawn-pos', () => cmd.set([s[0]], { x: 255 })],
    ['spawn-in-safe', () => cmd.transform(cmd.snapshot([s[0]]), { dx: -95 })],
    ['chest-gold', () => cmd.set([c[0]], { gold: 0 })],
    ['chest-respawn', () => cmd.set([c[0]], { respawn: 86401 })],
    ['chest-pos', () => cmd.set([c[0]], { x: 260 })],
    ['npc-pos', () => cmd.transform(cmd.snapshot([n[0]]), { dz: 300 })],
    ['region-circle', () => cmd.set([r[1]], { shape: { type: 'circle', x: 0, z: 0, r: 0.5 } })],
    ['region-poly', () => cmd.set([r[2]], { shape: { type: 'poly', points: [[0, 0], [1, 0]] } })],
    ['region-poly', () => cmd.set([r[2]], { shape: { type: 'poly', points: Array.from({ length: 65 }, (_, i) => [Math.cos(i) * 50, Math.sin(i) * 50]) } })],
    ['region-levels', () => cmd.set([r[0]], { levels: [0, 5] })],
    ['string', () => cmd.set([r[0]], { name: '' })],
    ['string', () => cmd.set([r[0]], { name: 'Lake ' })],
    ['enum', () => cmd.set([r[0]], { color: '#ABCDEF' })],
    ['start', () => cmd.set([map.start], { r: 41 })],
    ['start-blocked', () => cmd.paint([cellIndex(map.ground, 0, 0)], GROUND_INDEX.water)],
    ['string', () => cmd.setProps({ name: '' })],
    ['string', () => cmd.setProps({ fallback: { name: ' Sea' } })],
    ['radius', () => cmd.setProps({ radius: 39 })],
    ['radius', () => cmd.setProps({ radius: 300.5 })],
    ['too-many', () => cmd.add('npc', Array.from({ length: 39 }, () => cmd.make('npc', { x: 0, z: 0 })))],
    ['too-many', () => cmd.add('chest', Array.from({ length: 199 }, () => cmd.make('chest', { x: 40, z: 40 })))],
    ['too-many', () => cmd.add('region', Array.from({ length: 62 }, () => cmd.make('region')))],
    ['too-many', () => cmd.add('spawn', Array.from({ length: 298 }, () => cmd.make('spawn', { x: 100, z: 100, count: 1 })))],
    ['spawn-total', () => cmd.add('spawn', Array.from({ length: 50 }, () => cmd.make('spawn', { x: 100, z: 100, count: 30 })))],
  ];
  assert.deepEqual(errors(map), []);
  for (const [code, build] of cases) {
    store.exec(build());
    const found = errors(map);
    assert.ok(found.includes(code), `${code}: validate reports ${found.join(', ') || 'nothing'}`);
    // such a map cannot be saved, but it is still a map: its draft decodes again into the very same map, errors and all
    const draft = raw(map);
    assert.equal(raw(normalize(JSON.parse(draft), { check: false })), draft, `${code}: the draft`);
    store.undo();
    assert.equal(store.canUndo, false);
  }
  assert.equal(text(map), before);
  // 40 NPCs are fine, the 41st is not (the collection caps)
  store.exec(cmd.add('npc', Array.from({ length: 38 }, () => cmd.make('npc', { x: 0, z: 0 }))));
  assert.equal(map.npcs.length, LIMITS.npcs);
  assert.deepEqual(errors(map), []);
});

// ---------------------------------------------------------------- the field schema

test('FIELDS: the kinds, keys, types and limits of the inspector', () => {
  const shape = (kind) => FIELDS[kind].map((f) => `${f.key ?? '-'}:${f.type}`).join(' ');
  assert.deepEqual(Object.keys(FIELDS), ['object', 'spawn', 'chest', 'npc', 'region', 'start', 'map']);
  assert.equal(shape('object'), 'm:model x:number y:number z:number ry:angle rx:angle rz:angle s:number sy:number col:collider g:group');
  assert.equal(shape('spawn'), 'types:weights lvl:intRange x:number z:number r:number count:int respawn:int -:computed g:group');
  assert.equal(shape('chest'), 'x:number z:number ry:angle gold:int big:bool respawn:int g:group');
  assert.equal(shape('npc'), 'kind:select x:number z:number ry:angle g:group');
  assert.equal(shape('region'), 'name:text levels:intRangeOrNull -:action mood:select safe:bool color:color');
  assert.equal(shape('start'), 'x:number z:number r:number');
  assert.equal(shape('map'), 'name:text radius:int foliage:bool');

  const TYPES = ['number', 'int', 'angle', 'text', 'bool', 'select', 'color', 'model', 'collider', 'group', 'weights', 'intRange', 'intRangeOrNull', 'computed', 'action'];
  const field = (kind, key) => FIELDS[kind].find((f) => f.key === key);
  for (const kind of Object.keys(FIELDS)) {
    for (const f of FIELDS[kind]) {
      assert.ok(TYPES.includes(f.type), `${kind}.${f.key}: ${f.type}`);
      assert.equal(typeof f.label, 'string');
      assert.ok(f.label.length > 0);
      assert.ok(Object.isFrozen(f));
    }
    assert.ok(Object.isFrozen(FIELDS[kind]));
  }
  assert.ok(Object.isFrozen(FIELDS));

  // `label` defaults to the capitalised key
  assert.equal(field('object', 'x').label, 'X');
  assert.equal(field('spawn', 'count').label, 'Count');
  assert.equal(field('object', 'm').label, 'Model');
  assert.equal(field('object', 'sy').label, 'Height ×');
  assert.equal(field('spawn', 'respawn').label, 'Respawn (s)');
  assert.equal(field('region', 'mood').label, 'Mood');

  // the numbers of the limits table (§3.11), taken from LIMITS
  const range = (kind, key) => [field(kind, key).min, field(kind, key).max];
  assert.deepEqual(range('object', 'y'), [-20, 100]);
  assert.deepEqual(range('object', 's'), [0.05, 20]);
  assert.deepEqual(range('object', 'sy'), [0.05, 20]);
  assert.deepEqual(range('spawn', 'lvl'), [1, 99]);
  assert.deepEqual(range('spawn', 'r'), [0, 80]);
  assert.deepEqual(range('spawn', 'count'), [1, 30]);
  assert.deepEqual(range('spawn', 'respawn'), [3, 3600]);
  assert.deepEqual(range('chest', 'gold'), [1, 100000]);
  assert.deepEqual(range('chest', 'respawn'), [10, 86400]);
  assert.deepEqual(range('region', 'levels'), [1, 99]);
  assert.deepEqual(range('start', 'r'), [0, 40]);
  assert.deepEqual([field('region', 'name').minLength, field('region', 'name').maxLength], [1, 48]);
  assert.deepEqual([field('map', 'name').minLength, field('map', 'name').maxLength], [1, 64]);
  assert.equal(field('map', 'radius').min, 40);
  assert.equal(field('map', 'radius').max(emptyMap()), 492, 'a function of the map: what a cell-2 ground can cover');
  assert.equal(field('map', 'radius').max({ ground: { cell: 1 } }), 236);
  assert.equal(field('map', 'radius').max({ ground: { cell: 4 } }), 600);
  assert.deepEqual([field('object', 's').step, field('object', 's').digits, field('object', 'x').step, field('spawn', 'r').step], [0.05, 3, 0.1, 0.5]);

  assert.deepEqual(field('spawn', 'types').options, MOB_KEYS);
  assert.equal(field('spawn', 'types').patch, typesPatch);
  assert.deepEqual(field('npc', 'kind').options, NPC_KINDS);
  assert.deepEqual(field('region', 'mood').options, [null, ...Object.keys(MOODS)]);
  assert.equal(FIELDS.region.find((f) => f.type === 'action').action, 'region.levelsFromSpawns');
  assert.equal(FIELDS.region.find((f) => f.type === 'action').label, 'Set from spawns');
  assert.notEqual(field('spawn', 'types').options, MOB_KEYS, 'a copy: freezing the schema must not freeze the game tables');
  assert.equal(Object.isFrozen(MOB_KEYS), false);
  assert.equal(Object.isFrozen(NPC_KINDS), false);

  // groups: the pattern validate() applies
  assert.equal(field('object', 'g').pattern, GROUP_PATTERN);
  assert.equal(field('object', 'g').maxLength, 32);
  const map = emptyMap(), obj = cmd.make('object', { m: 'medieval/barrel' });
  map.objects.push(obj);
  for (const g of ['a', 'town-wall', 'plot-01', 'g12', 'A.b_c-d', 'x'.repeat(32), 'a b', '', '-a', '.a', 'ä', 'x'.repeat(33), 'a/b']) {
    obj.g = g;                                      // (test set-up)
    assert.equal(GROUP_PATTERN.test(g), !errors(map).includes('enum'), `"${g}"`);
  }
});

test('every field of the schema is a field the commands can write', () => {
  const { map, store } = world();
  const before = text(map);
  const sample = {
    model: 'medieval/crate', number: 1.5, int: 20, angle: 0.5, text: 'Name', bool: true, color: '#aabbcc', collider: 'box', group: 'grp',
    weights: { tank: 2 }, intRange: [2, 4], intRangeOrNull: [2, 4],
  };
  for (const kind of ['object', 'spawn', 'chest', 'npc', 'region', 'start']) {
    const item = store.items(kind)[0];
    for (const f of FIELDS[kind]) {
      if (!f.key) continue;
      assert.ok(f.key in item, `${kind}.${f.key} is not a key of the runtime form`);
      const value = f.type === 'select' ? f.options.filter((v) => v !== item[f.key]).at(-1) : sample[f.type];
      const command = f.patch ? cmd.setEach([item], [f.patch(item, value)]) : cmd.set([item], { [f.key]: value });
      const change = store.exec(command);
      assert.ok(!isEmptyChange(change), `${kind}.${f.key} was not written`);
      assert.deepEqual(item[f.key], f.type === 'angle' ? qAngle(value) : value);
      store.undo();
    }
  }
  for (const f of FIELDS.map) {
    assert.ok(f.key in map);
    const value = { text: 'Other', int: 200, bool: !map.foliage }[f.type];
    assert.deepEqual(store.exec(cmd.setProps({ [f.key]: value })).props, [f.key]);
    store.undo();
  }
  assert.equal(text(map), before);
});

test('withEnd: one end of a level pair typed for several items - the other end of each stays its own', () => {
  const pair = [5, 9];
  assert.deepEqual(withEnd(pair, 0, 2), [2, 9]);
  assert.deepEqual(withEnd(pair, 1, 12), [5, 12]);
  assert.deepEqual(pair, [5, 9], 'the pair of the item is not changed');
  assert.deepEqual(withEnd([5, 9], 0, 11), [11, 11], 'an end typed past the other takes it along');
  assert.deepEqual(withEnd([5, 9], 1, 3), [3, 3]);
  assert.deepEqual(withEnd(null, 1, 4), [4, 4], 'an item without a pair gets the value at both ends');
  assert.deepEqual(withEnd(undefined, 0, 4), [4, 4]);

  // what the Regions panel and the inspector build from it: 2 typed into the low end of two regions is ONE step that
  // leaves the high ends 4 and 9 alone
  const { store, map } = world();
  const meadows = cmd.make('region', { name: 'Meadows', levels: [1, 4], shape: { type: 'circle', x: 0, z: 0, r: 40 } });
  const wastes = cmd.make('region', { name: 'Wastes', levels: [5, 9], shape: { type: 'circle', x: 0, z: 0, r: 80 } });
  const plain = cmd.make('region', { name: 'Plain', shape: { type: 'circle', x: 0, z: 0, r: 20 } });
  store.exec(cmd.add('region', [wastes, meadows, plain]));
  const items = [meadows, wastes];
  store.exec(cmd.setEach(items, items.map((r) => ({ levels: withEnd(r.levels, 0, 2) }))));
  assert.deepEqual([meadows.levels, wastes.levels, plain.levels], [[2, 4], [2, 9], null]);
  store.exec(cmd.setEach(items, items.map((r) => ({ levels: withEnd(r.levels, 1, 3) }))));
  assert.deepEqual([meadows.levels, wastes.levels], [[2, 3], [2, 3]]);
  store.undo();
  store.undo();
  assert.deepEqual([meadows.levels, wastes.levels], [[1, 4], [5, 9]]);
  assert.ok(map.regions.includes(plain));
});

test('typesPatch: the boss respawn rule', () => {
  const camp = { types: { chaser: 3, runner: 2 }, respawn: 14 }, boss = { types: { boss: 1 }, respawn: 90 };
  const frozen = (o) => Object.freeze({ ...o, types: Object.freeze({ ...o.types }) });
  assert.deepEqual(typesPatch(frozen(camp), Object.freeze({ boss: 1 })), { types: { boss: 1 }, respawn: 90 }, 'a camp that becomes the boss alone');
  assert.deepEqual(typesPatch(camp, { boss: 1, tank: 2 }), { types: { boss: 1, tank: 2 } }, 'the boss with company keeps the time');
  assert.deepEqual(typesPatch({ ...camp, respawn: 30 }, { boss: 1 }), { types: { boss: 1 } }, 'a time somebody chose is kept');
  assert.deepEqual(typesPatch(frozen(boss), { chaser: 1 }), { types: { chaser: 1 }, respawn: 14 }, 'a boss spawn that loses its boss');
  assert.deepEqual(typesPatch({ ...boss, respawn: 120 }, { chaser: 1 }), { types: { chaser: 1 } });
  assert.deepEqual(typesPatch(boss, { boss: 2 }), { types: { boss: 2 } }, 'still the boss: nothing to do');
  assert.deepEqual(typesPatch({ types: { boss: 1, tank: 1 }, respawn: 90 }, { tank: 1 }), { types: { tank: 1 }, respawn: 14 });
  assert.deepEqual(typesPatch(camp, { chaser: 5 }), { types: { chaser: 5 } });
  // a weight of 0 means absent
  assert.deepEqual(typesPatch(camp, { chaser: 0, runner: 0, shooter: 0, tank: 0, boss: 1 }), { types: { boss: 1 }, respawn: 90 });
  assert.deepEqual(typesPatch(boss, { boss: 0, chaser: 4 }), { types: { chaser: 4 }, respawn: 14 });
  const given = { boss: 1 };
  assert.notEqual(typesPatch(camp, given).types, given, 'the result is its own object');
  assert.deepEqual(camp, { types: { chaser: 3, runner: 2 }, respawn: 14 }, 'the spawn is not changed');
});

test('the spawn Stats field: HP, P.Atk and XP at the lowest and the highest level', () => {
  const stats = FIELDS.spawn.find((f) => f.type === 'computed');
  assert.equal(stats.label, 'Stats');
  assert.equal(stats.text(cmd.make('spawn')), 'Skeleton Minion: HP 30 · P.Atk 14 · XP 10');
  assert.equal(stats.text(cmd.make('spawn', { types: { runner: 1, chaser: 3 }, lvl: [1, 2] })),
    'Skeleton Minion: HP 30–44 · P.Atk 14–16 · XP 10–20\nSkeleton Rogue: HP 15–22 · P.Atk 8–9 · XP 8–16');
  assert.equal(stats.text(cmd.make('spawn', { types: { boss: 1 }, lvl: [18, 18] })), 'Skeleton King: HP 13,840 · P.Atk 71 · XP 10,800');
  assert.equal(stats.text(cmd.make('spawn', { types: {} })), '—');
  assert.equal(stats.text(cmd.make('spawn', { lvl: [5, 2] })), '—', 'levels that validate rejects show nothing, and nothing throws');
  assert.equal(stats.text(cmd.make('spawn', { lvl: [1.5, 2] })), '—');
});

// ---------------------------------------------------------------- undo is byte-identical: every constructor, two maps

// Each case builds ONE edit from items of the map it is given: w = { map, store, objects, spawns, chests, npcs, regions,
// poly } - at least 4 objects and 2 of every other kind, regions[0] a circle, poly a polygon region.
// `run(w)` executes it through the store (one exec, or one group).
const exec = (build) => (w) => w.store.exec(build(w));
const crate = (x, z) => cmd.make('object', { m: 'medieval/crate', x, z, ry: 0.3, s: 1.2 });
const CASES = [
  ['add objects at the end', exec(() => cmd.add('object', [crate(1, 1), crate(2, 2)]))],
  ['add objects at one index', exec(() => cmd.add('object', [crate(1, 1), crate(2, 2), crate(3, 3)], 1))],
  ['add objects at ascending indices', exec((w) => cmd.add('object', [crate(1, 1), crate(2, 2), crate(3, 3)], [0, 2, w.map.objects.length + 2]))],
  ['add a spawn', exec(() => cmd.add('spawn', [cmd.make('spawn', { x: 120, z: 120, g: 'new' })]))],
  ['add a chest at the front', exec(() => cmd.add('chest', [cmd.make('chest', { x: 44, z: 44, big: true })], 0))],
  ['add an NPC', exec(() => cmd.add('npc', [cmd.make('npc', { kind: 'trader', x: 3, z: -3, ry: 1 })]))],
  ['add regions in the middle', exec(() => cmd.add('region', [cmd.make('region', { name: 'Grove', shape: { type: 'poly', points: [[100, 100], [130, 100], [115, 130]] } }), cmd.make('region')], 1))],
  ['remove a mix of kinds', exec((w) => cmd.remove([w.objects[0], w.objects.at(-1), w.objects[2], w.spawns[1], w.chests[0], w.npcs.at(-1), w.regions[0], w.map.start]))],
  ['remove everything', exec((w) => cmd.remove([...w.map.objects, ...w.map.spawns, ...w.map.chests, ...w.map.npcs, ...w.map.regions]))],
  ['set a position', exec((w) => cmd.set(w.objects, { x: 3.21, z: -4.56 }))],
  ['set every field of an object', exec((w) => cmd.set(w.objects, { m: 'dungeon/barrel_large', y: 2, rx: 0.1, ry: -2, rz: 0.2, s: 0.574, sy: 1.5, col: [{ x: 0.1, z: 0, r: 0.5 }, { x: -0.1, z: 0, r: 0.5 }], g: 'row' }))],
  ['set collider forms', exec((w) => cmd.setEach(w.objects.slice(0, 4), [{ col: 0 }, { col: 0.8 }, { col: 'box' }, { col: null, g: 'x' }]))],
  ['set every field of a spawn', exec((w) => cmd.set(w.spawns, { types: { shooter: 2, tank: 1 }, lvl: [4, 9], r: 15.5, count: 7, respawn: 30, g: 'camp-7' }))],
  ['set every field of a chest', exec((w) => cmd.set(w.chests, { ry: 2.5, gold: 77, big: true, respawn: 600, g: 'loot' }))],
  ['set every field of an NPC', exec((w) => cmd.set(w.npcs, { kind: 'sage', ry: -1, g: 'folk' }))],
  ['set every field of a region', exec((w) => cmd.set(w.regions, { name: 'Renamed', levels: [3, 8], mood: 'cursed', safe: false, color: '#123abc' }))],
  ['set a region shape', exec((w) => cmd.set([w.regions[0], w.poly], { shape: { type: 'poly', points: [[-150, -150], [-120, -150], [-120, -120], [-150, -120]] } }))],
  ['set the start point', exec((w) => cmd.set([w.map.start], { x: 1.5, z: -1.5, r: 3 }))],
  ['set: reset to defaults', exec((w) => cmd.batch('Reset', [cmd.set(w.objects, { y: 1, s: 2, g: 'tmp', col: 0 }), cmd.set(w.objects, { y: undefined, s: undefined, g: undefined, col: undefined, ry: undefined }), cmd.set(w.objects, { z: 1 })]))],
  ['setEach across kinds', exec((w) => cmd.setEach([w.objects[0], w.spawns[0], w.chests[0], w.npcs[0], w.regions[0], w.map.start, w.objects[1]],
    [{ x: 1, ry: 1 }, { count: 9, lvl: [2, 2] }, { gold: 1 }, { kind: 'trader' }, { safe: false, levels: [1, 1] }, { r: 2 }, { s: 3 }]))],
  ['transform: move everything', exec((w) => cmd.transform(cmd.snapshot(w.everything), { dx: 1.37, dz: -2.61, dy: 0.5 }))],
  ['transform: rotate about a pivot', exec((w) => cmd.transform(cmd.snapshot(w.everything), { rot: 33.33 * DEG, pivot: { x: 4, z: -9 } }))],
  ['transform: scale about the default pivot', exec((w) => cmd.transform(cmd.snapshot(w.everything), { scale: 0.83 }))],
  ['transform: everything at once', exec((w) => cmd.transform(cmd.snapshot(w.everything), { dx: -3, dz: 2, dy: -1, rot: -1.1, scale: 1.07, pivot: { x: 0, z: 0 } }))],
  ['transform: individual', exec((w) => cmd.transform(cmd.snapshot(w.everything), { rot: 15 * DEG, scale: 1.1, individual: true }))],
  ['reorder a region', exec((w) => cmd.reorder('region', w.regions[0], w.map.regions.length - 1))],
  ['paint a patch', exec((w) => cmd.paint(w.cells, GROUND_INDEX.swamp))],
  ['setProps: name and foliage', exec((w) => cmd.setProps({ name: 'Another name', foliage: !w.map.foliage }))],
  ['setProps: fallback', exec(() => cmd.setProps({ fallback: { name: 'The Deep', levels: [20, 30], mood: 'cursed' } }))],
  ['setProps: a larger radius (the ground grows)', exec(() => cmd.setProps({ radius: 333 }))],
  ['setProps: a smaller radius', exec(() => cmd.setProps({ radius: 150 }))],
  ['batch of everything', exec((w) => cmd.batch('Everything', [
    cmd.add('object', [crate(5, 5)], 0), cmd.remove([w.objects[1], w.spawns[0]]), cmd.set(w.chests, { gold: 3 }), cmd.paint(w.cells, GROUND_INDEX.ash),
    cmd.transform(cmd.snapshot([w.objects[0], w.poly, w.map.start]), { dx: 2, rot: 0.2 }), cmd.setProps({ radius: 301, name: 'Batch' }),
    cmd.paint([0, 1, 2], GROUND_INDEX.snow), cmd.reorder('region', w.poly, 0), cmd.setEach([w.npcs[0]], [{ ry: 3 }]),
  ]))],
  ['a group: a drag of 30 moves', (w) => {
    const snap = cmd.snapshot(w.everything);
    w.store.begin('Drag');
    for (let i = 1; i <= 30; i++) w.store.exec(cmd.transform(snap, { dx: i * 0.37, dz: i * -0.11, rot: i * 0.01, pivot: { x: 1, z: 1 } }));
    w.store.commit();
  }],
  ['a group: a brush stroke that paints, scatters and erases', (w) => {
    w.store.begin('Stroke');
    for (let i = 0; i < w.cells.length; i += 3) w.store.exec(cmd.paint(w.cells.slice(i, i + 5), i % 2 ? GROUND_INDEX.dirt : GROUND_INDEX.sand));
    for (let i = 0; i < 12; i++) w.store.exec(cmd.add('object', [crate(i, i), crate(-i, i)]));
    w.store.exec(cmd.remove([w.objects[0], w.objects[3]]));
    w.store.exec(cmd.remove([w.objects[1]]));
    w.store.commit();
  }],
  ['a group: duplicate, then move the copies', (w) => {
    const copies = w.objects.map((it) => cmd.clone(it)), ids = w.store.newGroupIds(1);
    for (const copy of copies) copy.g = ids[0];
    w.store.begin('Duplicate');
    w.store.exec(cmd.add('object', copies));
    w.store.select(copies);
    const snap = cmd.snapshot(copies);
    for (let i = 1; i <= 5; i++) w.store.exec(cmd.transform(snap, { dx: i, dz: i }));
    w.store.commit();
  }],
  ['a group: a scrubbed field', (w) => {
    w.store.begin('Scale');
    for (let i = 1; i <= 20; i++) w.store.exec(cmd.set(w.objects, { s: 1 + i / 50, sy: 1 + i / 100 }));
    w.store.commit();
  }],
];

function handMade() {
  const w = world();
  return {
    map: w.map, store: w.store, objects: w.o.slice(0, 5), spawns: w.s, chests: w.c, npcs: w.n, regions: w.r, poly: w.r[2],
    everything: [...w.o, ...w.s, ...w.c, ...w.n, ...w.r, w.map.start],
    cells: [0, 3, 40, 41, 42, 1000, 1001, 5000, 5281, 5282, 9000, 20000].map((i) => i + cellIndex(w.map.ground, 0, 0) - 5000),
  };
}

for (const [name, run] of CASES) {
  test(`undo is byte-identical on a small map: ${name}`, () => {
    const w = handMade();
    roundTrip(w.store, w.map, () => run(w));
    assert.equal(w.store.dirty, false);
  });
}

// The world as the game ships it, baked into a temp directory (the bake is deterministic; this is not map/world.json).
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hypercat-commands-'));
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const BAKED = path.join(DIR, 'world.json');
const bake = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'bake-map.mjs'), '--out', BAKED], { cwd: DIR, encoding: 'utf8' });
assert.equal(bake.status, 0, `the bake failed: ${bake.stderr}`);
const WORLD = fs.readFileSync(BAKED, 'utf8');

function baked() {
  const map = normalize(JSON.parse(WORLD)), store = createStore();
  store.load(map);
  // the bake has circles only: one polygon region, added the way the editor would add it
  const poly = cmd.make('region', { name: 'Lake', color: '#3a8fb0', shape: { type: 'poly', points: [[100, 100], [140, 104], [122, 140], [96, 128]] } });
  store.exec(cmd.add('region', [poly]));
  store.markSaved();
  const wall = map.objects.filter((o) => o.g === 'town-wall'), every = (list, n) => list.filter((_, i) => i % n === 0);
  return {
    map, store, poly,
    objects: [...every(map.objects, 97), ...wall],
    spawns: [map.spawns[0], map.spawns.at(-1), ...every(map.spawns, 10)], chests: [map.chests[0], map.chests.at(-1)],
    npcs: [map.npcs[0], map.npcs.at(-1)], regions: map.regions.slice(0, 2),
    everything: [...every(map.objects, 3), ...wall, ...map.spawns, ...map.chests, ...map.npcs, ...map.regions, map.start],
    cells: Array.from({ length: 400 }, (_, i) => cellIndex(map.ground, -20 + (i % 20) * 2, 60 + Math.floor(i / 20) * 2)),
  };
}

test('the baked world loads, is canonical and has what the cases below need', () => {
  const map = normalize(JSON.parse(WORLD));
  assert.equal(text(map), WORLD);
  assert.ok(map.objects.length > 4000 && map.spawns.length > 50 && map.chests.length > 10 && map.npcs.length > 5 && map.regions.length >= 2);
  assert.equal(map.objects.filter((o) => o.g === 'town-wall').length, 28);
  assert.equal(map.regions[0].shape.type, 'circle');
});

{
  // one world for all the cases: every case must leave it exactly as it found it, which the next one checks again
  let w = null, before = null;
  for (const [name, run] of CASES) {
    test(`undo is byte-identical on the real world: ${name}`, () => {
      if (!w) {
        w = baked();
        before = text(w.map);
        assert.notEqual(before, WORLD);
      }
      roundTrip(w.store, w.map, () => run(w), before);
      assert.equal(w.store.dirty, false, 'undone back to the saved point');
      assert.equal(w.store.canUndo, true, 'only the set-up step is left');
    });
  }
  test('the real world after all of them: still valid, and one more undo gives the bake back, byte for byte', () => {
    assert.equal(text(w.map), before);
    assert.equal(w.store.undo(), 'Add 1 region');
    assert.equal(text(w.map), WORLD);
    assert.equal(w.store.canUndo, false);
  });
}

test('the acceptance lines of step 3 on the real world: cmd.set quantises, undo is exact, a group expands', () => {
  const w = baked(), { map, store } = w;
  const o = map.objects.find((q) => q.m === 'medieval/tree_single_A'), x = o.x;
  store.exec(cmd.set([o], { x: x + 5 }));
  assert.ok(o.x === qPos(x + 5) && store.dirty);
  store.undo();
  assert.ok(o.x === x && !store.dirty);
  // every tree, each by itself: x + 5 is the quantised double, and undo gives the very same double back
  for (const tree of map.objects.filter((q) => q.m === 'medieval/tree_single_A')) {
    const was = tree.x, command = cmd.set([tree], { x: was + 5 });
    command.do(map);
    assert.equal(tree.x, qPos(was + 5));
    command.undo(map);
    assert.ok(Object.is(tree.x, was));
  }
  const wall = map.objects.find((q) => q.g === 'town-wall');
  assert.equal(store.expandGroups([wall]).length, 28);
  store.select(store.expandGroups([wall]));
  assert.equal(store.selection.size, 28);
  assert.ok(store.selection.has(wall));
  // Q: +15 degrees about the pivot of the selection, one undo step
  const snap = cmd.snapshot(store.selected());
  store.exec(cmd.transform(snap, { rot: 15 * DEG }));
  assert.ok(store.canUndo);
  assert.equal(store.undo(), 'Rotate 28 objects');
  assert.equal(store.dirty, false);
  const fortress = store.expandGroups([map.spawns.find((s) => 'boss' in s.types)]);
  assert.ok(fortress.some((it) => store.kindOf(it) === 'chest') && fortress.some((it) => store.kindOf(it) === 'object'), 'a group spans kinds');
});

// ---------------------------------------------------------------- a long random session

test('a random editing session: every undo and every redo lands on the exact bytes of that position', () => {
  const rnd = mulberry(20261006), w = world(), { map, store } = w;
  const int = (n) => Math.floor(rnd() * n), pick = (list) => list[int(list.length)], some = (list, n) => [...new Set(Array.from({ length: n }, () => pick(list)))].filter(Boolean);
  const num = (lo, hi) => lo + rnd() * (hi - lo);
  const anyItems = () => some([...map.objects, ...map.spawns, ...map.chests, ...map.npcs, ...map.regions, map.start], 1 + int(6));
  const builders = [
    () => cmd.add('object', Array.from({ length: 1 + int(4) }, () => cmd.make('object', { m: pick(['medieval/crate', 'dungeon/pillar']), x: num(-99, 99), z: num(-99, 99), ry: num(-4, 4), g: rnd() < 0.3 ? 'grp' : null })), rnd() < 0.5 ? null : int(map.objects.length + 1)),
    () => cmd.add(pick(['spawn', 'chest', 'npc', 'region']), []),
    () => { const kind = pick(['spawn', 'chest', 'npc', 'region']); return cmd.add(kind, [cmd.make(kind, kind === 'region' ? { shape: { type: 'poly', points: [[num(-50, 0), num(-50, 0)], [num(0, 50), num(-50, 0)], [num(-9, 9), num(1, 50)]] } } : { x: num(-90, 90), z: num(-90, 90) })]); },
    () => cmd.remove(anyItems()),
    () => cmd.set(anyItems(), pick([{ x: num(-99, 99) }, { z: num(-99, 99), ry: num(-7, 7) }, { g: pick(['a', 'b', undefined]) }, { r: num(0, 30) }, { s: num(0.1, 3), y: num(-5, 5) }, { name: `R${int(9)}`, safe: rnd() < 0.5 }, { gold: 1 + int(500), big: rnd() < 0.5 }, { count: 1 + int(9), lvl: [1 + int(5), 6 + int(5)] }, { kind: pick(NPC_KINDS) }, { col: pick([0, 0.5, 'box', undefined, [{ x: num(-1, 1), z: 0, r: 0.5 }]]) }])),
    () => { const items = anyItems(); return cmd.setEach(items, items.map(() => pick([{ x: num(-50, 50) }, { ry: num(-3, 3) }, {}, { r: num(1, 20) }, { g: 'each' }]))); },
    () => cmd.transform(cmd.snapshot(anyItems()), { dx: num(-5, 5), dz: num(-5, 5), dy: rnd() < 0.3 ? num(-1, 1) : 0, rot: rnd() < 0.5 ? num(-3, 3) : 0, scale: rnd() < 0.5 ? num(0.5, 1.5) : 1, individual: rnd() < 0.3 }),
    () => (map.regions.length ? cmd.reorder('region', pick(map.regions), int(map.regions.length)) : cmd.setProps({ foliage: !map.foliage })),
    () => cmd.paint(Array.from({ length: 1 + int(60) }, () => int(map.ground.cells.length + 20) - 10), int(GROUND_TYPES.length)),
    () => cmd.setProps(pick([{ name: `Map ${int(99)}` }, { foliage: rnd() < 0.5 }, { radius: 220 + int(60) }, { fallback: { mood: pick(Object.keys(MOODS)), levels: rnd() < 0.5 ? null : [1, 1 + int(9)] } }])),
    () => cmd.batch('Batch', [cmd.set(anyItems(), { x: num(-9, 9) }), cmd.remove(anyItems()), cmd.paint([int(1000)], int(GROUND_TYPES.length))]),
  ];
  const states = [raw(map)];      // states[k]: the bytes with k steps in the undo stack
  let depth = 0;
  const pushed = () => { states.length = ++depth; states.push(raw(map)); };
  for (let step = 0; step < 300; step++) {
    const dice = rnd();
    if (dice < 0.12 && depth > 0) {
      store.undo();
      depth--;
      assert.equal(raw(map), states[depth], `undo at step ${step}`);
    } else if (dice < 0.2 && states.length - 1 > depth) {
      store.redo();
      depth++;
      assert.equal(raw(map), states[depth], `redo at step ${step}`);
    } else if (dice < 0.4) {
      const snap = cmd.snapshot(anyItems());
      store.begin('Group');
      for (let i = 0; i < 1 + int(6); i++) store.exec(pick([() => cmd.transform(snap, { dx: num(-5, 5), rot: num(-1, 1) }), ...builders])());
      if (rnd() < 0.3) {
        store.cancel();
        assert.equal(raw(map), states[depth], `cancel at step ${step}`);
      } else if (store.commit()) pushed();
    } else {
      const canUndo = store.canUndo, label = store.undoLabel, redo = store.canRedo;
      const change = store.exec(pick(builders)());
      if (!isEmptyChange(change)) pushed();
      else assert.deepEqual([store.canUndo, store.undoLabel, store.canRedo], [canUndo, label, redo], 'an empty command left a trace');
    }
    assert.equal(store.grouping, false);
    assert.equal(store.dirty, depth !== 0);
    for (const item of store.selection) assert.notEqual(store.kindOf(item), null, 'something that is not in the map is selected');
  }
  assert.ok(depth > 20, `only ${depth} steps deep: the session tests little`);
  // all the way back, all the way forward, and back again
  for (let k = depth; k > 0; k--) { store.undo(); assert.equal(raw(map), states[k - 1], `unwinding to ${k - 1}`); }
  assert.equal(store.canUndo, false);
  assert.equal(text(map), states[0], 'the map is the valid map it started as');
  assert.equal(map.start, w.map.start);
  assert.deepEqual(map.objects, w.o);
  for (let i = 0; i < w.o.length; i++) assert.equal(map.objects[i], w.o[i]);
  for (let k = 1; k < states.length; k++) { store.redo(); assert.equal(raw(map), states[k], `rewinding to ${k}`); }
  assert.equal(store.canRedo, false);
  while (store.undo() !== null);
  assert.equal(text(map), states[0]);
  // every item the session left behind is still an item of its own list, known to the store
  for (const list of LISTS) for (const item of map[list]) assert.equal(COLLECTION[store.kindOf(item)], list);
});
