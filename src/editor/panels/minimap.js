import { h, button, rafThrottle } from '../ui/dom.js';
import { hintFor } from '../keymap.js';
import { GROUND_TYPES, groundHalf } from '../../map/format.js';
import { modelInfo } from '../../map/catalog.js';
import { MOB_KEYS, MOB_TYPES } from '../../shared.js';

// The minimap (#minimap): the whole island on a 2D canvas - never a second 3D render. North (-Z) is up and east (+X)
// is right, like the in-game radar and like the viewport at yaw 0.
//
// Drawn from data, in layers:
//   ground    an ImageData of size x size pixels, one per ground vertex; after a brush stroke only the dirty rectangle
//             of the Change is repainted
//   tint      the canvas of the regiontint overlay on top, while that overlay is switched on (owner D; null = no tint)
//   objects   one dot per object, coloured by category, on a canvas of their own that is redrawn at most 4 times a second
//   markers   spawns (disc and centre), chests, NPCs, the start disc - and what is selected, in the accent colour
//   camera    the ground footprint of the view (viewport.viewQuad()) and its target
// A click or a drag on the map moves the camera target. Below it: four bookmark buttons (click = go, Shift+click =
// store) and the three view actions a mapper uses with it.

const DOTS_MS = 250;        // objects are redrawn at most 4 times a second
const SEA = 0x2f7d9c;       // the colour of the view's sea plane
const SELECTED_MAX = 4000;  // selected objects highlighted one by one; beyond that the dots layer has to do
const CATEGORY = {          // dot colours by catalog category: readable on grass, sand and ash alike
  buildings: '#e8c39a', walls: '#c4c9d1', trees: '#1f5a2a', rocks: '#8d9199', props: '#c79a5b', graves: '#a9a2c0',
  lights: '#ffd66e', ruins: '#a39684', foliage: '#3f8a3a', special: '#d58cff',
};
const OTHER = '#d0d0d0';

const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;
const rgbOf = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
// one colour per ground type: the middle of the two the terrain blends
const GROUND_RGB = GROUND_TYPES.map((t) => mix(rgbOf(t.a), rgbOf(t.b), 0.5));
const SEA_RGB = rgbOf(SEA), UNKNOWN_RGB = [255, 0, 255];

// The monster type that names a camp: the highest weight, ties in MOB_KEYS order.
function dominant(types) {
  let best = null;
  for (const key of MOB_KEYS) if (Object.hasOwn(types, key) && (best === null || types[key] > types[best])) best = key;
  return best;
}

export default function mount(el, ctx) {
  const { store, ui, actions } = ctx;

  // ---- DOM
  const canvas = h('canvas', { class: 'map', width: 2, height: 2, title: 'Click or drag: move the camera here' });
  const coords = h('span', { class: 'coords ui-mono' });
  const marks = [1, 2, 3, 4].map((i) => {
    const node = button(String(i), (ev) => {
      actions.run(ev.shiftKey ? `view.bookmark.store.${i}` : `view.bookmark.${i}`);
      syncMarks();
    });
    node.classList.add('mark');
    return node;
  });
  const act = (label, id, title) => {
    const key = hintFor(id), node = button(label, () => { actions.run(id); syncMarks(); }, { title: key ? `${title} (${key})` : title });
    node.classList.add('flat');
    return node;
  };
  const top = act('Top', 'view.overhead', 'Toggle the overhead view');
  el.replaceChildren(
    h('div', { class: 'frame' }, canvas),
    h('div', { class: 'bar' },
      h('span', { class: 'ui-group marks' }, marks),
      act('Home', 'view.home', 'Go to the start point'),
      act('Frame', 'view.frame', 'Frame the selection (the whole island when nothing is selected)'),
      top),
    h('div', { class: 'foot' }, coords),
  );

  const g2d = canvas.getContext('2d');
  const base = document.createElement('canvas'), baseCtx = base.getContext('2d');
  const dots = document.createElement('canvas'), dotsCtx = dots.getContext('2d');
  let image = null;         // the ImageData behind `base`
  let baseFor = null;       // the ground object `base` was painted from
  let extent = 1;           // half the width of the picture in world units
  let dotsDirty = true, dotsAt = -Infinity, dotsTimer = 0;
  let lastKey = '';         // camera, tint and size of the last draw
  let hover = null;         // { x, z } under the pointer
  let dragging = false;
  const catColor = new Map();   // model id -> dot colour

  // the accent and text colours of the page: the camera frame and the markers follow the theme
  const css = (name, fallback) => getComputedStyle(el).getPropertyValue(name).trim() || fallback;
  let accent = '#5a9cf2', ink = '#ffffff';

  // ---------------------------------------------------------------- ground

  // Repaints the INCLUSIVE vertex rectangle of the ground picture. Beyond the map radius the ground sinks into the
  // sea: it is shown under water, so paint that strays out there is still seen.
  function paintGround(ix0, iz0, ix1, iz1) {
    const map = store.map, g = map.ground, size = g.size, c = (size - 1) / 2, r2 = map.radius * map.radius, data = image.data;
    ix0 = Math.max(0, ix0); iz0 = Math.max(0, iz0); ix1 = Math.min(size - 1, ix1); iz1 = Math.min(size - 1, iz1);
    if (ix1 < ix0 || iz1 < iz0) return;
    for (let iz = iz0; iz <= iz1; iz++) {
      const z = (iz - c) * g.cell;
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = (ix - c) * g.cell, k = iz * size + ix;
        let rgb = GROUND_RGB[g.cells[k]] ?? UNKNOWN_RGB;
        if (x * x + z * z > r2) rgb = mix(rgb, SEA_RGB, 0.82);
        data[k * 4] = rgb[0]; data[k * 4 + 1] = rgb[1]; data[k * 4 + 2] = rgb[2]; data[k * 4 + 3] = 255;
      }
    }
    baseCtx.putImageData(image, 0, 0, ix0, iz0, ix1 - ix0 + 1, iz1 - iz0 + 1);
  }

  // The whole ground picture: a new map, a new ground object (a resize) or a new radius.
  function rebuildGround() {
    const map = store.map;
    if (!map) { baseFor = null; return; }
    const g = map.ground, size = g.size;
    if (!(size > 0) || g.cells.length !== size * size) { baseFor = null; return; }
    if (base.width !== size || base.height !== size || !image) {
      base.width = base.height = size;
      image = baseCtx.createImageData(size, size);
    }
    baseFor = g;
    extent = groundHalf(g) + g.cell / 2;   // a pixel is one cell, centred on its vertex
    paintGround(0, 0, size - 1, size - 1);
  }

  // ---------------------------------------------------------------- sizes and coordinates

  // The canvas follows its box. -> false while it has no size (the panel is collapsed).
  function fit() {
    const w = canvas.clientWidth;
    if (!w) return false;
    const px = Math.max(2, Math.round(w * Math.min(window.devicePixelRatio || 1, 2)));
    if (canvas.width !== px || canvas.height !== px) {
      canvas.width = canvas.height = px;
      dots.width = dots.height = px;
      dotsDirty = true;
      dotsAt = -Infinity;
    }
    return true;
  }
  const scale = () => canvas.width / (2 * extent);          // device pixels per world unit
  const pointOf = (ev) => {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: ((ev.clientX - r.left) / r.width * 2 - 1) * extent, z: ((ev.clientY - r.top) / r.height * 2 - 1) * extent };
  };

  // ---------------------------------------------------------------- objects

  function colorOf(id) {
    let color = catColor.get(id);
    if (color === undefined) catColor.set(id, color = CATEGORY[modelInfo(id)?.cat] ?? OTHER);
    return color;
  }

  function drawDots() {
    dotsDirty = false;
    dotsAt = performance.now();
    const map = store.map, W = dots.width;
    dotsCtx.clearRect(0, 0, W, W);
    if (!map || !ui.layers.objects?.visible) return;
    const k = scale(), s = Math.max(1.5, W / 190), half = s / 2, hidden = ui.hiddenModels;
    // one fillStyle per model, not per object: the objects of a model are drawn together
    const byModel = new Map();
    for (const obj of map.objects) {
      if (hidden.has(obj.m)) continue;
      let list = byModel.get(obj.m);
      if (!list) byModel.set(obj.m, list = []);
      list.push(obj);
    }
    for (const [id, list] of byModel) {
      dotsCtx.fillStyle = colorOf(id);
      for (const obj of list) dotsCtx.fillRect((obj.x + extent) * k - half, (obj.z + extent) * k - half, s, s);
    }
  }

  // Asks for new dots: at once when the last ones are old enough, else when they are.
  function touchDots() {
    dotsDirty = true;
    if (dotsTimer) return;
    dotsTimer = setTimeout(() => {
      dotsTimer = 0;
      draw();
    }, Math.max(0, DOTS_MS - (performance.now() - dotsAt)));
  }

  // ---------------------------------------------------------------- the picture

  function cameraKey() {
    const vp = ctx.viewport, t = vp.target, tint = ctx.overlays?.regiontint;
    return `${t.x},${t.z},${vp.distance},${vp.yaw},${vp.pitch},${ui.overlays.regiontint ? tint?.version ?? 0 : -1},${canvas.clientWidth},${vp.dom?.clientWidth},${vp.dom?.clientHeight}`;
  }

  function draw() {
    drawSoon.cancel();
    const map = store.map;
    if (!map || !fit()) return;
    if (baseFor !== map.ground) rebuildGround();
    if (!baseFor) return;
    if (dotsDirty) {
      if (performance.now() - dotsAt >= DOTS_MS) drawDots();
      else touchDots();
    }
    lastKey = cameraKey();
    const W = canvas.width, k = scale(), px = W / (canvas.clientWidth || W), layers = ui.layers;
    const X = (v) => (v + extent) * k;
    const c = g2d;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, W, W);
    c.imageSmoothingEnabled = W < base.width * 3;   // a few screen pixels per cell: show the cells as they are
    c.drawImage(base, 0, 0, W, W);
    const tint = ui.overlays.regiontint ? ctx.overlays?.regiontint?.canvas : null;
    if (tint && tint.width > 0 && layers.regions?.visible !== false) c.drawImage(tint, 0, 0, W, W);

    // the edge of the island
    c.lineWidth = px;
    c.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    c.beginPath();
    c.arc(X(0), X(0), map.radius * k, 0, Math.PI * 2);
    c.stroke();

    c.drawImage(dots, 0, 0);

    const selected = store.selection, sel = [];
    // ---- spawns: the disc when it is large enough to see, and the centre
    if (layers.spawns?.visible) {
      for (const s of map.spawns) {
        const type = dominant(s.types), color = hex(MOB_TYPES[type]?.color ?? 0xffffff), r = s.r * k;
        c.fillStyle = color;
        if (r > 2 * px) {
          c.globalAlpha = 0.28;
          c.beginPath();
          c.arc(X(s.x), X(s.z), r, 0, Math.PI * 2);
          c.fill();
          c.globalAlpha = 1;
        }
        c.fillRect(X(s.x) - 1.5 * px, X(s.z) - 1.5 * px, 3 * px, 3 * px);
        if (selected.has(s)) sel.push([s.x, s.z, Math.max(r, 4 * px)]);
      }
    }
    // ---- chests: gold squares, the big ones bigger
    if (layers.chests?.visible) {
      c.fillStyle = '#ffd84a';
      c.strokeStyle = 'rgba(0, 0, 0, 0.6)';
      for (const chest of map.chests) {
        const s = (chest.big ? 5 : 3.5) * px;
        c.fillRect(X(chest.x) - s / 2, X(chest.z) - s / 2, s, s);
        c.strokeRect(X(chest.x) - s / 2, X(chest.z) - s / 2, s, s);
        if (selected.has(chest)) sel.push([chest.x, chest.z, 4 * px]);
      }
    }
    // ---- NPCs: diamonds
    if (layers.npcs?.visible) {
      c.fillStyle = '#7fe8ff';
      c.strokeStyle = 'rgba(0, 0, 0, 0.7)';
      for (const npc of map.npcs) {
        const x = X(npc.x), z = X(npc.z), s = 3.2 * px;
        c.beginPath();
        c.moveTo(x, z - s); c.lineTo(x + s, z); c.lineTo(x, z + s); c.lineTo(x - s, z);
        c.closePath();
        c.fill();
        c.stroke();
        if (selected.has(npc)) sel.push([npc.x, npc.z, 5 * px]);
      }
    }
    // ---- the start disc
    if (layers.start?.visible) {
      const s = map.start, x = X(s.x), z = X(s.z), arm = 4 * px;
      c.strokeStyle = ink;
      c.lineWidth = 1.5 * px;
      c.beginPath();
      c.arc(x, z, Math.max(s.r * k, 2 * px), 0, Math.PI * 2);
      c.moveTo(x - arm, z); c.lineTo(x + arm, z);
      c.moveTo(x, z - arm); c.lineTo(x, z + arm);
      c.stroke();
      if (selected.has(s)) sel.push([s.x, s.z, Math.max(s.r * k, 2 * px) + 2 * px]);
    }
    // ---- the selection
    c.strokeStyle = accent;
    c.fillStyle = accent;
    c.lineWidth = 1.5 * px;
    for (const [x, z, r] of sel) {
      c.beginPath();
      c.arc(X(x), X(z), r, 0, Math.PI * 2);
      c.stroke();
    }
    if (selected.size && layers.objects?.visible) {
      let n = 0;
      const s = Math.max(2.5 * px, W / 150);
      for (const item of selected) {
        if (store.kindOf(item) !== 'object') continue;
        if (++n > SELECTED_MAX) break;
        c.fillRect(X(item.x) - s / 2, X(item.z) - s / 2, s, s);
      }
    }

    // ---- the camera: what the view covers on the ground, and its target
    const quad = ctx.viewport.viewQuad?.();
    if (Array.isArray(quad) && quad.length === 4) {
      c.beginPath();
      quad.forEach(([x, z], i) => { if (i) c.lineTo(X(x), X(z)); else c.moveTo(X(x), X(z)); });
      c.closePath();
      c.globalAlpha = 0.12;
      c.fillStyle = ink;
      c.fill();
      c.globalAlpha = 1;
      c.strokeStyle = ink;
      c.lineWidth = 1.5 * px;
      c.stroke();
    }
    const t = ctx.viewport.target;
    c.fillStyle = accent;
    c.strokeStyle = ink;
    c.lineWidth = px;
    c.beginPath();
    c.arc(X(t.x), X(t.z), 3 * px, 0, Math.PI * 2);
    c.fill();
    c.stroke();

    const p = hover ?? t;
    const text = `${hover ? 'cursor' : 'camera'}  x ${Math.round(p.x)}  z ${Math.round(p.z)}`;
    if (coords.textContent !== text) coords.textContent = text;
  }
  const drawSoon = rafThrottle(draw);

  // ---------------------------------------------------------------- bookmarks

  function syncMarks() {
    const vp = ctx.viewport, alt = /mac/i.test(navigator.platform || '') ? 'Option' : 'Alt';
    marks.forEach((node, n) => {
      const i = n + 1, has = !!vp.hasBookmark?.(i);
      node.classList.toggle('set', has);
      node.title = has ? `Bookmark ${i}: click to go there (${alt}+${i}) · Shift+click stores the current view`
        : `Bookmark ${i} is empty: Shift+click stores the current view (${alt}+Shift+${i})`;
    });
    top.classList.toggle('active', !!vp.overhead);
  }

  // ---------------------------------------------------------------- pointer: move the camera

  function go(ev) {
    const p = pointOf(ev);
    if (!p) return;
    hover = p;
    ctx.viewport.setTarget(p.x, p.z, { animate: false });
    draw();
  }
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || !store.map) return;
    ev.preventDefault();
    dragging = true;
    try { canvas.setPointerCapture(ev.pointerId); } catch { /* a synthetic event has no pointer to capture */ }
    go(ev);
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (dragging) { go(ev); return; }
    hover = pointOf(ev);
    drawSoon();
  });
  const release = (ev) => {
    if (!dragging) return;
    dragging = false;
    try { canvas.releasePointerCapture(ev.pointerId); } catch { /* already gone */ }
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', () => { if (!dragging) { hover = null; drawSoon(); } });
  el.addEventListener('pointerenter', syncMarks);   // a bookmark may have been stored with the keyboard meanwhile

  // ---------------------------------------------------------------- wiring

  store.on('load', () => {
    baseFor = null;      // another map: its ground is another object
    hover = null;
    catColor.clear();
    dotsDirty = true;
    dotsAt = -Infinity;
    accent = css('--accent', accent);
    ink = css('--text', ink);
    syncMarks();
    drawSoon();
  });
  store.on('change', (change) => {
    const map = store.map;
    if (!map) return;
    if (change.props.includes('ground') || change.props.includes('radius') || baseFor !== map.ground) baseFor = null;
    else if (change.ground && image) paintGround(change.ground.ix0, change.ground.iz0, change.ground.ix1, change.ground.iz1);
    if (change.added.objects.length || change.removed.objects.length || change.updated.objects.length || baseFor === null) touchDots();
    drawSoon();
  });
  store.on('selection', drawSoon);
  ui.on('layers', () => { touchDots(); drawSoon(); });
  ui.on('hiddenModels', () => { touchDots(); drawSoon(); });
  ui.on('overlays', drawSoon);
  new ResizeObserver(() => drawSoon()).observe(canvas);   // also when the collapsed panel is opened

  syncMarks();
  drawSoon();

  return {
    // Every rendered frame: the camera frame follows the camera, the tint follows its overlay.
    update() {
      if (!store.map || !canvas.clientWidth) return;
      drawSoon.flush();   // a draw that was waiting for an animation frame happens in this one
      if (cameraKey() !== lastKey) draw();
    },
  };
}
