import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { LIMITS, qPos } from '../map/format.js';
import { describe, editable, pivotOf, snapPoint, snapping } from './tools/common.js';

// The gizmo of the Select tool: ONE set of handles at the pivot of the selection, no modes.
//   0  X arrow        move along X            3  ring           turn about the pivot
//   1  Z arrow        move along Z            4  corner block   scale about the pivot
//   2  centre pad     move freely             5  short up arrow lift (objects only)
// It keeps its size on screen, is drawn over the scene with plain meshes in viewport.overlay, and is picked
// analytically in pixels - no ray is cast at it. (TransformControls is not used: in r170 it is not an Object3D, knows
// no pivot for instances and needs modes.)
//
// A drag is one undo step: begin() opens a store group, every move() runs ONE cmd.transform relative to the snapshot
// taken at the press, end() commits and cancel() takes it all back. The viewport feeds it: setItems() on every
// selection change, update() on every frame, pick() as the first stage of a pick, setHover() from the pointer.

const DEG = Math.PI / 180;
// sizes in pixels on screen
const AXIS_FROM = 16, AXIS_LENGTH = 62, HEAD = 18, HEAD_R = 6.5, SHAFT = 3;
const AXIS_TO = AXIS_FROM + AXIS_LENGTH + HEAD;
const LIFT_FROM = 16, LIFT_LENGTH = 30, LIFT_TO = LIFT_FROM + LIFT_LENGTH + HEAD;
const PAD = 11;                 // half the side of the centre pad
const RING = 112, RING_WIDTH = 5;
const CORNER = 60, CORNER_SIZE = 12;
const PICK_PAD = 13, PICK_CORNER = 10, PICK_AXIS = 7, PICK_RING = 7;   // how close the cursor must come
const END_ON = 10;              // an arrow shorter than this on screen points at the camera: it cannot be grabbed
const RING_STEPS = 48;
const COLORS = [0xff5263, 0x4d8dff, 0xffffff, 0xffd24d, 0xc58bff, 0x62d96b];
const OPACITY = [0.95, 0.95, 0.5, 0.9, 0.95, 0.95];
const VERBS = ['Move', 'Move', 'Move', 'Rotate', 'Scale', 'Lift'];
const ON_TOP = { depthTest: false, depthWrite: false, transparent: true, toneMapped: false, side: THREE.DoubleSide };

const V = new THREE.Vector3(), WHITE = new THREE.Color(1, 1, 1);
const noRaycast = () => {};     // picked in pixels: a stray scene raycast must not find the handles
const num = (v) => (Math.round(v * 100) / 100).toFixed(2);
const wrap = (a) => a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;

// an arrow along +X: a shaft from `from`, `length` long, and a cone on its end
function arrowGeometry(from, length) {
  const shaft = new THREE.BoxGeometry(length, SHAFT, SHAFT).translate(from + length / 2, 0, 0);
  const head = new THREE.ConeGeometry(HEAD_R, HEAD, 12).rotateZ(-Math.PI / 2).translate(from + length + HEAD / 2, 0, 0);
  return mergeGeometries([shaft, head]);
}

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

// The factors a scale drag may use so that no scale and no radius of the items leaves LIMITS. An item that is already
// outside (an imported map) does not narrow the range to nothing: 1 is always allowed.
function factorRange(ctx, items) {
  let lo = 0, hi = Infinity;
  for (const item of items) {
    const kind = ctx.store.kindOf(item);
    let v = 0, range = null;
    if (kind === 'object') { v = item.s; range = LIMITS.scale; }
    else if (kind === 'spawn') { v = item.r; range = LIMITS.spawnR; }
    else if (kind === 'start') { v = item.r; range = LIMITS.startR; }
    else if (kind === 'region' && item.shape.type === 'circle') { v = item.shape.r; range = LIMITS.regionR; }
    if (!range || !(v > 0)) continue;
    lo = Math.max(lo, range[0] / v);
    hi = Math.min(hi, range[1] / v);
  }
  return [Math.min(Math.max(lo, 0.01), 1), Math.max(hi, 1)];
}

export function createGizmo(ctx) {
  const { store, ui } = ctx;

  let items = [];               // what the viewport handed over (the selection while Select is the tool)
  let list = [];                // ... of which may be edited: what a drag transforms and what the pivot is taken from
  let dirty = true;             // list, base and hasObjects are stale
  let base = null;              // { x, z } the pivot of `list`
  let hasObjects = false;
  let drag = null;              // the drag in progress
  let hot = -1;                 // the handle under the cursor
  // where the handles stand right now and how large a pixel is there (set by layout(), used by pick())
  // (y: the height of the ground under the pivot - the handles lie on the hill the selection stands on)
  const at = { x: 0, y: 0, z: 0 };
  let angle = 0, k = 1;
  const A = { x: 0, y: 0 }, B = { x: 0, y: 0 };

  const root = new THREE.Group();
  root.name = 'gizmo';
  root.visible = false;
  const axis = arrowGeometry(AXIS_FROM, AXIS_LENGTH);   // one arrow for X and for Z: the second mesh is turned
  const geometries = [
    axis,
    axis,
    new THREE.PlaneGeometry(PAD * 2, PAD * 2).rotateX(-Math.PI / 2),
    new THREE.RingGeometry(RING - RING_WIDTH / 2, RING + RING_WIDTH / 2, 72).rotateX(-Math.PI / 2),
    new THREE.BoxGeometry(CORNER_SIZE, CORNER_SIZE, CORNER_SIZE).translate(CORNER, 0, CORNER),
    arrowGeometry(LIFT_FROM, LIFT_LENGTH),
  ];
  const parts = geometries.map((geometry, i) => {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: COLORS[i], opacity: OPACITY[i], ...ON_TOP }));
    mesh.renderOrder = 1000 + (i === 2 ? 0 : i === 3 ? 1 : 2);   // the pad under the ring under the arrows
    mesh.raycast = noRaycast;
    root.add(mesh);
    return mesh;
  });
  parts[1].rotation.y = -Math.PI / 2;   // +X -> +Z
  parts[5].rotation.z = Math.PI / 2;    // +X -> +Y
  ctx.viewport.overlay.add(root);

  function paint() {
    const active = drag ? drag.index : hot;
    parts.forEach((mesh, i) => {
      mesh.material.color.setHex(COLORS[i]);
      if (i === active) mesh.material.color.lerp(WHITE, 0.55);
      mesh.material.opacity = i === active ? 1 : OPACITY[i];
    });
  }

  // With exactly one item and ui.axes === 'local' the arrows follow that item's own turn.
  const axesAngle = () => (list.length === 1 && ui.axes === 'local' && Number.isFinite(list[0].ry) ? list[0].ry : 0);

  // Puts the handles where they belong for the camera as it is now. -> false when there is nothing to show.
  function layout(camera = ctx.viewport.camera) {
    if (dirty) {
      dirty = false;
      list = editable(ctx, items);
      hasObjects = list.some((item) => store.kindOf(item) === 'object');
      base = list.length ? pivotOf(ctx, list) : null;
    }
    const where = drag ? drag.at : base;
    if (!where) {
      root.visible = false;
      return false;
    }
    at.x = where.x;
    at.z = where.z;
    at.y = ctx.view?.heightAt?.(at.x, at.z) ?? 0;
    angle = drag ? drag.angle : axesAngle();
    const depth = -V.set(at.x, at.y, at.z).applyMatrix4(camera.matrixWorldInverse).z;
    if (!(depth > camera.near)) {   // behind the camera
      root.visible = false;
      return false;
    }
    k = 2 * depth * Math.tan(camera.fov * DEG / 2) / (ctx.viewport.dom.clientHeight || 1);
    root.position.set(at.x, at.y, at.z);
    root.rotation.y = angle;
    root.scale.setScalar(k);
    for (let i = 0; i < parts.length; i++) parts[i].visible = drag ? i === drag.index || i === 2 : i !== 5 || hasObjects;
    root.visible = true;
    return true;
  }

  // a point of the gizmo (pixels in its own frame) -> client pixels; false when it lies behind the camera
  function toScreen(rect, lx, ly, lz, out) {
    const c = Math.cos(angle), s = Math.sin(angle);
    V.set(at.x + k * (lx * c + lz * s), at.y + k * ly, at.z + k * (-lx * s + lz * c)).project(ctx.viewport.camera);
    out.x = rect.left + (V.x + 1) / 2 * rect.width;
    out.y = rect.top + (1 - V.y) / 2 * rect.height;
    return V.z > -1 && V.z < 1;
  }

  // -> the index of the handle under the cursor (client pixels), or -1. The small handles win over the long ones:
  // pad, corner, the nearest arrow, the ring.
  function pick(sx, sy) {
    if (drag) return drag.index;
    if (!layout()) return -1;
    const rect = ctx.viewport.dom.getBoundingClientRect();
    if (!toScreen(rect, 0, 0, 0, A)) return -1;
    if (Math.hypot(sx - A.x, sy - A.y) <= PICK_PAD) return 2;
    if (toScreen(rect, CORNER, 0, CORNER, B) && Math.hypot(sx - B.x, sy - B.y) <= PICK_CORNER) return 4;
    let best = -1, near = PICK_AXIS;
    const arrow = (index, x0, y0, z0, x1, y1, z1) => {
      if (!toScreen(rect, x0, y0, z0, A) || !toScreen(rect, x1, y1, z1, B)) return;
      if (Math.hypot(B.x - A.x, B.y - A.y) < END_ON) return;
      const d = segDist(sx, sy, A.x, A.y, B.x, B.y);
      if (d <= near) { best = index; near = d; }
    };
    arrow(0, AXIS_FROM, 0, 0, AXIS_TO, 0, 0);
    arrow(1, 0, 0, AXIS_FROM, 0, 0, AXIS_TO);
    if (hasObjects) arrow(5, 0, LIFT_FROM, 0, 0, LIFT_TO, 0);
    if (best >= 0) return best;
    // the ring is an ellipse on screen (or worse, near the eye): it is walked
    let ok = toScreen(rect, RING, 0, 0, A);
    for (let i = 1; i <= RING_STEPS; i++) {
      const a = i / RING_STEPS * Math.PI * 2, next = toScreen(rect, RING * Math.cos(a), 0, RING * Math.sin(a), B);
      if (ok && next && segDist(sx, sy, A.x, A.y, B.x, B.y) <= PICK_RING) return 3;
      A.x = B.x; A.y = B.y;
      ok = next;
    }
    return -1;
  }

  function setItems(next) {
    items = Array.from(next ?? []);
    dirty = true;
    if (!items.length && hot !== -1) { hot = -1; paint(); }
    ctx.viewport.invalidate();
  }

  function setHover(index) {
    const next = Number.isInteger(index) && index >= 0 && index < parts.length ? index : -1;
    if (next === hot) return;
    hot = next;
    paint();
    ctx.viewport.invalidate();
  }

  // Starts the drag of handle `index` with the Hit of the press. -> false when there is nothing to drag.
  function begin(index, hit) {
    if (drag || store.grouping || !Number.isInteger(index) || index < 0 || index > 5 || !layout()) return false;
    const moving = index === 5 ? list.filter((item) => store.kindOf(item) === 'object') : list;
    if (!moving.length) return false;
    const rect = ctx.viewport.dom.getBoundingClientRect();
    toScreen(rect, 0, 0, 0, A);
    store.begin(`${VERBS[index]} ${describe(ctx, moving)}`);
    drag = {
      index, snap: ctx.cmd.snapshot(moving),
      pivot: { x: base.x, z: base.z },   // fixed for the whole drag: the items turn and grow about where it was at the press
      at: { x: base.x, z: base.z },      // where the handles are drawn: it follows a move
      angle, k,
      x0: hit.x, z0: hit.z, sx0: hit.sx, sy0: hit.sy, cx: A.x, cy: A.y,
      a0: Math.atan2(hit.x - base.x, hit.z - base.z),
      r0: Math.max(4, Math.hypot(hit.sx - A.x, hit.sy - A.y)),
      range: index === 4 ? factorRange(ctx, moving) : null,
    };
    // nothing moves yet: a press that never travels is a click, and a click changes nothing (the empty group is dropped)
    paint();
    ctx.viewport.invalidate();
    return true;
  }

  // The amount along one axis of the gizmo, on the snap grid when snapping is asked for. With world axes snapping is
  // absolute - the pivot lands on multiples of the step; along a turned axis only the distance can be stepped.
  function along(amount, coord, ev) {
    if (!snapping(ctx, ev)) return amount;
    const step = ui.snap.step > 0 ? ui.snap.step : 1;
    return coord === null ? Math.round(amount / step) * step : Math.round((coord + amount) / step) * step - coord;
  }

  function move(hit, ev) {
    const d = drag;
    if (!d) return;
    if (!store.grouping) {   // the group was closed under the drag (the tool changed): nothing is left to do
      drag = null;
      dirty = true;
      paint();
      return;
    }
    const world = d.angle === 0, c = Math.cos(d.angle), s = Math.sin(d.angle);
    let t = null, text = '';
    if (d.index <= 2) {
      if (hit.onGround === false) return;   // above the horizon there is no ground point to follow
      let dx = hit.x - d.x0, dz = hit.z - d.z0;
      // the pointer's way in the frame of the gizmo: a along its X arrow (cos, -sin), b along its Z arrow (sin, cos)
      const a = dx * c - dz * s, b = dx * s + dz * c;
      const axis = d.index === 0 ? 0 : d.index === 1 ? 1 : ev?.shiftKey ? (Math.abs(a) >= Math.abs(b) ? 0 : 1) : -1;   // Shift locks a free move
      if (axis === 0) {
        const m = along(a, world ? d.pivot.x : null, ev);
        dx = m * c; dz = -m * s;
      } else if (axis === 1) {
        const m = along(b, world ? d.pivot.z : null, ev);
        dx = m * s; dz = m * c;
      } else {
        const p = snapPoint(ctx, d.pivot.x + dx, d.pivot.z + dz, ev);
        dx = p.x - d.pivot.x; dz = p.z - d.pivot.z;
      }
      // one offset on the map's grid for all items: what was aligned before the drag is aligned after it
      dx = qPos(dx); dz = qPos(dz);
      d.at.x = d.pivot.x + dx; d.at.z = d.pivot.z + dz;
      t = { dx, dz };
      text = `dx ${num(dx)}  dz ${num(dz)}`;
    } else if (d.index === 3) {
      if (hit.onGround === false) return;
      let rot = wrap(Math.atan2(hit.x - d.pivot.x, hit.z - d.pivot.z) - d.a0);
      const step = ev?.shiftKey ? 15 * DEG : snapping(ctx, ev) ? (ui.snap.angle > 0 ? ui.snap.angle : 15 * DEG) : 0;
      if (step) rot = Math.round(rot / step) * step;
      t = { rot };
      text = `${(rot / DEG).toFixed(1)}°`;
    } else if (d.index === 4) {
      // measured on screen, from the pivot: it works at any tilt and never runs away at the horizon
      let f = Math.hypot(hit.sx - d.cx, hit.sy - d.cy) / d.r0;
      if (snapping(ctx, ev)) f = Math.round(f * 10) / 10;
      f = Math.round(Math.max(d.range[0], Math.min(d.range[1], f)) * 1000) / 1000;
      t = { scale: f };
      text = `× ${f.toFixed(2)}`;
    } else {
      // a pixel up the screen is the less of a lift the steeper the camera looks down
      let dy = (d.sy0 - hit.sy) * d.k / Math.max(0.25, Math.cos(ctx.viewport.pitch ?? 0));
      if (snapping(ctx, ev)) dy = along(dy, null, ev);
      dy = qPos(dy);
      t = { dy };
      text = `dy ${num(dy)}`;
    }
    store.exec(ctx.cmd.transform(d.snap, { ...t, pivot: d.pivot }));
    ctx.viewport.readout(text);
    ctx.viewport.invalidate();
  }

  function close(how) {
    if (!drag) return false;
    drag = null;
    dirty = true;
    paint();
    ctx.viewport.readout(null);
    if (store.grouping) store[how]();
    ctx.viewport.invalidate();
    return true;
  }
  const end = () => close('commit');
  const cancel = () => close('cancel');

  // Once per rendered frame: the pivot follows the items, the size follows the camera.
  function update(camera) {
    layout(camera ?? undefined);
  }

  const off = [
    store.on('change', () => { dirty = true; }),
    store.on('load', () => { drag = null; items = []; dirty = true; hot = -1; paint(); }),
    ui.on('layers', () => { dirty = true; }),   // a locked layer takes its items out of what may be edited
    ui.on('itemflags', () => { dirty = true; }),
    ui.on('hiddenModels', () => { dirty = true; }),
  ];

  function dispose() {
    for (const un of off) un?.();
    root.removeFromParent();
    for (const mesh of parts) { mesh.geometry.dispose(); mesh.material.dispose(); }
  }

  return {
    setItems, pick, begin, move, end, cancel, update,
    // ---- beyond §10.10
    setHover,                                     // the handle under the cursor is lit (the viewport calls it)
    get visible() { return root.visible; },       // the viewport draws its pivot mark only where there is no gizmo
    get dragging() { return drag ? drag.index : -1; },
    get items() { return items; },
    dispose,
  };
}
