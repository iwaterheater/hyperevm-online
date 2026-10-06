window.name = 'hypercat-editor';   // FIRST, before anything can fail: the game's "Edit here" opens /editor.html#at=x,z
                                   // into the window of this name, so it comes back to this tab and its undo history

import * as fmt from '../map/format.js';
import { listModels } from '../map/catalog.js';
import { createUi } from './state.js';
import { createStore } from './store.js';
import * as cmd from './commands.js';
import { createActions, reportOnce } from './actions.js';
import { createNet } from './net.js';
import { createViewport } from './viewport.js';
import { Markers } from './markers.js';
import { createGizmo } from './gizmo.js';
import { install as installKeymap } from './keymap.js';
import { h, frame, createToasts, createModal } from './ui/dom.js';
import { TOOLS } from './tools/index.js';
import { PANELS } from './panels/index.js';
import { OVERLAYS } from './overlays/index.js';

// Boot and wiring of the map editor. This file builds `ctx` - the one object every tool, panel and overlay gets - and
// connects the pieces; it holds no feature of its own beyond the few actions that belong to nobody else (undo, redo,
// the tool keys, the snap toggle).
//
// Six people fill in the tools and panels at the same time, in one live worktree. So nothing here trusts a registry
// module: each one is loaded with a guarded dynamic import, replaced by a stub when it does not load, and every call
// into it is wrapped. One broken file costs its own button or panel, never the page.

const ISSUES_SHOWN = 10;
const $ = (selector) => document.querySelector(selector);

// ---------------------------------------------------------------- fault isolation

// A call into a registry module. A throw is logged once per module and method - through the one reporter the viewport
// and the keymap use for their calls into the same modules - and `fallback` is the answer.
function guard(name, method, fn, fallback = undefined) {
  try {
    return fn();
  } catch (err) {
    reportOnce(name, method, err);
    return fallback;
  }
}
const THREW = Symbol('threw');   // the fallback of a create() that threw: guard has reported it, nothing is left to say

// -> the default export of a registry module, or null when it cannot be loaded (a 404, a syntax error, a broken import
// of its own, no default function). `row.path` is relative to src/editor/, which is where this file lives.
function load(row) {
  return import(row.path).then((module) => {
    if (typeof module.default !== 'function') throw new TypeError('the module has no default export function');
    return module.default;
  }).catch((err) => {
    console.error(`[editor] ${row.path} failed to load`, err);
    return null;
  });
}

// What stands in for a module that did not load or whose create() / mount() threw: the stubs of step 3, built from
// the registry row.
function toolStub(row) {
  return {
    id: row.id, label: row.label, icon: '?', layer: row.layer ?? null, picks: [], hidden: !!row.hidden,
    get context() { return 'none'; },
    activate() {}, deactivate() {}, pointerDown() {}, pointerMove() {}, pointerUp() {}, key() { return false; },
  };
}
function overlayStub(row) {
  return { id: row.id, canvas: null, version: 0, setVisible() {} };
}
const panelName = (row) => row.name ?? row.title ?? row.el;
function panelStub(el, row) {
  el.replaceChildren();
  el.textContent = `${panelName(row)} (failed to load)`;
}

// ---------------------------------------------------------------- the page

// Every section of the right column gets a collapsible frame: <details class="ui-frame"><summary>Title</summary>
// <section id></section></details>. Which ones are closed is remembered (ui.collapsed, in hypercat-editor-ui).
// A panel may open or hide its own frame (el.parentElement.open / .hidden); what it opens is remembered like a click.
function wrapFrames(ui) {
  for (const row of PANELS) {
    const el = row.title ? $(row.el) : null;
    if (!el || el.parentElement?.id !== 'right') continue;
    const id = el.id;
    const box = frame(row.title, null, {
      open: ui.collapsed?.[id] !== true,
      onToggle: (open) => {
        if ((ui.collapsed?.[id] === true) === !open) return;   // the event of the state it was created in
        const next = { ...ui.collapsed };
        if (open) delete next[id];
        else next[id] = true;
        ui.set('collapsed', next);
      },
    });
    box.dataset.panel = id;     // base.css keeps the Minimap frame in view by it
    el.replaceWith(box);
    box.append(el);
  }
}

// The one thing shown when the editor cannot start: what went wrong, and nothing else of the editor.
function bootFailure(err) {
  const modal = $('#modal');
  if (!modal) return;
  const issues = Array.isArray(err?.issues) ? err.issues : null;
  let title, lines;
  if (issues) {
    title = 'The map on the server cannot be loaded';
    lines = issues.slice(0, ISSUES_SHOWN).map((issue) => `${issue?.path ? `${issue.path}: ` : ''}${issue?.message ?? 'invalid'}`);
    if (issues.length > ISSUES_SHOWN) lines.push(`... and ${issues.length - ISSUES_SHOWN} more`);
  } else {
    title = 'The editor could not start';
    lines = [String(err?.message ?? err)];
  }
  const reload = h('button', { type: 'button', class: 'ui-button primary', onclick: () => location.reload() }, 'Reload');
  modal.replaceChildren(h('div', { class: 'ui-dialog', role: 'alertdialog', 'aria-modal': 'true' },
    h('h2', { class: 'ui-dialog-title' }, title),
    h('div', { class: 'ui-dialog-text ui-mono' }, lines.join('\n')),   // text nodes: issue messages quote the file
    h('div', { class: 'ui-dialog-buttons' }, reload)));
  modal.hidden = false;
  reload.focus();
}

// ---------------------------------------------------------------- actions that belong to nobody else

function registerCoreActions(ctx) {
  const { actions, store, ui } = ctx;
  const say = (verb, label) => ui.toast(label ? `${verb}: ${label}` : verb);

  // Disabled while a drag, a grab or a typed edit is open: its group must be closed first (store.canUndo says so).
  actions.register('edit.undo', () => {
    const label = store.undo();
    if (label !== null) say('Undo', label);
  }, { enabled: () => store.canUndo });
  actions.register('edit.redo', () => {
    const label = store.redo();
    if (label !== null) say('Redo', label);
  }, { enabled: () => store.canRedo });

  actions.register('snap.toggle', () => {
    const on = !ui.snap.on;
    ui.set('snap', { ...ui.snap, on });
    ui.setNote(on ? `Snap on, step ${ui.snap.step}` : 'Snap off');
  });

  // tool.<id> is ui.set('tool', id). The toolbar disables a tool whose layer is hidden or locked, and its key must not
  // get around that: the action is DISABLED on the same rule, so actions.enabled() and the false of actions.run() tell
  // every caller the truth (the keymap adds the toast that says why).
  for (const row of TOOLS) {
    if (row.hidden) continue;
    actions.register(`tool.${row.id}`, () => ui.set('tool', row.id), {
      enabled: () => {
        const layer = ctx.tools[row.id]?.layer ?? row.layer ?? null, state = layer ? ui.layers[layer] : null;
        return !state || (state.visible && !state.locked);
      },
    });
  }
}

// ---------------------------------------------------------------- the options strip

// The strip is one line of fixed height (a strip that grew would move the viewport at every tool switch), so in a
// narrow window a long one - the Spawn tool's, a Line of the Place tool - is wider than the page. Then it scrolls
// sideways: the wheel over it scrolls it, and the edge that hides something fades out (.more-left / .more-right in
// base.css). The hint a strip ends with may be cut short by the same lack of room: its tooltip has the whole text.
function fitStrip(strip) {
  const mark = () => {
    const left = strip.scrollLeft, room = strip.scrollWidth - strip.clientWidth;
    strip.classList.toggle('more-left', room > 1 && left > 1);
    strip.classList.toggle('more-right', room > 1 && left < room - 1);
    const hint = strip.lastElementChild;
    if (hint?.classList.contains('ui-hint') && (!hint.title || hint.dataset.cut === '1')) {
      if (hint.scrollWidth > hint.clientWidth) { hint.title = hint.textContent; hint.dataset.cut = '1'; }
      else if (hint.dataset.cut === '1') { hint.removeAttribute('title'); delete hint.dataset.cut; }
    }
  };
  let due = false;
  const soon = () => {
    if (due) return;
    due = true;
    queueMicrotask(() => { due = false; mark(); });
  };
  strip.addEventListener('scroll', mark, { passive: true });
  strip.addEventListener('wheel', (ev) => {
    if (strip.scrollWidth - strip.clientWidth <= 1 || ev.ctrlKey) return;
    const delta = Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY;
    if (!delta) return;
    strip.scrollLeft += ev.deltaMode === 1 ? delta * 16 : delta;
    mark();
    ev.preventDefault();   // the page itself never scrolls; this keeps a trackpad from "going back" on a sideways swipe
  }, { passive: false });
  window.addEventListener('resize', soon);
  // a tool fills its strip when it is activated and rebuilds it when its mode changes
  if (typeof MutationObserver === 'function') new MutationObserver(soon).observe(strip, { childList: true, subtree: true, characterData: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(soon).observe(strip);
  mark();
}

// ---------------------------------------------------------------- tool switching

// ui 'tool' -> deactivate the old tool, activate the new one, fill the options strip.
// (The viewport hears the same event first: it has already ended an open press and cancelled an open modal.
// ctx.tools is read when the event comes, so this may be wired before the tools exist.)
function wireTools(ctx) {
  const { ui, store } = ctx, strip = $('#tooloptions');
  let active = null;   // { id, tool }
  if (strip) fitStrip(strip);

  ui.on('tool', (id) => {
    const tool = ctx.tools[id];
    if (!tool) {
      console.warn(`[editor] no such tool: '${id}'`);
      if (id !== 'select' && ctx.tools.select) ui.set('tool', 'select');
      return;
    }
    if (active) {
      const old = active;
      if (typeof old.tool.deactivate === 'function') guard(`tool ${old.id}`, 'deactivate', () => old.tool.deactivate());
    }
    // deactivate() must have closed whatever the tool had open; an edit left open would swallow the next tool's steps
    if (store.grouping) {
      console.warn(`[editor] tool '${active?.id ?? id}' left a store group open: cancelled`);
      guard('store', 'cancel', () => store.cancel());
    }
    const now = active = { id, tool };
    strip?.replaceChildren();
    if (strip) strip.scrollLeft = 0;
    if (typeof tool.activate === 'function') guard(`tool ${id}`, 'activate', () => tool.activate());
    if (active !== now) return;   // activate() chose another tool itself (a paste with nothing to paste)
    if (strip && typeof tool.options === 'function') {
      if (guard(`tool ${id}`, 'options', () => { tool.options(strip); return true; }, false) !== true) strip.replaceChildren();
    }
    ctx.viewport.invalidate();
  });
}

// ---------------------------------------------------------------- #at=x,z

// The game's "Edit here" (and anybody's link) names a ground point: the camera goes there. The hash is taken off the
// address afterwards, so the same spot asked for twice in a row is a change of the hash both times.
function applyHash(ctx, animate) {
  const at = new URLSearchParams(location.hash.slice(1)).get('at');
  if (at === null) return;
  const parts = at.split(','), x = Number(parts[0]), z = Number(parts[1]);
  if (parts.length === 2 && parts[0].trim() !== '' && parts[1].trim() !== '' && Number.isFinite(x) && Number.isFinite(z)) {
    ctx.viewport.setTarget(x, z, { animate });
  }
  try { history.replaceState(history.state, '', location.pathname + location.search); } catch { /* the hash stays: harmless */ }
}

// ---------------------------------------------------------------- the test hook (§10.17)

function testHook(ctx) {
  const { viewport } = ctx;
  // A ground point - the point of the TERRAIN over (x, z) - in client pixels. A point that is not on the canvas is
  // brought there by moving the camera to it. (A point behind a hill is on the canvas and still not what a click at
  // its pixel meets: the script then has to turn the camera, as a user would.)
  const pixel = (x, z) => {
    let p = viewport.project(x, viewport.groundY(x, z), z);
    if (!p.visible) {
      viewport.setTarget(x, z, { animate: false });
      p = viewport.project(x, viewport.groundY(x, z), z);
    }
    return p;
  };
  const tick = (dt = 0.016) => viewport.tick(dt);
  return {
    store: ctx.store, ui: ctx.ui, cmd, actions: ctx.actions, viewport, view: ctx.view, markers: ctx.markers,
    tools: ctx.tools, overlays: ctx.overlays, net: ctx.net, fmt,
    ctx,   // beyond the contract: what a tool or a panel is handed, for the console
    tick,
    // pointerDown + pointerUp at a ground point, through the viewport's own pointer path: what is picked there is
    // decided by normal picking, and an open grab or pick-a-point takes the click as it would a real one
    click(x, z, mods = {}) {
      const p = pixel(x, z);
      viewport.input('down', p.x, p.y, mods);
      viewport.input('up', p.x, p.y, mods);
      tick(0.016);
    },
    // pointerDown at the first point, pointerMove through the rest, pointerUp at the last
    drag(points, mods = {}) {
      if (!Array.isArray(points) || !points.length) return;
      let p = null;
      points.forEach(([x, z], i) => {
        p = pixel(x, z);
        viewport.input(i === 0 ? 'down' : 'move', p.x, p.y, mods);
      });
      viewport.input('up', p.x, p.y, mods);
      tick(0.016);
    },
    // one key press through the keymap; mods: { mod, shift, alt }. -> whether anything used it
    key(code, mods = {}) {
      return ctx.keymap.press(code, mods);
    },
  };
}

// ---------------------------------------------------------------- boot

async function boot() {
  const net = createNet();
  const { map, assets } = await net.loadAll();   // throws a MapError when the server's map does not normalize

  const ui = createUi();
  const dialogs = createModal($('#modal'));
  ui.attach({ toast: createToasts($('#toasts')), confirm: dialogs.confirm, choose: dialogs.choose, prompt: dialogs.prompt });
  const store = createStore();

  // Filled in the order the modules are created: each one reads what it needs from ctx when it needs it.
  const ctx = {
    store, ui, viewport: null, view: null, markers: null, gizmo: null, net, actions: null, keymap: null, cmd,
    assets,
    models: listModels(assets),                              // the palette and "replace model" (hidden models left out)
    modelSet: new Set(listModels(assets, { hidden: true })),   // the ONLY set passed to validate()
    tools: {}, overlays: {},
  };
  ctx.viewport = createViewport(ctx);   // creates the MapView; attaches ui.pickPoint and ui.setCursor
  ctx.view = ctx.viewport.view;
  ctx.markers = new Markers(ctx.viewport.scene, ctx);
  ctx.gizmo = createGizmo(ctx);
  ctx.actions = createActions(ui);
  ctx.viewport.registerActions();       // view.*: the viewport was created before there were actions
  net.install(ctx);                     // file.save, ui.readOnly
  ctx.keymap = installKeymap(ctx);      // edit.cancel
  registerCoreActions(ctx);             // edit.undo, edit.redo, snap.toggle, tool.<id>
  // Before any tool or panel can subscribe: by the time they hear ui 'tool', the new tool is active and has its options.
  wireTools(ctx);

  // ---- every module of the three registries, core and step 4 alike: one code path loads them all
  const [tools, panels, overlays] = await Promise.all([TOOLS, PANELS, OVERLAYS].map((rows) => Promise.all(rows.map(load))));

  TOOLS.forEach((row, i) => {
    let tool = tools[i] ? guard(`tool ${row.id}`, 'create', () => tools[i](ctx), THREW) : null;
    if (tool === THREW) tool = null;
    else if (tools[i] && (tool === null || typeof tool !== 'object')) {
      console.error(`[editor] ${row.path}: create() returned no tool`);
      tool = null;
    }
    ctx.tools[row.id] = tool ?? toolStub(row);
  });

  OVERLAYS.forEach((row, i) => {
    let overlay = overlays[i] ? guard(`overlay ${row.id}`, 'create', () => overlays[i](ctx), THREW) : null;
    if (overlay === THREW) overlay = null;
    else if (overlays[i] && (overlay === null || typeof overlay !== 'object')) {
      console.error(`[editor] ${row.path}: create() returned no overlay`);
      overlay = null;
    }
    ctx.overlays[row.id] = overlay ?? overlayStub(row);
  });
  // the id of an overlay is its key in ui.overlays
  const showOverlays = () => {
    for (const id of Object.keys(ctx.overlays)) {
      const overlay = ctx.overlays[id];
      if (typeof overlay.setVisible === 'function') guard(`overlay ${id}`, 'setVisible', () => overlay.setVisible(!!ui.overlays[id]));
    }
  };
  showOverlays();
  ui.on('overlays', showOverlays);

  wrapFrames(ui);
  PANELS.forEach((row, i) => {
    const el = $(row.el);
    if (!el) {
      console.error(`[editor] ${row.path}: the page has no ${row.el}`);
      return;
    }
    const name = `panel ${panelName(row)}`;
    const panel = panels[i] ? guard(name, 'mount', () => panels[i](el, ctx) ?? {}, null) : null;
    if (!panel) panelStub(el, row);
    else if (typeof panel.update === 'function') ctx.viewport.addPanel(panel, name);   // every rendered frame
  });

  // ---- the map. Tools, overlays and panels were built while store.map was still null: they draw on this 'load'.
  store.load(map);                      // the viewport awaits view.load and reports the progress
  ctx.view.preload(ctx.models).catch((err) => console.warn('[editor] model preload failed', err));   // in the background

  applyHash(ctx, false);
  window.addEventListener('hashchange', () => applyHash(ctx, true));

  ui.set('tool', 'select');
  window.__editor = testHook(ctx);
}

boot().catch((err) => {
  console.error('[editor] boot failed', err);
  bootFailure(err);
});
