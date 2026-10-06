import { h, button, selectField, textField, rafThrottle, leaveField } from '../ui/dom.js';
import { hintFor } from '../keymap.js';
import { GROUP_PATTERN } from '../fields.js';
import { COLLECTION, LAYERS, LAYER_OF, spawnCount } from '../../map/format.js';

// The Layers panel (#layers): what is shown and what may be touched.
//
//   layers   an eye and a lock per layer with its item count. A hidden or locked layer is never picked, boxed, erased
//            or edited (ui.isPickable); the toolbar disables its tool. Alt+click on an eye shows that layer alone.
//   models   under Objects: every model the map uses with its count and an eye of its own (ui.hiddenModels - the
//            viewport hides the instances, this panel never calls the view). A click on a row selects all objects of
//            that model; "Replace" swaps the model of all of them in one undo step.
//   groups   every group id with its member count: rename (one undo step), select, frame in the viewport.
//
// The panel only writes `ui` state and runs commands; the lists are recounted from the map after every change and
// rebuilt only when a count, an id or a name really changed.

const NAMES = {
  ground: 'Ground', foliage: 'Foliage', objects: 'Objects', spawns: 'Spawns', chests: 'Chests', npcs: 'NPCs', regions: 'Regions', start: 'Start point',
};
const NO_LOCK = new Set(['foliage']);                              // nothing edits foliage: it grows from the ground types
const GROUPED = ['object', 'spawn', 'chest', 'npc'];               // the kinds that carry a group id
const NOUN = { object: 'object', spawn: 'spawn', chest: 'chest', npc: 'NPC' };

const int = (n) => n.toLocaleString('en-US');
const plural = (n, word) => `${int(n)} ${word}${n === 1 ? '' : 's'}`;

// A small square button that shows an icon drawn by layers.css from its classes ('eye' / 'lock', plus 'off').
function iconButton(cls, onClick) {
  const node = button(h('span', { class: 'glyph' }), onClick);
  node.classList.add('flat', 'icon', cls);
  return node;
}

// A collapsible block whose heading changes ("Models (87)"). Its header never takes the focus, like every other one.
function fold(cls, open = true) {
  const title = h('span', { class: 'title' }), extra = h('span', { class: 'extra' });
  const summary = h('summary', null, title, extra), body = h('div', { class: 'ui-section-body' });
  summary.addEventListener('mousedown', (ev) => { ev.preventDefault(); leaveField(); });
  return { el: h('details', { class: `ui-section ${cls}`, open }, summary, body), title, extra, body };
}

export default function mount(el, ctx) {
  const { store, ui, cmd } = ctx;

  // ---------------------------------------------------------------- layers

  const layerRows = LAYERS.map((layer) => {
    const eye = iconButton('eye', (ev) => {
      if (ev.altKey) solo(layer);
      else setLayer(layer, { visible: !ui.layers[layer].visible });
    });
    const lock = NO_LOCK.has(layer) ? h('span', { class: 'nolock' }) : iconButton('lock', () => setLayer(layer, { locked: !ui.layers[layer].locked }));
    const count = h('span', { class: 'count' });
    const node = h('div', { class: 'layer', dataset: { layer } }, eye, lock, h('span', { class: 'name' }, NAMES[layer] ?? layer), count);
    return { layer, node, eye, lock, count };
  });

  // The tool of a layer that was just hidden or locked has nothing left to edit; and what is hidden cannot stay
  // selected - it would be moved and deleted unseen.
  function afterLayers(before) {
    const tool = ctx.tools?.[ui.tool], state = tool?.layer ? ui.layers[tool.layer] : null;
    if (state && (!state.visible || state.locked) && ui.tool !== 'select') ui.set('tool', 'select');
    const hidden = LAYERS.filter((layer) => before[layer].visible && !ui.layers[layer].visible);
    if (hidden.length && store.selection.size) {
      store.select([...store.selection].filter((item) => !hidden.includes(LAYER_OF[store.kindOf(item)])));
    }
  }
  function setLayer(layer, patch) {
    const before = ui.layers;
    ui.set('layers', { ...before, [layer]: { ...before[layer], ...patch } });
    afterLayers(before);
  }
  // Alt+click: this layer alone; again (when it already is alone): all of them.
  function solo(layer) {
    const before = ui.layers, alone = LAYERS.every((l) => before[l].visible === (l === layer));
    ui.set('layers', Object.fromEntries(LAYERS.map((l) => [l, { ...before[l], visible: alone || l === layer }])));
    afterLayers(before);
  }

  function syncLayers() {
    for (const row of layerRows) {
      const state = ui.layers[row.layer] ?? { visible: true, locked: false }, name = NAMES[row.layer] ?? row.layer;
      row.node.classList.toggle('hidden', !state.visible);
      row.node.classList.toggle('locked', !!state.locked);
      row.eye.classList.toggle('off', !state.visible);
      row.eye.setAttribute('aria-pressed', String(!!state.visible));
      row.eye.title = `${state.visible ? 'Hide' : 'Show'} ${name} (Alt+click: this layer alone)`;
      if (!NO_LOCK.has(row.layer)) {
        row.lock.classList.toggle('off', !state.locked);
        row.lock.setAttribute('aria-pressed', String(!!state.locked));
        row.lock.title = state.locked ? `Unlock ${name}` : `Lock ${name}: it stays visible but cannot be picked or edited`;
      }
    }
  }

  // ---------------------------------------------------------------- models

  const models = fold('models');
  const filter = h('input', { type: 'search', class: 'ui-input filter', placeholder: 'Filter models', autocomplete: 'off', spellcheck: false, 'aria-label': 'Filter models' });
  const showAll = button('Show all', () => ui.set('hiddenModels', new Set()), { title: 'Show every hidden model again' });
  showAll.classList.add('flat');
  const modelList = h('div', { class: 'ui-list scroll' });
  models.body.append(h('div', { class: 'tools' }, filter, showAll), modelList);
  let replacing = null;        // the model id whose "replace" editor is open
  let modelCounts = new Map(); // id -> number of objects
  filter.addEventListener('input', () => drawModels());

  const objectsOf = (id) => store.map.objects.filter((obj) => obj.m === id);
  const layerOpen = (layer) => { const l = ui.layers[layer]; return !l || (l.visible && !l.locked); };
  const refuse = (layer) => ui.toast(`Layer ${ui.layers[layer]?.visible ? 'locked' : 'hidden'}: ${layer}`, 'warn');

  function toggleModel(id) {
    const next = new Set(ui.hiddenModels);
    if (!next.delete(id)) next.add(id);
    ui.set('hiddenModels', next);
    // what is hidden cannot stay selected
    if (next.has(id) && store.selection.size) store.select([...store.selection].filter((item) => item.m !== id || store.kindOf(item) !== 'object'));
  }

  function selectModel(id, add) {
    if (!store.map) return;
    const items = objectsOf(id).filter((obj) => ui.isPickable('object', obj));
    if (!items.length) {
      if (!layerOpen('objects')) refuse('objects');
      else ui.toast(ui.hiddenModels.has(id) ? 'This model is hidden: show it first' : 'No object of this model', 'warn');
      return;
    }
    store.select(items, { add });
    ui.setStatus(`Selected ${plural(items.length, 'object')} of ${id}`);
  }

  // All objects of one model get another: one undo step. A hidden model is replaced like a shown one - this panel is
  // where it was hidden - but a locked or hidden Objects layer is not edited.
  function replaceModel(from, to) {
    if (!store.map || !to || to === from) return;
    if (store.grouping) { ui.toast('Finish the current edit first', 'warn'); return; }
    if (!layerOpen('objects')) { refuse('objects'); return; }
    const items = objectsOf(from);
    if (!items.length) return;
    store.exec(cmd.set(items, { m: to }));
    replacing = null;
    ui.toast(`Replaced the model of ${plural(items.length, 'object')}: ${to}`);
  }

  function replaceEditor(id, n) {
    const options = (ctx.models ?? []).filter((m) => m !== id);
    const palette = ui.models?.[0];
    const pick = selectField({ value: palette && options.includes(palette) ? palette : options[0], options });
    pick.el.setAttribute('aria-label', 'Replace with');
    const go = button(`Replace ${int(n)}`, () => replaceModel(id, pick.value), { title: `Give all ${plural(n, 'object')} of ${id} the chosen model (one undo step)` });
    go.classList.add('primary');
    go.disabled = !options.length;
    const cancel = button('Cancel', () => { replacing = null; drawModels(); });
    return h('div', { class: 'replace', dataset: { model: id } }, h('span', { class: 'ui-dim' }, 'with'), pick, go, cancel);
  }

  function drawModels() {
    const hiddenSet = ui.hiddenModels, needle = filter.value.trim().toLowerCase();
    // a hidden model whose last object is gone still gets a row: it must be possible to show it again
    const ids = [...new Set([...modelCounts.keys(), ...hiddenSet])].sort();
    const shown = needle ? ids.filter((id) => id.toLowerCase().includes(needle)) : ids;
    models.title.textContent = `Models (${int(modelCounts.size)})`;
    models.extra.textContent = hiddenSet.size ? `${int(hiddenSet.size)} hidden` : '';
    showAll.hidden = hiddenSet.size === 0;
    filter.hidden = ids.length < 8 && !needle;
    if (replacing !== null && !modelCounts.has(replacing)) replacing = null;

    const nodes = [];
    for (const id of shown) {
      const n = modelCounts.get(id) ?? 0, off = hiddenSet.has(id), cut = id.indexOf('/');
      const eye = iconButton('eye', (ev) => { ev.stopPropagation(); toggleModel(id); });
      if (off) eye.classList.add('off');
      eye.title = off ? `Show ${id}` : `Hide ${id}: its objects cannot be picked while hidden`;
      eye.setAttribute('aria-pressed', String(!off));
      const swap = button('Replace', (ev) => { ev.stopPropagation(); replacing = replacing === id ? null : id; drawModels(); },
        { title: `Replace the model of all ${plural(n, 'object')}…`, disabled: n === 0 });
      swap.classList.add('flat', 'swap');
      if (replacing === id) swap.classList.add('active');
      const row = h('div', {
        class: ['ui-item', 'model', off && 'hidden', n === 0 && 'unused'], dataset: { model: id },
        title: n ? `${id}\nClick: select all ${int(n)} · Shift+click: add them to the selection` : `${id}\nNo object uses this model any more`,
      }, eye, h('span', { class: 'name' }, h('span', { class: 'pack' }, id.slice(0, cut + 1)), id.slice(cut + 1)), h('span', { class: 'count' }, int(n)), swap);
      row.addEventListener('click', (ev) => { if (n) selectModel(id, ev.shiftKey); });
      nodes.push(row);
      if (replacing === id) nodes.push(replaceEditor(id, n));
    }
    if (!nodes.length) {
      nodes.push(h('div', { class: 'ui-empty' }, !store.map ? 'No map loaded.' : needle ? 'No model matches the filter.' : 'No objects on the map yet: pick a model in the palette and place it.'));
    }
    modelList.replaceChildren(...nodes);
  }

  // ---------------------------------------------------------------- groups

  const groups = fold('groups');
  const groupList = h('div', { class: 'ui-list scroll' });
  groups.body.append(groupList);
  let groupCounts = new Map();   // id -> { n, object, spawn, chest, npc }

  function membersOf(g) {
    const out = [];
    for (const kind of GROUPED) for (const item of store.map[COLLECTION[kind]]) if (item.g === g) out.push(item);
    return out;
  }

  // Rename: every member gets the new id, whatever its layer - a group is one thing across layers, and renaming the
  // unlocked half of it would silently split it. An empty name dissolves the group.
  function renameGroup(from, to) {
    if (!store.map || to === from) return;
    if (store.grouping) { ui.toast('Finish the current edit first', 'warn'); drawGroups(); return; }
    const items = membersOf(from);
    if (!items.length) return;
    const merged = to !== '' && groupCounts.has(to);
    store.exec(cmd.set(items, { g: to === '' ? undefined : to }));
    ui.toast(to === '' ? `Ungrouped ${plural(items.length, 'item')}` : merged ? `Merged ${from} into the group ${to}` : `Renamed the group ${from} to ${to}`);
  }

  function selectGroup(g, add) {
    const all = membersOf(g), items = all.filter((item) => ui.isPickable(store.kindOf(item), item));
    if (!items.length) { ui.toast('Every member of this group is on a hidden or locked layer', 'warn'); return; }
    store.select(items, { add });
    ui.setStatus(items.length === all.length ? `Selected the group ${g}: ${plural(items.length, 'item')}`
      : `Selected ${int(items.length)} of ${int(all.length)} items of the group ${g}: the rest is hidden or locked`);
  }

  function drawGroups() {
    groups.title.textContent = `Groups (${int(groupCounts.size)})`;
    const nodes = [];
    for (const g of [...groupCounts.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
      const c = groupCounts.get(g);
      const name = textField({ value: g, maxLength: 32, pattern: GROUP_PATTERN, onCommit: (text) => renameGroup(g, text) });
      name.input.title = 'Group id: letters, digits, _ . - (at most 32). Rename it here; an empty name ungroups its members.';
      name.input.setAttribute('aria-label', `Group ${g}`);
      const parts = GROUPED.filter((kind) => c[kind]).map((kind) => plural(c[kind], NOUN[kind]));
      const pick = button('Select', (ev) => selectGroup(g, ev.shiftKey), { title: 'Select the members of this group (Shift+click: add them)' });
      const go = button('Focus', () => { const items = membersOf(g); if (items.length) ctx.viewport.focus(items); }, { title: 'Frame this group in the viewport' });
      pick.classList.add('flat');
      go.classList.add('flat');
      nodes.push(h('div', { class: 'group', dataset: { group: g } }, name.el, h('span', { class: 'count', title: parts.join(', ') }, int(c.n)), pick, go));
    }
    if (!nodes.length) {
      const key = hintFor('edit.group');
      nodes.push(h('div', { class: 'ui-empty' }, !store.map ? 'No map loaded.' : `No groups. Select items and group them${key ? ` (${key})` : ''}: a click on one member then selects them all.`));
    }
    groupList.replaceChildren(...nodes);
  }

  // ---------------------------------------------------------------- counting

  let signature = '';
  function recount() {
    const map = store.map, mc = new Map(), gc = new Map();
    if (map) {
      for (const obj of map.objects) mc.set(obj.m, (mc.get(obj.m) ?? 0) + 1);
      for (const kind of GROUPED) {
        for (const item of map[COLLECTION[kind]]) {
          if (typeof item.g !== 'string') continue;
          let c = gc.get(item.g);
          if (!c) gc.set(item.g, c = { n: 0, object: 0, spawn: 0, chest: 0, npc: 0 });
          c.n++;
          c[kind]++;
        }
      }
    }
    // the layer counts
    const text = {
      ground: map ? `${map.ground.size} × ${map.ground.size}` : '',
      foliage: map ? (map.foliage ? 'auto' : 'off') : '',
      objects: map ? int(map.objects.length) : '',
      spawns: map ? `${int(map.spawns.length)} · ${plural(spawnCount(map), 'monster')}` : '',
      chests: map ? int(map.chests.length) : '', npcs: map ? int(map.npcs.length) : '', regions: map ? int(map.regions.length) : '', start: '',
    };
    for (const row of layerRows) if (row.count.textContent !== text[row.layer]) row.count.textContent = text[row.layer];
    layerRows.find((r) => r.layer === 'foliage').count.title = 'Grass and flowers grow by themselves on the ground types that have them; the switch is a map property (Inspector, nothing selected)';

    // the two lists: rebuilt only when what they show changed - never under a field that is being typed in
    const next = `${[...mc].map(([id, n]) => `${id}=${n}`).sort().join('|')}\n${[...gc].map(([g, c]) => `${g}=${c.n},${c.object},${c.spawn},${c.chest},${c.npc}`).sort().join('|')}`;
    if (next === signature) return;
    signature = next;
    modelCounts = mc;
    groupCounts = gc;
    drawModels();
    drawGroups();
  }
  const recountSoon = rafThrottle(recount);

  // ---------------------------------------------------------------- wiring

  el.replaceChildren(h('div', { class: 'layers' }, layerRows.map((row) => row.node)), models.el, groups.el);

  store.on('load', () => { replacing = null; signature = '\u0000'; recount(); });
  store.on('change', (change) => {
    // a move, a paint stroke or a region edit changes no count, no model and no group
    const { added, removed, updated } = change;
    const lists = ['objects', 'spawns', 'chests', 'npcs', 'regions'];
    if (lists.some((key) => added[key].length || removed[key].length) || updated.objects.length || updated.spawns.length
      || updated.chests.length || updated.npcs.length || change.props.length) recountSoon();
  });
  ui.on('layers', syncLayers);
  ui.on('hiddenModels', drawModels);
  ui.on('models', () => { if (replacing !== null) drawModels(); });   // the palette's choice is the editor's suggestion

  syncLayers();
  recount();
  return {
    // Every rendered frame: a recount that is waiting for its animation frame is done with this one (a change of the
    // map always asks the viewport for a frame; a throttled window hands out none of its own).
    update() { recountSoon.flush(); },
  };
}
