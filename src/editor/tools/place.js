// The Place tool: scenery from the palette onto the map - one object at a time, or a whole row of them.
//
//   Single   every click places one object and the tool stays armed. A ghost follows the cursor.
//            Q / E turn it (Shift 90, Alt 1 degree), [ ] scale it, R re-rolls what is random.
//            Press, drag, release: the press is the position, the drag direction the way the object faces.
//   Line     every click adds a point; Enter or a double-click places the row, Backspace takes the last point back,
//            Esc drops the row. How walls, fences and colonnades are built.
//   Ring     press at the centre, drag to the radius, release places the ring.
//   Alt+click (any mode): the eyedropper - arms the tool with the model, scale and rotation of the object under the cursor.
//
// A row is one undo step and one new group. The pieces of a row are laid out by path.js; this file turns the layout
// into objects, shows the ghost (view.setGhost), the collider footprint of the ghost and the guide lines of a row
// (viewport.overlay), and refuses what a map may not hold: an object beyond radius - 1 or on blocked ground.
//
// The model is ui.models[0], chosen in the palette. Everything else the tool goes by is in the plain object
// `tool.opts`, read at every use: the options strip writes it, and so may a script.
import * as THREE from 'three';
import { h, row, button, checkField, selectField, numberField, angleField } from '../ui/dom.js';
import { hintFor } from '../keymap.js';
import { LIMITS, groundAt, qAngle, qPos, qScale } from '../../map/format.js';
import { colliderOf, modelInfo } from '../../map/catalog.js';
import { dragTracker, placeOnce, snapPoint, snapping } from './common.js';
import { layoutLine, layoutRing, pathLength } from '../path.js';

const DEG = Math.PI / 180, TAU = Math.PI * 2;
const MODES = [
  ['single', 'Single', 'One object per click'],
  ['line', 'Line', 'A row along the points you click: Enter or a double-click places it'],
  ['ring', 'Ring', 'A ring: press at the centre, drag to the radius'],
];
const ORIENT = [
  { value: 'along', label: 'Along' },
  { value: 'perp', label: 'Across' },
  { value: 'centre', label: 'To centre' },
  { value: 'random', label: 'Random' },
];
const DEFAULTS = {
  scale: [1, 1], randomRotation: false, yOffset: 0, surfaceSnap: false,
  spacing: null, orient: 'along', offset: 0, alternate: false, fit: false,
  jitter: 0, randomModel: false,   // beyond the contract: off, they change nothing
};
const MAX_PIECES = 2000;        // one row; more is a typing mistake in the spacing field
const MAX_FOOTPRINTS = 300;     // collider outlines drawn for a row
const DOUBLE_MS = 350;          // a second click in the same spot within this time is the second half of a double-click
const LINE_Y = 0.06;            // the guide lines lie just above the ground
const PREFS_KEY = 'hypercat-editor-palette';   // the palette's key; this tool keeps the Y offset per model in it

const clamp = (v, [min, max]) => Math.max(min, Math.min(max, v));
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const fmt = (v, digits = 2) => String(Number(v.toFixed(digits)));

// A random source that repeats: the pieces of a row keep their roll while the row is being drawn.
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// one number in [0, 1) for piece `i` of a row, independent of the others
const rollAt = (seed, i, salt) => mulberry((seed ^ Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt, 0x85ebca6b)) >>> 0)();

// Line segments on the ground, rewritten on every change of the ghost.
function groundLines(color, opacity) {
  let array = new Float32Array(2048 * 6), n = 0;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(array, 3).setUsage(THREE.DynamicDrawUsage));
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, toneMapped: false });
  const mesh = new THREE.LineSegments(geometry, material);
  mesh.frustumCulled = false;   // rewritten all the time: bounds would be stale more often than right
  mesh.renderOrder = 998;
  mesh.visible = false;
  const seg = (x0, z0, x1, z1) => {
    if (n + 6 > array.length) {
      // a buffer attribute cannot grow: a larger one takes its place
      const next = new Float32Array(array.length * 2);
      next.set(array);
      array = next;
      geometry.setAttribute('position', new THREE.BufferAttribute(array, 3).setUsage(THREE.DynamicDrawUsage));
    }
    array[n++] = x0; array[n++] = LINE_Y; array[n++] = z0;
    array[n++] = x1; array[n++] = LINE_Y; array[n++] = z1;
  };
  return {
    mesh, seg,
    begin() { n = 0; },
    circle(x, z, r, steps = 32) {
      for (let i = 0; i < steps; i++) {
        const a = i / steps * TAU, b = (i + 1) / steps * TAU;
        seg(x + Math.cos(a) * r, z + Math.sin(a) * r, x + Math.cos(b) * r, z + Math.sin(b) * r);
      }
    },
    end() {
      geometry.setDrawRange(0, n / 3);
      geometry.attributes.position.needsUpdate = true;
      mesh.visible = n > 0;
    },
    tint(hex) { material.color.set(hex); },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}

// The Y offsets remembered per model (a torch is mounted at the same height every time). They live in the palette's
// storage key, merged into what is there, so the palette's favourites survive.
function readOffsets() {
  const out = new Map();
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(PREFS_KEY) ?? 'null');
    if (isObj(raw) && isObj(raw.yOffset)) {
      for (const id of Object.keys(raw.yOffset).slice(0, 500)) {
        const v = raw.yOffset[id];
        if (typeof v === 'number' && Number.isFinite(v) && v !== 0 && modelInfo(id)) out.set(id, clamp(v, LIMITS.objectY));
      }
    }
  } catch { /* disabled, full or somebody else's data: nothing is remembered */ }
  return out;
}
function writeOffsets(map) {
  try {
    const s = globalThis.localStorage;
    let raw = null;
    try { raw = JSON.parse(s.getItem(PREFS_KEY)); } catch { raw = null; }
    s.setItem(PREFS_KEY, JSON.stringify({ ...(isObj(raw) ? raw : {}), v: 1, yOffset: Object.fromEntries(map) }));
  } catch { /* the offsets last for this session only */ }
}

export default function create(ctx) {
  const { store, ui, cmd } = ctx;

  const opts = { ...DEFAULTS, scale: [...DEFAULTS.scale] };
  let mode = 'single';
  let active = false;
  let ry = 0;              // the rotation of the single ghost: Q / E, the drag of a press, the eyedropper, a random roll
  let turn = 0;            // added to the rotation of every piece of a line or a ring (Q / E in those modes)
  let roll = { seed: 1, u: 0.5, pick: 0 };   // what is random about the next placement; R rolls again
  let pointer = null;      // where the pointer is over the viewport, with the modifier keys of its last event; null outside
  let press = null;        // the press in progress: { kind: 'single' | 'line' | 'ring' | 'dead', ... }
  let points = [];         // Line: the points clicked so far, [[x, z], ...]
  let last = null;         // the last single placement { m, x, y, z, at }: a double-click must not place two
  let dirty = false;       // the ghost has to be rebuilt before the next frame
  let waiting = null;      // a model whose size was not known when the ghost was built
  let statusText = null;   // the status line this tool has set
  let notice = null;       // { text, sx, sy }: what the last click has to say - it stands in the status line until the pointer moves on
  let foot = null, guide = null;   // groundLines: collider footprints of the ghost; the path being drawn
  let strip = null, widgets = null, stripKey = '';   // the options strip
  let subs = [];           // subscriptions that last while the tool is active
  const offsets = readOffsets();
  const RAY = new THREE.Raycaster(), NDC = new THREE.Vector2();

  // ---------------------------------------------------------------- what is armed

  const armed = () => (Array.isArray(ui.models) ? ui.models.filter((id) => typeof id === 'string' && modelInfo(id)) : []);
  // the model of the next single object: the first of the palette's selection, or any of it when asked for
  function model(u = roll.pick) {
    const list = armed();
    if (!list.length) return null;
    return opts.randomModel && list.length > 1 ? list[Math.min(list.length - 1, Math.floor(u * list.length))] : list[0];
  }
  function scaleRange() {
    const a = clamp(finite(opts.scale?.[0], 1), LIMITS.scale), b = clamp(finite(opts.scale?.[1], a), LIMITS.scale);
    return a <= b ? [a, b] : [b, a];
  }
  const scale = (u = roll.u) => { const [lo, hi] = scaleRange(); return qScale(lo + (hi - lo) * u); };
  const yBase = () => clamp(qPos(finite(opts.yOffset, 0)), LIMITS.objectY);

  function reroll() {
    roll = { seed: (Math.random() * 4294967296) >>> 0, u: Math.random(), pick: Math.random() };
    if (opts.randomRotation) ry = qAngle(Math.random() * TAU);
  }

  // 'Layer locked: objects' while nothing may be placed, else null. (The toolbar disables the button; the layer can
  // still be locked under the active tool.)
  function closed() {
    const l = ui.layers?.objects;
    if (l && l.visible === false) return 'Layer hidden: objects';
    return l?.locked ? 'Layer locked: objects' : null;
  }

  // Why an object may not stand at (x, z), or null.
  function refuse(x, z) {
    const map = store.map;
    if (!map) return 'No map';
    if (Math.hypot(x, z) > map.radius - 1) return 'Outside the island';
    const type = groundAt(map, x, z);
    return type?.block ? `Cannot place on ${String(type.name ?? type.id).toLowerCase()}` : null;
  }

  // The horizontal bounds of a model in world units at s = 1, or null while the model is not loaded.
  function boundsOf(id) {
    const info = modelInfo(id), f = ctx.view.footprint(id);
    if (!info) return null;
    if (!f) return ctx.view.missing?.has(id) ? { minX: -0.5, maxX: 0.5, minZ: -0.5, maxZ: 0.5 } : null;   // the magenta stand-in
    const P = info.scale;
    return { minX: f.minX * P, maxX: f.maxX * P, minZ: f.minZ * P, maxZ: f.maxZ * P };
  }

  const literal = (m, x, y, z, rot, s) => ({ m, x, y, z, rx: 0, ry: rot, rz: 0, s, sy: 1 });

  // ---------------------------------------------------------------- where the cursor points

  function remember(ev, hit) {
    pointer = {
      x: hit.x, z: hit.z, onGround: hit.onGround !== false, sx: hit.sx, sy: hit.sy,
      metaKey: !!ev.metaKey, ctrlKey: !!ev.ctrlKey, shiftKey: !!ev.shiftKey, altKey: !!ev.altKey,
    };
  }

  // Surface snap: where the ray under the cursor meets scenery, or null (bare ground).
  function surface(sx, sy) {
    const r = ctx.viewport.dom.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    NDC.set((sx - r.left) / r.width * 2 - 1, 1 - (sy - r.top) / r.height * 2);
    RAY.setFromCamera(NDC, ctx.viewport.camera);
    const hit = ctx.view.pickObject(RAY);
    return hit ? { x: hit.point.x, y: hit.point.y, z: hit.point.z } : null;
  }

  // Where a single object would stand for this pointer position: { x, y, z, reason } (reason: why not, or null).
  // p carries the position and the modifier keys (a Hit plus an event, or `pointer`).
  function aim(p, ev = p) {
    let x = p.x, z = p.z, y = 0, on = p.onGround !== false;
    if (opts.surfaceSnap) {
      const s = surface(p.sx, p.sy);
      if (s) { x = s.x; z = s.z; y = s.y; on = true; }
    }
    const q = snapPoint(ctx, x, z, ev);
    y = clamp(qPos(y + finite(opts.yOffset, 0)), LIMITS.objectY);
    return { x: q.x, y, z: q.z, reason: on ? refuse(q.x, q.z) : 'Point at the ground' };
  }

  // ---------------------------------------------------------------- rows

  // The pieces of a row as ghost literals with `reason` (why a piece cannot be placed, or null).
  // shape: { points } for a line, { centre, radius, angle } for a ring.
  function layout(shape) {
    const list = armed(), first = list[0], y = yBase();
    if (!first) return [];
    const [lo, hi] = scaleRange(), mid = (lo + hi) / 2, random = opts.orient === 'random', across = opts.orient === 'perp';
    const box = boundsOf(first);
    waiting = box ? null : first;
    // the length of a piece along the path: its extent along local X - across the path, along local Z
    const length = !box ? 1 : across ? box.maxZ - box.minZ : random ? Math.max(box.maxX - box.minX, box.maxZ - box.minZ) : box.maxX - box.minX;
    const o = {
      length, s: mid, spacing: opts.spacing, orient: opts.orient, turn, offset: finite(opts.offset, 0),
      alternate: !!opts.alternate, fit: !!opts.fit, jitter: finite(opts.jitter, 0), max: MAX_PIECES, rnd: mulberry(roll.seed),
    };
    const raw = shape.points ? layoutLine(shape.points, o) : layoutRing(shape.centre, shape.radius, { ...o, startAngle: shape.angle });
    const several = opts.randomModel && list.length > 1;
    return raw.map((p, i) => {
      const m = several ? list[Math.min(list.length - 1, Math.floor(rollAt(roll.seed, i, 1) * list.length))] : first;
      const s = clamp(qScale(hi > lo ? p.s * (lo + (hi - lo) * rollAt(roll.seed, i, 2)) / mid : p.s), LIMITS.scale);
      let x = p.x, z = p.z;
      const b = random ? null : m === first ? box : boundsOf(m);
      if (b) {
        // The layout gives the CENTRE of a piece. Along the path that is the centre of its bounds, so a row of
        // touching pieces runs exactly from point to point whatever the model's origin is. Sideways the origin is the
        // axis the model was built around (a wall and its gate must line up) - unless the origin lies outside the
        // model altogether, as with the hex-edge fences, which sit a whole unit beside theirs: those are centred too.
        const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
        const lx = (across ? (b.minX > 0 || b.maxX < 0 ? cx : 0) : cx) * s, lz = (across ? cz : (b.minZ > 0 || b.maxZ < 0 ? cz : 0)) * s;
        const cos = Math.cos(p.ry), sin = Math.sin(p.ry);
        x -= lx * cos + lz * sin;
        z -= -lx * sin + lz * cos;
      }
      const piece = literal(m, qPos(x), y, qPos(z), qAngle(p.ry), s);
      piece.reason = refuse(piece.x, piece.z);
      return piece;
    });
  }

  // Adds the pieces that may be placed as ONE undo step and ONE new group. -> whether anything was placed
  function commitRow(pieces, what) {
    const why = closed();
    if (why) { ui.toast(why, 'warn'); return false; }
    if (store.grouping) { ui.toast('Finish the current edit first', 'warn'); return false; }
    if (waiting) {
      ctx.view.loadModel(waiting);
      ui.toast('The model is still loading: try again in a moment', 'warn');
      return false;
    }
    const good = pieces.filter((p) => !p.reason), skipped = pieces.length - good.length;
    if (!good.length) {
      ui.toast(pieces.length ? `Nothing placed: ${pieces[0].reason.toLowerCase()}` : 'Nothing to place', 'warn');
      return false;
    }
    const g = store.newGroupIds(1)[0];
    const objs = good.map((p) => cmd.make('object', { m: p.m, x: p.x, y: p.y, z: p.z, ry: p.ry, s: p.s, g }));
    const n = `${objs.length} object${objs.length === 1 ? '' : 's'}`;
    store.exec(cmd.batch(`Place a ${what} of ${n}`, [cmd.add('object', objs)]));
    store.select(objs);
    const reason = skipped ? pieces.find((p) => p.reason).reason.toLowerCase() : '';
    ui.toast(`Placed a ${what} of ${n} as group ${g}${skipped ? `, ${skipped} skipped (${reason})` : ''}`, skipped ? 'warn' : 'info');
    if (pieces.length >= MAX_PIECES) ui.toast(`A row holds at most ${MAX_PIECES} pieces: check the spacing`, 'warn');
    for (const id of new Set(objs.map((o) => o.m))) keepOffset(id);
    reroll();
    return true;
  }

  function commitLine() {
    if (points.length < 2) {
      tell('A line needs two points: click another one');
      return false;
    }
    const done = commitRow(layout({ points }), 'line');
    if (done) points = [];
    refresh();
    return done;
  }

  // ---------------------------------------------------------------- single objects

  function keepOffset(id) {
    const y = yBase(), before = offsets.get(id) ?? 0;
    if (y === before) return;
    if (y === 0) offsets.delete(id);
    else offsets.set(id, y);
    writeOffsets(offsets);
  }

  function placeSingle(p) {
    const why = closed();
    if (why) { ui.toast(why, 'warn'); return; }
    if (store.grouping) { ui.toast('Finish the current edit first', 'warn'); return; }
    const m = model();
    if (!m) { ui.toast('Pick a model in the palette first', 'warn'); return; }
    if (p.reason) {   // the click is ignored and the status bar says why
      tell(`${p.reason}: nothing placed`);
      return;
    }
    const now = performance.now();
    if (last && last.m === m && last.x === p.x && last.y === p.y && last.z === p.z && now - last.at < DOUBLE_MS) return;
    placeOnce(ctx, 'object', { m, x: p.x, y: p.y, z: p.z, ry, s: scale() });   // one undo step; the object becomes the selection
    last = { m, x: p.x, y: p.y, z: p.z, at: now };
    keepOffset(m);
    reroll();
  }

  // Alt+click: the tool takes over the model, the scale and the rotation of the object under the cursor.
  function eyedrop(hit) {
    const obj = hit.kind === 'object' ? hit.item : null;
    if (!obj) {
      tell('Nothing to pick up here: Alt+click an object to take its model, scale and rotation');
      return;
    }
    ry = obj.ry;
    opts.scale = [obj.s, obj.s];
    opts.randomRotation = false;      // the rotation that was just picked up is the one to place
    ui.set('models', [obj.m]);        // the palette follows; our own listener re-arms the ghost
    ui.toast(`Picked up ${obj.m}`);
  }

  // ---------------------------------------------------------------- the ghost

  // A remark about the click that just happened. It outlasts the rebuilds of the ghost and goes when the pointer moves on.
  function tell(text) {
    notice = { text, sx: pointer?.sx ?? 0, sy: pointer?.sy ?? 0 };
  }

  function say(text) {
    if (text === statusText) return;
    statusText = text;
    ui.setStatus(text ?? '');
  }

  function hint() {
    const m = model();
    if (!m) return 'Place: pick a model in the palette';
    const name = modelInfo(m)?.label ?? m;
    if (mode === 'line') {
      return points.length
        ? `Line of ${name}: click the next point, Enter or double-click to place, Backspace takes a point back, Esc drops the line`
        : `Line of ${name}: click the first point`;
    }
    if (mode === 'ring') return `Ring of ${name}: press at the centre and drag to the radius`;
    return `Place ${name}: click to place, drag to turn, Q / E rotate, [ ] scale, R re-roll, Alt+click picks up an object`;
  }

  // Rebuilds everything the tool shows from its state: the ghost, its collider footprints, the guide lines of a row,
  // the readout by the cursor and the status line.
  function refresh() {
    dirty = false;
    if (!active) return;
    const map = store.map, why = closed();
    let ghost = null, valid = true, status = null, readout = null;
    waiting = null;
    guide.begin();
    foot.begin();

    if (map && !why && armed().length) {
      if (mode === 'single') {
        const at = press?.kind === 'single' ? press : pointer ? aim(pointer) : null;
        const m = model();
        if (at && m) {
          ghost = [literal(m, at.x, at.y, at.z, ry, scale())];
          valid = !at.reason;
          status = at.reason;
          if (press?.kind === 'single' && press.turned) readout = `${fmt(ry / DEG, 1)}°`;
        }
      } else {
        let pieces = null;
        const here = pointer?.onGround ? snapPoint(ctx, pointer.x, pointer.z, pointer) : null;
        if (mode === 'line') {
          const pts = points.slice(), tip = pts[pts.length - 1];
          if (here && (!tip || Math.hypot(here.x - tip[0], here.z - tip[1]) >= 0.01)) pts.push([here.x, here.z]);
          for (let i = 1; i < pts.length; i++) guide.seg(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
          for (const p of points) guide.circle(p[0], p[1], 0.35, 12);
          if (pts.length >= 2) {
            pieces = layout({ points: pts });
            readout = `${fmt(pathLength(pts), 1)} long · ${pieces.length} piece${pieces.length === 1 ? '' : 's'}`;
          }
        } else if (press?.kind === 'ring' && press.moved && press.r > 0) {
          pieces = layout({ centre: { x: press.cx, z: press.cz }, radius: press.r, angle: press.angle });
          guide.circle(press.cx, press.cz, press.r, 96);
          guide.seg(press.cx, press.cz, press.cx + Math.cos(press.angle) * press.r, press.cz + Math.sin(press.angle) * press.r);
          readout = `r ${fmt(press.r)} · ${pieces.length} piece${pieces.length === 1 ? '' : 's'}`;
        }
        if (pieces) {
          const good = pieces.filter((p) => !p.reason);
          ghost = good.length ? good : pieces;       // what will be placed - or, when nothing can be, all of it in red
          valid = good.length > 0;
          if (good.length < pieces.length) status = `${pieces.length - good.length} of ${pieces.length} pieces cannot be placed: ${pieces.find((p) => p.reason).reason.toLowerCase()}`;
          if (pieces.length >= MAX_PIECES) status = `A row holds at most ${MAX_PIECES} pieces: check the spacing`;
        } else if (here && !(press?.kind === 'ring')) {
          // nothing to lay out yet: one piece under the cursor shows the model, its scale and its turn
          const reason = refuse(here.x, here.z);
          ghost = [literal(armed()[0], here.x, yBase(), here.z, qAngle(turn), scale(0.5))];
          valid = !reason;
          status = reason;
        }
      }
    }

    if (ghost) {
      const n = Math.min(ghost.length, MAX_FOOTPRINTS);
      for (let i = 0; i < n; i++) {
        const obj = ghost[i], c = colliderOf(obj, modelInfo(obj.m), ctx.view.footprint(obj.m));
        for (const k of c.circles) foot.circle(k.x, k.z, k.r, 28);
        for (const k of c.boxes) {
          const cos = Math.cos(k.ry), sin = Math.sin(k.ry);
          const corner = (lx, lz) => [k.x + lx * cos + lz * sin, k.z - lx * sin + lz * cos];
          const q = [corner(-k.hw, -k.hd), corner(k.hw, -k.hd), corner(k.hw, k.hd), corner(-k.hw, k.hd)];
          for (let j = 0; j < 4; j++) foot.seg(q[j][0], q[j][1], q[(j + 1) % 4][0], q[(j + 1) % 4][1]);
        }
      }
    }
    foot.tint(valid ? 0xffd27a : 0xff5a5a);
    foot.end();
    guide.end();
    ctx.view.setGhost(ghost, { valid });
    ctx.viewport.readout(readout);
    say(why ?? notice?.text ?? status ?? hint());
    ctx.viewport.invalidate();
  }

  function touch() {
    dirty = true;
    ctx.viewport?.invalidate();
  }

  // ---------------------------------------------------------------- options strip

  const stateKey = () => JSON.stringify([mode, opts, ry, turn, armed(), points.length, ui.snap?.on]);

  function sync() {
    const w = widgets;
    if (!w) return;
    stripKey = stateKey();
    const [lo, hi] = scaleRange(), list = armed(), m = list[0];
    w.model.textContent = !m ? 'No model: pick one in the palette'
      : list.length > 1 ? `${modelInfo(m).label} +${list.length - 1}` : modelInfo(m).label;
    w.model.title = list.join('\n');
    w.rotation.set(mode === 'single' ? ry : turn);
    w.lo.set(lo);
    w.hi.set(hi);
    w.y.set(finite(opts.yOffset, 0));
    w.randomModel.set(!!opts.randomModel);
    w.randomModel.setDisabled(list.length < 2);
    w.randomRotation?.set(!!opts.randomRotation);
    w.surface?.set(!!opts.surfaceSnap);
    if (w.spacing) {
      const typed = typeof opts.spacing === 'number' && opts.spacing > 0;
      const box = m ? boundsOf(m) : null, piece = box ? (opts.orient === 'perp' ? box.maxZ - box.minZ : box.maxX - box.minX) * (lo + hi) / 2 : 1;
      w.spacingMode.set(typed ? 'custom' : 'auto');
      w.spacing.set(typed ? opts.spacing : qPos(piece));
      w.spacing.setDisabled(!typed);
      w.orient.set(opts.orient);
      w.offset.set(finite(opts.offset, 0));
      w.alternate.set(!!opts.alternate);
      w.fit.set(!!opts.fit);
      w.jitter.set(finite(opts.jitter, 0));
    }
    if (w.finish) w.finish.disabled = points.length < 2;
    if (w.back) w.back.disabled = points.length < 1;
  }

  // The strip is ONE line that scrolls sideways when it is too long: the rows of a line or a ring are kept short
  // (narrow fields, one-word labels, the explanation in the tooltip) and come in the order they are reached for.
  function build() {
    const el = strip;
    if (!el) return;
    el.replaceChildren();
    const w = widgets = {};
    const path = mode !== 'single';
    const changed = () => { stripKey = stateKey(); touch(); };
    const key = (action) => { const k = hintFor(action); return k ? ` ${k}` : ''; };
    const slim = (field, px = 46) => { field.input.style.width = `${px}px`; return field; };
    const titled = (node, title) => { node.title = title; return node; };

    const modes = MODES.map(([id, label, title]) => {
      const b = button(label, () => tool.setMode(id), { title });
      b.classList.toggle('active', id === mode);
      b.setAttribute('aria-pressed', String(id === mode));
      return b;
    });
    w.model = h('span', { class: 'ui-badge accent' });

    w.rotation = slim(angleField({
      value: 0, step: 15 * DEG,
      onInput: (rad) => { if (mode === 'single') ry = qAngle(rad); else turn = qAngle(rad); changed(); },
    }), 56);
    const range = (i) => slim(numberField({
      value: 1, min: LIMITS.scale[0], max: LIMITS.scale[1], step: 0.05, digits: 3,
      onInput: (v) => {
        const [lo, hi] = scaleRange();
        // an end pushed past the other takes it along; both at once while they are one number
        opts.scale = i === 0 ? [v, lo === hi ? v : Math.max(v, hi)] : [Math.min(lo, v), v];
        changed();
      },
      onCommit: () => sync(),
    }));
    w.lo = range(0);
    w.hi = range(1);
    w.y = slim(numberField({
      value: 0, min: LIMITS.objectY[0], max: LIMITS.objectY[1], step: 0.1,
      onInput: (v) => { opts.yOffset = v; changed(); },
      onCommit: () => { const m = armed()[0]; if (m) keepOffset(m); },
    }));
    w.randomModel = checkField({ value: false, onCommit: (on) => { opts.randomModel = on; reroll(); changed(); } });

    const rotationRow = titled(row(path ? 'Turn' : 'Rotation', w.rotation), path
      ? 'Added to the rotation of every piece (Q / E before the first point): 180 degrees turn a ring inside out'
      : 'The rotation of the next object. Q / E turn it by 15 degrees (Shift 90, Alt 1); dragging a press sets it');
    const scaleRow = titled(row('Scale', w.lo, h('span', { class: 'ui-dash' }, '–'), w.hi),
      'Every object gets a scale between the two numbers. [ and ] scale both');
    const yRow = titled(row(path ? 'Y' : 'Y offset', w.y), 'Y offset: raises (or sinks) what is placed; remembered per model');
    const modelRow = titled(row(path ? 'Mix' : 'Mix models', w.randomModel),
      'Mix models: with several models selected in the palette, every object is a random one of them');

    el.append(h('div', { class: 'ui-group' }, modes), w.model);
    if (!path) {
      w.randomRotation = checkField({ value: false, onCommit: (on) => { opts.randomRotation = on; reroll(); changed(); sync(); } });
      w.surface = checkField({ value: false, onCommit: (on) => { opts.surfaceSnap = on; changed(); } });
      el.append(
        rotationRow,
        titled(row('Random', w.randomRotation), 'Every object gets a random rotation; R rolls again'),
        scaleRow, yRow,
        titled(row('Surface snap', w.surface), 'The object lands on the scenery under the cursor: crates on crates, a torch on a wall'),
        modelRow,
      );
    } else {
      if (mode === 'line') {
        w.finish = button(`Place${key('path.commit')}`, () => commitLine(), { title: 'Place the row along the points clicked so far (Enter, or a double-click on the last point)' });
        w.back = button(`Back${key('path.back')}`, () => { if (points.length) { points.pop(); refresh(); sync(); } }, { title: 'Take the last point back (Backspace)' });
        el.append(w.finish, w.back);
      }
      w.spacingMode = selectField({
        value: 'auto', options: [{ value: 'auto', label: 'Auto' }, { value: 'custom', label: 'Custom' }],
        onCommit: (v) => { opts.spacing = v === 'custom' ? Math.max(0.1, w.spacing.value ?? 1) : null; changed(); sync(); },
      });
      w.spacing = slim(numberField({ value: 1, min: 0.1, max: 200, step: 0.5, onInput: (v) => { opts.spacing = v; changed(); } }));
      w.orient = selectField({ value: 'along', options: ORIENT, onCommit: (v) => { opts.orient = v; changed(); sync(); } });
      w.offset = slim(numberField({ value: 0, min: -100, max: 100, step: 0.5, onInput: (v) => { opts.offset = v; changed(); } }));
      w.alternate = checkField({ value: false, onCommit: (on) => { opts.alternate = on; changed(); } });
      w.fit = checkField({ value: false, onCommit: (on) => { opts.fit = on; changed(); } });
      w.jitter = slim(numberField({ value: 0, min: 0, max: 20, step: 0.1, onInput: (v) => { opts.jitter = v; changed(); } }));
      const alt = h('span', { class: 'ui-dim', onclick: () => w.alternate.input.click() }, 'alt.');
      el.append(
        titled(row('Spacing', w.spacingMode, w.spacing), 'The distance between two pieces. Auto: the length of the model, so the pieces touch. Custom: a number of your own'),
        titled(row('Fit', w.fit), 'The row ends exactly on the last point, the ring closes: the pieces are scaled (or a custom spacing stretched) to fit'),
        titled(row('Orient', w.orient), 'How the pieces are turned. Along: local +X along the path. Across: local +X across it. To centre: local +Z faces the centre of a ring. Random: any way'),
        rotationRow, scaleRow,
        titled(row('Offset', w.offset, w.alternate, alt), 'Moves the row sideways: to the left of a line, out of a ring. alt.: the offset changes sides from piece to piece'),
        titled(row('Jitter', w.jitter), 'Every piece is moved by a random distance up to this: a row of trees that is not a ruler line'),
        yRow, modelRow,
      );
    }
    sync();
  }

  // ---------------------------------------------------------------- the model in the palette changed

  ui.on('models', () => {
    const m = armed()[0];
    opts.yOffset = m ? offsets.get(m) ?? 0 : 0;   // remembered per model
    if (m) ctx.view?.loadModel(m);                // its size is needed for a row, its shape for the ghost
    if (!active) return;
    roll.pick = Math.random();
    touch();
  });
  store.on('load', () => {   // another map: the points and the press belong to the old one
    points = [];
    press = press ? { kind: 'dead' } : null;
    last = null;
    if (active) touch();
  });

  // ---------------------------------------------------------------- the tool

  const tool = {
    id: 'place', label: 'Place', icon: '✚', layer: 'objects', picks: ['object'], hidden: false,
    // a line in progress takes Backspace and Enter; everything else is a ghost that Q, E, [ ] and R act on
    get context() { return mode === 'line' && points.length > 0 ? 'path' : 'ghost'; },
    get mode() { return mode; },
    opts,
    get rotation() { return mode === 'single' ? ry : turn; },
    set rotation(v) { if (Number.isFinite(v)) { if (mode === 'single') ry = qAngle(v); else turn = qAngle(v); touch(); } },

    setMode(next) {
      if (!MODES.some(([id]) => id === next)) throw new TypeError(`place.setMode: no such mode: ${next}`);
      if (next === mode) return;
      mode = next;
      points = [];
      notice = null;
      press = press ? { kind: 'dead' } : null;
      if (!active) return;
      build();
      refresh();
    },

    activate() {
      active = true;
      press = null;
      points = [];
      pointer = null;
      statusText = null;
      notice = null;
      foot = groundLines(0xffd27a, 0.9);
      guide = groundLines(0x8fc2ff, 0.9);
      ctx.viewport.overlay.add(guide.mesh, foot.mesh);
      const c = ui.cursor;
      if (c) remember({}, c);   // the tool was chosen with a key: the pointer is over the viewport already
      const m = armed()[0];
      if (m) ctx.view.loadModel(m);
      reroll();
      subs = [
        ui.on('cursor', (hit) => { if (hit === null && pointer && !press) { pointer = null; touch(); } }),   // the pointer left the viewport
        ui.on('layers', touch),
        ui.on('snap', touch),
      ];
      refresh();
    },

    deactivate() {
      active = false;
      for (const off of subs) off?.();
      subs = [];
      press = null;
      points = [];
      pointer = null;
      waiting = null;
      strip = widgets = null;
      ctx.view.setGhost(null);
      foot?.dispose();
      guide?.dispose();
      foot = guide = null;
      ctx.viewport.readout(null);
      if (statusText !== null && ui.status === statusText) ui.setStatus('');
      statusText = null;
      ctx.viewport.invalidate();
    },

    pointerDown(ev, hit) {
      remember(ev, hit);
      notice = null;
      const why = closed();
      if (why) { ui.toast(why, 'warn'); press = { kind: 'dead' }; return; }
      if (ev.altKey) {
        eyedrop(hit);
        press = { kind: 'dead' };
        refresh();
        return;
      }
      if (!armed().length) { ui.toast('Pick a model in the palette first', 'warn'); press = { kind: 'dead' }; return; }
      if (mode === 'single') {
        // the press is the position; a drag from here turns the object
        press = { kind: 'single', ...aim(hit, ev), gx: hit.x, gz: hit.z, tracker: dragTracker(ev), turned: false, ry0: ry };
      } else if (mode === 'ring') {
        const c = snapPoint(ctx, hit.x, hit.z, ev);
        press = { kind: hit.onGround === false ? 'dead' : 'ring', cx: c.x, cz: c.z, tracker: dragTracker(ev), moved: false, r: 0, angle: 0 };
      } else press = { kind: 'line' };
      refresh();
    },

    pointerMove(ev, hit) {
      remember(ev, hit);
      if (notice && Math.hypot(hit.sx - notice.sx, hit.sy - notice.sy) > 4) notice = null;
      const p = press;
      if (p?.kind === 'single' && p.tracker.moved(ev)) {
        const dx = hit.x - p.gx, dz = hit.z - p.gz;
        if (Math.hypot(dx, dz) > 1e-3) {
          let a = Math.atan2(dx, dz);   // the object's front, local +Z, looks where the drag goes
          if (snapping(ctx, ev) || ev.shiftKey) {
            const step = ui.snap?.angle > 0 ? ui.snap.angle : 15 * DEG;
            a = Math.round(a / step) * step;
          }
          ry = qAngle(a);
          p.turned = true;
        }
      } else if (p?.kind === 'ring') {
        if (!p.moved && p.tracker.moved(ev)) p.moved = true;
        if (p.moved && hit.onGround !== false) {
          const q = snapPoint(ctx, hit.x, hit.z, ev);
          p.r = qPos(Math.hypot(q.x - p.cx, q.z - p.cz));
          p.angle = Math.atan2(q.z - p.cz, q.x - p.cx);
        }
      }
      touch();   // update() rebuilds the ghost once per frame, however many moves a frame brings
    },

    pointerUp(ev, hit) {
      const p = press;
      press = null;
      // The viewport also ends a press that had no release - the tool was switched under it, the pointer was cancelled,
      // the window lost the focus - and hands over the last event it has. Only a real release places something.
      if (!p || p.kind === 'dead' || ev?.type !== 'pointerup') {
        if (p?.kind === 'single') ry = p.ry0;
        refresh();
        return;
      }
      remember(ev, hit);
      if (p.kind === 'single') placeSingle(p);
      else if (p.kind === 'ring') {
        if (!p.moved || !(p.r > 0)) tell('A click places no ring: press at the centre and DRAG to the radius');
        else commitRow(layout({ centre: { x: p.cx, z: p.cz }, radius: p.r, angle: p.angle }), 'ring');
      } else if (hit.onGround !== false) {
        const q = snapPoint(ctx, hit.x, hit.z, ev), tip = points[points.length - 1];
        // a double-click delivers two clicks first: its second one must not add the end point twice
        if (!tip || Math.hypot(q.x - tip[0], q.z - tip[1]) >= 0.01) points.push([q.x, q.z]);
      }
      refresh();
      sync();
    },

    doubleClick() {
      if (mode === 'line' && points.length) commitLine();
    },

    key(action, ev) {
      if (action === 'rotate.ccw' || action === 'rotate.cw') {
        const step = (ev?.shiftKey ? 90 : ev?.altKey ? 1 : 15) * DEG * (action === 'rotate.ccw' ? 1 : -1);
        if (mode === 'single') ry = qAngle(ry + step);
        else turn = qAngle(turn + step);
        refresh();
        return true;
      }
      if (action === 'scale.down' || action === 'scale.up') {
        const f = action === 'scale.up' ? 1.1 : 0.9, [lo, hi] = scaleRange();
        opts.scale = [clamp(qScale(lo * f), LIMITS.scale), clamp(qScale(hi * f), LIMITS.scale)];
        refresh();
        return true;
      }
      if (action === 'ghost.reroll') {
        reroll();
        refresh();
        return true;
      }
      if (action === 'path.back') {
        if (mode !== 'line' || !points.length) return false;
        points.pop();
        refresh();
        return true;
      }
      if (action === 'path.commit') {
        if (mode !== 'line' || !points.length) return false;
        commitLine();
        return true;
      }
      if (action === 'cancel') {
        if (press && press.kind !== 'dead') {   // a press in progress: it places nothing, and its drag is taken back
          if (press.kind === 'single') ry = press.ry0;
          press = { kind: 'dead' };
          refresh();
          return true;
        }
        if (mode === 'line' && points.length) {
          points = [];
          refresh();
          return true;
        }
      }
      return false;   // Esc with nothing in progress leaves the tool
    },

    update() {
      if (waiting && ctx.view.footprint(waiting)) dirty = true;   // the model of the row has arrived: lay it out again
      if (dirty) refresh();
      if (widgets && stripKey !== stateKey()) sync();             // a key, a script or the eyedropper changed what the strip shows
    },

    options(el) {
      strip = el;
      build();
    },
  };
  return tool;
}
