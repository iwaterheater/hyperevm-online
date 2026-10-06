// The maths of the Arrange panel (src/editor/arrange.js): align, distribute, face a point, randomize, drop to ground,
// array. The module is pure, so most of this needs no store at all; the last block runs the patches and the copies
// through the real store and commands, the way panels/arrange.js does, and checks what the panel promises: every
// arrangement is ONE undo step and undo leaves a byte-identical map.
// Maps are built with emptyMap() and cmd.make(); nothing here reads map/world.json or needs a browser.
// Run: node --test test/arrange.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMap, qAngle, serialize, shapeCentre, stringifyMap, toDeg } from '../src/map/format.js';
import { createStore } from '../src/editor/store.js';
import * as cmd from '../src/editor/commands.js';
import { align, array, distribute, drop, facePoint, randomize } from '../src/editor/arrange.js';

const DEG = Math.PI / 180;
const text = (map) => stringifyMap(serialize(map, { check: false }));

// ---------------------------------------------------------------- helpers

const obj = (x, z, props = {}) => cmd.make('object', { m: 'medieval/barrel', x, z, ...props });
const entry = (kind, item) => ({ kind, item });
const objects = (...points) => points.map(([x, z, props]) => entry('object', obj(x, z, props)));

// One item of every kind, as entries. The start is a plain { x, z, r } like map.start.
function mixed() {
  return [
    entry('object', obj(10, 4, { ry: 30 * DEG, y: 2, s: 1.5 })),
    entry('spawn', cmd.make('spawn', { x: 20, z: -6, r: 5 })),
    entry('chest', cmd.make('chest', { x: 30, z: 8, ry: 90 * DEG })),
    entry('npc', cmd.make('npc', { kind: 'guard', x: 40, z: 0 })),
    entry('region', cmd.make('region', { name: 'Ring', shape: { type: 'circle', x: 50, z: 12, r: 6 } })),
    entry('region', cmd.make('region', { name: 'Yard', shape: { type: 'poly', points: [[58, 0], [62, 0], [62, 4], [58, 4]] } })),
    entry('start', { x: 70, z: -2, r: 5 }),
  ];
}

// What a patch would make of the entry's position, without a store: the patched x / z, or the centre of the new shape.
function after(e, patch) {
  if (e.kind === 'region') return shapeCentre(patch.shape ?? e.item.shape);
  return { x: patch.x ?? e.item.x, z: patch.z ?? e.item.z };
}

// A deterministic rnd(): the given values, round and round.
const sequence = (...values) => { let i = 0; return () => values[i++ % values.length]; };

// A store with a small island and the given objects on it - part of the map it loads, so the history starts empty.
function storeWith(items = []) {
  const store = createStore(), map = emptyMap();
  map.objects.push(...items);
  store.load(map);
  return store;
}
const entriesOf = (store, items) => items.map((item) => ({ kind: store.kindOf(item), item }));

// ---------------------------------------------------------------- align

test('align: min, centre and max give every entry one coordinate and leave the other axis alone', () => {
  const es = objects([10, 1], [14.5, 2], [12, 3]);
  for (const [mode, want] of [['min', 10], ['centre', 12.25], ['max', 14.5]]) {
    const patches = align(es, 'x', mode);
    assert.equal(patches.length, 3);
    es.forEach((e, i) => {
      assert.equal(after(e, patches[i]).x, want, `${mode}: x of entry ${i}`);
      assert.equal('z' in patches[i], false, `${mode}: z is not touched`);
    });
  }
  const z = align(es, 'z', 'max');
  es.forEach((e, i) => assert.equal(after(e, z[i]).z, 3));
});

test('align: an entry that is already there gets an empty patch', () => {
  const es = objects([10, 1], [14, 2], [10, 3]);
  assert.deepEqual(align(es, 'x', 'min'), [{}, { x: 10 }, {}]);
});

test('align: every kind moves, a region by its shape', () => {
  const es = mixed(), patches = align(es, 'z', 'min');
  es.forEach((e, i) => assert.ok(Math.abs(after(e, patches[i]).z - (-6)) < 0.006, `${e.kind} lands on z = -6`));
  const circle = patches[4].shape, poly = patches[5].shape;
  assert.deepEqual(circle, { type: 'circle', x: 50, z: -6, r: 6 });
  assert.deepEqual(poly.points, [[58, -8], [62, -8], [62, -4], [58, -4]]);
  assert.notEqual(poly.points, es[5].item.shape.points, 'the shape of the item is not edited in place');
  assert.deepEqual(es[5].item.shape.points, [[58, 0], [62, 0], [62, 4], [58, 4]]);
});

test('align: the result sits on the 0.01 grid of the map', () => {
  const es = objects([0.01, 0], [0.04, 1]);
  assert.deepEqual(align(es, 'x', 'centre'), [{ x: 0.03 }, { x: 0.03 }]);      // 0.025 rounds to 0.03 for both
});

test('align: bad arguments throw, an empty list is an empty list', () => {
  assert.deepEqual(align([], 'x', 'min'), []);
  assert.throws(() => align(objects([0, 0]), 'y', 'min'), TypeError);
  assert.throws(() => align(objects([0, 0]), 'x', 'middle'), TypeError);
  assert.throws(() => align(null, 'x', 'min'), TypeError);
  assert.throws(() => align([{ item: {} }], 'x', 'min'), TypeError);
});

// ---------------------------------------------------------------- distribute

test('distribute: the outermost two stay, the rest are spaced evenly in their order along the axis', () => {
  const es = objects([10, 0], [0, 5], [1, 9], [7, -3], [2, 2]);       // along x: 0, 1, 2, 7, 10
  const patches = distribute(es, 'x');
  assert.deepEqual(patches[1], {}, 'the smallest stays');
  assert.deepEqual(patches[0], {}, 'the largest stays');
  assert.deepEqual([after(es[2], patches[2]).x, after(es[4], patches[4]).x, after(es[3], patches[3]).x], [2.5, 5, 7.5]);
  for (const p of patches) assert.equal('z' in p, false);
});

test('distribute: fewer than three entries, or entries on one spot, change nothing', () => {
  assert.deepEqual(distribute(objects([0, 0], [5, 0]), 'x'), [{}, {}]);
  assert.deepEqual(distribute(objects([3, 0], [3, 1], [3, 2]), 'x'), [{}, {}, {}]);
  assert.deepEqual(distribute([], 'z'), []);
});

test('distribute: entries that share a coordinate keep the order they were given in', () => {
  const es = objects([0, 0], [0, 1], [0, 2], [9, 3]);
  const patches = distribute(es, 'x');
  assert.deepEqual(patches, [{}, { x: 3 }, { x: 6 }, {}]);
});

test('distribute: regions and markers take part', () => {
  const es = mixed(), patches = distribute(es, 'x');          // origins along x: 10 20 30 40 50 60 70 - already even
  assert.deepEqual(patches, es.map(() => ({})));
  es[3].item.x = 44;                                          // not in a map: the test builds its own input
  const again = distribute(es, 'x');
  assert.deepEqual(again[3], { x: 40 });
});

// ---------------------------------------------------------------- face a point

test('facePoint: ry = atan2(dx, dz), so forward (sin ry, cos ry) points at the target', () => {
  const es = objects([0, 0], [10, 0], [0, 10], [3, -4]);
  const patches = facePoint(es, 0, 5);
  assert.equal(toDeg(patches[0].ry), 0, 'south (+Z) is ry 0');
  assert.equal(toDeg(patches[2].ry), 180, 'north is 180, never -180');
  es.forEach((e, i) => {
    const dx = 0 - e.item.x, dz = 5 - e.item.z, len = Math.hypot(dx, dz), ry = patches[i].ry;
    assert.ok(Math.abs(Math.sin(ry) - dx / len) < 1e-3 && Math.abs(Math.cos(ry) - dz / len) < 1e-3, `entry ${i} faces the point`);
    assert.equal(ry, qAngle(ry), 'on the 0.01 degree grid');
  });
});

test('facePoint: only objects, chests and NPCs turn; an item on the point keeps its facing', () => {
  const es = mixed(), patches = facePoint(es, 10, 4);
  assert.deepEqual(patches[0], {}, 'the object stands on the point');
  assert.deepEqual(Object.keys(patches[2]), ['ry']);
  assert.deepEqual(Object.keys(patches[3]), ['ry']);
  for (const i of [1, 4, 5, 6]) assert.deepEqual(patches[i], {}, `${es[i].kind} has no facing`);
  assert.throws(() => facePoint(es, NaN, 0), TypeError);
});

// ---------------------------------------------------------------- randomize

test('randomize: rotation covers (-180, 180], scale stays inside its range, both on the grid', () => {
  const es = objects(...Array.from({ length: 200 }, (_, i) => [i, 0]));
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const patches = randomize(es, { rotation: true, scale: [0.8, 1.3] }, rnd);
  const angles = new Set();
  for (const p of patches) {
    assert.ok(p.ry > -Math.PI - 1e-9 && p.ry <= Math.PI + 1e-9);
    assert.equal(p.ry, qAngle(p.ry));
    assert.ok(p.s >= 0.8 && p.s <= 1.3, `scale ${p.s}`);
    assert.equal(p.s, Math.round(p.s * 1000) / 1000);
    angles.add(p.ry);
  }
  assert.ok(angles.size > 150, 'the angles differ');
});

test('randomize: the ends of the ranges, and a range given backwards', () => {
  const es = objects([0, 0]);
  assert.deepEqual(randomize(es, { rotation: true }, () => 0), [{ ry: Math.PI }], '-180 degrees is written as 180');
  assert.deepEqual(randomize(es, { scale: [2, 0.5] }, () => 0), [{ s: 0.5 }]);
  assert.deepEqual(randomize(es, { scale: [0.5, 2] }, () => 0.999999), [{ s: 2 }]);
  assert.deepEqual(randomize(es, { scale: [1.2, 1.2] }), [{ s: 1.2 }]);
  assert.deepEqual(randomize(es, {}), [{}], 'nothing asked for, nothing changed');
});

test('randomize: rnd is drawn per entry, rotation before scale, and only where a value is needed', () => {
  const es = mixed(), drawn = [];
  const rnd = () => { drawn.push(drawn.length); return 0.5; };
  const patches = randomize(es, { rotation: true, scale: [1, 3] }, rnd);
  assert.deepEqual(patches[0], { ry: 0, s: 2 });                // the object: both
  assert.deepEqual(patches[1], {});                             // a spawn has neither a facing nor a scale
  assert.deepEqual(patches[2], { ry: 0 });                      // a chest and an NPC turn
  assert.deepEqual(patches[3], { ry: 0 });
  assert.deepEqual(patches.slice(4), [{}, {}, {}]);             // regions and the start
  assert.equal(drawn.length, 4);
  const same = randomize(objects([0, 0], [1, 0]), { rotation: true }, sequence(0.25, 0.75));
  assert.deepEqual(same.map((p) => toDeg(p.ry)), [-90, 90]);
  assert.throws(() => randomize(es, { scale: [0, 1] }), TypeError);
  assert.throws(() => randomize(es, { scale: [1] }), TypeError);
});

// ---------------------------------------------------------------- drop to ground

test('drop: objects come down to y = 0, nothing else changes', () => {
  const es = [...mixed(), entry('object', obj(0, 0)), entry('object', obj(1, 1, { y: -3 }))];
  const patches = drop(es);
  assert.deepEqual(patches[0], { y: 0 });
  assert.deepEqual(patches.slice(1, 8), [{}, {}, {}, {}, {}, {}, {}], 'markers, regions, the start and an object on the ground');
  assert.deepEqual(patches[8], { y: 0 });
});

// ---------------------------------------------------------------- array

test('array: count - 1 copies of every entry, each a step further', () => {
  const es = objects([0, 0, { ry: 10 * DEG }], [1, 2]);
  const copies = array(es, { count: 4, dx: 5, dz: -1 });
  assert.equal(copies.length, 6);
  assert.deepEqual(copies.map((c) => [c.item.x, c.item.z]), [[5, -1], [6, 1], [10, -2], [11, 0], [15, -3], [16, -1]]);
  for (const c of copies) assert.equal(c.kind, 'object');
  assert.equal(toDeg(copies[0].item.ry), 10, 'without dry the facing is kept');
  assert.notEqual(copies[0].item, es[0].item);
  assert.deepEqual(array(es, { count: 1, dx: 5, dz: 0 }), [], 'a count of 1 is the selection alone');
  assert.deepEqual([es[0].item.x, es[1].item.x], [0, 1], 'the entries are untouched');
});

test('array: a turn moves the whole set as one rigid piece about its pivot', () => {
  // two posts 4 apart on the x axis: the pivot is (2, 0). A quarter turn (+Z towards +X) puts them on the z axis.
  const es = objects([0, 0], [4, 0]);
  const [a, b] = array(es, { count: 2, dx: 0, dz: 0, dry: 90 * DEG });
  assert.deepEqual([a.item.x, a.item.z, b.item.x, b.item.z], [2, 2, 2, -2]);
  assert.equal(toDeg(a.item.ry), 90);
  // a single item turns on its own spot and takes the step
  const one = array(objects([3, 3]), { count: 3, dx: 2, dz: 0, dry: 45 * DEG });
  assert.deepEqual(one.map((c) => [c.item.x, c.item.z, toDeg(c.item.ry)]), [[5, 3, 45], [7, 3, 90]]);
});

test('array: every kind is copied except the start; regions move with all their points', () => {
  const es = mixed(), copies = array(es, { count: 2, dx: 100, dz: 0 });
  assert.deepEqual(copies.map((c) => c.kind), ['object', 'spawn', 'chest', 'npc', 'region', 'region']);
  assert.deepEqual(copies[4].item.shape, { type: 'circle', x: 150, z: 12, r: 6 });
  assert.deepEqual(copies[5].item.shape.points, [[158, 0], [162, 0], [162, 4], [158, 4]]);
  assert.equal(copies[4].item.name, 'Ring');
  assert.deepEqual(copies[1].item.types, es[1].item.types);
  assert.notEqual(copies[1].item.types, es[1].item.types, 'a deep copy');
  assert.equal(copies[0].item.y, 2, 'height and scale come along');
  assert.equal(copies[0].item.s, 1.5);
});

test('array: every distinct group of every copy gets its own new id, from ONE call of newIds', () => {
  const es = [
    entry('object', obj(0, 0, { g: 'house' })), entry('object', obj(1, 0, { g: 'house' })),
    entry('spawn', cmd.make('spawn', { x: 2, z: 0, g: 'camp' })), entry('object', obj(3, 0)),
    entry('chest', cmd.make('chest', { x: 4, z: 0, g: 'house' })),
  ];
  const calls = [];
  const newIds = (n) => { calls.push(n); return Array.from({ length: n }, (_, i) => `g${i + 7}`); };
  const copies = array(es, { count: 4, dx: 10, dz: 0 }, newIds);
  assert.deepEqual(calls, [6], '(count - 1) x (distinct groups) = 3 x 2, asked for once');
  const g = copies.map((c) => c.item.g);
  assert.deepEqual(g.slice(0, 5), ['g7', 'g7', 'g8', null, 'g7'], 'the first copy: house and camp stay two groups');
  assert.deepEqual(g.slice(5, 10), ['g9', 'g9', 'g10', null, 'g9']);
  assert.deepEqual(g.slice(10), ['g11', 'g11', 'g12', null, 'g11']);
  assert.equal(new Set(g.filter(Boolean)).size, 6);
  assert.deepEqual(es.map((e) => e.item.g), ['house', 'house', 'camp', null, 'house'], 'the originals keep their groups');
});

test('array: newIds is asked even for nothing, must deliver, and is not needed without groups', () => {
  const calls = [];
  array(objects([0, 0]), { count: 3, dx: 1, dz: 0 }, (n) => { calls.push(n); return []; });
  assert.deepEqual(calls, [0]);
  const grouped = [entry('object', obj(0, 0, { g: 'a' }))];
  assert.throws(() => array(grouped, { count: 2, dx: 1, dz: 0 }), TypeError, 'groups need ids');
  assert.throws(() => array(grouped, { count: 3, dx: 1, dz: 0 }, () => ['g1']), TypeError, 'too few ids');
  assert.throws(() => array(grouped, { count: 3, dx: 1, dz: 0 }, () => ['g1', 'g1']), TypeError, 'the same id twice');
  assert.equal(array(objects([0, 0]), { count: 2, dx: 1, dz: 0 }).length, 1);
});

test('array: bad arguments throw', () => {
  const es = objects([0, 0]);
  assert.throws(() => array(es, { count: 0, dx: 1, dz: 0 }), RangeError);
  assert.throws(() => array(es, { count: 2.5, dx: 1, dz: 0 }), RangeError);
  assert.throws(() => array(es, { dx: 1, dz: 0 }), RangeError);
  assert.throws(() => array(es, { count: 2, dx: NaN, dz: 0 }), TypeError);
  assert.throws(() => array(es, { count: 2, dx: 0, dz: 0, dry: Infinity }), TypeError);
});

// ---------------------------------------------------------------- through the store, as the panel does it

test('store: Align X (min) on three objects gives them one x in one undo step', () => {
  const items = [obj(10, 1), obj(14.5, 2), obj(12, 3)], store = storeWith(items), before = text(store.map);
  let steps = 0;
  store.on('history', () => { steps++; });
  store.begin('Align 3 objects');
  store.exec(cmd.setEach(items, align(entriesOf(store, items), 'x', 'min')));
  assert.equal(store.commit(), true);
  assert.deepEqual(items.map((o) => o.x), [10, 10, 10]);
  assert.deepEqual(items.map((o) => o.z), [1, 2, 3]);
  assert.equal(store.undoLabel, 'Align 3 objects');
  assert.equal(store.undo(), 'Align 3 objects');
  assert.equal(text(store.map), before, 'one undo restores the map byte for byte');
  assert.equal(store.canUndo, false, 'it was the only step');
  assert.equal(store.redo(), 'Align 3 objects');
  assert.deepEqual(items.map((o) => o.x), [10, 10, 10]);
  assert.ok(steps > 0);
});

test('store: an arrangement that changes nothing leaves no undo step', () => {
  const items = [obj(5, 1), obj(5, 2)], store = storeWith(items);
  store.begin('Align 2 objects');
  store.exec(cmd.setEach(items, align(entriesOf(store, items), 'x', 'max')));
  assert.equal(store.commit(), false);
  assert.equal(store.canUndo, false);
  assert.equal(store.dirty, false);
});

test('store: every kind takes its patches; undo restores the same shape objects', () => {
  const store = createStore();
  store.load(emptyMap());
  const es = mixed().filter((e) => e.kind !== 'start');
  for (const e of es) store.exec(cmd.add(e.kind, [e.item]));
  const all = [...es, { kind: 'start', item: store.map.start }], items = all.map((e) => e.item);
  const before = text(store.map), shape = es[5].item.shape;
  const run = (label, patches) => { store.begin(label); store.exec(cmd.setEach(items, patches)); return store.commit(); };

  assert.equal(run('Align', align(all, 'z', 'centre')), true);
  const z = (e) => (e.kind === 'region' ? shapeCentre(e.item.shape).z : e.item.z);
  for (const e of all) assert.ok(Math.abs(z(e) - 3) < 0.006, `${e.kind} is on the centre line`);     // z runs from -6 to 12
  assert.equal(run('Distribute', distribute(all, 'x')), false, 'the origins are 10 apart already: no step');
  store.exec(cmd.set([es[3].item], { x: 44 }));
  assert.equal(run('Distribute', distribute(all, 'x')), true);
  assert.equal(es[3].item.x, 40);
  assert.equal(run('Face', facePoint(all, 0, 0)), true);
  assert.equal(run('Randomize', randomize(all, { rotation: true, scale: [0.5, 0.5] }, () => 0.5)), true);
  assert.equal(es[0].item.s, 0.5);
  assert.equal(run('Drop', drop(all)), true);
  assert.equal(es[0].item.y, 0);
  assert.deepEqual(Array.from({ length: 6 }, () => store.undo()), ['Drop', 'Randomize', 'Face', 'Distribute', 'Move 1 NPC', 'Align']);
  assert.equal(text(store.map), before);
  assert.equal(es[5].item.shape, shape, 'the region has its own shape object back');
});

test('store: Array (count 3) of a selection holding one group yields two copies with two NEW distinct g', () => {
  const items = [obj(0, 0, { g: 'g1' }), obj(1, 0, { g: 'g1' }), obj(2, 0, { g: 'g3' })], store = storeWith(items);
  const selection = items.slice(0, 2), before = text(store.map);
  let asked = 0;
  const copies = array(entriesOf(store, selection), { count: 3, dx: 0, dz: 5 }, (n) => { asked++; return store.newGroupIds(n); });
  assert.equal(asked, 1);
  store.begin('Array 2 objects x 3');
  store.exec(cmd.add('object', copies.map((c) => c.item)));
  store.select([...selection, ...copies.map((c) => c.item)]);
  assert.equal(store.commit(), true);

  assert.equal(store.map.objects.length, 7);
  const g = copies.map((c) => c.item.g);
  assert.deepEqual(g, ['g2', 'g2', 'g4', 'g4'], 'the smallest ids no item uses: g1 and g3 are taken');
  assert.deepEqual(copies.map((c) => [c.item.x, c.item.z]), [[0, 5], [1, 5], [0, 10], [1, 10]]);
  assert.equal(store.selection.size, 6);
  assert.equal(store.undo(), 'Array 2 objects x 3');
  assert.equal(text(store.map), before, 'one undo removes every copy');
  assert.deepEqual(store.newGroupIds(2), ['g2', 'g4'], 'the ids are free again');
});
