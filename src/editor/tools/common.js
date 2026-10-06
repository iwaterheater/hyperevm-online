// Helpers shared by the Select tool and by the tools that place and edit items (Place, Paste, Spawn, Chest, NPC, Start,
// Region). They hold the rules every one of those tools must follow in the same way - snapping, the click-versus-drag
// threshold, a drag as ONE undo step, the pivot, the keys that turn, scale and nudge the selection - so a spawn moves,
// snaps and undoes exactly like a tree.
//
// Nothing here listens to the keyboard or touches the view: a tool forwards its pointer events and its key actions,
// and every change of the map goes through a command (ctx.cmd) run by the store.
import { LIMITS, qPos, shapeCentre } from '../../map/format.js';
import { mod } from '../keymap.js';

const DEG = Math.PI / 180;
const NOUN = {
  object: ['object', 'objects'], spawn: ['spawn', 'spawns'], chest: ['chest', 'chests'],
  npc: ['NPC', 'NPCs'], region: ['region', 'regions'], start: ['start point', 'start points'],
};
const num = (v) => (Math.round(v * 100) / 100).toFixed(2);
const clamp = (v, [min, max]) => Math.max(min, Math.min(max, v));

// ---------------------------------------------------------------- what may be edited, and what to call it

// -> the items of `items` (any iterable) that are in the map and may be edited right now: on a visible, unlocked layer,
// not flagged, not of a model hidden in Layers. A selection can outlive the lock of its layer; an edit must not.
export function editable(ctx, items) {
  const { store, ui } = ctx, out = [];
  for (const item of items) {
    const kind = store.kindOf(item);
    if (kind && ui.isPickable(kind, item)) out.push(item);
  }
  return out;
}

// -> the items plus the other members of their groups, without those that may not be picked: what a click on a group
// member, a box select and Select All put into the selection (a fortress wall clicked while the Spawns layer is locked
// does not bring the boss spawn along).
export function expandPickable(ctx, items) {
  return editable(ctx, ctx.store.expandGroups(items));
}

// -> '12 objects', '1 spawn', '3 items' (several kinds): the tail of an undo label.
export function describe(ctx, items) {
  let n = 0, kind = null;
  for (const item of items) {
    const k = ctx.store.kindOf(item) ?? 'item';
    kind = n === 0 || kind === k ? k : 'item';
    n++;
  }
  if (kind === 'start') return 'start point';
  const noun = NOUN[kind] ?? ['item', 'items'];
  return `${n} ${noun[n === 1 ? 0 : 1]}`;
}

// ---------------------------------------------------------------- snapping

// Does this event ask for snapping? The toggle of the status bar, inverted while Mod is held.
export function snapping(ctx, ev) {
  return !!ctx.ui.snap.on !== !!(ev && mod(ev));
}

// -> { x, z }: on the snap grid when snapping is asked for, else as given - and on the 0.01 grid of the map either way.
// Snapping is absolute: the point lands on multiples of the step.
export function snapPoint(ctx, x, z, ev) {
  if (!snapping(ctx, ev)) return { x: qPos(x), z: qPos(z) };
  const step = ctx.ui.snap.step > 0 ? ctx.ui.snap.step : 1;
  return { x: qPos(Math.round(x / step) * step), z: qPos(Math.round(z / step) * step) };
}

// ---------------------------------------------------------------- click or drag

// -> { moved(ev) -> boolean }: false until the pointer is `px` pixels away from where `ev` pressed, true from then on
// (also when it comes back: a drag that has started stays a drag).
export function dragTracker(ev, px = 4) {
  const x = ev.clientX, y = ev.clientY;
  let moved = false;
  return {
    moved(e) {
      if (!moved && Math.hypot(e.clientX - x, e.clientY - y) >= px) moved = true;
      return moved;
    },
  };
}

// ---------------------------------------------------------------- pivot

// -> { x, z }: the centre of the ground bounding box of the items' origins; a region counts with the centre of its shape.
export function pivotOf(ctx, items) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const item of items) {
    const p = item.shape ? shapeCentre(item.shape) : item;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return minX > maxX ? { x: 0, z: 0 } : { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 };
}

// ---------------------------------------------------------------- drags

const IDLE = { active: false, move() {}, end() {}, cancel() {} };

// Moves `items` with the pointer as ONE undo step. startHit: the Hit of the press.
// -> { active, move(hit, ev), end(), cancel() }: move on every pointer move, end on release, cancel on Esc.
// The pivot of the items is what snaps (Mod inverts the toggle, per move). Items that may not be edited stay behind;
// with nothing to move and no group to close the result is inert (active: false).
//   label  the undo label of the group it opens (default 'Move 12 objects')
// A store group that is ALREADY open is joined, not opened a second time (store.begin would throw): a tool that
// creates and then drags - begin, add the copies, hand them over - gets ONE step for both. end() commits that group
// and cancel() takes all of it back, the caller's own commands included. A drag that ends where it started leaves no
// step at all (the store drops a group that changed nothing).
export function dragMove(ctx, items, startHit, { label = null } = {}) {
  const { store, cmd, viewport } = ctx, list = editable(ctx, items);
  if (!store.grouping) {
    if (!list.length) return IDLE;
    store.begin(label ?? `Move ${describe(ctx, list)}`);
  }
  const snap = list.length ? cmd.snapshot(list) : null, pivot = pivotOf(ctx, list), x0 = startHit.x, z0 = startHit.z;
  let done = false;
  const close = (how) => {
    if (done) return;
    done = true;
    viewport?.readout?.(null);
    store[how]();
  };
  return {
    active: true,
    move(hit, ev) {
      if (done || !snap || hit.onGround === false) return;   // above the horizon there is no ground point to follow
      let dx = hit.x - x0, dz = hit.z - z0;
      if (snapping(ctx, ev)) {
        const p = snapPoint(ctx, pivot.x + dx, pivot.z + dz, ev);
        dx = p.x - pivot.x;
        dz = p.z - pivot.z;
      }
      // one offset on the map's grid for all items: what was aligned before the drag is aligned after it
      dx = qPos(dx);
      dz = qPos(dz);
      store.exec(cmd.transform(snap, { dx, dz, pivot }));
      viewport?.readout?.(`dx ${num(dx)}  dz ${num(dz)}`);
    },
    end() { close('commit'); },
    cancel() { close('cancel'); },
  };
}

// The radius of a spawn, of the start disc or of a circle region and where its centre is - or null for anything else.
function discOf(ctx, item) {
  const kind = ctx.store.kindOf(item);
  if (kind === 'spawn') return { kind, x: item.x, z: item.z, r: item.r, range: LIMITS.spawnR };
  if (kind === 'start') return { kind, x: item.x, z: item.z, r: item.r, range: LIMITS.startR };
  if (kind === 'region' && item.shape.type === 'circle') return { kind, x: item.shape.x, z: item.shape.z, r: item.shape.r, range: LIMITS.regionR };
  return null;
}

// Drags the 'radius' handle of a spawn, of the start disc or of a circle region as ONE undo step: the radius becomes
// the distance from the centre to the pointer, on the snap grid when snapping is asked for, kept inside LIMITS.
// -> { active, move(hit, ev), end(), cancel() } like dragMove, with the same option `label` and the same rule for a
// store group that is ALREADY open: it is joined. That is how a camp or a circle region is created by press-drag as
// one step - store.begin('Add spawn'), exec(cmd.add(...)), dragRadius(ctx, item, hit) - with end() committing and
// cancel() removing the new item again.
export function dragRadius(ctx, item, startHit, { label = null } = {}) {
  const { store, cmd, viewport } = ctx, disc = discOf(ctx, item);
  if (!store.grouping) {
    if (!disc || !ctx.ui.isPickable(disc.kind, item)) return IDLE;
    store.begin(label ?? `Resize ${NOUN[disc.kind][0]}`);
  }
  let done = false, last = disc ? disc.r : 0;
  const close = (how) => {
    if (done) return;
    done = true;
    viewport?.readout?.(null);
    store[how]();
  };
  return {
    active: true,
    move(hit, ev) {
      if (done || !disc || hit.onGround === false) return;
      let r = Math.hypot(hit.x - disc.x, hit.z - disc.z);
      if (snapping(ctx, ev)) {
        const step = ctx.ui.snap.step > 0 ? ctx.ui.snap.step : 1;
        r = Math.round(r / step) * step;
      }
      r = qPos(clamp(r, disc.range));
      viewport?.readout?.(`r ${num(r)}`);
      if (r === last) return;
      last = r;
      // a region keeps its identity and gets a new shape object; a spawn and the start just get the number
      if (disc.kind === 'region') store.exec(cmd.set([item], { shape: { type: 'circle', x: item.shape.x, z: item.shape.z, r } }));
      else store.exec(cmd.set([item], { r }));
    },
    end() { close('commit'); },
    cancel() { close('cancel'); },
  };
}

// ---------------------------------------------------------------- create

// Adds one new item of `kind` built from `props` (cmd.make fills the defaults) as one undo step and selects it.
// -> the item
export function placeOnce(ctx, kind, props) {
  const { store, cmd } = ctx, item = cmd.make(kind, props);
  store.exec(cmd.add(kind, [item]));
  store.select([item]);
  return item;
}

// ---------------------------------------------------------------- keys on the selection

// The factor closest to f that keeps every scale and radius of the items inside LIMITS. An item that is already outside
// (an imported map) is never pushed further out, and never pulled in by a key that scales the other way.
function allowedFactor(ctx, items, f) {
  let lo = 0, hi = Infinity;
  for (const item of items) {
    const kind = ctx.store.kindOf(item);
    let v, range;
    if (kind === 'object') { v = item.s; range = LIMITS.scale; }
    else {
      const disc = discOf(ctx, item);
      if (!disc) continue;
      v = disc.r; range = disc.range;
    }
    if (!(v > 0)) continue;
    lo = Math.max(lo, range[0] / v);
    hi = Math.min(hi, range[1] / v);
  }
  return f > 1 ? Math.min(f, Math.max(hi, 1)) : Math.max(f, Math.min(lo, 1));
}

// A context action of the 'select' key context, applied to the selection (what of it may be edited):
//   rotate.ccw / rotate.cw   +15 / -15 degrees about the pivot (Shift 90, Alt 1)
//   scale.down / scale.up    x 0.9 / x 1.1 about the pivot
//   nudge.left / right / up / down   -X / +X / -Z / +Z by the snap step (Shift x 10)
//   axes.toggle              gizmo axes world <-> local
// With ui.axes === 'local' turning and scaling leave the positions alone: every item turns and grows on its own spot.
// Each key press is one undo step. -> true when the key was consumed; false leaves it to the next key table (an arrow
// with nothing selected pans the camera).
export function selectionKey(ctx, action, ev) {
  const { store, ui, cmd } = ctx;
  if (action === 'axes.toggle') {
    ui.set('axes', ui.axes === 'local' ? 'world' : 'local');
    ui.setStatus?.(`Gizmo axes: ${ui.axes}`);
    return true;
  }
  const dot = typeof action === 'string' ? action.indexOf('.') : -1;
  const verb = dot < 0 ? '' : action.slice(0, dot), way = dot < 0 ? '' : action.slice(dot + 1);
  if (verb !== 'rotate' && verb !== 'scale' && verb !== 'nudge') return false;
  if (!store.map || store.grouping) return false;   // a drag is in progress: its group must not swallow a key step
  const items = editable(ctx, store.selection);
  if (!items.length) return false;

  const pivot = pivotOf(ctx, items), individual = ui.axes === 'local', what = describe(ctx, items);
  let label, t;
  if (verb === 'rotate') {
    if (way !== 'ccw' && way !== 'cw') return false;
    const step = (ev?.shiftKey ? 90 : ev?.altKey ? 1 : 15) * DEG;
    label = `Rotate ${what}`;
    t = { rot: way === 'ccw' ? step : -step, pivot, individual };
  } else if (verb === 'scale') {
    if (way !== 'down' && way !== 'up') return false;
    const scale = allowedFactor(ctx, items, way === 'up' ? 1.1 : 0.9);
    if (scale === 1) {
      ui.setStatus?.('Scale limit reached');
      return true;
    }
    label = `Scale ${what}`;
    t = { scale, pivot, individual };
  } else {
    const step = (ui.snap.step > 0 ? ui.snap.step : 1) * (ev?.shiftKey ? 10 : 1);
    const d = { left: [-step, 0], right: [step, 0], up: [0, -step], down: [0, step] }[way];
    if (!d) return false;
    label = `Nudge ${what}`;
    t = { dx: d[0], dz: d[1], pivot };
  }
  store.begin(label);
  try {
    store.exec(cmd.transform(cmd.snapshot(items), t));
  } finally {
    store.commit();
  }
  return true;
}
