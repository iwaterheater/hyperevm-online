import { h, button } from '../ui/dom.js';
import { LAYER_OF, validate } from '../../map/format.js';
import { editorChecks } from '../checks.js';

// The Issues panel (#validation): everything that is wrong with the map, or merely odd.
//
//   errors     what validate() rejects - the server would answer 422, so Save is disabled while there is one
//              (this panel writes the counts to ui.issues; the menu bar and net.save read them)
//   warnings   what validate() only remarks on, plus the editor's own checks (checks.js): items nobody can reach,
//              items inside colliders, regions that never win, triangle budgets, models that failed to load
//
// The checks run 500 ms after the last change and never while an undo group is open (a drag, a typed edit): a map in
// the middle of a gesture is nobody's business. They also run again when the view's colliders change without an edit -
// models arrive after the map does.
// Issues are grouped by code; a click on a row selects the item it names and moves the camera there.
// Action 'validation.open' expands the panel and scrolls to it (Save's toast links to it).

const DELAY = 500;      // ms after the last change
const ROWS = 40;        // rows of one group shown at first; the rest waits behind "Show all"
const OPEN_UP_TO = 6;   // a group with at most this many rows starts open

const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

export default function mount(el, ctx) {
  const { store, ui, actions } = ctx;

  let entries = [];             // [{ issue, item }] of the last run; the item references die with their map
  let signature = null;         // what the list showed, so an unchanged result does not rebuild the DOM
  let timer = 0;
  let stale = true;             // the map changed since the last run
  let checked = false;          // a run has completed for this map
  let noted = { colliders: -1, missing: -1 };   // the view's state when a change of it was last noticed
  let failed = false;           // editorChecks threw: reported once, the validate() part still counts
  const triangles = new Map();  // model id -> triangles of one instance, as the models arrive
  const asked = new Set();      // model ids whose triangle count was asked for
  const opened = new Map();     // group key -> the user's own choice of open / closed
  const expanded = new Set();   // group keys shown in full

  // ---- static DOM
  const badges = h('span', { class: 'badges' });
  const state = h('span', { class: 'state ui-hint' });
  const again = button('Check now', () => run(true), { title: 'Run the checks now' });
  again.classList.add('flat');
  const note = h('div', { class: 'note ui-hint', hidden: true });
  const list = h('div', { class: 'groups' });
  el.replaceChildren(h('div', { class: 'head' }, badges, state, h('span', { class: 'ui-spacer' }), again), note, list);

  // ---------------------------------------------------------------- running the checks

  // The triangle counts come from the models themselves; a model that is still on its way counts once it is there.
  function askTriangles(map) {
    const view = ctx.view;
    if (!view || typeof view.loadModel !== 'function') return;
    for (const obj of map.objects) {
      const id = obj.m;
      if (asked.has(id)) continue;
      asked.add(id);
      Promise.resolve(view.loadModel(id)).then((model) => {
        const n = model?.triangles;
        if (!(n > 0) || triangles.get(id) === n) return;
        triangles.set(id, n);
        schedule();
      }, () => { /* loadModel never rejects; a view that does has said so itself */ });
    }
  }

  function schedule(delay = DELAY) {
    stale = true;
    clearTimeout(timer);
    timer = setTimeout(run, delay);
    showState();
  }

  function run(byHand = false) {
    clearTimeout(timer);
    timer = 0;
    const map = store.map;
    if (!map) return;
    if (store.grouping) {   // 'history' brings us back when the group closes
      if (byHand === true) ui.toast('Finish the current edit first', 'warn');
      showState();
      return;
    }
    const found = validate(map, { models: ctx.modelSet ?? null, strictModels: true });
    let extra = [];
    try {
      askTriangles(map);
      const view = ctx.view;
      extra = editorChecks(map, { obstacles: view?.obstacles?.() ?? null, missing: view?.missing ?? null, triangles });
    } catch (err) {
      if (!failed) console.error('[editor] the editor checks failed', err);
      failed = true;
    }
    stale = false;
    checked = true;
    // the item an issue names is looked up now, while the indices are those of this very map
    entries = [...found, ...extra].map((issue) => {
      const item = issue.kind && Number.isInteger(issue.index) ? store.items(issue.kind)[issue.index] ?? null : null;
      return { issue, item };
    });
    const errors = entries.filter((e) => e.issue.level === 'error').length, warnings = entries.length - errors;
    if (ui.issues?.errors !== errors || ui.issues?.warnings !== warnings) ui.set('issues', { errors, warnings });
    render();
  }

  // ---------------------------------------------------------------- showing them

  function showState() {
    state.textContent = !store.map ? '' : store.grouping && stale ? 'waiting for the edit to finish' : stale ? 'checking…' : '';
  }

  function focus(entry) {
    const { issue, item } = entry;
    const live = item && store.kindOf(item) === issue.kind ? item : null;   // still in the map
    if (live) {
      store.select([live]);
      const layer = LAYER_OF[issue.kind], l = ui.layers?.[layer];
      if (l && (!l.visible || l.locked)) ui.toast(`Layer ${l.visible ? 'locked' : 'hidden'}: ${layer}`, 'warn');
    }
    if (finite(issue.x) && finite(issue.z)) ctx.viewport.focus({ x: issue.x, z: issue.z });
    else if (live) ctx.viewport.focus([live]);
    ui.setStatus(issue.message);
  }

  function rowOf(entry) {
    const { issue } = entry, there = entry.item !== null || (finite(issue.x) && finite(issue.z));
    const node = h('div', {
      class: ['ui-item', 'row', !there && 'plain'], role: there ? 'button' : null,
      title: there ? `${issue.path}\nClick: select it and go there` : issue.path,
      dataset: { code: issue.code, path: issue.path },
    }, h('span', { class: 'message' }, issue.message), h('span', { class: 'path ui-mono' }, issue.path));
    if (there) node.addEventListener('click', () => focus(entry));
    return node;
  }

  function render() {
    showState();
    const next = entries.map((e) => `${e.issue.level}\n${e.issue.code}\n${e.issue.path}\n${e.issue.message}`).join('\n\n');
    if (next === signature) return;
    signature = next;

    const errors = entries.filter((e) => e.issue.level === 'error').length, warnings = entries.length - errors;
    badges.replaceChildren(...[
      errors ? h('span', { class: 'ui-badge danger' }, plural(errors, 'error')) : null,
      warnings ? h('span', { class: 'ui-badge warn' }, plural(warnings, 'warning')) : null,
      !entries.length ? h('span', { class: 'ui-badge ok' }, checked ? 'No issues' : 'Not checked yet') : null,
    ].filter(Boolean));   // the DOM would print a null as the word
    note.hidden = !errors;
    note.textContent = errors ? (ui.readOnly ? 'Errors: the server would refuse this map.' : 'Errors block saving: the server would refuse this map.') : '';

    // groups in the order of their first issue: errors come first from validate()
    const groups = new Map();
    for (const entry of entries) {
      const key = `${entry.issue.level}:${entry.issue.code}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    const nodes = [];
    for (const [key, rows] of groups) {
      const { level, code } = rows[0].issue, all = expanded.has(key) || rows.length <= ROWS;
      const body = h('div', { class: 'ui-list' }, (all ? rows : rows.slice(0, ROWS)).map(rowOf));
      if (!all) {
        const more = button(`Show all ${rows.length.toLocaleString('en-US')}`, () => { expanded.add(key); signature = null; render(); });
        more.classList.add('flat', 'more');
        body.append(more);
      }
      const summary = h('summary', { class: 'summary' },
        h('span', { class: 'code ui-mono' }, code),
        h('span', { class: ['ui-badge', level === 'error' ? 'danger' : 'warn'] }, rows.length.toLocaleString('en-US')));
      summary.addEventListener('mousedown', (ev) => ev.preventDefault());   // a header never takes the focus
      const group = h('details', { class: ['group', level], dataset: { code, level }, open: opened.get(key) ?? (level === 'error' || rows.length <= OPEN_UP_TO) }, summary, body);
      // only what the user chose is remembered (the click comes before the element toggles): a group that was open
      // because it was short may close by itself when it grows
      summary.addEventListener('click', () => opened.set(key, !group.open));
      nodes.push(group);
    }
    list.replaceChildren(...nodes);
    if (!entries.length) list.append(h('div', { class: 'ui-empty' }, checked ? 'Nothing to report: the map can be saved.' : 'The map has not been checked yet.'));
  }

  // ---------------------------------------------------------------- wiring

  store.on('load', () => {
    // another map: its items are other objects, and nothing of the old list may be clicked
    entries = [];
    signature = null;
    checked = false;
    expanded.clear();
    if (ui.issues?.errors || ui.issues?.warnings) ui.set('issues', { errors: 0, warnings: 0 });
    render();
    schedule(0);   // as soon as everybody has heard the 'load': an imported map with errors must not look saveable
  });
  store.on('change', () => schedule());
  store.on('history', () => {
    if (stale && !store.grouping && !timer) schedule();
    else showState();
  });
  ui.on('readOnly', () => { signature = null; render(); });

  if (!actions.has('validation.open')) {
    actions.register('validation.open', () => {
      const box = el.parentElement;
      if (box && 'open' in box) box.open = true;   // the collapsible frame around the panel
      el.scrollIntoView({ block: 'nearest' });
    });
  }

  render();
  if (store.map) schedule(0);

  return {
    // Every rendered frame: have the colliders or the list of failed models changed without an edit? (A model that
    // arrives brings its colliders; the view cannot tell anybody but the viewport.)
    update() {
      const view = ctx.view;
      if (!view || !store.map) return;
      const colliders = view.obstaclesVersion ?? 0, missing = view.missing?.size ?? 0;
      if (colliders === noted.colliders && missing === noted.missing) return;
      noted = { colliders, missing };
      // No edit, so nothing to wait out: a run that is already due stays due (the first check of a new map must not
      // be pushed back by every model that arrives), and without one this asks for the next.
      if (timer) stale = true;
      else schedule();
    },
  };
}
