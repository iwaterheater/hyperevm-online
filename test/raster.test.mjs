// The ground rasteriser of the Terrain tool (src/editor/raster.js): discs, soft discs, capsules, ribbons, flood fill,
// region fill and bounds. Every result is compared with a brute-force walk over ALL vertices of the grid, so the
// clipping at the border, the inclusive rims and "no index twice" are checked against the definition, not against
// the implementation. Grids are built here or with emptyMap(): nothing reads map/world.json, nothing needs a browser.
// Run: node --test test/raster.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GROUND_INDEX, cellHash, cellIndex, cellXZ, emptyMap, groundAt, groundHalf, groundX, inShape, resizeGround,
} from '../src/map/format.js';
import { createStore } from '../src/editor/store.js';
import * as cmd from '../src/editor/commands.js';
import { SOFT_CORE, boundsOf, capsule, disc, flood, inside, ribbon, runs, softDisc } from '../src/editor/raster.js';

// ---------------------------------------------------------------- helpers

// A grid of one ground type. size is odd, like every ground of a map.
function grid(size = 41, cell = 2, type = 0) {
  return { size, cell, cells: new Uint8Array(size * size).fill(type) };
}

// Every vertex of the grid for which test(x, z, ix, iz) holds: the definition each function is measured against.
function brute(g, test) {
  const out = [];
  for (let iz = 0; iz < g.size; iz++) {
    for (let ix = 0; ix < g.size; ix++) if (test(groundX(g, ix), groundX(g, iz), ix, iz)) out.push(iz * g.size + ix);
  }
  return out;
}

const segDist = (x, z, x0, z0, x1, z1) => {
  const dx = x1 - x0, dz = z1 - z0, len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / len2)) : 0;
  return Math.hypot(x - (x0 + t * dx), z - (z0 + t * dz));
};
const lineDist = (x, z, points) => {
  if (points.length === 1) return Math.hypot(x - points[0][0], z - points[0][1]);
  let best = Infinity;
  for (let i = 1; i < points.length; i++) best = Math.min(best, segDist(x, z, points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]));
  return best;
};

// What every result must be: an Int32Array, ascending (so nothing twice), every index on the grid.
function wellFormed(g, a, what = 'result') {
  assert.ok(a instanceof Int32Array, `${what}: an Int32Array`);
  for (let k = 0; k < a.length; k++) {
    assert.ok(a[k] >= 0 && a[k] < g.size * g.size, `${what}: index ${a[k]} is on the grid`);
    if (k) assert.ok(a[k] > a[k - 1], `${what}: ascending, no index twice (at ${k})`);
  }
  assert.equal(new Set(a).size, a.length, `${what}: no duplicates`);
  return a;
}
const same = (g, a, expected, what) => assert.deepEqual([...wellFormed(g, a, what)], expected, what);
const loaded = (map) => { const s = createStore(); s.load(map); return s; };
const worldSet = (g, a) => new Set([...a].map((i) => { const p = cellXZ(g, i); return `${p.x},${p.z}`; }));

// ---------------------------------------------------------------- disc

test('disc: every vertex within the radius, the rim included', () => {
  const g = grid();
  same(g, disc(g, 0, 0, 4), brute(g, (x, z) => x * x + z * z <= 16), 'radius 4 at the centre');
  assert.equal(disc(g, 0, 0, 4).length, 13);        // 0, +-2, +-4 on the axes and the four diagonal neighbours
  same(g, disc(g, 3.3, -7.1, 9.5), brute(g, (x, z) => Math.hypot(x - 3.3, z + 7.1) <= 9.5), 'off-centre');
  same(g, disc(g, 6, 6, 0), [cellIndex(g, 6, 6)], 'radius 0 on a vertex is that vertex');
  same(g, disc(g, 7, 7, 0.5), [], 'a small disc between four vertices holds none');
  same(g, disc(g, 7, 7, Math.SQRT2), brute(g, (x, z) => Math.abs(x - 7) === 1 && Math.abs(z - 7) === 1), 'and exactly its four corners at sqrt(2)');
});

test('disc: other cell sizes', () => {
  for (const cell of [1, 2, 4]) {
    const g = grid(33, cell);
    same(g, disc(g, 2.5 * cell, -1.25 * cell, 5.3 * cell), brute(g, (x, z) => Math.hypot(x - 2.5 * cell, z + 1.25 * cell) <= 5.3 * cell), `cell ${cell}`);
  }
});

test('disc: clipped at the border of the grid, empty beyond it', () => {
  const g = grid(21, 2), half = groundHalf(g);    // the grid spans -20 .. 20
  same(g, disc(g, half, half, 6), brute(g, (x, z) => Math.hypot(x - half, z - half) <= 6), 'a corner');
  same(g, disc(g, -half - 3, 0, 5), brute(g, (x, z) => Math.hypot(x + half + 3, z) <= 5), 'centre outside, rim inside');
  assert.ok(disc(g, -half - 3, 0, 5).length > 0);
  same(g, disc(g, half + 30, 0, 5), [], 'all of it outside');
  same(g, disc(g, 0, 0, 1000), brute(g, () => true), 'a disc larger than the grid is the grid');
  assert.equal(disc(g, 0, 0, 1000).length, 21 * 21);
});

test('bad input gives an empty result, never a throw', () => {
  const g = grid();
  for (const a of [disc(g, NaN, 0, 4), disc(g, 0, 0, NaN), disc(g, 0, 0, -1), disc(g, 0, Infinity, 4), disc(g, 0, 0, Infinity),
    disc(null, 0, 0, 4), disc({}, 0, 0, 4), capsule(g, 0, 0, NaN, 0, 3), softDisc(g, 0, 0, undefined, 1),
    ribbon(g, [], 4), ribbon(g, null, 4), ribbon(g, [[0, 0]], NaN), ribbon(g, [[NaN, 0]], 4),
    flood(g, -1), flood(g, g.size * g.size), flood(g, 1.5), flood(g, 0, { radius: NaN }), flood(null, 0),
    inside(g, null), inside(g, { type: 'star' }), inside(g, { type: 'circle', x: 0, z: 0, r: NaN }), inside(g, { type: 'poly', points: [[0, 0], [1, 1]] })]) {
    assert.ok(a instanceof Int32Array);
    assert.equal(a.length, 0);
  }
});

// ---------------------------------------------------------------- softDisc

test('softDisc: all of the inner 60 %, a dither towards the rim, nothing beyond it', () => {
  const g = grid(101, 2), r = 30;
  const soft = softDisc(g, 0, 0, r, 7), all = new Set(disc(g, 0, 0, r)), got = new Set(wellFormed(g, soft));
  for (const i of got) assert.ok(all.has(i), 'inside the hard disc');
  for (const i of disc(g, 0, 0, r * SOFT_CORE)) assert.ok(got.has(i), 'the core is solid');
  assert.ok(soft.length < all.size && soft.length > disc(g, 0, 0, r * SOFT_CORE).length);
  // the definition, vertex by vertex
  same(g, soft, brute(g, (x, z, ix, iz) => {
    const d = Math.hypot(x, z);
    return d <= r * SOFT_CORE || (d <= r && cellHash(ix, iz, 7) < (r - d) / (r - r * SOFT_CORE));
  }), 'hash below the falling probability');
  // the share that is painted falls from the core to the rim
  const share = (from, to) => {
    let n = 0, hit = 0;
    for (const i of all) {
      const p = cellXZ(g, i), d = Math.hypot(p.x, p.z) / r;
      if (d > from && d <= to) { n++; if (got.has(i)) hit++; }
    }
    return hit / n;
  };
  const inner = share(0.6, 0.7), mid = share(0.75, 0.85), outer = share(0.9, 1);
  assert.ok(inner > 0.75 && inner <= 1, `near the core most vertices are painted (${inner})`);
  assert.ok(mid > 0.25 && mid < 0.75, `half way about half (${mid})`);
  assert.ok(outer < 0.25, `at the rim few (${outer})`);
});

test('softDisc: one seed, one pattern - another seed, another', () => {
  const g = grid(101, 2);
  assert.deepEqual([...softDisc(g, 4, -6, 24, 3)], [...softDisc(g, 4, -6, 24, 3)]);
  assert.notDeepEqual([...softDisc(g, 4, -6, 24, 3)], [...softDisc(g, 4, -6, 24, 4)]);
  // the choice belongs to the vertex, not to the dab: a vertex one dab keeps is kept by every dab of the same stroke
  // that gives it at least the same chance - so a stroke never comes out more ragged than its dabs
  const chance = (i, cx) => { const p = cellXZ(g, i), d = Math.hypot(p.x - cx, p.z); return d <= 12 ? 1 : (20 - d) / 8; };
  const a = softDisc(g, 0, 0, 20, 9), b = new Set(softDisc(g, 6, 0, 20, 9));
  let compared = 0;
  for (const i of a) {
    if (chance(i, 6) < chance(i, 0)) continue;
    assert.ok(b.has(i));
    compared++;
  }
  assert.ok(compared > 100);
  assert.deepEqual([...softDisc(g, 0, 0, 20, null)], [...softDisc(g, 0, 0, 20, 0)], 'a missing seed is seed 0, still soft');
});

// ---------------------------------------------------------------- capsule

test('capsule: every vertex within the radius of the segment', () => {
  const g = grid(61, 2);
  for (const [x0, z0, x1, z1, r] of [[0, 40, 10, 40, 4], [-21.5, 3.2, 17.9, -30.4, 5.5], [5, 5, 5, -25, 2], [-8, -8, 12, 12, 1.5], [3, 3, 3, 3, 6]]) {
    same(g, capsule(g, x0, z0, x1, z1, r), brute(g, (x, z) => segDist(x, z, x0, z0, x1, z1) <= r + 1e-9), `(${x0}, ${z0}) - (${x1}, ${z1}) r ${r}`);
  }
  assert.deepEqual([...capsule(g, 3, 3, 3, 3, 6)], [...disc(g, 3, 3, 6)], 'a segment of no length is a disc');
  assert.deepEqual([...capsule(g, 0, 0, 20, 8, 5)], [...capsule(g, 20, 8, 0, 0, 5)], 'the direction does not matter');
});

test('capsule: the acceptance stroke - radius 4 from (0, 40) to (10, 40) covers (5, 40)', () => {
  const map = emptyMap(), g = map.ground;
  const a = capsule(g, 0, 40, 10, 40, 4);
  assert.ok(a.includes(cellIndex(g, 5, 40)));
  assert.ok(a.includes(cellIndex(g, 0, 36)) && a.includes(cellIndex(g, 14, 40)) && !a.includes(cellIndex(g, 16, 40)));
  const store = createStore();
  store.load(map);
  store.exec(cmd.paint(a, GROUND_INDEX.sand));
  assert.equal(groundAt(map, 5, 40).id, 'sand');
  store.undo();
  assert.equal(groundAt(map, 5, 40).id, 'grass');
});

test('capsule: clipped at the border, and both ends may be outside', () => {
  const g = grid(21, 2);
  same(g, capsule(g, -60, 0, 60, 0, 3), brute(g, (x, z) => Math.abs(z) <= 3), 'through the whole grid');
  same(g, capsule(g, 18, 18, 40, 40, 4), brute(g, (x, z) => segDist(x, z, 18, 18, 40, 40) <= 4), 'out through a corner');
  same(g, capsule(g, 30, -30, 30, 30, 5), [], 'past the grid');
});

test('capsule with a seed: the soft edge along the whole segment', () => {
  const g = grid(81, 2), r = 12;
  const soft = capsule(g, -30, 5, 30, -10, r, 11);
  same(g, soft, brute(g, (x, z, ix, iz) => {
    const d = segDist(x, z, -30, 5, 30, -10);
    return d <= r * SOFT_CORE || (d <= r + 1e-9 && cellHash(ix, iz, 11) < (r - d) / (r - r * SOFT_CORE));
  }), 'the definition');
  const hard = new Set(capsule(g, -30, 5, 30, -10, r));
  assert.ok(soft.length < hard.size);
  for (const i of capsule(g, -30, 5, 30, -10, r * SOFT_CORE)) assert.ok(soft.includes(i));
  // a stroke is many capsules with one seed: painted in pieces or in one go, the same vertices
  const pieces = new Set([...capsule(g, -30, 5, 0, -2.5, r, 11), ...capsule(g, 0, -2.5, 30, -10, r, 11)]);
  assert.deepEqual([...pieces].sort((a, b) => a - b), [...soft]);
  assert.deepEqual([...capsule(g, 0, 0, 0, 0, r, 11)], [...softDisc(g, 0, 0, r, 11)]);
});

// ---------------------------------------------------------------- ribbon

test('ribbon: every vertex within half the width of the polyline, each one once', () => {
  const g = grid(81, 2);
  const lines = [
    [[-40, -40], [0, 0], [40, -40]],                              // a sharp bend: the two legs share the joint
    [[-50, 10], [-20, 12], [-20, 12], [10, -30], [44, 44]],       // a point twice
    [[0, 0], [30, 0], [0, 0.5], [30, 1]],                         // legs that lie on each other
    [[12, -7]],                                                    // one point: a disc
  ];
  for (const points of lines) {
    for (const width of [2, 4, 7, 12]) {
      same(g, ribbon(g, points, width), brute(g, (x, z) => lineDist(x, z, points) <= width / 2 + 1e-9), `${points.length} points, width ${width}`);
    }
  }
  assert.deepEqual([...ribbon(g, [[12, -7]], 8)], [...disc(g, 12, -7, 4)]);
  // the union of the capsules of its segments, without the vertices they share appearing twice
  const points = lines[0], parts = [...capsule(g, -40, -40, 0, 0, 3), ...capsule(g, 0, 0, 40, -40, 3)];
  assert.ok(parts.length > new Set(parts).size, 'the capsules do overlap');
  assert.deepEqual([...ribbon(g, points, 6)], [...new Set(parts)].sort((a, b) => a - b));
});

test('ribbon: clipped at the border; points that are no points are skipped', () => {
  const g = grid(21, 2);
  const points = [[-100, -100], [100, 100]];
  same(g, ribbon(g, points, 4), brute(g, (x, z) => lineDist(x, z, points) <= 2 + 1e-9), 'corner to corner and beyond');
  same(g, ribbon(g, [[40, 40], [60, 80]], 6), [], 'outside');
  assert.deepEqual([...ribbon(g, [[0, 0], [NaN, 3], null, [10, 0]], 4)], [...ribbon(g, [[0, 0], [10, 0]], 4)]);
});

test('ribbon: a second call is not disturbed by the first (the scratch marks are cleared)', () => {
  const g = grid(81, 2);
  const a = [...ribbon(g, [[-60, 0], [60, 0]], 12)];
  ribbon(g, [[-60, -60], [60, 60], [-60, 60]], 12);
  flood(g, 0);
  assert.deepEqual([...ribbon(g, [[-60, 0], [60, 0]], 12)], a);
});

// ---------------------------------------------------------------- flood

test('flood: the connected vertices of one type', () => {
  const g = grid(21, 2), at = (ix, iz) => iz * g.size + ix;
  for (let i = 0; i < g.size; i++) g.cells[at(10, i)] = 3;   // a wall from top to bottom
  const left = flood(g, at(2, 2)), right = flood(g, at(15, 9)), wall = flood(g, at(10, 0));
  same(g, left, brute(g, (x, z, ix) => ix < 10), 'the left half');
  same(g, right, brute(g, (x, z, ix) => ix > 10), 'the right half');
  same(g, wall, brute(g, (x, z, ix) => ix === 10), 'the wall itself');
  g.cells[at(10, 7)] = 0;                                   // a gap of one vertex joins the halves
  assert.equal(flood(g, at(2, 2)).length, 21 * 21 - 20);
  same(g, flood(g, at(10, 20)), brute(g, (x, z, ix, iz) => ix === 10 && iz > 7), 'the wall below the gap');
});

test('flood: 4-connected - a diagonal is no way through', () => {
  const g = grid(9, 2), at = (ix, iz) => iz * g.size + ix;
  // a diagonal wall: its vertices touch only at their corners, and so do the two sides
  for (let i = 0; i < g.size; i++) g.cells[at(i, i)] = 5;
  same(g, flood(g, at(8, 0)), brute(g, (x, z, ix, iz) => ix > iz), 'above the diagonal');
  same(g, flood(g, at(0, 8)), brute(g, (x, z, ix, iz) => ix < iz), 'below it');
  same(g, flood(g, at(4, 4)), [at(4, 4)], 'a wall vertex has no 4-neighbour of its own type');
});

test('flood: limited to hypot(x, z) <= radius around the centre of the map', () => {
  const g = grid(41, 2);                                    // one type everywhere, the grid spans -40 .. 40
  const centre = cellIndex(g, 0, 0);
  same(g, flood(g, centre, { radius: 20 }), brute(g, (x, z) => Math.hypot(x, z) <= 20), 'radius 20, the rim included');
  assert.ok(flood(g, centre, { radius: 20 }).includes(cellIndex(g, 20, 0)));
  same(g, flood(g, cellIndex(g, 12, -8), { radius: 20 }), brute(g, (x, z) => Math.hypot(x, z) <= 20), 'the same from any vertex inside');
  same(g, flood(g, cellIndex(g, 30, 0), { radius: 20 }), [], 'a start outside the radius fills nothing');
  assert.equal(flood(g, centre).length, 41 * 41);
  assert.equal(flood(g, centre, {}).length, 41 * 41);
  assert.equal(flood(g, centre, { radius: 1000 }).length, 41 * 41);
  same(g, flood(g, centre, { radius: 0 }), [centre], 'radius 0 is the centre vertex');
  // the radius cuts a region off even when the type goes on beyond it
  for (let i = 0; i < g.cells.length; i++) { const p = cellXZ(g, i); if (Math.abs(p.z) > 6) g.cells[i] = 2; }
  same(g, flood(g, centre, { radius: 20 }), brute(g, (x, z) => Math.abs(z) <= 6 && Math.hypot(x, z) <= 20), 'a band, cut at the radius');
});

test('flood: on a real island it stays on the island, and reaches the grid border when nothing stops it', () => {
  const map = emptyMap({ radius: 60 }), g = map.ground;     // grass inside 58, a sand shore
  const grass = flood(g, cellIndex(g, 0, 0), { radius: map.radius });
  same(g, grass, brute(g, (x, z) => Math.hypot(x, z) <= 58), 'the grass');
  assert.ok(!flood(g, cellIndex(g, 60, 0), { radius: map.radius }).some((i) => Math.hypot(cellXZ(g, i).x, cellXZ(g, i).z) > 60), 'the shore: nothing beyond the radius');
  // a wider beach: sand from 40 outwards. Filling it from the island side stops at the radius, all the way round
  loaded(map).exec(cmd.paint(brute(g, (x, z) => Math.hypot(x, z) > 40), GROUND_INDEX.sand));
  const shore = flood(g, cellIndex(g, 50, 0), { radius: map.radius });
  same(g, shore, brute(g, (x, z) => Math.hypot(x, z) > 40 && Math.hypot(x, z) <= 60), 'the ring of sand inside the radius');
  const sea = flood(g, 0);                                   // from a corner of the grid, no limit: all the sand
  same(g, sea, brute(g, (x, z) => Math.hypot(x, z) > 40), 'everything beyond the grass, corners and edges included');
  assert.ok(sea.includes(g.size * g.size - 1) && sea.includes(g.size - 1));
});

// ---------------------------------------------------------------- inside

test('inside: the vertices of a region shape, by the format\'s own inShape', () => {
  const g = grid(61, 2);
  const shapes = [
    { type: 'circle', x: 10, z: -20, r: 14 },
    { type: 'circle', x: 0, z: 0, r: 2 },
    { type: 'poly', points: [[-30, -30], [30, -30], [30, 30], [-30, 30]] },
    { type: 'poly', points: [[-40, 0], [0, -35], [45, 5], [10, 12], [0, 50]] },               // concave
    { type: 'poly', points: [[-30, -30], [30, 30], [30, -30], [-30, 30]] },                    // a bow tie (even-odd)
    { type: 'poly', points: [[30, 30], [-30, 30], [-30, -30], [30, -30]] },                    // the other winding
  ];
  for (const s of shapes) same(g, inside(g, s), brute(g, (x, z) => inShape(s, x, z)), JSON.stringify(s).slice(0, 60));
  assert.ok(inside(g, shapes[0]).includes(cellIndex(g, 10, -6)) && inside(g, shapes[0]).includes(cellIndex(g, 24, -20)), 'a circle is edge-inclusive');
  assert.equal(inside(g, shapes[1]).length, 5);
});

test('inside: clipped at the border of the grid', () => {
  const g = grid(21, 2);
  const circle = { type: 'circle', x: 20, z: 20, r: 9 }, poly = { type: 'poly', points: [[-100, -5], [100, -5], [100, 5], [-100, 5]] };
  same(g, inside(g, circle), brute(g, (x, z) => inShape(circle, x, z)), 'a circle on the corner');
  same(g, inside(g, poly), brute(g, (x, z) => inShape(poly, x, z)), 'a band wider than the grid');
  same(g, inside(g, { type: 'circle', x: 0, z: 0, r: 500 }), brute(g, () => true), 'a shape around everything');
  same(g, inside(g, { type: 'circle', x: 200, z: 0, r: 5 }), [], 'a shape off the grid');
});

test('runs: the rows of a shape as unbroken runs, not one vertex different from inShape', () => {
  // a small generator with a fixed seed: the same polygons on every run
  let seed = 20261006;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const g = grid(81, 2);                                 // vertices on even coordinates, -80 .. 80
  const shapes = [];
  for (let n = 0; n < 60; n++) {
    const points = [], count = 3 + Math.floor(rnd() * 30);
    // half of them on the grid of the vertices themselves: corners ON rows and columns, and edges that run along them
    const snap = n % 2 === 0 ? (v) => Math.round(v / 2) * 2 : (v) => Math.round(v * 100) / 100;
    for (let i = 0; i < count; i++) points.push([snap(rnd() * 200 - 100), snap(rnd() * 200 - 100)]);
    shapes.push({ type: 'poly', points });
  }
  shapes.push({ type: 'circle', x: 3.3, z: -7.1, r: 41.7 }, { type: 'circle', x: 78, z: 78, r: 10 }, { type: 'circle', x: 0, z: 0, r: 0 });
  for (const s of shapes) {
    const got = [];
    let last = -1;
    runs(g, s, (iz, ix0, ix1) => {
      assert.ok(Number.isInteger(iz) && ix0 <= ix1 && ix0 >= 0 && ix1 < g.size, 'a run on the grid');
      const first = iz * g.size + ix0;
      assert.ok(first > last + 1 || last < 0 || Math.floor(last / g.size) !== iz, 'rows north to south, runs west to east, never touching');
      for (let ix = ix0; ix <= ix1; ix++) got.push(iz * g.size + ix);
      last = iz * g.size + ix1;
    });
    assert.deepEqual(got, brute(g, (x, z) => inShape(s, x, z)), JSON.stringify(s).slice(0, 80));
    same(g, inside(g, s), got, 'inside() is the same vertices');
  }
  // nothing is visited for what is no shape, or misses the grid
  for (const bad of [null, { type: 'star' }, { type: 'circle', x: 0, z: 0, r: -4 }, { type: 'circle', x: NaN, z: 0, r: 4 },
    { type: 'poly', points: [[0, 0], [1, 1]] }, { type: 'poly', points: [[0, 0], [1, 1], [2, 'x']] }, { type: 'circle', x: 500, z: 0, r: 5 }]) {
    runs(g, bad, () => assert.fail(`visited for ${JSON.stringify(bad)}`));
  }
  runs(null, shapes[0], () => assert.fail('no ground'));
});

test('runs: a polygon costs its edges per row - 64 regions of 64 points over the largest grid are quick', () => {
  const g = grid(513, 2);
  const star = (k) => ({ type: 'poly', points: Array.from({ length: 64 }, (_, i) => {
    const a = i / 64 * Math.PI * 2, r = (i % 2 ? 380 : 500) - k;
    return [Math.round(Math.cos(a) * r * 100) / 100, Math.round(Math.sin(a) * r * 100) / 100];
  }) });
  const t0 = performance.now();
  let n = 0;
  for (let k = 0; k < 64; k++) runs(g, star(k), (iz, ix0, ix1) => { n += ix1 - ix0 + 1; });
  const ms = performance.now() - t0;
  assert.ok(n > 64 * 100000, 'they cover most of the grid');
  assert.ok(ms < 1000, `took ${Math.round(ms)} ms (vertex by vertex this is about 1.1 thousand million edge tests)`);
});

// ---------------------------------------------------------------- boundsOf

test('boundsOf: the inclusive vertex rectangle', () => {
  const g = grid(41, 2), at = (ix, iz) => iz * g.size + ix;
  assert.equal(boundsOf(g, []), null);
  assert.equal(boundsOf(g, new Int32Array(0)), null);
  assert.deepEqual(boundsOf(g, [at(7, 3)]), { ix0: 7, iz0: 3, ix1: 7, iz1: 3 });
  assert.deepEqual(boundsOf(g, Int32Array.of(at(7, 30), at(12, 3), at(0, 9))), { ix0: 0, iz0: 3, ix1: 12, iz1: 30 });
  assert.deepEqual(boundsOf(g, [at(40, 40), at(0, 0)]), { ix0: 0, iz0: 0, ix1: 40, iz1: 40 });
  assert.deepEqual(boundsOf(g, [-1, 41 * 41, at(5, 5), NaN]), { ix0: 5, iz0: 5, ix1: 5, iz1: 5 }, 'indices off the grid are not counted');
  assert.equal(boundsOf(g, [-4, 41 * 41]), null);
  // of a disc: exactly its extent
  const b = boundsOf(g, disc(g, 0, 0, 10));
  assert.deepEqual(b, { ix0: 15, iz0: 15, ix1: 25, iz1: 25 });
  assert.deepEqual(boundsOf(g, disc(g, -44, -44, 10)), { ix0: 0, iz0: 0, ix1: 2, iz1: 2 }, 'a disc over the corner: clipped');
});

test('boundsOf is the rectangle cmd.paint reports for the same cells', () => {
  const map = emptyMap(), g = map.ground, store = createStore();
  store.load(map);
  const cells = ribbon(g, [[-30, 12], [5, 40], [44, 38]], 6);
  const change = store.exec(cmd.paint(cells, GROUND_INDEX.dirt));
  assert.deepEqual(change.ground, boundsOf(g, cells));
  store.undo();
  assert.equal(groundAt(map, 5, 40).id, 'grass');
});

// ---------------------------------------------------------------- a map whose radius changes

test('after a radius change the ground is another grid: the same world shape covers the same world vertices', () => {
  const small = emptyMap({ radius: 60 }).ground;
  const big = resizeGround(small, 140);
  assert.notEqual(big, small);
  assert.ok(big.size > small.size);
  const cases = [
    (g) => disc(g, 12, -30, 9),
    (g) => softDisc(g, 12, -30, 9, 5).length >= 0 && disc(g, 12, -30, 9 * SOFT_CORE),   // the solid core (the dither is per grid index)
    (g) => capsule(g, -50, 10, 44, -20, 5),
    (g) => ribbon(g, [[-50, -50], [0, 20], [50, -40]], 8),
    (g) => inside(g, { type: 'poly', points: [[-40, -10], [40, -30], [10, 45]] }),
    (g) => inside(g, { type: 'circle', x: 5, z: 5, r: 33 }),
  ];
  for (const run of cases) {
    const a = run(small), b = run(big);
    wellFormed(small, a);
    wellFormed(big, b);
    assert.deepEqual(worldSet(big, b), worldSet(small, a));
    for (const i of b) assert.equal(cellIndex(big, cellXZ(big, i).x, cellXZ(big, i).z), i);
  }
  // a shape that the small grid cut off is whole on the large one
  assert.ok(disc(big, 80, 0, 10).length > disc(small, 80, 0, 10).length);
  assert.equal(disc(big, 100, 0, 10).length, 81);
  assert.equal(disc(small, 100, 0, 10).length, 0);
});

test('after a radius change the fill follows the new radius, through the store', () => {
  const map = emptyMap({ radius: 60 }), store = createStore();
  store.load(map);
  const before = map.ground, centre = () => cellIndex(map.ground, 0, 0);
  const n60 = flood(before, centre(), { radius: map.radius }).length;
  store.exec(cmd.setProps({ radius: 140 }));
  assert.notEqual(map.ground, before);                         // resized: a new ground object
  assert.equal(map.radius, 140);
  const g = map.ground;
  // the old cells stayed where they were in the world: the grass is the same disc, and so is the fill of it
  assert.equal(flood(g, centre(), { radius: map.radius }).length, n60);
  // paint the whole grid with one type: now only the radius limits the fill
  store.exec(cmd.paint(inside(g, { type: 'circle', x: 0, z: 0, r: 1000 }), GROUND_INDEX.grass));
  same(g, flood(g, centre(), { radius: 60 }), brute(g, (x, z) => Math.hypot(x, z) <= 60), 'the old radius');
  same(g, flood(g, centre(), { radius: map.radius }), brute(g, (x, z) => Math.hypot(x, z) <= 140), 'the new radius');
  assert.equal(flood(g, cellIndex(g, 100, 0), { radius: 60 }).length, 0, 'a vertex the old radius did not reach');
  assert.ok(flood(g, cellIndex(g, 100, 0), { radius: map.radius }).length > 0);
  store.undo();
  store.undo();
  assert.equal(map.ground, before);                            // and back: the functions take whatever ground they are given
  assert.equal(flood(map.ground, centre(), { radius: map.radius }).length, n60);
});
