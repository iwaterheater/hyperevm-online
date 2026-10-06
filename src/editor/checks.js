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
//   item-in-collider   a chest, an NPC or the centre of a spawn inside the collider of an object
//   unreachable        a chest, an NPC or the centre of a spawn that cannot be walked to from the start disc
//   region-hidden      a region that is the winning one at no vertex of the ground grid
//   heavy-model        one model above MODEL_TRIANGLES triangles in total
//   many-triangles     more than TOTAL_TRIANGLES instanced triangles in total
//   model-failed       a model that failed to load (drawn as a magenta box)
import { GROUND_TYPES, groundIx, groundX, inShape, shapeBounds, shapeCentre } from '../map/format.js';

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
// -> { reached(x, z) -> boolean, seeds: number } - reached: a walked cell lies within REACH of the point.
// A cell is closed when it is beyond the map radius, on ground that blocks, or covered by an obstacle grown by the
// player's radius. The flood is 8-connected: a 1-unit grid cannot tell a tight diagonal passage from a wall, and a
// warning that cries wolf is worth less than one that misses a hairline gap.
function flood(map, obs) {
  const R = Math.ceil(map.radius / STEP), n = 2 * R + 1, state = new Uint8Array(n * n);   // 0 open, 1 closed, 2 reached
  const g = map.ground, size = g.size, r2 = map.radius * map.radius;
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
  return {
    seeds,
    reached(x, z) {
      if (!finite(x) || !finite(z)) return false;
      const i0 = Math.max(0, Math.ceil((x - REACH) / STEP) + R), i1 = Math.min(n - 1, Math.floor((x + REACH) / STEP) + R);
      const j0 = Math.max(0, Math.ceil((z - REACH) / STEP) + R), j1 = Math.min(n - 1, Math.floor((z + REACH) / STEP) + R);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const dx = (i - R) * STEP - x, dz = (j - R) * STEP - z;
          if (state[j * n + i] === 2 && dx * dx + dz * dz <= REACH * REACH) return true;
        }
      }
      return false;
    },
  };
}

// The indices of the regions that win at no vertex of the ground grid: covered completely by later regions, off the
// grid, or smaller than a ground cell. Later regions win, so they claim their vertices first.
function hiddenRegions(map) {
  const g = map.ground, size = g.size, c = (size - 1) / 2, out = [];
  if (!Number.isInteger(size) || size < 1 || !(g.cell > 0)) return out;
  const claimed = new Uint8Array(size * size);
  for (let r = map.regions.length - 1; r >= 0; r--) {
    const s = map.regions[r].shape;
    if (!s || (s.type === 'circle' ? !(finite(s.x) && finite(s.z) && finite(s.r)) : !(s.type === 'poly' && Array.isArray(s.points) && s.points.length >= 3))) continue;
    const b = shapeBounds(s);
    if (!finite(b.minX) || !finite(b.maxX) || !finite(b.minZ) || !finite(b.maxZ)) continue;
    const ix0 = Math.max(0, Math.ceil(b.minX / g.cell + c)), ix1 = Math.min(size - 1, Math.floor(b.maxX / g.cell + c));
    const iz0 = Math.max(0, Math.ceil(b.minZ / g.cell + c)), iz1 = Math.min(size - 1, Math.floor(b.maxZ / g.cell + c));
    let wins = 0;
    for (let iz = iz0; iz <= iz1; iz++) {
      const z = groundX(g, iz);
      for (let ix = ix0; ix <= ix1; ix++) {
        const k = iz * size + ix;
        if (claimed[k] || !inShape(s, groundX(g, ix), z)) continue;
        claimed[k] = 1;
        wins++;
      }
    }
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

  // what a player walks up to: [kind, list key, what to call one]
  const targets = [];
  for (const [kind, key, name] of [['chest', 'chests', 'This chest'], ['npc', 'npcs', 'This NPC'], ['spawn', 'spawns', 'The centre of this spawn']]) {
    map[key].forEach((item, index) => targets.push({ kind, index, item, path: `${key}[${index}]`, name }));
  }

  // ---- item-in-collider
  if (obs.nCircles || obs.nBoxes) {
    for (const t of targets) {
      if (insideCollider(obs, t.item.x, t.item.z)) {
        warn('item-in-collider', t.path, `${t.name} is inside the collider of an object.`, at(t.kind, t.index, t.item));
      }
    }
  }

  // ---- unreachable
  if (targets.length) {
    const walk = flood(map, obs);
    if (!walk.seeds) {
      warn('unreachable', 'start', 'The start disc has no ground a player can stand on: nothing can be reached from it.', at('start', 0, map.start));
    } else {
      for (const t of targets) {
        if (!walk.reached(t.item.x, t.item.z)) {
          warn('unreachable', t.path, `${t.name} cannot be reached on foot from the start point.`, at(t.kind, t.index, t.item));
        }
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
