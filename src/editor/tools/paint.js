// The Terrain tool: paints ground types onto the vertex grid of the map.
//
//   Brush   drag to paint. Hard: every vertex inside the radius. Soft: the outer 40 % is dithered away.
//           Shift+click: a straight stroke from where the last stroke ended.
//   Road    click the points of a polyline, Enter or a double-click paints it as a ribbon of the chosen width
//           (optionally clearing the scenery that stands in the way), Backspace takes the last point back.
//   Fill    click: flood-fills the connected area of one ground type, never beyond the island's radius.
//           "Fill selected region" paints everything inside the selected region's shape.
//   Alt+click picks the ground type under the cursor (in every mode).  1 - 9 choose a ground type.
//   [ ]  radius (Road: width)     Shift+[  Shift+]  soft / hard edge
//
// Which vertices a gesture covers is decided by the pure raster.js; this file turns pointer events into cmd.paint.
// A brush stroke is ONE undo step: store.begin on the press, one cmd.paint per pointer move (they merge), commit on
// release. A road, a fill and a region fill are one step each. Nothing here writes to the map or to the view directly.
import * as THREE from 'three';
import { GROUND_TYPES, cellIndex, groundX } from '../../map/format.js';
import { colliderOf, modelInfo } from '../../map/catalog.js';
import { h, row, button, checkField, numberField, rangeField } from '../ui/dom.js';
import { chordLabel, keyText } from '../keymap.js';
import { snapPoint } from './common.js';
import { SOFT_CORE, capsule, flood, inside, ribbon } from '../raster.js';

const MODES = ['brush', 'road', 'fill'];
const MODE_LABEL = { brush: 'Brush', road: 'Road', fill: 'Fill' };
// what a mode does, as the tooltip of its button; and the few words that fit on the strip
// (keys are named through keyText: one key has one name on the whole screen)
const MODE_HELP = {
  brush: keyText('Drag to paint. Shift+click paints a straight stroke from the end of the last one. Alt+click picks the ground type under the cursor.'),
  road: keyText('Click the points of the road, then press Enter or double-click to paint it. Backspace removes the last point, Esc drops them all.'),
  fill: keyText('Click to fill the connected area of one ground type, never beyond the radius of the island. Alt+click picks the ground type under the cursor.'),
};
// ... and the one line the status bar holds while the tool rests
const MODE_REST = {
  brush: keyText('drag to paint · Shift+click: a straight stroke from the last · Alt+click: pick the type'),
  road: keyText('click the points, Enter or double-click paints it · Backspace: one point back · Esc: drop them'),
  fill: keyText('click fills the connected area of one ground type · Alt+click: pick the type'),
};
const MODE_HINT = {
  brush: keyText('Drag: paint · Shift+click: straight stroke · Alt+click: pick type'),
  road: keyText('Click: add a point · Enter / double-click: paint · Backspace: one back'),
  fill: keyText('Click: fill the connected area · Alt+click: pick type'),
};
const RADIUS = [1, 40], WIDTH = [2, 12];
// A brush is never smaller than this share of a ground cell: half the diagonal of a cell, so that a dab always holds
// at least the vertex nearest to the cursor (a radius of 1 on a grid of 2 would otherwise paint nothing between vertices).
const MIN_REACH = 0.7072;
const POINT_GAP = 0.01;           // a road point closer than this to the previous one is dropped (a double-click)
const RUNS_MAX = 16384;           // preview quads; a run is a row of neighbouring vertices
const BLOCK = GROUND_TYPES.map((t) => t.block === true);
// like every ground overlay of the editor: tested against the scene, never written, pulled towards the eye
const GROUND_OVERLAY = { depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false };

const clamp = (v, [min, max]) => Math.max(min, Math.min(max, v));
const count = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const shortName = (type) => GROUND_TYPES[type].name.replace(/\s*\(.*\)$/, '');   // 'Lawn (grass without foliage)' -> 'Lawn'
const css = (hex) => `#${hex.toString(16).padStart(6, '0')}`;

// ---------------------------------------------------------------- geometry of "what stands on the road"

function pointSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

// The distance between the segment a - b and a box collider { x, z, hw, hd, ry }; 0 when they touch.
function segmentBox(box, ax, az, bx, bz) {
  const cos = Math.cos(box.ry), sin = Math.sin(box.ry);
  // into the frame of the box, where it is an axis-aligned rectangle around the origin
  const lx = (x, z) => (x - box.x) * cos - (z - box.z) * sin, lz = (x, z) => (x - box.x) * sin + (z - box.z) * cos;
  const a0 = lx(ax, az), a1 = lz(ax, az), b0 = lx(bx, bz), b1 = lz(bx, bz);
  // does the segment cross the rectangle? (clipped against its two slabs)
  let t0 = 0, t1 = 1, crosses = true;
  for (const [a, d, half] of [[a0, b0 - a0, box.hw], [a1, b1 - a1, box.hd]]) {
    if (Math.abs(d) < 1e-12) { if (Math.abs(a) > half) crosses = false; continue; }
    const near = (-half - a) / d, far = (half - a) / d;
    t0 = Math.max(t0, Math.min(near, far));
    t1 = Math.min(t1, Math.max(near, far));
  }
  if (crosses && t0 <= t1) return 0;
  // two convex shapes that do not touch are nearest at a corner of one of them
  const toRect = (x, z) => Math.hypot(Math.max(Math.abs(x) - box.hw, 0), Math.max(Math.abs(z) - box.hd, 0));
  let best = Math.min(toRect(a0, a1), toRect(b0, b1));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) best = Math.min(best, pointSegment(sx * box.hw, sz * box.hd, a0, a1, b0, b1));
  return best;
}

// Is index `i` in the ascending list?
function contains(sorted, i) {
  let lo = 0, hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] === i) return true;
    if (sorted[mid] < i) lo = mid + 1; else hi = mid - 1;
  }
  return false;
}

export default function create(ctx) {
  const { store, ui, cmd } = ctx;

  // What the options strip shows and what scripts may set: read at every use.
  const opts = { radius: 4, soft: false, width: 4, clearScenery: false };
  let mode = 'brush';
  let active = false;
  let stroke = null;       // a brush stroke between press and release: { type, seed, last: { x, z }, flooded, dead }
  let strokes = 0;         // the seed of the next soft stroke: one dither pattern per stroke
  let lastEnd = null;      // { x, z } where the previous brush stroke ended: Shift+click continues from there
  let road = [];           // [[x, z], ...] the points of the road being drawn
  let hover = null;        // the cursor on the ground: { x, z, ix, iz, px, pz (snapped), shift }
  let filled = null;       // the last flood: { ground, radius, indices } - hovering inside it needs no second flood
  let said = null;         // the status text this tool wrote last
  let told = -1;           // Fill: the vertex the hover text was written for (-1: none), so a click's result is not overwritten at once
  let strip = null, widgets = null, subs = [];
  let shown = '';          // what the strip shows of opts (compared every frame: keys and scripts change opts)
  let cells = null, line = null, dots = null;   // the preview objects in viewport.overlay
  let previewKey = null;   // what the cell preview shows: the indices it was built from, and the type

  const typeNow = () => (Number.isInteger(ui.groundType) && ui.groundType >= 0 && ui.groundType < GROUND_TYPES.length ? ui.groundType : 0);
  const reach = (r, ground) => Math.max(r, ground.cell * MIN_REACH);
  const radiusNow = (ground) => reach(clamp(Number(opts.radius) || RADIUS[0], RADIUS), ground);
  const widthNow = (ground) => 2 * reach(clamp(Number(opts.width) || WIDTH[0], WIDTH) / 2, ground);
  const layerOpen = (layer) => { const l = ui.layers?.[layer]; return !l || (l.visible !== false && !l.locked); };

  // The status line is what stays true while the tool is in this state: what a click would do (Fill), how far a road
  // has got - and otherwise the instruction of the mode, so the bar always says what a click or a drag does here.
  // What has just happened ("Filled 40 cells", "Road cancelled") is a note: the bar shows it and takes it away again.
  const resting = () => `Terrain \u00b7 ${MODE_LABEL[mode]}: ${MODE_REST[mode]}`;
  function say(text) {
    said = text;
    ui.setStatus(text);
  }
  function hush() {
    if (active) say(resting());
    else {
      if (said !== null && ui.status === said) ui.setStatus('');
      said = null;
    }
  }
  const note = (text) => ui.setNote(text);
  // The tool was switched to while its layer was open, and the layer was closed afterwards: it says so and does nothing.
  function refused() {
    if (layerOpen('ground')) return false;
    ui.toast(`Layer ${ui.layers.ground.visible ? 'locked' : 'hidden'}: ground`, 'warn');
    return true;
  }
  function busy() {
    if (!store.grouping) return false;
    ui.toast('Finish the current edit first', 'warn');
    return true;
  }

  // ---------------------------------------------------------------- what a paint leaves standing in the water

  // The cells of `indices` that do not block yet go into `into`: after the paint they are the newly blocked ground.
  function noteFlooded(indices, into) {
    const g = store.map.ground.cells;
    for (let k = 0; k < indices.length; k++) if (!BLOCK[g[indices[k]]]) into.add(indices[k]);
  }
  function warnFlooded(flooded) {
    if (!flooded?.size) return;
    const map = store.map, g = map.ground;
    const on = (p) => { const i = cellIndex(g, p.x, p.z); return i >= 0 && flooded.has(i); };
    let objects = 0, markers = on(map.start) ? 1 : 0;
    for (const o of map.objects) if (on(o)) objects++;
    for (const list of [map.spawns, map.chests, map.npcs]) for (const item of list) if (on(item)) markers++;
    if (!objects && !markers) return;
    // (the Issues panel has one row for the objects - a click on it selects them all - and one per marker)
    const what = [objects ? count(objects, 'object') : '', markers ? count(markers, 'marker') : ''].filter(Boolean).join(' and ');
    const text = `${what} now stand${objects + markers === 1 ? 's' : ''} on blocked ground`;
    const open = ctx.actions?.has('validation.open') ? { label: 'Issues', run: () => ctx.actions.run('validation.open') } : null;
    ui.toast(open ? { text, action: open } : text, 'warn');
  }

  // ---------------------------------------------------------------- brush strokes

  function paintSegment(x0, z0, x1, z1) {
    const s = stroke, g = store.map.ground;
    const indices = capsule(g, x0, z0, x1, z1, radiusNow(g), opts.soft ? s.seed : null);
    if (!indices.length) return;
    if (s.flooded) noteFlooded(indices, s.flooded);
    store.exec(cmd.paint(indices, s.type));
  }

  function startStroke(ev, hit) {
    if (busy() || !hit.onGround) return;
    const type = typeNow();
    store.begin(`Paint ${shortName(type).toLowerCase()}`);
    stroke = { type, seed: ++strokes, last: { x: hit.x, z: hit.z }, flooded: BLOCK[type] ? new Set() : null, dead: false };
    try {
      const from = ev.shiftKey && lastEnd ? lastEnd : stroke.last;
      paintSegment(from.x, from.z, hit.x, hit.z);
    } catch (err) {
      abortStroke();
      throw err;
    }
  }

  function extendStroke(hit) {
    const s = stroke;
    if (!s || s.dead || !hit.onGround) return;
    if (!store.grouping) { s.dead = true; return; }   // the group was closed under the stroke (a new map came in)
    if (hit.x === s.last.x && hit.z === s.last.z) return;
    paintSegment(s.last.x, s.last.z, hit.x, hit.z);
    s.last = { x: hit.x, z: hit.z };
  }

  // Takes the stroke back. The button may still be down: the rest of the gesture is swallowed.
  function abortStroke() {
    if (!stroke || stroke.dead) return false;
    stroke.dead = true;
    if (store.grouping) store.cancel();
    return true;
  }

  function endStroke(hit) {
    const s = stroke;
    if (!s) return;
    try {
      if (!s.dead) extendStroke(hit);
    } finally {
      stroke = null;
      if (!s.dead) {
        const kept = store.grouping && store.commit();
        lastEnd = s.last;
        if (kept) warnFlooded(s.flooded);
      }
    }
  }

  // ---------------------------------------------------------------- one-step paints: fill, region, road

  // Paints `indices` (and removes `doomed` objects) as one undo step. -> the number of cells that changed
  function paintOnce(label, indices, type, doomed = []) {
    const g = store.map.ground.cells, flooded = BLOCK[type] ? new Set() : null;
    let n = 0;
    for (let k = 0; k < indices.length; k++) if (g[indices[k]] !== type) n++;
    if (flooded) noteFlooded(indices, flooded);
    store.begin(label);
    let kept = false;
    try {
      if (n) store.exec(cmd.paint(indices, type));
      if (doomed.length) store.exec(cmd.remove(doomed));
    } finally {
      kept = store.commit();
    }
    if (kept) warnFlooded(flooded);
    return n;
  }

  // The flood from a vertex, limited to the island. Hovering over the area it found asks for no second flood.
  function floodAt(index) {
    const map = store.map, g = map.ground;
    if (!filled || filled.ground !== g || filled.radius !== map.radius || !contains(filled.indices, index)) {
      filled = { ground: g, radius: map.radius, indices: flood(g, index, { radius: map.radius }) };
    }
    return filled.indices;
  }

  function fillAt(hit) {
    if (busy()) return;
    const map = store.map, g = map.ground, type = typeNow();
    if (hit.ix < 0) { note('Fill: the cursor is off the ground'); return; }
    const index = hit.iz * g.size + hit.ix, area = floodAt(index);
    if (!area.length) { note('Fill: outside the island - the shore is painted with the brush'); return; }
    if (g.cells[index] === type) { note(`Fill: nothing to do - this area is ${shortName(type)} already`); return; }
    const from = shortName(g.cells[index]);
    const n = paintOnce(`Fill with ${shortName(type).toLowerCase()}`, area, type);
    note(`Filled ${count(n, 'cell')}: ${from} to ${shortName(type)}`);
  }

  function fillRegions() {
    if (!store.map || refused() || busy()) return;
    const regions = store.selected('region'), g = store.map.ground, type = typeNow();
    if (!regions.length) { note('Fill region: select a region first (the Regions panel, or its outline with the Select tool)'); return; }
    const parts = regions.map((r) => inside(g, r.shape));
    const all = parts.length === 1 ? parts[0] : Int32Array.from(new Set(parts.flatMap((p) => [...p])));
    const n = paintOnce(regions.length === 1 ? 'Fill region' : `Fill ${regions.length} regions`, all, type);
    const what = regions.length === 1 ? `"${regions[0].name}"` : count(regions.length, 'region');
    note(n ? `Filled ${what} with ${shortName(type)}: ${count(n, 'cell')}` : `${what}: nothing to paint, it is ${shortName(type)} already`);
  }

  // The pickable objects whose collider comes within `margin` of the road's centre line.
  function sceneryOn(points, margin) {
    const map = store.map, view = ctx.view, infos = new Map(), out = [];
    const info = (id) => { if (!infos.has(id)) infos.set(id, modelInfo(id)); return infos.get(id); };
    const segments = points.length === 1 ? [[points[0], points[0]]] : points.slice(1).map((p, i) => [points[i], p]);
    for (const obj of map.objects) {
      if (!ui.isPickable('object', obj)) continue;      // a locked layer and a hidden model are never cleared
      const col = colliderOf(obj, info(obj.m), view.footprint(obj.m));
      if (!col.circles.length && !col.boxes.length) continue;
      let near = false;
      for (const [a, b] of segments) {
        for (const c of col.circles) if (pointSegment(c.x, c.z, a[0], a[1], b[0], b[1]) - c.r <= margin) { near = true; break; }
        if (!near) for (const box of col.boxes) if (segmentBox(box, a[0], a[1], b[0], b[1]) <= margin) { near = true; break; }
        if (near) break;
      }
      if (near) out.push(obj);
    }
    return out;
  }

  function addRoadPoint(ev, hit) {
    if (!hit.onGround) return;
    if (hit.ix < 0) { note('Road: this point is off the ground'); return; }
    const p = snapPoint(ctx, hit.x, hit.z, ev), prev = road[road.length - 1];
    if (prev && Math.hypot(p.x - prev[0], p.z - prev[1]) < POINT_GAP) return;
    road.push([p.x, p.z]);
    roadChanged();
  }

  // The points of the road changed (or what the road will do to the scenery): strip, status and preview follow.
  function roadChanged() {
    ui.setNote('');          // what was said about the road before this point is over
    syncStrip(true);
    if (road.length) {
      // with "Clear scenery" on, the status says before the commit how much stands in the way
      const doomed = opts.clearScenery && layerOpen('objects') ? sceneryOn(road, widthNow(store.map.ground) / 2 + 1).length : 0;
      const way = doomed ? `, ${count(doomed, 'object')} will be cleared` : '';
      say(`Road: ${count(road.length, 'point')}${way} - ${chordLabel('Enter')} or double-click paints it, ${chordLabel('Backspace')} removes the last point`);
    } else hush();
    refresh();
  }

  function commitRoad() {
    if (!road.length || !store.map) return false;
    if (refused() || busy()) return true;
    const map = store.map, g = map.ground, type = typeNow(), width = widthNow(g), points = road;
    const doomed = opts.clearScenery ? sceneryOn(points, width / 2 + 1) : [];
    const n = paintOnce('Paint road', ribbon(g, points, width), type, doomed);
    road = [];
    syncStrip(true);
    refresh();
    const kept = opts.clearScenery && !layerOpen('objects') ? ` (objects layer ${ui.layers.objects.visible ? 'locked' : 'hidden'}: scenery kept)` : '';
    const cleared = doomed.length ? `, ${count(doomed.length, 'object')} cleared` : kept;
    hush();
    note(n || doomed.length ? `Road painted (${shortName(type)}): ${count(n, 'cell')}${cleared}` : `Road: nothing to paint, it is ${shortName(type)} already`);
    return true;
  }

  function cancelRoad() {
    if (!road.length) return false;
    road = [];
    syncStrip(true);
    refresh();
    hush();
    note('Road cancelled');
    return true;
  }

  function pickType(hit) {
    const g = store.map.ground;
    if (hit.ix < 0) { note('The cursor is off the ground'); return; }
    const type = g.cells[hit.iz * g.size + hit.ix];
    ui.set('groundType', type);
    note(`Ground type: ${GROUND_TYPES[type].name}`);
  }

  // ---------------------------------------------------------------- preview: the cells a gesture would paint

  function ensurePreview() {
    if (cells) return;
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, ...GROUND_OVERLAY });
    cells = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), material, 256);
    cells.frustumCulled = false;   // spread over the map
    cells.renderOrder = 2;
    cells.count = 0;
    cells.visible = false;
    const onTop = { depthTest: false, depthWrite: false, transparent: true, toneMapped: false };
    line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, opacity: 0.9, ...onTop }));
    line.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(64 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    dots = new THREE.Points(line.geometry, new THREE.PointsMaterial({ color: 0xffffff, size: 7, sizeAttenuation: false, ...onTop }));
    line.frustumCulled = dots.frustumCulled = false;
    line.renderOrder = dots.renderOrder = 998;
    line.visible = dots.visible = false;
  }

  // Shows `indices` (ascending, as raster.js returns them) as translucent quads in the colour of the type; null hides.
  // Neighbours in a row share one quad, so a fill of half the island is a few hundred instances.
  function showCells(indices, type) {
    if (!indices || !indices.length || !active) {
      if (cells?.visible) { cells.visible = false; ctx.viewport.invalidate(); }
      previewKey = null;
      return;
    }
    if (previewKey && previewKey.indices === indices && previewKey.type === type) return;
    previewKey = { indices, type };
    const g = store.map.ground, { size, cell } = g, runs = [];
    for (let k = 0; k < indices.length && runs.length < RUNS_MAX * 3;) {
      const first = indices[k];
      let n = 1;
      while (k + n < indices.length && indices[k + n] === first + n && (first + n) % size !== 0) n++;
      runs.push(first % size, Math.floor(first / size), n);
      k += n;
    }
    const total = runs.length / 3;
    if (cells.instanceMatrix.count < total) {
      const grown = new THREE.InstancedMesh(cells.geometry, cells.material, THREE.MathUtils.ceilPowerOfTwo(total));
      grown.frustumCulled = false;
      grown.renderOrder = cells.renderOrder;
      const parent = cells.parent;
      cells.removeFromParent();
      cells.dispose();
      cells = grown;
      parent?.add(cells);
    }
    const a = cells.instanceMatrix.array;
    for (let i = 0, o = 0; i < total; i++, o += 16) {
      const ix = runs[i * 3], iz = runs[i * 3 + 1], n = runs[i * 3 + 2];
      a.fill(0, o, o + 16);
      a[o] = n * cell; a[o + 5] = 1; a[o + 10] = cell; a[o + 15] = 1;
      a[o + 12] = groundX(g, ix) + (n - 1) * cell / 2;
      a[o + 14] = groundX(g, iz);
    }
    cells.count = total;
    cells.instanceMatrix.needsUpdate = true;
    cells.material.color.setHex(GROUND_TYPES[type].b);
    cells.visible = true;
    ctx.viewport.invalidate();
  }

  // The centre line of the road through its points and on to the cursor; `fixed` of them get a dot.
  function showLine(points, fixed) {
    if (!line) return;
    const on = active && points.length > 0;
    if (!on) {
      if (line.visible || dots.visible) { line.visible = dots.visible = false; ctx.viewport.invalidate(); }
      return;
    }
    let attr = line.geometry.attributes.position;
    if (attr.count < points.length) {
      attr = new THREE.BufferAttribute(new Float32Array(THREE.MathUtils.ceilPowerOfTwo(points.length) * 3), 3).setUsage(THREE.DynamicDrawUsage);
      line.geometry.dispose();
      line.geometry = dots.geometry = new THREE.BufferGeometry().setAttribute('position', attr);
    }
    points.forEach((p, i) => attr.setXYZ(i, p[0], 0.05, p[1]));
    attr.needsUpdate = true;
    line.geometry.setDrawRange(0, points.length);   // the dots share the geometry: the rubber-band end shows one too
    line.visible = points.length > 1;
    dots.visible = fixed > 0;
    ctx.viewport.invalidate();
  }

  // Where the cursor is on the ground; null above the horizon. px / pz: the point a road would take (snapped).
  function track(ev, hit) {
    if (!hit.onGround) { hover = null; return; }
    const p = mode === 'road' ? snapPoint(ctx, hit.x, hit.z, ev) : hit;
    hover = { x: hit.x, z: hit.z, ix: hit.ix, iz: hit.iz, px: p.x, pz: p.z, shift: !!ev.shiftKey };
  }

  // Ring, previews and the Fill hover text, from the state as it is now.
  function refresh() {
    const map = store.map, vp = ctx.viewport;
    if (!active || !map) return;
    const g = map.ground, type = typeNow();
    if (!hover || mode === 'fill') vp.brush(null);
    else if (mode === 'road') vp.brush(hover.px, hover.pz, widthNow(g) / 2);
    else { const r = radiusNow(g); vp.brush(hover.x, hover.z, r, { inner: opts.soft ? r * SOFT_CORE : 0 }); }

    if (mode === 'road') {
      const points = hover && road.length ? [...road, [hover.px, hover.pz]] : road;
      showLine(points, road.length);
      showCells(road.length ? ribbon(g, points, widthNow(g)) : null, type);
    } else {
      showLine([], 0);
      if (mode === 'brush') {
        // Shift is down and there is a stroke to continue: show the straight stroke the click would paint
        const from = hover?.shift && !stroke ? lastEnd : null;
        showCells(from ? capsule(g, from.x, from.z, hover.x, hover.z, radiusNow(g)) : null, type);
      } else fillHover(g, type);
    }
  }

  // Fill: the status bar says how many cells a click would change, and the preview shows which.
  function fillHover(g, type) {
    if (!hover || hover.ix < 0) {
      showCells(null);
      if (told !== -1) hush();
      told = -1;
      return;
    }
    const index = hover.iz * g.size + hover.ix, area = floodAt(index), from = g.cells[index];
    const key = index * GROUND_TYPES.length + type, quiet = key === told;
    told = key;
    if (!area.length) {
      showCells(null);
      if (!quiet) say('Fill: outside the island - the shore is painted with the brush');
    } else if (from === type) {
      showCells(null);
      if (!quiet) say(`Fill: 0 cells would change - this area is ${shortName(type)} already`);
    } else {
      showCells(area, type);
      if (!quiet) say(`Fill: ${count(area.length, 'cell')} would change from ${shortName(from)} to ${shortName(type)}`);
    }
  }

  // ---------------------------------------------------------------- options strip

  function setMode(next) {
    if (!MODES.includes(next) || next === mode) return;
    abortStroke();
    road = [];
    mode = next;
    told = -1;
    hush();
    buildStrip();
    refresh();
    ctx.viewport?.invalidate();
  }

  // [ and ]: fine steps for a small brush, coarse ones for a large one
  function stepRadius(dir) {
    const r = clamp(Number(opts.radius) || RADIUS[0], RADIUS), step = (v) => (v < 6 ? 0.5 : v < 16 ? 1 : 2);
    opts.radius = clamp(Math.round((dir > 0 ? r + step(r) : r - step(r - 0.01)) * 2) / 2, RADIUS);
  }

  function release() {
    for (const off of subs) off?.();
    subs = [];
  }

  // The strip follows the state: the options (keys and scripts change them too), the points of the road, the selected
  // region, the ground type. Without `force` only when an option differs from what the strip shows - that is the check
  // update() makes on every frame, for the sake of a script that wrote to tool.opts.
  function syncStrip(force = false) {
    if (!strip || !widgets) return;
    const key = `${opts.radius}|${opts.soft}|${opts.width}|${opts.clearScenery}`;
    if (!force && key === shown) return;
    shown = key;
    widgets.radius?.set(clamp(Number(opts.radius) || RADIUS[0], RADIUS));
    if (widgets.hard) {
      widgets.hard.classList.toggle('active', !opts.soft);
      widgets.softEdge.classList.toggle('active', !!opts.soft);
    }
    widgets.width?.set(clamp(Number(opts.width) || WIDTH[0], WIDTH));
    widgets.clear?.set(!!opts.clearScenery);
    if (widgets.finish) widgets.finish.disabled = widgets.cancel.disabled = road.length === 0;
    if (widgets.region) {
      const regions = store.map ? store.selected('region') : [];
      widgets.region.disabled = regions.length === 0;
      widgets.region.title = regions.length === 0 ? 'Select a region first: in the Regions panel, or by its outline with the Select tool'
        : regions.length === 1 ? `Paint every vertex inside "${regions[0].name}" with the chosen ground type`
          : `Paint every vertex inside the ${regions.length} selected regions with the chosen ground type`;
    }
    const type = typeNow();
    widgets.swatches.forEach((node, i) => {
      node.classList.toggle('active', i === type);
      node.setAttribute('aria-pressed', String(i === type));
    });
    widgets.name.textContent = GROUND_TYPES[type].name + (BLOCK[type] ? ' (blocks walking)' : '');
  }

  function buildStrip() {
    release();
    if (!strip) return;
    const node = (x) => x?.el ?? x, w = widgets = {};
    const modes = h('div', { class: 'ui-group', role: 'group', 'aria-label': 'Mode' }, MODES.map((id) => {
      const b = button(MODE_LABEL[id], () => setMode(id), { title: MODE_HELP[id] });
      b.classList.toggle('active', id === mode);
      b.setAttribute('aria-pressed', String(id === mode));
      return b;
    }));
    w.swatches = GROUND_TYPES.map((t, i) => {
      const chip = h('span', { class: 'ui-swatch', style: { background: `linear-gradient(135deg, ${css(t.a)} 50%, ${css(t.b)} 50%)` } });
      const b = button(chip, () => ui.set('groundType', i), { title: `${t.name}${i < 9 ? ` (${i + 1})` : ''}${t.block ? ' - cannot be walked on' : ''}` });
      b.classList.add('icon');
      return b;
    });
    w.name = h('span', { class: 'ui-hint' });
    const ground = h('div', { class: 'ui-row' }, h('span', { class: 'ui-label' }, 'Ground'), h('div', { class: 'ui-control' }, h('div', { class: 'ui-group' }, w.swatches), w.name));
    const parts = [modes, h('span', { class: 'ui-sep' }), ground, h('span', { class: 'ui-sep' })];
    const redraw = () => { syncStrip(true); refresh(); };
    if (mode === 'brush') {
      w.radius = rangeField({ value: opts.radius, min: RADIUS[0], max: RADIUS[1], step: 0.5, onInput: (v) => { opts.radius = v; redraw(); } });
      w.hard = button('Hard', () => { opts.soft = false; redraw(); }, { title: `Paint every vertex inside the radius (${chordLabel('Shift+BracketRight')})` });
      w.softEdge = button('Soft', () => { opts.soft = true; redraw(); }, { title: `Dither the outer 40 % of the brush away (${chordLabel('Shift+BracketLeft')})` });
      const radius = row('Radius', w.radius);
      radius.title = `Brush radius in world units (${chordLabel('BracketLeft')} ${chordLabel('BracketRight')})`;
      parts.push(radius, row('Edge', h('div', { class: 'ui-group' }, w.hard, w.softEdge)));
    } else if (mode === 'road') {
      w.width = numberField({ value: opts.width, min: WIDTH[0], max: WIDTH[1], step: 0.5, digits: 1, onInput: (v) => { opts.width = v; redraw(); }, onCommit: (v) => { opts.width = v; redraw(); } });
      w.clear = checkField({ value: opts.clearScenery, onCommit: (on) => { opts.clearScenery = on; roadChanged(); } });
      w.finish = button('Paint road', () => commitRoad(), { title: `Paint the road through the points (${chordLabel('Enter')} or a double-click)` });
      w.cancel = button('Cancel', () => cancelRoad(), { title: `Drop the points (${chordLabel('Escape')})` });
      const width = row('Width', w.width), clear = row('Clear scenery', w.clear);
      width.title = `Width of the road in world units (${chordLabel('BracketLeft')} ${chordLabel('BracketRight')})`;
      clear.title = 'Also delete the objects whose collider comes within width / 2 + 1 of the centre line, in the same undo step';
      parts.push(width, clear, h('div', { class: 'ui-row' }, w.finish, w.cancel));
    } else {
      w.region = button('Fill selected region', () => fillRegions());
      parts.push(w.region);
    }
    parts.push(h('span', { class: 'ui-hint', title: MODE_HELP[mode] }, MODE_HINT[mode]));
    strip.replaceChildren(...parts.map(node));
    syncStrip(true);
    subs = [
      ui.on('groundType', () => { syncStrip(true); refresh(); }),
      store.on('selection', () => syncStrip(true)),
    ];
  }

  // ---------------------------------------------------------------- the map changes under the tool

  store.on('load', () => {
    // another map object: the group of an open stroke went with the old history, and no point or cell means anything now
    stroke = null;
    road = [];
    lastEnd = null;
    filled = null;
    hover = null;
    previewKey = null;
    told = -1;
    if (!active) return;
    showCells(null);
    showLine([], 0);
    ctx.viewport.brush(null);
    syncStrip(true);
  });
  store.on('change', (change) => {
    if (!change.ground && !change.props.length) return;
    filled = null;          // the ground is not what the last flood saw
    told = -1;              // painted, undone or redone under the cursor: what a click would do there is due again
    if (change.props.includes('ground') || change.props.includes('radius')) { lastEnd = null; previewKey = null; }
  });

  return {
    id: 'paint', label: 'Terrain', icon: '▦', layer: 'ground', picks: [], hidden: false,
    about: 'Paint the ground types: with a brush, as a road, or by filling an area',
    get intro() { return resting(); },
    // a road in progress takes Enter; Backspace, the brackets and the digits are in both tables
    get context() { return mode === 'road' && road.length ? 'path' : 'brush'; },
    get mode() { return mode; },
    setMode,
    opts,

    activate() {
      active = true;
      ensurePreview();
      ctx.viewport.overlay.add(cells, line, dots);
      const c = ui.cursor;
      hover = c && c.onGround ? { x: c.x, z: c.z, ix: c.ix, iz: c.iz, px: c.x, pz: c.z, shift: false } : null;
      hush();          // the instruction of the mode
      refresh();
    },

    deactivate() {
      abortStroke();
      stroke = null;
      road = [];
      hover = null;
      told = -1;
      showCells(null);
      showLine([], 0);
      active = false;
      cells?.removeFromParent();
      line?.removeFromParent();
      dots?.removeFromParent();
      ctx.viewport.brush(null);
      ctx.viewport.readout(null);
      release();
      strip = widgets = null;
      hush();          // (no longer active: this clears what the tool wrote)
    },

    pointerDown(ev, hit) {
      if (!store.map) return;
      if (stroke) abortStroke();          // a press whose release never came
      stroke = null;
      track(ev, hit);
      if (refused()) return;
      if (ev.altKey) { pickType(hit); return; }
      if (mode === 'road') addRoadPoint(ev, hit);
      else if (mode === 'fill') fillAt(hit);
      else startStroke(ev, hit);
      refresh();
    },

    // Every pointer move: with the button down it extends the stroke, and always it moves the ring and the previews.
    pointerMove(ev, hit) {
      if (!store.map) return;
      track(ev, hit);
      if (stroke && (ev.buttons & 1)) extendStroke(hit);
      refresh();
    },

    pointerUp(ev, hit) {
      if (!stroke) return;
      endStroke(hit);
      refresh();
    },

    // The two clicks came first: the first added a point, the second one fell on it and was dropped.
    doubleClick() {
      if (mode === 'road' && road.length) commitRoad();
    },

    key(action) {
      if (action === 'cancel') {
        if (abortStroke()) { refresh(); return true; }
        return cancelRoad();
      }
      if (action === 'path.back') {
        // In Road mode Backspace is the key of the points, with or without one left: a press too many must not fall
        // through to "delete the selection" (whatever was selected before the road was begun).
        if (mode !== 'road') return false;
        if (!road.length) { note('Road: no point to take back'); return true; }
        road.pop();
        roadChanged();
        return true;
      }
      if (action === 'path.commit') return commitRoad();
      if (action === 'brush.smaller' || action === 'brush.larger') {
        const dir = action === 'brush.larger' ? 1 : -1;
        if (mode === 'brush') {
          stepRadius(dir);
          note(`Brush radius ${opts.radius}`);
        } else if (mode === 'road') {
          opts.width = clamp((Number(opts.width) || WIDTH[0]) + dir, WIDTH);
          note(`Road width ${opts.width}`);
        } else return false;
        syncStrip(true);
        refresh();
        return true;
      }
      if (action === 'brush.optDown' || action === 'brush.optUp') {
        if (mode !== 'brush') return false;
        opts.soft = action === 'brush.optDown';
        note(opts.soft ? 'Soft edge' : 'Hard edge');
        syncStrip(true);
        refresh();
        return true;
      }
      if (typeof action === 'string' && action.startsWith('brush.type.')) {
        const n = Number(action.slice('brush.type.'.length));
        if (!Number.isInteger(n) || n < 1 || n > GROUND_TYPES.length) return false;
        ui.set('groundType', n - 1);
        note(`Ground type: ${GROUND_TYPES[n - 1].name}`);
        return true;
      }
      return false;
    },

    update() {
      // the cursor left the viewport: no ring and no preview hang where it was
      if (hover && !ui.cursor && !stroke) {
        hover = null;
        refresh();
      }
      syncStrip();
    },

    options(el) {
      strip = el;
      buildStrip();
    },
  };
}
