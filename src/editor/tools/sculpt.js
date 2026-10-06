// The Sculpt tool: shapes the relief of the map - the height of every ground vertex.
//
//   Raise / Lower   hold the button: the ground under the brush rises (sinks) for as long as it is held, also while
//                   the pointer rests. Alt at the press does the opposite of the mode.
//   Smooth          evens out what is under the brush. Shift at the press smooths in every mode.
//   Flatten         levels the ground to the height it had under the cursor where the stroke began.
//   Set height      levels it to the typed height (a plateau, a pit). Alt+click takes the height under the cursor.
//   Ramp            press, drag, release: the ground along the line becomes a straight slope from the height at the
//                   press to the height at the release, as wide as the brush.
//   [ ]  radius     Shift+[  Shift+]  strength     1 - 6  the mode     Esc  takes the stroke back
//
// What a brush does to the heights is the pure relief.js; this file turns pointer events and frames into cmd.heights.
// One press-drag-release is ONE undo step: store.begin on the press, one command per frame (they merge), commit on the
// release. The stroke adds up in a private copy of the heights (`work`): the map keeps heights on a 0.1 grid, and the
// few hundredths a frame adds at the rim of a brush would round to nothing there.
// Nothing here writes to the map or to the view: the viewport reshapes the terrain when the store reports the change.
import { LIMITS, clampHeight, heightAt } from '../../map/format.js';
import { h, row, button, numberField, rangeField, selectField } from '../ui/dom.js';
import { chordLabel, keyText } from '../keymap.js';
import { SCULPT_MODES, brushReach, dab, ramp } from '../relief.js';

const MODE_LABEL = { raise: 'Raise', lower: 'Lower', smooth: 'Smooth', flatten: 'Flatten', set: 'Set height', ramp: 'Ramp' };
const MODE_HELP = {
  raise: keyText('Hold the button to raise the ground under the brush - it keeps rising while the pointer rests. Alt lowers, Shift smooths.'),
  lower: keyText('Hold the button to lower the ground under the brush. Alt raises, Shift smooths.'),
  smooth: 'Hold the button to even out the ground under the brush.',
  flatten: keyText('Hold the button to level the ground to the height under the cursor where the stroke began. Alt+click takes that height for Set height.'),
  set: keyText('Hold the button to level the ground to the typed height: a plateau, or a pit. Alt+click takes the height under the cursor.'),
  ramp: 'Press, drag and release: a straight slope from the height at the press to the height at the release, as wide as the brush.',
};
const MODE_REST = {
  raise: keyText('hold to raise the ground · Alt: lower · Shift: smooth'),
  lower: keyText('hold to lower the ground · Alt: raise · Shift: smooth'),
  smooth: 'hold to even out the ground',
  flatten: keyText('hold to level the ground to the height where the stroke began · Alt+click: take that height'),
  set: keyText('hold to level the ground to the typed height · Alt+click: take the height under the cursor'),
  ramp: 'press, drag and release: a straight slope between the two heights',
};
const RADIUS = [1, 60], STRENGTH = [0.05, 1];
const SLOPES = [0, 30, 45, 60, 75];
const LOWER_COLOR = 0x8fc2ff, SMOOTH_COLOR = 0xb9f29a, LEVEL_COLOR = 0xffd27a;

const clamp = (v, [min, max]) => Math.max(min, Math.min(max, v));
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const fixed = (v) => (Math.round(v * 10) / 10).toFixed(1);

export default function create(ctx) {
  const { store, ui, cmd } = ctx;

  // What the options strip shows and what scripts may set: read at every use.
  //   radius    world units          strength  0.05 .. 1: how fast the brush works
  //   soft      a bell-shaped brush (true) or the same everywhere inside the ring (false)
  //   height    the height of Set height
  //   slope     the steepest slope a stroke may make, in degrees; 0 = no limit
  const opts = { radius: 8, strength: 0.4, soft: true, height: 5, slope: 60 };
  let mode = 'raise';
  let active = false;
  let stroke = null;       // between press and release: { mode, target, work, x, z, radius, from, base, touched, dead }
  let hover = null;        // the cursor on the ground: { x, z, ix, alt, shift }
  let said = null;         // the status text this tool wrote last
  let strip = null, widgets = null;
  let shown = '';          // what the strip shows of opts (compared every frame: keys and scripts change opts)
  let buffer = null;       // the `work` array of the last stroke, reused while the ground keeps its size
  let stale = false;       // the ground moved under the ring: ring and readout are due on the next frame

  const radiusNow = () => clamp(num(Number(opts.radius), 8), RADIUS);
  const strengthNow = () => clamp(num(Number(opts.strength), 0.4), STRENGTH);
  const heightNow = () => clampHeight(num(Number(opts.height), 0));
  const slopeNow = () => { const s = num(Number(opts.slope), 0); return s > 0 && s < 90 ? s : 0; };
  const layerOpen = () => { const l = ui.layers?.ground; return !l || (l.visible !== false && !l.locked); };

  const resting = () => `Sculpt · ${MODE_LABEL[mode]}: ${MODE_REST[mode]}`;
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

  // ---------------------------------------------------------------- what a stroke does

  // The mode of a press: Shift smooths in every mode, Alt turns Raise into Lower and back.
  function modeOf(ev) {
    if (mode === 'ramp') return 'ramp';
    if (ev.shiftKey) return 'smooth';
    if (ev.altKey && mode === 'raise') return 'lower';
    if (ev.altKey && mode === 'lower') return 'raise';
    return mode;
  }

  // Writes what the stroke has changed in `work` to the map, where it has become visible on the map's 0.1 grid.
  // out: { n, index, value } of relief.js.
  function write(out, label) {
    const heights = store.map.ground.heights, idx = [], val = [];
    for (let k = 0; k < out.n; k++) {
      const i = out.index[k], q = Math.fround(clampHeight(out.value[k]));
      if ((heights ? heights[i] : 0) !== q) { idx.push(i); val.push(q); }
    }
    if (idx.length) store.exec(cmd.heights(idx, val, label));
  }

  function begin(ev, hit) {
    const map = store.map, g = map.ground, how = modeOf(ev);
    const n = g.cells.length;
    // the private copy the stroke adds up in; a ground without heights is flat
    const work = buffer && buffer.length === n ? buffer : (buffer = new Float32Array(n));
    if (g.heights) work.set(g.heights); else work.fill(0);
    const here = heightAt(map, hit.x, hit.z);
    store.begin(MODE_LABEL[how]);
    stroke = {
      mode: how, work, x: hit.x, z: hit.z, radius: radiusNow(),
      target: how === 'set' ? heightNow() : here,       // Flatten: the height under the cursor where the stroke began
      from: how === 'ramp' ? { x: hit.x, z: hit.z, h: here } : null,
      base: how === 'ramp' ? work.slice() : null,       // Ramp: the ground as it was, to lay every new line on
      touched: null,                                    // Ramp: the vertices the line of the last pointer move covered
      dead: false,
    };
  }

  // One frame of a held brush.
  function press(dt) {
    const s = stroke;
    if (!s || s.dead || s.mode === 'ramp') return;
    if (!store.grouping) { s.dead = true; return; }     // the group was closed under the stroke (a new map came in)
    const out = dab(store.map.ground, s.work, {
      x: s.x, z: s.z, radius: s.radius, mode: s.mode, strength: strengthNow(), soft: !!opts.soft, target: s.target, slope: slopeNow(),
    }, Math.min(dt, 0.1));
    write(out, MODE_LABEL[s.mode]);
  }

  // Ramp: the line from the press to where the pointer is now, laid on the ground as it was before the stroke.
  function slope(hit) {
    const s = stroke;
    if (!s || s.dead || s.mode !== 'ramp' || !hit.onGround) return;
    if (!store.grouping) { s.dead = true; return; }
    const map = store.map, g = map.ground, size = g.size, last = size - 1, mid = last / 2;
    // the height at the far end: the ground there as it was before the stroke
    const gx = Math.max(0, Math.min(last, Math.round(hit.x / g.cell + mid))), gz = Math.max(0, Math.min(last, Math.round(hit.z / g.cell + mid)));
    const h1 = s.base[gz * size + gx];
    const out = ramp(g, s.base, { x0: s.from.x, z0: s.from.z, h0: s.from.h, x1: hit.x, z1: hit.z, h1, radius: s.radius, soft: !!opts.soft });
    // what the last line covered and this one does not goes back to what it was
    const now = new Set();
    for (let k = 0; k < out.n; k++) { s.work[out.index[k]] = out.value[k]; now.add(out.index[k]); }
    const idx = [], val = [];
    for (let k = 0; k < out.n; k++) { idx.push(out.index[k]); val.push(out.value[k]); }
    if (s.touched) for (const i of s.touched) if (!now.has(i)) { s.work[i] = s.base[i]; idx.push(i); val.push(s.base[i]); }
    s.touched = now;
    s.to = { x: hit.x, z: hit.z, h: h1 };
    write({ n: idx.length, index: idx, value: val }, MODE_LABEL.ramp);
  }

  // Takes the stroke back. The button may still be down: the rest of the gesture is swallowed.
  function abort() {
    if (!stroke || stroke.dead) return false;
    stroke.dead = true;
    if (store.grouping) store.cancel();
    return true;
  }

  function end() {
    const s = stroke;
    if (!s) return;
    stroke = null;
    if (s.dead) return;
    const kept = store.grouping && store.commit();
    if (!kept) note(`${MODE_LABEL[s.mode]}: nothing changed`);
    else if (s.mode === 'ramp') note(`Ramp from ${fixed(s.from.h)} to ${fixed(s.to?.h ?? s.from.h)}`);
  }

  // ---------------------------------------------------------------- ring, readout

  function track(ev, hit) {
    hover = hit.onGround ? { x: hit.x, z: hit.z, ix: hit.ix, alt: !!ev.altKey, shift: !!ev.shiftKey } : null;
  }

  // The ring lies on the terrain (the viewport drapes it) and the readout says how high the ground under the cursor is.
  function refresh() {
    const map = store.map, vp = ctx.viewport;
    if (!active || !map) return;
    if (!hover) { vp.brush(null); vp.readout(null); return; }
    const how = stroke && !stroke.dead ? stroke.mode : modeOf({ altKey: hover.alt, shiftKey: hover.shift });
    const r = brushReach(map.ground, stroke && !stroke.dead ? stroke.radius : radiusNow());
    const color = how === 'lower' ? LOWER_COLOR : how === 'smooth' ? SMOOTH_COLOR : how === 'raise' ? null : LEVEL_COLOR;
    vp.brush(hover.x, hover.z, r, { inner: opts.soft ? r * 0.5 : 0, color });
    const here = heightAt(map, hover.x, hover.z);
    vp.readout(stroke && !stroke.dead && (how === 'flatten' || how === 'set') ? `h ${fixed(here)} → ${fixed(stroke.target)}` : `h ${fixed(here)}`);
  }

  function pickHeight(hit) {
    if (!hit.onGround) return;
    opts.height = clampHeight(heightAt(store.map, hit.x, hit.z));
    note(`Set height: ${fixed(opts.height)}`);
    syncStrip(true);
  }

  // ---------------------------------------------------------------- options strip

  function setMode(next) {
    if (!SCULPT_MODES.includes(next) || next === mode) return;
    abort();
    mode = next;
    hush();
    buildStrip();
    refresh();
    ctx.viewport?.invalidate();
  }

  // [ and ]: fine steps for a small brush, coarse ones for a large one
  function stepRadius(dir) {
    const r = radiusNow(), step = (v) => (v < 6 ? 0.5 : v < 16 ? 1 : v < 32 ? 2 : 4);
    opts.radius = clamp(Math.round((dir > 0 ? r + step(r) : r - step(r - 0.01)) * 2) / 2, RADIUS);
  }
  function stepStrength(dir) {
    opts.strength = clamp(Math.round((strengthNow() + dir * 0.05) * 100) / 100, STRENGTH);
  }

  // The strip follows the options (keys and scripts change them too). Without `force` only when an option differs
  // from what the strip shows - the check update() makes on every frame.
  function syncStrip(force = false) {
    if (!strip || !widgets) return;
    const key = `${opts.radius}|${opts.strength}|${opts.soft}|${opts.height}|${opts.slope}`;
    if (!force && key === shown) return;
    shown = key;
    widgets.radius.set(radiusNow());
    widgets.strength.set(strengthNow());
    widgets.hard.classList.toggle('active', !opts.soft);
    widgets.softEdge.classList.toggle('active', !!opts.soft);
    widgets.height?.set(heightNow());
    widgets.slope.set(slopeNow());
  }

  function buildStrip() {
    if (!strip) return;
    const node = (x) => x?.el ?? x, w = widgets = {};
    const redraw = () => { syncStrip(true); refresh(); };
    const modes = h('div', { class: 'ui-group', role: 'group', 'aria-label': 'Mode' }, SCULPT_MODES.map((id, i) => {
      const b = button(MODE_LABEL[id], () => setMode(id), { title: `${MODE_HELP[id]} (${i + 1})` });
      b.classList.toggle('active', id === mode);
      b.setAttribute('aria-pressed', String(id === mode));
      return b;
    }));
    w.radius = rangeField({ value: radiusNow(), min: RADIUS[0], max: RADIUS[1], step: 0.5, onInput: (v) => { opts.radius = v; redraw(); } });
    w.strength = rangeField({ value: strengthNow(), min: STRENGTH[0], max: STRENGTH[1], step: 0.05, onInput: (v) => { opts.strength = v; redraw(); } });
    w.hard = button('Hard', () => { opts.soft = false; redraw(); }, { title: 'The brush works the same everywhere inside the ring' });
    w.softEdge = button('Soft', () => { opts.soft = true; redraw(); }, { title: 'The brush is strongest in the middle and fades out to the ring' });
    w.slope = selectField({
      value: slopeNow(), options: SLOPES.map((s) => ({ value: s, label: s ? `${s}°` : 'Off' })),
      onCommit: (v) => { opts.slope = v; redraw(); },
    });
    const radius = row('Radius', w.radius), strength = row('Strength', w.strength), slope = row('Max slope', w.slope);
    radius.title = `Brush radius in world units (${chordLabel('BracketLeft')} ${chordLabel('BracketRight')})`;
    strength.title = `How fast the brush works (${chordLabel('Shift+BracketLeft')} ${chordLabel('Shift+BracketRight')})`;
    slope.title = 'The steepest slope a stroke may make: the ground is not pushed further than that above (below) the vertices next to it. Smooth and Ramp are not limited.';
    const parts = [modes, h('span', { class: 'ui-sep' }), radius, strength, row('Edge', h('div', { class: 'ui-group' }, w.hard, w.softEdge))];
    if (mode === 'set') {
      w.height = numberField({
        value: heightNow(), min: LIMITS.height[0], max: LIMITS.height[1], step: 0.5, digits: 1,
        onInput: (v) => { opts.height = v; }, onCommit: (v) => { opts.height = v; redraw(); },
      });
      const height = row('Height', w.height);
      height.title = keyText(`The height the ground is levelled to, from ${LIMITS.height[0]} to ${LIMITS.height[1]} (Alt+click takes the height under the cursor)`);
      parts.push(height);
    }
    parts.push(slope, h('span', { class: 'ui-hint', title: MODE_HELP[mode] }, MODE_REST[mode]));
    strip.replaceChildren(...parts.map(node));
    syncStrip(true);
  }

  // ---------------------------------------------------------------- the map changes under the tool

  store.on('load', () => {
    // another map object: the group of an open stroke went with the old history, and its heights mean nothing now
    stroke = null;
    hover = null;
    buffer = null;
    if (!active) return;
    ctx.viewport.brush(null);
    ctx.viewport.readout(null);
  });
  // the ground moved under the ring (the stroke itself, an undo): ring and readout follow on the next frame
  store.on('change', (change) => {
    if (!active || !(change.ground?.relief || change.props.includes('ground'))) return;
    stale = true;
    ctx.viewport.invalidate();
  });

  return {
    id: 'sculpt', label: 'Sculpt', icon: '▲', layer: 'ground', picks: [], hidden: false,
    about: 'Shape the hills: raise, lower, smooth and level the ground',
    get intro() { return resting(); },
    get context() { return 'brush'; },
    get mode() { return mode; },
    setMode,
    opts,

    activate() {
      active = true;
      const c = ui.cursor;
      hover = c && c.onGround ? { x: c.x, z: c.z, ix: c.ix, alt: false, shift: false } : null;
      hush();          // the instruction of the mode
      refresh();
    },

    deactivate() {
      abort();
      stroke = null;
      hover = null;
      active = false;
      ctx.viewport.brush(null);
      ctx.viewport.readout(null);
      strip = widgets = null;
      hush();          // (no longer active: this clears what the tool wrote)
    },

    pointerDown(ev, hit) {
      if (!store.map) return;
      if (stroke) abort();                // a press whose release never came
      stroke = null;
      track(ev, hit);
      if (!layerOpen()) {
        ui.toast(`Layer ${ui.layers.ground.visible ? 'locked' : 'hidden'}: ground`, 'warn');
        return;
      }
      if (store.grouping) { ui.toast('Finish the current edit first', 'warn'); return; }
      if (!hit.onGround || hit.ix < 0) { note('Sculpt: the cursor is off the ground'); return; }
      if (ev.altKey && mode !== 'raise' && mode !== 'lower') { pickHeight(hit); return; }
      begin(ev, hit);
      refresh();
      ctx.viewport.invalidate();          // the stroke works in update(): a frame, and one after every frame of it
    },

    // Every pointer move: the brush follows; a Ramp is laid anew to where the pointer is.
    pointerMove(ev, hit) {
      if (!store.map) return;
      track(ev, hit);
      const s = stroke;
      if (s && !s.dead && hit.onGround) {
        s.x = hit.x;
        s.z = hit.z;
        if (s.mode === 'ramp' && (ev.buttons & 1)) slope(hit);
      }
      refresh();
    },

    pointerUp(ev, hit) {
      if (!stroke) return;
      // a Ramp ends where the button is released (a real release: a press that was taken away ends where it was)
      if (stroke.mode === 'ramp' && !stroke.dead && hit?.onGround && ev?.type === 'pointerup') slope(hit);
      end();
      refresh();
    },

    key(action) {
      if (action === 'cancel') {
        if (!abort()) return false;
        note('Stroke cancelled');
        refresh();
        return true;
      }
      if (action === 'brush.smaller' || action === 'brush.larger') {
        stepRadius(action === 'brush.larger' ? 1 : -1);
        note(`Brush radius ${opts.radius}`);
      } else if (action === 'brush.optDown' || action === 'brush.optUp') {
        stepStrength(action === 'brush.optUp' ? 1 : -1);
        note(`Strength ${opts.strength}`);
      } else if (typeof action === 'string' && action.startsWith('brush.type.')) {
        const id = SCULPT_MODES[Number(action.slice('brush.type.'.length)) - 1];
        if (!id) return false;
        setMode(id);
        note(`Sculpt: ${MODE_LABEL[id]}`);
        return true;
      } else return false;
      syncStrip(true);
      refresh();
      return true;
    },

    // Every rendered frame: a held brush works for the time the frame took, whether the pointer moved or not.
    update(dt) {
      if (stroke && !stroke.dead) {
        press(dt);
        ctx.viewport.invalidate();        // ... and asks for the next frame: the editor draws on demand
      }
      // the cursor left the viewport: no ring hangs where it was
      if (hover && !ui.cursor && !stroke) { hover = null; stale = true; }
      if (stale && active) {              // the ground under the ring moved (the stroke, an undo)
        stale = false;
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
