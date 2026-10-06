// The clipboard of the editor and the stamps: named clips that stay.
//
//   Clip = { v: 1, pivot: { x, z }, objects: [], spawns: [], chests: [], npcs: [] }
//
// The items of a clip are in FILE form (encodeItem: degrees, defaults omitted) with absolute coordinates, exactly as
// they would stand in the map file; `pivot` is the point that lands under the cursor when the clip is pasted. Regions
// and the start point are never part of a clip.
//
// A clip lives in this tab's memory and in localStorage['hypercat-editor-clipboard'], so it survives a reload and
// travels between two editor tabs. Stamps live in localStorage['hypercat-editor-stamps'] as { v: 1, stamps: [{ name, clip }] }.
// Whatever comes back from storage - or from a stamp file somebody hands over - is untrusted: every item is decoded
// with decodeItem and re-encoded before it is used, and one bad item rejects its clip.
//
// No DOM and no three: the module reads the store and `ui` it is given and touches nothing but the browser's storage.
import { COLLECTION, LAYER_OF, LIMITS, decodeItem, encodeItem, qPos, quantizeItem } from '../map/format.js';

export const CLIP_KEY = 'hypercat-editor-clipboard';
export const STAMPS_KEY = 'hypercat-editor-stamps';
export const CLIP_KINDS = ['object', 'spawn', 'chest', 'npc'];   // what can be copied, in the order of a clip's lists
export const MAX_STAMPS = 200;
export const STAMP_NAME_MAX = 48;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------- storage and change notes

// localStorage where there is one. Node has none; a browser may refuse it (private mode, a blocked origin).
function storage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
function load(key) {
  try { return storage()?.getItem(key) ?? null; } catch { return null; }
}
// -> whether the text was stored (false: no storage, or it is full)
function save(key, text) {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(key, text);
    return true;
  } catch { return false; }
}

const listeners = new Set();
function emit(what) {
  for (const fn of [...listeners]) {
    try { fn(what); } catch (e) { console.error('[editor] a clipboard listener failed', e); }
  }
}
// fn('clip' | 'stamps') whenever the clipboard or the stamps change - in this tab or in another one. -> unsubscribe
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------- clips

// -> a clean copy of `raw` when it is a clip that holds at least one item, else null. Every item goes through
// decodeItem and comes back in canonical file form, so nothing a file or another tab wrote is taken on trust.
function checkClip(raw) {
  if (!isObj(raw) || raw.v !== 1 || !isObj(raw.pivot) || !finite(raw.pivot.x) || !finite(raw.pivot.z)) return null;
  const clip = { v: 1, pivot: { x: qPos(raw.pivot.x), z: qPos(raw.pivot.z) }, objects: [], spawns: [], chests: [], npcs: [] };
  let n = 0;
  try {
    for (const kind of CLIP_KINDS) {
      const list = COLLECTION[kind], items = raw[list];
      if (!Array.isArray(items) || items.length > LIMITS[list]) return null;
      for (const item of items) clip[list].push(encodeItem(kind, decodeItem(kind, item)));
      n += items.length;
    }
  } catch { return null; }   // a MapError of decodeItem: this is not a clip of ours
  return n ? clip : null;
}

// How many items a clip holds.
export function clipSize(clip) {
  return clip ? clip.objects.length + clip.spawns.length + clip.chests.length + clip.npcs.length : 0;
}

// -> Clip of `items` (any iterable of map items): objects, spawns, chests and NPCs in the order given; regions, the
// start point and anything that is not in the map are skipped. The pivot is the centre of the ground bounding box of
// the origins - the pivot of the selection.
export function makeClip(ctx, items) {
  const clip = { v: 1, pivot: { x: 0, z: 0 }, objects: [], spawns: [], chests: [], npcs: [] };
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const item of items ?? []) {
    const kind = ctx.store.kindOf(item);
    if (!CLIP_KINDS.includes(kind)) continue;
    clip[COLLECTION[kind]].push(encodeItem(kind, item));
    minX = Math.min(minX, item.x); maxX = Math.max(maxX, item.x);
    minZ = Math.min(minZ, item.z); maxZ = Math.max(maxZ, item.z);
  }
  if (minX <= maxX) clip.pivot = { x: qPos((minX + maxX) / 2), z: qPos((minZ + maxZ) / 2) };
  return clip;
}

let memory = null;          // the last clip this tab copied: what Paste uses when the browser keeps nothing
let memoryOnly = false;     // ... and it did not reach localStorage, so storage holds something older
let seen = { text: null, clip: null };   // the stored text is checked once, not on every read

// -> the Clip to paste, or null: nothing was copied, or what the storage holds is not a clip.
// The result is shared: read it, never change it.
export function readClip() {
  if (memoryOnly) return memory;
  const text = load(CLIP_KEY);
  if (text === null) return memory;   // no storage, or it was emptied: this tab still remembers its own copy
  if (text !== seen.text) {
    let clip = null;
    try { clip = checkClip(JSON.parse(text)); } catch { clip = null; }
    seen = { text, clip };
  }
  return seen.clip;
}

// Makes `clip` the clipboard. -> true when it also reached localStorage (other tabs, the next reload); false when it
// lives in this tab only. Throws a TypeError for anything that is not a clip with at least one item.
export function writeClip(clip) {
  const clean = checkClip(clip);
  if (!clean) throw new TypeError('writeClip: not a clip (or an empty one)');
  const text = JSON.stringify(clean);
  memory = clean;
  memoryOnly = !save(CLIP_KEY, text);
  if (!memoryOnly) seen = { text, clip: clean };
  emit('clip');
  return !memoryOnly;
}

// New runtime items from a clip, moved so that its pivot is at (x, z) and turned by `rot` about it (objects, chests and
// NPCs turn with it; a spawn only moves). Without x / z the items stay where they were copied.
// Items whose layer is hidden or locked (ctx.ui.layers) are left out and counted in `skipped`.
// Every distinct group of the clip becomes a new group: ONE call of ctx.store.newGroupIds per instantiate.
// -> { objects, spawns, chests, npcs, skipped }: items that are not in the map yet (add them with cmd.add)
export function instantiate(ctx, clip, { x = clip.pivot.x, z = clip.pivot.z, rot = 0 } = {}) {
  const out = { objects: [], spawns: [], chests: [], npcs: [], skipped: 0 };
  const cos = Math.cos(rot), sin = Math.sin(rot), px = clip.pivot.x, pz = clip.pivot.z, groups = new Map();
  for (const kind of CLIP_KINDS) {
    const list = COLLECTION[kind], layer = ctx.ui.layers?.[LAYER_OF[kind]];
    if (layer && (layer.visible === false || layer.locked)) {
      out.skipped += clip[list].length;
      continue;
    }
    for (const raw of clip[list]) {
      const item = decodeItem(kind, raw), dx = item.x - px, dz = item.z - pz;
      // the turn of the map: local (lx, lz) -> (lx cos + lz sin, -lx sin + lz cos), the same as an object's ry
      item.x = x + dx * cos + dz * sin;
      item.z = z - dx * sin + dz * cos;
      if (kind !== 'spawn') item.ry += rot;
      quantizeItem(kind, item);
      if (typeof item.g === 'string') {
        if (!groups.has(item.g)) groups.set(item.g, []);
        groups.get(item.g).push(item);
      }
      out[list].push(item);
    }
  }
  if (groups.size) {
    const ids = ctx.store.newGroupIds(groups.size);
    let i = 0;
    for (const members of groups.values()) {
      for (const item of members) item.g = ids[i];   // the item is not in the map yet: this is building it, not editing it
      i++;
    }
  }
  return out;
}

// ---------------------------------------------------------------- stamps

// -> the name as it is kept (trimmed), or null when it is no stamp name: empty, longer than 48, or with a control character.
export function stampName(text) {
  if (typeof text !== 'string') return null;
  const name = text.trim();
  return name.length >= 1 && name.length <= STAMP_NAME_MAX && !CONTROL.test(name) ? name : null;
}

let stampsSeen = { text: undefined, list: [] };

// What the storage holds, checked: stamps with a bad name, a bad clip or a name used twice are dropped.
function readStamps() {
  const text = load(STAMPS_KEY);
  if (text === stampsSeen.text) return stampsSeen.list;
  const list = [], names = new Set();
  try {
    const raw = text === null ? null : JSON.parse(text);
    if (isObj(raw) && raw.v === 1 && Array.isArray(raw.stamps)) {
      for (const entry of raw.stamps.slice(0, MAX_STAMPS)) {
        const name = stampName(entry?.name), clip = name !== null && !names.has(name) ? checkClip(entry.clip) : null;
        if (!clip) continue;
        names.add(name);
        list.push({ name, clip });
      }
    }
  } catch { /* not JSON: no stamps */ }
  stampsSeen = { text, list };
  return list;
}

// One stamp per line: a set that is kept in a repository shows what changed.
function stampsText(list) {
  return list.length ? `{"v":1,"stamps":[\n${list.map((s) => JSON.stringify(s)).join(',\n')}\n]}` : '{"v":1,"stamps":[]}';
}

function writeStamps(list) {
  const text = stampsText(list);
  if (!save(STAMPS_KEY, text)) throw new Error('The browser storage is full or disabled: the stamps were not saved.');
  stampsSeen = { text, list };
  emit('stamps');
}

// -> [{ name, clip }] in the order they were saved. The clips are shared: read them, never change them.
export function listStamps() {
  return readStamps().slice();
}

export function getStamp(name) {
  return readStamps().find((s) => s.name === name) ?? null;
}

// Keeps `clip` under `name`; a stamp of that name is replaced where it stands. Throws when the name or the clip is not
// one, when there are 200 stamps already, or when the storage does not take it.
export function saveStamp(name, clip) {
  const key = stampName(name), clean = checkClip(clip);
  if (key === null) throw new TypeError(`A stamp name is 1 to ${STAMP_NAME_MAX} characters.`);
  if (!clean) throw new TypeError('Nothing to save: a stamp holds objects, spawns, chests or NPCs.');
  const list = readStamps().slice(), i = list.findIndex((s) => s.name === key);
  if (i >= 0) list[i] = { name: key, clip: clean };
  else if (list.length >= MAX_STAMPS) throw new RangeError(`There are ${MAX_STAMPS} stamps already: delete one first.`);
  else list.push({ name: key, clip: clean });
  writeStamps(list);
}

// -> whether there was a stamp of that name
export function deleteStamp(name) {
  const list = readStamps(), next = list.filter((s) => s.name !== name);
  if (next.length === list.length) return false;
  writeStamps(next);
  return true;
}

// -> whether the stamp was renamed. Throws when `to` is no stamp name or belongs to another stamp.
export function renameStamp(from, to) {
  const key = stampName(to), list = readStamps().slice(), i = list.findIndex((s) => s.name === from);
  if (key === null) throw new TypeError(`A stamp name is 1 to ${STAMP_NAME_MAX} characters.`);
  if (i < 0) return false;
  if (key === from) return true;
  if (list.some((s) => s.name === key)) throw new RangeError(`There is a stamp called "${key}" already.`);
  list[i] = { name: key, clip: list[i].clip };
  writeStamps(list);
  return true;
}

// -> the whole set as the text of a JSON file: { v: 1, stamps: [{ name, clip }] }, the form the storage keeps.
export function exportStamps() {
  return `${stampsText(readStamps())}\n`;
}

// Adds the stamps of a file that exportStamps wrote. A stamp that is here already, name and content, is left alone;
// one whose name is taken by another stamp comes in as "name (2)". -> the number of stamps added.
// Throws a SyntaxError for text that is not JSON, a TypeError for JSON that is not a stamp file.
export function importStamps(text) {
  const raw = JSON.parse(text);
  if (!isObj(raw) || raw.v !== 1 || !Array.isArray(raw.stamps)) throw new TypeError('Not a stamp file.');
  const list = readStamps().slice(), byName = new Map(list.map((s) => [s.name, JSON.stringify(s.clip)]));
  let added = 0;
  for (const entry of raw.stamps) {
    if (list.length >= MAX_STAMPS) break;
    const base = stampName(entry?.name), clip = base === null ? null : checkClip(entry.clip);
    if (!clip) continue;
    const content = JSON.stringify(clip);
    if (byName.get(base) === content) continue;
    let name = base;
    for (let k = 2; byName.has(name); k++) {
      const tail = ` (${k})`;
      name = base.slice(0, STAMP_NAME_MAX - tail.length) + tail;
    }
    byName.set(name, content);
    list.push({ name, clip });
    added++;
  }
  if (added) writeStamps(list);
  return added;
}

// ---------------------------------------------------------------- other tabs

// A copy made in another editor tab is the newest clipboard, also when this tab could not store its own; and whoever
// shows the clipboard or the stamps (the palette) is told.
if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('storage', (ev) => {
    if (ev.key === CLIP_KEY || ev.key === null) {
      memoryOnly = false;
      emit('clip');
    }
    if (ev.key === STAMPS_KEY || ev.key === null) emit('stamps');
  });
}
