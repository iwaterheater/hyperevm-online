// `ui`: the editor's own state - everything that is neither part of the map nor undoable. The active tool, layer
// visibility and locks, overlay toggles, snapping, what the palette has armed, the cursor, the status text.
// Pure: no DOM, no three. What needs a page - toasts, dialogs, picking a ground point, the canvas cursor - is injected
// by the boot code with ui.attach({ toast, confirm, ... }), so the store and the commands are testable in plain Node.
//
// Values are replaced, never mutated in place: ui.set('snap', { ...ui.snap, on: true }). A listener can therefore keep
// the previous value and compare.
import { GROUND_INDEX, LAYERS, LAYER_OF } from '../map/format.js';

export const STORAGE_KEY = 'hypercat-editor-ui';
export const SNAP_STEPS = [0.25, 0.5, 1, 2];        // world units; 2 is one ground cell of today's map

const PERSISTED = ['layers', 'overlays', 'snap', 'collapsed'];
const RENDERERS = ['toast', 'confirm', 'choose', 'prompt', 'pickPoint', 'setCursor'];
const FLAGS = ['hidden', 'locked'];
const PENDING_TOASTS = 20;     // toasts raised before a renderer is attached are kept, so a boot message is not lost
const MAX_SECTIONS = 64;       // collapsed section ids read back from storage: more than this is not ours

// A list of listeners per event. Both `ui` and the store are built on it.
// One listener that throws must not keep the others from hearing the event: six owners subscribe side by side, and the
// viewport has to follow a change even when a half-written panel chokes on it. The error is logged once per listener.
export function createEmitter() {
  const lists = new Map(), reported = new WeakSet();
  return {
    on(event, fn) {
      if (typeof fn !== 'function') throw new TypeError(`on('${event}'): the listener must be a function`);
      // the list is replaced, not changed: an emit in progress keeps walking the list it started with
      lists.set(event, [...(lists.get(event) ?? []), fn]);
      return () => {
        const list = lists.get(event), i = list ? list.indexOf(fn) : -1;
        if (i >= 0) lists.set(event, [...list.slice(0, i), ...list.slice(i + 1)]);
      };
    },
    emit(event, ...args) {
      const list = lists.get(event);
      if (!list) return;
      for (const fn of list) {
        try { fn(...args); } catch (e) {
          if (reported.has(fn)) continue;
          reported.add(fn);
          console.error(`[editor] a '${event}' listener failed`, e);
        }
      }
    },
  };
}

const defaultLayers = () => Object.fromEntries(LAYERS.map((layer) => [layer, { visible: true, locked: false }]));
// regiontint is the one overlay module (its id is its key); the other keys switch visuals of the viewport and the markers
const defaultOverlays = () => ({ grid: true, boundary: true, regiontint: false, colliders: false, threat: false, labels: true, levelColors: false });
const defaultSnap = () => ({ on: false, step: 1, angle: Math.PI / 12 });

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

// localStorage where there is one. Node has none, a browser may refuse it (private mode, a blocked origin).
function browserStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

// What is stored under STORAGE_KEY, or {} - the storage may be disabled, full of somebody else's data or of an old version.
function readStored(storage) {
  if (!storage) return {};
  try {
    const raw = JSON.parse(storage.getItem(STORAGE_KEY));
    return isObj(raw) ? raw : {};
  } catch { return {}; }
}

// The persisted keys, each value checked field by field: anything unexpected falls back to its default.
function restore(stored) {
  const layers = defaultLayers(), overlays = defaultOverlays(), snap = defaultSnap(), collapsed = {};
  if (isObj(stored.layers)) {
    for (const layer of LAYERS) {
      const v = stored.layers[layer];
      if (!isObj(v)) continue;
      if (typeof v.visible === 'boolean') layers[layer].visible = v.visible;
      if (typeof v.locked === 'boolean') layers[layer].locked = v.locked;
    }
  }
  if (isObj(stored.overlays)) {
    for (const key of Object.keys(overlays)) if (typeof stored.overlays[key] === 'boolean') overlays[key] = stored.overlays[key];
  }
  if (isObj(stored.snap)) {
    const v = stored.snap;
    if (typeof v.on === 'boolean') snap.on = v.on;
    if (SNAP_STEPS.includes(v.step)) snap.step = v.step;
    if (typeof v.angle === 'number' && v.angle > 0 && v.angle <= Math.PI) snap.angle = v.angle;
  }
  if (isObj(stored.collapsed)) {
    for (const id of Object.keys(stored.collapsed).slice(0, MAX_SECTIONS)) if (stored.collapsed[id] === true && id.length <= 64) collapsed[id] = true;
  }
  return { layers, overlays, snap, collapsed };
}

// storage: where layers, overlays, snap and the collapsed sections persist - anything with getItem / setItem.
// Default: the browser's localStorage when there is one. Pass null to keep nothing (tests).
export function createUi({ storage = browserStorage() } = {}) {
  const events = createEmitter();
  const flags = { hidden: new WeakSet(), locked: new WeakSet() };
  const renderers = {}, pendingToasts = [];
  const kept = restore(readStored(storage));

  // Our keys are merged into what is stored, so a key some other module keeps under the same name survives.
  const persist = () => {
    if (!storage) return;
    try {
      const next = { ...readStored(storage), v: 1 };
      for (const key of PERSISTED) next[key] = ui[key];
      storage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch { /* full or disabled: the editor works without remembering */ }
  };

  // A dialog nobody can answer is a dialog that was cancelled.
  const ask = (name, cancelled, args) => {
    if (!renderers[name]) return Promise.resolve(cancelled);
    try { return Promise.resolve(renderers[name](...args)); } catch (e) { return Promise.reject(e); }
  };

  const ui = {
    tool: null,                      // id of the active tool; null until the boot code picks Select
    prevTool: 'select',              // the tool to return to (paste, Esc)
    layers: kept.layers,             // { [layer in LAYERS]: { visible, locked } }
    overlays: kept.overlays,
    hiddenModels: new Set(),         // model ids hidden with the per-model eye of the Layers panel; not persisted
    snap: kept.snap,                 // { on, step: one of SNAP_STEPS, angle: radians }
    axes: 'world',                   // 'world' | 'local'
    models: [],                      // model ids selected in the palette; models[0] is what Place uses
    groundType: GROUND_INDEX.dirt,   // index into GROUND_TYPES used by Terrain. Not grass: a new map is all grass, and a first stroke should show
    cursor: null,                    // Hit | null - written by the viewport only
    preview: 'neutral',              // 'neutral' | 'game' | MoodKey
    readOnly: false,
    issues: { errors: 0, warnings: 0 },
    status: '',                      // the standing line of the status bar: the instruction of a tool, a progress
    note: '',                        // what has just happened ("Deleted 3 objects"); see setNote
    collapsed: kept.collapsed,       // { [section id]: true } for every collapsed section of the right column

    // Assigns and emits `key`: listeners get (value, previous). Always emits, also for an equal value: setting the active
    // tool again re-arms it.
    set(key, value) {
      if (typeof key !== 'string' || key === '__proto__' || typeof ui[key] === 'function') {
        throw new TypeError(`ui.set: '${String(key)}' is not a state key`);
      }
      const previous = ui[key];
      if (key === 'tool' && previous != null && previous !== value) ui.prevTool = previous;
      ui[key] = value;
      if (PERSISTED.includes(key)) persist();
      events.emit(key, value, previous);
    },

    on(key, fn) {
      return events.on(key, fn);
    },

    // Per-item flags (regions only in v1). WeakSets: a flag dies with its item, e.g. when another map is loaded.
    itemFlag(item, flag) {
      return FLAGS.includes(flag) && flags[flag].has(item);
    },

    setItemFlag(item, flag, on) {
      if (!FLAGS.includes(flag)) throw new TypeError(`ui.setItemFlag: no such flag: ${flag}`);
      if (item === null || typeof item !== 'object') throw new TypeError('ui.setItemFlag: not an item');
      if (flags[flag].has(item) === !!on) return;
      if (on) flags[flag].add(item); else flags[flag].delete(item);
      events.emit('itemflags', { item, flag, on: !!on });
    },

    // The ONE test used by picking, box select, group expansion, erase and Select All.
    isPickable(kind, item) {
      const layer = ui.layers[LAYER_OF[kind]];
      if (!layer || !layer.visible || layer.locked) return false;
      if (flags.hidden.has(item) || flags.locked.has(item)) return false;
      return kind !== 'object' || !ui.hiddenModels.has(item.m);
    },

    // The renderers of everything that needs a page. May be called several times, each with some of them (the boot code
    // has the dialogs, the viewport has pickPoint and setCursor).
    attach(given) {
      for (const name of Object.keys(given ?? {})) {
        if (!RENDERERS.includes(name)) throw new TypeError(`ui.attach: unknown renderer '${name}' (known: ${RENDERERS.join(', ')})`);
        if (typeof given[name] !== 'function') throw new TypeError(`ui.attach: '${name}' must be a function`);
        renderers[name] = given[name];
      }
      if (renderers.toast) for (const [text, level] of pendingToasts.splice(0)) ui.toast(text, level);
      return ui;
    },

    // text: a string or { text, action: { label, run } }. level: 'info' | 'warn' | 'error'.
    // Never throws: a message about a failure must not become a second failure.
    toast(text, level = 'info') {
      if (!renderers.toast) {
        if (pendingToasts.length < PENDING_TOASTS) pendingToasts.push([text, level]);
        return;
      }
      try { renderers.toast(text, level); } catch (e) { console.error('[editor] toast failed', e); }
    },

    // danger: the OK button destroys something - it is drawn as such and Cancel has the focus, so Enter is harmless
    confirm(text, { ok = 'OK', cancel = 'Cancel', danger = false } = {}) {      // -> Promise<boolean>
      return ask('confirm', false, [text, { ok, cancel, danger: !!danger }]);
    },

    // options: [{ id, label, danger? }]. sticky: a click beside the dialog does not cancel it (Escape still does) -
    // for a question that a stray click must not wave away.
    choose(text, options, { sticky = false } = {}) {            // -> Promise<string | null>
      return ask('choose', null, [text, options, { sticky: !!sticky }]);
    },

    prompt(text, value = '') {                                  // -> Promise<string | null>
      return ask('prompt', null, [text, value]);
    },

    pickPoint(label) {                                          // -> Promise<{ x, z } | null>
      return ask('pickPoint', null, [label]);
    },

    setCursor(cssCursor) {
      if (!renderers.setCursor) return;
      try { renderers.setCursor(cssCursor); } catch (e) { console.error('[editor] setCursor failed', e); }
    },

    setStatus(text) {
      ui.set('status', text);
    },

    // A line about something that has JUST HAPPENED: "Deleted 3 objects", "Camp added ...". The status bar shows it in
    // place of the status text and takes it away again - with the next edit, the next change of the selection, a tool
    // switch, or after a few seconds - so it never stands there when it is no longer true. ui.status is not touched:
    // the instruction of the active tool is back when the note has gone. (setStatus is for what stays true: a tool's
    // instruction, a progress.)
    setNote(text) {
      ui.set('note', text == null ? '' : String(text));
    },
  };
  return ui;
}
