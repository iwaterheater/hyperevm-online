// The Scatter brush: paints random objects of the models chosen in the palette (ui.models, all of them).
//
//   drag            scatter up to the target density under the brush
//   Alt + drag      erase the objects of the brush models under the brush
//   Alt+Shift+drag  erase ANY object under the brush
//   [ ]             radius        Shift+[  Shift+]  density
//
// How it decides where an object goes. The ground carries an invisible lattice of candidate spots - one jittered spot
// per lattice cell, a little denser than the target density - and everything about a spot (its place, its priority,
// the model, the turn, the scale) is a hash of its cell. A dab of the brush looks at the spots inside its disc, most
// wanted first, and fills them while the disc holds fewer objects of the brush models than
//     density x area / 100.
// A spot is refused when it is closer than the min spacing to another object of the brush models, outside
// radius - 1, on blocked ground or on a ground type that is switched off, or too close to a collider, a chest, an NPC
// or the start disc. Nothing is random at the time of the stroke, so:
//   - strokes never pile up: a second pass over the same ground finds its spots taken and the count reached;
//   - the same drag twice adds nothing the second time;
//   - a brush that lies half on a road cannot pack its whole target into the other half: beside the road there are
//     only the lattice's own spots, a quarter more than the target at most.
// A stroke is ONE undo step: store.begin on the press, one cmd.add (they merge) or cmd.remove per pointer move.
import { GROUND_TYPES, LIMITS, cellHash, groundIx, qPos } from '../../map/format.js';
import { modelInfo } from '../../map/catalog.js';
import { h, row, button, checkField, numberField, rangeField } from '../ui/dom.js';
import { chordLabel } from '../keymap.js';

const RADIUS = [1, 40], DENSITY = [0.1, 50], SPACING = [0, 20], CLEAR = [0, 20];
const NO_SCATTER = ['paving', 'dirt', 'dirt_dark'];   // roads and squares: off by default
const OVERSAMPLE = 1.25;      // candidate spots per wanted object: what the spacing and the keep-out refuse must be made up for
const TOUCH = 0.05;           // two objects of the brush models never stand closer than this, whatever the spacing says
const CHEST_R = 0.6;          // a chest has no collider in the editor's view; it is about this wide
const CELL = 8;               // world units: the grid the keep-out shapes are filed in
const WIDE = 64;              // a shape over more grid cells than this is kept in a list of its own
const ERASE_COLOR = 0xff5544;
const TAU = Math.PI * 2;
const BLOCK = GROUND_TYPES.map((t) => t.block === true);

const clamp = (v, [min, max]) => Math.max(min, Math.min(max, v));
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const count = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const css = (hex) => `#${hex.toString(16).padStart(6, '0')}`;
const defaultGround = () => GROUND_TYPES.filter((t) => !t.block && !NO_SCATTER.includes(t.id)).map((t) => t.id);

function pointSegment(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

export default function create(ctx) {
  const { store, ui, cmd } = ctx;

  // What the options strip shows and what scripts may set: read when a stroke starts.
  //   density    target objects per 100 square units          spacing   min distance between two brush-model objects
  //   scale      [min, max]                                   ground    ids of the ground types objects may stand on
  //   keepClear  world units kept free around colliders, chests, NPCs and the start disc; null = do not care
  const opts = { radius: 6, density: 5, spacing: 2, randomRotation: true, scale: [0.9, 1.1], ground: defaultGround(), keepClear: 1 };
  let active = false;
  let stroke = null;       // between press and release, see begin()
  let hover = null;        // the cursor on the ground: { x, z, alt }
  let said = null;         // the status text this tool wrote last
  let clearWas = 1;        // the keep-clear distance to come back to when the checkbox is ticked again
  let strip = null, widgets = null, subs = [];
  let shown = '';
  const near = [], close = [];   // two result buffers for view.queryCircle: the count of a dab, the spacing of a spot

  const layerOpen = () => { const l = ui.layers?.objects; return !l || (l.visible !== false && !l.locked); };
  const brushModels = () => [...new Set((ui.models ?? []).filter((id) => typeof id === 'string' && modelInfo(id)))].sort();
  const radiusNow = () => clamp(num(opts.radius, RADIUS[0]), RADIUS);
  const groundNow = () => (Array.isArray(opts.ground) ? opts.ground : []);
  const scaleNow = () => {
    const s = Array.isArray(opts.scale) ? opts.scale : [1, 1];
    const lo = clamp(num(s[0], 1), LIMITS.scale), hi = clamp(num(s[1], lo), LIMITS.scale);
    return [Math.min(lo, hi), Math.max(lo, hi)];
  };

  function say(text) {
    said = text;
    ui.setStatus(text);
  }
  function hush() {
    if (said !== null && ui.status === said) ui.setStatus('');
    said = null;
  }

  // ---------------------------------------------------------------- what to keep clear of

  // Everything a new object keeps its distance from, as it stands when the stroke starts: the colliders the view
  // knows (objects and NPCs), the chests and the start disc - filed in a grid, so a spot asks only its neighbourhood.
  function keepOut() {
    const map = store.map, o = ctx.view.obstacles(), grid = new Map(), wide = [];
    const file = (rec, ex, ez) => {
      const i0 = Math.floor((rec.x - ex) / CELL), i1 = Math.floor((rec.x + ex) / CELL), j0 = Math.floor((rec.z - ez) / CELL), j1 = Math.floor((rec.z + ez) / CELL);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > WIDE) { wide.push(rec); return; }
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const key = i * 2097152 + j;
          let list = grid.get(key);
          if (!list) grid.set(key, list = []);
          list.push(rec);
        }
      }
    };
    const circle = (x, z, r) => file({ box: false, x, z, r }, r, r);
    // the arrays of view.obstacles() are reused by the view: what is needed is copied out now
    for (let i = 0, k = 0; i < o.nCircles; i++, k += 3) circle(o.circles[k], o.circles[k + 1], o.circles[k + 2]);
    for (let i = 0, k = 0; i < o.nBoxes; i++, k += 5) {
      const hw = o.boxes[k + 2], hd = o.boxes[k + 3], cos = Math.cos(o.boxes[k + 4]), sin = Math.sin(o.boxes[k + 4]);
      file({ box: true, x: o.boxes[k], z: o.boxes[k + 1], hw, hd, cos, sin }, Math.abs(hw * cos) + Math.abs(hd * sin), Math.abs(hw * sin) + Math.abs(hd * cos));
    }
    for (const chest of map.chests) circle(chest.x, chest.z, CHEST_R);
    circle(map.start.x, map.start.z, map.start.r);
    // is (x, z) inside one of the shapes, or closer than `margin` to it?
    const hits = (rec, x, z, margin) => {
      const dx = x - rec.x, dz = z - rec.z;
      if (!rec.box) return Math.hypot(dx, dz) < rec.r + margin;
      const lx = Math.abs(dx * rec.cos - dz * rec.sin) - rec.hw, lz = Math.abs(dx * rec.sin + dz * rec.cos) - rec.hd;
      return (lx < 0 && lz < 0) || Math.hypot(Math.max(lx, 0), Math.max(lz, 0)) < margin;
    };
    return (x, z, margin) => {
      for (const rec of wide) if (hits(rec, x, z, margin)) return true;
      const i0 = Math.floor((x - margin) / CELL), i1 = Math.floor((x + margin) / CELL), j0 = Math.floor((z - margin) / CELL), j1 = Math.floor((z + margin) / CELL);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const list = grid.get(i * 2097152 + j);
          if (list) for (const rec of list) if (hits(rec, x, z, margin)) return true;
        }
      }
      return false;
    };
  }

  // ---------------------------------------------------------------- a stroke

  // The settings of one stroke, frozen at the press: an option changed half way must not move the lattice.
  function begin(erase, models, hit) {
    const density = clamp(num(opts.density, DENSITY[0]), DENSITY), radius = radiusNow();
    const allowed = new Uint8Array(GROUND_TYPES.length), ground = groundNow();
    GROUND_TYPES.forEach((t, i) => { allowed[i] = !t.block && ground.includes(t.id) ? 1 : 0; });
    // another set of models is another lattice: a second layer (bushes between the trees) does not land on the first
    let salt = 7;
    for (const ch of models.join('|')) salt = (salt * 31 + ch.charCodeAt(0)) % 65521;
    const clear = opts.keepClear === null || opts.keepClear === undefined ? null : clamp(num(opts.keepClear, 0), CLEAR);
    return {
      erase, models, set: new Set(models), radius, density,
      spacing: clamp(num(opts.spacing, 0), SPACING), scale: scaleNow(), rotate: !!opts.randomRotation,
      cell: Math.sqrt(100 / (density * OVERSAMPLE)), salt, allowed, clear,
      blocked: erase || clear === null ? null : keepOut(),
      step: radius / 2,          // a dab every half radius along the drag
      last: { x: hit.x, z: hit.z }, carry: 0,
      total: 0, why: { full: 0, taken: 0, ground: 0, edge: 0, spacing: 0, clear: 0, limit: false },   // why spots were refused
      dead: false,
    };
  }

  // The object for one spot of the lattice, or null when the spot is refused. `fresh`: the objects of this dab, which
  // are not in the view yet.
  function objectAt(s, spot, fresh) {
    const map = store.map, g = map.ground, x = spot.x, z = spot.z;
    if (Math.hypot(x, z) > map.radius - 1) { s.why.edge++; return null; }
    if (!s.allowed[g.cells[groundIx(g, z) * g.size + groundIx(g, x)]]) { s.why.ground++; return null; }
    const gap = Math.max(s.spacing, TOUCH), gap2 = gap * gap;
    for (const o of ctx.view.queryCircle(x, z, gap, close)) {
      if (!s.set.has(o.m)) continue;
      const d2 = (o.x - x) ** 2 + (o.z - z) ** 2;
      if (d2 >= gap2) continue;
      if (d2 < TOUCH * TOUCH) s.why.taken++; else s.why.spacing++;   // an object ON the spot: the brush was here before
      return null;
    }
    for (const o of fresh) if ((o.x - x) ** 2 + (o.z - z) ** 2 < gap2) { s.why.spacing++; return null; }
    if (s.blocked && s.blocked(x, z, s.clear)) { s.why.clear++; return null; }
    const roll = (k) => cellHash(spot.i, spot.j, s.salt + k);
    return cmd.make('object', {
      m: s.models[Math.min(s.models.length - 1, Math.floor(roll(3) * s.models.length))],
      x, z,
      ry: s.rotate ? roll(4) * TAU - Math.PI : 0,
      s: s.scale[0] + (s.scale[1] - s.scale[0]) * roll(5),
    });
  }

  // One dab of the brush at (x, z): fills the disc up to the target.
  function dab(s, x, z) {
    const map = store.map, R = s.radius;
    if (Math.hypot(x, z) > map.radius + R) return;                     // all of the disc is off the island
    const target = s.density * Math.PI * R * R / 100;
    let have = 0;
    for (const o of ctx.view.queryCircle(x, z, R, near)) if (s.set.has(o.m)) have++;
    if (have >= target) { s.why.full++; return; }
    const c = s.cell, spots = [];
    const i0 = Math.floor((x - R) / c), i1 = Math.floor((x + R) / c), j0 = Math.floor((z - R) / c), j1 = Math.floor((z + R) / c);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        // on the map's 0.01 grid already: where the object will stand is what must lie inside the disc, so that the
        // count of the next dab and an erase along the same drag see exactly the objects this dab made
        const sx = qPos((i + cellHash(i, j, s.salt)) * c), sz = qPos((j + cellHash(i, j, s.salt + 1)) * c);
        if ((sx - x) ** 2 + (sz - z) ** 2 <= R * R) spots.push({ i, j, x: sx, z: sz, rank: cellHash(i, j, s.salt + 2) });
      }
    }
    spots.sort((a, b) => a.rank - b.rank || a.j - b.j || a.i - b.i);   // the same order whoever asks, and whenever
    const fresh = [];
    for (const spot of spots) {
      if (have + fresh.length >= target) break;
      if (map.objects.length + fresh.length >= LIMITS.objects) { s.why.limit = true; break; }
      const obj = objectAt(s, spot, fresh);
      if (obj) fresh.push(obj);
    }
    if (!fresh.length) return;
    store.exec(cmd.add('object', fresh));
    s.total += fresh.length;
  }

  // Erases what lies within the radius of the segment: the brush models, or anything - but never what may not be
  // picked (a locked layer, a model hidden in Layers).
  function erase(s, x0, z0, x1, z1) {
    const R = s.radius, out = [];
    for (const o of ctx.view.queryCircle((x0 + x1) / 2, (z0 + z1) / 2, Math.hypot(x1 - x0, z1 - z0) / 2 + R, near)) {
      if (s.erase === 'models' && !s.set.has(o.m)) continue;
      if (store.kindOf(o) !== 'object' || !ui.isPickable('object', o)) continue;
      if (pointSegment(o.x, o.z, x0, z0, x1, z1) <= R) out.push(o);
    }
    if (!out.length) return;
    s.total += store.exec(cmd.remove(out)).removed.objects.length;
  }

  // The stroke follows the pointer to (x, z).
  function advance(s, x, z) {
    if (s.dead) return;
    if (!store.grouping) { s.dead = true; return; }          // the group was closed under the stroke (a new map came in)
    const dx = x - s.last.x, dz = z - s.last.z, len = Math.hypot(dx, dz);
    if (len === 0) return;
    if (s.erase) erase(s, s.last.x, s.last.z, x, z);
    else {
      let at = s.step - s.carry;                              // how far along this segment the next dab is due
      for (; at <= len; at += s.step) dab(s, s.last.x + dx * at / len, s.last.z + dz * at / len);
      s.carry = len - (at - s.step);
    }
    s.last = { x, z };
  }

  function showCount() {
    const s = stroke;
    ctx.viewport.readout(s && !s.dead ? `${s.erase ? '−' : '+'}${s.total}` : null);
  }

  function abort() {
    const s = stroke;
    if (!s || s.dead) return false;
    s.dead = true;
    if (store.grouping) store.cancel();
    ctx.viewport.readout(null);
    return true;
  }

  // Says what the stroke did - and when it did nothing, why.
  function report(s) {
    if (s.erase) {
      say(s.total ? `Erased ${count(s.total, 'object')}` : s.erase === 'models' ? 'Nothing to erase: no object of the brush models under the brush (Alt+Shift erases any object)' : 'Nothing to erase under the brush');
      return;
    }
    if (s.why.limit) ui.toast(`A map holds ${LIMITS.objects.toLocaleString('en-US')} objects at most: nothing more was added`, 'warn');
    if (s.total) { say(`Scattered ${count(s.total, 'object')}`); return; }
    const w = s.why, refused = Math.max(w.ground, w.clear, w.spacing, w.edge);
    if (!refused || w.taken > refused) say(w.full || w.taken ? 'Nothing added: the ground under the brush has its objects already' : 'Nothing added: no free spot under the brush');
    else if (refused === w.ground) say('Nothing added: the ground under the brush is switched off in "Ground", or blocked');
    else if (refused === w.clear) say('Nothing added: every spot is too close to a collider, a chest, an NPC or the start ("Keep clear")');
    else if (refused === w.spacing) say('Nothing added: no room left at this min spacing');
    else say('Nothing added: outside the island');
  }

  // ---------------------------------------------------------------- ring

  function showRing() {
    if (!active) return;
    if (!hover || !store.map) { ctx.viewport.brush(null); return; }
    const erasing = stroke && !stroke.dead ? !!stroke.erase : hover.alt;
    ctx.viewport.brush(hover.x, hover.z, stroke && !stroke.dead ? stroke.radius : radiusNow(), { color: erasing ? ERASE_COLOR : null });
  }

  // ---------------------------------------------------------------- options strip

  const step = (v, dir, of) => (dir > 0 ? v + of(v) : v - of(v - 1e-6));
  function stepRadius(dir) {
    opts.radius = clamp(Math.round(step(radiusNow(), dir, (v) => (v < 6 ? 0.5 : v < 16 ? 1 : 2)) * 2) / 2, RADIUS);
  }
  function stepDensity(dir) {
    const d = clamp(num(opts.density, DENSITY[0]), DENSITY);
    opts.density = clamp(Math.round(step(d, dir, (v) => (v < 1 ? 0.1 : v < 10 ? 0.5 : v < 20 ? 1 : 5)) * 10) / 10, DENSITY);
  }

  function release() {
    for (const off of subs) off?.();
    subs = [];
  }

  // The strip follows the options and the palette. Without `force` only when an option differs from what it shows:
  // that is the check update() makes on every frame, for the sake of the keys and of a script that wrote to tool.opts.
  function syncStrip(force = false) {
    if (!strip || !widgets) return;
    const ground = groundNow(), scale = scaleNow();
    const key = `${opts.radius}|${opts.density}|${opts.spacing}|${opts.randomRotation}|${scale}|${ground}|${opts.keepClear}`;
    if (!force && key === shown) return;
    shown = key;
    const w = widgets, on = opts.keepClear !== null && opts.keepClear !== undefined;
    w.radius.set(radiusNow());
    w.density.set(clamp(num(opts.density, DENSITY[0]), DENSITY));
    w.spacing.set(clamp(num(opts.spacing, 0), SPACING));
    w.rotate.set(!!opts.randomRotation);
    w.scaleLo.set(scale[0]);
    w.scaleHi.set(scale[1]);
    w.clearOn.set(on);
    w.clear.set(on ? clamp(num(opts.keepClear, 0), CLEAR) : clearWas);
    w.clear.setDisabled(!on);
    const kinds = GROUND_TYPES.filter((t) => !t.block);
    w.ground.textContent = `${kinds.filter((t) => ground.includes(t.id)).length} of ${kinds.length} types`;
    for (const [id, field] of w.types) field.set(ground.includes(id));
    const models = brushModels();
    w.models.textContent = models.length ? count(models.length, 'model') : 'No models';
    w.models.className = `ui-badge ${models.length ? 'accent' : 'warn'}`;
    w.models.title = models.length ? `The brush scatters: ${models.join(', ')}` : 'Pick one or more models in the palette (Shift+click or Ctrl/Cmd+click for several)';
  }

  function buildStrip() {
    release();
    if (!strip) return;
    const w = widgets = {}, changed = () => { syncStrip(true); showRing(); };
    const number = (key, range, stepBy, digits) => numberField({
      value: opts[key], min: range[0], max: range[1], step: stepBy, digits,
      onInput: (v) => { opts[key] = v; }, onCommit: (v) => { opts[key] = v; changed(); },
    });
    w.models = h('span', { class: 'ui-badge' });
    w.radius = rangeField({ value: radiusNow(), min: RADIUS[0], max: RADIUS[1], step: 0.5, onInput: (v) => { opts.radius = v; changed(); } });
    w.density = number('density', DENSITY, 0.5, 1);
    w.spacing = number('spacing', SPACING, 0.25, 2);
    w.rotate = checkField({ value: opts.randomRotation, onCommit: (on) => { opts.randomRotation = on; changed(); } });
    // the pair stays ordered: an end typed past the other takes it along
    const scale = (i) => numberField({
      value: scaleNow()[i], min: LIMITS.scale[0], max: LIMITS.scale[1], step: 0.05, digits: 2,
      onCommit: (v) => {
        const pair = scaleNow();
        pair[i] = v;
        if (pair[0] > pair[1]) pair[1 - i] = v;
        opts.scale = pair;
        changed();
      },
    });
    w.scaleLo = scale(0);
    w.scaleHi = scale(1);
    w.clearOn = checkField({ value: opts.keepClear !== null, onCommit: (on) => { opts.keepClear = on ? clearWas : null; changed(); } });
    w.clear = numberField({
      value: clearWas, min: CLEAR[0], max: CLEAR[1], step: 0.5, digits: 1,
      onInput: (v) => { clearWas = v; if (opts.keepClear !== null) opts.keepClear = v; },
      onCommit: (v) => { clearWas = v; if (opts.keepClear !== null) opts.keepClear = v; changed(); },
    });

    // ---- the ground-type filter: a button that opens a list of checkboxes
    const setGround = (ids) => { opts.ground = GROUND_TYPES.filter((t) => !t.block && ids.includes(t.id)).map((t) => t.id); changed(); };
    w.types = new Map();
    const lines = GROUND_TYPES.filter((t) => !t.block).map((t) => {
      const field = checkField({
        value: groundNow().includes(t.id),
        onCommit: (on) => setGround(on ? [...groundNow(), t.id] : groundNow().filter((id) => id !== t.id)),
      });
      w.types.set(t.id, field);
      const chip = h('span', { class: 'ui-swatch', style: { background: `linear-gradient(135deg, ${css(t.a)} 50%, ${css(t.b)} 50%)` } });
      // The whole line toggles the box. A label hands the focus to its box when it is clicked; picked with the mouse,
      // the box gives it back, or the hotkeys of the editor would be dead until the next click into the viewport.
      let byPointer = false;
      return h('label', {
        class: 'ui-item',
        onpointerdown: () => { byPointer = true; },
        onclick: (ev) => { if (ev.target === field.input && byPointer) { byPointer = false; field.input.blur(); } },
      }, field, chip, t.name);
    });
    const blocking = GROUND_TYPES.filter((t) => t.block).map((t) => t.name).join(' and ');
    const list = h('div', { class: 'ui-popover', id: 'scatter-ground-types' },
      h('div', { class: 'ui-hint' }, 'Scatter only on these ground types'),
      h('div', { class: 'ui-list' }, lines),
      h('div', { class: 'ui-row' },
        button('All', () => setGround(GROUND_TYPES.map((t) => t.id))),
        button('None', () => setGround([])),
        button('Default', () => setGround(defaultGround()), { title: `Everything except ${NO_SCATTER.join(', ')}` })),
      blocking ? h('div', { class: 'ui-hint' }, `${blocking} never take objects.`) : null);
    w.ground = button('', null, { title: 'The ground types the brush scatters on. Roads and paving are off by default' });
    // under its button, and never over the right edge of the window (240: its width while it cannot be measured yet)
    const place = () => {
      const r = w.ground.getBoundingClientRect(), width = list.offsetWidth || 240;
      Object.assign(list.style, { left: `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`, top: `${r.bottom + 4}px`, right: 'auto', bottom: 'auto' });
    };
    if (typeof list.showPopover === 'function') {
      // the browser's own popover: it floats above the strip, closes on a click elsewhere and on Escape
      list.setAttribute('popover', 'auto');
      w.ground.setAttribute('popovertarget', list.id);
      const opened = (ev) => { if (ev.newState === 'open') place(); };
      list.addEventListener('beforetoggle', opened);   // before it shows: it must not flash in the corner of the window
      list.addEventListener('toggle', opened);         // and again once it has a size
    } else {
      list.hidden = true;
      list.style.position = 'fixed';
      w.ground.addEventListener('click', () => { list.hidden = !list.hidden; if (!list.hidden) place(); });
    }

    const tip = (node, title) => { node.title = title; return node; };
    strip.replaceChildren(
      w.models,
      tip(row('Radius', w.radius), `Brush radius in world units (${chordLabel('BracketLeft')} ${chordLabel('BracketRight')})`),
      tip(row('Density', w.density), `Target: objects per 100 square units (${chordLabel('Shift+BracketLeft')} ${chordLabel('Shift+BracketRight')})`),
      tip(row('Spacing', w.spacing), 'Min distance between two objects of the brush models'),
      tip(row('Rotate', w.rotate), 'Turn every object by a random angle'),
      tip(row('Scale', w.scaleLo, h('span', { class: 'ui-dash' }, '–'), w.scaleHi), 'Scale range: every object gets a scale between the two'),
      row('Ground', w.ground),
      tip(row('Keep clear', w.clearOn, w.clear), 'World units kept free around colliders, chests, NPCs and the start disc'),
      list,
      h('span', { class: 'ui-hint', title: 'Drag to scatter the models chosen in the palette. Hold Alt to erase their objects under the brush, Alt+Shift to erase any object.' },
        'Alt: erase brush models · Alt+Shift: erase any'),
    );
    syncStrip(true);
    subs = [ui.on('models', () => syncStrip(true))];
  }

  // ---------------------------------------------------------------- the map changes under the tool

  store.on('load', () => {
    // another map object: the group of an open stroke went with the old history
    stroke = null;
    hover = null;
    if (!active) return;
    ctx.viewport.brush(null);
    ctx.viewport.readout(null);
  });

  return {
    id: 'scatter', label: 'Scatter', icon: '∴', layer: 'objects', picks: [], hidden: false,
    get context() { return 'brush'; },
    opts,

    activate() {
      active = true;
      const c = ui.cursor;
      hover = c && c.onGround ? { x: c.x, z: c.z, alt: false } : null;
      showRing();
      if (!brushModels().length) say('Scatter: pick one or more models in the palette');
    },

    deactivate() {
      abort();
      stroke = null;
      hover = null;
      active = false;
      ctx.viewport.brush(null);
      ctx.viewport.readout(null);
      release();
      strip = widgets = null;
      hush();
    },

    pointerDown(ev, hit) {
      if (!store.map) return;
      abort();                            // a press whose release never came
      stroke = null;
      hover = hit.onGround ? { x: hit.x, z: hit.z, alt: !!ev.altKey } : null;
      if (!layerOpen()) {
        ui.toast(`Layer ${ui.layers.objects.visible ? 'locked' : 'hidden'}: objects`, 'warn');
        return;
      }
      if (store.grouping) { ui.toast('Finish the current edit first', 'warn'); return; }
      if (!hit.onGround) return;
      const mode = ev.altKey ? (ev.shiftKey ? 'any' : 'models') : false, models = brushModels();
      if (!mode && !models.length) { ui.toast('Scatter: pick one or more models in the palette first', 'warn'); return; }
      const s = begin(mode, models, hit);
      store.begin(mode ? 'Erase objects' : 'Scatter objects');
      stroke = s;
      try {
        if (mode) erase(s, hit.x, hit.z, hit.x, hit.z);
        else dab(s, hit.x, hit.z);
      } catch (err) {
        abort();
        throw err;
      }
      showCount();
      showRing();
    },

    // Every pointer move: with the button down the stroke follows it, and always the ring does.
    pointerMove(ev, hit) {
      if (!store.map) return;
      hover = hit.onGround ? { x: hit.x, z: hit.z, alt: !!ev.altKey } : null;
      if (stroke && !stroke.dead && (ev.buttons & 1) && hit.onGround) {
        advance(stroke, hit.x, hit.z);
        showCount();
      }
      showRing();
    },

    pointerUp(ev, hit) {
      const s = stroke;
      if (!s) return;
      try {
        if (!s.dead && hit.onGround) {
          advance(s, hit.x, hit.z);
          if (!s.dead && !s.erase && s.carry > 0.01) dab(s, s.last.x, s.last.z);   // the end of the drag gets its dab too
        }
      } finally {
        stroke = null;
        ctx.viewport.readout(null);
        if (!s.dead) {
          if (store.grouping) store.commit();
          report(s);
        }
        showRing();
      }
    },

    key(action) {
      if (action === 'cancel') {
        if (!abort()) return false;
        say('Stroke cancelled');
        showRing();
        return true;
      }
      if (action === 'brush.smaller' || action === 'brush.larger') {
        stepRadius(action === 'brush.larger' ? 1 : -1);
        say(`Brush radius ${opts.radius}`);
      } else if (action === 'brush.optDown' || action === 'brush.optUp') {
        stepDensity(action === 'brush.optUp' ? 1 : -1);
        say(`Density ${opts.density} per 100 square units`);
      } else return false;                // the digits choose ground types: Terrain only
      syncStrip(true);
      showRing();
      return true;
    },

    update() {
      // the cursor left the viewport: no ring hangs where it was
      if (hover && !ui.cursor && !stroke) {
        hover = null;
        showRing();
      }
      syncStrip();
    },

    options(el) {
      strip = el;
      buildStrip();
    },
  };
}
