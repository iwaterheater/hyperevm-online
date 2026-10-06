// The editor's own checks of a map: what validate() cannot know, because it needs the loaded models - what blocks the
// way, how many triangles a model has, which files failed to load. PURE: no DOM, no three; the Issues panel hands in
// what the view measured.
//
//   editorChecks(map, { obstacles, missing, triangles }) -> Issue[]      (all of level 'warning': none blocks a save)
//
//   obstacles   view.obstacles(): { circles: Float32Array /* x, z, r */, nCircles, npcStart,
//                                   boxes: Float32Array /* x, z, hw, hd, ry */, nBoxes }.
//               The circles from index npcStart on are the NPCs' OWN circles and are ignored by both collider checks:
//               with them every NPC would stand inside a collider - its own - and nobody could reach it.
//   missing     Iterable<modelId>: the models that failed to load (view.missing)
//   triangles   Map<modelId, triangles of one instance>
//
// Codes
//   item-in-collider   a chest or an NPC inside the collider of an object; a spawn only when its monsters have nowhere
//                      else to appear (radius 0, or a disc without one open spot)
//   unreachable        a chest or an NPC that cannot be walked to from the start disc; a spawn when NO open spot of its
//                      disc can be
// A camp spreads its monsters over its whole disc (spawnHome), so a centre that stands in a tree is harmless: for a
// spawn with a radius both checks ask about the disc, not about the centre.
//   region-hidden      a region that is the winning one at no vertex of the ground grid
//   object-blocked     ONE row for all the objects that stand on ground nobody can walk on (water, lava ...): after a
//                      pond was painted over a wood, this is where the trees in it are found. It may be meant - a
//                      pier, a rock in a lake - so it only says so.
//   heavy-model        one model above MODEL_TRIANGLES triangles in total
//   many-triangles     more than TOTAL_TRIANGLES instanced triangles in total
//   model-failed       a model that failed to load (drawn as a magenta box)
import { GROUND_TYPES, LIMITS, groundIx, isBlocked, shapeBounds, shapeCentre } from '../map/format.js';
import { runs } from './raster.js';

export const PLAYER_R = 0.4;              // what view.collide() pushes out of obstacles
export const REACH = 1.5;                 // an item counts as reached when a walkable cell this close to it was
export const TOTAL_TRIANGLES = 2500000;
export const MODEL_TRIANGLES = 300000;
const STEP = 1;                           // the flood grid: one cell per world unit

const BLOCK = GROUND_TYPES.map((t) => t.block === true);
const count = (n) => n.toLocaleString('en-US');
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// What view.obstacles() returned, without the NPCs' own circles and safe against a missing or half-filled argument.
function readObstacles(o) {
  const circles = o?.circles ?? [], boxes = o?.boxes ?? [];
  const all = Math.max(0, Math.min(Number.isInteger(o?.nCircles) ? o.nCircles : Math.floor(circles.length / 3), Math.floor(circles.length / 3)));
  const nCircles = Math.max(0, Math.min(Number.isInteger(o?.npcStart) ? o.npcStart : all, all));
  const nBoxes = Math.max(0, Math.min(Number.isInteger(o?.nBoxes) ? o.nBoxes : Math.floor(boxes.length / 5), Math.floor(boxes.length / 5)));
  return { circles, nCircles, boxes, nBoxes };
}

// The point in the frame of a box: the inverse of the local -> world formula of the format (wx = x + lx cos + lz sin,
// wz = z - lx sin + lz cos). -> true when it lies inside the box grown by `grow`.
function inBox(boxes, i, x, z, grow) {
  const k = i * 5, dx = x - boxes[k], dz = z - boxes[k + 1], cos = Math.cos(boxes[k + 4]), sin = Math.sin(boxes[k + 4]);
  return Math.abs(dx * cos - dz * sin) <= boxes[k + 2] + grow && Math.abs(dx * sin + dz * cos) <= boxes[k + 3] + grow;
}

function insideCollider(obs, x, z) {
  const { circles, nCircles, boxes, nBoxes } = obs;
  for (let i = 0; i < nCircles; i++) {
    const dx = x - circles[i * 3], dz = z - circles[i * 3 + 1], r = circles[i * 3 + 2];
    if (dx * dx + dz * dz < r * r) return true;
  }
  for (let i = 0; i < nBoxes; i++) if (inBox(boxes, i, x, z, 0)) return true;
  return false;
}

// The cells of a 1-unit grid a player can stand on and get to from the start disc.
// -> { seeds, reached(x, z, r = 0), open(x, z, r) }
//    reached  a walked cell lies within REACH of the point - or, for a disc, anywhere in it (within max(r, REACH))
//    open     a cell a player could stand on, walked to or not, lies within r of the point
// A cell is closed when it is beyond the map radius, on ground that blocks, or covered by an obstacle grown by the
// player's radius. The flood is 8-connected: a 1-unit grid cannot tell a tight diagonal passage from a wall, and a
// warning that cries wolf is worth less than one that misses a hairline gap.
// The grid never reaches beyond the ground: there is nothing to stand on out there, and the ground is what bounds the
// work - a radius can be any number in a file that is being repaired, and a grid of its size would be the freeze.
function flood(map, obs) {
  const g = map.ground, size = g.size, r2 = map.radius * map.radius;
  const reach = Math.min(map.radius, (size - 1) / 2 * g.cell + g.cell);
  const R = Math.max(0, Math.ceil(reach / STEP)), n = 2 * R + 1, state = new Uint8Array(n * n);   // 0 open, 1 closed, 2 reached
  const sound = g.cells.length === size * size;
  for (let j = 0; j < n; j++) {
    const z = (j - R) * STEP, row = sound ? groundIx(g, z) * size : 0;
    for (let i = 0; i < n; i++) {
      const x = (i - R) * STEP;
      if (x * x + z * z > r2 || (sound && BLOCK[g.cells[row + groundIx(g, x)]] === true)) state[j * n + i] = 1;
    }
  }
  // close every cell whose centre lies inside test(x, z), looking only at the square around (cx, cz)
  const close = (cx, cz, reach, test) => {
    const i0 = Math.max(0, Math.ceil((cx - reach) / STEP) + R), i1 = Math.min(n - 1, Math.floor((cx + reach) / STEP) + R);
    const j0 = Math.max(0, Math.ceil((cz - reach) / STEP) + R), j1 = Math.min(n - 1, Math.floor((cz + reach) / STEP) + R);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (test((i - R) * STEP, (j - R) * STEP)) state[j * n + i] = 1;
  };
  const { circles, nCircles, boxes, nBoxes } = obs;
  for (let c = 0; c < nCircles; c++) {
    const cx = circles[c * 3], cz = circles[c * 3 + 1], r = circles[c * 3 + 2] + PLAYER_R;
    if (!finite(cx) || !finite(cz) || !(r > 0)) continue;
    close(cx, cz, r, (x, z) => (x - cx) * (x - cx) + (z - cz) * (z - cz) < r * r);
  }
  for (let b = 0; b < nBoxes; b++) {
    const cx = boxes[b * 5], cz = boxes[b * 5 + 1], reach = Math.hypot(boxes[b * 5 + 2] + PLAYER_R, boxes[b * 5 + 3] + PLAYER_R);
    if (!finite(cx) || !finite(cz) || !finite(reach)) continue;
    close(cx, cz, reach, (x, z) => inBox(boxes, b, x, z, PLAYER_R));
  }

  // every open cell of the start disc is a place a player may appear on
  const queue = new Int32Array(n * n), start = map.start, sr = Math.max(finite(start.r) ? start.r : 0, REACH);
  let head = 0, tail = 0;
  if (finite(start.x) && finite(start.z)) {
    const i0 = Math.max(0, Math.ceil((start.x - sr) / STEP) + R), i1 = Math.min(n - 1, Math.floor((start.x + sr) / STEP) + R);
    const j0 = Math.max(0, Math.ceil((start.z - sr) / STEP) + R), j1 = Math.min(n - 1, Math.floor((start.z + sr) / STEP) + R);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = (i - R) * STEP - start.x, dz = (j - R) * STEP - start.z, k = j * n + i;
        if (state[k] === 0 && dx * dx + dz * dz <= sr * sr) { state[k] = 2; queue[tail++] = k; }
      }
    }
  }
  const seeds = tail;
  while (head < tail) {
    const k = queue[head++], i = k % n, j = (k - i) / n;
    for (let dj = -1; dj <= 1; dj++) {
      const jj = j + dj;
      if (jj < 0 || jj >= n) continue;
      for (let di = -1; di <= 1; di++) {
        const ii = i + di, kk = jj * n + ii;
        if (ii < 0 || ii >= n || state[kk] !== 0) continue;
        state[kk] = 2;
        queue[tail++] = kk;
      }
    }
  }
  // is there a cell within `reach` of (x, z) that is walked to (walked: true) or at least open (walked: false)?
  const any = (x, z, reach, walked) => {
    if (!finite(x) || !finite(z) || !(reach >= 0)) return false;
    const i0 = Math.max(0, Math.ceil((x - reach) / STEP) + R), i1 = Math.min(n - 1, Math.floor((x + reach) / STEP) + R);
    const j0 = Math.max(0, Math.ceil((z - reach) / STEP) + R), j1 = Math.min(n - 1, Math.floor((z + reach) / STEP) + R);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = (i - R) * STEP - x, dz = (j - R) * STEP - z, s = state[j * n + i];
        if ((walked ? s === 2 : s !== 1) && dx * dx + dz * dz <= reach * reach) return true;
      }
    }
    return false;
  };
  return {
    seeds,
    reached: (x, z, r = 0) => any(x, z, Math.max(finite(r) ? r : 0, REACH), true),
    open: (x, z, r) => any(x, z, r, false),
  };
}

// The indices of the regions that win at no vertex of the ground grid: covered completely by later regions, off the
// grid, or smaller than a ground cell. Later regions win, so they claim their vertices first.
function hiddenRegions(map) {
  const g = map.ground, size = g.size, out = [];
  if (!Number.isInteger(size) || size < 1 || !(g.cell > 0)) return out;
  const claimed = new Uint8Array(size * size);
  for (let r = map.regions.length - 1; r >= 0; r--) {
    const s = map.regions[r].shape;
    if (!s || (s.type === 'circle' ? !(finite(s.x) && finite(s.z) && finite(s.r)) : !(s.type === 'poly' && Array.isArray(s.points) && s.points.length >= 3))) continue;
    const b = shapeBounds(s);
    if (!finite(b.minX) || !finite(b.maxX) || !finite(b.minZ) || !finite(b.maxZ)) continue;
    // row by row (raster.js): a region with many points costs its edges per row of the grid, not per vertex
    let wins = 0;
    runs(g, s, (iz, ix0, ix1) => {
      for (let k = iz * size + ix0, end = iz * size + ix1; k <= end; k++) {
        if (claimed[k]) continue;
        claimed[k] = 1;
        wins++;
      }
    });
    if (!wins) out.push(r);
  }
  return out.reverse();
}

// -> Issue[]: { level: 'warning', code, path, message, kind?, index?, x?, z? } like the issues of validate().
// Never throws on a map the store can hold; the arguments it lacks switch their checks off.
export function editorChecks(map, { obstacles = null, missing = null, triangles = null } = {}) {
  const issues = [];
  const warn = (code, path, message, where) => issues.push({ level: 'warning', code, path, message, ...where });
  const at = (kind, index, p) => (finite(p.x) && finite(p.z) ? { kind, index, x: p.x, z: p.z } : { kind, index });
  const obs = readObstacles(obstacles);

  // what a player walks up to: [kind, list key, what to call one]. `r` is the disc a spawn fills with its monsters;
  // a chest, an NPC and a spawn of radius 0 are one point.
  const targets = [];
  for (const [kind, key, name] of [['chest', 'chests', 'This chest'], ['npc', 'npcs', 'This NPC'], ['spawn', 'spawns', 'This spawn']]) {
    map[key].forEach((item, index) => {
      targets.push({ kind, index, item, path: `${key}[${index}]`, name, r: kind === 'spawn' && item.r > 0 ? item.r : 0 });
    });
  }
  // A radius outside the format's limits is an error validate() has listed already; where a player can walk is not
  // asked of a map without a usable size (the answer would be about another island than the one being repaired).
  const sized = finite(map.radius) && map.radius >= LIMITS.radius[0] && map.radius <= LIMITS.radius[1];
  const walk = targets.length && sized ? flood(map, obs) : null;

  // ---- item-in-collider
  if (obs.nCircles || obs.nBoxes) {
    for (const t of targets) {
      if (!insideCollider(obs, t.item.x, t.item.z)) continue;
      if (!t.r) warn('item-in-collider', t.path, `${t.name} is inside the collider of an object.`, at(t.kind, t.index, t.item));
      else if (walk && !walk.open(t.item.x, t.item.z, t.r)) {      // (no walk grid: a disc cannot be judged, so it is not accused)
        warn('item-in-collider', t.path, `${t.name} has no open spot in its disc: its centre is inside the collider of an object.`, at(t.kind, t.index, t.item));
      }
    }
  }

  // ---- unreachable
  if (walk) {
    if (!walk.seeds) {
      warn('unreachable', 'start', 'The start disc has no ground a player can stand on: nothing can be reached from it.', at('start', 0, map.start));
    } else {
      for (const t of targets) {
        if (walk.reached(t.item.x, t.item.z, t.r)) continue;
        warn('unreachable', t.path,
          t.r ? `No part of this spawn's disc can be reached on foot from the start point.` : `${t.name} cannot be reached on foot from the start point.`,
          at(t.kind, t.index, t.item));
      }
    }
  }

  // ---- region-hidden
  for (const index of hiddenRegions(map)) {
    const region = map.regions[index];
    warn('region-hidden', `regions[${index}]`,
      'This region wins at no point of the ground grid: later regions cover it, or it is smaller than a ground cell.',
      at('region', index, shapeCentre(region.shape)));
  }

  // ---- object-blocked: one row, however many they are (a lake painted over a wood drowns hundreds of trees)
  {
    let n = 0;
    for (const obj of map.objects) if (finite(obj.x) && finite(obj.z) && isBlocked(map, obj.x, obj.z)) n++;
    // no item and no point of its own: the Issues panel knows which objects are meant and selects them all
    if (n) {
      warn('object-blocked', 'objects',
        `${count(n)} object${n === 1 ? ' stands' : 's stand'} on ground that cannot be walked on (water, lava and the like): move or delete what is not meant to be there.`);
    }
  }

  // ---- heavy-model, many-triangles
  if (triangles && typeof triangles.get === 'function') {
    const perModel = new Map();   // id -> { first, n, each, total }
    let total = 0;
    map.objects.forEach((obj, index) => {
      const each = triangles.get(obj.m);
      if (!(each > 0)) return;
      const m = perModel.get(obj.m);
      if (m) { m.n++; m.total += each; } else perModel.set(obj.m, { first: index, n: 1, each, total: each });
      total += each;
    });
    for (const [id, m] of perModel) {
      if (m.total <= MODEL_TRIANGLES) continue;
      warn('heavy-model', `objects[${m.first}].m`,
        `The model "${id}" adds up to ${count(m.total)} triangles (${count(m.n)} × ${count(m.each)}); more than ${count(MODEL_TRIANGLES)} for one model is heavy to draw.`,
        at('object', m.first, map.objects[m.first]));
    }
    if (total > TOTAL_TRIANGLES) {
      warn('many-triangles', 'objects', `The objects add up to ${count(total)} triangles; more than ${count(TOTAL_TRIANGLES)} is heavy to draw.`);
    }
  }

  // ---- model-failed
  if (missing && typeof missing[Symbol.iterator] === 'function') {
    for (const id of new Set(missing)) {
      let first = -1, n = 0;
      map.objects.forEach((obj, index) => {
        if (obj.m !== id) return;
        if (first < 0) first = index;
        n++;
      });
      if (first < 0) warn('model-failed', 'objects', `The model "${id}" failed to load (no object uses it).`);
      else {
        warn('model-failed', `objects[${first}].m`,
          `The model "${id}" failed to load: ${count(n)} object${n === 1 ? ' is' : 's are'} drawn as a magenta box.`,
          at('object', first, map.objects[first]));
      }
    }
  }

  return issues;
}
