// The maths of the Arrange panel. PURE: no DOM, no three, no store - numbers in, patches out.
//
// `entries` = [{ kind, item }]: the selected items with their kinds (the store knows the kind, this module does not ask
// it). Every function but array() returns PATCHES, index-aligned with entries, for cmd.setEach(items, patches): the
// panel runs them as one command, so each arrangement is one undo step. An entry that needs no change gets {} - setEach
// skips an empty patch - and nothing here ever writes to an item of the map.
//
// Where an item "is": x, z of an object, a spawn, a chest, an NPC and the start point; the centre of a region's shape
// (the circle's centre, the average of a polygon's vertices). A region is moved by replacing its shape, as every
// command does.
import { qAngle, qPos, qScale, quantizeItem, shapeCentre } from '../map/format.js';
import { clone } from './commands.js';

const AXES = ['x', 'z'];
const MODES = ['min', 'centre', 'max'];
const TURNS = ['object', 'chest', 'npc'];     // the kinds that have a facing (`ry`)

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const need = (ok, what) => { if (!ok) throw new TypeError(`arrange: expected ${what}`); };

const isEntry = (e) => e !== null && typeof e === 'object' && typeof e.kind === 'string' && e.item !== null && typeof e.item === 'object';
function check(entries) {
  need(Array.isArray(entries) && entries.every(isEntry), 'entries: [{ kind, item }]');
  return entries;
}

// -> { x, z }: where the entry is
const originOf = (entry) => (entry.kind === 'region' ? shapeCentre(entry.item.shape) : entry.item);

// A copy of `shape` moved by (dx, dz). The command quantises it; so do we, to compare like with like.
function movedShape(shape, dx, dz) {
  if (shape.type === 'circle') return { type: 'circle', x: qPos(shape.x + dx), z: qPos(shape.z + dz), r: shape.r };
  return { type: 'poly', points: shape.points.map((p) => [qPos(p[0] + dx), qPos(p[1] + dz)]) };
}

// The patch that puts the entry at `value` on `axis`; {} when it is there already.
function moveTo(entry, axis, value) {
  const v = qPos(value);
  if (entry.kind !== 'region') return entry.item[axis] === v ? {} : { [axis]: v };
  const d = qPos(v - originOf(entry)[axis]);
  if (d === 0) return {};
  return { shape: movedShape(entry.item.shape, axis === 'x' ? d : 0, axis === 'z' ? d : 0) };
}

// -> { x, z }: the centre of the ground bounding box of the entries' origins (the pivot of the gizmo)
function pivotOf(entries) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const e of entries) {
    const p = originOf(e);
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return minX > maxX ? { x: 0, z: 0 } : { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
}

// Align: every entry gets ONE coordinate on `axis` - the smallest ('min'), the largest ('max') or the middle of the
// two ('centre') among the entries. The other axis is left alone, so "Align X" turns a ragged row into a straight
// north-south line. -> patches
export function align(entries, axis, mode) {
  check(entries);
  need(AXES.includes(axis), "axis: 'x' or 'z'");
  need(MODES.includes(mode), "mode: 'min', 'centre' or 'max'");
  if (!entries.length) return [];
  let min = Infinity, max = -Infinity;
  for (const e of entries) {
    const v = originOf(e)[axis];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const target = mode === 'min' ? min : mode === 'max' ? max : (min + max) / 2;
  return entries.map((e) => moveTo(e, axis, target));
}

// Distribute: the two outermost entries on `axis` stay, the ones between them are spaced evenly in the order they
// already have along that axis (entries on the same spot keep the order they were given in). With fewer than three
// entries there is nothing to space. -> patches
export function distribute(entries, axis) {
  check(entries);
  need(AXES.includes(axis), "axis: 'x' or 'z'");
  const patches = entries.map(() => ({})), n = entries.length;
  if (n < 3) return patches;
  const at = entries.map((e) => originOf(e)[axis]);
  const order = entries.map((_, i) => i).sort((a, b) => at[a] - at[b] || a - b);
  const first = at[order[0]], step = (at[order[n - 1]] - first) / (n - 1);
  for (let k = 1; k < n - 1; k++) patches[order[k]] = moveTo(entries[order[k]], axis, first + step * k);
  return patches;
}

// Face a point: every entry that has a facing turns towards (x, z) - `ry = atan2(dx, dz)`, forward being
// (sin ry, cos ry). An entry standing on the point itself keeps its facing; spawns, regions and the start have none.
// -> patches
export function facePoint(entries, x, z) {
  check(entries);
  need(finite(x) && finite(z), 'a point: x, z');
  return entries.map((e) => {
    if (!TURNS.includes(e.kind)) return {};
    const dx = x - e.item.x, dz = z - e.item.z;
    if (Math.abs(dx) < 1e-9 && Math.abs(dz) < 1e-9) return {};
    return { ry: qAngle(Math.atan2(dx, dz)) };
  });
}

// Randomize: with `rotation`, every entry that has a facing gets a random one; with `scale` = [min, max], every object
// gets a random uniform scale in that range (an absolute value, like the scale range of the Place tool - a second roll
// does not drift). rnd() is drawn in the order of the entries, rotation before scale, only where a value is needed.
// -> patches
export function randomize(entries, { rotation = false, scale = null } = {}, rnd = Math.random) {
  check(entries);
  need(typeof rnd === 'function', 'rnd: a function returning 0..1');
  let lo = 0, hi = 0;
  if (scale !== null) {
    need(Array.isArray(scale) && scale.length === 2 && finite(scale[0]) && finite(scale[1]) && scale[0] > 0 && scale[1] > 0, 'scale: [min, max], both above 0');
    lo = Math.min(scale[0], scale[1]);
    hi = Math.max(scale[0], scale[1]);
  }
  return entries.map((e) => {
    const patch = {};
    if (rotation && TURNS.includes(e.kind)) patch.ry = qAngle((rnd() * 2 - 1) * Math.PI);
    if (scale !== null && e.kind === 'object') patch.s = qScale(lo + rnd() * (hi - lo));
    return patch;
  });
}

// Drop to ground: an object's height offset becomes 0. Nothing else has one. -> patches
export function drop(entries) {
  check(entries);
  return entries.map((e) => (e.kind === 'object' && e.item.y !== 0 ? { y: 0 } : {}));
}

// Array: count - 1 further copies of every entry (the entries themselves are the first of `count`). Copy k (1-based)
// is the whole set moved by k x (dx, dz) and turned by k x dry about the set's pivot - as ONE rigid piece, so an
// arrayed house stays a house: positions turn about the pivot and every facing turns with them.
// Groups: every distinct `g` of EVERY copy becomes a group of its own. newIds(n) must return n distinct unused group
// ids and is called ONCE, with (count - 1) x (number of distinct g); the panel passes (n) => store.newGroupIds(n), so
// no id is ever invented here.
// The start point has no copy (a map has exactly one). The copies are new items, not in the map: add them with
// cmd.add(kind, items). -> [{ kind, item }], copy by copy, each in the order of the entries
export function array(entries, { count, dx = 0, dz = 0, dry = 0 } = {}, newIds) {
  check(entries);
  if (!Number.isInteger(count) || count < 1) throw new RangeError('arrange: array needs a whole count, 1 or more');
  need(finite(dx) && finite(dz) && finite(dry), 'dx, dz and dry: finite numbers');
  const list = entries.filter((e) => e.kind !== 'start'), copies = count - 1;
  const groups = new Map();                    // g -> its number among the distinct groups, in order of appearance
  for (const e of list) if (typeof e.item.g === 'string' && !groups.has(e.item.g)) groups.set(e.item.g, groups.size);
  const wanted = copies * groups.size;
  let ids = [];
  if (typeof newIds === 'function') ids = newIds(wanted);
  else need(wanted === 0, 'newIds: (n) => n distinct unused group ids');
  const fresh = Array.isArray(ids) ? ids.slice(0, wanted) : [];
  need(fresh.length === wanted && new Set(fresh).size === wanted && fresh.every((id) => typeof id === 'string' && id !== ''),
    `newIds(${wanted}) to return ${wanted} distinct group ids`);

  const out = [], pivot = pivotOf(list);
  for (let k = 1; k <= copies; k++) {
    const rot = dry * k, cos = Math.cos(rot), sin = Math.sin(rot), mx = dx * k, mz = dz * k;
    // (x, z) turned about the pivot, then moved. A positive angle takes +Z towards +X, as `ry` does.
    const place = (x, z) => {
      const ox = x - pivot.x, oz = z - pivot.z;
      return [pivot.x + ox * cos + oz * sin + mx, pivot.z - ox * sin + oz * cos + mz];
    };
    for (const e of list) {
      const item = clone(e.item);              // a deep copy; from here on this builds a new item, it edits none
      if (e.kind === 'region') {
        const s = item.shape;
        if (s.type === 'circle') [s.x, s.z] = place(s.x, s.z);
        else s.points = s.points.map((p) => place(p[0], p[1]));
      } else {
        [item.x, item.z] = place(item.x, item.z);
        if (TURNS.includes(e.kind)) item.ry += rot;
        if (typeof item.g === 'string') item.g = fresh[(k - 1) * groups.size + groups.get(item.g)];
      }
      out.push({ kind: e.kind, item: quantizeItem(e.kind, item) });
    }
  }
  return out;
}
