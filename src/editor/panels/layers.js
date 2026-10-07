import { h, button, selectField, textField, rafThrottle, leaveField, CANCEL_EVENT, COMMIT_EVENT } from '../ui/dom.js';
import { hintFor, keyText } from '../keymap.js';
import { GROUP_PATTERN } from '../fields.js';
import { COLLECTION, LAYERS, LAYER_OF, LIMITS, layerProblem, spawnCount } from '../../map/format.js';

// The Layers panel (#layers): what is shown and what may be touched.
//
//   layers   an eye and a lock per layer with its item count. A hidden or locked layer is never picked, boxed, erased
//            or edited (ui.isPickable); the toolbar disables its tool. Alt+click on an eye shows that layer alone.
//   my layers  the map's OWN layers ("Town", "Forest", "Bandit camp"): names that are saved with the map (map.layers),
//            each with an eye and a lock that are the editor's. An object, spawn, chest or NPC is on one of them or on
//            none (its `l`). A click on a row makes the layer ACTIVE - what is placed from then on goes onto it - and a
//            second click returns to "no layer"; a double-click (or F2 for the active one) renames, a drag reorders,
//            and the "..." of a row opens its actions: move the selection here, select its items, rename, delete.
//            A hidden or locked layer of the map's own keeps its items out of every pick and edit, like a fixed one.
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
const GROUPED = ['object', 'spawn', 'chest', 'npc'];               // the kinds that carry a group id - and a layer of the map's own
const DRAG_PX = 4;                                                 // a press on a layer row that travels less is a click
const BUSY = 'Finish the current edit first';
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
      row.eye.title = `${state.visible ? 'Hide' : 'Show'} ${name} (${keyText('Alt+click: this layer alone')})`;
      if (!NO_LOCK.has(row.layer)) {
        row.lock.classList.toggle('off', !state.locked);
        row.lock.setAttribute('aria-pressed', String(!!state.locked));
        row.lock.title = state.locked ? `Unlock ${name}` : `Lock ${name}: it stays visible but cannot be picked or edited`;
      }
    }
  }


  // ---------------------------------------------------------------- my layers (the map's own)

  const mine = fold('mine');
  const addButton = button('+ Add layer', () => startNaming({ add: true }), { title: 'A new layer of your own: what you place while it is active goes onto it' });
  const mineList = h('div', { class: 'ui-list mine-list' });
  const mineHint = h('div', { class: 'ui-hint' }, keyText('Click a layer: new items go onto it (again: onto none) · double-click: rename · drag: reorder'));
  const drop = h('div', { class: 'drop', hidden: true });
  mine.body.append(h('div', { class: 'tools' }, addButton), mineList, mineHint);
  let layerCounts = new Map();   // layer name -> { n, object, spawn, chest, npc }
  let naming = null;             // the name that is being typed: { add: true } | { rename: name }, with its `input` once drawn
  let menuFor = null;            // the layer whose actions are shown under its row
  let press = null;              // a press on a row: { el, name, x, y, id, dragging, dead, slot }
  let mineStale = false;         // a redraw was asked for under a drag or a name that is being typed

  const layersOf = () => store.map?.layers ?? [];
  const onLayer = (name) => {
    const out = [];
    if (store.map) for (const kind of GROUPED) for (const item of store.map[COLLECTION[kind]]) if (item.l === name) out.push(item);
    return out;
  };
  const closed = (name) => { const state = ui.layerState(name); return !state.visible ? 'hidden' : state.locked ? 'locked' : null; };
  const quoted = (name) => `“${name}”`;

  // One command as one undo step. -> whether it ran (and changed something)
  function run(command) {
    if (!store.map) return false;
    if (store.grouping) { ui.toast(BUSY, 'warn'); return false; }
    try {
      const change = store.exec(command);
      return change.props.length > 0 || GROUPED.some((kind) => change.updated[COLLECTION[kind]].length || change.removed[COLLECTION[kind]].length);
    } catch (err) {
      console.error('[editor] layers: the edit failed', err);
      ui.toast(`That could not be done: ${err?.message ?? err}`, 'error');
      return false;
    }
  }

  // ---- the active layer

  function setActive(name) {
    if (name !== null && closed(name)) { ui.toast(`Layer ${closed(name)}: ${name}. ${closed(name) === 'hidden' ? 'Show' : 'Unlock'} it to work on it`, 'warn'); return; }
    ui.set('activeLayer', name);
    ui.setNote(name === null ? 'No active layer: new items go onto no layer' : `Active layer: ${name}. What you place now goes onto it`);
  }

  // ---- eye and lock

  // What a layer hides cannot stay selected - it would be moved and deleted unseen.
  function dropHidden() {
    if (store.selection.size) store.select([...store.selection].filter((item) => !ui.layerHidden(item)));
  }
  function toggle(name, key) {
    const wasActive = ui.activeLayer === name;
    ui.setLayerState(name, { [key]: !ui.layerState(name)[key] });
    dropHidden();
    if (wasActive && ui.activeLayer === null) ui.setNote(`${name} is ${closed(name)}: it is no longer the active layer, new items go onto no layer`);
  }
  // Alt+click on an eye: this layer alone among the map's own; again (when it already is alone): all of them.
  // What is on no layer is always shown: the fixed layers above switch that.
  function solo(name) {
    const names = layersOf(), alone = names.every((other) => ui.layerState(other).visible === (other === name));
    for (const other of names) ui.setLayerState(other, { visible: alone || other === name });
    dropHidden();
  }

  // ---- a name that is being typed: a new layer, or another name for one

  // The field of a name. finish(text | null): null when Escape ended it, else what was typed, trimmed.
  function nameField(value, finish) {
    const input = h('input', {
      type: 'text', class: 'ui-input name-edit', value, maxLength: LIMITS.layerName[1], autocomplete: 'off', spellcheck: false,
      placeholder: 'Layer name', 'aria-label': 'Layer name', title: keyText(`1 to ${LIMITS.layerName[1]} characters. Enter: done · Esc: cancel`),
    });
    let over = false, cancelled = false;
    const end = () => {
      if (over) return;
      over = true;
      finish(cancelled ? null : input.value.trim());
    };
    input.addEventListener(CANCEL_EVENT, () => { cancelled = true; });   // Escape: the commit that follows is no commit
    input.addEventListener(COMMIT_EVENT, end);
    input.addEventListener('blur', end);
    return input;
  }

  function startNaming(what) {
    if (!store.map) return;
    if (store.grouping) { ui.toast(BUSY, 'warn'); return; }
    if (what.add && layersOf().length >= LIMITS.layers) { ui.toast(`A map has ${LIMITS.layers} layers at most`, 'warn'); return; }
    if (what.rename !== undefined && !layersOf().includes(what.rename)) return;
    leaveField();                      // a name that was being typed elsewhere is finished first
    naming = { ...what, input: null };
    if (el.parentElement) el.parentElement.open = true;   // the panel may be folded away: F2 opens it
    mine.el.open = true;
    drawMine();
    naming?.input?.focus();
    naming?.input?.select();
  }

  function endNaming(text) {
    const what = naming;
    naming = null;
    if (what && text) {
      const from = what.rename ?? null, bad = text === from ? null : layerProblem(layersOf(), text, from);
      if (bad) ui.toast(`The layer name ${bad}`, 'warn');
      else if (what.add) {
        if (run(cmd.addLayer(text))) {
          ui.set('activeLayer', text);   // a layer is added to be worked on
          ui.setNote(`Layer ${text} added. It is the active layer: what you place now goes onto it`);
        }
      } else if (text !== from && run(cmd.renameLayer(from, text))) {
        if (menuFor === from) menuFor = text;
        ui.setNote(`Renamed the layer ${from} to ${text}`);
      }
    }
    drawMine();
  }

  // ---- what a row's actions do

  // "Move selection here": everything selected that may be edited and can be on a layer - one undo step.
  function moveHere(name) {
    if (closed(name)) { ui.toast(`Layer ${closed(name)}: ${name}`, 'warn'); return; }
    const items = [...store.selection].filter((item) => {
      const kind = store.kindOf(item);
      return GROUPED.includes(kind) && ui.isPickable(kind, item);
    });
    if (!items.length) {
      ui.toast(store.selection.size ? 'Nothing of the selection can be moved: regions and the start point are on no layer, and locked items stay' : 'Select objects, spawns, chests or NPCs first', 'warn');
      return;
    }
    const moved = items.filter((item) => item.l !== name).length;
    if (!moved) { ui.setNote(`The selection is on the layer ${name} already`); return; }
    if (run(cmd.set(items, { l: name }))) ui.toast(`Moved ${plural(moved, 'item')} to the layer ${name}`);
  }

  function selectLayer(name, add) {
    const all = onLayer(name), items = all.filter((item) => ui.isPickable(store.kindOf(item), item));
    if (!items.length) {
      ui.toast(!all.length ? `Nothing is on the layer ${name} yet` : closed(name) ? `Layer ${closed(name)}: ${name}` : 'Every item of this layer is hidden or locked', 'warn');
      return;
    }
    store.select(items, { add });
    ui.setNote(items.length === all.length ? `Selected the layer ${name}: ${plural(items.length, 'item')}`
      : `Selected ${int(items.length)} of ${int(all.length)} items of the layer ${name}: the rest is hidden or locked`);
  }

  // Delete: an empty layer goes at once. One that holds items asks - by default they STAY on the map, on no layer;
  // deleting them with it is the second answer, offered only for what may be edited.
  async function deleteLayer(name) {
    if (!store.map || !layersOf().includes(name)) return;
    if (store.grouping) { ui.toast(BUSY, 'warn'); return; }
    const all = onLayer(name);
    let answer = 'keep';
    if (all.length) {
      // the fixed layers and the layer's own lock decide what may be deleted with it; its own eye does not
      const free = ui.layerState(name).locked ? [] : all.filter((item) => {
        const fixed = ui.layers[LAYER_OF[store.kindOf(item)]];
        return fixed && fixed.visible && !fixed.locked;
      });
      const options = [{ id: 'keep', label: 'Delete the layer, keep its items' }];
      if (free.length) options.unshift({ id: 'all', label: `Delete the layer and ${free.length === all.length ? 'its' : `${int(free.length)} of its`} ${plural(all.length, 'item')}`, danger: true });
      const rest = free.length === all.length ? '' : ui.layerState(name).locked ? '\nThe layer is locked: its items can only be kept.'
        : free.length ? `\n${plural(all.length - free.length, 'item')} on a hidden or locked layer above cannot be deleted.` : '\nIts items are on hidden or locked layers above: they can only be kept.';
      answer = await ui.choose(`The layer ${quoted(name)} holds ${plural(all.length, 'item')}.\nKept items stay on the map, on no layer.${rest}`, options);
      if (answer === null || !store.map || !layersOf().includes(name)) return;   // cancelled, or another map by now
      if (answer === 'all') {
        if (run(cmd.batch(`Delete the layer ${name} and ${plural(free.length, 'item')}`, [cmd.remove(free), cmd.removeLayer(name)]))) {
          ui.toast(`Deleted the layer ${name} and ${plural(free.length, 'item')}`);
        }
        return;
      }
    }
    if (run(cmd.removeLayer(name))) {
      ui.toast(all.length ? `Deleted the layer ${name}: ${plural(all.length, 'item')} ${all.length === 1 ? 'is' : 'are'} on no layer now` : `Deleted the layer ${name}`);
    }
  }

  function actionsOf(name, n) {
    const flat = (node) => { node.classList.add('flat'); return node; };
    const move = flat(button('Move selection here', () => moveHere(name), { title: `Put the selected objects, spawns, chests and NPCs onto ${quoted(name)} (one undo step)` }));
    const pick = flat(button('Select items', (ev) => selectLayer(name, ev.shiftKey), { title: keyText(`Select everything on ${quoted(name)} (Shift+click: add it to the selection)`), disabled: n === 0 }));
    const rename = flat(button('Rename', () => startNaming({ rename: name }), { title: keyText('Give the layer another name (also: double-click its name, or F2 for the active layer)') }));
    const del = flat(button('Delete', () => { deleteLayer(name).catch((err) => console.error('[editor] layers: delete failed', err)); },
      { title: n ? `Delete the layer ${quoted(name)}: you are asked what becomes of its ${plural(n, 'item')}` : `Delete the empty layer ${quoted(name)}`, danger: true }));
    return h('div', { class: 'actions', dataset: { actions: name } }, move, pick, rename, del);
  }

  // ---- drawing

  function drawMine() {
    // the row under the pointer must stay the same element, and a name that is being typed must keep the keyboard
    if (press?.dragging || (naming?.input && document.activeElement === naming.input)) { mineStale = true; return; }
    mineStale = false;
    const names = layersOf();
    mine.title.textContent = `My layers (${int(names.length)})`;
    addButton.disabled = !store.map;
    if (menuFor !== null && !names.includes(menuFor)) menuFor = null;
    if (naming?.rename !== undefined && !names.includes(naming.rename)) naming = null;

    const nodes = [];
    for (const name of names) {
      const state = ui.layerState(name), c = layerCounts.get(name), n = c?.n ?? 0;
      const eye = iconButton('eye', (ev) => { if (ev.altKey) solo(name); else toggle(name, 'visible'); });
      if (!state.visible) eye.classList.add('off');
      eye.setAttribute('aria-pressed', String(state.visible));
      eye.title = `${state.visible ? 'Hide' : 'Show'} ${name} (${keyText('Alt+click: this layer alone')})`;
      const lock = iconButton('lock', () => toggle(name, 'locked'));
      if (!state.locked) lock.classList.add('off');
      lock.setAttribute('aria-pressed', String(state.locked));
      lock.title = state.locked ? `Unlock ${name}` : `Lock ${name}: it stays visible but cannot be picked or edited`;
      let label;
      if (naming?.rename === name) label = naming.input = nameField(name, endNaming);
      else label = h('span', { class: 'name' }, name);
      const more = button('⋯', () => { menuFor = menuFor === name ? null : name; drawMine(); }, { title: `Actions of ${quoted(name)}: move the selection here, select its items, rename, delete` });
      more.classList.add('flat', 'more');
      if (menuFor === name) more.classList.add('active');
      more.setAttribute('aria-expanded', String(menuFor === name));
      const parts = GROUPED.filter((kind) => c?.[kind]).map((kind) => plural(c[kind], NOUN[kind]));
      nodes.push(h('div', {
        class: ['layer', 'own', !state.visible && 'hidden', state.locked && 'locked'], dataset: { own: name },
        title: `${name}\n${keyText('Click: make it the active layer (again: none) · double-click: rename · drag: reorder')}`,
      }, eye, lock, h('span', { class: 'mark' }), label,
      h('span', { class: 'count', title: parts.join(', ') || 'Nothing is on this layer yet' }, int(n)), more));
      if (menuFor === name) nodes.push(actionsOf(name, n));
    }
    if (naming?.add) nodes.push(h('div', { class: 'layer own adding' }, naming.input = nameField('', endNaming)));
    if (!names.length && !naming) {
      nodes.push(h('div', { class: 'ui-empty' }, !store.map ? 'No map loaded.'
        : 'No layers of your own yet. Add one - Town, Forest, Bandit camp - and what you place goes onto it: its eye hides that part of the map, its lock protects it.'));
    }
    mineHint.hidden = !names.length;
    mineList.replaceChildren(...nodes, drop);
    syncActive();
  }

  // Which row is the active layer. The rows stay the elements they are: the second click of a double-click must find
  // the row the first one was made on.
  function syncActive() {
    const active = ui.activeLayer;
    mine.extra.textContent = active !== null && layersOf().includes(active) ? `new items: ${active}` : '';
    for (const node of rowNodes()) {
      const on = node.dataset.own === active;
      node.classList.toggle('active', on);
      node.querySelector('.mark').title = on ? 'The active layer: new items go onto it' : '';
    }
  }

  // ---- the pointer on a row: click = the active layer, double-click = rename, drag = reorder

  const rowNodes = () => [...mineList.querySelectorAll('.layer.own:not(.adding)')];

  // -> the slot the pointer is over: 0 = above the first row ... n = below the last one
  function slotAt(clientY) {
    const nodes = rowNodes();
    for (let k = 0; k < nodes.length; k++) {
      const r = nodes[k].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return k;
    }
    return nodes.length;
  }

  function endPress() {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onCancel, true);
    const p = press;
    press = null;
    if (!p) return null;
    p.el.classList.remove('dragging');
    mineList.classList.remove('reordering');
    drop.hidden = true;
    return p;
  }

  function onMove(ev) {
    const p = press;
    if (!p || ev.pointerId !== p.id || p.dead) return;
    if (!p.dragging) {
      if (Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < DRAG_PX) return;
      if (store.grouping || layersOf().length < 2) { p.dead = true; return; }   // an edit is open, or there is nowhere to go
      p.dragging = true;
      p.el.classList.add('dragging');
      mineList.classList.add('reordering');
    }
    p.slot = slotAt(ev.clientY);
    const nodes = rowNodes(), last = nodes[nodes.length - 1];
    drop.style.top = `${(p.slot < nodes.length ? nodes[p.slot].offsetTop : last.offsetTop + last.offsetHeight) - 1}px`;
    drop.hidden = false;
  }

  function onUp(ev) {
    if (!press || ev.pointerId !== press.id) return;
    const p = endPress(), from = layersOf().indexOf(p.name);
    if (p.dragging) {
      // a row dropped into the slot below itself stays where it is
      if (from >= 0 && p.slot != null) run(cmd.reorderLayer(p.name, p.slot > from ? p.slot - 1 : p.slot));
    } else if (!p.dead && from >= 0) setActive(ui.activeLayer === p.name ? null : p.name);
    if (mineStale || p.dragging) drawMine();
  }

  function onCancel(ev) {
    if (!press || ev.pointerId !== press.id) return;
    const p = endPress();
    if (mineStale || p.dragging) drawMine();
  }

  mineList.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || press) return;
    const node = ev.target.closest?.('.layer.own');
    if (!node || node.dataset.own === undefined || ev.target.closest('button, input')) return;   // buttons and the name field are their own business
    press = { el: node, name: node.dataset.own, x: ev.clientX, y: ev.clientY, id: ev.pointerId, dragging: false, dead: false, slot: null };
    // on the window: the pointer may leave the list during a drag, and a row that is rebuilt would lose a capture
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
  });
  mineList.addEventListener('dblclick', (ev) => {
    const node = ev.target.closest?.('.layer.own');
    if (!node || node.dataset.own === undefined || ev.target.closest('button, input')) return;
    startNaming({ rename: node.dataset.own });
  });

  // F2 renames the active layer (keymap.js binds the key to this action).
  if (!ctx.actions.has('layer.rename')) {
    ctx.actions.register('layer.rename', () => {
      if (ui.activeLayer === null) ui.setNote('No active layer to rename: click a layer in the Layers panel first');
      else startNaming({ rename: ui.activeLayer });
    });
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
    ui.setNote(`Selected ${plural(items.length, 'object')} of ${id}`);
  }

  // All objects of one model get another: one undo step. A hidden model is replaced like a shown one - this panel is
  // where it was hidden - but a locked or hidden Objects layer is not edited.
  function replaceModel(from, to) {
    if (!store.map || !to || to === from) return;
    if (store.grouping) { ui.toast('Finish the current edit first', 'warn'); return; }
    if (!layerOpen('objects')) { refuse('objects'); return; }
    // ... and neither is what a locked layer of the map's own protects
    const all = objectsOf(from), items = all.filter((obj) => obj.l == null || !ui.layerState(obj.l).locked);
    if (!items.length) { if (all.length) ui.toast('Every object of this model is on a locked layer', 'warn'); return; }
    store.exec(cmd.set(items, { m: to }));
    replacing = null;
    ui.toast(`Replaced the model of ${plural(items.length, 'object')}: ${to}${items.length < all.length ? ` (${int(all.length - items.length)} on a locked layer kept)` : ''}`);
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
        title: n ? `${id}\nClick: select all ${int(n)} · ${keyText('Shift+click: add them to the selection')}` : `${id}\nNo object uses this model any more`,
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
    ui.setNote(items.length === all.length ? `Selected the group ${g}: ${plural(items.length, 'item')}`
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
      const pick = button('Select', (ev) => selectGroup(g, ev.shiftKey), { title: keyText('Select the members of this group (Shift+click: add them)') });
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

  let signature = '', mineSignature = '';
  function recount() {
    const map = store.map, mc = new Map(), gc = new Map(), lc = new Map();
    if (map) {
      for (const obj of map.objects) mc.set(obj.m, (mc.get(obj.m) ?? 0) + 1);
      for (const kind of GROUPED) {
        for (const item of map[COLLECTION[kind]]) {
          if (typeof item.l === 'string') {
            let c = lc.get(item.l);
            if (!c) lc.set(item.l, c = { n: 0, object: 0, spawn: 0, chest: 0, npc: 0 });
            c.n++;
            c[kind]++;
          }
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

    // the map's own layers: their names in order, and what is on each
    const mineNext = JSON.stringify([map?.layers ?? [], [...lc].map(([name, c]) => [name, c.n, c.object, c.spawn, c.chest, c.npc]).sort()]);
    if (mineNext !== mineSignature) {
      mineSignature = mineNext;
      layerCounts = lc;
      drawMine();
    }

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

  el.replaceChildren(h('div', { class: 'layers' }, layerRows.map((row) => row.node)), mine.el, models.el, groups.el);

  store.on('load', () => {
    replacing = null;
    naming = menuFor = null;
    signature = mineSignature = '\u0000';
    recount();
  });
  store.on('change', (change) => {
    // a move, a paint stroke or a region edit changes no count, no model and no group
    const { added, removed, updated } = change;
    const lists = ['objects', 'spawns', 'chests', 'npcs', 'regions'];
    if (lists.some((key) => added[key].length || removed[key].length) || updated.objects.length || updated.spawns.length
      || updated.chests.length || updated.npcs.length || change.props.length) recountSoon();
  });
  ui.on('layers', syncLayers);
  ui.on('customLayers', drawMine);
  ui.on('activeLayer', syncActive);
  ui.on('hiddenModels', drawModels);
  ui.on('models', () => { if (replacing !== null) drawModels(); });   // the palette's choice is the editor's suggestion

  syncLayers();
  drawMine();
  recount();
  return {
    // Every rendered frame: a recount that is waiting for its animation frame is done with this one (a change of the
    // map always asks the viewport for a frame; a throttled window hands out none of its own).
    update() { recountSoon.flush(); },
  };
}
