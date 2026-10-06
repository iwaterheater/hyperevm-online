// The editor-only checks of src/editor/checks.js: reachability from the start disc, items inside colliders, regions
// that never win, triangle budgets and models that failed to load.
// Maps are built with emptyMap() and cmd.make(); the obstacles are written by hand in the layout of view.obstacles(),
// so nothing here needs three.js, a browser or map/world.json.
// Run: node --test test/checks.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUND_INDEX, cellIndex, emptyMap, serialize, stringifyMap, validate } from '../src/map/format.js';
import * as cmd from '../src/editor/commands.js';
import { MODEL_TRIANGLES, PLAYER_R, REACH, TOTAL_TRIANGLES, editorChecks } from '../src/editor/checks.js';

// ---------------------------------------------------------------- helpers

// What view.obstacles() returns: object circles first, the NPCs' own circles last (from npcStart), then the boxes.
// The arrays are longer than what is filled, as the view's reused buffers are.
function obstacles({ circles = [], npcs = [], boxes = [] } = {}) {
  const c = new Float32Array((circles.length + npcs.length) * 3 + 9).fill(7), b = new Float32Array(boxes.length * 5 + 10).fill(7);
  [...circles, ...npcs].forEach(([x, z, r], i) => c.set([x, z, r], i * 3));
  boxes.forEach((box, i) => b.set(box, i * 5));
  return { circles: c, nCircles: circles.length + npcs.length, npcStart: circles.length, boxes: b, nBoxes: boxes.length };
}

// circles of radius r on a ring around (x, z), close enough to leave no way through
function ring(x, z, radius, r = 1, skip = () => false) {
  const n = Math.ceil(2 * Math.PI * radius / r), out = [];
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2;
    if (!skip(a)) out.push([x + Math.cos(a) * radius, z + Math.sin(a) * radius, r]);
  }
  return out;
}

function world() {
  const map = emptyMap();   // radius 260, cell 2, start { 0, 0, 5 }
  map.chests.push(cmd.make('chest', { x: 40, z: 0 }));
  map.npcs.push(cmd.make('npc', { kind: 'sage', x: 10, z: 10 }));
  map.spawns.push(cmd.make('spawn', { x: -60, z: 30 }));
  return map;
}

const codes = (issues) => issues.map((i) => i.code);
const of = (issues, code) => issues.filter((i) => i.code === code);
const bytes = (map) => stringifyMap(serialize(map, { check: false }));

// ---------------------------------------------------------------- shape of the result

test('a map with nothing in the way has no editor issue', () => {
  const map = world();
  assert.deepEqual(editorChecks(map, { obstacles: obstacles(), missing: [], triangles: new Map() }), []);
  // every argument is optional: a check without its input is switched off
  assert.deepEqual(editorChecks(map), []);
  assert.deepEqual(editorChecks(map, {}), []);
  assert.deepEqual(editorChecks(map, { obstacles: null, missing: null, triangles: null }), []);
  assert.deepEqual(editorChecks(emptyMap(), { obstacles: obstacles() }), []);
});

test('issues are plain warnings in the form of validate(), and the map is left alone', () => {
  const map = world();
  const before = bytes(map);
  const issues = editorChecks(map, {
    obstacles: obstacles({ circles: [[40, 0, 3], [10, 10, 3]], boxes: [[-60, 30, 4, 4, 0.3]] }),
    missing: ['medieval/nope'], triangles: new Map(),
  });
  assert.ok(issues.length >= 4);
  for (const issue of issues) {
    assert.equal(issue.level, 'warning');
    assert.equal(typeof issue.code, 'string');
    assert.equal(typeof issue.path, 'string');
    assert.match(issue.message, /^[A-Z].*\.$/);
    assert.deepEqual(JSON.parse(JSON.stringify(issue)), issue);       // plain data
    if (issue.kind !== undefined) {
      assert.ok(Number.isInteger(issue.index));
      const list = issue.kind === 'start' ? [map.start] : map[`${issue.kind}s`];
      assert.ok(list[issue.index], `${issue.path} names an item of the map`);
    }
  }
  assert.equal(bytes(map), before);
  // the same input gives the same answer
  const again = obstacles({ circles: [[40, 0, 3], [10, 10, 3]], boxes: [[-60, 30, 4, 4, 0.3]] });
  assert.deepEqual(editorChecks(map, { obstacles: again, missing: ['medieval/nope'], triangles: new Map() }), issues);
});

// ---------------------------------------------------------------- item-in-collider

test('an NPC with its own circle at npcStart raises neither item-in-collider nor unreachable', () => {
  const map = world(), npc = map.npcs[0];
  const issues = editorChecks(map, { obstacles: obstacles({ npcs: [[npc.x, npc.z, 0.55]] }) });
  assert.deepEqual(issues, []);
  // also with object circles before it: only the indices from npcStart on are the NPCs' own
  const mixed = editorChecks(map, { obstacles: obstacles({ circles: [[100, 100, 2], [-100, 50, 1]], npcs: [[npc.x, npc.z, 0.55]] }) });
  assert.deepEqual(mixed, []);
});

test('the same NPC inside an object circle raises item-in-collider', () => {
  const map = world(), npc = map.npcs[0];
  const issues = editorChecks(map, { obstacles: obstacles({ circles: [[npc.x + 0.2, npc.z, 0.6]], npcs: [[npc.x, npc.z, 0.55]] }) });
  assert.deepEqual(codes(issues), ['item-in-collider']);
  assert.deepEqual({ ...issues[0], message: '' }, { level: 'warning', code: 'item-in-collider', path: 'npcs[0]', message: '', kind: 'npc', index: 0, x: 10, z: 10 });
  // a collider that swallows the ground around it as well leaves no cell to stand on next to the NPC
  const deep = editorChecks(map, { obstacles: obstacles({ circles: [[npc.x, npc.z, 4]], npcs: [[npc.x, npc.z, 0.55]] }) });
  assert.deepEqual(codes(deep), ['item-in-collider', 'unreachable']);
});

test('chests and spawn centres inside a circle or a box are reported, the rim is not', () => {
  const map = world();
  const inCircle = editorChecks(map, { obstacles: obstacles({ circles: [[40.5, 0, 0.8], [-60, 30.3, 0.5]] }) });
  assert.deepEqual(of(inCircle, 'item-in-collider').map((i) => i.path), ['chests[0]', 'spawns[0]']);
  // just outside the radius
  assert.deepEqual(of(editorChecks(map, { obstacles: obstacles({ circles: [[41, 0, 0.99]] }) }), 'item-in-collider'), []);
  // n = npcStart = 0: an NPC list alone is nobody's obstacle
  assert.deepEqual(editorChecks(map, { obstacles: obstacles({ npcs: [[40, 0, 5]] }) }), []);
});

test('a box is tested in its own frame: the rotation counts', () => {
  const map = world();   // chest at (40, 0)
  // a wall 6 long and 0.6 deep through (40, 2): unturned it misses the chest, turned by 90 degrees it covers it
  const flat = editorChecks(map, { obstacles: obstacles({ boxes: [[40, 2, 3, 0.3, 0]] }) });
  assert.deepEqual(of(flat, 'item-in-collider'), []);
  const turned = editorChecks(map, { obstacles: obstacles({ boxes: [[40, 2, 3, 0.3, Math.PI / 2]] }) });
  assert.deepEqual(of(turned, 'item-in-collider').map((i) => i.path), ['chests[0]']);
  // local +X of an item turned by ry points to (cos ry, -sin ry): a box reaching 3 units along it from (37, 3)
  const ry = Math.PI / 4, far = 2.9;
  const along = editorChecks(map, { obstacles: obstacles({ boxes: [[40 - Math.cos(ry) * far, 0 + Math.sin(ry) * far, 3, 0.2, ry]] }) });
  assert.deepEqual(of(along, 'item-in-collider').map((i) => i.path), ['chests[0]']);
  const across = editorChecks(map, { obstacles: obstacles({ boxes: [[40 - Math.cos(ry) * far, 0 - Math.sin(ry) * far, 3, 0.2, ry]] }) });
  assert.deepEqual(of(across, 'item-in-collider'), []);
});

// ---------------------------------------------------------------- unreachable

test('a chest walled in by colliders is unreachable until the wall has a gap', () => {
  const map = world();
  const closed = editorChecks(map, { obstacles: obstacles({ circles: ring(40, 0, 6) }) });
  assert.deepEqual(codes(closed), ['unreachable']);
  assert.equal(closed[0].path, 'chests[0]');
  assert.equal(closed[0].kind, 'chest');
  assert.deepEqual([closed[0].x, closed[0].z], [40, 0]);
  // a gate 4 units wide (minus the player's radius on both sides) towards the start
  const open = editorChecks(map, { obstacles: obstacles({ circles: ring(40, 0, 6, 1, (a) => Math.abs(a - Math.PI) < 0.5) }) });
  assert.deepEqual(open, []);
});

test('a wall of boxes closes the way like circles do', () => {
  const map = world();
  // four walls around the chest at (40, 0), 12 x 12, each 1 thick
  const walls = [[40, -6, 6.5, 0.5, 0], [40, 6, 6.5, 0.5, 0], [34, 0, 6.5, 0.5, Math.PI / 2], [46, 0, 6.5, 0.5, Math.PI / 2]];
  assert.deepEqual(codes(editorChecks(map, { obstacles: obstacles({ boxes: walls }) })), ['unreachable']);
  assert.deepEqual(editorChecks(map, { obstacles: obstacles({ boxes: walls.slice(1) }) }), []);
});

test('ground that blocks cuts items off, a bridge connects them again', () => {
  const map = world(), g = map.ground, water = GROUND_INDEX.water;
  // a moat: every vertex between 8 and 14 units from the spawn centre
  const spawn = map.spawns[0], moat = [];
  for (let x = spawn.x - 16; x <= spawn.x + 16; x += g.cell) {
    for (let z = spawn.z - 16; z <= spawn.z + 16; z += g.cell) {
      const d = Math.hypot(x - spawn.x, z - spawn.z);
      if (d >= 8 && d <= 14) moat.push(cellIndex(g, x, z));
    }
  }
  for (const i of moat) g.cells[i] = water;
  const cut = editorChecks(map, { obstacles: obstacles() });
  assert.deepEqual(cut.map((i) => [i.code, i.path]), [['unreachable', 'spawns[0]']]);
  // the same without any obstacle argument: blocked ground alone is enough
  assert.deepEqual(codes(editorChecks(map)), ['unreachable']);
  // a causeway along +X
  for (let x = spawn.x; x <= spawn.x + 16; x += g.cell) g.cells[cellIndex(g, x, spawn.z)] = GROUND_INDEX.dirt;
  assert.deepEqual(editorChecks(map, { obstacles: obstacles() }), []);
});

test('an item beyond the map radius is unreachable, one right at an open cell is not', () => {
  const map = world();
  map.chests.push(cmd.make('chest', { x: 300, z: 0 }), cmd.make('chest', { x: 259.4, z: 0 }), cmd.make('chest', { x: 0.5, z: 0.5 }));
  assert.deepEqual(editorChecks(map).map((i) => [i.code, i.path]), [['unreachable', 'chests[1]']]);
  assert.ok(REACH > 1 && PLAYER_R > 0);
});

test('a start disc with nowhere to stand is one issue, not one per item', () => {
  const map = world();
  // everything within reach of the start is under one collider
  const buried = editorChecks(map, { obstacles: obstacles({ circles: [[0, 0, 12]] }) });
  assert.deepEqual(buried.map((i) => [i.code, i.path, i.kind]), [['unreachable', 'start', 'start']]);
  // a start disc that is walled in but has ground: every item outside is reported
  const walled = editorChecks(map, { obstacles: obstacles({ circles: ring(0, 0, 9) }) });
  assert.deepEqual(walled.map((i) => i.path), ['chests[0]', 'npcs[0]', 'spawns[0]']);
  assert.ok(walled.every((i) => i.code === 'unreachable'));
  // a map without chests, NPCs and spawns has nothing to reach
  assert.deepEqual(editorChecks(emptyMap(), { obstacles: obstacles({ circles: [[0, 0, 12]] }) }), []);
});

test('players may appear anywhere in the start disc: every part of it is a start', () => {
  const map = world();
  map.start.r = 10;
  // a wall through the middle of the disc, from edge to edge of the island: the chest side is still a place to appear
  const wall = [];
  for (let z = -262; z <= 262; z += 1) wall.push([4, z, 0.8]);
  assert.deepEqual(editorChecks(map, { obstacles: obstacles({ circles: wall }) }), []);
});

// ---------------------------------------------------------------- region-hidden

test('a region that wins at no ground vertex is hidden', () => {
  const map = world();
  const inner = cmd.make('region', { name: 'Inner', shape: { type: 'circle', x: 50, z: 50, r: 20 } });
  const outer = cmd.make('region', { name: 'Outer', shape: { type: 'circle', x: 50, z: 50, r: 30 } });
  map.regions.push(inner, outer);                      // later wins: Outer covers Inner completely
  let issues = editorChecks(map);
  assert.deepEqual(issues.map((i) => [i.code, i.path, i.kind, i.index, i.x, i.z]), [['region-hidden', 'regions[0]', 'region', 0, 50, 50]]);
  map.regions.reverse();                               // Inner on top: both win somewhere
  assert.deepEqual(editorChecks(map), []);
  // partly covered is not hidden
  map.regions = [inner, cmd.make('region', { name: 'Half', shape: { type: 'poly', points: [[50, 20], [80, 20], [80, 80], [50, 80]] } })];
  assert.deepEqual(editorChecks(map), []);
  // a polygon covered by a polygon
  map.regions = [
    cmd.make('region', { name: 'Small', shape: { type: 'poly', points: [[-20, -20], [-10, -20], [-10, -10], [-20, -10]] } }),
    cmd.make('region', { name: 'Big', shape: { type: 'poly', points: [[-40, -40], [0, -40], [0, 0], [-40, 0]] } }),
  ];
  issues = editorChecks(map);
  assert.deepEqual(issues.map((i) => i.path), ['regions[0]']);
  assert.deepEqual([issues[0].x, issues[0].z], [-15, -15]);
});

test('a region smaller than a ground cell or off the grid is hidden as well', () => {
  const map = world();   // cell 2: vertices on even coordinates
  map.regions.push(cmd.make('region', { name: 'Speck', shape: { type: 'circle', x: 1, z: 1, r: 1 } }));
  assert.deepEqual(codes(editorChecks(map)), ['region-hidden']);
  map.regions[0].shape.r = 1.5;                        // reaches the four vertices around it
  assert.deepEqual(editorChecks(map), []);
  map.regions[0] = cmd.make('region', { name: 'Far', shape: { type: 'circle', x: 900, z: 0, r: 50 } });
  assert.deepEqual(codes(editorChecks(map)), ['region-hidden']);
  // several hidden regions come in file order
  map.regions = [1, 2, 3].map((n) => cmd.make('region', { name: `R${n}`, shape: { type: 'circle', x: 0, z: 0, r: 10 * n } }));
  assert.deepEqual(editorChecks(map).map((i) => i.path), ['regions[0]', 'regions[1]']);
});

// ---------------------------------------------------------------- triangles and models

test('heavy-model names the model, many-triangles counts them all', () => {
  const map = emptyMap();
  for (let i = 0; i < 4; i++) map.objects.push(cmd.make('object', { m: 'medieval/tree_single_A', x: i * 5, z: 60 }));
  for (let i = 0; i < 3; i++) map.objects.push(cmd.make('object', { m: 'medieval/barrel', x: i * 5, z: 70 }));
  const each = MODEL_TRIANGLES / 4;
  // exactly at the limit: fine
  assert.deepEqual(editorChecks(map, { triangles: new Map([['medieval/tree_single_A', each], ['medieval/barrel', 100]]) }), []);
  let issues = editorChecks(map, { triangles: new Map([['medieval/tree_single_A', each + 1], ['medieval/barrel', 100]]) });
  assert.deepEqual(issues.map((i) => [i.code, i.path, i.kind, i.index]), [['heavy-model', 'objects[0].m', 'object', 0]]);
  assert.match(issues[0].message, /"medieval\/tree_single_A"/);
  assert.match(issues[0].message, /300,004 triangles/);
  assert.deepEqual([issues[0].x, issues[0].z], [0, 60]);
  // the total: 3 barrels of a third of the budget each, plus the trees
  issues = editorChecks(map, { triangles: new Map([['medieval/tree_single_A', 10], ['medieval/barrel', Math.ceil(TOTAL_TRIANGLES / 3)]]) });
  assert.deepEqual(codes(issues), ['heavy-model', 'many-triangles']);
  assert.equal(issues[0].index, 4);
  assert.equal(issues[1].path, 'objects');
  assert.equal(issues[1].kind, undefined);
  // a model the map does not use, and one the table does not know, count for nothing
  assert.deepEqual(editorChecks(map, { triangles: new Map([['dungeon/pillar', 9e9]]) }), []);
});

test('model-failed lists every model that failed to load, with the objects that use it', () => {
  const map = emptyMap();
  map.objects.push(cmd.make('object', { m: 'medieval/barrel', x: 1, z: 2 }), cmd.make('object', { m: 'halloween/ghost', x: 30, z: 40 }),
    cmd.make('object', { m: 'halloween/ghost', x: 31, z: 40 }));
  const issues = editorChecks(map, { missing: new Set(['halloween/ghost', 'dungeon/unused']) });
  assert.deepEqual(issues.map((i) => [i.code, i.path, i.kind, i.index]), [
    ['model-failed', 'objects[1].m', 'object', 1], ['model-failed', 'objects', undefined, undefined],
  ]);
  assert.match(issues[0].message, /"halloween\/ghost" failed to load: 2 objects are drawn/);
  assert.match(issues[1].message, /"dungeon\/unused" failed to load/);
  assert.deepEqual([issues[0].x, issues[0].z], [30, 40]);
  // an array with the id twice is one issue
  assert.equal(editorChecks(map, { missing: ['halloween/ghost', 'halloween/ghost'] }).length, 1);
  assert.deepEqual(editorChecks(map, { missing: new Set() }), []);
});

// ---------------------------------------------------------------- robustness

test('half-filled input never throws', () => {
  const map = world();
  assert.doesNotThrow(() => editorChecks(map, { obstacles: {} }));
  assert.doesNotThrow(() => editorChecks(map, { obstacles: { circles: new Float32Array(6), nCircles: 99, npcStart: 50, boxes: new Float32Array(3), nBoxes: 4 } }));
  assert.doesNotThrow(() => editorChecks(map, { obstacles: { circles: new Float32Array([NaN, 0, 1, 0, 0, NaN]), nCircles: 2, npcStart: 2 } }));
  assert.doesNotThrow(() => editorChecks(map, { triangles: {}, missing: 5 }));
  // a map with range errors (what a draft may hold) is checked all the same
  map.spawns[0].x = 5000;
  map.chests[0].x = NaN;
  map.regions.push(cmd.make('region', { shape: { type: 'poly', points: [[0, 0], [1, 1]] } }));
  assert.ok(validate(map).some((i) => i.level === 'error'));
  const issues = editorChecks(map, { obstacles: obstacles({ circles: [[1, 1, 1]] }) });
  assert.deepEqual(issues.map((i) => [i.code, i.path]), [['unreachable', 'chests[0]'], ['unreachable', 'spawns[0]']]);
  assert.equal('x' in issues[0], false);                 // no place to look at
});

test('the largest map with a full load of colliders is checked quickly', () => {
  const map = emptyMap({ radius: 492 });
  for (let i = 0; i < 300; i++) map.spawns.push(cmd.make('spawn', { x: Math.cos(i) * (i + 20), z: Math.sin(i) * (i + 20) }));
  for (let i = 0; i < 200; i++) map.chests.push(cmd.make('chest', { x: Math.cos(i * 2) * (i * 2 + 30), z: Math.sin(i * 2) * (i * 2 + 30) }));
  for (let i = 0; i < 64; i++) map.regions.push(cmd.make('region', { name: `R${i}`, shape: { type: 'circle', x: i * 5 - 160, z: 0, r: 300 } }));
  const circles = [], boxes = [];
  for (let i = 0; i < 20000; i++) circles.push([Math.cos(i * 1.7) * (i % 480), Math.sin(i * 1.7) * (i % 480), 0.5]);
  for (let i = 0; i < 5000; i++) boxes.push([Math.cos(i * 0.9) * (i % 470), Math.sin(i * 0.9) * (i % 470), 2, 0.4, i]);
  const t0 = performance.now();
  const issues = editorChecks(map, { obstacles: obstacles({ circles, boxes }) });
  assert.ok(performance.now() - t0 < 5000, 'under five seconds even on a slow machine');
  assert.ok(Array.isArray(issues));
});
