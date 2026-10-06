// The Measure tool: click points on the ground and read distances off them. Nothing is written to the map.
//
//   click                 adds a point (on the snap grid when snapping is on; Mod inverts the toggle)
//   press and drag        the point just added follows the pointer until the button is released
//   Backspace / Delete    takes the last point back
//   Enter / Esc           clears the measurement (Esc with nothing measured goes back to Select)
//
// What it shows: the length of every segment at its middle, the total distance at the last point and - from three
// points on - the area the points enclose, with the closing segment drawn faintly. One segment alone is also a
// RADIUS: the circle of that radius around the first point is drawn on the ground, which is how a camp radius or a
// region is sized before it is placed. The same numbers stand in the options strip, where they can be copied.
//
// This file also holds what the two path tools of this owner share - the Region tool draws its unfinished polygon
// with the same line and the same knobs: createLine, createDots and the polygon maths below.
import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { h, row, button } from '../ui/dom.js';
import { chordLabel, keyText } from '../keymap.js';
import { snapPoint } from './common.js';
import { drapePath } from '../drape.js';

const MAX_POINTS = 200;        // one label per segment: more than this is a drawing, not a measurement
const SAME_PX = 3;             // a click this close to the last point is the second half of a double-click
const LINE_COLOR = 0xffd24d, RING_COLOR = 0xffd24d;
const Y = 0.1;                 // above every ground overlay; the preview is drawn without a depth test anyway
const PIECE = 2;               // a line follows the ground in pieces of this length, so it climbs a hill instead of crossing it
const level = () => 0;         // the ground of a caller that names no height: flat
const noRaycast = () => {};    // previews are never picked: a stray scene raycast must not find them

// ---------------------------------------------------------------- polygon maths (pure)

// Points are [x, z] pairs, like the points of a polygon region.
export const segmentLength = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

// The length of the open polyline through the points.
export function pathLength(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += segmentLength(points[i - 1], points[i]);
  return d;
}

// The area enclosed by the points, closed implicitly (shoelace; either winding). A path that crosses itself counts
// the overlap with its sign, as every shoelace does: the number is exact for simple outlines only.
export function polygonArea(points) {
  let a = 0;
  for (let i = 0, n = points.length, j = n - 1; i < n; j = i++) a += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  return points.length < 3 ? 0 : Math.abs(a) / 2;
}

// Where the area readout hangs: the centroid of the polygon, or the average of its points when it has no area.
export function polygonCentroid(points) {
  let a = 0, cx = 0, cz = 0, sx = 0, sz = 0;
  for (let i = 0, n = points.length, j = n - 1; i < n; j = i++) {
    const w = points[j][0] * points[i][1] - points[i][0] * points[j][1];
    a += w;
    cx += (points[j][0] + points[i][0]) * w;
    cz += (points[j][1] + points[i][1]) * w;
    sx += points[i][0];
    sz += points[i][1];
  }
  if (!points.length) return [0, 0];
  if (Math.abs(a) < 1e-9) return [sx / points.length, sz / points.length];
  return [cx / (3 * a), cz / (3 * a)];
}

// Everything the tool reads off a list of points.
//   segments   the length of each segment          total    their sum
//   closing    the segment back to the first point (0 below three points)
//   perimeter  total + closing                     area     the enclosed area (0 below three points)
//   radius     the length of the one segment when there are exactly two points, else 0
export function measure(points) {
  const n = points.length, segments = [];
  for (let i = 1; i < n; i++) segments.push(segmentLength(points[i - 1], points[i]));
  const total = segments.reduce((sum, d) => sum + d, 0), closing = n >= 3 ? segmentLength(points[n - 1], points[0]) : 0;
  return { points: n, segments, total, closing, perimeter: total + closing, area: polygonArea(points), radius: n === 2 ? segments[0] : 0 };
}

// ---------------------------------------------------------------- preview pieces (three)

// A polyline on the ground that keeps its width on screen. set(points) replaces it; a line needs two points.
// The geometry is made anew for every set: a LineGeometry cannot be resized, and replacing its buffers in place would
// leave the old ones on the GPU until the page goes.
//   height   (x, z) -> the height of the ground there (viewport.groundY): the line lies on the hills
export function createLine(color, { width = 2.5, opacity = 1, height = level } = {}) {
  const material = new LineMaterial({ color, linewidth: width, transparent: true, opacity, depthTest: false, depthWrite: false, toneMapped: false });
  const line = new Line2(new LineGeometry(), material);
  line.frustumCulled = false;   // rewritten on every pointer move: bounds would be stale more often than right
  line.renderOrder = 30;
  line.visible = false;
  line.raycast = noRaycast;
  return {
    object: line,
    set(points) {
      line.geometry.dispose();
      line.geometry = new LineGeometry();
      line.visible = points.length >= 2;
      if (!line.visible) return;
      line.geometry.setPositions(drapePath(points, height, { lift: Y, step: PIECE }));
    },
    // the size of the canvas in CSS pixels: what a line width is measured against
    resolution(w, h) { material.resolution.set(w || 1, h || 1); },
    dispose() {
      line.removeFromParent();
      line.geometry.dispose();
      material.dispose();
    },
  };
}

// One round knob with a dark rim, drawn once and shared by every createDots() of the page.
let knob = null;
function knobTexture() {
  if (knob) return knob;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const g = canvas.getContext('2d');
  g.fillStyle = '#10151a';
  g.beginPath(); g.arc(32, 32, 30, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffffff';
  g.beginPath(); g.arc(32, 32, 21, 0, Math.PI * 2); g.fill();
  knob = new THREE.CanvasTexture(canvas);
  knob.colorSpace = THREE.SRGBColorSpace;
  return knob;
}

// Knobs of a fixed size on screen at ground points. set(points) replaces them. height: as for createLine.
export function createDots(color, { size = 12, height = level } = {}) {
  const geometry = new THREE.BufferGeometry();
  const material = new THREE.PointsMaterial({
    color, size, sizeAttenuation: false, map: knobTexture(), transparent: true, alphaTest: 0.05, depthTest: false, depthWrite: false, toneMapped: false,
  });
  const dots = new THREE.Points(geometry, material);
  dots.frustumCulled = false;
  dots.renderOrder = 31;
  dots.visible = false;
  dots.raycast = noRaycast;
  let capacity = 0;
  return {
    object: dots,
    set(points) {
      const n = points.length;
      if (n > capacity) {   // a buffer attribute cannot grow: a larger one replaces it, and the old one is released
        geometry.dispose();
        capacity = THREE.MathUtils.ceilPowerOfTwo(Math.max(8, n));
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
      }
      const attr = geometry.attributes.position;
      if (attr) {
        for (let i = 0; i < n; i++) attr.setXYZ(i, points[i][0], height(points[i][0], points[i][1]) + Y, points[i][1]);
        attr.needsUpdate = true;
      }
      geometry.setDrawRange(0, n);
      dots.visible = n > 0;
    },
    dispose() {
      dots.removeFromParent();
      geometry.dispose();
      material.dispose();   // the knob texture is shared and stays
    },
  };
}

// ---------------------------------------------------------------- the tool

const LABEL = 'position:absolute;left:0;top:0;transform:translate(-50%,-50%);padding:1px 5px;border-radius:3px;white-space:nowrap;'
  + 'font:11px/1.4 var(--mono);color:var(--text);background:color-mix(in srgb, var(--bg) 86%, transparent);';
const LABEL_KIND = {
  segment: '',
  closing: 'color:var(--dim);',
  total: 'border:1px solid var(--warn);font-weight:600;',
  area: 'border:1px solid var(--line);',
};
const num = (v) => v.toFixed(2);
const area = (v) => v.toFixed(1);

export default function create(ctx) {
  const { store, ui, viewport } = ctx;

  let points = [];       // [[x, z], ...] the clicked points, on the map's 0.01 grid
  let cursor = null;     // [x, z]: the snapped ground point under the pointer, or null (no pointer, or it is over the sky)
  let held = false;      // the button is down: the point just added follows the pointer until the release
  let visuals = null;    // what activate() built: { group, path, closing, rubber, dots, layer, labels: [{ el, x, z }] }
  let strip = null;      // the outputs and buttons of the options strip
  let status = '';       // the status text this tool has set last

  const say = (text) => {
    if (ui.status !== text) ui.setStatus(text);
    status = text;
  };
  const at = (hit, ev) => { const p = snapPoint(ctx, hit.x, hit.z, ev); return [p.x, p.z]; };

  // ---- what is drawn

  function label(kind, text, x, z) {
    const el = h('div', { style: LABEL + LABEL_KIND[kind] }, text);
    visuals.layer.append(el);
    visuals.labels.push({ el, x, z });
  }

  // The labels are DOM text over the canvas: crisp at any zoom. They are put in place once per rendered frame.
  function placeLabels() {
    if (!visuals) return;
    const box = visuals.layer.getBoundingClientRect();
    for (const l of visuals.labels) {
      const p = viewport.project(l.x, viewport.groundY(l.x, l.z), l.z);
      l.el.hidden = !p.visible;
      if (p.visible) l.el.style.transform = `translate(-50%, -50%) translate(${Math.round(p.x - box.left)}px, ${Math.round(p.y - box.top)}px)`;
    }
  }

  // The circle whose radius is the one segment there is: around the first point, through the second (or the pointer).
  function drawCircle() {
    const to = points.length === 2 ? points[1] : points.length === 1 ? cursor : null;
    const r = to ? segmentLength(points[0], to) : 0;
    if (r > 0) viewport.brush(points[0][0], points[0][1], r, { color: RING_COLOR });
    else viewport.brush(null);
  }

  // The segment from the last point to the pointer, and what the measurement would read with the pointer as its next point.
  function drawLive() {
    if (!visuals) return;
    const last = points[points.length - 1];
    visuals.rubber.set(last && cursor && !held ? [last, cursor] : []);
    drawCircle();
    if (!last || !cursor || held) viewport.readout(null);
    else {
      const d = segmentLength(last, cursor), lines = [];
      if (points.length === 1) lines.push(`radius ${num(d)}`, `diameter ${num(d * 2)}`, `circle area ${area(Math.PI * d * d)}`);
      else {
        lines.push(`segment ${num(d)}`, `total ${num(pathLength(points) + d)}`);
        lines.push(`area ${area(polygonArea([...points, cursor]))}`);
      }
      viewport.readout(lines.join('\n'));
    }
    viewport.invalidate();
  }

  function fillStrip() {
    if (!strip) return;
    const m = measure(points);
    strip.count.textContent = String(m.points);
    strip.total.textContent = m.points >= 2 ? num(m.total) : '—';
    strip.radius.textContent = m.points === 2 ? `${num(m.radius)} (⌀ ${num(m.radius * 2)})` : '—';
    strip.area.textContent = m.points >= 3 ? `${area(m.area)} (perimeter ${num(m.perimeter)})` : '—';
    strip.back.disabled = strip.clear.disabled = m.points === 0;
    strip.hint.textContent = m.points === 0 ? 'Click points on the ground to measure between them'
      : m.points === 1 ? 'Click the next point: one segment is a distance and a radius'
        : m.points === 2 ? 'A third point adds the enclosed area' : '';
  }

  // The points changed: the path, its knobs, the labels and every number are rebuilt.
  function refresh() {
    const m = measure(points);
    if (visuals) {
      visuals.path.set(points);
      visuals.closing.set(m.points >= 3 ? [points[m.points - 1], points[0]] : []);
      visuals.dots.set(points);
      for (const l of visuals.labels) l.el.remove();
      visuals.labels.length = 0;
      for (let i = 1; i < m.points; i++) {
        label('segment', num(m.segments[i - 1]), (points[i - 1][0] + points[i][0]) / 2, (points[i - 1][1] + points[i][1]) / 2);
      }
      if (m.points >= 3) {
        const last = points[m.points - 1], c = polygonCentroid(points);
        label('closing', num(m.closing), (last[0] + points[0][0]) / 2, (last[1] + points[0][1]) / 2);
        label('area', `area ${area(m.area)}`, c[0], c[1]);
      }
      if (m.points >= 2) label('total', m.points === 2 ? `r ${num(m.total)}` : `Σ ${num(m.total)}`, points[m.points - 1][0], points[m.points - 1][1]);
      placeLabels();
    }
    fillStrip();
    say(m.points === 0 ? 'Measure: click points on the ground'
      : m.points === 1 ? 'Measure: 1 point'
        : `Measure: ${m.points} points · ${num(m.total)} units${m.points >= 3 ? ` · area ${area(m.area)}` : ''}`);
    drawLive();
  }

  function clear() {
    points = [];
    held = false;
    refresh();
  }

  function back() {
    if (!points.length) return;
    points.pop();
    refresh();
  }

  // The coordinates of another map mean nothing on this one.
  store.on('load', () => {
    points = [];
    cursor = null;
    held = false;
    if (visuals) refresh();
  });
  // The ground moved under the lines (an undo of a sculpt stroke): they are laid on it again.
  store.on('change', (change) => { if (visuals && (change.ground?.relief || change.props.includes('ground'))) refresh(); });

  return {
    id: 'measure', label: 'Measure', icon: '↔', layer: null, picks: [], hidden: false,
    about: 'Measure distances and areas: click the points',
    intro: 'Measure: click points on the ground',
    // always a path: Backspace takes a point back and never reaches "delete the selection", however often it is pressed
    get context() { return 'path'; },

    // For scripts and checks: the measurement as plain data (see measure() above), with the points themselves.
    get result() { return { ...measure(points), at: points.map((p) => [p[0], p[1]]) }; },

    activate() {
      const group = new THREE.Group();
      group.name = 'measure';
      const height = viewport.groundY;
      const path = createLine(LINE_COLOR, { height }), closing = createLine(LINE_COLOR, { width: 1.5, opacity: 0.45, height });
      const rubber = createLine(LINE_COLOR, { width: 1.5, opacity: 0.7, height }), dots = createDots(0xffffff, { height });
      group.add(closing.object, path.object, rubber.object, dots.object);
      viewport.overlay.add(group);
      // one layer for the labels over the canvas, under the viewport's own readout and tip
      const layer = h('div', { style: 'position:absolute;inset:0;z-index:2;overflow:hidden;pointer-events:none;' });
      viewport.dom.parentElement.append(layer);
      visuals = { group, path, closing, rubber, dots, layer, labels: [] };
      refresh();
    },

    deactivate() {
      points = [];
      cursor = null;
      held = false;
      if (visuals) {
        for (const part of [visuals.path, visuals.closing, visuals.rubber, visuals.dots]) part.dispose();
        visuals.group.removeFromParent();
        visuals.layer.remove();
        visuals = null;
      }
      strip = null;
      viewport.brush(null);
      viewport.readout(null);
      if (status && ui.status === status) ui.setStatus('');
      status = '';
      viewport.invalidate();
    },

    pointerDown(ev, hit) {
      if (hit.onGround === false) return;   // over the sky there is no ground point to measure from
      const p = at(hit, ev), last = points[points.length - 1];
      held = true;
      cursor = null;
      if (last) {
        const s = viewport.project(last[0], viewport.groundY(last[0], last[1]), last[1]);
        // a double-click delivers its two clicks first: the second one must not add the same point again
        if (segmentLength(last, p) < 0.01 || Math.hypot(s.x - ev.clientX, s.y - ev.clientY) < SAME_PX) { drawLive(); return; }
      }
      if (points.length >= MAX_POINTS) {
        ui.toast(`A measurement has at most ${MAX_POINTS} points`, 'warn');
        return;
      }
      points.push(p);
      refresh();
    },

    pointerMove(ev, hit) {
      if (hit.onGround === false) {
        if (cursor) { cursor = null; drawLive(); }
        return;
      }
      const p = at(hit, ev);
      if (held && (ev.buttons & 1) && points.length) {
        const last = points[points.length - 1];
        if (last[0] === p[0] && last[1] === p[1]) return;
        points[points.length - 1] = p;
        refresh();
        return;
      }
      if (cursor && cursor[0] === p[0] && cursor[1] === p[1]) return;
      cursor = p;
      drawLive();
    },

    pointerUp(ev, hit) {
      if (!held) return;
      held = false;
      if (hit && hit.onGround !== false) cursor = at(hit, ev);
      drawLive();
    },

    key(action) {
      if (action === 'path.back') {
        back();
        return true;   // also with nothing left to take back: the key must not fall through to "delete the selection"
      }
      if (action === 'path.commit') {
        clear();
        return true;
      }
      if (action === 'cancel') {
        if (!points.length) return false;   // nothing measured: Esc goes on to the Select tool
        clear();
        return true;
      }
      return false;
    },

    // every rendered frame: the camera may have moved under the labels, the canvas may have another size
    update() {
      if (!visuals) return;
      const w = viewport.dom.clientWidth, hgt = viewport.dom.clientHeight;
      for (const part of [visuals.path, visuals.closing, visuals.rubber]) part.resolution(w, hgt);
      placeLabels();
    },

    options(el) {
      const out = () => h('output', { class: 'ui-mono ui-selectable' }, '—');
      const key = (chord) => h('kbd', { class: 'ui-kbd' }, chordLabel(chord));
      strip = {
        count: out(), total: out(), radius: out(), area: out(),
        back: button(['Undo point', key('Backspace')], back, { title: 'Take the last point back' }),
        clear: button(['Clear', key('Enter')], clear, { title: keyText('Clear the measurement (Enter or Esc)') }),
        hint: h('span', { class: 'ui-hint' }),
      };
      el.append(
        row('Points', strip.count), row('Distance', strip.total), row('Radius', strip.radius), row('Area', strip.area),
        h('div', { class: 'ui-row' }, strip.back, strip.clear),
        strip.hint,
      );
      fillStrip();
    },
  };
}
