// The ground rasteriser: which vertices of the ground grid a brush dab, a brush stroke, a road, a flood fill or a
// region covers. The Terrain tool turns the result into one cmd.paint().
//
// PURE: no DOM, no three, nothing remembered between two calls (the two buffers below are scratch space and are
// handed out cleared). `ground` is { size, cell, cells } of a runtime map and is only read. Nothing is cached per
// ground: after a resize of the map the ground is ANOTHER object of another size, and every function works from the
// one it is given.
//
// Every function returns an Int32Array of indices into ground.cells - no index twice, in ascending order, never one
// outside the grid: a shape that reaches over the border of the grid is clipped to it, a shape that misses the grid
// gives an empty array. A radius that is not a number (or is negative) gives an empty array as well.
//
// Distances are inclusive, like every circle of the map format: a vertex exactly `radius` away is inside.
import { cellHash, inShape, shapeBounds } from '../map/format.js';

// A soft brush paints all of its inner 60 %; from there to the rim the share of painted vertices falls from 1 to 0.
export const SOFT_CORE = 0.6;

const EPS = 1e-9;                  // forgives the rounding of a vertex that sits exactly on a rim
const finite = Number.isFinite;

// ---------------------------------------------------------------- scratch space

let marks = new Uint8Array(0), queue = new Int32Array(0);

// n zeroed bytes: one per vertex of the rectangle or grid a function is working on
function cleared(n) {
  if (marks.length < n) marks = new Uint8Array(n);
  else marks.fill(0, 0, n);
  return marks;
}

// ---------------------------------------------------------------- grid helpers

const usable = (g) => !!g && Number.isInteger(g.size) && g.size > 0 && g.cell > 0 && !!g.cells;

// The inclusive range of vertex numbers (along one axis) that lies between the world coordinates a and b.
// lo > hi when there is none.
function span(g, a, b) {
  const c = (g.size - 1) / 2;
  return { lo: Math.max(0, Math.ceil(a / g.cell + c - EPS)), hi: Math.min(g.size - 1, Math.floor(b / g.cell + c + EPS)) };
}

// The vertices within `radius` of the segment (x0, z0) - (x1, z1), offered to `take(ix, iz)` row by row.
// seed !== null: the soft edge - a vertex beyond the core is taken with a probability that falls to 0 at the rim.
// The hash is per vertex and per seed, so every dab of one stroke makes the same choice for a vertex.
function sweep(g, x0, z0, x1, z1, radius, seed, take) {
  if (!usable(g) || !finite(x0) || !finite(z0) || !finite(x1) || !finite(z1) || !(radius >= 0) || !finite(radius)) return;
  const xs = span(g, Math.min(x0, x1) - radius, Math.max(x0, x1) + radius);
  const zs = span(g, Math.min(z0, z1) - radius, Math.max(z0, z1) + radius);
  if (xs.lo > xs.hi || zs.lo > zs.hi) return;
  const { cell } = g, c = (g.size - 1) / 2, dx = x1 - x0, dz = z1 - z0, len2 = dx * dx + dz * dz;
  const r2 = radius * radius + EPS, soft = seed !== null && seed !== undefined;
  const core = radius * SOFT_CORE, core2 = core * core, fall = radius - core;
  for (let iz = zs.lo; iz <= zs.hi; iz++) {
    const z = (iz - c) * cell;
    for (let ix = xs.lo; ix <= xs.hi; ix++) {
      const x = (ix - c) * cell;
      let t = len2 > 0 ? ((x - x0) * dx + (z - z0) * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = x - (x0 + t * dx), ez = z - (z0 + t * dz), d2 = ex * ex + ez * ez;
      if (d2 > r2) continue;
      if (soft && d2 > core2 && !(cellHash(ix, iz, seed) < (radius - Math.sqrt(d2)) / fall)) continue;
      take(ix, iz);
    }
  }
}

// ---------------------------------------------------------------- brushes

// A disc swept along a segment: every vertex within `radius` of it. seed != null gives it the soft edge of softDisc.
// Both ends may lie outside the grid.
export function capsule(ground, x0, z0, x1, z1, radius, seed = null) {
  if (!usable(ground) || !(radius >= 0) || !finite(radius) || !finite(x0) || !finite(z0) || !finite(x1) || !finite(z1)) return new Int32Array(0);
  const xs = span(ground, Math.min(x0, x1) - radius, Math.max(x0, x1) + radius);
  const zs = span(ground, Math.min(z0, z1) - radius, Math.max(z0, z1) + radius);
  if (xs.lo > xs.hi || zs.lo > zs.hi) return new Int32Array(0);
  const out = new Int32Array((xs.hi - xs.lo + 1) * (zs.hi - zs.lo + 1)), size = ground.size;
  let n = 0;
  sweep(ground, x0, z0, x1, z1, radius, seed, (ix, iz) => { out[n++] = iz * size + ix; });   // row by row: ascending
  return out.slice(0, n);
}

// Every vertex within `radius` of the point (the hard brush).
export function disc(ground, x, z, radius) {
  return capsule(ground, x, z, x, z, radius, null);
}

// The soft brush: all vertices of the inner 60 %, then a dither - between 60 % and 100 % of the radius a vertex is
// painted with a probability that falls from 1 to 0, decided by cellHash(ix, iz, seed). One seed per stroke.
export function softDisc(ground, x, z, radius, seed) {
  return capsule(ground, x, z, x, z, radius, seed ?? 0);
}

// ---------------------------------------------------------------- roads

// A hard-edged polyline of the given width through points [[x, z], ...]: every vertex within width / 2 of one of its
// segments (round joints and round ends). One point gives a disc. A vertex two segments share is listed once.
export function ribbon(ground, points, width) {
  const half = width / 2, list = [];
  if (Array.isArray(points)) for (const p of points) if (Array.isArray(p) && finite(p[0]) && finite(p[1])) list.push(p);
  if (!usable(ground) || !list.length || !(half >= 0) || !finite(half)) return new Int32Array(0);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of list) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const xs = span(ground, minX - half, maxX + half), zs = span(ground, minZ - half, maxZ + half);
  if (xs.lo > xs.hi || zs.lo > zs.hi) return new Int32Array(0);
  // one mark per vertex of the rectangle around the whole line: that is what keeps a joint from being listed twice
  const w = xs.hi - xs.lo + 1, hgt = zs.hi - zs.lo + 1, seen = cleared(w * hgt);
  let n = 0;
  const take = (ix, iz) => {
    const k = (iz - zs.lo) * w + (ix - xs.lo);
    if (!seen[k]) { seen[k] = 1; n++; }
  };
  if (list.length === 1) sweep(ground, list[0][0], list[0][1], list[0][0], list[0][1], half, null, take);
  for (let i = 1; i < list.length; i++) sweep(ground, list[i - 1][0], list[i - 1][1], list[i][0], list[i][1], half, null, take);
  const out = new Int32Array(n), size = ground.size;
  for (let iz = 0, k = 0, o = 0; iz < hgt; iz++) {
    for (let ix = 0; ix < w; ix++, k++) if (seen[k]) out[o++] = (iz + zs.lo) * size + ix + xs.lo;
  }
  return out;
}

// ---------------------------------------------------------------- fills

// Flood fill: the vertex `index` and every vertex of the same ground type that can be reached from it through
// 4-connected neighbours of that type (never across a diagonal), without leaving the disc hypot(x, z) <= radius around
// the centre of the map - pass map.radius, so a fill stays on the island. No radius: the whole grid.
// An index outside the grid, or a start vertex outside the radius, fills nothing.
export function flood(ground, index, { radius } = {}) {
  if (!usable(ground)) return new Int32Array(0);
  const { size, cell, cells } = ground, total = size * size, limit = radius ?? Infinity;
  if (!Number.isInteger(index) || index < 0 || index >= total || !(limit >= 0)) return new Int32Array(0);
  const c = (size - 1) / 2, r2 = limit * limit + EPS;
  const within = (ix, iz) => { const x = (ix - c) * cell, z = (iz - c) * cell; return x * x + z * z <= r2; };
  const ix0 = index % size, iz0 = (index - ix0) / size;
  if (!within(ix0, iz0)) return new Int32Array(0);
  const type = cells[index], seen = cleared(total);
  if (queue.length < total) queue = new Int32Array(total);
  let head = 0, tail = 0, rowLo = iz0, rowHi = iz0;
  seen[index] = 1;
  queue[tail++] = index;
  // a vertex is marked when it is queued, so it is queued once and the queue never outgrows the grid
  const visit = (ix, iz) => {
    const i = iz * size + ix;
    if (seen[i] || cells[i] !== type || !within(ix, iz)) return;
    seen[i] = 1;
    queue[tail++] = i;
    if (iz < rowLo) rowLo = iz;
    if (iz > rowHi) rowHi = iz;
  };
  while (head < tail) {
    const i = queue[head++], ix = i % size, iz = (i - ix) / size;
    if (ix > 0) visit(ix - 1, iz);
    if (ix < size - 1) visit(ix + 1, iz);
    if (iz > 0) visit(ix, iz - 1);
    if (iz < size - 1) visit(ix, iz + 1);
  }
  const out = new Int32Array(tail);
  for (let i = rowLo * size, end = (rowHi + 1) * size, o = 0; i < end; i++) if (seen[i]) out[o++] = i;   // ascending
  return out;
}

// A region shape the rasteriser can walk: a circle with finite numbers and a radius of 0 or more, or a polygon of at
// least three finite points.
function walkable(shape) {
  if (!shape) return false;
  if (shape.type === 'circle') return finite(shape.x) && finite(shape.z) && shape.r >= 0 && finite(shape.r);
  return shape.type === 'poly' && Array.isArray(shape.points) && shape.points.length >= 3
    && shape.points.every((p) => Array.isArray(p) && finite(p[0]) && finite(p[1]));
}

// The vertices inside a region shape, row by row: visit(iz, ix0, ix1) for every unbroken run of them (ix0 .. ix1, both
// inside), rows from north to south and the runs of a row from west to east. Nothing is visited for a shape that is
// not one, or that misses the grid.
// What is inside is decided exactly as the map format's inShape decides it - for a polygon with inShape's own
// expressions, so that not one vertex differs from what the game calls inside the region. But a polygon costs its
// edges once per ROW, not once per vertex: inShape counts the edges that cross the row to the right of a point, so
// the crossings of a row are computed once, sorted, and every vertex of the row is answered by where it stands among
// them. A 64-point region over a 513-vertex grid is 513 x (64 edges + a sort), not 263,000 x 64 edges.
export function runs(ground, shape, visit) {
  if (!usable(ground) || !walkable(shape)) return;
  const b = shapeBounds(shape), xs = span(ground, b.minX, b.maxX), zs = span(ground, b.minZ, b.maxZ);
  if (xs.lo > xs.hi || zs.lo > zs.hi) return;
  const { size, cell } = ground, c = (size - 1) / 2;
  if (shape.type === 'circle') {
    for (let iz = zs.lo; iz <= zs.hi; iz++) {
      const z = (iz - c) * cell;
      let from = -1;
      for (let ix = xs.lo; ix <= xs.hi; ix++) {
        if (inShape(shape, (ix - c) * cell, z)) { if (from < 0) from = ix; } else if (from >= 0) { visit(iz, from, ix - 1); from = -1; }
      }
      if (from >= 0) visit(iz, from, xs.hi);
    }
    return;
  }
  const p = shape.points, crossings = new Float64Array(p.length);
  for (let iz = zs.lo; iz <= zs.hi; iz++) {
    const z = (iz - c) * cell;
    let m = 0;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const xi = p[i][0], zi = p[i][1], xj = p[j][0], zj = p[j][1];
      if ((zi > z) !== (zj > z)) crossings[m++] = (xj - xi) * (z - zi) / (zj - zi) + xi;     // as in inShape, to the letter
    }
    if (!m) continue;
    const sorted = crossings.subarray(0, m).sort();     // ascending, by value
    // inShape: inside when an odd number of crossings lies to the right of the point (x < crossing)
    let k = 0, from = -1;
    for (let ix = xs.lo; ix <= xs.hi; ix++) {
      const x = (ix - c) * cell;
      while (k < m && !(x < sorted[k])) k++;
      if ((m - k) & 1) { if (from < 0) from = ix; } else if (from >= 0) { visit(iz, from, ix - 1); from = -1; }
    }
    if (from >= 0) visit(iz, from, xs.hi);
  }
}

// Every vertex inside a region shape ({ type: 'circle', x, z, r } or { type: 'poly', points }), by the map format's own
// inShape: what the game calls inside the region is exactly what gets painted.
export function inside(ground, shape) {
  if (!usable(ground) || !walkable(shape)) return new Int32Array(0);
  const b = shapeBounds(shape), xs = span(ground, b.minX, b.maxX), zs = span(ground, b.minZ, b.maxZ);
  if (xs.lo > xs.hi || zs.lo > zs.hi) return new Int32Array(0);
  const size = ground.size, out = new Int32Array((xs.hi - xs.lo + 1) * (zs.hi - zs.lo + 1));
  let n = 0;
  runs(ground, shape, (iz, ix0, ix1) => { for (let i = iz * size + ix0, end = iz * size + ix1; i <= end; i++) out[n++] = i; });
  return out.slice(0, n);
}

// ---------------------------------------------------------------- bounds

// -> { ix0, iz0, ix1, iz1 }: the INCLUSIVE vertex rectangle around the indices (what view.repaintGround takes), or null
// when there are none. Indices outside the grid are not counted.
export function boundsOf(ground, indices) {
  if (!usable(ground) || !indices || typeof indices.length !== 'number') return null;
  const size = ground.size, total = size * size;
  let ix0 = size, iz0 = size, ix1 = -1, iz1 = -1;
  for (let k = 0; k < indices.length; k++) {
    const i = indices[k];
    if (!Number.isInteger(i) || i < 0 || i >= total) continue;
    const ix = i % size, iz = (i - ix) / size;
    if (ix < ix0) ix0 = ix;
    if (ix > ix1) ix1 = ix;
    if (iz < iz0) iz0 = iz;
    if (iz > iz1) iz1 = iz;
  }
  return ix1 < 0 ? null : { ix0, iz0, ix1, iz1 };
}
