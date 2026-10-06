// The store: the map being edited, the selection, and undo / redo.
// Pure - no DOM, no three - and it knows nothing about layers, tools or the view: those listen to its four events.
//
//   'change'     a command changed the map; the listener gets a Change (below) that says exactly what
//   'selection'  the selection is another set of items now
//   'history'    canUndo / canRedo / dirty / grouping may have changed
//   'load'       store.map is another map object: forget every item of the old one
//
// The map is written by commands only (commands.js). A command is { label, bytes, do(map) -> Change, undo(map) -> Change,
// merge?(next) -> boolean }; the store runs it, keeps it for undo and tells everybody what it did.
import { COLLECTION } from '../map/format.js';
import { createEmitter } from './state.js';

const LISTS = ['objects', 'spawns', 'chests', 'npcs', 'regions'];
const KIND_OF_LIST = { objects: 'object', spawns: 'spawn', chests: 'chest', npcs: 'npc', regions: 'region' };
const GROUPED = ['objects', 'spawns', 'chests', 'npcs'];                   // the lists whose items can carry a group id `g`
const KIND_ORDER = ['object', 'spawn', 'chest', 'npc', 'region', 'start']; // "map order" across kinds
const EVENTS = ['change', 'selection', 'history', 'load'];
const STEP_BYTES = 256;                 // what an undo step costs besides its commands, so that tiny steps are bounded too
const GROUP_ID = /^g([1-9]\d*)$/;       // the ids newGroupIds() hands out: g1, g2, ...

// What a command did to the map. Every key is always present, so a listener never has to test for one.
//   added / removed / updated   item references per list; updated.start is [] or [map.start]
//   order    lists whose order changed ('regions')
//   ground   null, or { ix0, iz0, ix1, iz1 }: the INCLUSIVE vertex rectangle that was repainted
//   props    changed top-level keys: 'name' | 'radius' | 'foliage' | 'fallback' | 'ground' (the ground OBJECT was replaced)
//   origin   'do' | 'undo' | 'redo' | 'cancel' - set by the store
export function emptyChange(origin = 'do') {
  return {
    added: { objects: [], spawns: [], chests: [], npcs: [], regions: [] },
    removed: { objects: [], spawns: [], chests: [], npcs: [], regions: [] },
    updated: { objects: [], spawns: [], chests: [], npcs: [], regions: [], start: [] },
    order: [],
    ground: null,
    props: [],
    origin,
  };
}

// True when the command left the map exactly as it was.
export function isEmptyChange(change) {
  for (const list of LISTS) {
    if (change.added[list].length || change.removed[list].length || change.updated[list].length) return false;
  }
  return !change.updated.start.length && !change.order.length && !change.props.length && change.ground === null;
}

// The Change of a command with every key in place and the origin the store gives it. The commands of commands.js return
// complete ones; this only repairs what a hand-written command (a test's) left out.
const PARTS = { added: LISTS, removed: LISTS, updated: [...LISTS, 'start'] };
function complete(raw, origin) {
  if (raw === null || typeof raw !== 'object') return emptyChange(origin);
  for (const part of Object.keys(PARTS)) {
    if (raw[part] === null || typeof raw[part] !== 'object') raw[part] = {};
    for (const list of PARTS[part]) if (!Array.isArray(raw[part][list])) raw[part][list] = [];
  }
  if (!Array.isArray(raw.order)) raw.order = [];
  if (!Array.isArray(raw.props)) raw.props = [];
  if (raw.ground === undefined) raw.ground = null;
  raw.origin = origin;
  return raw;
}

const sameSet = (a, b) => {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
};

// one item, an array, a Set - or nothing
const toList = (items) => (items == null ? [] : typeof items[Symbol.iterator] === 'function' ? [...items] : [items]);

// maxUndoBytes: the budget of the undo history, measured in the `bytes` of its commands. The oldest steps go first.
export function createStore({ maxUndoBytes = 64e6 } = {}) {
  const events = createEmitter();
  let map = null;
  let selection = new Set();       // replaced on every change, never mutated: a reference a caller kept stays a snapshot
  let kinds = new WeakMap();       // item -> kind, for exactly the items that are in the map
  let undoStack = [], redoStack = [], undoBytes = 0;
  let group = null;                // { label, commands, selection } while begin() ... commit() / cancel() is open
  let replaying = false;           // undo / redo / cancel in progress: the map is between two steps
  // The undo position is the id of the step on top of the undo stack, or baseId under an empty one. Ids are never
  // reused, so "saved" stays a position that an undo can come back to and that a new command after an undo leaves for good.
  let stepIds = 0, baseId = 0, savedId = 0, loadedDirty = false;

  const position = () => (undoStack.length ? undoStack[undoStack.length - 1].id : baseId);
  const busy = (what) => { if (replaying) throw new Error(`store.${what}: not possible from a 'change' listener during undo, redo or cancel`); };
  const needMap = (what) => { if (!map) throw new Error(`store.${what}: no map is loaded`); };

  // Takes a command's Change in: completes it, follows which items are in the map, and drops removed items from the
  // selection - all BEFORE the 'change' event, so a listener sees a store that agrees with the map.
  function settle(raw, origin) {
    const change = complete(raw, origin);
    let gone = null;
    for (const list of LISTS) {
      for (const item of change.removed[list]) {
        kinds.delete(item);
        if (selection.has(item)) (gone ??= []).push(item);
      }
    }
    for (const list of LISTS) for (const item of change.added[list]) kinds.set(item, KIND_OF_LIST[list]);
    if (gone) {
      const next = new Set(selection);
      for (const item of gone) if (!kinds.has(item)) next.delete(item);
      if (next.size !== selection.size) selection = next;
    }
    return change;
  }

  // 'selection' is emitted only when the set is another set than `before`.
  const announce = (before) => { if (selection !== before && !sameSet(selection, before)) events.emit('selection'); };

  // found: the selection the step was made with (a Set that is never mutated: keeping the reference costs nothing).
  function push(label, commands, found) {
    let bytes = STEP_BYTES;
    for (const c of commands) bytes += Number.isFinite(c.bytes) ? c.bytes : 0;
    undoStack.push({ id: ++stepIds, label, commands, bytes, selection: found });
    undoBytes += bytes;
    redoStack = [];
    // the newest step always stays, however large: the last edit can always be undone
    while (undoBytes > maxUndoBytes && undoStack.length > 1) {
      const oldest = undoStack.shift();
      undoBytes -= oldest.bytes;
      baseId = oldest.id;        // the state under the stack is now the state after that step
    }
  }

  // A group that ended where it started - a drag out and back, a field typed in and put back - is like a command that
  // changed nothing: as a step it would undo nothing, mark an unchanged map dirty and cost what could be redone.
  // Only what is certain counts: EVERY command of the group says so itself (command.unchanged, optional); each then
  // holds what it found, so nothing any of them wrote differs from before the group.
  function reverted(commands) {
    try {
      return commands.every((c) => typeof c.unchanged === 'function' && c.unchanged(map) === true);
    } catch {
      return false;      // a command that cannot tell is a command that changed something
    }
  }

  // Runs one step backwards (undo) or forwards (redo): one 'change' per command, then the selection rule of the editor -
  // the selection becomes what the step touched and still exists; a step that touched no item leaves it alone.
  // "Touched" is what the step was applied to, which can be more than what it changed: Align on three objects moves
  // two of them (the third stood there already), and undoing it must give the three back, or the next button works on
  // two. A command only knows what it changed - so when everything the step changed was part of the selection the step
  // was made with, it was an edit OF that selection, and the whole of it comes back.
  function replay(step, back) {
    const before = selection, touched = new Set();
    const commands = back ? step.commands.slice().reverse() : step.commands;
    replaying = true;
    try {
      for (const c of commands) {
        const change = settle(back ? c.undo(map) : c.do(map), back ? 'undo' : 'redo');
        for (const part of [change.added, change.removed, change.updated]) {
          for (const list of Object.keys(part)) for (const item of part[list]) touched.add(item);
        }
        if (!isEmptyChange(change)) events.emit('change', change);
      }
    } finally { replaying = false; }
    if (touched.size) {
      let whole = step.selection ?? null;
      if (whole) for (const item of touched) if (!whole.has(item)) { whole = null; break; }
      const next = new Set();
      for (const item of whole ?? touched) if (kinds.has(item)) next.add(item);
      selection = next;
    }
    announce(before);
  }

  const store = {
    get map() { return map; },                    // null until the first load
    get selection() { return selection; },        // Set<item>; treat it as read-only
    get dirty() { return loadedDirty || position() !== savedId; },
    get canUndo() { return undoStack.length > 0 && !group; },
    get canRedo() { return redoStack.length > 0 && !group; },
    get grouping() { return group !== null; },
    get undoLabel() { return undoStack.length ? undoStack[undoStack.length - 1].label : null; },
    get redoLabel() { return redoStack.length ? redoStack[redoStack.length - 1].label : null; },
    get maxUndoBytes() { return maxUndoBytes; },

    // -> Kind | null: O(1); null for anything that is not in the map (a removed item, a clone not added yet, the fallback)
    kindOf(item) {
      return kinds.get(item) ?? null;
    },

    // -> the map's own list for that kind (do not change it), or [map.start]
    items(kind) {
      if (!map) return [];
      if (kind === 'start') return [map.start];
      return Object.hasOwn(COLLECTION, kind) ? map[COLLECTION[kind]] : [];
    },

    // -> index in its list (O(n)); 0 for the start; -1 when the item is not in the map
    indexOf(item) {
      const kind = kinds.get(item);
      if (!kind) return -1;
      return kind === 'start' ? 0 : map[COLLECTION[kind]].indexOf(item);
    },

    // Replaces the selection; `add` extends it, `toggle` flips each given item. Items that are not in the map are ignored.
    // -> whether the selection changed
    select(items, { add = false, toggle = false } = {}) {
      const list = [...new Set(toList(items))].filter((item) => kinds.has(item));
      let next;
      if (toggle) {
        next = new Set(selection);
        for (const item of list) if (!next.delete(item)) next.add(item);
      } else if (add) {
        next = new Set(selection);
        for (const item of list) next.add(item);
      } else next = new Set(list);
      if (sameSet(next, selection)) return false;
      selection = next;
      events.emit('selection');
      return true;
    },

    clearSelection() {
      return store.select([]);
    },

    // -> the selected items, optionally of one kind, in map order (objects, spawns, chests, NPCs, regions, start)
    selected(kind = null) {
      const out = [];
      if (!map || !selection.size) return out;
      const count = {}, lone = {};
      for (const item of selection) {
        const k = kinds.get(item);
        if (!k || (kind !== null && k !== kind)) continue;
        count[k] = (count[k] || 0) + 1;
        lone[k] = item;
      }
      for (const k of KIND_ORDER) {
        if (!count[k]) continue;
        if (count[k] === 1) { out.push(lone[k]); continue; }       // no need to walk 6,000 objects for one of them
        let left = count[k];
        for (const item of map[COLLECTION[k]]) {
          if (!selection.has(item)) continue;
          out.push(item);
          if (--left === 0) break;
        }
      }
      return out;
    },

    // -> the items plus every other member of their groups, in one pass over the map. It knows no layers: the caller
    // keeps what ui.isPickable allows.
    expandGroups(items) {
      const list = [...new Set(toList(items))];
      if (!map) return list;
      const groups = new Set();
      for (const item of list) if (typeof item?.g === 'string') groups.add(item.g);      // regions and the start have no g
      if (!groups.size) return list;
      const seen = new Set(list);
      for (const key of GROUPED) {
        for (const item of map[key]) {
          if (typeof item.g !== 'string' || !groups.has(item.g) || seen.has(item)) continue;
          seen.add(item);
          list.push(item);
        }
      }
      return list;
    },

    // -> n distinct ids 'g<k>' (k >= 1) that no item uses, smallest first. Stateless: two calls before the items are
    // added return the same ids, so ask once for all the ids one operation needs.
    newGroupIds(n) {
      if (!Number.isInteger(n) || n < 0) throw new RangeError('store.newGroupIds: expected a count');
      const used = new Set();
      if (map) {
        for (const key of GROUPED) {
          for (const item of map[key]) {
            const m = typeof item.g === 'string' ? GROUP_ID.exec(item.g) : null;
            if (m) used.add(m[1]);
          }
        }
      }
      const out = [];
      for (let k = 1; out.length < n; k++) if (!used.has(String(k))) out.push(`g${k}`);
      return out;
    },

    // Runs a command. Outside a group it is one undo step. Inside a group it is first offered to the group's previous
    // command (prev.merge(command)): a drag is thousands of commands and must stay one small step.
    // A command that changes nothing leaves no trace: no step, no event, and what could be redone stays.
    // -> the Change
    exec(command) {
      busy('exec');
      needMap('exec');
      if (!command || typeof command.do !== 'function' || typeof command.undo !== 'function') throw new TypeError('store.exec: not a command');
      const before = selection;
      if (group) {
        const prev = group.commands[group.commands.length - 1];
        const merged = prev !== undefined && typeof prev.merge === 'function' && prev.merge(command) === true;
        const change = settle(command.do(map), 'do');
        if (isEmptyChange(change)) return change;
        if (!merged) group.commands.push(command);
        events.emit('change', change);
        announce(before);
        return change;
      }
      const change = settle(command.do(map), 'do');
      if (isEmptyChange(change)) return change;
      push(command.label, [command], before);
      events.emit('change', change);
      announce(before);
      events.emit('history');
      return change;
    },

    // Opens a group: every exec until commit() belongs to ONE undo step with this label.
    begin(label) {
      busy('begin');
      needMap('begin');
      if (group) throw new Error(`store.begin('${label}'): the group '${group.label}' is still open`);
      group = { label, commands: [], selection };
      events.emit('history');
    },

    // Closes the group as one undo step - nothing when no command of it changed the map, and nothing when its commands
    // have put everything back (reverted, above). Without an open group it does nothing (a field that was focused and
    // left untouched commits on blur). -> whether a step was pushed
    commit() {
      busy('commit');
      if (!group) return false;
      const { label, commands, selection: found } = group;
      group = null;
      const kept = commands.length > 0 && !reverted(commands);
      if (kept) push(label ?? commands[0].label, commands, found);
      events.emit('history');
      return kept;
    },

    // Undoes the group's commands in reverse order and puts the selection back as begin() found it.
    // -> whether a group was open
    cancel() {
      busy('cancel');
      if (!group) return false;
      const { commands, selection: saved } = group, before = selection;
      replaying = true;
      try {
        for (let i = commands.length - 1; i >= 0; i--) {
          const change = settle(commands[i].undo(map), 'cancel');
          if (!isEmptyChange(change)) events.emit('change', change);
        }
      } finally {
        replaying = false;
        group = null;
      }
      const restored = new Set();
      for (const item of saved) if (kinds.has(item)) restored.add(item);
      selection = restored;
      announce(before);
      events.emit('history');
      return true;
    },

    // -> the label of the step that was undone / redone, or null (nothing to undo, or a group is open)
    undo() {
      if (!map || group || replaying || !undoStack.length) return null;
      const step = undoStack.pop();
      undoBytes -= step.bytes;
      replay(step, true);
      redoStack.push(step);
      events.emit('history');
      return step.label;
    },

    redo() {
      if (!map || group || replaying || !redoStack.length) return null;
      const step = redoStack.pop();
      replay(step, false);
      undoStack.push(step);
      undoBytes += step.bytes;
      events.emit('history');
      return step.label;
    },

    // The map as it is now is what the server has.
    markSaved() {
      savedId = position();
      loadedDirty = false;
      events.emit('history');
    },

    // Replaces the map (boot, Revert, Import, a restored draft): the selection and the history belong to the old one.
    // dirty: the new map is not what the server has (an import, a draft).
    load(next, { dirty = false } = {}) {
      busy('load');
      // ground.cells is what tells the runtime form from a parsed file, which has the same keys
      if (next === null || typeof next !== 'object' || !LISTS.every((list) => Array.isArray(next[list])) || !next.start
        || !next.ground || !(next.ground.cells instanceof Uint8Array)) {
        throw new TypeError('store.load: not a map in runtime form (see normalize)');
      }
      map = next;
      kinds = new WeakMap();
      for (const list of LISTS) for (const item of map[list]) kinds.set(item, KIND_OF_LIST[list]);
      kinds.set(map.start, 'start');
      selection = new Set();
      undoStack = [];
      redoStack = [];
      undoBytes = 0;
      group = null;
      baseId = savedId = ++stepIds;
      loadedDirty = !!dirty;
      events.emit('load');
      events.emit('selection');
      events.emit('history');
    },

    // -> unsubscribe. 'change' listeners get the Change; the other three events carry nothing.
    on(event, fn) {
      if (!EVENTS.includes(event)) throw new TypeError(`store.on: no such event: ${event} (known: ${EVENTS.join(', ')})`);
      return events.on(event, fn);
    },
  };
  return store;
}
