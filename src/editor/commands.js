// Commands: the ONLY code that writes to the map. Nothing else assigns to an item, to ground.cells or to ground.heights.
// Pure - no DOM, no three. A command is built here and run by the store (store.exec):
//
//   Command = { label, bytes, do(map) -> Change, undo(map) -> Change, merge?(next) -> boolean, unchanged?(map) -> boolean }
//
// unchanged(map) is optional, like merge: true when everything the command wrote holds again what it held before the
// command first ran. The two commands a drag or a typed field is made of have it (transform, set / setEach), so the
// store can drop a group that ended where it started instead of keeping a step that undoes nothing.
//
// What every command guarantees:
//   - undo() leaves the map exactly as do() found it: the same item references at the same indices, the same numbers.
//     It restores what it saved, it never computes backwards - so an undone edit leaves no trace in the file.
//   - what it writes is quantised (quantizeItem): the store, the view and the file always hold the same values.
//   - it never range-checks (validate() does, and the Issues panel shows it) - but it refuses a value that would leave
//     no file form at all: NaN, a string for a number, an unknown mood. Such a map could not even be kept as a draft.
//   - undo() and redo run in strict order (the store sees to that), so a command may rely on finding the map as it
//     left it.
//   - Change lists name only what really changed; a command that changed nothing returns an empty Change and the store
//     forgets it.
import { MOB_KEYS, MOB_TYPES } from '../shared.js';
import { COLLECTION, GROUND_TYPES, MOODS, NPC_KINDS, clampHeight, maxRadius, quantizeItem, resizeGround } from '../map/format.js';
import { emptyChange } from './store.js';

// ---------------------------------------------------------------- items: fields, kinds, values

const NUM = 'number', STR = 'string', TEXT = 'text', BOOL = 'boolean';
// Every field of every kind, in the key order of the runtime form, with the type a value must have.
const FIELDS = {
  object: { m: STR, x: NUM, y: NUM, z: NUM, rx: NUM, ry: NUM, rz: NUM, s: NUM, sy: NUM, col: 'col', g: TEXT },
  spawn: { types: 'types', lvl: 'pair', x: NUM, z: NUM, r: NUM, count: NUM, respawn: NUM, g: TEXT },
  chest: { x: NUM, z: NUM, ry: NUM, gold: NUM, big: BOOL, respawn: NUM, g: TEXT },
  npc: { kind: 'npc', x: NUM, z: NUM, ry: NUM, g: TEXT },
  region: { name: STR, levels: 'levels', mood: 'mood', safe: BOOL, color: TEXT, shape: 'shape' },
  start: { x: NUM, z: NUM, r: NUM },
};
// The optional keys with their defaults: what a file may omit, and what set(items, { key: undefined }) resets to.
const OPTIONAL = {
  object: { y: 0, rx: 0, ry: 0, rz: 0, s: 1, sy: 1, col: null, g: null },
  spawn: { g: null },
  chest: { ry: 0, big: false, g: null },
  npc: { ry: 0, g: null },
  region: { levels: null, mood: null, safe: false, color: null },
  start: {},
};
// What make() fills in for the required keys. An object's model has no default: `m` must be given.
const REQUIRED = {
  object: { x: 0, z: 0 },
  spawn: { types: { chaser: 1 }, lvl: [1, 1], x: 0, z: 0, r: 8, count: 3, respawn: 14 },
  chest: { x: 0, z: 0, gold: 12, respawn: 150 },
  npc: { kind: 'guard', x: 0, z: 0 },
  region: { name: 'New region', shape: { type: 'circle', x: 0, z: 0, r: 20 } },
};
const LIST_OF = { ...COLLECTION, start: 'start' };       // kind -> its key in Change.updated
const LISTS = Object.values(COLLECTION);
const NOUNS = {
  object: ['object', 'objects'], spawn: ['spawn', 'spawns'], chest: ['chest', 'chests'], npc: ['NPC', 'NPCs'],
  region: ['region', 'regions'], start: ['start point', 'start points'],
};

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const toList = (items) => (items == null ? [] : typeof items[Symbol.iterator] === 'function' ? [...items] : [items]);
const unique = (items) => [...new Set(toList(items))];
const fail = (where, what) => { throw new TypeError(`${where}: expected ${what}`); };

// The kind of a runtime item, read off its fields: items carry no type tag, but no two kinds share their telling key.
function kindOf(item) {
  if (!isObj(item)) return null;
  if ('m' in item) return 'object';
  if ('types' in item) return 'spawn';
  if ('gold' in item) return 'chest';
  if ('kind' in item) return 'npc';
  if ('shape' in item) return 'region';
  return 'x' in item && 'z' in item && 'r' in item ? 'start' : null;
}

function kindsOf(items, where) {
  return items.map((item) => kindOf(item) ?? fail(where, 'map items (objects, spawns, chests, NPCs, regions, the start)'));
}

const pair = (v, where) => (Array.isArray(v) && v.length === 2 && finite(v[0]) && finite(v[1]) ? [v[0], v[1]] : fail(where, 'two numbers, [min, max]'));

// A value for a field of that type, checked and - when it is an object - copied, so the item owns what it holds and a
// patch shared by many items never becomes one object inside all of them.
function take(type, v, where) {
  switch (type) {
    case NUM: return finite(v) ? v : fail(where, 'a finite number');
    case STR: return typeof v === 'string' ? v : fail(where, 'a string');
    case TEXT: return v === null || typeof v === 'string' ? v : fail(where, 'a string or null');
    case BOOL: return typeof v === 'boolean' ? v : fail(where, 'true or false');
    case 'npc': return NPC_KINDS.includes(v) ? v : fail(where, `one of ${NPC_KINDS.join(', ')}`);
    case 'mood': return v === null || (typeof v === 'string' && Object.hasOwn(MOODS, v)) ? v : fail(where, 'a mood id or null');
    case 'pair': return pair(v, where);
    case 'levels': return v === null ? null : pair(v, where);
    case 'types': {
      if (!isObj(v)) fail(where, 'an object of monster types and weights');
      const out = {};
      for (const k of Object.keys(v)) if (!Object.hasOwn(MOB_TYPES, k) || !finite(v[k])) fail(`${where}.${k}`, 'a monster type with a numeric weight');
      for (const k of MOB_KEYS) if (Object.hasOwn(v, k)) out[k] = v[k];       // the order normalize() gives them
      return out;
    }
    case 'col': {
      if (v === null || v === 'box' || finite(v)) return v;
      if (!Array.isArray(v)) fail(where, 'null, 0, a factor, "box" or a list of circles');
      return v.map((c, i) => (isObj(c) && finite(c.x) && finite(c.z) && finite(c.r) ? { x: c.x, z: c.z, r: c.r } : fail(`${where}[${i}]`, 'a circle { x, z, r }')));
    }
    case 'shape': {
      if (isObj(v) && v.type === 'circle' && finite(v.x) && finite(v.z) && finite(v.r)) return { type: 'circle', x: v.x, z: v.z, r: v.r };
      if (isObj(v) && v.type === 'poly' && Array.isArray(v.points)) {
        return { type: 'poly', points: v.points.map((p, i) => pair(p, `${where}.points[${i}]`)) };
      }
      return fail(where, 'a shape: { type: "circle", x, z, r } or { type: "poly", points }');
    }
    default: throw new TypeError(`${where}: no such field type: ${type}`);
  }
}

// A new item of that kind from the fields of `src`, every value checked and owned by the new item.
function copyOf(kind, src, where) {
  const item = {};
  for (const key of Object.keys(FIELDS[kind])) item[key] = take(FIELDS[kind][key], src[key], `${where}.${key}`);
  return item;
}

// Deep equality of two field values (numbers, strings, null, small arrays and objects).
function same(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!Object.hasOwn(b, k) || !same(a[k], b[k])) return false;
  return true;
}

// "12 objects", "1 spawn", "3 items" (mixed kinds), "the start point" - for the labels of the undo toast.
function describe(kinds) {
  const n = kinds.length, first = kinds[0];
  let mixed = false;
  for (let i = 1; i < n && !mixed; i++) mixed = kinds[i] !== first;
  if (n && !mixed && first === 'start') return 'the start point';
  const [one, many] = n && !mixed ? NOUNS[first] : ['item', 'items'];
  return n === 1 ? `1 ${one}` : `${n.toLocaleString('en-US')} ${many}`;
}

// ---------------------------------------------------------------- lists: one pass, never a splice per item

// Inserts items[i] so that it ends up at index at[i] (ascending). One pass from the back, in place: O(n + k).
function insertAt(arr, items, at) {
  const k = items.length;
  let src = arr.length - 1, j = k - 1;
  arr.length += k;
  for (let dst = arr.length - 1; j >= 0; dst--) arr[dst] = at[j] === dst ? items[j--] : arr[src--];
}

// Removes the entries at the ascending indices `at`. One pass, in place.
function removeAt(arr, at) {
  let j = 0, w = at[0];
  for (let r = w; r < arr.length; r++) {
    if (j < at.length && at[j] === r) j++;
    else arr[w++] = arr[r];
  }
  arr.length = w;
}

// Removes every entry that is in `set`. One pass, in place. -> { at, items }: the ascending indices they had, and
// the entries in that order - exactly what insertAt needs to put them back.
function removeSet(arr, set) {
  const at = [], items = [];
  let w = 0;
  for (let r = 0; r < arr.length; r++) {
    const item = arr[r];
    if (set.has(item)) { at.push(r); items.push(item); } else arr[w++] = item;
  }
  arr.length = w;
  return { at, items };
}

// true when arr holds exactly `items` at the indices `at`: the map is as this command left it
const sitsAt = (arr, items, at) => items.length > 0 && arr[at[0]] === items[0] && arr[at[at.length - 1]] === items[items.length - 1];

// ---------------------------------------------------------------- add

class Add {
  constructor(kind, items, at) {
    if (!Object.hasOwn(COLLECTION, kind)) fail(`add('${kind}')`, 'one of object, spawn, chest, npc, region');
    this.kind = kind;
    this.list = COLLECTION[kind];
    this.items = unique(items);
    for (const item of this.items) {
      if (kindOf(item) !== kind) fail(`add('${kind}')`, `items of that kind (made with make('${kind}', ...))`);
      copyOf(kind, item, kind);        // checks every field: an item with a missing one would be quantised into NaN
    }
    const n = this.items.length;
    if (at === null || at === undefined) this.at = null;
    else if (typeof at === 'number') {
      if (!Number.isInteger(at) || at < 0) fail(`add('${kind}')`, 'an index');
      this.at = at;                    // becomes the list of final indices when the length of the list is known
    } else {
      this.at = [...at];
      if (this.at.length !== n) fail(`add('${kind}')`, 'one index per item');
      for (let i = 0; i < n; i++) {
        if (!Number.isInteger(this.at[i]) || this.at[i] < (i ? this.at[i - 1] + 1 : 0)) fail(`add('${kind}')`, 'ascending indices');
      }
    }
  }

  get label() { return `Add ${describe(this.items.map(() => this.kind))}`; }

  get bytes() { return 64 + 16 * this.items.length; }

  do(map) {
    const arr = map[this.list], items = this.items, n = items.length, change = emptyChange();
    if (!n) return change;
    if (typeof this.at === 'number') {
      const start = Math.min(this.at, arr.length);
      this.at = items.map((_, i) => start + i);
    } else if (this.at) {
      // at[i] is where items[i] ends up: i of the new items and at[i] - i old entries stand before it
      for (let i = 0; i < n; i++) if (this.at[i] - i > arr.length) throw new RangeError(`add('${this.kind}'): index ${this.at[i]} is beyond the list`);
    }
    for (const item of items) quantizeItem(this.kind, item);
    if (this.at) insertAt(arr, items, this.at);
    else for (const item of items) arr.push(item);
    change.added[this.list] = items.slice();
    return change;
  }

  undo(map) {
    const arr = map[this.list], items = this.items, n = items.length, change = emptyChange();
    if (!n) return change;
    const tail = arr.length - n;
    if (!this.at && tail >= 0 && arr[tail] === items[0] && arr[arr.length - 1] === items[n - 1]) arr.length = tail;
    else if (this.at && sitsAt(arr, items, this.at)) removeAt(arr, this.at);
    else removeSet(arr, new Set(items));
    change.removed[this.list] = items.slice();
    return change;
  }

  // a brush stroke adds a few objects per pointer move, all at the end: one command for the stroke
  merge(next) {
    if (!(next instanceof Add) || next.kind !== this.kind || this.at !== null || next.at !== null) return false;
    for (const item of next.items) this.items.push(item);
    return true;
  }
}

// kind: 'object' | 'spawn' | 'chest' | 'npc' | 'region'. Inserts the GIVEN references (make them with make / clone).
// at: null = at the end; one index = the items in a row from there; ascending indices = where each item ends up.
export function add(kind, items, at = null) {
  return new Add(kind, items, at);
}

// ---------------------------------------------------------------- remove

class Remove {
  constructor(items) {
    const list = unique(items), kinds = kindsOf(list, 'remove');
    this.kinds = [];
    this.pending = {};       // list -> Set of items to look for; replaced by `found` once they were looked up
    this.found = null;       // list -> { at, items }: where each removed item stood
    list.forEach((item, i) => {
      if (kinds[i] === 'start') return;         // a map always has its start point
      this.kinds.push(kinds[i]);
      (this.pending[LIST_OF[kinds[i]]] ??= new Set()).add(item);
    });
  }

  get label() { return `Delete ${describe(this.kinds)}`; }

  get bytes() { return 64 + 16 * this.kinds.length; }

  do(map) {
    const change = emptyChange();
    if (this.pending) {
      this.found = {};
      this.kinds = [];
      for (const list of Object.keys(this.pending)) {
        const hit = removeSet(map[list], this.pending[list]);
        if (!hit.items.length) continue;        // items that are not in the map are not this command's business
        this.found[list] = hit;
        for (let i = 0; i < hit.items.length; i++) this.kinds.push(kindOf(hit.items[i]));
      }
      this.pending = null;
    } else {
      for (const list of Object.keys(this.found)) {
        const { at, items } = this.found[list];
        if (sitsAt(map[list], items, at)) removeAt(map[list], at);
        else removeSet(map[list], new Set(items));
      }
    }
    for (const list of Object.keys(this.found)) change.removed[list] = this.found[list].items.slice();
    return change;
  }

  undo(map) {
    const change = emptyChange();
    for (const list of Object.keys(this.found ?? {})) {
      const { at, items } = this.found[list];
      insertAt(map[list], items, at);           // the same references at the same indices
      change.added[list] = items.slice();
    }
    return change;
  }
}

// Any mix of kinds; the start point is skipped, and so is whatever is not in the map.
export function remove(items) {
  return new Remove(items);
}

// ---------------------------------------------------------------- set, setEach

// The part of a patch that applies to one kind, as values the item may own. -> { patch, plain } or null when no key of
// the patch is a field of that kind (a mixed selection takes what applies). plain: no value is an object, so one
// patch object can serve every item of the kind.
function patchFor(kind, patch, where) {
  const fields = FIELDS[kind], out = {};
  let n = 0, plain = true;
  for (const key of Object.keys(patch)) {
    if (!Object.hasOwn(fields, key)) continue;
    let v = patch[key];
    if (v === undefined) {
      if (!Object.hasOwn(OPTIONAL[kind], key)) throw new TypeError(`${where}: ${kind}.${key} has no default to reset to`);
      v = OPTIONAL[kind][key];
    } else v = take(fields[key], v, `${where}: ${kind}.${key}`);
    if (typeof v === 'object' && v !== null) plain = false;
    out[key] = v;
    n++;
  }
  return n ? { patch: out, plain } : null;
}

const sameKeys = (a, b) => {
  let n = 0;
  for (const k in a) { if (!(k in b)) return false; n++; }
  return n === Object.keys(b).length;
};

const MOVE_KEYS = ['x', 'y', 'z'], TURN_KEYS = ['rx', 'ry', 'rz'], SCALE_KEYS = ['s', 'sy'];

class SetFields {
  // items are unique; after[i] is the patch of items[i] (never empty), owned by this command
  constructor(items, kinds, after) {
    this.items = items;
    this.kinds = kinds;
    this.after = after;
    this.before = null;      // before[i]: the values the keys of after[i] had, saved by the first do()
  }

  get label() {
    const keys = new Set();
    let grouped = false;
    for (const patch of this.after) {
      for (const k in patch) keys.add(k);
      if (patch.g != null) grouped = true;
    }
    const only = (list) => keys.size > 0 && [...keys].every((k) => list.includes(k));
    const what = describe(this.kinds);
    if (only(['g'])) return `${grouped ? 'Group' : 'Ungroup'} ${what}`;
    if (only(['m'])) return `Replace the model of ${what}`;
    if (only(['name'])) return `Rename ${what}`;
    if (only(['shape'])) return `Reshape ${what}`;
    if (only(MOVE_KEYS)) return `Move ${what}`;
    if (only(TURN_KEYS)) return `Rotate ${what}`;
    if (only(SCALE_KEYS)) return `Scale ${what}`;
    if (only(['r'])) return `Resize ${what}`;
    return `Edit ${what}`;
  }

  get bytes() { return 64 + 96 * this.items.length; }

  do(map) {
    const { items, kinds, after } = this, change = emptyChange(), first = this.before === null;
    if (first) this.before = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
      const item = items[i], kind = kinds[i], patch = after[i];
      if (kind === 'start' && item !== map.start) continue;      // a start point of another map
      const before = first ? (this.before[i] = {}) : this.before[i];
      for (const key in patch) {
        if (first) before[key] = item[key];
        item[key] = patch[key];
      }
      quantizeItem(kind, item);
      let changed = false;
      for (const key in patch) if (!same(item[key], before[key])) { changed = true; break; }
      // an equal value keeps the old reference: nothing at all differs, and the store forgets the command
      if (changed) change.updated[LIST_OF[kind]].push(item);
      else for (const key in patch) item[key] = before[key];
    }
    return change;
  }

  undo(map) {
    const { items, kinds, before } = this, change = emptyChange();
    if (!before) return change;
    for (let i = 0; i < items.length; i++) {
      const item = items[i], saved = before[i];
      if (!saved) continue;                     // skipped by do(): a start point of another map
      let changed = false;
      for (const key in saved) {
        if (!changed && !same(item[key], saved[key])) changed = true;
        item[key] = saved[key];
      }
      if (changed) change.updated[LIST_OF[kinds[i]]].push(item);
    }
    return change;
  }

  // A field that is scrubbed or typed into sets the same keys on the same items on every input event (§10.11): the
  // first `before` and the latest values are all an undo step needs. (Not asked for by the spec, which merges only
  // add, transform and paint; without it, scrubbing 6,000 objects keeps 6,000 patches per pointer move.)
  merge(next) {
    if (!(next instanceof SetFields) || next.items.length !== this.items.length || !this.before) return false;
    for (let i = 0; i < this.items.length; i++) {
      if (next.items[i] !== this.items[i] || (next.after[i] !== this.after[i] && !sameKeys(next.after[i], this.after[i]))) return false;
    }
    this.after = next.after;
    return true;
  }

  // A field that was typed in and put back, a rim dragged out and home again: every key holds what it held before
  // this command (and whatever was merged into it) first ran.
  unchanged() {
    const { items, before } = this;
    if (!before) return true;                   // never ran
    for (let i = 0; i < items.length; i++) {
      const saved = before[i];
      if (!saved) continue;                     // skipped by do(): a start point of another map
      for (const key in saved) if (!same(items[i][key], saved[key])) return false;
    }
    return true;
  }
}

// The same shallow patch on every item. A value of undefined resets the key to its default (col -> null, g -> null).
// Keys that an item's kind does not have are skipped for that item. Items are mutated in place; an object value
// (shape, lvl, types, col, levels) replaces the old one and is copied per item.
export function set(items, patch) {
  if (!isObj(patch)) fail('set', 'a patch object');
  const list = unique(items), all = kindsOf(list, 'set'), outItems = [], kinds = [], after = [], cache = {};
  list.forEach((item, i) => {
    const kind = all[i];
    let p = cache[kind];
    if (p === undefined || (p && !p.plain)) p = patchFor(kind, patch, 'set');
    if (cache[kind] === undefined) cache[kind] = p;
    if (!p) return;
    outItems.push(item);
    kinds.push(kind);
    after.push(p.patch);
  });
  return new SetFields(outItems, kinds, after);
}

// patches[i] for items[i]. An item given twice gets both patches, the later one winning key by key.
export function setEach(items, patches) {
  const list = toList(items), given = toList(patches);
  if (list.length !== given.length) fail('setEach', 'one patch per item');
  const all = kindsOf(list, 'setEach'), outItems = [], kinds = [], after = [], index = new Map();
  list.forEach((item, i) => {
    if (!isObj(given[i])) fail('setEach', 'patch objects');
    const p = patchFor(all[i], given[i], 'setEach');
    if (!p) return;
    const seen = index.get(item);
    if (seen !== undefined) { Object.assign(after[seen], p.patch); return; }
    index.set(item, outItems.length);
    outItems.push(item);
    kinds.push(all[i]);
    after.push(p.patch);
  });
  return new SetFields(outItems, kinds, after);
}

// ---------------------------------------------------------------- snapshot, transform

// Per item five numbers: x, z, y, ry, size - size is `s` of an object and `r` of a spawn, the start and a circle region.
// A region keeps its centre in x, z (that is its origin for the pivot) and a copy of its whole shape in `shapes`.
const STRIDE = 5;

function readTransform(kind, item, data, o) {
  if (kind === 'region') {
    const s = item.shape;
    if (s.type === 'circle') { data[o] = s.x; data[o + 1] = s.z; data[o + 4] = s.r; return; }
    let x = 0, z = 0;
    for (const p of s.points) { x += p[0]; z += p[1]; }
    data[o] = s.points.length ? x / s.points.length : 0;
    data[o + 1] = s.points.length ? z / s.points.length : 0;
    return;
  }
  data[o] = item.x;
  data[o + 1] = item.z;
  if (kind === 'object') { data[o + 2] = item.y; data[o + 3] = item.ry; data[o + 4] = item.s; }
  else if (kind === 'chest' || kind === 'npc') data[o + 3] = item.ry;
  else data[o + 4] = item.r;       // spawn, start
}

// -> Snapshot: the transform-relevant fields of each item, captured now. Not a command: transform() works from it,
// so a drag applies every pointer move to the values the drag started with and rounding never accumulates.
export function snapshot(items) {
  const list = unique(items), kinds = kindsOf(list, 'snapshot');
  const data = new Float64Array(list.length * STRIDE), shapes = [];
  list.forEach((item, i) => {
    readTransform(kinds[i], item, data, i * STRIDE);
    if (kinds[i] === 'region') shapes[i] = take('shape', item.shape, 'snapshot: region.shape');
  });
  return { items: list, kinds, data, shapes, pivot: null };
}

// The default pivot: the centre of the ground bounding box of the items' origins.
function pivotOf(snap) {
  if (snap.pivot) return snap.pivot;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let o = 0; o < snap.data.length; o += STRIDE) {
    const x = snap.data[o], z = snap.data[o + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  snap.pivot = snap.items.length ? { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 } : { x: 0, z: 0 };
  return snap.pivot;
}

class Transform {
  constructor(snap, t) {
    if (!isObj(snap) || !Array.isArray(snap.items) || !(snap.data instanceof Float64Array)) fail('transform', 'a snapshot (see snapshot())');
    if (!isObj(t)) fail('transform', 't = { dx, dz, dy, rot, scale, pivot, individual }');
    const { dx = 0, dz = 0, dy = 0, rot = 0, scale = 1, pivot = null, individual = false } = t;
    for (const [name, v] of [['dx', dx], ['dz', dz], ['dy', dy], ['rot', rot], ['scale', scale]]) if (!finite(v)) fail(`transform: t.${name}`, 'a finite number');
    if (pivot !== null && !(isObj(pivot) && finite(pivot.x) && finite(pivot.z))) fail('transform: t.pivot', '{ x, z }');
    this.snap = snap;
    this.t = { dx, dz, dy, rot, scale, pivot: pivot && { x: pivot.x, z: pivot.z }, individual: !!individual };
    this.before = null;      // { data, shapes }: what the items held when do() first ran - normally the snapshot itself
  }

  get label() {
    const { dx, dz, dy, rot, scale } = this.t, moved = dx !== 0 || dz !== 0 || dy !== 0, what = describe(this.snap.kinds);
    if (rot !== 0 && scale === 1 && !moved) return `Rotate ${what}`;
    if (scale !== 1 && rot === 0 && !moved) return `Scale ${what}`;
    return rot === 0 && scale === 1 ? `Move ${what}` : `Transform ${what}`;
  }

  get bytes() {
    let n = 64 + 64 * this.snap.items.length;
    for (const s of this.snap.shapes) if (s && s.points) n += 32 * s.points.length;
    return n;
  }

  // What the items hold right now, in the layout of a snapshot. A region gives its shape OBJECT: transform replaces
  // the shape, so undo can hand the old one back.
  capture(map) {
    const { items, kinds, data } = this.snap, now = new Float64Array(data.length), shapes = [];
    let equal = true;
    for (let i = 0; i < items.length; i++) {
      if (kinds[i] === 'start' && items[i] !== map.start) continue;
      const o = i * STRIDE;
      readTransform(kinds[i], items[i], now, o);
      if (kinds[i] === 'region') shapes[i] = items[i].shape;
      for (let k = 0; equal && k < STRIDE; k++) equal = now[o + k] === data[o + k];
    }
    return { data: equal ? data : now, shapes };       // nothing moved since the snapshot: share its numbers
  }

  do(map) {
    const { items, kinds, data, shapes } = this.snap, { dx, dz, dy, rot, scale, individual } = this.t, change = emptyChange();
    if (!this.before) this.before = this.capture(map);
    const turn = rot !== 0 || scale !== 1, cos = Math.cos(rot), sin = Math.sin(rot);
    const pivot = turn && !individual ? this.t.pivot ?? pivotOf(this.snap) : null;
    // (x, z) scaled and turned about (px, pz), then moved. A positive angle takes +Z towards +X, as `ry` does (§2.2).
    const place = (x, z, px, pz, out) => {
      const ox = (x - px) * scale, oz = (z - pz) * scale;
      out[0] = px + ox * cos + oz * sin + dx;
      out[1] = pz - ox * sin + oz * cos + dz;
    };
    const at = [0, 0];
    for (let i = 0; i < items.length; i++) {
      const item = items[i], kind = kinds[i], o = i * STRIDE;
      if (kind === 'start' && item !== map.start) continue;
      if (kind === 'region') {
        // `individual` turns and scales a region about its own centre, which therefore stays where it is
        const s = shapes[i], px = pivot ? pivot.x : data[o], pz = pivot ? pivot.z : data[o + 1], old = item.shape;
        if (s.type === 'circle') {
          if (turn) place(s.x, s.z, px, pz, at); else { at[0] = s.x + dx; at[1] = s.z + dz; }
          item.shape = { type: 'circle', x: at[0], z: at[1], r: s.r * scale };
        } else {
          item.shape = {
            type: 'poly',
            points: s.points.map((p) => {
              if (turn) place(p[0], p[1], px, pz, at); else { at[0] = p[0] + dx; at[1] = p[1] + dz; }
              return [at[0], at[1]];
            }),
          };
        }
        quantizeItem('region', item);
        if (same(old, item.shape)) item.shape = old; else change.updated.regions.push(item);
        continue;
      }
      const x = item.x, z = item.z, y = item.y, ry = item.ry, size = kind === 'object' ? item.s : item.r;
      if (pivot) place(data[o], data[o + 1], pivot.x, pivot.z, at); else { at[0] = data[o] + dx; at[1] = data[o + 1] + dz; }
      item.x = at[0];
      item.z = at[1];
      if (kind === 'object') { item.y = data[o + 2] + dy; item.ry = data[o + 3] + rot; item.s = data[o + 4] * scale; }
      else if (kind === 'chest' || kind === 'npc') item.ry = data[o + 3] + rot;
      else item.r = data[o + 4] * scale;
      quantizeItem(kind, item);
      if (item.x !== x || item.z !== z || item.y !== y || item.ry !== ry || (kind === 'object' ? item.s : item.r) !== size) {
        change.updated[LIST_OF[kind]].push(item);
      }
    }
    return change;
  }

  undo(map) {
    const { items, kinds } = this.snap, change = emptyChange();
    if (!this.before) return change;
    const { data, shapes } = this.before;
    for (let i = 0; i < items.length; i++) {
      const item = items[i], kind = kinds[i], o = i * STRIDE;
      if (kind === 'start' && item !== map.start) continue;
      if (kind === 'region') {
        if (item.shape === shapes[i]) continue;
        item.shape = shapes[i];
        change.updated.regions.push(item);
        continue;
      }
      const x = item.x, z = item.z, y = item.y, ry = item.ry, size = kind === 'object' ? item.s : item.r;
      item.x = data[o];
      item.z = data[o + 1];
      if (kind === 'object') { item.y = data[o + 2]; item.ry = data[o + 3]; item.s = data[o + 4]; }
      else if (kind === 'chest' || kind === 'npc') item.ry = data[o + 3];
      else item.r = data[o + 4];
      if (item.x !== x || item.z !== z || item.y !== y || item.ry !== ry || (kind === 'object' ? item.s : item.r) !== size) {
        change.updated[LIST_OF[kind]].push(item);
      }
    }
    return change;
  }

  // every pointer move of a drag is a transform of the same snapshot: only the latest counts
  merge(next) {
    if (!(next instanceof Transform) || next.snap !== this.snap) return false;
    this.t = next.t;
    return true;
  }

  // A drag that came back to where it started: every item holds the numbers - a region the shape, by value - it had
  // before this command first ran. (The same comparison undo() makes to tell what it changed.)
  unchanged(map) {
    if (!this.before) return true;              // never ran
    const { items, kinds } = this.snap, { data, shapes } = this.before;
    for (let i = 0; i < items.length; i++) {
      const item = items[i], kind = kinds[i], o = i * STRIDE;
      if (kind === 'start' && item !== map.start) continue;
      if (kind === 'region') {
        if (!same(item.shape, shapes[i])) return false;
        continue;
      }
      if (item.x !== data[o] || item.z !== data[o + 1]) return false;
      if (kind === 'object') {
        if (item.y !== data[o + 2] || item.ry !== data[o + 3] || item.s !== data[o + 4]) return false;
      } else if (kind === 'chest' || kind === 'npc') {
        if (item.ry !== data[o + 3]) return false;
      } else if (item.r !== data[o + 4]) return false;
    }
    return true;
  }
}

// t = { dx = 0, dz = 0, dy = 0, rot = 0, scale = 1, pivot: { x, z }, individual = false } - always RELATIVE TO THE
// SNAPSHOT, never to what the items hold now.
//   object       x, z move, y += dy, ry += rot, s *= scale        chest, npc   x, z move, ry += rot
//   spawn, start, circle region   x, z move, r *= scale           poly region  every point moves
// rot and scale act about `pivot` (default: the middle of the snapshot's origins). With `individual` the positions
// stay and only ry / s / r change - each item about its own origin, a region about its own centre.
export function transform(snap, t) {
  return new Transform(snap, t);
}

// ---------------------------------------------------------------- reorder

class Reorder {
  constructor(kind, item, toIndex) {
    if (!Object.hasOwn(COLLECTION, kind)) fail(`reorder('${kind}')`, "a kind that has a list ('region')");
    if (kindOf(item) !== kind) fail(`reorder('${kind}')`, 'an item of that kind');
    if (!Number.isInteger(toIndex)) fail(`reorder('${kind}')`, 'an index');
    this.kind = kind;
    this.list = COLLECTION[kind];
    this.item = item;
    this.to = toIndex;
    this.from = -1;
  }

  get label() { return `Reorder ${NOUNS[this.kind][1]}`; }

  get bytes() { return 64; }

  move(map, from, to) {
    const arr = map[this.list], change = emptyChange();
    if (from === to || arr[from] !== this.item) return change;
    const step = from < to ? 1 : -1;
    for (let i = from; i !== to; i += step) arr[i] = arr[i + step];
    arr[to] = this.item;
    change.order.push(this.list);
    return change;
  }

  do(map) {
    const arr = map[this.list];
    this.from = arr.indexOf(this.item);
    if (this.from < 0) return emptyChange();
    this.to = Math.max(0, Math.min(arr.length - 1, this.to));
    return this.move(map, this.from, this.to);
  }

  undo(map) {
    return this.from < 0 ? emptyChange() : this.move(map, this.to, this.from);
  }
}

// Moves the item to index toIndex of its list (clamped). 'region' only in v1: region order is priority, later wins.
export function reorder(kind, item, toIndex) {
  return new Reorder(kind, item, toIndex);
}

// ---------------------------------------------------------------- paint

// The cells one stroke changed, in the order it changed them: index and the type the cell had. Appended to, never
// searched: a cell is recorded again only when a later part of the stroke paints it with ANOTHER type, and undo walks
// the list backwards, so the first `before` of a cell is the one that sticks.
class Stroke {
  constructor() {
    this.n = 0;
    this.index = new Int32Array(256);
    this.before = new Uint8Array(256);
    this.after = null;       // what each cell held when the stroke was undone; all a redo needs
  }

  push(index, before) {
    if (this.n === this.index.length) {
      const index2 = new Int32Array(this.n * 2), before2 = new Uint8Array(this.n * 2);
      index2.set(this.index);
      before2.set(this.before);
      this.index = index2;
      this.before = before2;
    }
    this.index[this.n] = index;
    this.before[this.n++] = before;
  }
}

class Paint {
  constructor(indices, type) {
    if (!Number.isInteger(type) || type < 0 || type >= GROUND_TYPES.length) fail('paint', 'an index into GROUND_TYPES');
    if (!indices || typeof indices.length !== 'number') fail('paint', 'cell indices (an Int32Array or an array)');
    this.type = type;
    this.indices = Int32Array.from(indices);      // a copy: brushes reuse their buffers
    this.stroke = new Stroke();
  }

  get label() { return 'Paint'; }

  get bytes() { return 64 + 5 * this.stroke.n; }

  do(map) {
    const { cells, size } = map.ground, stroke = this.stroke, change = emptyChange();
    let ix0 = size, iz0 = size, ix1 = -1, iz1 = -1;
    const grow = (i) => {
      const ix = i % size, iz = (i - ix) / size;
      if (ix < ix0) ix0 = ix;
      if (ix > ix1) ix1 = ix;
      if (iz < iz0) iz0 = iz;
      if (iz > iz1) iz1 = iz;
    };
    if (this.indices) {                           // the first time
      const list = this.indices, type = this.type;
      this.indices = null;
      for (let k = 0; k < list.length; k++) {
        const i = list[k];
        if (i < 0 || i >= cells.length || cells[i] === type) continue;      // off the grid, or already of that type
        stroke.push(i, cells[i]);
        cells[i] = type;
        grow(i);
      }
    } else if (stroke.after) {                    // a redo
      for (let k = 0; k < stroke.n; k++) {
        const i = stroke.index[k];
        if (cells[i] === stroke.after[k]) continue;
        cells[i] = stroke.after[k];
        grow(i);
      }
    }
    if (ix1 >= 0) change.ground = { ix0, iz0, ix1, iz1 };
    return change;
  }

  undo(map) {
    const { cells, size } = map.ground, stroke = this.stroke, change = emptyChange();
    let ix0 = size, iz0 = size, ix1 = -1, iz1 = -1;
    if (!stroke.after || stroke.after.length !== stroke.n) stroke.after = new Uint8Array(stroke.n);
    for (let k = 0; k < stroke.n; k++) stroke.after[k] = cells[stroke.index[k]];
    for (let k = stroke.n - 1; k >= 0; k--) {
      const i = stroke.index[k];
      if (cells[i] === stroke.before[k]) continue;
      cells[i] = stroke.before[k];
      const ix = i % size, iz = (i - ix) / size;
      if (ix < ix0) ix0 = ix;
      if (ix > ix1) ix1 = ix;
      if (iz < iz0) iz0 = iz;
      if (iz > iz1) iz1 = iz;
    }
    if (ix1 >= 0) change.ground = { ix0, iz0, ix1, iz1 };
    return change;
  }

  // The store offers `next` BEFORE it runs it: from now on next writes into this command's stroke, and this command
  // undoes and redoes the whole of it (first `before` wins, the latest type applies).
  merge(next) {
    if (!(next instanceof Paint) || !next.indices) return false;
    next.stroke = this.stroke;
    return true;
  }
}

// indices: Int32Array | number[] into ground.cells; type: index into GROUND_TYPES. Cells already of that type are
// skipped. Change.ground is the inclusive rectangle of the cells that changed.
export function paint(indices, type) {
  return new Paint(indices, type);
}

// ---------------------------------------------------------------- heights

// The vertices one sculpt stroke moved: index and the height each one had BEFORE the stroke. A stroke writes the same
// vertices again on every frame, so a vertex is recorded once (`slot` finds it) and only its first `before` is kept.
class Relief {
  constructor() {
    this.n = 0;
    this.index = new Int32Array(256);
    this.before = new Float32Array(256);
    this.after = null;       // what each vertex held when the stroke was undone; all a redo needs
    this.slot = new Map();   // vertex index -> its place in the two lists
    this.made = null;        // the heights array this stroke had to create (a ground that came without one)
  }

  // Remembers the height the vertex has now, unless the stroke has moved it before.
  keep(index, before) {
    if (this.slot.has(index)) return;
    if (this.n === this.index.length) {
      const index2 = new Int32Array(this.n * 2), before2 = new Float32Array(this.n * 2);
      index2.set(this.index);
      before2.set(this.before);
      this.index = index2;
      this.before = before2;
    }
    this.slot.set(index, this.n);
    this.index[this.n] = index;
    this.before[this.n++] = before;
  }
}

class Heights {
  constructor(indices, values, label) {
    if (!indices || typeof indices.length !== 'number') fail('heights', 'vertex indices (an Int32Array or an array)');
    const one = typeof values === 'number';
    if (!one && (!values || values.length !== indices.length)) fail('heights', 'one height per index, or one height for all');
    this.indices = Int32Array.from(indices);      // copies: brushes reuse their buffers
    this.values = new Float32Array(indices.length);
    for (let k = 0; k < indices.length; k++) {
      const v = one ? values : values[k];
      if (!finite(v)) fail(`heights: values[${k}]`, 'a finite number');
      this.values[k] = clampHeight(v);            // on the 0.1 grid and inside LIMITS.height: what the file can hold
    }
    this.label = String(label);
    this.stroke = new Relief();
  }

  get bytes() { return 64 + 28 * this.stroke.n; }

  do(map) {
    const ground = map.ground, stroke = this.stroke, size = ground.size, change = emptyChange();
    let ix0 = size, iz0 = size, ix1 = -1, iz1 = -1;
    const grow = (i) => {
      const ix = i % size, iz = (i - ix) / size;
      if (ix < ix0) ix0 = ix;
      if (ix > ix1) ix1 = ix;
      if (iz < iz0) iz0 = iz;
      if (iz > iz1) iz1 = iz;
    };
    if (!ground.heights && (this.indices || stroke.after)) {
      // a ground without heights is flat: the first stroke gives it the array (undo takes it away again)
      stroke.made ??= new Float32Array(ground.cells.length);
      ground.heights = stroke.made;
    }
    const heights = ground.heights;
    if (this.indices) {                           // the first time
      const list = this.indices, values = this.values;
      this.indices = this.values = null;
      for (let k = 0; k < list.length; k++) {
        const i = list[k];
        if (i < 0 || i >= heights.length || heights[i] === values[k]) continue;   // off the grid, or there already
        stroke.keep(i, heights[i]);
        heights[i] = values[k];
        grow(i);
      }
    } else if (stroke.after) {                    // a redo
      for (let k = 0; k < stroke.n; k++) {
        const i = stroke.index[k];
        if (heights[i] === stroke.after[k]) continue;
        heights[i] = stroke.after[k];
        grow(i);
      }
    }
    if (ix1 >= 0) change.ground = { ix0, iz0, ix1, iz1, relief: true };
    return change;
  }

  undo(map) {
    const ground = map.ground, heights = ground.heights, stroke = this.stroke, size = ground.size, change = emptyChange();
    if (!heights) return change;
    let ix0 = size, iz0 = size, ix1 = -1, iz1 = -1;
    if (!stroke.after || stroke.after.length !== stroke.n) stroke.after = new Float32Array(stroke.n);
    for (let k = 0; k < stroke.n; k++) stroke.after[k] = heights[stroke.index[k]];
    for (let k = 0; k < stroke.n; k++) {
      const i = stroke.index[k];
      if (heights[i] === stroke.before[k]) continue;
      heights[i] = stroke.before[k];
      const ix = i % size, iz = (i - ix) / size;
      if (ix < ix0) ix0 = ix;
      if (ix > ix1) ix1 = ix;
      if (iz < iz0) iz0 = iz;
      if (iz > iz1) iz1 = iz;
    }
    if (stroke.made && heights === stroke.made) delete ground.heights;   // the ground is as it was found: without the array
    if (ix1 >= 0) change.ground = { ix0, iz0, ix1, iz1, relief: true };
    return change;
  }

  // The store offers `next` BEFORE it runs it: from now on next writes into this command's stroke, and this command
  // undoes and redoes the whole of it (the first `before` of a vertex wins, its latest height applies).
  merge(next) {
    if (!(next instanceof Heights) || !next.indices) return false;
    next.stroke = this.stroke;
    return true;
  }

  // A stroke that raised and lowered its way back: every vertex holds the height it had before.
  unchanged(map) {
    const heights = map.ground.heights, stroke = this.stroke;
    if (!heights) return true;
    for (let k = 0; k < stroke.n; k++) if (heights[stroke.index[k]] !== stroke.before[k]) return false;
    return true;
  }
}

// indices: Int32Array | number[] into ground.heights; values: one height per index (Float32Array | number[]), or one
// number for all of them. A height is written on the 0.1 grid and clamped to LIMITS.height (clampHeight); vertices that
// hold their value already are skipped. Change.ground is the inclusive rectangle of the vertices that moved, with
// `relief: true` - what tells a listener that the SHAPE of the ground changed, not its paint.
// Merges with a following heights() inside a store group: a stroke that writes the same vertices sixty times a second
// is one command with one record per vertex.
export function heights(indices, values, label = 'Sculpt') {
  return new Heights(indices, values, label);
}

// ---------------------------------------------------------------- setProps

const PROPS = ['name', 'radius', 'foliage', 'fallback'];
const PROP_ORDER = [...PROPS, 'ground'];

class Props {
  constructor(patch) {
    if (!isObj(patch)) fail('setProps', 'a patch object');
    const p = {};
    for (const key of Object.keys(patch)) {
      if (!PROPS.includes(key)) fail(`setProps: '${key}'`, `one of ${PROPS.join(', ')}`);
      if (patch[key] === undefined) continue;
      if (key === 'name') p.name = take(STR, patch.name, 'setProps: name');
      else if (key === 'radius') p.radius = take(NUM, patch.radius, 'setProps: radius');
      else if (key === 'foliage') p.foliage = take(BOOL, patch.foliage, 'setProps: foliage');
      else {
        const f = patch.fallback;
        if (!isObj(f)) fail('setProps: fallback', '{ name?, levels?, mood? }');
        p.fallback = {};
        for (const k of Object.keys(f)) {
          if (f[k] === undefined) continue;
          if (k === 'name') p.fallback.name = take(STR, f.name, 'setProps: fallback.name');
          else if (k === 'levels') p.fallback.levels = take('levels', f.levels, 'setProps: fallback.levels');
          else if (k === 'mood' && f.mood !== null) p.fallback.mood = take('mood', f.mood, 'setProps: fallback.mood');
          else fail(`setProps: fallback.${k}`, 'name, levels or a mood id (the fallback always has a mood)');
        }
      }
    }
    this.patch = p;
    this.before = null;      // key -> value, for the keys that really change; filled by the first do()
    this.after = null;
  }

  get label() {
    const keys = this.after ? Object.keys(this.after) : Object.keys(this.patch);
    const only = (...list) => keys.length > 0 && keys.every((k) => list.includes(k));
    if (only('name')) return 'Rename the map';
    if (only('radius', 'ground')) return 'Resize the map';
    if (only('foliage')) return 'Toggle foliage';
    if (only('fallback')) return 'Edit the fallback region';
    return 'Edit the map';
  }

  get bytes() { return 128 + (this.after && this.after.ground ? this.after.ground.cells.length * (this.after.ground.heights ? 5 : 1) : 0); }

  // The spec asks for the radius to be clamped "before the command is built" - but a command is built without a map.
  // So it happens here, the first time the command meets the map it is for.
  plan(map) {
    const p = this.patch, before = {}, after = {};
    const change = (key, value) => { if (!same(value, map[key])) { before[key] = map[key]; after[key] = value; } };
    if ('name' in p) change('name', p.name);
    if ('radius' in p) {
      // never above what a grid of this cell size can cover: resizeGround must not be asked for more than 513 vertices
      const radius = Math.min(p.radius, maxRadius(map.ground));
      change('radius', radius);
      const ground = resizeGround(map.ground, radius);      // the same object when it already reaches radius + 20
      if (ground !== map.ground) { before.ground = map.ground; after.ground = ground; }
    }
    if ('foliage' in p) change('foliage', p.foliage);
    if ('fallback' in p) {
      const old = map.fallback, f = p.fallback;
      const levels = 'levels' in f ? f.levels : old.levels;
      change('fallback', { name: f.name ?? old.name, levels: levels ? [levels[0], levels[1]] : null, mood: f.mood ?? old.mood });
    }
    this.before = before;
    this.after = after;
  }

  apply(map, values) {
    const change = emptyChange();
    for (const key of PROP_ORDER) {
      if (!Object.hasOwn(values, key)) continue;
      map[key] = values[key];
      change.props.push(key);
    }
    return change;
  }

  do(map) {
    if (!this.after) this.plan(map);
    return this.apply(map, this.after);
  }

  undo(map) {
    return this.before ? this.apply(map, this.before) : emptyChange();
  }
}

// { name?, radius?, foliage?, fallback? } - fallback may be partial: { mood: 'cursed' }.
// A radius above maxRadius(map.ground) is CLAMPED to it. A radius the ground does not cover (groundHalf < radius + 20)
// also replaces map.ground with a larger grid in the same command: Change.props then has 'radius' and 'ground'.
export function setProps(patch) {
  return new Props(patch);
}

// ---------------------------------------------------------------- batch

// The net effect of several Changes, in order: an item added and removed again is in neither list, an item removed
// and added back counts as updated (and its list as reordered).
function union(changes) {
  const out = emptyChange(), sets = {};
  for (const list of LISTS) sets[list] = { added: new Set(), removed: new Set(), updated: new Set() };
  const start = new Set();
  let rect = null;
  for (const ch of changes) {
    if (ch.props.includes('ground')) rect = null;       // a rectangle of the old grid means nothing on the new one
    if (ch.ground) {
      const g = ch.ground;
      const relief = !!(rect?.relief || g.relief);
      rect = rect
        ? { ix0: Math.min(rect.ix0, g.ix0), iz0: Math.min(rect.iz0, g.iz0), ix1: Math.max(rect.ix1, g.ix1), iz1: Math.max(rect.iz1, g.iz1) }
        : { ix0: g.ix0, iz0: g.iz0, ix1: g.ix1, iz1: g.iz1 };
      if (relief) rect.relief = true;       // the shape of the ground moved somewhere inside the rectangle
    }
    for (const list of LISTS) {
      const { added, removed, updated } = sets[list];
      for (const item of ch.removed[list]) {
        updated.delete(item);
        if (!added.delete(item)) removed.add(item);
      }
      for (const item of ch.added[list]) {
        if (!removed.delete(item)) { added.add(item); continue; }
        updated.add(item);
        if (!out.order.includes(list)) out.order.push(list);
      }
      for (const item of ch.updated[list]) if (!added.has(item)) updated.add(item);
    }
    for (const item of ch.updated.start) start.add(item);
    for (const list of ch.order) if (!out.order.includes(list)) out.order.push(list);
    for (const key of ch.props) if (!out.props.includes(key)) out.props.push(key);
  }
  for (const list of LISTS) {
    out.added[list] = [...sets[list].added];
    out.removed[list] = [...sets[list].removed];
    out.updated[list] = [...sets[list].updated];
  }
  out.updated.start = [...start];
  out.ground = rect;
  return out;
}

class Batch {
  constructor(label, commands) {
    this.label = String(label);
    this.commands = toList(commands);
    for (const c of this.commands) if (!c || typeof c.do !== 'function' || typeof c.undo !== 'function') fail(`batch('${label}')`, 'commands');
  }

  get bytes() {
    let n = 64;
    for (const c of this.commands) n += c.bytes;
    return n;
  }

  // All or nothing: when one command throws, the ones before it are undone again.
  run(map, commands, back) {
    const changes = [];
    try {
      for (const c of commands) changes.push(back ? c.undo(map) : c.do(map));
    } catch (e) {
      for (let i = changes.length - 1; i >= 0; i--) { if (back) commands[i].do(map); else commands[i].undo(map); }
      throw e;
    }
    return union(changes);
  }

  do(map) {
    return this.run(map, this.commands, false);
  }

  undo(map) {
    return this.run(map, this.commands.slice().reverse(), true);
  }
}

// do in order, undo in reverse; the Change is the union. One undo step with its own label, also outside a group.
export function batch(label, commands) {
  return new Batch(label, commands);
}

// ---------------------------------------------------------------- helpers (not commands)

// -> a new item of that kind with the defaults of the format - the only way editor code creates items.
// kind: 'object' | 'spawn' | 'chest' | 'npc' | 'region'. An object needs its model `m`; everything else has a default.
export function make(kind, props = {}) {
  if (!Object.hasOwn(REQUIRED, kind)) fail(`make('${kind}')`, 'one of object, spawn, chest, npc, region (a map has exactly one start)');
  if (!isObj(props)) fail(`make('${kind}')`, 'a props object');
  const fields = FIELDS[kind], item = {};
  for (const key of Object.keys(props)) if (!Object.hasOwn(fields, key)) fail(`make('${kind}'): '${key}'`, `a field of that kind (${Object.keys(fields).join(', ')})`);
  for (const key of Object.keys(fields)) {
    const where = `make('${kind}'): ${key}`;
    if (props[key] !== undefined) item[key] = take(fields[key], props[key], where);
    else if (Object.hasOwn(OPTIONAL[kind], key)) item[key] = OPTIONAL[kind][key];
    else if (Object.hasOwn(REQUIRED[kind], key)) item[key] = take(fields[key], REQUIRED[kind][key], where);
    else fail(where, 'a value (it has no default)');
  }
  return quantizeItem(kind, item);
}

// -> a deep copy (lvl, types, shape.points, col circles) for duplicate and paste. Not in the map until it is added.
export function clone(item) {
  const kind = kindOf(item) ?? fail('clone', 'a map item');
  return quantizeItem(kind, copyOf(kind, item, `clone: ${kind}`));
}
