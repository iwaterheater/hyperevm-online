import { h, button, selectField, rafThrottle } from '../ui/dom.js';
import { hintFor } from '../keymap.js';
import { SNAP_STEPS } from '../state.js';
import { GROUND_TYPES, heightAt, regionIndex, regionLabel, spawnCount } from '../../map/format.js';

// The status bar (#status): what is under the cursor, what is selected, what the map holds, how the last frame did -
// and the switches a mapper reaches for all the time: the snap toggle with its step, the issue count, the hotkey sheet.
// It only shows state and asks for changes through `ui` and actions; it never writes the map.
//
// Left to right: save state and map revision · issues · cursor x, z and the height of the ground there · ground type ·
// region · selection · totals ·
// the status text (ui.setStatus) · snap · fps, triangles, draw calls · help.

const PERF_MS = 250;    // the frame numbers change on every frame: four readings a second are plenty
const NOTE_MS = 6000;   // a note (ui.setNote) that nothing else has ended goes by itself after this
const NOUN = {
  object: ['object', 'objects'], spawn: ['spawn', 'spawns'], chest: ['chest', 'chests'],
  npc: ['NPC', 'NPCs'], region: ['region', 'regions'], start: ['start point', 'start points'],
};
const KIND_ORDER = ['object', 'spawn', 'chest', 'npc', 'region', 'start'];

const int = (n) => Math.round(n).toLocaleString('en-US');
const plural = (n, kind) => `${int(n)} ${NOUN[kind][n === 1 ? 0 : 1]}`;
const coord = (v) => (Math.round(v * 10) / 10).toFixed(1);
// 1,234,567 -> '1.23M', 45,300 -> '45.3k': the triangle count must not make the bar jump about
const short = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${(n / 1e3).toFixed(1)}k` : int(n));

export default function mount(el, ctx) {
  const { store, ui, actions } = ctx;
  const text = (cls, title) => h('span', { class: `cell ${cls}`, title });
  // a text node is only touched when its text changes: most cells are written on every pointer move
  const put = (node, value) => { if (node.textContent !== value) node.textContent = value; };

  // ---- save state, revision, issues
  const dot = h('span', { class: 'ui-dot', title: 'Unsaved changes' });
  const saved = h('span', { class: 'state' });
  const rev = h('span', { class: 'rev ui-mono' });
  const save = h('span', { class: 'cell save' }, dot, saved, rev);
  const issues = button('', () => actions.run('validation.open'), { title: 'Open the Issues panel' });
  issues.classList.add('issues', 'flat');

  // ---- under the cursor
  const cursor = text('cursor ui-mono', 'Cursor position on the ground (x east, z south) and the height of the ground there');
  const ground = text('ground', 'Ground type under the cursor');
  const region = text('region', 'Region under the cursor (the one that wins there)');

  // ---- the map and the selection
  const selection = text('selection', 'Selection');
  const totals = text('totals', 'Objects and monsters on the map');
  const status = text('text', null);
  status.setAttribute('role', 'status');

  // ---- snap
  const snapHint = hintFor('snap.toggle');
  const snap = button('Snap', () => actions.run('snap.toggle'), { title: `Snap positions to the grid${snapHint ? ` (${snapHint})` : ''}; hold the command key while dragging to invert` });
  snap.classList.add('flat');
  const step = selectField({
    value: ui.snap.step, options: SNAP_STEPS.map((value) => ({ value, label: String(value) })),
    onCommit: (value) => ui.set('snap', { ...ui.snap, step: value }),
  });
  step.el.title = 'Snap step in world units (2 is one ground cell)';
  step.el.setAttribute('aria-label', 'Snap step');

  // ---- the last frame
  // in a window that is not wide the bar keeps the frame rate and gives the room of the other two numbers to the
  // status text (status.css); the tooltip of the cell always has all three
  const fps = h('span', { class: 'fps' }), load = h('span', { class: 'load' });
  const perf = h('span', { class: 'cell perf ui-mono' }, fps, load);
  const helpHint = hintFor('help.toggle');
  const help = button('?', () => actions.run('help.toggle'), { title: `Keyboard shortcuts${helpHint ? ` (${helpHint})` : ''}` });
  help.classList.add('flat', 'icon', 'help');

  el.replaceChildren(save, issues, cursor, ground, region, selection, totals, status,
    h('span', { class: 'cell snap' }, snap, step), perf, help);

  // ---------------------------------------------------------------- what each cell shows

  function syncSave() {
    const dirty = !!store.dirty;
    dot.classList.toggle('on', dirty);
    put(saved, ui.readOnly ? (dirty ? 'Read-only · unsaved' : 'Read-only') : !store.map ? 'Loading' : dirty ? 'Unsaved' : 'Saved');
    save.classList.toggle('dirty', dirty);
    save.classList.toggle('readonly', !!ui.readOnly);
    save.title = ui.readOnly ? 'Read-only: server is not in editor mode. Export still works.'
      : dirty ? 'The map has changes the server does not have yet' : 'The server has this map';
    syncRev();
  }
  function syncRev() {
    const id = typeof ctx.net?.baseRev === 'string' ? ctx.net.baseRev : '';
    put(rev, id ? `rev ${id.slice(0, 8)}` : 'rev —');
    rev.title = id ? `Map revision ${id}: what the server had when this map was loaded or last saved` : 'The revision of the server\'s map is not known';
  }

  function syncIssues() {
    const errors = ui.issues?.errors ?? 0, warnings = ui.issues?.warnings ?? 0;
    const parts = [];
    if (errors) parts.push(`${int(errors)} error${errors === 1 ? '' : 's'}`);
    if (warnings) parts.push(`${int(warnings)} warning${warnings === 1 ? '' : 's'}`);
    put(issues, parts.length ? parts.join(' · ') : 'No issues');
    issues.classList.toggle('errors', errors > 0);
    issues.classList.toggle('warnings', !errors && warnings > 0);
    issues.title = errors ? 'The map has errors and cannot be saved: open the Issues panel' : 'Open the Issues panel';
  }

  // The lookup of the region under the cursor keeps a bounding box per region; it is rebuilt when the regions change.
  let regions = null;
  const regionAt = (x, z) => (regions ??= regionIndex(store.map)).regionAt(x, z);

  // Reads nothing but the ground point of the Hit: its `item` would cost a pick on every pointer move.
  function syncCursor() {
    const hit = ui.cursor, map = store.map;
    if (!hit || !map || hit.onGround === false || !Number.isFinite(hit.x) || !Number.isFinite(hit.z)) {
      put(cursor, 'x —  z —  h —');
      put(ground, '');
      put(region, '');
      return;
    }
    // the height is read from the map, not from the Hit: the ground may have moved under a cursor that rests (a sculpt stroke)
    put(cursor, `x ${coord(hit.x)}  z ${coord(hit.z)}  h ${heightAt(map, hit.x, hit.z).toFixed(1)}`);
    const onGrid = hit.ix >= 0 && hit.iz >= 0;
    const type = onGrid ? GROUND_TYPES[map.ground.cells[hit.iz * map.ground.size + hit.ix]] : null;
    put(ground, onGrid ? (type?.name ?? 'Unknown ground') + (type?.block ? ' (blocks)' : '') : 'Off the ground grid');
    ground.classList.toggle('block', !!type?.block);
    put(region, regionLabel(regionAt(hit.x, hit.z)));
  }
  const cursorSoon = rafThrottle(syncCursor);

  function syncSelection() {
    const counts = {};
    let n = 0, only = null;
    for (const item of store.selection) {
      const kind = store.kindOf(item);
      if (!kind) continue;
      counts[kind] = (counts[kind] ?? 0) + 1;
      only = item;
      n++;
    }
    if (!n) { put(selection, 'Nothing selected'); selection.title = 'Selection'; return; }
    const kinds = KIND_ORDER.filter((kind) => counts[kind]);
    let label = kinds.map((kind) => plural(counts[kind], kind)).join(' + ');
    if (n === 1 && kinds[0] !== 'start') {   // one item: say which
      let name = '';
      try { name = ctx.markers?.labelOf?.(only) ?? ''; } catch { /* the label is a nicety */ }
      if (typeof name === 'string' && name) label += `: ${name}`;
    }
    put(selection, label);
    selection.title = `Selection: ${label}`;      // the cell gives way first in a narrow bar: its text is here in full
  }
  const selectionSoon = rafThrottle(syncSelection);

  function syncTotals() {
    const map = store.map;
    put(totals, map ? `${plural(map.objects.length, 'object')} · ${int(spawnCount(map))} monster${spawnCount(map) === 1 ? '' : 's'}` : '');
  }
  const totalsSoon = rafThrottle(syncTotals);

  function syncSnap() {
    const on = !!ui.snap.on;
    snap.classList.toggle('active', on);
    snap.setAttribute('aria-pressed', String(on));
    step.set(ui.snap.step);
  }

  function syncPerf() {
    const vp = ctx.viewport, info = vp?.info, rate = vp?.fps;
    const frames = `${rate > 0 ? int(rate) : '—'} fps`, rest = ` · ${short(info?.triangles ?? 0)} tris · ${int(info?.calls ?? 0)} calls`;
    put(fps, frames);
    put(load, rest);
    const title = `Frames per second · triangles · draw calls of the last frame\n${frames}${rest}`;
    if (perf.title !== title) perf.title = title;
  }

  // The status text, and the note that covers it for a moment (ui.setNote). The line is cut when it is longer than
  // its cell - instructions of a tool often are - so the cell's tooltip always has the whole of it.
  // With neither, the bar shows what the active tool is for (tool.intro): there is always a line that says what a
  // click and a drag do, whoever cleared the status last.
  let noteTimer = 0;
  const intro = () => { try { return ctx.tools?.[ui.tool]?.intro ?? ''; } catch { return ''; } };   // a getter of somebody else's module
  function syncText() {
    const value = String(ui.note || ui.status || intro() || '');
    put(status, value);
    if (status.title !== value) status.title = value;
    status.classList.toggle('note', !!ui.note);
  }
  // A note ends with the next thing that happens: it described the one before.
  function dropNote() {
    clearTimeout(noteTimer);
    noteTimer = 0;
    if (ui.note) ui.set('note', '');
  }

  // ---------------------------------------------------------------- wiring

  store.on('load', () => { regions = null; dropNote(); syncSave(); syncSelection(); syncTotals(); syncCursor(); });
  store.on('history', syncSave);
  store.on('selection', selectionSoon);
  store.on('change', (change) => {
    if (change.added.regions.length || change.removed.regions.length || change.updated.regions.length || change.order.includes('regions')
      || change.props.includes('fallback')) {
      regions = null;
      cursorSoon();
    }
    if (change.ground || change.props.includes('ground')) cursorSoon();
    if (change.added.objects.length || change.removed.objects.length || change.added.spawns.length || change.removed.spawns.length
      || change.updated.spawns.length) totalsSoon();
    if (store.selection.size === 1) selectionSoon();   // the label of the one selected item may have changed
  });
  ui.on('cursor', cursorSoon);
  ui.on('status', syncText);
  ui.on('note', (value) => {
    clearTimeout(noteTimer);
    noteTimer = value ? setTimeout(dropNote, NOTE_MS) : 0;
    syncText();
  });
  // every edit, undo and redo emits 'history'; the note was written after the events of what it describes
  store.on('history', dropNote);
  store.on('selection', dropNote);
  ui.on('tool', () => { dropNote(); syncText(); });
  // being read (the pointer rests on it for its tooltip): it waits
  status.addEventListener('pointerenter', () => clearTimeout(noteTimer));
  status.addEventListener('pointerleave', () => { if (ui.note) noteTimer = setTimeout(dropNote, NOTE_MS / 3); });
  ui.on('snap', syncSnap);
  ui.on('issues', syncIssues);
  ui.on('readOnly', syncSave);

  syncSave();
  syncIssues();
  syncCursor();
  syncSelection();
  syncTotals();
  syncSnap();
  syncPerf();
  syncText();

  let wait = 0;
  return {
    // every rendered frame: the frame numbers, a few times a second
    update(dt) {
      // what was waiting for an animation frame is shown with this one (a throttled window hands out none of its own)
      cursorSoon.flush();
      selectionSoon.flush();
      totalsSoon.flush();
      wait -= (dt > 0 ? dt : 0.016) * 1000;
      if (wait > 0) return;
      wait = PERF_MS;
      syncPerf();
      syncRev();   // a save that was overtaken by an edit moves the revision without a store event
    },
  };
}
