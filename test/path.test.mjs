// The row layout of the Place tool (src/editor/path.js): where the pieces of a Line and of a Ring go.
// Pure maths - no map, no browser. The ring of the editor's acceptance check is asserted here with the same numbers:
// medieval/wall_straight is 10 units long at s = 1, scaled 0.574, on a ring of radius 25.6 -> 28 pieces.
// Run: node --test test/path.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutLine, layoutRing, pathLength } from '../src/editor/path.js';

const TAU = Math.PI * 2;
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b} (within ${eps})`);
// two angles are the same direction
const sameAngle = (a, b, eps = 1e-9) => {
  const d = Math.abs(((a - b) % TAU + TAU + Math.PI) % TAU - Math.PI);
  assert.ok(d <= eps, `the angle ${a} is not ${b}`);
};
// the map's convention (local -> world): local +X of a piece turned by ry points at (cos ry, -sin ry), local +Z at (sin ry, cos ry)
const axisX = (ry) => [Math.cos(ry), -Math.sin(ry)];
const axisZ = (ry) => [Math.sin(ry), Math.cos(ry)];
// a random source that repeats: tests must not depend on luck
function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------- ring

test('layoutRing: the acceptance ring - 28 wall pieces of scale 0.574 close a ring of radius 25.6', () => {
  const pieces = layoutRing({ x: 0, z: 0 }, 25.6, { length: 10, s: 0.574, fit: true });
  assert.equal(pieces.length, 28);
  const s = TAU * 25.6 / (28 * 10);
  for (const p of pieces) {
    near(Math.hypot(p.x, p.z), 25.6, 1e-9);       // piece centres ON the circle
    near(p.s, s, 1e-12);                          // scaled so that the ring closes
  }
  near(pieces[0].s, 0.5745, 5e-4);                // ... which is next to nothing: 0.574 -> 0.5745
  near(pieces[0].x, 25.6);                        // the first piece at startAngle 0
  near(pieces[0].z, 0);
  // evenly spread: every neighbour is the same chord away
  const chord = 2 * 25.6 * Math.sin(Math.PI / 28);
  pieces.forEach((p, i) => {
    const q = pieces[(i + 1) % pieces.length];
    near(Math.hypot(q.x - p.x, q.z - p.z), chord, 1e-9);
  });
});

test('layoutRing: without fit the count is the same and the scale is left alone', () => {
  const pieces = layoutRing({ x: 0, z: 0 }, 25.6, { length: 10, s: 0.574 });
  assert.equal(pieces.length, 28);
  for (const p of pieces) assert.equal(p.s, 0.574);
});

test('layoutRing: centre, radius and startAngle place the pieces', () => {
  const pieces = layoutRing({ x: 100, z: -40 }, 10, { length: 5, startAngle: Math.PI / 2 });
  assert.equal(pieces.length, Math.round(TAU * 10 / 5));   // 13
  near(pieces[0].x, 100);
  near(pieces[0].z, -30);                                  // angle PI / 2 is +Z
  for (const p of pieces) near(Math.hypot(p.x - 100, p.z + 40), 10);
});

test('layoutRing: along and centre turn local +X along the ring and local +Z to its centre', () => {
  for (const orient of ['along', 'centre']) {
    for (const p of layoutRing({ x: 3, z: 4 }, 20, { length: 4, orient })) {
      const [rx, rz] = [(p.x - 3) / 20, (p.z - 4) / 20];            // unit vector from the centre to the piece
      const [xx, xz] = axisX(p.ry), [zx, zz] = axisZ(p.ry);
      near(xx * rx + xz * rz, 0, 1e-9);                             // +X is tangent
      near(zx, -rx, 1e-9);                                          // +Z points at the centre
      near(zz, -rz, 1e-9);
    }
  }
});

test('layoutRing: perp points local +X out of the ring, turn is added to every piece', () => {
  for (const p of layoutRing({ x: 0, z: 0 }, 20, { length: 4, orient: 'perp' })) {
    const [xx, xz] = axisX(p.ry);
    near(xx, p.x / 20, 1e-9);
    near(xz, p.z / 20, 1e-9);
  }
  const plain = layoutRing({ x: 0, z: 0 }, 20, { length: 4 }), turned = layoutRing({ x: 0, z: 0 }, 20, { length: 4, turn: Math.PI });
  plain.forEach((p, i) => sameAngle(turned[i].ry, p.ry + Math.PI));
});

test('layoutRing: offset moves the pieces outwards, alternate puts every second one inside', () => {
  const out = layoutRing({ x: 0, z: 0 }, 20, { length: 4, offset: 2 });
  for (const p of out) near(Math.hypot(p.x, p.z), 22);
  const both = layoutRing({ x: 0, z: 0 }, 20, { length: 4, offset: 2, alternate: true });
  both.forEach((p, i) => near(Math.hypot(p.x, p.z), i % 2 ? 18 : 22));
});

test('layoutRing: a typed spacing counts the pieces; fit keeps their scale and spreads them evenly', () => {
  const pieces = layoutRing({ x: 0, z: 0 }, 30, { length: 1, s: 2, spacing: 6, fit: true });
  assert.equal(pieces.length, Math.round(TAU * 30 / 6));   // 31
  for (const p of pieces) assert.equal(p.s, 2);
});

test('layoutRing: no radius, no ring; a tiny ring still has one piece', () => {
  assert.deepEqual(layoutRing({ x: 0, z: 0 }, 0, { length: 10 }), []);
  assert.deepEqual(layoutRing({ x: 0, z: 0 }, NaN, { length: 10 }), []);
  assert.equal(layoutRing({ x: 0, z: 0 }, 0.1, { length: 10 }).length, 1);
});

// ---------------------------------------------------------------- line

test('layoutLine: pieces lie end to end from the first point', () => {
  const pieces = layoutLine([[0, 0], [30, 0]], { length: 10 });
  assert.deepEqual(pieces.map((p) => p.x), [5, 15, 25]);
  for (const p of pieces) {
    assert.equal(p.z, 0);
    assert.equal(p.s, 1);
    sameAngle(p.ry, 0);                                    // travelling +X: local +X is world +X
  }
});

test('layoutLine: the direction of travel sets the rotation (ry = atan2(-dz, dx))', () => {
  const south = layoutLine([[0, 0], [0, 20]], { length: 10 });       // +Z
  for (const p of south) {
    sameAngle(p.ry, -Math.PI / 2);
    const [xx, xz] = axisX(p.ry);
    near(xx, 0);
    near(xz, 1);                                                     // local +X runs along +Z
  }
  const diagonal = layoutLine([[0, 0], [10, 10]], { length: 5 });
  for (const p of diagonal) sameAngle(p.ry, -Math.PI / 4);
  const perp = layoutLine([[0, 0], [20, 0]], { length: 10, orient: 'perp' });
  for (const p of perp) {
    const [xx, xz] = axisX(p.ry);
    near(xx, 0);
    near(xz, -1);                                                    // to the left of travelling east: north (-Z)
  }
  // a line has no centre: 'centre' is 'along'
  assert.deepEqual(layoutLine([[0, 0], [20, 0]], { length: 10, orient: 'centre' }), layoutLine([[0, 0], [20, 0]], { length: 10 }));
});

test('layoutLine: the count is rounded; fit scales the pieces so the row ends on the last point', () => {
  assert.equal(layoutLine([[0, 0], [26, 0]], { length: 10 }).length, 3);     // 2.6 -> 3, the row overshoots
  assert.equal(layoutLine([[0, 0], [24, 0]], { length: 10 }).length, 2);     // 2.4 -> 2, it stops short
  const fit = layoutLine([[0, 0], [26, 0]], { length: 10, fit: true });
  assert.equal(fit.length, 3);
  for (const p of fit) near(p.s, 26 / 30);
  near(fit[0].x, 26 / 6);
  near(fit[2].x + (26 / 3) / 2, 26);                                         // the end of the last piece is the last point
  // the scale of the pieces takes part in the count
  assert.equal(layoutLine([[0, 0], [30, 0]], { length: 10, s: 0.5 }).length, 6);
});

test('layoutLine: fit with a typed spacing keeps the scale and stretches the spacing', () => {
  const pieces = layoutLine([[0, 0], [26, 0]], { length: 1, s: 1.5, spacing: 4, fit: true });
  assert.equal(pieces.length, 7);                                            // 6.5 -> 7
  for (const p of pieces) assert.equal(p.s, 1.5);
  near(pieces[1].x - pieces[0].x, 26 / 7);
  // without fit the typed spacing is the distance between two centres
  const loose = layoutLine([[0, 0], [26, 0]], { length: 1, spacing: 4 });
  near(loose[1].x - loose[0].x, 4);
  near(loose[0].x, 2);
});

test('layoutLine: every segment of a polyline is laid out by itself, so a corner is a clicked point', () => {
  const pieces = layoutLine([[0, 0], [20, 0], [20, 30]], { length: 10, fit: true });
  assert.equal(pieces.length, 5);
  assert.deepEqual(pieces.slice(0, 2).map((p) => [p.x, p.z]), [[5, 0], [15, 0]]);
  assert.deepEqual(pieces.slice(2).map((p) => [p.x, p.z]), [[20, 5], [20, 15], [20, 25]]);
  sameAngle(pieces[0].ry, 0);
  sameAngle(pieces[2].ry, -Math.PI / 2);
  // a repeated point is a segment of no length: it adds nothing; a short segment still gets its one piece
  assert.equal(layoutLine([[0, 0], [0, 0], [20, 0]], { length: 10 }).length, 2);
  assert.equal(layoutLine([[0, 0], [1, 0]], { length: 10 }).length, 1);
  near(layoutLine([[0, 0], [1, 0]], { length: 10, fit: true })[0].s, 0.1);
});

test('layoutLine: offset is to the left of travel and alternates on request', () => {
  const left = layoutLine([[0, 0], [30, 0]], { length: 10, offset: 2 });
  for (const p of left) near(p.z, -2);                                       // travelling east, left is north (-Z)
  const zigzag = layoutLine([[0, 0], [30, 0]], { length: 10, offset: 2, alternate: true });
  assert.deepEqual(zigzag.map((p) => p.z), [-2, 2, -2]);
  // the sides keep alternating across a corner
  const corner = layoutLine([[0, 0], [10, 0], [10, 10]], { length: 10, offset: 1, alternate: true });
  near(corner[0].z, -1);
  near(corner[1].x, 9);                                                      // second piece: the other side (travelling south, right is west)
});

test('layoutLine: random orientation and jitter come from rnd alone', () => {
  const a = layoutLine([[0, 0], [50, 0]], { length: 5, orient: 'random', jitter: 1.5, rnd: seeded(7) });
  const b = layoutLine([[0, 0], [50, 0]], { length: 5, orient: 'random', jitter: 1.5, rnd: seeded(7) });
  assert.deepEqual(a, b);
  assert.equal(a.length, 10);
  a.forEach((p, i) => {
    assert.ok(Math.hypot(p.x - (i * 5 + 2.5), p.z) <= 1.5 + 1e-9, 'a piece left its jitter disc');
    assert.ok(p.ry >= 0 && p.ry < TAU);
  });
  assert.ok(new Set(a.map((p) => p.ry)).size > 1);
  // no jitter and a fixed orientation: rnd is never asked
  layoutLine([[0, 0], [50, 0]], { length: 5, rnd: () => { throw new Error('rnd was called'); } });
});

test('layoutLine and layoutRing: bad input and absurd spacings stay bounded', () => {
  assert.deepEqual(layoutLine([], { length: 10 }), []);
  assert.deepEqual(layoutLine([[0, 0]], { length: 10 }), []);
  assert.deepEqual(layoutLine(null, { length: 10 }), []);
  assert.equal(layoutLine([[0, 0], [1000, 0]], { length: 10, spacing: 0.001 }).length, 2000);
  assert.equal(layoutLine([[0, 0], [1000, 0]], { length: 10, spacing: 0.001, max: 50 }).length, 50);
  assert.equal(layoutLine([[0, 0], [500, 0], [500, 500]], { length: 1, max: 600 }).length, 600);   // the cap is for the whole row
  assert.equal(layoutRing({ x: 0, z: 0 }, 500, { length: 0.001 }).length, 2000);
  // a spacing that is no positive number is "no spacing": the pieces touch
  for (const spacing of [0, -3, NaN, undefined, null]) assert.equal(layoutLine([[0, 0], [30, 0]], { length: 10, spacing }).length, 3);
  for (const p of layoutLine([[0, 0], [30, 0]], { length: 0 })) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.s));
});

test('pathLength: the length of a polyline', () => {
  assert.equal(pathLength([[0, 0], [3, 4], [3, 14]]), 15);
  assert.equal(pathLength([[1, 1]]), 0);
  assert.equal(pathLength([]), 0);
});
