// The Paste tool, and the clipboard actions that lead to it.
//
//   edit.copy   (Mod+C)  the selected objects, spawns, chests and NPCs become the clipboard (regions and the start stay out)
//   edit.cut    (Mod+X)  copy, then delete - one undo step
//   edit.paste  (Mod+V)  enters this tool: the clip hangs on the cursor as a translucent ghost
//   stamp.save           asks for a name and keeps the selection as a stamp
//   stamp.place (name)   enters this tool with that stamp instead of the clipboard
//
// In the tool:  click places the clip (one undo step, the new items become the selection) and returns to the tool that
// was active before; Shift+click places it and keeps the ghost; Q / E turn it about its pivot (Shift 90, Alt 1
// degree); Esc or a right-click cancels. The pivot snaps like everything else (ui.snap, Mod inverts).
//
// The tool has no layer of its own - a clip may hold four kinds. Instead every item whose layer is hidden or locked is
// left out (clipboard.instantiate), and so are the spawns, chests and NPCs of a clip while the Game preview hides the
// markers: the ghost shows only what will be pasted, the toast says how many were skipped and why, and with nothing
// left the tool is not entered at all.
import * as THREE from 'three';
import { h, row, angleField } from '../ui/dom.js';
import { hintFor, keyText } from '../keymap.js';
import { COLLECTION, LAYER_OF, qAngle } from '../../map/format.js';
import { snapPoint, editable } from './common.js';
import { CLIP_KINDS, clipSize, getStamp, instantiate, listStamps, makeClip, pasteOpen, readClip, saveStamp, stampName, writeClip } from '../clipboard.js';

const DEG = Math.PI / 180;
const PAD = 1.5;               // world units of air between the outermost origins and the outline of the ghost
const items = (n) => `${n.toLocaleString('en-US')} item${n === 1 ? '' : 's'}`;
const all = (made) => [...made.objects, ...made.spawns, ...made.chests, ...made.npcs];

export default function create(ctx) {
  const { store, ui, actions, cmd } = ctx;

  let pending = null;     // { clip, label }: what the next activate() pastes (set by the actions)
  let job = null;         // the paste in progress, see arm()
  let pressed = false;    // a press that started in this tool: only its release places
  let dirty = false;      // the ghost has to be moved before the next frame
  let outline = null;     // THREE.LineSegments in viewport.overlay: the extent of the clip and its pivot
  let subs = [];          // subscriptions of the active tool
  let field = null;       // the rotation field of the options strip
  let summary = null;     // the text of the options strip

  // ---------------------------------------------------------------- what can be copied

  const copyable = () => store.selected().filter((item) => CLIP_KINDS.includes(store.kindOf(item)));
  const layerOf = (kind) => ui.layers?.[LAYER_OF[kind]] ?? null;
  // how many items of a clip a paste would bring in right now
  const pasteable = (clip) => CLIP_KINDS.reduce((n, kind) => n + (pasteOpen(ctx, kind) ? clip[COLLECTION[kind]].length : 0), 0);
  // Why items of a clip are left out - or nothing of it can be pasted: 'Layer locked', 'Layer hidden', or the Game
  // preview, which hides the markers.
  const closedReason = (clip) => {
    const closed = CLIP_KINDS.filter((kind) => clip[COLLECTION[kind]].length && !pasteOpen(ctx, kind));
    if (closed.some((kind) => layerOf(kind)?.locked) || !closed.length) return 'Layer locked';
    if (closed.some((kind) => layerOf(kind)?.visible === false)) return 'Layer hidden';
    return 'Markers are hidden in the Game preview';
  };

  // Makes `list` the clipboard. -> whether it reached the browser storage; null when it is no clip - an item of a
  // file under repair may stand where no map reaches (clipboard.js refuses such a clip) - after saying so.
  function keep(list) {
    try {
      return writeClip(makeClip(ctx, list));
    } catch {
      ui.toast('Not copied: an item of the selection stands far outside any map. Give it a position on the island first (the inspector takes X and Z)', 'warn');
      return null;
    }
  }

  function copy() {
    if (!store.map) return false;
    const list = copyable();
    if (!list.length) {
      ui.toast(store.selection.size ? 'Regions and the start point cannot be copied' : 'Nothing is selected', 'warn');
      return false;
    }
    const stored = keep(list);
    if (stored === null) return false;
    if (stored) ui.toast(`Copied ${items(list.length)}`);
    else ui.toast(`Copied ${items(list.length)} - for this tab only: the browser storage is full or disabled`, 'warn');
    return true;
  }

  function cut() {
    if (!store.map) return false;
    if (store.grouping) { ui.toast('Finish the current edit first', 'warn'); return false; }
    // only what may be deleted is cut: a selection can outlive the lock of its layer
    const list = editable(ctx, copyable());
    if (!list.length) {
      ui.toast(store.selection.size ? 'Nothing here can be cut: regions, the start point and locked layers stay' : 'Nothing is selected', 'warn');
      return false;
    }
    if (keep(list) === null) return false;       // nothing is removed that could not be kept
    store.exec(cmd.batch(`Cut ${items(list.length)}`, [cmd.remove(list)]));
    ui.toast(`Cut ${items(list.length)}`);
    return true;
  }

  // source: { clip, label } to paste a stamp; without it the clipboard is pasted.
  function paste(source = null) {
    if (!store.map) return false;
    if (store.grouping) { ui.toast('Finish the current edit first', 'warn'); return false; }
    const clip = source?.clip ?? readClip();
    if (!clip || !clipSize(clip)) {
      const key = hintFor('edit.copy');
      ui.toast(`Nothing to paste: copy something first${key ? ` (${key})` : ''}`, 'warn');
      return false;
    }
    if (!pasteable(clip)) {       // the tool is not entered
      const why = closedReason(clip);
      ui.toast(why.startsWith('Markers') ? `${why}: switch the preview back to paste them` : why, 'warn');
      return false;
    }
    pending = { clip, label: typeof source?.label === 'string' ? source.label : null };
    ui.set('tool', 'paste');   // setting the active tool again re-arms it: a second Mod+V takes the newest clipboard
    return true;
  }

  async function saveAsStamp() {
    if (!store.map) return;
    const list = copyable();
    if (!list.length) {
      ui.toast('Select the objects, spawns, chests or NPCs of the stamp first', 'warn');
      return;
    }
    const clip = makeClip(ctx, list), names = new Set(listStamps().map((s) => s.name));
    let n = names.size + 1;
    while (names.has(`Stamp ${n}`)) n++;
    const typed = await ui.prompt(`Save ${items(list.length)} as a stamp. Its name:`, `Stamp ${n}`);
    if (typed === null) return;
    const name = stampName(typed);
    if (name === null) { ui.toast('A stamp name is 1 to 48 characters', 'warn'); return; }
    if (names.has(name) && !(await ui.confirm(`Replace the stamp "${name}"?`, { ok: 'Replace' }))) return;
    try {
      saveStamp(name, clip);
      ui.toast(`Saved the stamp "${name}" (${items(list.length)})`);
    } catch (err) {
      ui.toast(String(err?.message ?? err), 'error');
    }
  }

  function placeStamp(name) {
    const stamp = getStamp(name);
    if (!stamp) { ui.toast(`There is no stamp called "${name}"`, 'warn'); return false; }
    return paste({ clip: stamp.clip, label: stamp.name });
  }

  const some = () => store.selection.size > 0;
  actions.register('edit.copy', copy, { enabled: some });
  actions.register('edit.cut', cut, { enabled: some });
  actions.register('edit.paste', paste);
  actions.register('stamp.save', () => { saveAsStamp().catch((err) => console.error('[editor] stamp.save failed', err)); });
  actions.register('stamp.place', placeStamp);

  // ---------------------------------------------------------------- the ghost

  // Reads the clip once: the items that would be pasted right now, as ghost literals with their offsets from the
  // pivot. A move of the ghost then only rewrites numbers. -> false when every layer of the clip is closed
  function arm(source, keep = null) {
    const made = instantiate(ctx, source.clip, { x: 0, z: 0 });
    const list = all(made);
    if (!list.length) return false;
    let r = 0;
    const entries = list.map((item) => {
      r = Math.max(r, Math.hypot(item.x, item.z) + (typeof item.r === 'number' ? item.r : 0));
      return { item, dx: item.x, dz: item.z, ry: item.ry ?? 0, turns: 'ry' in item };
    });
    job = {
      clip: source.clip, label: source.label,
      ghost: { objects: made.objects, spawns: made.spawns, chests: made.chests, npcs: made.npcs },
      entries, total: list.length, skipped: made.skipped, reach: r + PAD,
      rot: keep?.rot ?? 0, x: keep?.x ?? 0, z: keep?.z ?? 0,
    };
    return true;
  }

  function ensureOutline() {
    if (outline) return outline;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((64 + 2) * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    outline = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: 0x8fc2ff, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false, toneMapped: false }));
    outline.frustumCulled = false;   // rewritten on every move
    outline.renderOrder = 998;
    ctx.viewport.overlay.add(outline);
    return outline;
  }

  // The ghost at the pivot (job.x, job.z), turned by job.rot: the objects through the view, the markers through the
  // markers, and a circle around all of it with a cross at the pivot (a clip of 2,000 objects shows 500 of them).
  function draw() {
    dirty = false;
    if (!job) return;
    const { x, z, rot } = job, cos = Math.cos(rot), sin = Math.sin(rot);
    for (const e of job.entries) {
      e.item.x = x + e.dx * cos + e.dz * sin;
      e.item.z = z - e.dx * sin + e.dz * cos;
      if (e.turns) e.item.ry = e.ry + rot;
    }
    ctx.view.setGhost(job.ghost.objects.length ? job.ghost.objects : null);
    ctx.markers.setGhost(job.ghost);
    const a = ensureOutline().geometry.attributes.position, p = a.array, R = job.reach, y = 0.06;
    let o = 0;
    const h = ctx.viewport.groundY;   // both ends of a segment stand on the ground: the outline lies on the hill it is over
    const seg = (x0, z0, x1, z1) => { p[o++] = x0; p[o++] = h(x0, z0) + y; p[o++] = z0; p[o++] = x1; p[o++] = h(x1, z1) + y; p[o++] = z1; };
    for (let i = 0; i < 64; i++) {
      const a0 = i / 64 * Math.PI * 2, a1 = (i + 1) / 64 * Math.PI * 2;
      seg(x + Math.cos(a0) * R, z + Math.sin(a0) * R, x + Math.cos(a1) * R, z + Math.sin(a1) * R);
    }
    const k = Math.min(1, R * 0.25);
    seg(x - cos * k, z + sin * k, x + cos * k * 2, z - sin * k * 2);   // the long arm shows which way the clip is turned
    seg(x - sin * k, z - cos * k, x + sin * k, z + cos * k);
    a.needsUpdate = true;
    ctx.viewport.invalidate();
  }

  function clear() {
    ctx.view.setGhost(null);
    ctx.markers.setGhost(null);
    if (outline) {
      outline.removeFromParent();
      outline.geometry.dispose();
      outline.material.dispose();
      outline = null;
    }
    ctx.viewport.invalidate();
  }

  // Where the ghost hangs while the pointer is not over the viewport: at the camera target.
  function toTarget() {
    if (!job) return;
    const p = snapPoint(ctx, ctx.viewport.target.x, ctx.viewport.target.z, null);
    job.x = p.x;
    job.z = p.z;
    dirty = true;
    ctx.viewport.invalidate();
  }

  function describe() {
    if (!job) return '';
    const what = job.label ? `Stamp "${job.label}"` : 'Paste';
    return `${what}: ${items(job.total)}${job.skipped ? `, ${job.skipped} skipped (${closedReason(job.clip).toLowerCase()})` : ''}`;
  }

  function say() {
    if (!job) return;
    const angle = job.rot ? `, turned ${Math.round(job.rot / DEG * 100) / 100}°` : '';
    ui.setStatus(`${describe()}${angle} - ${keyText('click to place, Shift+click to place again, Q / E to turn, Esc to cancel')}`);
    if (summary) summary.textContent = describe();
    field?.set(job.rot);
  }

  // Back to the tool that was active before - when it may be entered (its layer may have been locked meanwhile).
  function leave() {
    const prev = ui.prevTool;
    const ok = prev && prev !== 'paste' && ctx.tools?.[prev] && (!actions.has(`tool.${prev}`) || actions.enabled(`tool.${prev}`));
    ui.set('tool', ok ? prev : 'select');
  }

  function place(x, z, keep) {
    if (store.grouping) { ui.toast('Finish the current edit first', 'warn'); return; }
    const made = instantiate(ctx, job.clip, { x, z, rot: job.rot }), list = all(made);
    if (!list.length) {
      ui.toast(closedReason(job.clip), 'warn');
      leave();
      return;
    }
    const commands = CLIP_KINDS.filter((kind) => made[COLLECTION[kind]].length).map((kind) => cmd.add(kind, made[COLLECTION[kind]]));
    store.exec(cmd.batch(`Paste ${items(list.length)}`, commands));
    store.select(list);
    ui.toast(made.skipped
      ? `Pasted ${items(list.length)}, ${made.skipped} skipped (${closedReason(job.clip).toLowerCase()})`
      : `Pasted ${items(list.length)}`);
    if (!keep) leave();
  }

  // What may be pasted has changed under the ghost: it is read again - or, with nothing left, the tool is left.
  function rearm() {
    if (!job) return;
    const keep = { rot: job.rot, x: job.x, z: job.z }, source = { clip: job.clip, label: job.label };
    if (arm(source, keep)) { dirty = true; say(); ctx.viewport.invalidate(); return; }
    ui.toast(closedReason(source.clip), 'warn');
    leave();
  }

  function turn(by) {
    if (!job) return;
    job.rot = qAngle(job.rot + by);
    dirty = true;
    say();   // the status line and the field of the options strip show the angle
    ctx.viewport.invalidate();
  }

  return {
    id: 'paste', label: 'Paste', icon: '⎘', layer: null, picks: [], hidden: true,
    get context() { return 'ghost'; },

    activate() {
      const source = pending ?? { clip: readClip(), label: null };
      pending = null;
      pressed = false;
      if (!source.clip || !arm(source)) {
        // Entered without anything to paste (a script set the tool): leave again - after this switch has been told to
        // everybody, so no listener hears the two switches in the wrong order.
        job = null;
        if (source.clip) ui.toast(closedReason(source.clip), 'warn');
        Promise.resolve().then(() => { if (ui.tool === 'paste' && !job) leave(); });
        return;
      }
      const c = ui.cursor;
      if (c && c.onGround !== false) {
        const p = snapPoint(ctx, c.x, c.z, null);
        job.x = p.x;
        job.z = p.z;
      } else toTarget();
      subs = [
        // another map (Revert, Import): the view has dropped its ghost with the old map - the clip still hangs on the cursor
        store.on('load', () => { dirty = true; ctx.viewport.invalidate(); }),
        // the pointer left the viewport: the ghost waits at the camera target
        ui.on('cursor', (hit) => { if (hit === null && job && !pressed) toTarget(); }),
        // a layer was locked, hidden or opened under the ghost, or the preview changed: it shows what would be pasted NOW
        ui.on('layers', rearm),
        ui.on('preview', rearm),
      ];
      draw();
      say();
    },

    deactivate() {
      for (const off of subs) off?.();
      subs = [];
      const text = describe();
      job = null;
      pressed = false;
      field = summary = null;
      clear();
      if (text && ui.status.startsWith(text)) ui.setStatus('');
    },

    pointerDown() {
      pressed = !!job;
    },

    pointerMove(ev, hit) {
      if (!job || hit.onGround === false) return;
      const p = snapPoint(ctx, hit.x, hit.z, ev);
      if (p.x === job.x && p.z === job.z) return;
      job.x = p.x;
      job.z = p.z;
      dirty = true;
      ctx.viewport.invalidate();   // update() moves the ghost once per frame, however many moves a frame brings
    },

    pointerUp(ev, hit) {
      if (!pressed || !job) return;
      pressed = false;
      // a press the viewport ended without a release (the pointer was cancelled, the window lost the focus) places nothing
      if (ev?.type !== 'pointerup') return;
      if (hit.onGround === false) { ui.setStatus('Click on the ground to place the clip'); return; }
      const p = snapPoint(ctx, hit.x, hit.z, ev);
      job.x = p.x;
      job.z = p.z;
      place(p.x, p.z, !!ev.shiftKey);
      if (job) draw();   // Shift: the ghost stays, right where the copy was dropped
    },

    key(action, ev) {
      if (!job) return false;
      if (action === 'rotate.ccw' || action === 'rotate.cw') {
        const step = (ev?.shiftKey ? 90 : ev?.altKey ? 1 : 15) * DEG;
        turn(action === 'rotate.ccw' ? step : -step);
        return true;
      }
      if (action === 'cancel') {
        leave();
        return true;
      }
      return false;   // a clip is not scaled or re-rolled
    },

    update() {
      if (dirty) draw();
    },

    options(el) {
      if (!job) return;
      summary = h('span', { class: 'ui-hint' }, describe());
      field = angleField({
        value: job.rot, step: 15 * DEG,
        onInput: (rad) => { if (job) { job.rot = qAngle(rad); dirty = true; ctx.viewport.invalidate(); } },
        onCommit: () => say(),
      });
      el.append(
        summary,
        row('Rotation', field),
        h('span', { class: 'ui-hint' }, keyText('Click: place · Shift+click: place again · Q / E: turn · Esc: cancel')),
      );
    },
  };
}
