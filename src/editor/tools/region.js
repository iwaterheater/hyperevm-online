// The Region tool: draw regions - circles and polygons - and reshape the ones that are there.
//
// Idle, a press means the first of these that applies (what is under the cursor is decided by the viewport: hit.handle
// and hit.item; this file never picks by itself):
//   1. a handle of the SELECTED region  drag it: the rim of a circle resizes it, a vertex of a polygon moves, and the
//                                        knob in the middle of an edge first puts a new vertex there
//   2. an outline or a label             selects that region (Shift / Mod: toggles it); a drag from there moves it
//   3. inside the SELECTED region        a drag moves it; a click changes nothing
//   4. anything else                     creates, by mode. The inside of a region that is NOT selected is never a pick:
//                                        a region may cover the whole island, and it must still be possible to draw in it
//
// Circle mode: press at the centre, drag to the radius, release - one undo step. A click without a drag creates
// nothing and clears the selection.
// Polygon mode: the creating click is the first point and every further click adds one; nothing is picked while a
// polygon is being drawn. A click on the first point, Enter or a double-click closes it (three points or more),
// Backspace takes the last point back, Esc gives the polygon up. The polygon is not in the map until it is closed:
// closing it is ONE undo step, and until then undo, save and every panel work as if nothing was going on.
//
// The vertex that was pressed last is the ACTIVE one: Delete removes it (never below three points) instead of the
// region. Q E [ ] and the arrows turn, scale and nudge the selected regions like any other selection.
import * as THREE from 'three';
import { LIMITS, groundHalf } from '../../map/format.js';
import { h, row, button, checkField, selectField } from '../ui/dom.js';
import { mod, hintFor, chordLabel, keyText } from '../keymap.js';
import { SNAP_STEPS } from '../state.js';
import { dragTracker, dragMove, dragRadius, placeOnce, selectionKey, snapPoint, snapping, editable } from './common.js';
import { createLine, createDots, polygonArea, segmentLength } from './measure.js';

const MODES = ['circle', 'poly'];
const PICKS = ['region'], NO_PICKS = [];
const CLOSE_PX = 10;           // a click this close to the first point closes the polygon
const SAME_PX = 3;             // a click this close to the last point is the second half of a double-click
const MIN_POINTS = LIMITS.polyPoints[0], MAX_POINTS = LIMITS.polyPoints[1];
const LINE_COLOR = 0x8fd3ff, ACTIVE_COLOR = 0xffb84d, CLOSE_COLOR = 0x6dff9a;
const BUSY = 'Finish the current edit first';
const GAME_PREVIEW = 'Markers are hidden in the Game preview: switch the preview back to edit them';

const num = (v) => v.toFixed(2);
const copy = (points) => points.map((p) => [p[0], p[1]]);
const withHint = (text, action) => { const key = hintFor(action); return key ? `${text} (${key})` : text; };

// A circle as a polygon of the same size: enough corners that it still reads as round, few enough to edit by hand.
export function circleToPoints(shape) {
  const n = shape.r < 15 ? 12 : shape.r < 60 ? 16 : 24, points = [];
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2;
    points.push([shape.x + Math.cos(a) * shape.r, shape.z + Math.sin(a) * shape.r]);
  }
  return points;
}

// 'New region', 'New region 2', ... - the first name no region of the map has, so two new regions can be told apart
// in the list and in the zone banner before anybody has named them.
export function freshName(map) {
  const used = new Set(map.regions.map((r) => r.name));
  used.add(map.fallback.name);
  if (!used.has('New region')) return 'New region';
  for (let n = 2; ; n++) if (!used.has(`New region ${n}`)) return `New region ${n}`;
}

export default function create(ctx) {
  const { store, ui, cmd, viewport } = ctx;

  let mode = 'circle';   // what a press that hits nothing creates
  let poly = null;       // the polygon being drawn: { points: [[x, z], ...], cursor: [x, z] | null, held, closing }
  // The press in progress, from pointerDown to pointerUp:
  //   'press'   on a region; nothing decided yet (a click, or a drag below the threshold)
  //   'move'    the selection is dragged                    'radius'  the rim of a circle is dragged
  //   'vertex'  a vertex is dragged (`open`: its undo group is open - at once after an edge knob put the vertex there)
  //   'create'  a circle is being drawn (`drag` once the pointer has left the click threshold)
  //   'dead'    cancelled or refused with the button still down: the rest of the press is swallowed
  let gesture = null;
  let active = null;     // the active vertex: { region, index }
  let visuals = null;    // what activate() built: { group, path, closing, rubber, dots, first, knob }
  let cursor = '';       // the cursor this tool has set ('' = it has set none)
  let status = '';       // the status text this tool has set last
  let strip = null;      // the controls of the options strip
  let subs = [];         // what options() subscribed to; released in deactivate()

  // ---- small things

  const say = (text) => {
    if (ui.status !== text) ui.setStatus(text);
    status = text;
  };
  const point = (hit, ev) => { const p = snapPoint(ctx, hit.x, hit.z, ev); return [p.x, p.z]; };
  // The tool can outlive the lock of its layer (the lock is set while it is active): an edit must not.
  const layerOpen = () => { const l = ui.layers?.regions; return !l || (l.visible !== false && !l.locked); };
  const refuseLayer = () => ui.toast(`Layer ${ui.layers.regions.visible === false ? 'hidden' : 'locked'}: regions`, 'warn');
  // The Game preview shows the world as players see it: no outline is drawn and none is picked there, so a region
  // drawn or dragged in it could not be seen. The same refusal as the Spawn, Chest, NPC and Start tools give.
  const inGame = () => (viewport.preview ?? ui.preview) === 'game';
  // validate() wants a region within twice the ground's half size: a point at the horizon would make a map that cannot be saved
  const inReach = (x, z) => {
    const reach = LIMITS.regionReach * groundHalf(store.map.ground);
    return Math.abs(x) <= reach && Math.abs(z) <= reach;
  };
  const pxTo = (p, ev) => { const s = viewport.project(p[0], viewport.groundY(p[0], p[1]), p[1]); return Math.hypot(s.x - ev.clientX, s.y - ev.clientY); };

  function setCursor(next) {
    // '' hands the cursor back to the viewport (a handle, a locked layer, the crosshair of a path)
    if (next !== cursor) ui.setCursor(next);
    cursor = next;
  }

  const idleHint = () => (mode === 'circle'
    ? 'Region: drag from the centre to the radius. Drag a selected region, its rim or its points to change it'
    : 'Region: click the first point of a polygon. Drag a selected region, its rim or its points to change it');

  // ---- the active vertex

  function setActive(region, index) {
    const next = region ? { region, index } : null;
    if (next?.region === active?.region && next?.index === active?.index) return;
    active = next;
    draw();
    fillStrip();
  }

  // The vertex is still what it was: its region is a selected polygon of this map and has a point of that index.
  function checkActive() {
    if (!active) return;
    const { region, index } = active, s = region.shape;
    if (store.kindOf(region) !== 'region' || !store.selection.has(region) || s.type !== 'poly' || index >= s.points.length) setActive(null);
  }

  // ---- what is drawn

  function draw() {
    if (!visuals) return;
    const v = visuals, pts = poly ? poly.points : [];
    v.path.set(pts);
    v.dots.set(pts);
    const last = pts[pts.length - 1], to = poly && !poly.held ? poly.cursor : null;
    v.rubber.set(last && to ? [last, to] : []);
    // how the polygon would close from where the pointer is: faint, so it is not taken for an edge that is there
    const end = to ?? last;
    v.closing.set(pts.length >= 2 && end && end !== pts[0] ? [end, pts[0]] : []);
    v.first.set(poly?.closing ? [pts[0]] : []);
    const shape = active && !poly ? active.region.shape : null, at = shape?.type === 'poly' ? shape.points[active.index] : null;
    v.knob.set(at ? [at] : []);
    viewport.invalidate();
  }

  // ---- drawing a polygon

  function polyStatus() {
    const n = poly.points.length;
    say(`Polygon: ${n} point${n === 1 ? '' : 's'}. Click to add; ${n >= MIN_POINTS ? keyText('Enter, a double-click or the first point closes it') : `${MIN_POINTS - n} more to close`}; `
      + `${chordLabel('Backspace')} takes one back; Esc cancels`);
  }

  function polyReadout() {
    const pts = poly.points, to = poly.held ? null : poly.cursor, last = pts[pts.length - 1];
    if (!to || !last) { viewport.readout(null); return; }
    if (poly.closing) { viewport.readout('click to close'); return; }
    const lines = [`edge ${num(segmentLength(last, to))}`];
    if (pts.length >= 2) lines.push(`area ${polygonArea([...pts, to]).toFixed(1)}`);
    viewport.readout(lines.join('\n'));
  }

  function startPoly(ev, hit) {
    if (hit.onGround === false) return;
    const p = point(hit, ev);
    if (!inReach(p[0], p[1])) { ui.toast('Too far from the map for a region', 'warn'); return; }
    store.clearSelection();   // the handles of another region would only be in the way, and nothing is picked from here on
    poly = { points: [p], cursor: null, held: true, closing: false };
    setCursor('');            // a path has the viewport's crosshair
    polyStatus();
    fillStrip();
    draw();
  }

  function endPoly() {
    poly = null;
    viewport.readout(null);
    say(idleHint());
    fillStrip();
    draw();
  }

  // Closes the polygon: the region is added and selected as one undo step. -> whether it was
  function finishPoly() {
    if (!poly) return false;
    const points = copy(poly.points);
    if (points.length < MIN_POINTS) return false;   // nothing happens: the status line says how many points are missing
    if (polygonArea(points) < LIMITS.polyArea) {
      ui.toast(`A region must cover at least ${LIMITS.polyArea} square unit: move a point or add another`, 'warn');
      return false;
    }
    if (store.grouping) { ui.toast(BUSY, 'warn'); return false; }
    if (!layerOpen()) { refuseLayer(); return false; }
    if (inGame()) { ui.toast(GAME_PREVIEW, 'warn'); return false; }
    const region = placeOnce(ctx, 'region', { name: freshName(store.map), shape: { type: 'poly', points } });
    endPoly();
    ui.setNote(`Added the region "${region.name}": name it in the Regions panel`);
    return true;
  }

  function polyBack() {
    if (!poly) return;
    poly.points.pop();
    if (!poly.points.length) { endPoly(); return; }
    poly.closing = false;
    polyStatus();
    polyReadout();
    fillStrip();
    draw();
  }

  function polyPress(ev, hit) {
    if (hit.onGround === false) return;
    const pts = poly.points;
    if (pts.length >= MIN_POINTS && pxTo(pts[0], ev) <= CLOSE_PX) {
      finishPoly();
      gesture = { type: 'dead' };   // the release of this click belongs to nobody
      return;
    }
    const p = point(hit, ev), last = pts[pts.length - 1];
    poly.held = true;
    poly.cursor = null;
    // a double-click delivers its two clicks first: the second one must not add the same point again
    if (segmentLength(last, p) < 0.01 || pxTo(last, ev) < SAME_PX) { draw(); return; }
    if (pts.length >= MAX_POINTS) {
      ui.toast(`A polygon has at most ${MAX_POINTS} points: close it with ${chordLabel('Enter')}`, 'warn');
      return;
    }
    if (!inReach(p[0], p[1])) { ui.toast('Too far from the map for a region', 'warn'); return; }
    pts.push(p);
    polyStatus();
    fillStrip();
    draw();
  }

  function polyMove(ev, hit) {
    const pts = poly.points;
    if (hit.onGround === false) {
      if (poly.cursor) { poly.cursor = null; poly.closing = false; polyReadout(); draw(); }
      return;
    }
    const p = point(hit, ev);
    if (poly.held && (ev.buttons & 1)) {
      // the point just added follows the pointer until the button is released
      const i = pts.length - 1, before = pts[i - 1];
      if ((pts[i][0] === p[0] && pts[i][1] === p[1]) || (before && segmentLength(before, p) < 0.01) || !inReach(p[0], p[1])) return;
      pts[i] = p;
      viewport.readout(`${num(p[0])}, ${num(p[1])}`);
      draw();
      return;
    }
    poly.cursor = p;
    poly.closing = pts.length >= MIN_POINTS && pxTo(pts[0], ev) <= CLOSE_PX;
    polyReadout();
    draw();
  }

  // ---- reshaping

  // The polygon with one more vertex in the middle of edge `index`, inside the undo group that the drag of the new
  // vertex then goes on with. -> the index of the new vertex, or -1
  function insertVertex(region, index) {
    const pts = copy(region.shape.points), a = pts[index], b = pts[(index + 1) % pts.length];
    if (pts.length >= MAX_POINTS) {
      ui.toast(`A polygon has at most ${MAX_POINTS} points`, 'warn');
      return -1;
    }
    pts.splice(index + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    store.begin('Add region point');
    try {
      store.exec(cmd.set([region], { shape: { type: 'poly', points: pts } }));
    } catch (err) {
      store.cancel();
      throw err;
    }
    return index + 1;
  }

  function moveVertex(g, hit, ev) {
    if (hit.onGround === false) return;
    const s = g.region.shape;
    if (s.type !== 'poly' || g.index >= s.points.length) return;
    // the vertex keeps the offset it was grabbed with, unless it snaps: snapping is absolute
    const p = snapping(ctx, ev) ? point(hit, ev) : point({ x: hit.x + g.dx, z: hit.z + g.dz }, ev);
    viewport.readout(`${num(p[0])}, ${num(p[1])}`);
    if ((s.points[g.index][0] === p[0] && s.points[g.index][1] === p[1]) || !inReach(p[0], p[1])) return;
    const pts = copy(s.points);
    pts[g.index] = p;
    store.exec(cmd.set([g.region], { shape: { type: 'poly', points: pts } }));   // merges: the drag stays one small step
  }

  // Delete with a vertex active. -> true: the key was ours, whether a point went or the polygon is at its minimum
  function deleteVertex() {
    checkActive();
    if (!active) return false;
    const { region, index } = active, pts = region.shape.points;
    if (store.grouping) return true;
    if (!ui.isPickable('region', region)) { refuseLayer(); return true; }
    if (pts.length <= MIN_POINTS) {
      // refused, and not passed on: Delete would otherwise take the whole region when the user meant one point
      ui.toast(`A polygon needs at least ${MIN_POINTS} points. To delete the region, click inside it first`, 'warn');
      return true;
    }
    const next = copy(pts);
    next.splice(index, 1);
    store.begin('Delete region point');
    try {
      store.exec(cmd.set([region], { shape: { type: 'poly', points: next } }));
    } finally {
      store.commit();
    }
    // the neighbour takes over, so the next Delete goes on along the outline
    active = null;
    setActive(region, (index + next.length - 1) % next.length);
    return true;
  }

  // The selected circle becomes a polygon of the same size, which can then be reshaped point by point.
  function toPolygon() {
    const circles = editable(ctx, store.selected('region')).filter((r) => r.shape.type === 'circle');
    if (!circles.length) return;
    if (store.grouping) { ui.toast(BUSY, 'warn'); return; }
    store.begin(circles.length === 1 ? 'Convert a region to a polygon' : `Convert ${circles.length} regions to polygons`);
    try {
      for (const region of circles) store.exec(cmd.set([region], { shape: { type: 'poly', points: circleToPoints(region.shape) } }));
    } finally {
      store.commit();
    }
  }

  // ---- gestures

  // Was the region picked by its outline or its label - or by its inside, which only a selected region offers?
  // The markers are asked once more, this time without interiors; it is a question, nothing is changed.
  function byEdge(item, hit) {
    try {
      const stack = ctx.markers.stack({ x: hit.x, z: hit.z, onGround: hit.onGround }, hit.sx, hit.sy, { kinds: PICKS, interiors: 'none' });
      return stack.some((entry) => entry.item === item);
    } catch {
      return false;
    }
  }

  // The pointer left the click threshold on a region: the selection moves. (A Shift or Mod press on a region that is
  // not selected has nothing to move; on a selected one it is a move like any other - Mod inverts snapping.)
  function startMove(g) {
    const items = !store.selection.has(g.item) || store.grouping ? [] : editable(ctx, store.selection);
    const drag = items.length ? dragMove(ctx, items, g.start) : null;
    if (!drag?.active) { g.type = 'dead'; return; }
    g.drag = drag;
    g.type = 'move';
  }

  // ... on empty ground in circle mode: the region is added with the smallest radius and its rim follows the pointer,
  // both in one undo group - release commits it, Esc takes the region back.
  function startCircle(g, hit) {
    if (store.grouping) { ui.toast(BUSY, 'warn'); g.type = 'dead'; return; }
    store.begin('Add 1 region');   // the label a polygon gets from cmd.add
    try {
      const region = placeOnce(ctx, 'region', { name: freshName(store.map), shape: { type: 'circle', x: g.centre[0], z: g.centre[1], r: LIMITS.regionR[0] } });
      g.region = region;
      g.drag = dragRadius(ctx, region, hit);   // joins the open group
    } catch (err) {
      store.cancel();
      g.type = 'dead';
      throw err;
    }
  }

  // Takes back whatever the press in progress has done. -> whether there was one worth the name
  function abort() {
    const g = gesture;
    gesture = null;
    if (!g) return false;
    viewport.readout(null);
    if (g.drag) g.drag.cancel();                       // a move, a rim, a circle being drawn: the whole group goes
    else if (g.open && store.grouping) store.cancel();   // a vertex drag, with the vertex an edge knob has put there
    return g.type !== 'dead';
  }

  function hover(hit) {
    if (!layerOpen()) { setCursor(''); return; }   // the viewport shows "not allowed"
    if (inGame()) { setCursor('not-allowed'); say(GAME_PREVIEW); return; }
    if (status === GAME_PREVIEW) say(idleHint());  // the preview is back
    if (hit.handle) setCursor('');                 // ... and its own pointer over a handle
    else if (hit.item) setCursor(store.selection.has(hit.item) ? 'move' : 'pointer');
    else setCursor('crosshair');                   // a press here draws
  }

  // ---- the options strip

  function fillStrip() {
    if (!strip) return;
    const drawing = !!poly, n = poly ? poly.points.length : 0;
    strip.circle.classList.toggle('active', mode === 'circle');
    strip.poly.classList.toggle('active', mode === 'poly');
    strip.circle.setAttribute('aria-pressed', String(mode === 'circle'));
    strip.poly.setAttribute('aria-pressed', String(mode === 'poly'));
    strip.close.hidden = strip.back.hidden = strip.cancel.hidden = !drawing;
    strip.close.disabled = n < MIN_POINTS;
    const circles = drawing ? 0 : editable(ctx, store.selected('region')).filter((r) => r.shape.type === 'circle').length;
    strip.toPoly.hidden = circles === 0;
    strip.delPoint.hidden = drawing || !active;
    strip.delPoint.disabled = !!active && active.region.shape.type === 'poly' && active.region.shape.points.length <= MIN_POINTS;
    strip.hint.textContent = drawing ? `${n} point${n === 1 ? '' : 's'}`
      : !layerOpen() ? 'The Regions layer is locked or hidden'
        : active ? `Point ${active.index + 1} of ${active.region.shape.points.length} is active`
          : mode === 'circle' ? 'Drag from the centre to the radius' : 'Click the points of the polygon';
  }

  // ---- the store

  store.on('load', () => {   // the items of the old map are gone
    poly = null;
    gesture = null;
    active = null;
    if (visuals) { say(idleHint()); fillStrip(); draw(); }
  });
  store.on('selection', () => {
    checkActive();
    fillStrip();
  });
  store.on('change', (change) => {
    if (!active) return;
    // undo and redo may have put another outline there: an index says nothing about it
    const touched = change.updated.regions.includes(active.region) || change.removed.regions.includes(active.region);
    if (touched && change.origin !== 'do') setActive(null);
    else { checkActive(); draw(); fillStrip(); }
  });

  const tool = {
    id: 'region', label: 'Region', icon: '⬡', layer: 'regions', hidden: false,
    about: 'Named zones with levels, a mood and safety: draw a circle or a polygon',
    get intro() { return idleHint(); },
    // nothing is picked while a polygon is being drawn: every click is a point, and no region lights up under the cursor
    get picks() { return poly ? NO_PICKS : PICKS; },
    get context() { return poly ? 'path' : 'select'; },

    get mode() { return mode; },
    setMode(next) {
      if (!MODES.includes(next)) throw new TypeError(`region.setMode: expected one of ${MODES.join(', ')}`);
      if (next === mode) return;
      if (abort()) gesture = { type: 'dead' };
      mode = next;
      if (poly) endPoly();   // a polygon in progress belongs to the mode that is left
      else if (visuals) say(idleHint());
      fillStrip();
    },

    // For scripts and checks: the polygon being drawn and the active vertex, as plain data.
    get drawing() { return poly ? copy(poly.points) : null; },
    get activeVertex() { return active ? { region: active.region, index: active.index } : null; },

    activate() {
      const group = new THREE.Group();
      group.name = 'region-tool';
      const height = viewport.groundY;   // the preview lies on the hills, like the outline it becomes
      const path = createLine(LINE_COLOR, { height }), closing = createLine(LINE_COLOR, { width: 1.5, opacity: 0.4, height });
      const rubber = createLine(LINE_COLOR, { width: 1.5, opacity: 0.75, height });
      const dots = createDots(0xffffff, { height }), first = createDots(CLOSE_COLOR, { size: 18, height }), knob = createDots(ACTIVE_COLOR, { size: 15, height });
      group.add(closing.object, path.object, rubber.object, dots.object, first.object, knob.object);
      viewport.overlay.add(group);
      visuals = { group, path, closing, rubber, dots, first, knob };
      say(idleHint());
      draw();
    },

    deactivate() {
      abort();
      poly = null;
      active = null;
      if (visuals) {
        for (const part of [visuals.path, visuals.closing, visuals.rubber, visuals.dots, visuals.first, visuals.knob]) part.dispose();
        visuals.group.removeFromParent();
        visuals = null;
      }
      for (const off of subs) off?.();
      subs = [];
      strip = null;
      viewport.readout(null);
      if (cursor) ui.setCursor('');
      cursor = '';
      if (status && ui.status === status) ui.setStatus('');
      status = '';
      viewport.invalidate();
    },

    pointerDown(ev, hit) {
      if (gesture) abort();   // a press whose release never came
      if (!store.map) return;
      if (!layerOpen()) {
        refuseLayer();
        gesture = { type: 'dead' };
        return;
      }
      if (inGame()) {
        ui.toast(GAME_PREVIEW, 'warn');
        gesture = { type: 'dead' };
        return;
      }
      if (poly) { polyPress(ev, hit); return; }

      const handle = hit.handle, item = hit.item ?? null, toggle = !!(ev.shiftKey || mod(ev));
      // (with Shift a press is about the selection: the rim of a selected circle is one long handle, and without this
      // rule such a region could never be taken out of the selection again. Mod stays with the drag: it inverts snapping)
      if (handle && item && !ev.shiftKey) {
        if (store.grouping) { ui.toast(BUSY, 'warn'); gesture = { type: 'dead' }; return; }
        if (handle.type === 'radius') {
          setActive(null);
          const drag = dragRadius(ctx, item, hit);
          gesture = drag.active ? { type: 'radius', drag } : { type: 'dead' };
        } else if (handle.type === 'vertex' || handle.type === 'edge') {
          const fresh = handle.type === 'edge', index = fresh ? insertVertex(item, handle.index) : handle.index;
          if (index < 0) { gesture = { type: 'dead' }; return; }
          const p = item.shape.points[index];
          setActive(item, index);
          gesture = { type: 'vertex', region: item, index, open: fresh, dx: p[0] - hit.x, dz: p[1] - hit.z, tracker: dragTracker(ev) };
        } else gesture = { type: 'dead' };
        return;
      }
      setActive(null);
      if (item) {
        const selected = store.selection.has(item);
        // on the outline of one of SEVERAL selected regions a click takes that one alone; inside, a click changes nothing
        const alone = !toggle && selected && store.selection.size > 1 && byEdge(item, hit);
        if (!toggle && !selected) store.select([item]);   // at once: a drag from here moves it
        gesture = { type: 'press', item, toggle, alone, start: { x: hit.x, z: hit.z }, tracker: dragTracker(ev) };
        return;
      }
      // no pick: create
      if (mode === 'poly') {
        startPoly(ev, hit);   // from here on `poly` owns the pointer: the rest of this press drags the first point
        return;
      }
      if (hit.onGround === false) { gesture = { type: 'dead' }; return; }
      const centre = point(hit, ev);
      if (!inReach(centre[0], centre[1])) {
        ui.toast('Too far from the map for a region', 'warn');
        gesture = { type: 'dead' };
        return;
      }
      gesture = { type: 'create', centre, tracker: dragTracker(ev) };
    },

    // Every pointer move, with or without the button.
    pointerMove(ev, hit) {
      if (poly) { polyMove(ev, hit); return; }
      const g = gesture;
      if (!g) { hover(hit); return; }
      if (g.type === 'press') {
        if (!g.tracker.moved(ev)) return;
        startMove(g);
      }
      if (g.type === 'move' || g.type === 'radius') g.drag.move(hit, ev);
      else if (g.type === 'vertex') {
        if (!g.open) {
          if (!g.tracker.moved(ev)) return;
          if (store.grouping) { g.type = 'dead'; return; }
          store.begin('Move region point');
          g.open = true;
        }
        moveVertex(g, hit, ev);
      } else if (g.type === 'create') {
        if (!g.drag) {
          if (!g.tracker.moved(ev)) return;
          startCircle(g, hit);
          if (!g.drag) return;
        }
        g.drag.move(hit, ev);
      }
    },

    pointerUp() {
      if (poly) {
        poly.held = false;
        if (gesture?.type === 'dead') gesture = null;
        return;
      }
      const g = gesture;
      gesture = null;
      if (!g) return;
      viewport.readout(null);
      if (g.type === 'press') {
        if (g.toggle) store.select([g.item], { toggle: true });
        else if (g.alone) store.select([g.item]);
      } else if (g.type === 'move' || g.type === 'radius') g.drag.end();
      else if (g.type === 'vertex') {
        if (g.open && store.grouping) store.commit();
      } else if (g.type === 'create') {
        if (g.drag) {
          g.drag.end();
          if (store.kindOf(g.region) === 'region') ui.setNote(`Added the region "${g.region.name}": name it in the Regions panel`);
        } else store.clearSelection();   // a click on nothing
      }
    },

    // The two clicks came first: the first one added a point, the second one was dropped as its double.
    doubleClick() {
      if (poly && poly.points.length >= MIN_POINTS) finishPoly();
    },

    key(action, ev) {
      if (poly) {
        if (action === 'path.back') { polyBack(); return true; }
        if (action === 'path.commit') { finishPoly(); return true; }   // fewer than three points: nothing happens, and the key is still ours
        if (action === 'cancel') { endPoly(); return true; }
        return false;
      }
      if (action === 'cancel') {
        const cancelled = abort();
        if (cancelled) gesture = { type: 'dead' };   // the button is still down: its moves and its release are no new press
        return cancelled;
      }
      if (gesture) return false;                     // no turning or deleting in the middle of a press
      if (action === 'selection.delete') return deleteVertex();   // false without an active vertex: edit.delete takes the region
      return selectionKey(ctx, action, ev);                       // which leaves alone what a locked layer protects
    },

    // every rendered frame: a line width is measured against the size of the canvas
    update() {
      if (!visuals) return;
      const w = viewport.dom.clientWidth, hgt = viewport.dom.clientHeight;
      for (const part of [visuals.path, visuals.closing, visuals.rubber]) part.resolution(w, hgt);
    },

    options(el) {
      for (const off of subs) off?.();
      const node = (x) => x?.el ?? x;
      const key = (chord) => h('kbd', { class: 'ui-kbd' }, chordLabel(chord));
      const snapOn = checkField({ value: ui.snap.on, onCommit: (on) => ui.set('snap', { ...ui.snap, on }) });
      const snapStep = selectField({
        value: ui.snap.step, options: SNAP_STEPS.map((value) => ({ value, label: String(value) })),
        onCommit: (step) => ui.set('snap', { ...ui.snap, step }),
      });
      strip = {
        circle: button('Circle', () => tool.setMode('circle'), { title: 'Press at the centre, drag to the radius' }),
        poly: button('Polygon', () => tool.setMode('poly'), { title: keyText('Click the points; Enter, a double-click or the first point closes the polygon') }),
        close: button(['Close', key('Enter')], () => finishPoly(), { title: 'Close the polygon: it becomes a region' }),
        back: button(['Undo point', key('Backspace')], polyBack, { title: 'Take the last point back' }),
        cancel: button(['Cancel', key('Escape')], endPoly, { title: 'Give the polygon up' }),
        toPoly: button('To polygon', toPolygon, { title: 'Turn the selected circle into a polygon that can be reshaped point by point' }),
        delPoint: button(['Delete point', key('Backspace')], deleteVertex, { title: 'Remove the active point of the polygon', danger: true }),
        hint: h('span', { class: 'ui-hint' }),
      };
      el.append(
        row('Shape', h('span', { class: 'ui-group' }, strip.circle, strip.poly)),
        row(withHint('Snap', 'snap.toggle'), h('span', null, node(snapOn), node(snapStep))),
        h('div', { class: 'ui-row' }, strip.close, strip.back, strip.cancel, strip.toPoly, strip.delPoint),
        strip.hint,
      );
      fillStrip();
      subs = [
        ui.on('snap', () => { snapOn.set(ui.snap.on); snapStep.set(ui.snap.step); }),
        ui.on('layers', fillStrip),
        store.on('change', (change) => { if (change.updated.regions.length || change.added.regions.length || change.removed.regions.length) fillStrip(); }),
      ];
    },
  };
  return tool;
}
