// The Select tool: pick, box-select, move, resize, duplicate and delete anything on the map.
//
//   click                 select what is under the cursor - a member of a group brings its whole group
//   Shift / Mod + click   toggle it (the whole group)
//   double-click          the single member alone ("enter" the group); with Shift: toggle that member
//   click again in place  the next item under the cursor (after 400 ms, so a double-click never cycles); Alt+click: at once
//   drag on the selection move it (snapping per ui.snap, Mod inverts)        Alt+drag: move a copy
//   drag anywhere else    box select (Shift adds, Alt subtracts; regions are never boxed)
//   gizmo handle          move along an axis, freely, turn, scale, lift (gizmo.js); a click on a handle that does not
//                         become a drag goes to what lies under the handle
//   rim of a camp / the start disc / a circle region   resize it
//   Q E [ ] arrows X      turn, scale, nudge, switch gizmo axes (tools/common.js)
//
// What the cursor is over is decided by the viewport (hit.item / hit.handle): this file never picks by itself.
// It also owns the edits that act on the selection whatever tool is active: delete, duplicate, select all, group.
import { h, row, button, checkField, selectField } from '../ui/dom.js';
import { mod, hintFor, keyText } from '../keymap.js';
import { dragTracker, dragMove, dragRadius, selectionKey, editable, expandPickable, describe } from './common.js';

const KINDS = ['object', 'spawn', 'chest', 'npc', 'region', 'start'];
const BOX_KINDS = ['object', 'spawn', 'chest', 'npc', 'start'];   // a region covers half the island: it is never boxed
const GROUPED = ['object', 'spawn', 'chest', 'npc'];              // the kinds that carry a group id
const CYCLE_PX = 3, CYCLE_MS = 400;
const SNAP_STEPS = [0.25, 0.5, 1, 2];

const sameItems = (set, list) => {
  if (set.size !== list.length) return false;
  for (const item of list) if (!set.has(item)) return false;
  return true;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
// (one line of the status bar at 1440 px; the Help sheet has the rest: Shift, Alt, the click that cycles)
const INTRO = keyText('Select: click an item · drag on empty ground for a box · drag the selection to move it');
const withHint = (text, action) => { const key = hintFor(action); return key ? `${text} (${key})` : text; };

// ---------------------------------------------------------------- edits on the selection (any tool)

// Copies of `items` added to the map in place, inside the store group the caller has opened. The start point has no
// copy. Every group among the items becomes a NEW group, so the copies do not join the originals.
// -> the copies, in the order of the kinds
export function addClones(ctx, items) {
  const { store, cmd } = ctx, groups = new Set();
  for (const item of items) if (typeof item.g === 'string') groups.add(item.g);
  const ids = store.newGroupIds(groups.size), fresh = new Map([...groups].map((g, i) => [g, ids[i]]));
  const byKind = new Map();
  for (const item of items) {
    const kind = store.kindOf(item);
    if (!kind || kind === 'start') continue;
    const clone = cmd.clone(item);
    if (typeof clone.g === 'string') clone.g = fresh.get(clone.g);   // not in the map yet: this is building the item, not editing one
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(clone);
  }
  const clones = [];
  for (const kind of KINDS) {
    const list = byKind.get(kind);
    if (!list) continue;
    store.exec(cmd.add(kind, list));
    clones.push(...list);
  }
  return clones;
}

const duplicable = (ctx) => editable(ctx, ctx.store.selection).filter((item) => ctx.store.kindOf(item) !== 'start');

// Delete: everything selected that may be edited; the start point stays. -> whether anything was removed
export function deleteSelection(ctx) {
  const { store, cmd, ui } = ctx;
  if (!store.map || store.grouping) return false;
  const items = duplicable(ctx);
  if (!items.length) return false;
  const what = describe(ctx, items);
  store.begin(`Delete ${what}`);
  try {
    store.exec(cmd.remove(items));
  } finally {
    store.commit();
  }
  ui.setNote?.(`Deleted ${what}`);
  return true;
}

// Duplicate: the copies appear in place, become the selection and hang on the cursor (viewport.grab) until a left
// click drops them - one undo step - or Esc / a right-click takes the whole duplicate back and restores the selection.
// -> Promise<boolean>: whether the copies were kept
export async function duplicateSelection(ctx) {
  const { store, ui, viewport } = ctx;
  if (!store.map) return false;
  if (store.grouping) {
    ui.toast?.('Finish the current edit first', 'warn');
    return false;
  }
  const items = duplicable(ctx);
  if (!items.length) return false;
  const before = [...store.selection], label = `Duplicate ${describe(ctx, items)}`;
  store.begin(label);
  try {
    const clones = addClones(ctx, items);
    store.select(clones);
    const kept = await viewport.grab(clones, label);   // commits on a click, cancels on Esc
    if (!kept) store.select(before);
    return !!kept;
  } catch (err) {
    if (store.grouping) store.cancel();
    store.select(before);
    throw err;
  }
}

// Select All: every item of the kinds the ACTIVE tool can pick, on visible unlocked layers. -> the number selected
// In the Select tool that is what a box around the whole map would take: regions are left out there too. A region
// is a zone, not a thing that stands on the map - "select all, delete" or "select all, nudge" means the scenery and
// the markers, and must not take the lands of the island along. Regions are all selected with the Region tool
// active, or one by one by their outline, their label or their row.
export function selectAll(ctx) {
  const { store, ui } = ctx;
  if (!store.map) return 0;
  const picks = ctx.tools?.[ui.tool]?.picks ?? [], kinds = ui.tool === 'select' ? picks.filter((kind) => BOX_KINDS.includes(kind)) : picks;
  const items = [];
  for (const kind of KINDS) {
    if (!kinds.includes(kind)) continue;
    for (const item of store.items(kind)) if (ui.isPickable(kind, item)) items.push(item);
  }
  store.select(items);
  if (items.length) {
    const regions = ui.tool === 'select' && store.map.regions.length > 0;
    ui.setNote?.(`Selected ${describe(ctx, items)}${regions ? ' \u00b7 regions are not part of Select All: pick them by their outline, or take the Region tool' : ''}`);
  }
  return items.length;
}

const grouped = (ctx) => editable(ctx, ctx.store.selection).filter((item) => GROUPED.includes(ctx.store.kindOf(item)));

// Group: the selected objects, spawns, chests and NPCs get one new group id (g1, g2, ... the first unused).
export function groupSelection(ctx) {
  const { store, cmd, ui } = ctx;
  if (!store.map || store.grouping) return false;
  const items = grouped(ctx);   // one item is enough: a group of one is a group (it can be named, found and grown later)
  if (!items.length) {
    ui.setNote?.('Nothing to group here: regions, the start point and locked layers are left out');
    return false;
  }
  const g = store.newGroupIds(1)[0];
  store.begin(`Group ${plural(items.length, 'item')}`);
  try {
    store.exec(cmd.set(items, { g }));
  } finally {
    store.commit();
  }
  ui.toast?.(`Grouped ${plural(items.length, 'item')} as ${g}`);
  return true;
}

// Ungroup: the selected items leave their groups.
export function ungroupSelection(ctx) {
  const { store, cmd, ui } = ctx;
  if (!store.map || store.grouping) return false;
  const items = grouped(ctx).filter((item) => item.g != null);
  if (!items.length) return false;
  store.begin(`Ungroup ${plural(items.length, 'item')}`);
  try {
    store.exec(cmd.set(items, { g: undefined }));   // undefined = back to the default: no group
  } finally {
    store.commit();
  }
  ui.toast?.(`Ungrouped ${plural(items.length, 'item')}`);
  return true;
}

// ---------------------------------------------------------------- the tool

export default function create(ctx) {
  const { store, ui, actions } = ctx;

  // A press becomes one of these and stays it until the button is released:
  //   'press'  nothing decided yet (a click, or a drag below the threshold)      'gizmo'   a gizmo handle is dragged
  //   'radius' a rim handle is dragged       'move'  the selection (or a copy) is dragged       'box'  a box select
  //   'dead'   the gesture was cancelled with the button still down: the rest of it is swallowed
  let mode = null;
  let press = null;       // { x, y, start, item, onSelected, toggle, alt, tracker, moved }
  let drag = null;        // what dragMove / dragRadius returned
  let restore = null;     // the selection to put back when a duplicate-drag is cancelled
  let box = null;         // { el, x0, y0, x1, y1, base, add, subtract, stale }
  let last = null;        // the last click: { x, y, at, selection, top } - for cycling through what lies under the cursor
  let cursor = '';        // the cursor this tool has set ('' = it has set none)
  let subs = [];          // what options() subscribed to; released in deactivate()

  // The selection edits belong to the editor, not to this tool - they are registered here because Select is always
  // loaded. An id somebody registered earlier is left alone (registering twice throws).
  const offer = (id, fn, enabled) => { if (!actions.has(id)) actions.register(id, fn, enabled ? { enabled } : undefined); };
  const some = () => store.selection.size > 0 && !store.grouping;
  offer('edit.delete', () => deleteSelection(ctx), some);
  offer('edit.duplicate', () => { duplicateSelection(ctx).catch((err) => console.error('[editor] duplicate failed', err)); }, some);
  offer('edit.selectAll', () => selectAll(ctx));
  offer('edit.group', () => groupSelection(ctx), some);
  offer('edit.ungroup', () => ungroupSelection(ctx), some);

  store.on('load', () => { last = null; });   // the items of the old map are gone

  // ---- clicks

  // The next entry of the stack under the cursor whose selection would differ from the current one, or null.
  // `after`: the item to continue from (the previous click's choice); without it, the first selected entry.
  function nextInStack(x, y, after) {
    const stack = ctx.viewport.hitStack(x, y) ?? [], sel = store.selection;
    if (!stack.length) return null;
    let i = after ? stack.findIndex((e) => e.item === after) : -1;
    if (i < 0) i = stack.findIndex((e) => sel.has(e.item));
    for (let k = 1; k <= stack.length; k++) {
      const item = stack[(i + k) % stack.length].item;     // from -1 this starts at the top
      if (!sameItems(sel, expandPickable(ctx, [item]))) return item;
    }
    return null;
  }

  function click() {
    const { x, y, item, toggle, alt } = press, now = performance.now();
    const inPlace = last !== null && Math.abs(x - last.x) <= CYCLE_PX && Math.abs(y - last.y) <= CYCLE_PX;
    let chosen = item;
    // Cycling: the same pixel again, not as the second half of a double-click, and nobody changed the selection in
    // between. Alt asks for the next one outright.
    if (item && !toggle && (alt || (inPlace && now - last.at > CYCLE_MS && sameItems(store.selection, last.selection)))) {
      chosen = nextInStack(x, y, inPlace ? last.top : null) ?? item;
    }
    if (!chosen) {
      if (!toggle) store.clearSelection();   // a click on nothing clears; with Shift it is a miss, not a wish
    } else {
      const members = expandPickable(ctx, [chosen]);
      if (!toggle) store.select(members);
      else {
        const next = new Set(store.selection);
        if (next.has(chosen)) for (const m of members) next.delete(m);
        else for (const m of members) next.add(m);
        store.select([...next]);
      }
    }
    last = { x, y, at: now, selection: [...store.selection], top: chosen };
  }

  // A press on a gizmo handle that never became a drag. The gizmo is large - a ring and two arrows around the pivot -
  // and in a camp of buildings something the user means to click often lies under it (the well between two selected
  // houses): the click goes there, replacing the selection or toggling with Shift / Mod like any other click.
  // With nothing under the handle it does nothing: a click on the gizmo is not a click on empty ground.
  function clickUnder() {
    const top = ctx.viewport.hitStack(press.x, press.y)?.[0]?.item ?? null;
    if (!top) return;
    press.item = top;
    click();
  }

  // ---- box select

  function placeBox() {
    const r = box.el.parentElement.getBoundingClientRect(), s = box.el.style;
    s.left = `${Math.min(box.x0, box.x1) - r.left}px`;
    s.top = `${Math.min(box.y0, box.y1) - r.top}px`;
    s.width = `${Math.abs(box.x1 - box.x0)}px`;
    s.height = `${Math.abs(box.y1 - box.y0)}px`;
  }

  function startBox(ev) {
    // the one DOM node of this tool: a rectangle over the viewport that shows only while a box is dragged
    const el = h('div', { class: 'ui-marquee' });
    el.style.cssText = 'position:absolute;box-sizing:border-box;pointer-events:none;border:1px solid var(--accent, #6cb4ff);'
      + 'background:color-mix(in srgb, var(--accent, #6cb4ff) 14%, transparent);';
    ctx.viewport.dom.parentElement.append(el);
    box = { el, x0: press.x, y0: press.y, x1: ev.clientX, y1: ev.clientY, base: [...store.selection], add: press.toggle, subtract: press.alt, stale: true };
    placeBox();
  }

  function moveBox(ev) {
    if (Number.isFinite(ev.clientX) && Number.isFinite(ev.clientY)) { box.x1 = ev.clientX; box.y1 = ev.clientY; }
    box.stale = true;
    placeBox();
    ctx.viewport.invalidate();   // update() applies the box once per rendered frame, however many moves a frame brings
  }

  // The selection the box stands for: what it holds (groups expanded), added to or taken from the selection of the press.
  function applyBox() {
    box.stale = false;
    const inside = ctx.viewport.itemsInRect(Math.min(box.x0, box.x1), Math.min(box.y0, box.y1), Math.max(box.x0, box.x1), Math.max(box.y0, box.y1), BOX_KINDS) ?? [];
    const picked = expandPickable(ctx, inside);
    if (!box.add && !box.subtract) { store.select(picked); return; }
    const next = new Set(box.base);
    if (box.subtract) for (const item of picked) next.delete(item);
    else for (const item of picked) next.add(item);
    store.select([...next]);
  }

  function endBox() {
    box?.el.remove();
    box = null;
  }

  // ---- drags

  // The pointer left the click threshold: the press turns into a move of the selection or into a box.
  function startDrag(ev) {
    if (!press.onSelected) {
      startBox(ev);
      mode = 'box';
      return;
    }
    const items = editable(ctx, store.selection);
    if (!items.length || store.grouping) { mode = 'dead'; return; }   // all of it locked, or another edit is open
    if (!press.alt) {
      drag = dragMove(ctx, items, press.start);
      mode = drag.active ? 'move' : 'dead';
      return;
    }
    // Alt: the copies are added in place and dragged away, all in one undo step
    const originals = items.filter((item) => store.kindOf(item) !== 'start');
    if (!originals.length) { mode = 'dead'; return; }
    restore = [...store.selection];
    store.begin(`Duplicate ${describe(ctx, originals)}`);
    try {
      const clones = addClones(ctx, originals);
      store.select(clones);
      drag = dragMove(ctx, clones, press.start);   // joins the group opened above: the copies and their move are one step
      mode = 'move';
    } catch (err) {
      store.cancel();
      restore = null;
      mode = 'dead';
      throw err;
    }
  }

  // Takes back whatever the current gesture has done. -> whether there was a gesture
  function abort() {
    const was = mode;
    if (was === 'gizmo') ctx.gizmo.cancel();
    else if (was === 'radius' || was === 'move') {
      drag?.cancel();
      if (restore) store.select(restore);   // a cancelled duplicate: the originals are the selection again
    } else if (was === 'box') {
      store.select(box.base);
      endBox();
    }
    drag = null;
    restore = null;
    press = null;
    mode = null;
    return was !== null && was !== 'dead';
  }

  // Over something selected the cursor says "this moves"; over a handle the viewport shows its own.
  function hoverCursor(hit) {
    const next = !hit.handle && hit.item && store.selection.has(hit.item) ? 'move' : '';
    // '' hands the cursor back to the viewport (panning, a handle, a locked layer); it is said once, not on every move
    if (next !== cursor || next) ui.setCursor?.(next);
    cursor = next;
  }

  return {
    id: 'select', label: 'Select', icon: '↖', layer: null, picks: KINDS.slice(), hidden: false,
    about: 'Pick, move, turn and scale whatever is on the map',
    get context() { return 'select'; },

    intro: INTRO,          // the status bar shows it while nothing else is said
    activate() {},

    deactivate() {
      abort();
      endBox();
      for (const off of subs) off?.();
      subs = [];
      if (cursor) ui.setCursor?.('');
      cursor = '';
    },

    pointerDown(ev, hit) {
      if (mode) abort();   // a press whose release never came
      const handle = hit.handle;
      if (handle?.type === 'gizmo' && ctx.gizmo) {
        ctx.gizmo.begin(handle.index, hit, ev);
        // until the pointer leaves the click threshold this is still a click - on what lies under the handle
        press = {
          x: ev.clientX, y: ev.clientY, start: { x: hit.x, z: hit.z }, item: null, onSelected: false,
          toggle: !!(ev.shiftKey || mod(ev)), alt: !!ev.altKey, tracker: dragTracker(ev), moved: false,
        };
        mode = 'gizmo';
        return;
      }
      if (handle?.type === 'radius' && hit.item) {
        // somebody's edit is still open: the drag would join that group and close it with its own release
        drag = store.grouping ? null : dragRadius(ctx, hit.item, hit);
        mode = drag?.active ? 'radius' : 'dead';
        return;
      }
      const item = hit.item ?? null;
      press = {
        x: ev.clientX, y: ev.clientY,
        start: { x: hit.x, z: hit.z },   // a copy: the viewport may reuse its Hit object
        item, onSelected: item !== null && store.selection.has(item),
        toggle: !!(ev.shiftKey || mod(ev)), alt: !!ev.altKey,
        tracker: dragTracker(ev),
      };
      mode = 'press';
    },

    // Every pointer move, with or without the button; `mode` knows whether a press of ours is open.
    pointerMove(ev, hit) {
      if (mode === null) { hoverCursor(hit); return; }
      if (mode === 'press') {
        if (!press.tracker.moved(ev)) return;
        startDrag(ev);
      }
      if (mode === 'gizmo') {
        if (!press.moved && !press.tracker.moved(ev)) return;   // the same threshold as every other drag of this tool
        press.moved = true;
        ctx.gizmo.move(hit, ev);
      } else if (mode === 'radius' || mode === 'move') drag.move(hit, ev);
      else if (mode === 'box') moveBox(ev);
    },

    pointerUp(ev) {
      const was = mode;
      mode = null;
      try {
        if (was === 'gizmo') {
          if (press?.moved) ctx.gizmo.end();
          else {
            ctx.gizmo.cancel();                              // nothing moved: no step
            if (ev?.type === 'pointerup') clickUnder();      // (a press that lost its release is no click)
          }
        } else if (was === 'radius' || was === 'move') drag?.end();
        else if (was === 'box') { moveBox(ev); applyBox(); }
        else if (was === 'press') click();
      } finally {
        endBox();
        drag = null;
        restore = null;
        press = null;
      }
    },

    // The two clicks came first and selected the group; now its one member under the cursor is taken alone.
    doubleClick(ev, hit) {
      const item = hit.item;
      if (!item || mode) return;
      if (ev.shiftKey || mod(ev)) store.select([item], { toggle: true });
      else store.select([item]);
      last = { x: ev.clientX, y: ev.clientY, at: performance.now(), selection: [...store.selection], top: item };
    },

    key(action, ev) {
      if (action === 'cancel') {
        const cancelled = abort();
        if (cancelled) mode = 'dead';   // the button is still down: its moves and its release are not a new gesture
        return cancelled;
      }
      if (mode) return false;           // no turning or nudging in the middle of a press
      return selectionKey(ctx, action, ev);   // 'selection.delete' is not ours: it falls through to edit.delete
    },

    update() {
      if (box?.stale) applyBox();
    },

    // Snapping and axes, which decide how every drag of this tool behaves, and the edits on the selection as buttons.
    options(el) {
      for (const off of subs) off?.();
      const node = (x) => x?.el ?? x;
      const snapOn = checkField({ value: ui.snap.on, onCommit: (on) => ui.set('snap', { ...ui.snap, on }) });
      const snapStep = selectField({
        value: ui.snap.step, options: SNAP_STEPS.map((value) => ({ value, label: String(value) })),
        onCommit: (step) => ui.set('snap', { ...ui.snap, step }),
      });
      const axes = selectField({
        value: ui.axes, options: [{ value: 'world', label: 'World' }, { value: 'local', label: 'Local' }],
        onCommit: (value) => ui.set('axes', value),
      });
      const run = (id) => () => actions.run(id);
      const buttons = [
        button('Duplicate', run('edit.duplicate'), { title: withHint('Duplicate the selection and place the copies', 'edit.duplicate') }),
        button('Group', run('edit.group'), { title: withHint('Make one group of the selection', 'edit.group') }),
        button('Ungroup', run('edit.ungroup'), { title: withHint('Take the selection out of its groups', 'edit.ungroup') }),
        button('Delete', run('edit.delete'), { title: withHint('Delete the selection', 'edit.delete'), danger: true }),
      ].map(node);
      const refresh = () => {
        const none = store.selection.size === 0;
        for (const b of buttons) b.disabled = none;
      };
      el.append(
        row(withHint('Snap', 'snap.toggle'), h('span', null, node(snapOn), node(snapStep))),
        row('Axes', node(axes)),
        h('div', { class: 'ui-row' }, ...buttons),
      );
      refresh();
      subs = [
        ui.on('snap', () => { snapOn.set?.(ui.snap.on); snapStep.set?.(ui.snap.step); }),
        ui.on('axes', () => axes.set?.(ui.axes)),
        store.on('selection', refresh),
      ];
    },
  };
}
