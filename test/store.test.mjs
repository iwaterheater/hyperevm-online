// The editor's pure core, part 1: the store (map, selection, undo / redo, groups, dirty tracking, its four events),
// the `ui` state and the action registry - and, at the end, the editor's own use of them: the drag helpers of
// tools/common.js and the selection edits of the Select tool, which need a store and a `ui` but no page.
// The commands themselves are in commands.test.mjs.
// Maps are built with emptyMap() and cmd.make(): nothing here reads map/world.json, and nothing needs a browser.
// Run: node --test test/store.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GROUND_INDEX, LAYERS, cellIndex, emptyMap, serialize, stringifyMap, validate } from '../src/map/format.js';
import { createStore, emptyChange, isEmptyChange } from '../src/editor/store.js';
import { STORAGE_KEY, SNAP_STEPS, createEmitter, createUi } from '../src/editor/state.js';
import { createActions, reportOnce } from '../src/editor/actions.js';
import * as cmd from '../src/editor/commands.js';
import { dragMove, dragRadius, placeOnce } from '../src/editor/tools/common.js';
import { groupSelection, selectAll, ungroupSelection } from '../src/editor/tools/select.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVENTS = ['change', 'selection', 'history', 'load'];
const bytes = (map) => stringifyMap(serialize(map));

// ---------------------------------------------------------------- helpers

// A small valid island with a few items of every kind, loaded into a fresh store.
function world(options) {
  const map = emptyMap();
  const o = [
    cmd.make('object', { m: 'medieval/barrel', x: 10, z: 10 }),
    cmd.make('object', { m: 'medieval/barrel', x: 12, z: 10, g: 'camp' }),
    cmd.make('object', { m: 'medieval/tree_single_A', x: -30, z: 40, ry: 1, s: 1.1 }),
    cmd.make('object', { m: 'dungeon/pillar', x: 50, z: -20, y: 1.5, g: 'g2' }),
  ];
  const s = [
    cmd.make('spawn', { x: 100, z: 0 }),
    cmd.make('spawn', { x: -100, z: 50, r: 12, types: { chaser: 2, runner: 1 }, lvl: [3, 5], g: 'camp' }),
  ];
  const c = [cmd.make('chest', { x: 20, z: 20 }), cmd.make('chest', { x: -20, z: 20, big: true, gold: 400, g: 'camp' })];
  const n = [cmd.make('npc', { x: 5, z: 5 }), cmd.make('npc', { kind: 'blacksmith', x: -5, z: 5, g: 'g7' })];
  const r = [
    cmd.make('region', { name: 'Town', safe: true, mood: 'meadow', shape: { type: 'circle', x: 0, z: 0, r: 30 } }),
    cmd.make('region', { name: 'Lake', shape: { type: 'poly', points: [[60, 60], [90, 60], [90, 90], [60, 90]] } }),
  ];
  map.objects.push(...o);
  map.spawns.push(...s);
  map.chests.push(...c);
  map.npcs.push(...n);
  map.regions.push(...r);
  const store = createStore(options);
  store.load(map);
  return { map, store, o, s, c, n, r };
}

// Every event of the store, in order: [name, ...payload].
function record(store) {
  const log = [];
  for (const event of EVENTS) store.on(event, (...args) => log.push([event, ...args]));
  return log;
}
const names = (log) => log.map((e) => e[0]);

// The complete Change a command must have produced: `part` names only the lists that are not empty.
function changeOf(part = {}) {
  const change = emptyChange(part.origin ?? 'do');
  for (const key of ['added', 'removed', 'updated']) Object.assign(change[key], part[key]);
  for (const key of ['order', 'ground', 'props']) if (key in part) change[key] = part[key];
  return change;
}

// Deep equality AND the very same item references, list by list.
function assertChange(actual, part) {
  const expected = changeOf(part);
  assert.deepEqual(actual, expected);
  assert.deepEqual(Object.keys(actual), ['added', 'removed', 'updated', 'order', 'ground', 'props', 'origin']);
  for (const key of ['added', 'removed', 'updated']) {
    for (const list of Object.keys(expected[key])) {
      expected[key][list].forEach((item, i) => assert.equal(actual[key][list][i], item, `${key}.${list}[${i}] is another object`));
    }
  }
}

// Runs fn with console.error replaced; -> what it was called with.
function quiet(fn) {
  const calls = [], original = console.error;
  console.error = (...args) => calls.push(args);
  try { fn(); } finally { console.error = original; }
  return calls;
}

const fakeStorage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => { data.set(k, String(v)); } };
};

// ---------------------------------------------------------------- the store: loading and looking things up

test('a new store has no map and refuses to edit', () => {
  const store = createStore();
  assert.equal(store.map, null);
  assert.equal(store.selection.size, 0);
  assert.equal(store.dirty, false);
  assert.equal(store.canUndo, false);
  assert.equal(store.canRedo, false);
  assert.equal(store.grouping, false);
  assert.equal(store.maxUndoBytes, 64e6);
  assert.deepEqual(store.items('object'), []);
  assert.deepEqual(store.selected(), []);
  assert.equal(store.kindOf({}), null);
  assert.equal(store.undo(), null);
  assert.equal(store.redo(), null);
  assert.equal(store.commit(), false);
  assert.equal(store.cancel(), false);
  assert.throws(() => store.exec(cmd.setProps({ name: 'x' })), /no map/);
  assert.throws(() => store.begin('Edit'), /no map/);
  assert.deepEqual(store.newGroupIds(2), ['g1', 'g2']);
});

test("load replaces the map and emits 'load', 'selection', 'history' - in that order, each without a payload", () => {
  const { store, map, o } = world();
  store.select([o[0]]);
  store.exec(cmd.set([o[0]], { x: 1 }));
  const log = record(store), next = emptyMap({ radius: 100 });
  store.load(next);
  assert.deepEqual(log, [['load'], ['selection'], ['history']]);
  assert.equal(store.map, next);
  assert.notEqual(store.map, map);
  assert.equal(store.selection.size, 0);
  assert.equal(store.canUndo, false);
  assert.equal(store.canRedo, false);
  assert.equal(store.dirty, false);
  assert.equal(store.kindOf(o[0]), null, 'items of the old map are unknown');
  assert.equal(store.kindOf(next.start), 'start');

  log.length = 0;
  store.load(emptyMap(), { dirty: true });
  assert.deepEqual(log, [['load'], ['selection'], ['history']]);
  assert.equal(store.dirty, true, 'an import or a restored draft is not what the server has');
});

test('load discards an open group and refuses what is not a runtime map', () => {
  const { store, o } = world();
  store.begin('Drag');
  store.exec(cmd.set([o[0]], { x: 1 }));
  store.load(emptyMap());
  assert.equal(store.grouping, false);
  assert.equal(store.canUndo, false);
  // serialize() gives the FILE form: the same keys, but its ground is text rows - normalize() comes first
  for (const bad of [null, undefined, 42, {}, { objects: [] }, serialize(emptyMap())]) assert.throws(() => store.load(bad), TypeError);
  assert.equal(store.map.radius, 260, 'a refused load leaves the store as it was');
});

test('kindOf, items, indexOf', () => {
  const { store, map, o, s, c, n, r } = world();
  assert.equal(store.kindOf(o[2]), 'object');
  assert.equal(store.kindOf(s[1]), 'spawn');
  assert.equal(store.kindOf(c[0]), 'chest');
  assert.equal(store.kindOf(n[1]), 'npc');
  assert.equal(store.kindOf(r[1]), 'region');
  assert.equal(store.kindOf(map.start), 'start');
  assert.equal(store.kindOf(map.fallback), null, 'the fallback is not an item');
  assert.equal(store.kindOf(cmd.clone(o[0])), null, 'a clone is not in the map until it is added');
  assert.equal(store.kindOf(null), null);

  assert.equal(store.items('object'), map.objects);
  assert.equal(store.items('spawn'), map.spawns);
  assert.equal(store.items('chest'), map.chests);
  assert.equal(store.items('npc'), map.npcs);
  assert.equal(store.items('region'), map.regions);
  assert.deepEqual(store.items('start'), [map.start]);
  assert.equal(store.items('start')[0], map.start);
  assert.deepEqual(store.items('nonsense'), []);

  assert.equal(store.indexOf(o[2]), 2);
  assert.equal(store.indexOf(r[1]), 1);
  assert.equal(store.indexOf(map.start), 0);
  assert.equal(store.indexOf(cmd.clone(o[0])), -1);

  // the WeakMap follows adds and removes, undone or not
  const fresh = cmd.make('npc', { x: 1, z: 1 });
  store.exec(cmd.add('npc', [fresh]));
  assert.equal(store.kindOf(fresh), 'npc');
  store.exec(cmd.remove([fresh, o[0]]));
  assert.equal(store.kindOf(fresh), null);
  assert.equal(store.kindOf(o[0]), null);
  assert.equal(store.indexOf(o[0]), -1);
  store.undo();
  assert.equal(store.kindOf(fresh), 'npc');
  assert.equal(store.kindOf(o[0]), 'object');
  store.undo();
  assert.equal(store.kindOf(fresh), null);
});

// ---------------------------------------------------------------- selection

test("select: replace, add, toggle - and 'selection' only when the set changed", () => {
  const { store, map, o, s } = world();
  const log = record(store);
  assert.equal(store.select([o[0], o[1]]), true);
  assert.deepEqual([...store.selection], [o[0], o[1]]);
  assert.deepEqual(log, [['selection']], "'selection' carries no payload");

  const before = store.selection;
  assert.equal(store.select([o[1], o[0]]), false, 'the same set in another order');
  assert.equal(store.select(new Set([o[0], o[1]])), false);
  assert.equal(log.length, 1);
  assert.equal(store.selection, before);

  store.select([s[0]], { add: true });
  assert.deepEqual([...store.selection], [o[0], o[1], s[0]]);
  assert.notEqual(store.selection, before, 'the Set is replaced, never mutated');
  assert.deepEqual([...before], [o[0], o[1]], 'a reference somebody kept is a snapshot');
  assert.equal(store.select([o[0]], { add: true }), false);

  store.select([o[0], map.start], { toggle: true });
  assert.deepEqual([...store.selection], [o[1], s[0], map.start]);
  assert.equal(store.select([o[0], o[0]], { toggle: true }), true, 'an item given twice is toggled once');
  assert.equal(store.selection.has(o[0]), true);

  store.select(o[2]);
  assert.deepEqual([...store.selection], [o[2]], 'one item instead of a list');

  const n = log.length;
  assert.equal(store.select([cmd.clone(o[0]), map.fallback, null, 7]), true, 'things that are not in the map are ignored: this clears');
  assert.equal(store.selection.size, 0);
  assert.equal(store.clearSelection(), false);
  assert.equal(log.length, n + 1);
});

test('selected(kind) lists the selection in map order', () => {
  const { store, map, o, s, c, n, r } = world();
  store.select([map.start, r[1], n[0], c[1], s[1], o[3], o[0], s[0], r[0], o[2]]);
  assert.deepEqual(store.selected(), [o[0], o[2], o[3], s[0], s[1], c[1], n[0], r[0], r[1], map.start]);
  assert.deepEqual(store.selected('object'), [o[0], o[2], o[3]]);
  assert.deepEqual(store.selected('spawn'), [s[0], s[1]]);
  assert.deepEqual(store.selected('chest'), [c[1]]);
  assert.deepEqual(store.selected('start'), [map.start]);
  store.clearSelection();
  assert.deepEqual(store.selected('object'), []);
  // map order, not selection order, also after the order of a list changed
  store.select([r[0], r[1]]);
  store.exec(cmd.reorder('region', r[0], 1));
  assert.deepEqual(store.selected('region'), [r[1], r[0]]);
});

test('expandGroups adds every other member of the groups, across kinds, and knows no layers', () => {
  const { store, map, o, s, c, n, r } = world();
  assert.deepEqual(store.expandGroups([o[1]]), [o[1], s[1], c[1]]);
  assert.deepEqual(store.expandGroups([c[1], o[0]]), [c[1], o[0], o[1], s[1]]);
  assert.deepEqual(store.expandGroups([o[0]]), [o[0]], 'no group');
  assert.deepEqual(store.expandGroups([o[0], o[0]]), [o[0]]);
  assert.deepEqual(store.expandGroups([r[0], map.start, o[3]]), [r[0], map.start, o[3]], 'regions and the start have no group');
  assert.deepEqual(store.expandGroups(new Set([n[1], o[3]])), [n[1], o[3]]);
  assert.deepEqual(store.expandGroups([]), []);
  // a group renamed by a command is found under its new name
  store.exec(cmd.set([o[0]], { g: 'g7' }));
  assert.deepEqual(store.expandGroups([n[1]]), [n[1], o[0]]);
});

test('newGroupIds: distinct, unused, smallest first, stateless', () => {
  const { store, o } = world();      // the fixture uses 'camp', 'g2' and 'g7'
  assert.deepEqual(store.newGroupIds(1), ['g1']);
  assert.deepEqual(store.newGroupIds(4), ['g1', 'g3', 'g4', 'g5']);
  assert.deepEqual(store.newGroupIds(7), ['g1', 'g3', 'g4', 'g5', 'g6', 'g8', 'g9']);
  assert.deepEqual(store.newGroupIds(0), []);
  assert.deepEqual(store.newGroupIds(2), store.newGroupIds(2), 'two calls before the items are added return the same ids');
  store.exec(cmd.set([o[0]], { g: 'g1' }));
  assert.deepEqual(store.newGroupIds(2), ['g3', 'g4']);
  store.exec(cmd.set([o[0], o[3]], { g: undefined }));
  assert.deepEqual(store.newGroupIds(3), ['g1', 'g2', 'g3']);
  store.exec(cmd.set([o[0]], { g: 'g01' }));       // not an id this function hands out: g1 stays free
  assert.deepEqual(store.newGroupIds(1), ['g1']);
  assert.throws(() => store.newGroupIds(-1), RangeError);
  assert.throws(() => store.newGroupIds(1.5), RangeError);
});

// ---------------------------------------------------------------- exec and the 'change' payload

test("exec: one 'change' with the complete Change, then 'history'; one undo step", () => {
  const { store, o } = world();
  const log = record(store);
  const change = store.exec(cmd.set([o[0]], { x: 11 }));
  assert.deepEqual(names(log), ['change', 'history']);
  assert.equal(log[0].length, 2);
  assert.equal(log[0][1], change, 'the listener gets the Change that exec returns');
  assert.equal(log[1].length, 1, "'history' carries no payload");
  assertChange(change, { updated: { objects: [o[0]] } });
  assert.equal(o[0].x, 11);
  assert.equal(store.canUndo, true);
  assert.equal(store.canRedo, false);
  assert.equal(store.dirty, true);
  assert.equal(store.undoLabel, 'Move 1 object');
  assert.throws(() => store.exec(null), TypeError);
  assert.throws(() => store.exec({ do() {} }), TypeError);
});

test('the Change of every kind of edit, with every key always present', () => {
  const { store, map, o, s, c, n, r } = world();
  const fresh = cmd.make('chest', { x: 30, z: 30 });
  assertChange(store.exec(cmd.add('chest', [fresh])), { added: { chests: [fresh] } });
  assertChange(store.exec(cmd.remove([o[1], n[0], fresh, map.start])), { removed: { objects: [o[1]], npcs: [n[0]], chests: [fresh] } });
  assertChange(store.exec(cmd.set([map.start, s[0]], { r: 6 })), { updated: { spawns: [s[0]], start: [map.start] } });
  assertChange(store.exec(cmd.setEach([c[0], r[0]], [{ gold: 50 }, { name: 'Old Town' }])), { updated: { chests: [c[0]], regions: [r[0]] } });
  assertChange(store.exec(cmd.transform(cmd.snapshot([o[0], r[1]]), { dx: 1 })), { updated: { objects: [o[0]], regions: [r[1]] } });
  assertChange(store.exec(cmd.reorder('region', r[0], 1)), { order: ['regions'] });
  const i = cellIndex(map.ground, 0, 0), size = map.ground.size, mid = (size - 1) / 2;
  assertChange(store.exec(cmd.paint([i, i + 1, i + size], GROUND_INDEX.dirt)), { ground: { ix0: mid, iz0: mid, ix1: mid + 1, iz1: mid + 1 } });
  assertChange(store.exec(cmd.setProps({ name: 'Elsewhere', foliage: false })), { props: ['name', 'foliage'] });
  assertChange(store.exec(cmd.setProps({ radius: 300 })), { props: ['radius', 'ground'] });
  assertChange(store.exec(cmd.setProps({ fallback: { mood: 'cursed' } })), { props: ['fallback'] });
  const twin = cmd.clone(o[0]);
  assertChange(store.exec(cmd.batch('Twin', [cmd.add('object', [twin]), cmd.set([twin, o[2]], { y: 2 })])), { added: { objects: [twin] }, updated: { objects: [o[2]] } });
});

test("undo and redo: one 'change' per command with origin 'undo' / 'redo', then 'history'; the label is returned", () => {
  const { store, map, o } = world();
  const text = bytes(map);
  store.exec(cmd.set([o[0]], { ry: Math.PI / 2 }));
  const done = bytes(map);
  store.select([o[0]]);
  const log = record(store);

  assert.equal(store.undo(), 'Rotate 1 object');
  assert.deepEqual(names(log), ['change', 'history']);
  assertChange(log[0][1], { updated: { objects: [o[0]] }, origin: 'undo' });
  assert.equal(bytes(map), text);
  assert.equal(store.canUndo, false);
  assert.equal(store.canRedo, true);
  assert.equal(store.redoLabel, 'Rotate 1 object');
  assert.equal(store.undo(), null, 'nothing left');

  log.length = 0;
  assert.equal(store.redo(), 'Rotate 1 object');
  assert.deepEqual(names(log), ['change', 'history']);
  assertChange(log[0][1], { updated: { objects: [o[0]] }, origin: 'redo' });
  assert.equal(bytes(map), done);
  assert.equal(store.canRedo, false);
  assert.equal(store.redo(), null);
  assert.equal(log.length, 2, 'a refused redo emits nothing');
});

test('a new command clears what could be redone', () => {
  const { store, o } = world();
  store.exec(cmd.set([o[0]], { x: 1 }));
  store.exec(cmd.set([o[0]], { x: 2 }));
  store.undo();
  assert.equal(store.canRedo, true);
  store.exec(cmd.set([o[1]], { z: 3 }));
  assert.equal(store.canRedo, false);
  assert.equal(store.redo(), null);
  assert.equal(o[0].x, 1);
  // ... and so does a committed group, but not a cancelled one and not an empty one
  store.undo();
  store.begin('Nothing');
  store.commit();
  assert.equal(store.canRedo, true);
  store.begin('Cancelled');
  store.exec(cmd.set([o[0]], { x: 9 }));
  store.cancel();
  assert.equal(store.canRedo, true);
  store.begin('Edit');
  store.exec(cmd.set([o[0]], { x: 9 }));
  store.commit();
  assert.equal(store.canRedo, false);
});

test('dirty follows the undo position against the saved point', () => {
  const { store, o } = world();
  const step = (x) => store.exec(cmd.set([o[0]], { x }));
  assert.equal(store.dirty, false);
  step(1);
  assert.equal(store.dirty, true);
  store.undo();
  assert.equal(store.dirty, false, 'undone back to what was loaded');
  store.redo();
  assert.equal(store.dirty, true);

  const log = record(store);
  store.markSaved();
  assert.deepEqual(log, [['history']]);
  assert.equal(store.dirty, false);
  step(2);
  step(3);
  assert.equal(store.dirty, true);
  store.undo();
  assert.equal(store.dirty, true);
  store.undo();
  assert.equal(store.dirty, false, 'back at the saved point');
  store.undo();
  assert.equal(store.dirty, true, 'before the saved point');
  store.redo();
  assert.equal(store.dirty, false);

  // a new command after undoing past the saved point: that point cannot be reached again
  store.undo();
  step(4);
  assert.equal(store.dirty, true);
  store.undo();
  assert.equal(store.dirty, true);
  store.redo();
  assert.equal(store.dirty, true);
  store.markSaved();
  assert.equal(store.dirty, false);

  // loaded dirty: nothing was ever saved, whatever the position
  store.load(emptyMap(), { dirty: true });
  assert.equal(store.dirty, true);
  store.exec(cmd.setProps({ name: 'Draft' }));
  store.undo();
  assert.equal(store.dirty, true);
  store.markSaved();
  assert.equal(store.dirty, false);
  store.redo();
  assert.equal(store.dirty, true);
});

// ---------------------------------------------------------------- groups

test('begin / exec / commit: many commands, ONE undo step', () => {
  const { store, map, o, s } = world();
  const text = bytes(map), log = record(store);
  store.begin('Arrange');
  assert.equal(store.grouping, true);
  assert.deepEqual(names(log), ['history']);
  store.exec(cmd.set([o[0]], { x: 1 }));
  store.exec(cmd.remove([s[0]]));
  store.exec(cmd.setProps({ name: 'Renamed' }));
  assert.deepEqual(names(log), ['history', 'change', 'change', 'change'], "inside a group exec emits 'change' only");
  assert.equal(store.dirty, false, 'the position moves when the group is committed');
  assert.equal(store.canUndo, false);
  assert.equal(store.undo(), null, 'undo is a no-op while a group is open');
  assert.equal(store.redo(), null);
  assert.equal(o[0].x, 1);

  log.length = 0;
  assert.equal(store.commit(), true);
  assert.deepEqual(log, [['history']], "commit emits 'history' only");
  assert.equal(store.grouping, false);
  assert.equal(store.canUndo, true);
  assert.equal(store.dirty, true);
  assert.equal(store.undoLabel, 'Arrange');
  const done = bytes(map);

  log.length = 0;
  assert.equal(store.undo(), 'Arrange');
  assert.deepEqual(names(log), ['change', 'change', 'change', 'selection', 'history']);
  assert.deepEqual(log.slice(0, 3).map((e) => e[1].props.length + e[1].added.spawns.length * 2 + e[1].updated.objects.length * 3), [1, 2, 3], 'in reverse order');
  assert.ok(log.slice(0, 3).every((e) => e[1].origin === 'undo'));
  assert.equal(bytes(map), text);
  assert.equal(store.canUndo, false);
  assert.equal(store.dirty, false);

  log.length = 0;
  assert.equal(store.redo(), 'Arrange');
  assert.deepEqual(log.slice(0, 3).map((e) => e[1].props.length + e[1].removed.spawns.length * 2 + e[1].updated.objects.length * 3), [3, 2, 1], 'in order');
  assert.ok(log.slice(0, 3).every((e) => e[1].origin === 'redo'));
  assert.equal(bytes(map), done);
});

test('undo and redo do nothing while a group is open', () => {
  const { store, o } = world();
  store.exec(cmd.set([o[0]], { x: 1 }));
  store.exec(cmd.set([o[0]], { x: 2 }));
  store.undo();                                    // one step to undo, one to redo
  const log = record(store);
  store.begin('Drag');
  store.exec(cmd.set([o[1]], { x: 5 }));
  assert.equal(store.canUndo, false);
  assert.equal(store.canRedo, false);
  assert.equal(store.undo(), null);
  assert.equal(store.redo(), null);
  assert.deepEqual([o[0].x, o[1].x], [1, 5], 'neither the history nor the open group moved');
  assert.deepEqual(names(log), ['history', 'change']);
  store.cancel();
  assert.equal(store.canUndo, true);
  assert.equal(store.canRedo, true);
  assert.equal(store.redo(), 'Move 1 object');
  assert.equal(o[0].x, 2);
  assert.equal(store.undo(), 'Move 1 object');
  assert.equal(store.undo(), 'Move 1 object');
  assert.equal(o[0].x, 10);
});

test('group misuse: a nested begin throws, commit and cancel without a group do nothing, an empty group leaves no step', () => {
  const { store, o } = world();
  store.begin('Outer');
  assert.throws(() => store.begin('Inner'), /'Outer' is still open/);
  assert.equal(store.grouping, true, 'the outer group survives the refused begin');
  store.exec(cmd.set([o[0]], { x: 1 }));
  assert.equal(store.commit(), true);
  assert.equal(store.undoLabel, 'Outer');

  const log = record(store);
  assert.equal(store.commit(), false, 'a field that was left untouched commits on blur');
  assert.equal(store.cancel(), false);
  assert.deepEqual(log, []);

  store.begin('Nothing');
  assert.equal(store.commit(), false);
  assert.deepEqual(names(log), ['history', 'history'], "an empty group still says that it closed");
  assert.equal(store.undoLabel, 'Outer', 'no step for an empty group');
  assert.equal(store.grouping, false);

  // a group may be opened again right after a commit or a cancel
  store.begin('Next');
  store.cancel();
  store.begin('Next');
  store.commit();
  assert.equal(store.grouping, false);
});

test("cancel undoes the group in reverse order with origin 'cancel' and puts the selection back", () => {
  const { store, map, o, s } = world();
  const text = bytes(map);
  store.exec(cmd.set([s[0]], { count: 5 }));
  const saved = bytes(map);
  store.select([o[0], o[1]]);

  // what edit.duplicate does: add the copies, select them, move them - and then Esc
  store.begin('Duplicate 2 objects');
  const copies = [cmd.clone(o[0]), cmd.clone(o[1])];
  store.exec(cmd.add('object', copies));
  store.select(copies);
  const snap = cmd.snapshot(copies);
  store.exec(cmd.transform(snap, { dx: 3, dz: 1 }));
  store.exec(cmd.transform(snap, { dx: 4, dz: 2 }));
  assert.equal(map.objects.length, 6);
  assert.equal(copies[0].x, o[0].x + 4);

  const log = record(store);
  assert.equal(store.cancel(), true);
  assert.deepEqual(names(log), ['change', 'change', 'selection', 'history']);
  assertChange(log[0][1], { updated: { objects: copies }, origin: 'cancel' });
  assertChange(log[1][1], { removed: { objects: copies }, origin: 'cancel' });
  assert.equal(bytes(map), saved);
  assert.equal(map.objects.length, 4);
  assert.deepEqual([...store.selection], [o[0], o[1]], 'the selection as begin() found it');
  assert.equal(store.grouping, false);
  assert.equal(store.undoLabel, 'Edit 1 spawn', 'the cancelled group left no step');
  assert.equal(store.canRedo, false);
  store.undo();
  assert.equal(bytes(map), text);
});

test('cancel restores only the part of the old selection that still exists', () => {
  const { store, map, o } = world();
  store.select([o[0], o[1]]);
  store.begin('Edit');
  store.exec(cmd.remove([o[0]]));
  assert.deepEqual([...store.selection], [o[1]]);
  store.select([o[2]]);
  store.cancel();
  assert.deepEqual([...store.selection], [o[0], o[1]], 'the removed item is back, and so is its place in the selection');
  assert.equal(map.objects[0], o[0]);
});

test('inside a group a command is offered to the previous one: a drag, a stroke and a scrub stay one small step', () => {
  const { store, map, o } = world();
  const text = bytes(map);
  const countUndo = () => {
    let n = 0;
    const off = store.on('change', () => n++);
    store.undo();
    off();
    return n;
  };

  // a drag: 50 transforms of one snapshot
  const snap = cmd.snapshot([o[0], o[1]]);
  store.begin('Move 2 objects');
  for (let i = 1; i <= 50; i++) store.exec(cmd.transform(snap, { dx: i * 0.1 }));
  store.commit();
  assert.equal(o[0].x, 15);
  assert.equal(countUndo(), 1);
  assert.equal(bytes(map), text);
  store.redo();
  assert.equal(o[0].x, 15, 'the redo applies the last of the 50');
  store.undo();

  // a stroke: paints grow one command; objects added along the way grow another
  const i0 = cellIndex(map.ground, 0, 0);
  store.begin('Paint');
  for (let k = 0; k < 20; k++) store.exec(cmd.paint([i0 + k, i0 + k + 1], GROUND_INDEX.dirt));
  for (let k = 0; k < 20; k++) store.exec(cmd.add('object', [cmd.make('object', { m: 'medieval/barrel', x: k, z: 60 })]));
  store.commit();
  assert.equal(map.objects.length, 24);
  assert.equal(countUndo(), 2);
  assert.equal(bytes(map), text);

  // a scrubbed field: the same keys on the same items
  store.begin('Scale');
  for (let k = 1; k <= 30; k++) store.exec(cmd.set([o[0], o[1]], { s: 1 + k / 100 }));
  store.commit();
  assert.equal(o[1].s, 1.3);
  assert.equal(countUndo(), 1);
  assert.equal(bytes(map), text);

  // commands that do not belong together stay apart
  store.begin('Mixed');
  store.exec(cmd.set([o[0]], { s: 2 }));
  store.exec(cmd.set([o[0]], { y: 2 }));               // other keys
  store.exec(cmd.set([o[1]], { y: 2 }));               // other items
  store.exec(cmd.transform(snap, { dx: 1 }));
  store.exec(cmd.transform(cmd.snapshot([o[0], o[1]]), { dx: 2 }));   // another snapshot
  store.commit();
  assert.equal(countUndo(), 5);
  assert.equal(bytes(map), text);
});

test('outside a group nothing is merged: every exec is its own step', () => {
  const { store, o } = world();
  const snap = cmd.snapshot([o[0]]);
  store.exec(cmd.transform(snap, { dx: 1 }));
  store.exec(cmd.transform(snap, { dx: 2 }));
  assert.equal(o[0].x, 12);
  store.undo();
  assert.equal(o[0].x, 11);
  store.undo();
  assert.equal(o[0].x, 10);
});

// ---------------------------------------------------------------- the selection through edits

test('removed items leave the selection - before the change is announced', () => {
  const { store, o } = world();
  store.select([o[0], o[1]]);
  const seen = [], log = record(store);
  store.on('change', () => seen.push([...store.selection]));
  store.exec(cmd.remove([o[0]]));
  assert.deepEqual(names(log), ['change', 'selection', 'history']);
  assert.deepEqual(seen, [[o[1]]], 'a change listener never sees a removed item selected');
  assert.deepEqual([...store.selection], [o[1]]);
  // removing what is not selected says nothing about the selection
  log.length = 0;
  store.exec(cmd.remove([o[2]]));
  assert.deepEqual(names(log), ['change', 'history']);
});

test('after undo / redo the selection is what the step touched and still exists', () => {
  const { store, map, o, s } = world();
  // undo of a remove: the items are back and selected
  store.select([s[0]]);
  store.exec(cmd.remove([o[0], o[2]]));
  store.undo();
  assert.deepEqual(store.selected(), [o[0], o[2]]);
  // redo of the remove: nothing it touched exists
  store.redo();
  assert.equal(store.selection.size, 0);
  store.undo();

  // undo of an add: the added items are gone, and with them the selection
  const fresh = [cmd.make('npc', { x: 1, z: 1 }), cmd.make('npc', { x: 2, z: 2 })];
  store.exec(cmd.add('npc', fresh));
  store.select(fresh);
  store.undo();
  assert.equal(store.selection.size, 0);
  assert.equal(map.npcs.length, 2);
  // redo of the add: they are selected again
  store.redo();
  assert.deepEqual(store.selected(), fresh);

  // an edit: undo selects what it restored
  store.clearSelection();
  store.exec(cmd.set([o[1], map.start], { x: 3 }));
  store.select([s[1]]);
  store.undo();
  assert.deepEqual(store.selected(), [o[1], map.start]);

  // a group that adds and removes: only what exists afterwards
  store.begin('Swap');
  const twin = cmd.clone(o[3]);
  store.exec(cmd.add('object', [twin]));
  store.exec(cmd.remove([o[3]]));
  store.commit();
  store.undo();
  assert.deepEqual(store.selected(), [o[3]]);
  store.redo();
  assert.deepEqual(store.selected(), [twin]);
});

test('undo / redo of an edit of the selection gives the WHOLE selection back, also the part the edit left as it was', () => {
  const { store, map, o, s } = world();
  // "Align X" on three objects: one of them stands there already, so the command changes two (setEach never even
  // hears of the third). Undoing it must not leave two selected - the next button would work on two.
  const three = [o[0], o[1], o[2]];
  store.select(three);
  const x = o[0].x;
  store.exec(cmd.setEach([o[1], o[2]], [{ x }, { x }]));
  store.select([s[0]]);                                          // looked at something else in between
  store.undo();
  assert.deepEqual(store.selected(), three);
  store.select([s[0]]);
  store.redo();
  assert.deepEqual(store.selected(), three);
  // the same for a group (a drag, a typed field): the selection its begin() found
  store.select(three);
  store.begin('Drop');
  store.exec(cmd.set([o[2]], { y: 2 }));
  store.commit();
  store.clearSelection();
  store.undo();
  assert.deepEqual(store.selected(), three);
  // of that selection only what still exists
  store.select(three);
  store.exec(cmd.set([o[1]], { x: 77 }));
  store.exec(cmd.remove([o[0]]));
  store.undo();                                                  // o[0] is back (and it alone was touched)
  store.select([]);
  store.undo();                                                  // the edit of o[1], made with all three selected
  assert.deepEqual(store.selected(), three);
  store.redo();
  store.redo();                                                  // the remove again
  store.undo();
  store.undo();
  assert.deepEqual(store.selected(), three);
  // an edit of items that were NOT the selection (a panel that edits what it lists) still selects what it touched
  store.select([s[0]]);
  store.exec(cmd.set([o[1], o[2]], { y: 1 }));
  store.undo();
  assert.deepEqual(store.selected(), [o[1], o[2]]);
  // ... and so does an edit that reached beyond the selection it was made with
  store.select([o[1]]);
  store.exec(cmd.set([o[1], o[2]], { y: 3 }));
  store.select([map.start]);
  store.undo();
  assert.deepEqual(store.selected(), [o[1], o[2]]);
});

test('steps that touch no item leave the selection alone', () => {
  const { store, map, o, r } = world();
  store.select([o[0], r[0]]);
  const sel = store.selection;
  store.exec(cmd.paint([cellIndex(map.ground, 0, 0)], GROUND_INDEX.sand));
  store.exec(cmd.setProps({ name: 'Other', radius: 280 }));
  store.exec(cmd.reorder('region', r[0], 1));
  const log = record(store);
  for (let i = 0; i < 3; i++) store.undo();
  for (let i = 0; i < 3; i++) store.redo();
  assert.equal(store.selection, sel);
  assert.ok(!names(log).includes('selection'));
});

// ---------------------------------------------------------------- history budget, empty commands, listeners

test('the history keeps hundreds of steps and drops the oldest when the byte budget is spent', () => {
  const { store, o } = world();
  for (let i = 1; i <= 300; i++) store.exec(cmd.set([o[0]], { x: i }));
  let n = 0;
  while (store.undo() !== null) n++;
  assert.equal(n, 300, 'at least 200 steps within the default 64 MB');
  assert.equal(o[0].x, 10);

  // a tight budget: the sum of command.bytes rules
  const small = world({ maxUndoBytes: 3000 });
  assert.equal(small.store.maxUndoBytes, 3000);
  for (let i = 1; i <= 50; i++) small.store.exec(cmd.set([small.o[0]], { x: i }));
  let kept = 0;
  while (small.store.undo() !== null) kept++;
  assert.ok(kept >= 1 && kept < 50, `kept ${kept} of 50`);
  assert.equal(small.o[0].x, 50 - kept, 'the oldest steps went first');
  assert.equal(small.store.dirty, true, 'the loaded state is out of reach');
  while (small.store.redo() !== null);
  assert.equal(small.o[0].x, 50);

  // one step larger than the whole budget is still kept: the last edit can always be undone
  const tiny = world({ maxUndoBytes: 1 });
  tiny.store.exec(cmd.set([tiny.o[0]], { x: 1 }));
  tiny.store.exec(cmd.set([tiny.o[0]], { x: 2 }));
  assert.equal(tiny.store.undo(), 'Move 1 object');
  assert.equal(tiny.o[0].x, 1);
  assert.equal(tiny.store.undo(), null);
});

test('dirty stays right when the history drops steps around the saved one', () => {
  // how many steps of this size the budget holds
  const probe = world({ maxUndoBytes: 3000 });
  for (let i = 1; i <= 40; i++) probe.store.exec(cmd.set([probe.o[0]], { x: i }));
  let room = 0;
  while (probe.store.undo() !== null) room++;
  assert.ok(room >= 2 && room < 40);

  for (const [extra, dirty] of [[room, false], [room + 1, true]]) {
    const { store, o } = world({ maxUndoBytes: 3000 });
    store.exec(cmd.set([o[0]], { x: 100 }));
    store.markSaved();
    for (let i = 1; i <= extra; i++) store.exec(cmd.set([o[0]], { x: 100 + i }));
    while (store.undo() !== null);
    // with exactly `room` later steps the saved step was the last one dropped: undoing everything lands on it.
    // One step more and the state under the history is already past it.
    assert.equal(o[0].x, dirty ? 101 : 100);
    assert.equal(store.dirty, dirty);
  }
});

test('a command that changes nothing leaves no trace', () => {
  const { store, map, o } = world();
  store.exec(cmd.set([o[0]], { x: 1 }));
  store.undo();
  const log = record(store), text = bytes(map);
  const nothing = [
    cmd.remove([map.start]),                         // the start is skipped
    cmd.remove([cmd.clone(o[0])]),                   // not in the map
    cmd.add('object', []),
    cmd.set([o[0]], { x: o[0].x, g: null }),         // the values it already has
    cmd.set([o[0]], { x: o[0].x + 0.001 }),          // ... after quantising
    cmd.setEach([o[0], o[1]], [{}, { name: 'not a field of an object' }]),
    cmd.transform(cmd.snapshot([o[0], o[1]]), {}),
    cmd.reorder('region', map.regions[0], 0),
    cmd.paint([cellIndex(map.ground, 0, 0)], GROUND_INDEX.grass),
    cmd.setProps({ name: map.name, radius: map.radius, foliage: map.foliage, fallback: { ...map.fallback } }),
    cmd.batch('Nothing', []),
  ];
  for (const command of nothing) {
    const change = store.exec(command);
    assert.ok(isEmptyChange(change), command.label);
    assert.equal(change.origin, 'do');
  }
  assert.deepEqual(log, [], 'no event');
  assert.equal(store.canUndo, false, 'no step');
  assert.equal(store.canRedo, true, 'and what could be redone still can');
  assert.equal(store.dirty, false);
  assert.equal(bytes(map), text);
  store.begin('Nothing');
  for (const command of [cmd.remove([map.start]), cmd.set([o[0]], { x: o[0].x })]) store.exec(command);
  assert.equal(store.commit(), false);
  assert.equal(store.canUndo, false);
});

test('a group that ends where it started leaves no step, keeps what could be redone and stays clean', () => {
  const { store, map, o, s, r } = world();
  store.exec(cmd.set([o[3]], { y: 3 }));
  store.undo();                                      // one step to redo: a new step would wipe it
  const text = bytes(map), log = record(store);
  const closed = (what) => {
    assert.equal(store.commit(), false, `${what}: commit says that nothing was pushed`);
    assert.equal(store.grouping, false);
    assert.equal(store.canUndo, false, `${what}: no step`);
    assert.equal(store.canRedo, true, `${what}: what could be redone still can`);
    assert.equal(store.dirty, false, `${what}: the map is what was saved`);
    assert.equal(bytes(map), text);
    assert.equal(names(log).at(-1), 'history', "the closed group is announced with 'history' all the same");
    assert.ok(!names(log).includes('selection'));
  };

  // a drag out and back: merged transforms of one snapshot, the last one home (with snapping, any small wobble)
  const snap = cmd.snapshot([o[0], o[1], r[1]]);
  store.begin('Move 3 items');
  for (const dx of [1, 2, 0]) store.exec(cmd.transform(snap, { dx }));
  assert.equal(names(log).filter((e) => e === 'change').length, 3, 'the view followed every move, the way back included');
  closed('drag');

  // a field typed in and put back: merged sets of one key
  store.begin('Move 1 object');
  store.exec(cmd.set([o[0]], { x: o[0].x + 1 }));
  store.exec(cmd.set([o[0]], { x: o[0].x - 1 }));
  closed('field');

  // a rim dragged out and home; and two separate edits that both came back
  store.begin('Resize spawn');
  store.exec(cmd.set([s[1]], { r: 20 }));
  store.exec(cmd.set([s[1]], { r: 12 }));
  closed('rim');
  store.begin('Edit');
  store.exec(cmd.set([o[0]], { s: 2 }));
  store.exec(cmd.transform(cmd.snapshot([o[1]]), { dz: 4 }));      // another command: not merged
  store.exec(cmd.set([o[0]], { s: 1 }));                           // nor is this one: the previous command is the transform
  assert.equal(store.commit(), true, 'three commands, and only the first can vouch for o[0]: kept');
  assert.equal(store.undo(), 'Edit');
  assert.equal(bytes(map), text);
  store.begin('Edit');
  const two = cmd.snapshot([o[1]]);
  store.exec(cmd.set([o[0]], { s: 2 }));
  store.exec(cmd.set([o[0]], { s: 1 }));
  store.exec(cmd.transform(two, { dz: 4 }));
  store.exec(cmd.transform(two, {}));
  assert.equal(store.commit(), false, 'two commands, each of them home');
  assert.equal(store.redoLabel, 'Edit', 'and the step undone just before can still be redone');
  assert.equal(bytes(map), text);

  // what really changed is a step like any other - and so is everything a command cannot vouch for
  store.begin('Move 1 object');
  store.exec(cmd.transform(snap, { dx: 1 }));
  store.exec(cmd.transform(snap, { dx: 0.5 }));
  assert.equal(store.commit(), true);
  assert.equal(store.undo(), 'Move 1 object');
  const copy = cmd.clone(o[0]), copySnap = cmd.snapshot([copy]);
  store.begin('Duplicate 1 object');                 // a copy dropped where it was made is still a copy
  store.exec(cmd.add('object', [copy]));
  store.exec(cmd.transform(copySnap, { dx: 2 }));
  store.exec(cmd.transform(copySnap, {}));
  assert.equal(store.commit(), true);
  assert.equal(map.objects.length, 5);
  assert.equal(store.undo(), 'Duplicate 1 object');
  const plain = { label: 'Hand-written', bytes: 8, do: () => ({ props: ['name'] }), undo: () => ({ props: ['name'] }) };
  store.begin('Plain');
  store.exec(plain);
  assert.equal(store.commit(), true, 'a command without unchanged() has changed something');
  store.undo();
  store.begin('Moody');
  store.exec({ ...plain, unchanged() { throw new Error('cannot tell'); } });
  assert.equal(store.commit(), true, 'and so has one that cannot tell');
  store.undo();
  store.begin('Vague');
  store.exec({ ...plain, unchanged: () => 1 });
  assert.equal(store.commit(), true, 'only a plain true counts');
  store.undo();
  assert.equal(bytes(map), text);
});

test('a listener that throws stops neither the other listeners nor the edit', () => {
  const { store, o } = world();
  let heard = 0;
  store.on('change', () => { throw new Error('a broken panel'); });
  store.on('change', () => heard++);
  const errors = quiet(() => {
    store.exec(cmd.set([o[0]], { x: 1 }));
    store.exec(cmd.set([o[0]], { x: 2 }));
  });
  assert.equal(heard, 2);
  assert.equal(errors.length, 1, 'logged once per listener');
  assert.match(String(errors[0][0]), /'change' listener failed/);
  assert.equal(store.canUndo, true);
  quiet(() => { store.undo(); store.undo(); });
  assert.equal(o[0].x, 10);
});

test('on() returns an unsubscribe and refuses unknown events', () => {
  const { store, o } = world();
  let n = 0;
  const off = store.on('change', () => n++);
  store.exec(cmd.set([o[0]], { x: 1 }));
  off();
  off();
  store.exec(cmd.set([o[0]], { x: 2 }));
  assert.equal(n, 1);
  assert.throws(() => store.on('changed', () => {}), /no such event/);
  assert.throws(() => store.on('change', 'not a function'), TypeError);
  // a listener that unsubscribes itself does not disturb the one after it
  let a = 0, b = 0;
  const offA = store.on('history', () => { a++; offA(); });
  store.on('history', () => b++);
  store.markSaved();
  store.markSaved();
  assert.deepEqual([a, b], [1, 2]);
});

test('the map cannot be edited from a change listener while a step is being undone', () => {
  const { store, map, o } = world();
  const text = bytes(map);
  store.begin('Two');
  store.exec(cmd.set([o[0]], { x: 1 }));
  store.exec(cmd.set([o[1]], { x: 2 }));
  store.commit();
  const off = store.on('change', (change) => { if (change.origin === 'undo') store.exec(cmd.set([o[2]], { x: 3 })); });
  const errors = quiet(() => store.undo());
  off();
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][1]), /not possible from a 'change' listener/);
  assert.equal(bytes(map), text, 'the undo itself went through');
  // from an ordinary change it is allowed: the step is already in the history
  const once = store.on('change', () => { once(); store.exec(cmd.set([o[2]], { y: 1 })); });
  store.exec(cmd.set([o[0]], { y: 1 }));
  store.undo();
  store.undo();
  assert.equal(bytes(map), text);
});

test('emptyChange and isEmptyChange', () => {
  const change = emptyChange();
  assert.deepEqual(change, {
    added: { objects: [], spawns: [], chests: [], npcs: [], regions: [] },
    removed: { objects: [], spawns: [], chests: [], npcs: [], regions: [] },
    updated: { objects: [], spawns: [], chests: [], npcs: [], regions: [], start: [] },
    order: [], ground: null, props: [], origin: 'do',
  });
  assert.equal(isEmptyChange(change), true);
  assert.notEqual(emptyChange().added.objects, change.added.objects, 'a fresh object every time');
  for (const touch of [(c) => c.added.npcs.push({}), (c) => c.removed.objects.push({}), (c) => c.updated.start.push({}),
    (c) => c.order.push('regions'), (c) => { c.ground = { ix0: 0, iz0: 0, ix1: 0, iz1: 0 }; }, (c) => c.props.push('name')]) {
    const c = emptyChange('undo');
    touch(c);
    assert.equal(isEmptyChange(c), false);
  }
});

test('a hand-written command with a partial Change is completed by the store', () => {
  const { store, map } = world();
  let changes = [];
  store.on('change', (c) => changes.push(c));
  const rename = (to) => ({
    label: 'Rename', bytes: 10, was: null,
    do(m) { this.was = m.name; m.name = to; return { props: ['name'] }; },
    undo(m) { m.name = this.was; return { props: ['name'] }; },
  });
  store.exec(rename('A'));
  store.undo();
  assert.equal(map.name, 'New map');
  assert.deepEqual(changes, [changeOf({ props: ['name'] }), changeOf({ props: ['name'], origin: 'undo' })]);
  changes = [];
  store.exec({ label: 'Nothing', bytes: 0, do() {}, undo() {} });
  assert.deepEqual(changes, []);
});

// ---------------------------------------------------------------- ui

test('ui: the defaults of the editor state', () => {
  const ui = createUi({ storage: null });
  assert.equal(ui.tool, null);
  assert.equal(ui.prevTool, 'select');
  assert.deepEqual(Object.keys(ui.layers), LAYERS);
  for (const layer of LAYERS) assert.deepEqual(ui.layers[layer], { visible: true, locked: false });
  assert.deepEqual(ui.overlays, { grid: true, boundary: true, regiontint: false, colliders: false, threat: false, labels: true, levelColors: false });
  assert.ok(ui.hiddenModels instanceof Set && ui.hiddenModels.size === 0);
  assert.deepEqual(ui.snap, { on: false, step: 1, angle: Math.PI / 12 });
  assert.ok(SNAP_STEPS.includes(ui.snap.step));
  assert.equal(ui.axes, 'world');
  assert.deepEqual(ui.models, []);
  assert.equal(Number.isInteger(ui.groundType), true);
  assert.equal(ui.cursor, null);
  assert.equal(ui.preview, 'neutral');
  assert.equal(ui.readOnly, false);
  assert.deepEqual(ui.issues, { errors: 0, warnings: 0 });
  assert.equal(ui.status, '');
  assert.deepEqual(ui.collapsed, {});
});

test('ui.set assigns and emits the key; ui.on returns an unsubscribe', () => {
  const ui = createUi({ storage: null });
  const log = [];
  const off = ui.on('snap', (...args) => log.push(args));
  const before = ui.snap, next = { ...ui.snap, on: true };
  ui.set('snap', next);
  assert.equal(ui.snap, next);
  assert.deepEqual(log, [[next, before]], 'listeners get the value and the previous one');
  ui.set('snap', next);
  assert.equal(log.length, 2, 'it always emits: setting the active tool again re-arms it');
  ui.set('axes', 'local');
  assert.equal(log.length, 2, 'only its own key');
  off();
  ui.set('snap', before);
  assert.equal(log.length, 2);

  ui.on('status', (text) => log.push(text));
  ui.setStatus('Ready');
  assert.equal(ui.status, 'Ready');
  // a note is a second line that covers the status for a moment: setting or clearing it leaves the status alone
  const notes = [];
  ui.on('note', (value) => notes.push(value));
  ui.setNote('Deleted 3 objects');
  assert.deepEqual([ui.note, ui.status], ['Deleted 3 objects', 'Ready']);
  ui.setNote(null);
  assert.deepEqual([ui.note, ui.status, notes], ['', 'Ready', ['Deleted 3 objects', '']]);
  assert.equal(log[2], 'Ready');

  assert.throws(() => ui.set('toast', 1), TypeError, 'a method is not a state key');
  assert.throws(() => ui.set('__proto__', {}), TypeError);
  assert.equal(typeof ui.toast, 'function');
});

test('ui.prevTool is the tool that was active before', () => {
  const ui = createUi({ storage: null });
  const log = [];
  ui.on('tool', (tool, previous) => log.push([tool, previous, ui.prevTool]));
  ui.set('tool', 'select');
  assert.equal(ui.prevTool, 'select');
  ui.set('tool', 'place');
  ui.set('tool', 'paste');
  assert.equal(ui.prevTool, 'place');
  ui.set('tool', 'paste');
  assert.equal(ui.prevTool, 'place', 'pasting again does not forget where to return to');
  ui.set('tool', ui.prevTool);
  assert.equal(ui.tool, 'place');
  assert.deepEqual(log, [['select', null, 'select'], ['place', 'select', 'select'], ['paste', 'place', 'place'], ['paste', 'paste', 'place'], ['place', 'paste', 'paste']]);
});

test('ui.isPickable: the layer, the item flags and the hidden models - one test for everybody', () => {
  const ui = createUi({ storage: null });
  const { map, o, s, r } = world();
  assert.equal(ui.isPickable('object', o[0]), true);
  assert.equal(ui.isPickable('start', map.start), true);

  ui.set('layers', { ...ui.layers, objects: { visible: false, locked: false } });
  assert.equal(ui.isPickable('object', o[0]), false, 'a hidden layer');
  assert.equal(ui.isPickable('spawn', s[0]), true);
  ui.set('layers', { ...ui.layers, objects: { visible: true, locked: true } });
  assert.equal(ui.isPickable('object', o[0]), false, 'a locked layer');
  ui.set('layers', { ...ui.layers, objects: { visible: true, locked: false } });

  ui.set('hiddenModels', new Set(['medieval/barrel']));
  assert.equal(ui.isPickable('object', o[0]), false, 'a model hidden in the Layers panel');
  assert.equal(ui.isPickable('object', o[2]), true);
  assert.equal(ui.isPickable('spawn', s[0]), true, 'hidden models concern objects only');
  ui.set('hiddenModels', new Set());

  const log = [];
  ui.on('itemflags', (e) => log.push(e));
  assert.equal(ui.itemFlag(r[0], 'hidden'), false);
  ui.setItemFlag(r[0], 'hidden', true);
  assert.equal(ui.itemFlag(r[0], 'hidden'), true);
  assert.equal(ui.itemFlag(r[0], 'locked'), false);
  assert.equal(ui.isPickable('region', r[0]), false);
  assert.equal(ui.isPickable('region', r[1]), true);
  ui.setItemFlag(r[0], 'hidden', true);
  assert.equal(log.length, 1, 'emitted when the flag changes');
  assert.deepEqual(log[0], { item: r[0], flag: 'hidden', on: true });
  ui.setItemFlag(r[0], 'hidden', false);
  ui.setItemFlag(r[1], 'locked', true);
  assert.equal(ui.isPickable('region', r[0]), true);
  assert.equal(ui.isPickable('region', r[1]), false);
  assert.equal(log.length, 3);
  assert.throws(() => ui.setItemFlag(r[0], 'frozen', true), TypeError);
  assert.equal(ui.itemFlag(r[0], 'frozen'), false);
  assert.equal(ui.isPickable('nonsense', o[0]), false);
});

test('ui persists layers, overlays, snap and the collapsed sections - and nothing else', () => {
  const storage = fakeStorage();
  const ui = createUi({ storage });
  assert.equal(storage.data.size, 0, 'nothing is written before something changes');
  ui.set('tool', 'place');
  ui.set('cursor', { x: 1, z: 2 });
  ui.set('hiddenModels', new Set(['medieval/barrel']));
  assert.equal(storage.data.size, 0);

  ui.set('snap', { on: true, step: 0.5, angle: Math.PI / 12 });
  ui.set('layers', { ...ui.layers, spawns: { visible: false, locked: true } });
  ui.set('overlays', { ...ui.overlays, regiontint: true, grid: false });
  ui.set('collapsed', { ...ui.collapsed, layers: true });
  const stored = JSON.parse(storage.data.get(STORAGE_KEY));
  assert.deepEqual(Object.keys(stored).sort(), ['collapsed', 'layers', 'overlays', 'snap', 'v']);

  const again = createUi({ storage });
  assert.deepEqual(again.snap, ui.snap);
  assert.deepEqual(again.layers, ui.layers);
  assert.deepEqual(again.overlays, ui.overlays);
  assert.deepEqual(again.collapsed, { layers: true });
  assert.equal(again.tool, null);
  assert.equal(again.hiddenModels.size, 0, 'hidden models are not persisted');
});

test('ui survives a storage that is empty, broken, old or full, and keeps keys that are not its own', () => {
  const defaults = createUi({ storage: null });
  for (const raw of [undefined, '', 'not json', 'null', '[]', '42', '{"layers":7,"overlays":[],"snap":"on","collapsed":3}']) {
    const ui = createUi({ storage: fakeStorage(raw === undefined ? {} : { [STORAGE_KEY]: raw }) });
    assert.deepEqual(ui.layers, defaults.layers, String(raw));
    assert.deepEqual(ui.overlays, defaults.overlays);
    assert.deepEqual(ui.snap, defaults.snap);
    assert.deepEqual(ui.collapsed, {});
  }
  // field by field: what is valid is taken, the rest falls back
  const partial = {
    layers: { objects: { visible: false, locked: 'yes' }, moon: { visible: false, locked: true }, spawns: null },
    overlays: { grid: false, threat: 1, unknown: true },
    snap: { on: true, step: 3, angle: -1 },
    collapsed: { layers: true, regions: false, minimap: 'yes' },
    stamps: { kept: 'for somebody else' },
  };
  const storage = fakeStorage({ [STORAGE_KEY]: JSON.stringify(partial) });
  const ui = createUi({ storage });
  assert.deepEqual(ui.layers.objects, { visible: false, locked: false });
  assert.deepEqual(ui.layers.spawns, { visible: true, locked: false });
  assert.equal('moon' in ui.layers, false);
  assert.deepEqual(ui.overlays, { ...defaults.overlays, grid: false });
  assert.deepEqual(ui.snap, { on: true, step: 1, angle: Math.PI / 12 });
  assert.deepEqual(ui.collapsed, { layers: true });
  ui.set('snap', { ...ui.snap, step: 2 });
  const stored = JSON.parse(storage.data.get(STORAGE_KEY));
  assert.deepEqual(stored.stamps, { kept: 'for somebody else' });
  assert.equal(stored.snap.step, 2);
  assert.equal('moon' in stored.layers, false);

  // a storage that throws: the editor works without remembering
  const hostile = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  const offline = createUi({ storage: hostile });
  assert.deepEqual(offline.snap, defaults.snap);
  offline.set('snap', { ...offline.snap, on: true });
  assert.equal(offline.snap.on, true);
});

test('ui works without a page: dialogs resolve as cancelled until a renderer is attached', async () => {
  const ui = createUi({ storage: null });
  assert.equal(await ui.confirm('Sure?'), false);
  assert.equal(await ui.choose('Which?', [{ id: 'a', label: 'A' }]), null);
  assert.equal(await ui.prompt('Token'), null);
  assert.equal(await ui.pickPoint('Click a point'), null);
  ui.setCursor('crosshair');
  ui.toast('early');
  ui.toast({ text: 'early too', action: { label: 'Undo', run() {} } }, 'warn');

  const calls = [];
  assert.equal(ui.attach({ toast: (text, level) => calls.push(['toast', text, level]) }), ui);
  assert.deepEqual(calls.map((c) => [typeof c[1] === 'string' ? c[1] : c[1].text, c[2]]), [['early', 'info'], ['early too', 'warn']], 'toasts raised before the renderer came are shown, not lost');
  ui.toast('now');
  assert.deepEqual(calls[2], ['toast', 'now', 'info']);
  ui.toast('bad', 'error');
  assert.deepEqual(calls[3], ['toast', 'bad', 'error']);

  // renderers arrive from several modules, a few at a time
  ui.attach({
    confirm: (text, options) => { calls.push(['confirm', text, options]); return true; },
    choose: async (text, options, extra) => { calls.push(['choose', text, extra]); return options[1].id; },
    prompt: (text, value) => `${value}!`,
  });
  ui.attach({ pickPoint: (label) => Promise.resolve({ x: 1, z: 2, label }), setCursor: (css) => calls.push(['cursor', css]) });
  assert.equal(await ui.confirm('Sure?'), true);
  assert.deepEqual(calls[4], ['confirm', 'Sure?', { ok: 'OK', cancel: 'Cancel', danger: false }]);
  // a destructive confirmation says so: the renderer then keeps the focus on Cancel, and Enter loses nothing
  await ui.confirm('Overwrite?', { ok: 'Overwrite', danger: true });
  assert.deepEqual(calls[5][2], { ok: 'Overwrite', cancel: 'Cancel', danger: true });
  assert.equal(await ui.choose('Which?', [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', danger: true }]), 'b');
  assert.deepEqual(calls.pop(), ['choose', 'Which?', { sticky: false }]);
  // a question that a stray click beside the dialog must not wave away
  await ui.choose('Restore?', [{ id: 'a' }, { id: 'b' }], { sticky: true });
  assert.deepEqual(calls.pop(), ['choose', 'Restore?', { sticky: true }]);
  assert.equal(await ui.prompt('Token', 'abc'), 'abc!');
  assert.equal(await ui.prompt('Token'), '!');
  assert.deepEqual(await ui.pickPoint('Face point'), { x: 1, z: 2, label: 'Face point' });
  ui.setCursor('grab');
  assert.deepEqual(calls.at(-1), ['cursor', 'grab']);

  assert.throws(() => ui.attach({ toasts: () => {} }), /unknown renderer/);
  assert.throws(() => ui.attach({ toast: 'no' }), TypeError);
  // a renderer that throws: a toast never throws, a dialog rejects
  ui.attach({ toast: () => { throw new Error('no #toasts'); }, confirm: () => { throw new Error('no #modal'); } });
  assert.equal(quiet(() => ui.toast('x')).length, 1);
  await assert.rejects(ui.confirm('x'), /no #modal/);
});

test('createEmitter: listeners in order, per event, safe against changes while emitting', () => {
  const events = createEmitter(), log = [];
  const offA = events.on('x', (v) => { log.push(`a${v}`); offA(); events.on('x', (w) => log.push(`late${w}`)); });
  events.on('x', (v) => log.push(`b${v}`));
  events.on('y', (v) => log.push(`y${v}`));
  events.emit('x', 1);
  events.emit('x', 2);
  events.emit('z', 3);
  assert.deepEqual(log, ['a1', 'b1', 'b2', 'late2']);
  assert.throws(() => events.on('x', null), TypeError);
});

// ---------------------------------------------------------------- actions

test('actions: register, run, has, enabled', () => {
  const toasts = [], ui = createUi({ storage: null }).attach({ toast: (text, level) => toasts.push([text, level]) });
  const actions = createActions(ui);
  const calls = [];
  let on = true;
  actions.register('edit.undo', (...args) => { calls.push(args); return 'ignored'; }, { enabled: () => on });
  assert.equal(actions.has('edit.undo'), true);
  assert.equal(actions.has('edit.redo'), false);
  assert.equal(actions.enabled('edit.undo'), true);
  assert.equal(actions.enabled('edit.redo'), false);

  assert.equal(actions.run('edit.undo'), true);
  assert.equal(actions.run('edit.undo', 1, 'two', [3]), true);
  assert.deepEqual(calls, [[], [1, 'two', [3]]], 'the arguments are passed on');

  on = false;
  assert.equal(actions.enabled('edit.undo'), false);
  assert.equal(actions.run('edit.undo'), false, 'disabled');
  assert.equal(calls.length, 2);
  assert.deepEqual(toasts, [], 'a disabled action says nothing');

  assert.equal(actions.run('file.export'), false);
  assert.deepEqual(toasts, [['Not available yet', 'info']], 'an action nobody registered degrades to a toast');

  assert.throws(() => actions.register('edit.undo', () => {}), /already registered/);
  assert.throws(() => actions.register('', () => {}), TypeError);
  assert.throws(() => actions.register('x', 'not a function'), TypeError);
  assert.throws(() => actions.register('x', () => {}, { enabled: true }), TypeError);
  actions.register('view.home', () => {});
  assert.equal(actions.enabled('view.home'), true, 'enabled by default');
});

test('actions: a handler that throws makes run return false and is logged once', async () => {
  const actions = createActions(createUi({ storage: null }));
  let n = 0;
  actions.register('boom', () => { n++; throw new Error('half-written module'); });
  actions.register('moody', () => {}, { enabled: () => { throw new Error('no store yet'); } });
  actions.register('later', () => Promise.reject(new Error('async failure')));
  actions.register('fine', async () => 1);
  const errors = quiet(() => {
    assert.equal(actions.run('boom'), false);
    assert.equal(actions.run('boom'), false);
    assert.equal(actions.enabled('moody'), false);
    assert.equal(actions.run('moody'), false);
  });
  assert.equal(n, 2);
  assert.equal(errors.length, 2, 'once per action');
  assert.match(String(errors[0][0]), /action 'boom' failed/);

  // an async handler has run when run() returns; its rejection is reported, never left unhandled
  const original = console.error, late = [];
  console.error = (...args) => late.push(args);
  try {
    assert.equal(actions.run('later'), true);
    assert.equal(actions.run('fine'), true);
    await new Promise((ok) => setTimeout(ok, 0));
  } finally { console.error = original; }
  assert.equal(late.length, 1);
  assert.match(String(late[0][0]), /action 'later' failed/);
});

test('reportOnce: one console line per module and method, whoever made the call', () => {
  const err = new Error('half-written module');
  const lines = quiet(() => {
    assert.equal(reportOnce('tool test-place', 'key', err), true, 'the keymap pressed Escape');
    assert.equal(reportOnce('tool test-place', 'key', err), false, 'the viewport got a right-click: the same tool, the same method');
    assert.equal(reportOnce('tool test-place', 'update', err), true, 'another method');
    assert.equal(reportOnce('tool test-spawn', 'key', err), true, 'another module');
    assert.equal(reportOnce('tool test-spawn', 'key', new Error('another error')), false);
  });
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], ['[editor] tool test-place key() failed', err]);
  assert.match(String(lines[1][0]), /tool test-place update\(\) failed/);
});

// ---------------------------------------------------------------- the editor's use of the store, end to end

// What a tool is handed, as far as the helpers below need it: no viewport, no page.
function context() {
  const w = world(), toasts = [];
  const ui = createUi({ storage: null }).attach({ toast: (text, level) => toasts.push([text, level]) });
  return { ...w, toasts, ctx: { store: w.store, ui, cmd } };
}
const at = (x, z) => ({ x, z, onGround: true });

test('Select All: what the active tool picks - and in the Select tool what a box would take, so never the regions', () => {
  const { store, map, o, s, c, n, r, ctx } = context();
  const all = ['object', 'spawn', 'chest', 'npc', 'region', 'start'];
  ctx.tools = { select: { picks: all }, region: { picks: ['region'] }, spawn: { picks: ['spawn'] }, paint: { picks: [] } };
  ctx.ui.set('tool', 'select');
  // the scenery and the markers; a region is a zone - "select all, delete" must not take the lands of the island
  assert.equal(selectAll(ctx), o.length + s.length + c.length + n.length + 1);
  assert.deepEqual(store.selected(), [...o, ...s, ...c, ...n, map.start]);
  assert.equal(store.selected('region').length, 0);
  assert.match(ctx.ui.note, /regions are not part of Select All/);
  // a locked layer is left out, as everywhere
  ctx.ui.set('layers', { ...ctx.ui.layers, spawns: { visible: true, locked: true } });
  selectAll(ctx);
  assert.equal(store.selected('spawn').length, 0);
  ctx.ui.set('layers', { ...ctx.ui.layers, spawns: { visible: true, locked: false } });
  // the tool of a kind selects all of that kind: this is how every region is selected at once
  ctx.ui.set('tool', 'region');
  assert.equal(selectAll(ctx), r.length);
  assert.deepEqual(store.selected(), r);
  ctx.ui.set('tool', 'spawn');
  selectAll(ctx);
  assert.deepEqual(store.selected(), s);
  // a tool that picks nothing selects nothing (and says nothing)
  ctx.ui.set('tool', 'paint');
  ctx.ui.setNote('');
  assert.equal(selectAll(ctx), 0);
  assert.deepEqual([store.selection.size, ctx.ui.note], [0, '']);
});

test('grouping: Mod+G gives a selection one new id, Mod+Shift+G clears it - one cmd.set each', () => {
  const { store, map, o, s, r } = world();
  const text = bytes(map);
  const picked = [o[0], o[2], s[0], r[0], map.start];       // a region and the start have no group: the patch skips them
  assertChange(store.exec(cmd.set(picked, { g: store.newGroupIds(1)[0] })), { updated: { objects: [o[0], o[2]], spawns: [s[0]] } });
  assert.deepEqual([o[0].g, o[2].g, s[0].g], ['g1', 'g1', 'g1']);
  assert.equal('g' in r[0], false);
  assert.equal('g' in map.start, false);
  assert.equal(store.undoLabel, 'Group 3 items', 'the label counts what the patch applies to');
  assert.deepEqual(store.expandGroups([s[0]]), [s[0], o[0], o[2]]);
  assert.deepEqual(store.newGroupIds(1), ['g3']);
  assert.equal(validate(map).filter((i) => i.level === 'error').length, 0);

  store.exec(cmd.set(picked, { g: undefined }));
  assert.deepEqual([o[0].g, o[2].g, s[0].g], [null, null, null]);
  assert.equal(store.undoLabel, 'Ungroup 3 items');
  store.undo();
  store.undo();
  assert.equal(bytes(map), text);
});

test('duplicated groups get fresh ids: one per distinct g, asked for once', () => {
  const { store, map, o, s, c } = world();
  const originals = store.expandGroups([o[1], o[3], o[0]]);      // 'camp' (3 items of 3 kinds), 'g2', and one without a group
  assert.deepEqual(originals, [o[1], o[3], o[0], s[1], c[1]]);
  const groups = [...new Set(originals.map((it) => it.g).filter((g) => g !== null))];
  const ids = store.newGroupIds(groups.length);
  assert.deepEqual(ids, ['g1', 'g3']);
  const copies = originals.map((it) => { const copy = cmd.clone(it); if (copy.g !== null) copy.g = ids[groups.indexOf(copy.g)]; return copy; });
  store.begin('Duplicate 5 items');
  for (const kind of ['object', 'spawn', 'chest']) store.exec(cmd.add(kind, copies.filter((_, i) => store.kindOf(originals[i]) === kind)));
  store.commit();
  assert.deepEqual(store.expandGroups([copies[0]]).length, 3);
  assert.ok(store.expandGroups([copies[0]]).every((it) => copies.includes(it)), 'the copy of a group is a group of its own');
  assert.deepEqual(store.newGroupIds(2), ['g4', 'g5']);
  assert.equal(map.objects.length, 7);
  store.undo();
  assert.equal(map.objects.length, 4);
  assert.deepEqual(store.newGroupIds(2), ['g1', 'g3']);
});

test('Mod+G groups whatever can be grouped - one item is enough - and Mod+Shift+G takes it out again', () => {
  const { ctx, store, map, toasts, o, s, r } = context();
  const text = bytes(map);

  store.select([o[0]]);
  assert.equal(groupSelection(ctx), true, 'a group of one is a group');
  assert.equal(o[0].g, 'g1');
  assert.equal(store.undoLabel, 'Group 1 item');
  assert.deepEqual(toasts.at(-1), ['Grouped 1 item as g1', 'info']);

  store.select([o[0], o[2], s[0], r[0], map.start]);      // a region and the start carry no group: they are left out
  assert.equal(groupSelection(ctx), true);
  assert.deepEqual([o[0].g, o[2].g, s[0].g], ['g3', 'g3', 'g3'], 'the first unused id (g2 is taken); a member moves to the new group');
  assert.equal(store.undoLabel, 'Group 3 items');
  assert.equal('g' in r[0], false);

  store.select([r[0], map.start]);
  const steps = store.undoLabel, said = toasts.length;
  assert.equal(groupSelection(ctx), false, 'nothing that can carry a group');
  assert.equal(store.undoLabel, steps);
  assert.equal(toasts.length, said, 'it says so in the status bar, not with a toast');
  assert.match(ctx.ui.note, /Nothing to group/);
  assert.equal(ctx.ui.status, '', 'as a note: the standing status text is not replaced');
  store.clearSelection();
  assert.equal(groupSelection(ctx), false);

  ctx.ui.set('layers', { ...ctx.ui.layers, spawns: { visible: true, locked: true } });
  store.select([s[0], s[1]]);
  assert.equal(groupSelection(ctx), false, 'a locked layer is not edited');
  ctx.ui.set('layers', { ...ctx.ui.layers, spawns: { visible: true, locked: false } });

  store.select([o[2], s[0]]);
  assert.equal(ungroupSelection(ctx), true);
  assert.deepEqual([o[0].g, o[2].g, s[0].g], ['g3', null, null]);
  assert.equal(store.undoLabel, 'Ungroup 2 items');
  assert.equal(ungroupSelection(ctx), false, 'they are in no group any more');
  while (store.undo() !== null);
  assert.equal(bytes(map), text);
});

test('dragMove: one undo step per drag, snapping per move, and no step for a drag that comes home', () => {
  const { ctx, store, map, o } = context();
  const text = bytes(map);
  store.select([o[0], o[1]]);

  let drag = dragMove(ctx, [o[0], o[1]], at(10, 10));
  assert.equal(drag.active, true);
  assert.equal(store.grouping, true, 'the group is open from the press on');
  drag.move(at(11.234, 10));
  drag.move(at(13.5, 12.25));
  assert.deepEqual([o[0].x, o[0].z, o[1].x, o[1].z], [13.5, 12.25, 15.5, 12.25]);
  drag.end();
  drag.end();                                         // a second release is nobody's
  assert.equal(store.grouping, false);
  assert.equal(store.undoLabel, 'Move 2 objects');
  assert.equal(store.undo(), 'Move 2 objects');
  assert.equal(bytes(map), text);
  assert.equal(store.undo(), null, 'the whole drag was one step');

  // snapping: the pivot (11, 10) lands on multiples of the step, both objects keep their offset to it
  ctx.ui.set('snap', { ...ctx.ui.snap, on: true, step: 2 });
  drag = dragMove(ctx, [o[0], o[1]], at(10, 10), { label: 'Shove' });
  drag.move(at(13.4, 10.2));
  assert.deepEqual([o[0].x, o[1].x, o[0].z], [13, 15, 10], 'pivot 14.4 -> 14');
  drag.move(at(10.3, 10.4), { metaKey: true, ctrlKey: true });      // (both down is no Mod on any platform: still snapping)
  assert.deepEqual([o[0].x, o[1].x], [11, 13], 'pivot 11.3 -> 12');
  drag.cancel();
  assert.equal(bytes(map), text, 'Esc takes the drag back');
  assert.equal(store.undoLabel, null);

  // Out and back is nothing: no step, the redo survives, the map stays clean. With snapping on (the pivot is on the
  // grid of step 1) any small wobble ends exactly at home; without it, home is the map's 0.01 grid.
  store.exec(cmd.set([o[3]], { y: 3 }));
  store.undo();
  const home = (what) => {
    drag.end();
    assert.equal(store.grouping, false);
    assert.equal(store.canUndo, false, `${what}: no step`);
    assert.equal(store.canRedo, true, `${what}: the redo survives`);
    assert.equal(store.dirty, false, what);
    assert.equal(bytes(map), text);
  };
  ctx.ui.set('snap', { ...ctx.ui.snap, on: true, step: 1 });
  drag = dragMove(ctx, [o[0], o[1]], at(10, 10));
  drag.move(at(11.7, 10.2));
  assert.deepEqual([o[0].x, o[1].x, o[0].z], [12, 14, 10]);
  drag.move(at(10.3, 10.4));
  assert.deepEqual([o[0].x, o[1].x, o[0].z], [10, 12, 10]);
  home('snapped');
  ctx.ui.set('snap', { ...ctx.ui.snap, on: false });
  drag = dragMove(ctx, [o[0], o[1]], at(10, 10));
  drag.move(at(12.4, 10));
  drag.move(at(10.004, 10));
  home('free');
  drag = dragMove(ctx, [o[0], o[1]], at(10, 10));
  home('a press that never moved');
  drag = dragMove(ctx, [o[0], o[1]], at(10, 10));    // one hundredth off is a move
  drag.move(at(12.4, 10));
  drag.move(at(10.01, 10));
  drag.end();
  assert.equal(store.undoLabel, 'Move 2 objects');
  store.undo();
  assert.equal(bytes(map), text);

  // nothing that may be moved: inert, and no group is opened
  ctx.ui.set('layers', { ...ctx.ui.layers, objects: { visible: true, locked: true } });
  drag = dragMove(ctx, [o[0]], at(10, 10));
  assert.equal(drag.active, false);
  assert.equal(store.grouping, false);
  drag.move(at(20, 20));
  drag.end();
  drag.cancel();
  assert.equal(bytes(map), text);
});

test('dragMove and dragRadius join a store group that is already open: create and drag are ONE step', () => {
  const { ctx, store, map, o, s, r } = context();
  const text = bytes(map);

  // a camp created by press-drag, as the Spawn tool does it: begin, add, hand the new item to dragRadius
  store.select([o[0]]);
  store.begin('Add spawn');
  const camp = placeOnce(ctx, 'spawn', { x: 40, z: 40, r: 1 });      // inside the group it is no step of its own
  assert.deepEqual([...store.selection], [camp]);
  let drag = dragRadius(ctx, camp, at(40, 40));
  assert.equal(drag.active, true, 'not a dead handle');
  drag.move(at(46, 48));
  assert.equal(camp.r, 10);
  drag.end();
  assert.equal(store.grouping, false, 'end() commits the group it joined');
  assert.equal(store.undoLabel, 'Add spawn', "under the caller's label");
  assert.equal(map.spawns.length, 3);
  assert.equal(store.undo(), 'Add spawn');
  assert.equal(map.spawns.length, 2);
  assert.equal(store.undo(), null, 'ONE step');
  assert.equal(bytes(map), text);

  // Esc during that drag removes the new camp again and puts the selection back
  store.select([o[0]]);
  store.begin('Add spawn');
  const gone = placeOnce(ctx, 'spawn', { x: 40, z: 40, r: 1 });
  drag = dragRadius(ctx, gone, at(40, 40));
  drag.move(at(50, 40));
  drag.cancel();
  assert.equal(store.grouping, false);
  assert.equal(map.spawns.length, 2);
  assert.deepEqual([...store.selection], [o[0]]);
  assert.equal(store.undoLabel, null);
  assert.equal(bytes(map), text);

  // copies that are dragged away (Alt+drag): the add and the move are one step, also when the copies end in place
  for (const to of [at(13, 14), at(10, 10)]) {
    const copies = [cmd.clone(o[0]), cmd.clone(o[1])];
    store.begin('Duplicate 2 objects');
    store.exec(cmd.add('object', copies));
    drag = dragMove(ctx, copies, at(10, 10));
    assert.equal(drag.active, true);
    drag.move(at(20, 20));
    drag.move(to);
    drag.end();
    assert.equal(store.grouping, false);
    assert.equal(map.objects.length, 6);
    assert.equal(copies[0].x, o[0].x + to.x - 10);
    assert.equal(store.undo(), 'Duplicate 2 objects');
    assert.equal(bytes(map), text);
  }

  // on their own they open and close their own group: a rim of an existing camp, of a circle region, of the start
  for (const [item, hit, read, label] of [
    [s[1], at(-100, 70), () => s[1].r, 'Resize spawn'],
    [r[0], at(0, 45), () => r[0].shape.r, 'Resize region'],
    [map.start, at(6, 8), () => map.start.r, 'Resize start point'],
  ]) {
    const shape = item.shape;
    drag = dragRadius(ctx, item, at(0, 0));
    assert.equal(drag.active, true, label);
    assert.equal(store.grouping, true);
    drag.move(hit);
    drag.end();
    assert.equal(read(), Math.hypot(hit.x - (shape?.x ?? item.x), hit.z - (shape?.z ?? item.z)), label);
    if (shape) assert.notEqual(item.shape, shape, 'a region gets a new shape object and stays the same region');
    assert.equal(store.undo(), label);
    if (shape) assert.equal(item.shape, shape);
  }
  drag = dragRadius(ctx, s[1], at(-100, 62));         // a rim that comes home is no step
  drag.move(at(-100, 75));
  drag.move(at(-100, 62));
  drag.end();
  assert.equal(store.canUndo, false);
  assert.equal(bytes(map), text);

  // what has no radius, or may not be edited, gives an inert handle and opens nothing
  for (const item of [o[0], r[1]]) {
    drag = dragRadius(ctx, item, at(0, 0));
    assert.equal(drag.active, false);
    assert.equal(store.grouping, false);
    drag.move(at(9, 9));
    drag.end();
  }
  assert.equal(bytes(map), text);
});

// ---------------------------------------------------------------- pure

test('the five core modules need no browser', () => {
  for (const name of ['window', 'document', 'requestAnimationFrame', 'HTMLElement']) {       // (Node has a navigator of its own)
    assert.equal(typeof globalThis[name], 'undefined', `${name} exists here: this test must run in plain Node`);
  }
  // they are loaded (this file imports four of them, commands.test.mjs the fifth) and a ui builds with its default storage
  const ui = createUi();
  ui.set('snap', { ...ui.snap });
  assert.equal(createActions(ui).run('nothing'), false);

  const pure = ['../shared.js', '../map/format.js', './state.js', './store.js'];
  for (const file of ['state.js', 'store.js', 'commands.js', 'actions.js', 'fields.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'editor', file), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
    for (const m of code.matchAll(/\bimport\b[^'"]*['"]([^'"]+)['"]/g)) assert.ok(pure.includes(m[1]), `${file} imports ${m[1]}`);
    assert.doesNotMatch(code, /\b(document|window|navigator|requestAnimationFrame|setTimeout|setInterval|fetch|THREE)\b/, file);
    assert.doesNotMatch(code, /\bimport\s*\(/, `${file}: no dynamic imports`);
  }
});
