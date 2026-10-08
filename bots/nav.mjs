// Where a bot can walk, and how it gets from one place to another: the map as a grid of free and blocked cells, and
// A* over it. A cell is blocked by ground nobody walks on (water, cliffs, the rim of the world: isBlocked) and by what
// scenery blocks - the same colliders the game's client pushes a cat out of (colliderOf), measured from the model files.
import fs from 'node:fs';
import path from 'node:path';
import { isBlocked } from '../src/map/format.js';
import { modelInfo, colliderOf } from '../src/map/catalog.js';

export const CELL = 1.5;     // the size of a grid cell, in world units
const MARGIN = 0.5;          // how far a cat keeps from what blocks it

// The horizontal bounding box of a model, in model units, read from the file's own numbers: the min and max every
// glTF stores for a mesh's positions, moved by the translation and the scale of its node (a rotation is not applied;
// the packs do not turn their meshes). null when the file cannot be read.
const footprints = new Map();
function footprintOf(root, url) {
  if (footprints.has(url)) return footprints.get(url);
  let box = null;
  try {
    const data = fs.readFileSync(path.join(root, url));
    const json = JSON.parse(url.endsWith('.glb') ? data.toString('utf8', 20, 20 + data.readUInt32LE(12)) : data.toString('utf8'));
    for (const node of json.nodes ?? []) {
      if (node.mesh === undefined) continue;
      const [tx = 0, , tz = 0] = node.translation ?? [], [sx = 1, , sz = 1] = node.scale ?? [];
      for (const prim of json.meshes[node.mesh].primitives) {
        const acc = json.accessors[prim.attributes.POSITION];
        if (!acc?.min || !acc?.max) continue;
        const xs = [acc.min[0] * sx + tx, acc.max[0] * sx + tx], zs = [acc.min[2] * sz + tz, acc.max[2] * sz + tz];
        box ??= { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
        box.minX = Math.min(box.minX, ...xs); box.maxX = Math.max(box.maxX, ...xs);
        box.minZ = Math.min(box.minZ, ...zs); box.maxZ = Math.max(box.maxZ, ...zs);
      }
    }
  } catch { /* a model that is missing blocks nothing */ }
  footprints.set(url, box);
  return box;
}

// -> { free(x, z), clear(ax, az, bx, bz), path(ax, az, bx, bz), nearestFree(x, z), centre(x, z) } for a normalized map.
// centre: the middle of the cell a point lies in - the one place the ground of a cell is looked at.
// `root` is the folder the model files are in (the site root).
export function createNav(map, root) {
  const n = Math.ceil(map.radius * 2 / CELL) + 2, half = n * CELL / 2;
  const blocked = new Uint8Array(n * n);
  const cell = (v) => Math.floor((v + half) / CELL), centre = (i) => (i + 0.5) * CELL - half;
  const inside = (i, j) => i >= 0 && j >= 0 && i < n && j < n;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = centre(i), z = centre(j);
      if (Math.hypot(x, z) > map.radius - 1.5 || isBlocked(map, x, z)) blocked[j * n + i] = 1;
    }
  }
  // scenery: every cell whose centre is within the margin of a collider
  const mark = (x0, z0, x1, z1, hit) => {
    for (let j = Math.max(0, cell(z0)); j <= Math.min(n - 1, cell(z1)); j++) {
      for (let i = Math.max(0, cell(x0)); i <= Math.min(n - 1, cell(x1)); i++) if (hit(centre(i), centre(j))) blocked[j * n + i] = 1;
    }
  };
  for (const obj of map.objects) {
    const info = modelInfo(obj.m);
    if (!info) continue;
    const { circles, boxes } = colliderOf(obj, info, info.url ? footprintOf(root, info.url) : null);
    for (const c of circles) {
      const r = c.r + MARGIN;
      mark(c.x - r, c.z - r, c.x + r, c.z + r, (x, z) => Math.hypot(x - c.x, z - c.z) < r);
    }
    for (const b of boxes) {
      const cos = Math.cos(b.ry), sin = Math.sin(b.ry), hw = b.hw + MARGIN, hd = b.hd + MARGIN, e = Math.hypot(hw, hd);
      mark(b.x - e, b.z - e, b.x + e, b.z + e, (x, z) => {
        const dx = x - b.x, dz = z - b.z;
        return Math.abs(dx * cos - dz * sin) < hw && Math.abs(dx * sin + dz * cos) < hd;
      });
    }
  }

  // The walkable world is the free cells that can be reached from the start point. A free cell that cannot - a gap
  // between the trees of a thicket, a ledge in a cliff - is a pocket: nothing to stand in, and never a place to go to.
  const steps = (cur, visit) => {
    const ci = cur % n, cj = (cur - ci) / n;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const i = ci + di, j = cj + dj;
        if ((!di && !dj) || !inside(i, j) || blocked[j * n + i]) continue;
        if (di && dj && (blocked[cj * n + i] || blocked[j * n + ci])) continue;   // never through the corner of a blocked cell
        visit(j * n + i, di && dj ? 1.4142 : 1, i, j);
      }
    }
  };
  const world = new Uint8Array(n * n);
  {
    let seed = cell(map.start.z) * n + cell(map.start.x);
    for (let k = 0; blocked[seed] && k < n * n; k++) seed = (seed + 1) % (n * n);
    const queue = [seed];
    world[seed] = 1;
    for (let k = 0; k < queue.length; k++) steps(queue[k], (next) => { if (!world[next]) { world[next] = 1; queue.push(next); } });
  }

  const free = (x, z) => { const i = cell(x), j = cell(z); return inside(i, j) && world[j * n + i] === 1; };
  // whether the straight line between two points crosses only free cells
  function clear(ax, az, bx, bz) {
    const steps = Math.ceil(Math.hypot(bx - ax, bz - az) / (CELL / 2));
    for (let k = 0; k <= steps; k++) {
      const t = steps ? k / steps : 0;
      if (!free(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
    }
    return true;
  }
  // the free point nearest to (x, z): itself when it is free, else the centre of the closest free cell around it
  function nearestFree(x, z, reach = 14) {
    if (free(x, z)) return { x, z };
    const ci = cell(x), cj = cell(z);
    let best = null, bestD = Infinity;
    for (let dj = -reach; dj <= reach; dj++) {
      for (let di = -reach; di <= reach; di++) {
        const i = ci + di, j = cj + dj, d = di * di + dj * dj;
        if (d < bestD && inside(i, j) && world[j * n + i]) { bestD = d; best = { x: centre(i), z: centre(j) }; }
      }
    }
    return best;
  }

  // A* from a to b over the eight neighbours of a cell. Both ends are taken to the walkable world first, so there is
  // always a way between them. -> the way as a list of points to walk to in turn, straightened where a straight line
  // is free; null when an end has no walkable ground anywhere near it.
  function findPath(ax, az, bx, bz) {
    const from = nearestFree(ax, az), to = nearestFree(bx, bz);
    if (!from || !to) return null;
    if (clear(from.x, from.z, to.x, to.z)) return [to];
    const start = cell(from.z) * n + cell(from.x), goal = cell(to.z) * n + cell(to.x);
    const gi = goal % n, gj = (goal - gi) / n;
    // a binary heap of [f, cell]: the cell that looks nearest to the goal comes out first
    const cost = new Map([[start, 0]]), came = new Map(), heap = [[0, start]];
    const push = (item) => {
      let k = heap.push(item) - 1;
      for (let up = (k - 1) >> 1; k > 0 && heap[up][0] > item[0]; k = up, up = (k - 1) >> 1) heap[k] = heap[up];
      heap[k] = item;
    };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) {
        let k = 0;
        for (;;) {
          let child = 2 * k + 1;
          if (child >= heap.length) break;
          if (child + 1 < heap.length && heap[child + 1][0] < heap[child][0]) child++;
          if (heap[child][0] >= last[0]) break;
          heap[k] = heap[child];
          k = child;
        }
        heap[k] = last;
      }
      return top;
    };
    while (heap.length) {
      const [f, cur] = pop();
      if (cur === goal) break;
      const base = cost.get(cur);
      if (f > base + Math.hypot(cur % n - gi, Math.floor(cur / n) - gj) + 1e-9) continue;   // an older, dearer entry of this cell
      steps(cur, (next, len, ni, nj) => {
        const g = base + len;
        if (cost.has(next) && cost.get(next) <= g) return;
        cost.set(next, g);
        came.set(next, cur);
        push([g + Math.hypot(ni - gi, nj - gj), next]);
      });
    }
    if (!came.has(goal)) return null;
    const cells = [];
    for (let c = goal; c !== start; c = came.get(c)) cells.push(c);
    const points = cells.reverse().map((c) => ({ x: centre(c % n), z: centre((c - c % n) / n) }));
    points[points.length - 1] = to;
    // straighten: from each point walk on to the farthest one that is in plain sight
    const way = [];
    let at = from;
    for (let k = 0; k < points.length;) {
      let far = k;
      for (let m = Math.min(points.length - 1, k + 40); m > k; m--) if (clear(at.x, at.z, points[m].x, points[m].z)) { far = m; break; }
      way.push(points[far]);
      at = points[far];
      k = far + 1;
    }
    return way;
  }

  return { free, clear, nearestFree, path: findPath, cells: n, centre: (x, z) => ({ x: centre(cell(x)), z: centre(cell(z)) }) };
}
