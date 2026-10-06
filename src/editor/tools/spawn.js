// The Spawn tool: monster camps - where they are, how wide, and what lives in them.
//
//   click on free ground          a new camp with the settings of the options strip (the template)
//   press and drag on free ground a new camp from its centre out to its radius - one undo step
//   click a pin, a rim, a label   select that camp (Shift / Mod: add or take it); its group mates of the same kind come along
//   double-click                  that one camp alone
//   drag from there               move the selection               Alt+drag: move a copy
//   drag the rim of a selected camp   resize it                    drag inside its disc: move it
//   Alt+click a camp              copy its settings into the template (the eyedropper)
//   [ ]  arrows  Q E              scale / nudge / turn the selection; with nothing selected [ ] change the template's radius
//
// A marker tool PICKS only its own kind (tool = filter), but what is selected is edited as a whole, as everywhere in
// the editor: the keys, a drag that starts on a selected item, Delete, the inspector and Arrange all act on the same
// items - also on a tree or a chest that a panel, Select All or the tool before this one put into the selection.
//
// The disc of a camp that is NOT selected is never a pick: camps cover most of a zone, and a press inside one must be
// able to start the next camp. What the cursor is over is decided by the viewport (hit.item / hit.handle).
//
// The template is `tool.opts` - { types, lvl, count, r, respawn, follow } - a plain object read at every use. While
// `follow` is on it copies the last camp placed or selected, so "one more like that one" is a single click.
//
// This file also holds what the four marker tools share (Spawn, Chest, NPC, Start point): markerTool() - the gestures -
// and templateState() - a template that follows the selection. tools/chest.js, npc.js and start.js import them.
import { MOB_KEYS, MOB_TYPES } from '../../shared.js';
import { LIMITS, inShape, isBlocked, groundAt, qPos } from '../../map/format.js';
import { h, row, button, numberField, selectField, checkField } from '../ui/dom.js';
import { mod, keyText } from '../keymap.js';
import { typesPatch } from '../fields.js';
import { dragTracker, dragMove, dragRadius, placeOnce, selectionKey, snapPoint, snapping, editable, expandPickable, describe } from './common.js';
import { addClones } from './select.js';
import { SPAWN_PRESETS, campColor, campText, cleanTemplate, sameTemplate, shortName, templateOf, threatOf, typeKeys } from '../spawnstats.js';

const NOUN = { spawn: 'spawn', chest: 'chest', npc: 'NPC', start: 'start point' };
const hex = (color) => `#${color.toString(16).padStart(6, '0')}`;
const num = (v) => String(Number(v.toFixed(2)));
// The step of a turn key: 15 degrees, 90 with Shift, 1 with Alt - as for the selection.
export const turnStep = (ev) => (ev?.shiftKey ? 90 : ev?.altKey ? 1 : 15) * Math.PI / 180;

// ---------------------------------------------------------------- a template that follows the selection

// The settings the next new item of `kind` copies. -> { opts, set(patch), on(fn), adopt(item), fresh() }
//   opts     the live plain object: the template's own keys plus `follow`. Scripts may write it directly; the tool
//            reads it through fresh() at every use.
//   set      merges a patch, cleans the result (clean(opts) -> the template keys, every value legal) and tells the
//            listeners; `follow` is a key like the others. A change made by hand lets go of the item the template was
//            copied from.
//   adopt    copies an item of the map (read(item) -> the template keys) and keeps following its later edits
//   on       -> unsubscribe; fn() after every change
// While opts.follow is on, the template adopts the item of this kind that was selected last - placed, clicked,
// brought back by an undo - and re-reads it when it is edited.
// It copies what a step of the store LEAVES, never what a step passes through: a camp that a drag is creating starts
// with radius 0, and an undo or a cancelled drag walks back through every state the step had. So a selection that
// changes inside an open group is looked at when the group closes, and an item rewritten by an undo, a redo or a
// cancel is read again once that step is whole - when the item is still there. Esc on a half-drawn camp therefore
// leaves the template as it was, and undoing a new camp leaves it with that camp's settings.
export function templateState(ctx, kind, { defaults, read, clean }) {
  const { store } = ctx, listeners = new Set();
  const opts = { ...clean(defaults), follow: true };
  let source = null;         // the item the template was copied from last, while nobody has changed the template since
  let known = new Set();     // the selected items of this kind, to tell which one is new
  let unsettled = false;     // the selection changed inside an open group, or the source was rewritten by an undo
  let reread = false;        // ... the second of the two: the source has to be read again
  const tell = () => {
    for (const fn of [...listeners]) {
      try { fn(); } catch (err) { console.error(`[editor] a ${kind} template listener failed`, err); }
    }
  };
  const write = (values) => {
    const follow = opts.follow;
    Object.assign(opts, clean({ ...opts, ...values }));
    opts.follow = follow;
  };
  const state = {
    opts,
    fresh: () => clean(opts),
    set(patch = {}) {
      const { follow, ...values } = patch;
      if (Object.keys(values).length) { write(values); source = null; }
      if (follow !== undefined) opts.follow = !!follow;
      tell();
    },
    adopt(item) {
      write(read(item));
      source = item;
      tell();
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  // The selection as it is now against the one the template looked at last. Only called between two steps of the store.
  const look = () => {
    const again = reread;
    unsettled = reread = false;
    const now = store.selected(kind), added = now.filter((item) => !known.has(item));
    known = new Set(now);
    if (source && store.kindOf(source) !== kind) source = null;      // deleted, or its creation was undone
    if (!opts.follow) return;
    if (added.length) state.adopt(added[added.length - 1]);
    else if (again && source) state.adopt(source);
  };
  store.on('selection', () => {
    if (store.grouping) unsettled = true;
    else look();
  });
  store.on('change', (change) => {
    if (!source || !opts.follow || !change.updated?.[`${kind}s`]?.includes(source)) return;
    if (change.origin === 'do') state.adopt(source);      // edited: the strip shows it at once, also during a drag
    else unsettled = reread = true;                       // one command of an undo, a redo or a cancel: not a state to copy
  });
  store.on('history', () => { if (unsettled && !store.grouping) look(); });
  store.on('load', () => { source = null; known = new Set(); unsettled = reread = false; });      // the items of the old map are gone
  return state;
}

// The two controls every template strip ends with: "Follow selection" and "Apply to selection".
// -> { nodes, release() }. apply(items) is called with the selected items of the kind that may be edited.
export function templateControls(ctx, kind, state, apply) {
  const { store, ui } = ctx, noun = NOUN[kind];
  const follow = checkField({ value: state.opts.follow, onCommit: (on) => state.set({ follow: on }) });
  follow.el.title = `The settings follow the ${noun} you placed or selected last`;
  const targets = () => editable(ctx, store.selected(kind));
  const send = button('Apply to selection', () => {
    const items = targets();
    if (!items.length) return;
    if (store.grouping) { ui.toast('Finish the current edit first', 'warn'); return; }
    apply(items);
  }, { title: `Give these settings to every selected ${noun} (one undo step)` });
  const sync = () => {
    const n = targets().length;
    send.disabled = n === 0;
    send.textContent = n > 1 ? `Apply to ${n} selected` : 'Apply to selection';
    follow.set(state.opts.follow);
  };
  const subs = [store.on('selection', sync), ui.on('layers', sync), state.on(sync)];
  sync();
  const line = row('Follow', follow);
  line.title = follow.el.title;
  return { nodes: [line, send], release: () => { for (const off of subs) off(); } };
}

// ---------------------------------------------------------------- the gestures of a marker tool

// The tool object of a marker tool, from what makes it this tool:
//   id, label, icon, layer, kind
//   props()            -> the fields of a new item without its place, or leave it out when the tool creates nothing
//   fit(props)         -> props, adjusted to where it lands (optional; x and z are set). It is called for every ghost
//                      as well: it must keep nothing
//   canPlace(x, z)     -> null, or the reason why nothing may be put there
//   ghost(props)       -> what markers.setGhost shows under the cursor ({ spawns | chests | npcs }), or null
//   ring(props)        -> { r, color } of a ground ring drawn with the ghost (viewport.brush), or null
//   drag               what a press-drag on free ground does: 'radius' (centre -> radius), 'facing' (turn towards the
//                      pointer), 'follow' (the one existing item follows the pointer - the start point)
//   target()           -> the item a click on free ground moves ('follow' only)
//   adopt(item)        Alt+click: copy the item's settings
//   placed(item, how, asked)  after an item was created; how: 'click' | 'drag'; asked: what props() gave for it,
//                      before fit() - the template as it was at the press
//   idleKey(action, ev) -> boolean: a key the selection did not use (turn or resize the template)
//   hints              { intro, create, item, selected, handle }: status texts. `intro` is the instruction of the tool:
//                      it stands in the status bar from the moment the tool is chosen and whenever the cursor is over
//                      nothing more particular. Keys are named in the editor's words ('Alt+click'): keyText writes them
//   about              one line for the tooltip of the toolbar button
//   options(el, keep)  fills the options strip; keep(off) registers what deactivate() must release
//   activate(), deactivate()   optional extras
export function markerTool(ctx, spec) {
  const { store, ui, cmd } = ctx, { kind, layer } = spec, noun = NOUN[kind];

  // A press becomes one of these and stays it until the button is released:
  //   'press'   nothing decided yet (a click, or a drag below the threshold)
  //   'move'    the selection, or a copy of it, follows the pointer        'radius'  a rim handle is dragged
  //   'create'  a new item grows out of the press (its radius)             'face'    a new item turns towards the pointer
  //   'follow'  the start point follows the pointer
  //   'dead'    the gesture was cancelled or refused with the button still down: the rest of it is swallowed
  let mode = null;
  let press = null;        // { item, at, start, shift, toggle, alt, tracker, asked, props }
  let drag = null;         // what dragMove / dragRadius returned
  let made = null;         // the item a press-drag is creating
  let restore = null;      // the selection to put back when a copy-drag is cancelled
  let over = '';           // what the cursor is over: '' | 'create' | 'refused' | 'item' | 'selected' | 'handle'
  let last = null;         // the last hover position { x, z }, for a ghost that must follow a key
  let cursor = '';         // the cursor this tool has set
  let said = null;         // the status text this tool wrote
  let subs = [];

  const layerState = () => ui.layers?.[layer] ?? null;
  const say = (text) => { if (text !== said) { said = text; ui.setStatus?.(text ?? ''); } };
  const hush = () => { if (said !== null && ui.status === said) ui.setStatus?.(''); said = null; };
  // the hint for what the cursor is over ('intro': nothing in particular), with its keys as this keyboard writes them
  const hint = (name) => { const text = spec.hints?.[name] ?? spec.hints?.intro ?? null; return text == null ? null : keyText(text); };
  const point = (hit, ev) => snapPoint(ctx, hit.x, hit.z, ev);
  const ownKind = (items) => items.filter((item) => store.kindOf(item) === kind);
  // a group member brings the members of the SAME kind: this tool edits one kind, and the inspector shows its fields
  // only while the selection is of one kind
  const mates = (item) => ownKind(expandPickable(ctx, [item]));

  // Why nothing can be created or moved to this point - or null.
  function refusal(hit, at) {
    const map = store.map, state = layerState();
    if (!map) return 'No map is loaded';
    if (state && !state.visible) return `Layer hidden: ${layer}`;
    if (state && state.locked) return `Layer locked: ${layer}`;
    if ((ctx.viewport?.preview ?? ui.preview) === 'game') return 'Markers are hidden in the Game preview: switch the preview back to edit them';
    if (hit.onGround === false) return 'Point at the ground';
    return spec.canPlace?.(at.x, at.z) ?? null;
  }

  // ---- what the cursor shows

  function showGhost(props) {
    ctx.markers?.setGhost?.(props && spec.ghost ? spec.ghost(props) : null);
    const ring = props && spec.ring ? spec.ring(props) : null;
    if (ring && ring.r > 0) ctx.viewport?.brush?.(props.x, props.z, ring.r, { color: ring.color });
    else ctx.viewport?.brush?.(null);
  }
  function setCursor(next) {
    if (next !== cursor || next) ui.setCursor?.(next);
    cursor = next;
  }
  function clearHover() {
    showGhost(null);
    over = '';
    last = null;
    setCursor('');
  }
  // The props of the item a click at `at` would create (or the place a click would move the start point to).
  // base: what the template gives - passed by a caller that needs it afterwards.
  const asking = () => (spec.props ? spec.props() : {});
  function propsAt(at, base = asking()) {
    const props = { ...base, x: at.x, z: at.z };
    return spec.fit ? spec.fit(props) : props;
  }

  function hoverAt(hit, ev) {
    const creates = !!spec.props || spec.drag === 'follow';
    let next, why = null, at = null;
    if (hit.handle) next = 'handle';
    else if (hit.item) next = store.selection.has(hit.item) ? 'selected' : 'item';
    else if (!creates || ev?.shiftKey) next = '';     // Shift adds to the selection: it never creates, so no ghost
    else {
      at = point(hit, ev);
      why = refusal(hit, at);
      next = why ? 'refused' : 'create';
    }
    over = next;
    if (next === 'create') {
      last = at;
      showGhost(propsAt(at));
      setCursor('crosshair');
      say(hint('create'));
    } else {
      last = null;
      showGhost(null);
      setCursor(next === 'refused' ? 'not-allowed' : next === 'selected' ? 'move' : next === 'item' ? 'pointer' : '');
      say(next === 'refused' ? why : hint(next || 'intro'));
    }
  }
  // The template changed (a key, the strip): the ghost under a resting cursor follows.
  function refreshGhost() {
    if (mode === null && over === 'create' && last) showGhost(propsAt(last));
  }

  // ---- gestures

  // The pointer left the click threshold.
  function startDrag() {
    if (store.grouping) { mode = 'dead'; return; }       // somebody's edit is open: a drag would join it and close it
    if (press.item) {
      // from a selected item the SELECTION moves, whatever it holds (the keys and the inspector edit the same items);
      // from an unselected one, that item with its group mates of this kind
      const picked = store.selection.has(press.item) ? [...store.selection] : mates(press.item);
      const items = editable(ctx, picked);
      if (!items.length) { mode = 'dead'; return; }
      const originals = items.filter((item) => store.kindOf(item) !== 'start');     // the start point has no copy
      if (press.alt && originals.length) {
        restore = [...store.selection];
        store.begin(`Duplicate ${describe(ctx, originals)}`);
        try {
          const clones = addClones(ctx, originals);        // every group among them becomes a new one
          store.select(clones);
          drag = dragMove(ctx, clones, press.start);     // joins the group opened above: copy and move are one step
          mode = 'move';
        } catch (err) {
          store.cancel();
          restore = null;
          mode = 'dead';
          throw err;
        }
        return;
      }
      if (!store.selection.has(press.item)) store.select(items);   // a drag from an unselected pin takes it along
      drag = dragMove(ctx, items, press.start);
      mode = drag.active ? 'move' : 'dead';
      return;
    }
    // free ground
    const why = press.shift ? keyText('Shift is for adding to the selection: nothing is created with it') : refusal(press.hit, press.at);
    if (why || !spec.drag) {
      if (why && !press.shift) ui.toast?.(why, 'warn');
      mode = 'dead';
      return;
    }
    if (spec.drag === 'follow') {
      const target = spec.target?.();
      if (!target || !ui.isPickable(kind, target)) { mode = 'dead'; return; }
      store.begin(`Move the ${noun}`);
      store.select([target]);
      made = target;
      mode = 'follow';
      return;
    }
    press.asked = asking();
    press.props = propsAt(press.at, press.asked);
    store.begin(`Add 1 ${noun}`);     // the label a click gets from cmd.add: one name for one thing in the history
    try {
      const item = cmd.make(kind, spec.drag === 'radius' ? { ...press.props, r: 0 } : press.props);
      store.exec(cmd.add(kind, [item]));
      store.select([item]);
      made = item;
      if (spec.drag === 'radius') {
        drag = dragRadius(ctx, item, press.start);       // joins the open group: add and resize are one step
        mode = 'create';
      } else mode = 'face';
    } catch (err) {
      store.cancel();
      made = null;
      mode = 'dead';
      throw err;
    }
  }

  // 'face': the new item looks at the pointer. On the angle grid of the editor while snapping is asked for, or Shift is held.
  function face(hit, ev) {
    if (!made || hit.onGround === false) return;
    const dx = hit.x - made.x, dz = hit.z - made.z;
    if (Math.hypot(dx, dz) < 0.05) return;
    let ry = Math.atan2(dx, dz);
    const step = ui.snap?.angle > 0 ? ui.snap.angle : Math.PI / 12;
    if (snapping(ctx, ev) || ev?.shiftKey) ry = Math.round(ry / step) * step;
    store.exec(cmd.set([made], { ry }));
    ctx.viewport?.readout?.(`${num(made.ry * 180 / Math.PI)}°`);
  }

  // 'follow': the start point goes where the pointer is - as long as it may stand there.
  function follow(hit, ev) {
    if (!made) return;
    const at = point(hit, ev), why = refusal(hit, at);
    if (why) { say(why); return; }
    say(hint('create'));
    store.exec(cmd.set([made], { x: at.x, z: at.z }));
    ctx.viewport?.readout?.(`${num(at.x)}, ${num(at.z)}`);
  }

  // A press released where it began.
  function click() {
    const { item } = press;
    if (item) {
      if (press.alt && spec.adopt) {
        spec.adopt(item);
        ui.toast?.(`Settings copied from that ${noun}`);
      } else if (press.toggle) store.select([item], { toggle: true });
      else store.select(mates(item));
      return;
    }
    if (press.shift) return;     // a miss while adding to the selection is not a wish for a new item
    if (!spec.props && spec.drag !== 'follow') return;
    if (store.grouping) { ui.toast?.('Finish the current edit first', 'warn'); return; }
    const why = refusal(press.hit, press.at);
    if (why) { ui.toast?.(why, 'warn'); return; }
    if (spec.drag === 'follow') {
      const target = spec.target?.();
      if (!target || !ui.isPickable(kind, target)) return;
      store.exec(cmd.set([target], { x: press.at.x, z: press.at.z }));
      store.select([target]);
      return;
    }
    const asked = asking();
    const created = placeOnce(ctx, kind, propsAt(press.at, asked));
    spec.placed?.(created, 'click', asked);
  }

  // Takes back whatever the current gesture has done. -> whether there was a gesture
  function abort() {
    const was = mode;
    if (was === 'move' || was === 'radius' || was === 'create') {
      drag?.cancel();
      if (restore) store.select(restore);    // a cancelled copy: the originals are the selection again
    } else if ((was === 'face' || was === 'follow') && store.grouping) store.cancel();
    ctx.viewport?.readout?.(null);
    drag = null;
    made = null;
    restore = null;
    press = null;
    mode = null;
    return was !== null && was !== 'dead';
  }

  store.on('load', () => {       // the old map took its items and its open group with it
    drag = null;
    made = null;
    restore = null;
    press = null;
    mode = null;
    last = null;
  });

  const tool = {
    id: spec.id, label: spec.label, icon: spec.icon, layer, picks: [kind], hidden: false,
    about: spec.about ?? '',
    get intro() { return hint('intro') ?? ''; },
    get context() { return 'select'; },

    activate() {
      // the pointer left the viewport: nothing would be created anywhere, so nothing is promised - the bar goes back
      // to what the tool does
      subs.push(ui.on('cursor', (hit) => { if (hit === null && mode === null) { clearHover(); say(hint('intro')); } }));
      spec.activate?.();
      say(hint('intro'));
    },

    deactivate() {
      abort();
      clearHover();
      hush();
      for (const off of subs) off?.();
      subs = [];
      spec.deactivate?.();
    },

    pointerDown(ev, hit) {
      if (mode) abort();         // a press whose release never came
      showGhost(null);
      if (hit.handle?.type === 'radius' && hit.item) {
        drag = store.grouping ? null : dragRadius(ctx, hit.item, hit);
        mode = drag?.active ? 'radius' : 'dead';
        return;
      }
      press = {
        item: hit.item ?? null,
        hit: { onGround: hit.onGround },
        at: point(hit, ev),                        // where a new item would stand
        start: { x: hit.x, z: hit.z },             // a copy: the viewport may reuse its Hit object
        shift: !!ev.shiftKey, toggle: !!(ev.shiftKey || mod(ev)), alt: !!ev.altKey,
        tracker: dragTracker(ev), props: null,
      };
      mode = 'press';
    },

    // Every pointer move, with or without the button; `mode` knows whether a press of ours is open.
    pointerMove(ev, hit) {
      if (mode === null) { hoverAt(hit, ev); return; }
      if (mode === 'press') {
        if (!press.tracker.moved(ev)) return;
        startDrag();
      }
      if (mode === 'move' || mode === 'radius' || mode === 'create') drag.move(hit, ev);
      else if (mode === 'face') face(hit, ev);
      else if (mode === 'follow') follow(hit, ev);
    },

    // The viewport ends every press with a pointerUp - also one whose release never came (the window lost the focus,
    // a tool key, a cancelled pointer): then `ev` is the last event of the press, not a 'pointerup'. Such a press
    // creates nothing, as in Place and Paste: no click, and the camp or the chest that was growing out of it is taken
    // back. A move or a resize of what exists is kept as far as it got, as in the Select tool.
    pointerUp(ev, hit) {
      if (ev?.type !== 'pointerup' && (mode === 'press' || mode === 'create' || mode === 'face')) {
        abort();
        return;
      }
      const was = mode;
      mode = null;
      try {
        if (was === 'press') click();
        else if (was === 'move' || was === 'radius') drag?.end();
        else if (was === 'create') {
          // a drag that hardly left the spot was a click with a shaky hand: the camp gets the template's radius
          const shaky = !!(made && made.r < 1 && press?.props && press.props.r >= 1);
          if (shaky) store.exec(cmd.set([made], { r: press.props.r }));
          drag?.end();
          spec.placed?.(made, shaky ? 'click' : 'drag', press?.asked);
        } else if (was === 'face') {
          ctx.viewport?.readout?.(null);
          store.commit();
          spec.placed?.(made, 'drag', press?.asked);
        } else if (was === 'follow') {
          ctx.viewport?.readout?.(null);
          store.commit();
        }
      } finally {
        drag = null;
        made = null;
        restore = null;
        press = null;
      }
    },

    // The two clicks came first and selected the group mates; now the one under the cursor is taken alone.
    doubleClick(ev, hit) {
      if (!hit.item || mode) return;
      if (ev.shiftKey || mod(ev)) store.select([hit.item], { toggle: true });
      else store.select([hit.item]);
    },

    key(action, ev) {
      if (action === 'cancel') {
        const cancelled = abort();
        if (cancelled) mode = 'dead';     // the button is still down: its moves and its release are not a new gesture
        return cancelled;
      }
      if (mode) return false;             // no turning or nudging in the middle of a press
      if (action === 'selection.delete') return false;     // nothing of our own to delete: it falls through to edit.delete
      if (selectionKey(ctx, action, ev)) return true;
      if (spec.idleKey?.(action, ev) === true) { refreshGhost(); return true; }
      return false;
    },

    options(el) {
      spec.options?.(el, (off) => { subs.push(off); });
    },

    refreshGhost,
  };
  return tool;
}

// ---------------------------------------------------------------- the Spawn tool

const DEFAULT_TEMPLATE = { types: { chaser: 1 }, lvl: [1, 2], count: 3, r: 8, respawn: 14 };

export default function create(ctx) {
  const { store, ui, cmd } = ctx;
  const template = templateState(ctx, 'spawn', { defaults: DEFAULT_TEMPLATE, read: templateOf, clean: cleanTemplate });
  const { opts } = template;

  const safeRegionAt = (x, z) => store.map.regions.find((region) => region.safe && inShape(region.shape, x, z)) ?? null;

  // New weights for the template, through the one rule every editor of `types` uses: a camp that becomes the boss alone
  // takes the boss's respawn, and gives it back when the boss leaves. -> false when no monster would be left
  function setTypes(types) {
    const patch = typesPatch(opts, types);
    if (!typeKeys(patch.types).length) {
      ui.toast('A camp needs at least one monster type', 'warn');
      return false;
    }
    template.set(patch);
    return true;
  }

  const tool = markerTool(ctx, {
    id: 'spawn', label: 'Spawn', icon: '☠', layer: 'spawns', kind: 'spawn', drag: 'radius',
    about: 'Monster camps: click to add one, drag to draw its radius',

    props: () => template.fresh(),

    // a camp clicked near the shore is as wide as the island allows; the template itself stays as it is (placed, below)
    fit(props) {
      const room = store.map.radius - LIMITS.spawnMargin - Math.hypot(props.x, props.z);
      return props.r > room ? { ...props, r: qPos(Math.max(0, room)) } : props;
    },

    canPlace(x, z) {
      const map = store.map;
      if (Math.hypot(x, z) > map.radius - LIMITS.spawnMargin) return `Outside the island: a camp stays ${LIMITS.spawnMargin} units inside its edge`;
      const safe = safeRegionAt(x, z);
      if (safe) return `Monsters cannot spawn inside a safe region (${safe.name})`;
      return null;
    },

    ghost: (props) => ({ spawns: [props] }),
    // the dashed ring of a real camp, before the camp exists: how far its monsters will reach
    ring: (props) => ({ r: threatOf(props), color: campColor(props, !!ui.overlays?.levelColors) }),

    adopt: (item) => template.adopt(item),

    placed(item, how, asked) {
      if (!item || store.kindOf(item) !== 'spawn') return;
      // the template has just copied the new camp (it follows the selection): a radius cut at the shore is not what
      // the next camp should start from. A radius drawn by hand is.
      if (how === 'click' && Number.isFinite(asked?.r) && item.r < asked.r) template.set({ r: asked.r });
      const blocked = isBlocked(store.map, item.x, item.z) ? ` · its centre is on ${groundAt(store.map, item.x, item.z).name.toLowerCase()}: monsters appear on the walkable part of the disc` : '';
      ui.setNote(`Camp added: ${campText(item)} · radius ${num(item.r)} · threat radius ${num(threatOf(item))}${blocked}`);
    },

    // nothing selected: the brackets size the next camp
    idleKey(action) {
      if (action !== 'scale.up' && action !== 'scale.down') return false;
      const r = Math.max(LIMITS.spawnR[0], Math.min(LIMITS.spawnR[1], Math.round(opts.r) + (action === 'scale.up' ? 1 : -1)));
      template.set({ r });
      ui.setNote(`Camp radius ${num(opts.r)} · threat radius ${num(threatOf(opts))}`);
      return true;
    },

    hints: {
      intro: 'Spawn: click adds a camp, drag draws its radius · drag a camp to move it, its rim to resize',
      get create() { return `Click: ${campText(template.fresh())} · drag: centre to radius · [ ]: radius ${num(opts.r)}`; },
      item: 'Click: select · drag: move · Shift+click: add · Alt+click: copy its settings · Alt+drag: move a copy',
      selected: 'Drag: move the selection · drag the rim: resize · Alt+drag: move a copy',
      handle: 'Drag the rim to resize the camp',
    },

    // One line: preset, the monster mix (a weight per type, 0 = absent), levels, count, radius, respawn.
    options(el, keep) {
      const weightOf = (key) => opts.types[key] ?? 0;
      const presetOf = () => SPAWN_PRESETS.find((p) => sameTemplate(p.template, template.fresh()))?.id ?? null;
      const preset = selectField({
        value: presetOf(),
        options: [{ value: null, label: 'Custom' }, ...SPAWN_PRESETS.map((p) => ({ value: p.id, label: p.label }))],
        onCommit: (id) => {
          const found = SPAWN_PRESETS.find((p) => p.id === id);
          if (found) template.set(found.template);
          else preset.set(presetOf());     // "Custom" is what the fields make it, not a choice
        },
      });
      preset.el.title = 'Ready-made camps. The fields beside it change any of them';

      const weights = MOB_KEYS.map((key) => {
        const field = numberField({
          value: weightOf(key), min: 0, max: LIMITS.spawnWeight[1], step: 1,
          onCommit: (v) => { if (!setTypes({ ...opts.types, [key]: v })) field.set(weightOf(key)); },
        });
        field.input.style.width = '30px';
        const swatch = h('span', { class: 'ui-swatch', style: { background: hex(MOB_TYPES[key].color), verticalAlign: 'middle', marginRight: '3px' } });
        const line = row([swatch, shortName(key)], field);
        line.title = `${MOB_TYPES[key].name}: its weight in the camp's mix (0 = none). Drag the name to change it`;
        return { key, field, line };
      });

      const narrow = (field, px = 42) => { field.input.style.width = `${px}px`; return field; };
      const lo = narrow(numberField({ value: opts.lvl[0], min: LIMITS.level[0], max: LIMITS.level[1], step: 1, onCommit: (v) => template.set({ lvl: [v, Math.max(v, opts.lvl[1])] }) }), 34);
      const hi = narrow(numberField({ value: opts.lvl[1], min: LIMITS.level[0], max: LIMITS.level[1], step: 1, onCommit: (v) => template.set({ lvl: [Math.min(v, opts.lvl[0]), v] }) }), 34);
      const count = narrow(numberField({ value: opts.count, min: LIMITS.spawnCount[0], max: LIMITS.spawnCount[1], step: 1, onInput: (v) => template.set({ count: v }) }), 34);
      const radius = narrow(numberField({ value: opts.r, min: LIMITS.spawnR[0], max: LIMITS.spawnR[1], step: 0.5, onInput: (v) => template.set({ r: v }) }));
      const respawn = narrow(numberField({ value: opts.respawn, min: LIMITS.spawnRespawn[0], max: LIMITS.spawnRespawn[1], step: 1, onInput: (v) => template.set({ respawn: v }) }), 56);
      const threat = h('span', { class: 'ui-hint', title: 'How far from its centre the camp is dangerous: radius + strolling + aggro range (the dashed ring)' });

      const controls = templateControls(ctx, 'spawn', template, (items) => {
        const t = template.fresh();
        store.begin(`Apply camp settings to ${describe(ctx, items)}`);
        try {
          store.exec(cmd.set(items, { types: t.types, lvl: t.lvl, count: t.count, r: t.r, respawn: t.respawn }));
        } finally {
          store.commit();
        }
      });

      const sync = () => {
        preset.set(presetOf());
        for (const w of weights) w.field.set(weightOf(w.key));
        lo.set(opts.lvl[0]);
        hi.set(opts.lvl[1]);
        count.set(opts.count);
        radius.set(opts.r);
        respawn.set(opts.respawn);
        threat.textContent = `threat ${num(threatOf(opts))}`;
        tool.refreshGhost();
      };
      const lvlRow = row('Level', h('span', { class: 'ui-field ui-pair' }, lo.el, h('span', { class: 'ui-dash' }, '–'), hi.el));
      lvlRow.title = 'Every monster of the camp gets a level from this range';
      const countRow = row('Count', count), radiusRow = row('Radius', radius), respawnRow = row('Respawn', respawn);
      countRow.title = 'How many monsters live in the camp';
      radiusRow.title = 'Monsters appear inside this disc. Drag on the map to set it by hand; [ and ] change it';
      respawnRow.title = 'Seconds after its death a monster comes back';
      respawn.el.classList.add('ui-unit');
      respawn.el.dataset.unit = 's';
      el.append(row('Camp', preset), ...weights.map((w) => w.line), lvlRow, countRow, radiusRow, respawnRow, threat, ...controls.nodes);
      sync();
      keep(template.on(sync));
      keep(controls.release);
    },
  });

  // beyond the tool contract: the template, for the Spawns panel (Populate copies it) and for scripts
  return Object.assign(tool, {
    opts,
    presets: SPAWN_PRESETS,
    template: () => template.fresh(),
    setTemplate: (patch) => template.set(patch),
    onTemplate: (fn) => template.on(fn),
  });
}
