// The arithmetic of the Sculpt tool: what a brush does to the heights of the ground. PURE - no DOM, no three, no store -
// so it is tested in Node (test/relief.test.mjs) and the tool (tools/sculpt.js) only turns its answers into commands.
//
// A stroke works on `work`: a Float32Array with one height per ground vertex, a private copy of ground.heights made
// when the stroke begins. The map holds heights on a 0.1 grid; a brush that is held still adds a few hundredths per
// frame at its rim, and on the map's own grid that would round to nothing for ever. So the stroke adds up exactly in
// `work`, and the tool writes what has become visible on the grid (cmd.heights quantises).
//
// Every rate is per SECOND and every dab takes the time since the last one: a stroke does the same at 30 and at 144
// frames a second.
import { LIMITS, heightAt, rayGround } from '../map/format.js';

export const SCULPT_MODES = ['raise', 'lower', 'smooth', 'flatten', 'set', 'ramp'];

const DEG = Math.PI / 180;
const RAISE_RATE = 24;          // world units per second in the middle of the brush at full strength
const SMOOTH_RATE = 14;         // per second: how fast a vertex closes the gap to the average of its neighbours
const LEVEL_RATE = 9;           // per second: how fast Flatten and Set close the gap to their height ...
const LEVEL_MIN = 5;            // ... and the units per second they move at least, so the last tenth is reached too
const MIN_REACH = 0.7072;       // half the diagonal of a cell: a brush always holds the vertex nearest to its centre
const SOFT_CORE = 0.5;          // Ramp, soft edge: this share of the half width is the road, the rest blends into the ground

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// How much of the brush a vertex gets at the relative distance t (0 the centre, 1 the rim).
//   soft   a bell: full in the middle, nothing at the rim        hard   all of it everywhere inside
export function falloff(t, soft) {
  if (!(t < 1)) return t === 1 && !soft ? 1 : 0;
  return soft ? 0.5 + 0.5 * Math.cos(Math.PI * Math.max(0, t)) : 1;
}

// The reach of a brush on this ground: its radius, but never so small that it falls between the vertices.
export const brushReach = (ground, radius) => Math.max(radius, ground.cell * MIN_REACH);

// The scratch a dab answers in; it grows and is reused, so sixty dabs a second allocate nothing.
let INDEX = new Int32Array(1024), VALUE = new Float32Array(1024);
function reserve(n) {
  if (n <= INDEX.length) return;
  let size = INDEX.length;
  while (size < n) size *= 2;
  INDEX = new Int32Array(size);
  VALUE = new Float32Array(size);
}

// One dab of the brush, `dt` seconds long, at (x, z). Mutates `work`.
//   brush = { x, z, radius, mode, strength /* 0..1 */, soft, target, slope }
//     mode     'raise' | 'lower'   the ground under the brush moves up / down
//              'smooth'            every vertex moves towards the average of the 3 x 3 vertices around it
//              'flatten' | 'set'   every vertex moves towards `target` (the height the stroke began at / the typed one)
//     slope    0 = no limit, else degrees: a vertex is not moved further than that slope allows above its lowest
//              (below its highest) neighbour. A slope that is steeper already is left alone, never made worse.
// -> { n, index, value }: the n vertices whose height changed and what they hold now. The two arrays are shared
//    scratch: read them before the next call.
export function dab(ground, work, brush, dt) {
  const { size, cell } = ground, last = size - 1, mid = last / 2, mode = brush.mode;
  const R = brushReach(ground, brush.radius), strength = clamp(Number(brush.strength) || 0, 0, 1), soft = !!brush.soft;
  const ix0 = Math.max(0, Math.ceil((brush.x - R) / cell + mid)), ix1 = Math.min(last, Math.floor((brush.x + R) / cell + mid));
  const iz0 = Math.max(0, Math.ceil((brush.z - R) / cell + mid)), iz1 = Math.min(last, Math.floor((brush.z + R) / cell + mid));
  const out = { n: 0, index: INDEX, value: VALUE };
  if (!(dt > 0) || ix0 > ix1 || iz0 > iz1 || !SCULPT_MODES.includes(mode) || mode === 'ramp') return out;
  reserve((ix1 - ix0 + 1) * (iz1 - iz0 + 1));
  out.index = INDEX;
  out.value = VALUE;
  const steep = brush.slope > 0 && brush.slope < 90 ? Math.tan(brush.slope * DEG) * cell : Infinity;
  const sign = mode === 'lower' ? -1 : 1, target = Number(brush.target) || 0;
  const [low, high] = LIMITS.height;
  let n = 0;
  for (let iz = iz0; iz <= iz1; iz++) {
    const dz = (iz - mid) * cell - brush.z, up = Math.max(0, iz - 1) * size, row = iz * size, down = Math.min(last, iz + 1) * size;
    for (let ix = ix0; ix <= ix1; ix++) {
      const d = Math.hypot((ix - mid) * cell - brush.x, dz);
      if (d > R) continue;
      const w = falloff(d / R, soft), h = work[row + ix], l = Math.max(0, ix - 1), r = Math.min(last, ix + 1);
      let v = h;
      if (mode === 'raise' || mode === 'lower') v = h + sign * RAISE_RATE * strength * w * dt;
      else if (mode === 'smooth') {
        const around = (work[up + l] + work[up + ix] + work[up + r] + work[row + l] + h + work[row + r] + work[down + l] + work[down + ix] + work[down + r]) / 9;
        v = h + (around - h) * (1 - Math.exp(-SMOOTH_RATE * strength * w * dt));
      } else {
        const gap = target - h, step = Math.abs(gap) * (1 - Math.exp(-LEVEL_RATE * strength * w * dt)) + LEVEL_MIN * strength * w * dt;
        v = Math.abs(gap) <= step ? target : h + Math.sign(gap) * step;
      }
      if (steep !== Infinity && mode !== 'smooth' && v !== h) {
        const a = work[up + ix], b = work[down + ix], c = work[row + l], e = work[row + r];
        if (v > h) v = Math.min(v, Math.max(h, Math.min(a, b, c, e) + steep));
        else v = Math.max(v, Math.min(h, Math.max(a, b, c, e) - steep));
      }
      v = Math.fround(clamp(v, low, high));
      if (v === h) continue;
      INDEX[n] = row + ix;
      VALUE[n++] = v;
    }
  }
  // written only now: every vertex was computed from the ground as the dab found it, whatever the order of the loop
  for (let k = 0; k < n; k++) work[INDEX[k]] = VALUE[k];
  out.n = n;
  return out;
}

// A ramp: the ground within `radius` of the segment from (x0, z0) to (x1, z1) is laid on the straight line from the
// height h0 at its start to h1 at its end - a road up a hill, a causeway, a pass. Computed from `base` (the heights
// before the stroke), never from an earlier ramp, so the tool may call it again for every pointer move.
//   soft   the middle half of the width is the ramp itself, the rest blends into the ground beside it
// -> { n, index, value }: EVERY vertex within reach with the height it gets (shared scratch, as dab).
export function ramp(ground, base, { x0, z0, h0, x1, z1, h1, radius, soft = true }) {
  const { size, cell } = ground, last = size - 1, mid = last / 2, R = brushReach(ground, radius);
  const ix0 = Math.max(0, Math.ceil((Math.min(x0, x1) - R) / cell + mid)), ix1 = Math.min(last, Math.floor((Math.max(x0, x1) + R) / cell + mid));
  const iz0 = Math.max(0, Math.ceil((Math.min(z0, z1) - R) / cell + mid)), iz1 = Math.min(last, Math.floor((Math.max(z0, z1) + R) / cell + mid));
  const out = { n: 0, index: INDEX, value: VALUE };
  if (ix0 > ix1 || iz0 > iz1) return out;
  reserve((ix1 - ix0 + 1) * (iz1 - iz0 + 1));
  out.index = INDEX;
  out.value = VALUE;
  const dx = x1 - x0, dz = z1 - z0, len2 = dx * dx + dz * dz, [low, high] = LIMITS.height;
  let n = 0;
  for (let iz = iz0; iz <= iz1; iz++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const px = (ix - mid) * cell - x0, pz = (iz - mid) * cell - z0;
      const t = len2 > 0 ? clamp((px * dx + pz * dz) / len2, 0, 1) : 0, d = Math.hypot(px - dx * t, pz - dz * t);
      if (d > R) continue;
      const i = iz * size + ix, k = d / R;
      const w = !soft || k <= SOFT_CORE ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * (k - SOFT_CORE) / (1 - SOFT_CORE));
      INDEX[n] = i;
      VALUE[n++] = Math.fround(clamp(base[i] + (h0 + (h1 - h0) * t - base[i]) * w, low, high));
    }
  }
  out.n = n;
  return out;
}

// How steep the ground is under a point, in degrees (0 = level): the slope of the terrain triangle the point lies on -
// the very triangle heightAt() of format.js reads its height from.
export function slopeAt(map, x, z) {
  const g = map.ground, h = g.heights;
  if (!h) return 0;
  const last = g.size - 1, mid = last / 2;
  const gx = clamp(x / g.cell + mid, 0, last), gz = clamp(z / g.cell + mid, 0, last);
  const ix = Math.min(last - 1, Math.floor(gx)), iz = Math.min(last - 1, Math.floor(gz));
  const i = iz * g.size + ix, a = h[i], d = h[i + 1], b = h[i + g.size], c = h[i + g.size + 1];
  const upper = gx - ix + gz - iz <= 1, sx = upper ? d - a : c - b, sz = upper ? b - a : c - d;
  return Math.atan(Math.hypot(sx, sz) / g.cell) / DEG;
}

// Where a ray meets the relief, EXACTLY: { x, y, z } | null. origin and dir are { x, y, z }; dir need not be normalised.
// rayGround() of format.js walks the ray in steps of half a cell, which is right for walking and wrong for pointing:
// a ray that grazes the tip of a peak or the crest of a ridge steps over it and lands on the ground far behind - and
// the brush with it. Here the ray is cut where its ground track crosses a line of the grid or the diagonal of a cell;
// between two such cuts it runs over ONE triangle of the terrain, where its height above the ground changes evenly, so
// a change of sign between two cuts is a crossing and nothing is ever stepped over. (Beyond the grid the ground goes
// on as its edge does, as heightAt says, and the same cuts hold.)
export function rayRelief(map, origin, dir, far = 4000) {
  const g = map.ground;
  if (!g.heights) return rayGround(map, origin, dir, far);     // flat: the plane y = 0
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (!(len > 0)) return null;
  const dx = dir.x / len, dy = dir.y / len, dz = dir.z / len, ox = origin.x, oy = origin.y, oz = origin.z;
  const above = (t) => oy + dy * t - heightAt(map, ox + dx * t, oz + dz * t);
  const point = (t) => ({ x: ox + dx * t, y: heightAt(map, ox + dx * t, oz + dz * t), z: oz + dz * t });
  let t = 0, a = above(0);
  if (a <= 0) return point(0);                                 // it starts under the ground: its start is the answer
  const top = LIMITS.height[1];
  if (oy > top) {                                              // nothing is higher than the limit: skip the air above it
    if (!(dy < 0)) return null;
    t = (oy - top) / -dy;
    if (t > far) return null;
    a = above(t);
    if (a <= 0) return point(t);
  }
  // the three families of cuts, in grid units: x lines, z lines and the diagonals x + z = whole number
  const mid = (g.size - 1) / 2, rate = [dx / g.cell, dz / g.cell, (dx + dz) / g.cell], next = [Infinity, Infinity, Infinity], gap = [Infinity, Infinity, Infinity];
  const at = [(ox + dx * t) / g.cell + mid, (oz + dz * t) / g.cell + mid, 0];
  at[2] = at[0] + at[1];
  for (let k = 0; k < 3; k++) {
    if (Math.abs(rate[k]) < 1e-12) continue;
    gap[k] = 1 / Math.abs(rate[k]);
    const ahead = rate[k] > 0 ? Math.floor(at[k]) + 1 - at[k] : at[k] - (Math.ceil(at[k]) - 1);
    next[k] = t + ahead * gap[k];
  }
  while (t < far) {
    if (dy >= 0 && oy + dy * t > top) return null;             // above everything and not coming down
    let to = Math.min(next[0], next[1], next[2], far);
    if (!(to > t)) to = t + 1e-9;                              // (two cuts in one spot)
    for (let k = 0; k < 3; k++) if (next[k] <= to) next[k] += gap[k];
    const b = above(to);
    if (b <= 0) return point(t + (to - t) * a / (a - b));      // the crossing lies on this one triangle
    t = to;
    a = b;
  }
  return null;
}
