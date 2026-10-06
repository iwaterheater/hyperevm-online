// The Spawns panel (#spawns): every monster camp of the map in one table.
//
//   - one row per camp: the region that wins at its centre, its monster mix, levels, count, radius, respawn
//   - click a header to sort (again: the other way; a third time: back to map order); the box above filters by region
//     name, monster and level ('meadow', 'mage', 'lv5-9'), the select beside it by one region
//   - click a row to select the camp and bring the camera to it; Shift+click a range, Mod+click to add or take one;
//     the selection is the store's, so the viewport, the inspector and this table always agree
//   - click a VALUE to edit it: a small editor opens beside the row. With several camps selected it edits them all
//     (values that differ show a dash; '+2' and '*1.5' apply to each). A change of the monster mix goes through the
//     field schema's `patch` (typesPatch): a camp that becomes the boss alone takes the boss's respawn in the same step
//   - the footer counts camps and monsters; "Monsters by region" totals them per region, by type, with level ranges
//   - "Populate region" drops N new camps - copies of the Spawn tool's settings - into a region as one undo step
//     (action 'spawn.populate')
//
// The panel never writes the map: every edit is a command run by the store. It keeps no item of an old map across a
// store 'load'.
import { MOB_KEYS, MOB_TYPES, WANDER_R } from '../../shared.js';
import { LIMITS, regionColor } from '../../map/format.js';
import { h, row, section, button, numberField, selectField, rafThrottle, leaveField, safeColor } from '../ui/dom.js';
import { mod, keyText } from '../keymap.js';
import { FIELDS, typesPatch, withEnd } from '../fields.js';
import { editable, describe } from '../tools/common.js';
import {
  campColor, campText, cleanTemplate, filterRows, holdRows, levelText, populate, shortName, sortRows, spawnRows, threatOf, totalsByRegion, typeKeys,
} from '../spawnstats.js';

// [key, header, tooltip] - the columns of the table. Every column but the first is a value that can be edited.
const COLUMNS = [
  ['region', 'Region', 'The region that wins at the centre of the camp. Click a row here to select the camp and frame it'],
  ['types', 'Mix', 'Monster types by weight, in the colours of the map. Click to edit'],
  ['lvl', 'Lv', 'Level range of the monsters. Click to edit'],
  ['count', 'N', 'Monsters in the camp. Click to edit'],
  ['r', 'R', 'Radius of the camp. Click to edit'],
  ['respawn', 'Resp', 'Seconds until a dead monster comes back. Click to edit'],
];
const NUMBERS = {
  count: { label: 'Count', what: 'count', range: LIMITS.spawnCount, step: 1, digits: 0, title: 'How many monsters live in the camp' },
  r: { label: 'Radius', what: 'radius', range: LIMITS.spawnR, step: 0.5, digits: 2, title: 'Monsters appear inside this disc' },
  respawn: { label: 'Respawn (s)', what: 'respawn time', range: LIMITS.spawnRespawn, step: 1, digits: 0, title: 'Seconds after its death a monster comes back' },
};
// the rule every editor of `types` goes through lives in the field schema; the import is only the fallback
const patchTypes = FIELDS.spawn?.find((f) => f.key === 'types')?.patch ?? typesPatch;

const hex = (color) => (typeof color === 'string' ? color : `#${color.toString(16).padStart(6, '0')}`);
const num = (v, digits = 2) => String(Number(v.toFixed(digits)));
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const clamp = (v, [min, max]) => Math.max(min, Math.min(max, v));
const applyRel = (v, { op, n }) => (op === '+' ? v + n : op === '-' ? v - n : v * n);
const sameValue = (a, b) => a === b || (Array.isArray(a) && Array.isArray(b) && a[0] === b[0] && a[1] === b[1]);

export default function mount(el, ctx) {
  const { store, ui, cmd, actions } = ctx;

  let rows = [];                 // spawnRows(map): every camp
  let shown = [];                // the rows the table shows, in its order (filtered, sorted)
  let sort = { key: 'index', dir: 1 };
  const filter = { text: '', region: null };
  let anchor = null;             // the camp a Shift+click extends from
  let card = null;               // the open editor: { pop, items, sync, release }
  let held = null;               // while the editor is open: the spawns of the table in the order it had when it opened
  let fromPanel = false;         // the selection is being changed by a click in this table: do not scroll under the cursor
  let revealSoon = false;        // a camp was selected before its row existed: scroll to it once the table has it
  let entries = new Map();       // spawn -> { tr, cells, sig }: rows are reused while their camp lives
  let listed = { key: null, regions: [] };   // what the two region selects list: they are rebuilt only when that changes
  const pop = { n: 8, spacing: null, keepOut: 6, region: null };     // the Populate form; spacing null = follow the template

  const layerState = () => ui.layers?.spawns ?? null;
  const layerOpen = () => { const s = layerState(); return !s || (s.visible && !s.locked); };
  const pickable = (spawn) => store.kindOf(spawn) === 'spawn' && ui.isPickable('spawn', spawn);
  const regionsTopFirst = () => (store.map ? [...store.map.regions].reverse().concat(store.map.fallback) : []);
  const regionName = (region) => (region === store.map?.fallback ? `${region.name} (fallback)` : region.name);
  // what a new camp copies: the Spawn tool's template; the format's defaults while that tool is a stub
  const toolTemplate = () => cleanTemplate(ctx.tools?.spawn?.template?.() ?? ctx.tools?.spawn?.opts ?? cmd.make('spawn', {}));

  // One undo step with a label of its own. -> false when another edit is open (its group must not swallow ours)
  function step(label, command) {
    if (store.grouping) {
      ui.toast('Finish the current edit first', 'warn');
      return false;
    }
    store.begin(label);
    try {
      store.exec(command);
    } finally {
      store.commit();
    }
    return true;
  }

  // ---------------------------------------------------------------- static DOM

  const search = h('input', {
    type: 'search', class: 'ui-input ui-text search', placeholder: 'Filter: region, monster, lv5-9', autocomplete: 'off', spellcheck: false,
    title: 'Words must all match the region name or a monster of the camp; lv7 or lv5-9 keeps the camps of those levels',
    oninput: () => { filter.text = search.value; renderTable(); },
  });
  search.setAttribute('aria-label', 'Filter the camps');
  const regionPick = selectField({ value: null, options: [], onCommit: (region) => { filter.region = region; renderAll(); } });
  regionPick.el.title = 'Show the camps of one region';
  regionPick.el.classList.add('region-pick');
  const note = h('div', { class: 'note ui-hint', hidden: true });

  const heads = COLUMNS.map(([key, label, title]) => {
    const arrow = h('span', { class: 'arrow' });
    const th = h('th', { class: ['c', 'head', key], title: `${title}. Click the header to sort`, onclick: () => sortBy(key) }, label, arrow);
    return { key, th, arrow };
  });
  const body = h('tbody', { onclick: onRowClick, ondblclick: onRowDouble });
  const wrap = h('div', { class: 'wrap' }, h('table', { class: 'ui-table' }, h('thead', null, h('tr', null, heads.map((x) => x.th))), body));
  const empty = h('div', { class: 'ui-empty', hidden: true });
  const total = h('span', { class: 'total' });
  const picked = h('span', { class: 'picked ui-hint' });
  const selectAll = button('Select all', () => {
    const items = shown.map((r) => r.spawn).filter(pickable);
    if (!items.length) return;
    fromPanel = true;
    try { store.select(items); } finally { fromPanel = false; }
  }, { title: 'Select every camp the table shows' });
  const foot = h('div', { class: 'foot' }, h('div', { class: 'sum' }, total, picked), selectAll);

  const totalsList = h('div', { class: 'totals' });
  const totalsBox = section('Monsters by region', totalsList);

  // ---- Populate
  const popRegion = selectField({ value: null, options: [], onCommit: (region) => { pop.region = region; syncPopulate(); } });
  const popN = numberField({ value: pop.n, min: 1, max: 100, step: 1, onInput: (v) => { pop.n = v; syncPopulate(); } });
  const popSpacing = numberField({ value: 0, min: 0, max: 400, step: 1, onInput: (v) => { pop.spacing = v; syncPopulate(); } });
  const popKeep = numberField({ value: pop.keepOut, min: 0, max: 100, step: 1, onInput: (v) => { pop.keepOut = v; syncPopulate(); } });
  const popWhat = h('div', { class: 'ui-hint what' });
  const popWhy = h('span', { class: 'ui-hint why' });
  const popGo = button('Populate', () => actions.run('spawn.populate'));
  popGo.classList.add('primary');
  const small = (label, field, title) => h('label', { class: 'small', title }, h('span', { class: 'ui-label' }, label), field);
  const populateBox = section('Populate region',
    row('Region', popRegion),
    h('div', { class: 'trio' },
      small('Camps', popN, 'How many new camps to drop into the region'),
      small('Spacing', popSpacing, 'The least distance between the centres of two camps, old or new'),
      small('Keep-out', popKeep, 'How far a camp\'s disc stays from chests, NPCs and the start disc')),
    popWhat,
    h('div', { class: 'go' }, popGo, popWhy));
  populateBox.classList.add('populate');

  const hint = h('div', { class: 'ui-hint help' }, keyText('Click a camp to select and frame it · click a value to edit it · Mod+click adds one, Shift+click a range'));
  const root = h('div', { class: 'root' }, h('div', { class: 'bar' }, search, regionPick), note, wrap, empty, foot, totalsBox, populateBox, hint);
  el.replaceChildren(root);

  // ---------------------------------------------------------------- the table

  function makeEntry() {
    const cells = {};
    const tr = h('tr', { class: 'row' });
    for (const [key] of COLUMNS) tr.append(cells[key] = h('td', { class: ['c', key, key !== 'region' && 'edit'], dataset: { key } }));
    cells.chip = h('span', { class: 'chip' });
    cells.name = h('span', { class: 'name' });
    cells.region.append(cells.chip, cells.name);
    return { tr, cells, sig: '' };
  }

  // Writes a row's cells - only when what it shows has changed since the last time.
  function fillEntry(entry, r, byLevel) {
    const { spawn } = r, colour = hex(campColor(spawn, byLevel)), keys = typeKeys(spawn.types);
    const sig = [r.region?.name, colour, keys.map((k) => `${k}${spawn.types[k]}`).join(','), spawn.lvl[0], spawn.lvl[1], spawn.count, spawn.r, spawn.respawn, spawn.x, spawn.z, r.index].join('|');
    if (sig === entry.sig) return;
    entry.sig = sig;
    const c = entry.cells;
    c.chip.style.background = colour;
    c.name.textContent = r.region?.name ?? '';
    c.region.title = `Camp ${r.index + 1}: ${campText(spawn)}\n${r.region?.name ?? ''} · at ${num(spawn.x)}, ${num(spawn.z)} · radius ${num(spawn.r)} · threat radius ${num(threatOf(spawn))}`;
    c.types.replaceChildren(...(keys.length
      ? keys.map((key) => h('span', { class: 'w', style: { color: hex(MOB_TYPES[key].color) } }, String(spawn.types[key])))
      : [h('span', { class: 'ui-dim' }, '—')]));
    c.types.title = `${keys.map((key) => `${MOB_TYPES[key].name} ${spawn.types[key]}`).join(' : ') || 'No monsters'} - click to edit`;
    c.lvl.textContent = spawn.lvl[0] === spawn.lvl[1] ? String(spawn.lvl[0]) : `${spawn.lvl[0]}–${spawn.lvl[1]}`;
    c.count.textContent = String(spawn.count);
    c.r.textContent = num(spawn.r, 1);
    c.respawn.textContent = String(spawn.respawn);
  }

  function renderTable() {
    const map = store.map;
    const sorted = map ? sortRows(filterRows(rows, filter), sort.key, sort.dir) : [];
    // While a value is being edited the rows stand still: the map follows every key, and a table sorted by that very
    // column would move the row - and close the editor - between the first digit and the second.
    shown = card && held ? holdRows(rows, sorted, held, card.items) : sorted;
    const byLevel = !!ui.overlays?.levelColors, next = new Map(), sel = store.selection, open = layerOpen();
    const editing = card ? new Set(card.items) : null;
    for (const r of shown) {
      const entry = entries.get(r.spawn) ?? makeEntry();
      fillEntry(entry, r, byLevel);
      entry.tr.classList.toggle('selected', sel.has(r.spawn));
      entry.tr.classList.toggle('editing', !!editing?.has(r.spawn));
      next.set(r.spawn, entry);
    }
    // rows of camps that are filtered out keep their elements too: a filter typed letter by letter must not rebuild them
    for (const [spawn, entry] of entries) if (!next.has(spawn) && store.kindOf(spawn) === 'spawn') next.set(spawn, entry);
    entries = next;
    const trs = shown.map((r) => entries.get(r.spawn).tr);
    // the same rows in the same order: nothing to move (the usual case while a camp is dragged or typed into)
    if (trs.length !== body.children.length || trs.some((tr, i) => body.children[i] !== tr)) body.replaceChildren(...trs);

    for (const head of heads) {
      const on = sort.key === head.key;
      head.th.classList.toggle('sorted', on);
      head.arrow.textContent = on ? (sort.dir > 0 ? '▲' : '▼') : '';
      head.th.setAttribute('aria-sort', on ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none');
    }
    root.classList.toggle('locked', !open);
    wrap.hidden = shown.length === 0;
    renderEmpty();
    renderFoot();
  }

  function renderEmpty() {
    empty.hidden = shown.length > 0;
    if (shown.length > 0) return;
    if (!store.map) { empty.replaceChildren('No map is loaded.'); return; }
    if (!rows.length) {
      empty.replaceChildren('No monster camps yet. Take the Spawn tool and click on the map, or populate a region below. ',
        button('Spawn tool', () => actions.run('tool.spawn'), { title: 'Switch to the Spawn tool', disabled: !layerOpen() }));
      return;
    }
    empty.replaceChildren('No camp matches the filter. ', button('Clear the filter', clearFilter));
  }

  function clearFilter() {
    filter.text = '';
    filter.region = null;
    search.value = '';
    regionPick.set(null);
    renderAll();
  }

  function renderFoot() {
    const monsters = (list) => list.reduce((n, r) => n + r.count, 0);
    const all = monsters(rows), part = monsters(shown), filtered = shown.length !== rows.length;
    total.textContent = filtered
      ? `${shown.length} of ${plural(rows.length, 'camp')} · ${part.toLocaleString('en-US')} of ${plural(all, 'monster')}`
      : `${plural(rows.length, 'camp')} · ${plural(all, 'monster')}`;
    total.dataset.camps = String(rows.length);
    total.dataset.monsters = String(all);
    const over = rows.length > LIMITS.spawns || all > LIMITS.monsters, heavy = !over && all > LIMITS.monstersWarn;
    total.classList.toggle('over', over);
    total.classList.toggle('heavy', heavy);
    total.title = over ? `Over the limit of ${LIMITS.spawns} camps or ${LIMITS.monsters.toLocaleString('en-US')} monsters: the map cannot be saved`
      : heavy ? `More than ${LIMITS.monstersWarn} monsters is heavy for the server` : 'Every camp of the map and the monsters they hold';
    const chosen = store.selected('spawn');
    picked.textContent = chosen.length ? `${chosen.length} selected · ${plural(chosen.reduce((n, s) => n + s.count, 0), 'monster')}` : '';
    selectAll.textContent = filtered ? `Select these ${shown.length}` : 'Select all';
    selectAll.disabled = !shown.length || !layerOpen();
  }

  // ---------------------------------------------------------------- totals and region lists

  function renderTotals() {
    const map = store.map;
    if (!map) { totalsList.replaceChildren(); return; }
    const byRegion = new Map(totalsByRegion(map).map((t) => [t.region, t]));
    totalsList.replaceChildren(...regionsTopFirst().map((region) => {
      const t = byRegion.get(region), none = !t || t.camps === 0;
      const kinds = none ? [] : Object.keys(t.byType).map((key) => h('span', { class: 'kind', title: `About ${num(t.byType[key], 1)} ${MOB_TYPES[key].name}` },
        h('span', { class: 'dot', style: { background: hex(MOB_TYPES[key].color) } }), `${num(t.byType[key], 1)} ${shortName(key)}`));
      const line = h('div', {
        class: ['zone', none && 'none', filter.region === region && 'on'],
        title: none ? `${regionName(region)}: no camps` : `${regionName(region)}: click to show only its camps`,
        onclick: () => {
          filter.region = filter.region === region ? null : region;
          regionPick.set(filter.region);
          renderAll();
        },
      },
        h('div', { class: 'zone-line' },
          h('span', { class: 'ui-swatch', style: { background: safeColor(regionColor(map, region)) } }),   // from the file: never a raw CSS value
          h('span', { class: 'zone-name' }, regionName(region)),
          region.safe ? h('span', { class: 'ui-badge ok' }, 'safe') : null,
          h('span', { class: 'zone-n' }, none ? '—' : `${plural(t.camps, 'camp')} · ${t.monsters}`),
          h('span', { class: 'zone-lv' }, none || !t.lvl ? '' : levelText(t.lvl))),
        kinds.length ? h('div', { class: 'zone-kinds' }, kinds) : null);
      return line;
    }));
  }

  function syncRegionLists() {
    const regions = regionsTopFirst();
    if (filter.region && !regions.includes(filter.region)) filter.region = null;
    if (!pop.region || !regions.includes(pop.region)) pop.region = regions.find((region) => !region.safe) ?? null;
    // A drag in the viewport brings a change per pointer move: the option lists are rebuilt only when the regions,
    // their order, a name or a safe flag changed (an open drop-down would close under the cursor otherwise).
    const key = regions.map((region) => `${region.name}:${region.safe ? 1 : 0}`).join('\n');
    if (key !== listed.key || regions.length !== listed.regions.length || regions.some((region, i) => region !== listed.regions[i])) {
      listed = { key, regions };
      regionPick.setOptions([{ value: null, label: 'All regions' }, ...regions.map((region) => ({ value: region, label: regionName(region) }))]);
      popRegion.setOptions(regions.map((region) => ({ value: region, label: region.safe ? `${regionName(region)} (safe)` : regionName(region) })));
    }
    if (regionPick.value !== filter.region) regionPick.set(filter.region);
    if (popRegion.value !== pop.region) popRegion.set(pop.region);
  }

  // ---------------------------------------------------------------- populate

  const spacingNow = () => pop.spacing ?? Math.round(2 * (toolTemplate().r + WANDER_R));     // discs and strolling margins apart

  // Why Populate cannot run right now - or null.
  function populateBlock() {
    const map = store.map, state = layerState();
    if (!map) return 'No map is loaded';
    if (state && !state.visible) return 'The Spawns layer is hidden';
    if (state && state.locked) return 'The Spawns layer is locked';
    if (!pop.region) return 'The map has no region to populate';
    if (pop.region.safe) return 'Monsters cannot spawn in a safe region';
    if (map.spawns.length >= LIMITS.spawns) return `The map already has ${LIMITS.spawns} camps: the limit`;
    return null;
  }

  function syncPopulate() {
    const t = toolTemplate(), why = populateBlock();
    popSpacing.set(spacingNow());
    popWhat.textContent = `Each camp: ${campText(t)} · radius ${num(t.r)}`;
    popWhat.title = 'New camps copy the settings of the Spawn tool: change them in its options strip';
    popWhy.textContent = why ?? '';
    popGo.disabled = !!why;
    popGo.title = why ?? `Drop ${plural(pop.n, 'camp')} into ${pop.region ? regionName(pop.region) : 'the region'} - one undo step`;
  }

  // The action 'spawn.populate'. region: a region of the map, map.fallback, or nothing for the one chosen in the form.
  // given: { n, spacing, keepOut, template, rnd } overrides the form (scripts, tests).
  function runPopulate(region = null, given = {}) {
    const map = store.map;
    if (!map) return;
    if (region && (map.regions.includes(region) || region === map.fallback)) {
      pop.region = region;
      popRegion.set(region);
      syncPopulate();
    }
    const why = populateBlock();
    if (why) { ui.toast(why, 'warn'); return; }
    if (store.grouping) { ui.toast('Finish the current edit first', 'warn'); return; }
    const target = pop.region, name = regionName(target);
    const n = Number.isFinite(given.n) ? given.n : pop.n;
    const camps = populate(map, target, {
      n, spacing: Number.isFinite(given.spacing) ? given.spacing : spacingNow(),
      keepOut: Number.isFinite(given.keepOut) ? given.keepOut : pop.keepOut,
      template: given.template ?? toolTemplate(), rnd: typeof given.rnd === 'function' ? given.rnd : Math.random,
    });
    if (!camps.length) {
      ui.toast(`No room for a camp in ${name}: lower the spacing or the keep-out`, 'warn');
      return;
    }
    store.begin(`Populate ${name}`);
    try {
      store.exec(cmd.add('spawn', camps));
      store.select(camps);
    } finally {
      store.commit();
    }
    const monsters = camps.reduce((sum, s) => sum + s.count, 0);
    const wanted = Math.floor(n);
    ui.toast(camps.length < wanted
      ? `Populated ${name}: only ${camps.length} of ${plural(wanted, 'camp')} fit (${plural(monsters, 'monster')})`
      : `Populated ${name}: ${plural(camps.length, 'camp')}, ${plural(monsters, 'monster')}`);
    ctx.viewport?.focus?.(camps);
  }
  if (!actions.has('spawn.populate')) actions.register('spawn.populate', runPopulate, { enabled: () => !!store.map && !store.grouping });

  // ---------------------------------------------------------------- selection

  function markSelection() {
    const sel = store.selection;
    for (const [spawn, entry] of entries) entry.tr.classList.toggle('selected', sel.has(spawn));
  }

  // Scrolls the table - and only the table - so that the first selected camp is in view.
  function reveal() {
    const first = shown.find((r) => store.selection.has(r.spawn)), tr = first && entries.get(first.spawn)?.tr;
    revealSoon = !!store.selected('spawn').length && !tr;
    if (!tr || !tr.isConnected || wrap.hidden) return;
    const headH = heads[0].th.offsetHeight, top = tr.offsetTop - headH, bottom = tr.offsetTop + tr.offsetHeight;
    if (top < wrap.scrollTop) wrap.scrollTop = top;
    else if (bottom > wrap.scrollTop + wrap.clientHeight) wrap.scrollTop = bottom - wrap.clientHeight;
  }

  const spawnOf = (tr) => { for (const [spawn, entry] of entries) if (entry.tr === tr) return spawn; return null; };

  function onRowClick(ev) {
    const tr = ev.target.closest?.('.row'), spawn = tr && spawnOf(tr);
    if (!spawn || store.kindOf(spawn) !== 'spawn') return;
    const key = ev.target.closest('.c')?.dataset.key ?? 'region';
    const many = mod(ev), range = ev.shiftKey, value = key !== 'region' && !many && !range;
    fromPanel = true;
    try {
      if (!pickable(spawn)) {
        ctx.viewport?.focus?.([spawn]);      // a locked camp can still be looked at
        return;
      }
      if (range && anchor && anchor !== spawn && shown.some((r) => r.spawn === anchor)) {
        const a = shown.findIndex((r) => r.spawn === anchor), b = shown.findIndex((r) => r.spawn === spawn);
        store.select(shown.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.spawn).filter(pickable), { add: many });
      } else if (many) {
        store.select([spawn], { toggle: true });
        anchor = spawn;
      } else {
        // a click on a value of a camp that is already selected keeps the selection: the edit goes to all of it
        if (!(value && store.selection.has(spawn))) store.select([spawn]);
        anchor = spawn;
      }
    } finally { fromPanel = false; }
    if (value) openCard(spawn, key, tr);
    else if (!many && !range) ctx.viewport?.focus?.([spawn]);
  }

  function onRowDouble(ev) {
    const tr = ev.target.closest?.('.row'), spawn = tr && spawnOf(tr);
    if (spawn && store.kindOf(spawn) === 'spawn') ctx.viewport?.focus?.([spawn]);
  }

  function sortBy(key) {
    closeCard();       // the order is asked for anew: nothing holds the rows any more
    if (sort.key !== key) sort = { key, dir: 1 };
    else if (sort.dir > 0) sort = { key, dir: -1 };
    else sort = { key: 'index', dir: 1 };      // the third click: back to map order
    renderTable();
  }

  // ---------------------------------------------------------------- the editor beside a row

  function closeCard() {
    const c = card;
    if (!c) return;
    card = null;
    held = null;
    if (c.pop.contains(document.activeElement)) leaveField();      // what is being typed is committed, not lost
    c.release();
    try { if (c.pop.matches(':popover-open')) c.pop.hidePopover(); } catch { /* a browser without popovers: it is a plain box */ }
    c.pop.remove();
    for (const entry of entries.values()) entry.tr.classList.remove('editing');
    refresh();         // the rows were held in place while it was open: now the table sorts and filters again
  }

  // Beside the panel, level with the row: the table stays readable while its values are edited.
  // -> false when the row is not on screen any more (scrolled out of the table, filtered away, the section folded)
  function placeCard(box, tr) {
    const a = tr.getBoundingClientRect(), view = wrap.getBoundingClientRect();
    if (!tr.isConnected || (a.width === 0 && a.height === 0) || a.bottom <= view.top || a.top >= view.bottom) return false;
    const p = el.getBoundingClientRect(), w = box.offsetWidth, tall = box.offsetHeight;
    let left = p.left - w - 8;
    if (left < 8) left = Math.max(8, Math.min(window.innerWidth - w - 8, p.left));
    const top = Math.max(8, Math.min(window.innerHeight - tall - 8, a.top - 10));
    const x = `${Math.round(left)}px`, y = `${Math.round(top)}px`;
    if (box.style.left !== x || box.style.top !== y) Object.assign(box.style, { left: x, top: y, right: 'auto', bottom: 'auto' });
    return true;
  }

  // Opens the editor for `spawn` - or for every selected camp when it is one of them - with the field of column `key`
  // ready to type into.
  function openCard(spawn, key, tr) {
    const order = shown.map((r) => r.spawn);      // from one value to the next the rows stay as they are, too
    closeCard();
    const chosen = store.selection.has(spawn) ? editable(ctx, store.selected('spawn')) : [];
    const items = chosen.includes(spawn) ? chosen : editable(ctx, [spawn]);
    if (!items.length) return;
    const one = items.length === 1;
    const subs = [];

    const title = h('div', { class: 'title' });
    const sub = h('div', { class: 'ui-hint sub' });

    // ---- the mix: one weight per monster type, 0 = absent
    const setTypes = (label, next) => {
      const targets = [], patches = [];
      let emptied = 0;
      for (const item of items) {
        const types = next(item);
        if (!types) continue;
        if (!typeKeys(types).length) { emptied++; continue; }
        targets.push(item);
        patches.push(patchTypes(item, types));
      }
      if (emptied) ui.toast('A camp needs at least one monster type', 'warn');
      if (targets.length) step(label, cmd.setEach(targets, patches));
      sync();
    };
    const weights = MOB_KEYS.map((type) => {
      const field = numberField({
        value: 0, min: 0, max: LIMITS.spawnWeight[1], step: 1,
        onCommit: (v, { relative } = {}) => setTypes(`Change the monsters of ${describe(ctx, items)}`, (item) => {
          const w = relative ? clamp(Math.round(applyRel(item.types[type] ?? 0, relative)), [0, LIMITS.spawnWeight[1]]) : v;
          return Number.isFinite(w) ? { ...item.types, [type]: w } : null;
        }),
      });
      const share = h('span', { class: 'share' });
      const only = button('only', () => setTypes(`Make ${describe(ctx, items)} ${MOB_TYPES[type].name} only`, () => ({ [type]: 1 })),
        { title: `A camp of ${MOB_TYPES[type].name} alone` });
      only.classList.add('flat', 'only');
      const line = row([h('span', { class: 'ui-swatch', style: { background: hex(MOB_TYPES[type].color) } }), MOB_TYPES[type].name], field, share, only);
      line.classList.add('weight');
      line.title = `${MOB_TYPES[type].name}: its weight in the mix (0 = none)`;
      return { type, field, share, line };
    });

    // ---- levels: the two ends are edited one by one, so that camps with different ranges keep what was not typed
    const setLevel = (end) => (v, { relative } = {}) => {
      const patches = items.map((item) => {
        const next = relative ? clamp(Math.round(applyRel(item.lvl[end], relative)), LIMITS.level) : v;
        return Number.isFinite(next) ? { lvl: withEnd(item.lvl, end, next) } : {};      // the pair stays ordered
      });
      step(`Change the levels of ${describe(ctx, items)}`, cmd.setEach(items, patches));
      sync();
    };
    const lo = numberField({ value: 1, min: LIMITS.level[0], max: LIMITS.level[1], step: 1, onCommit: setLevel(0) });
    const hi = numberField({ value: 1, min: LIMITS.level[0], max: LIMITS.level[1], step: 1, onCommit: setLevel(1) });
    const lvlRow = row('Level', h('span', { class: 'ui-field ui-pair' }, lo.el, h('span', { class: 'ui-dash' }, '–'), hi.el));
    lvlRow.title = 'Every monster of the camp gets a level from this range';

    // ---- count, radius, respawn: the map follows while a number is typed or stepped; Enter or blur makes it one step
    const numbers = Object.keys(NUMBERS).map((name) => {
      const def = NUMBERS[name], pow = 10 ** def.digits;
      const fit = (v) => Math.round(clamp(v, def.range) * pow) / pow;
      let open = false, base = null;
      const begin = () => {
        if (open) return true;
        if (store.grouping) return false;
        base = items.map((item) => item[name]);
        store.begin(`Set the ${def.what} of ${describe(ctx, items)}`);
        open = true;
        return true;
      };
      const field = numberField({
        value: 0, min: def.range[0], max: def.range[1], step: def.step, digits: def.digits,
        onInput: (v) => { if (begin()) store.exec(cmd.set(items, { [name]: v })); },
        onCommit: (v, { relative } = {}) => {
          // a relative entry means each camp's own value: the field only knew the one it showed
          if (relative && (!one || Number.isNaN(v)) && begin()) store.exec(cmd.setEach(items, base.map((b) => ({ [name]: fit(applyRel(b, relative)) }))));
          if (open) {
            open = false;
            base = null;
            store.commit();
          } else ui.toast('Finish the current edit first', 'warn');
          sync();
        },
      });
      const line = row(def.label, field);
      line.title = def.title;
      return { name, field, line, reset: () => { open = false; base = null; } };
    });

    // What the fields show: the value all camps share, or a dash where they differ.
    function sync() {
      const live = items.filter((item) => store.kindOf(item) === 'spawn');
      if (live.length !== items.length || !items.every(pickable)) { closeCard(); return; }
      const shared = (get) => {
        const v = get(items[0]);
        return items.every((item) => sameValue(get(item), v)) ? [v, false] : [null, true];
      };
      for (const w of weights) {
        w.field.set(...shared((item) => item.types[w.type] ?? 0));
        const sum = one ? typeKeys(items[0].types).reduce((n, k) => n + items[0].types[k], 0) : 0, mine = one ? items[0].types[w.type] ?? 0 : 0;
        w.share.textContent = one && mine > 0 && sum > 0 ? `${Math.round(mine * 100 / sum)}%` : '';
      }
      lo.set(...shared((item) => item.lvl[0]));
      hi.set(...shared((item) => item.lvl[1]));
      for (const n of numbers) n.field.set(...shared((item) => item[n.name]));
      if (one) {
        const r = rows.find((x) => x.spawn === items[0]);
        title.textContent = `Camp ${store.indexOf(items[0]) + 1}${r?.region ? ` · ${r.region.name}` : ''}`;
        sub.textContent = `${campText(items[0])} · threat radius ${num(threatOf(items[0]))}`;
      } else {
        title.textContent = `${items.length} camps`;
        sub.textContent = `${plural(items.reduce((n, item) => n + item.count, 0), 'monster')} · a dash: the camps differ · what you type goes to all of them (+2 and *1.5 to each)`;
      }
    }

    const close = button('×', closeCard, { title: 'Close (Esc)' });
    close.classList.add('flat', 'icon', 'close');
    const box = h('div', { class: 'ui-popover card' },
      h('div', { class: 'top' }, title, close), sub,
      weights.map((w) => w.line), lvlRow, numbers.map((n) => n.line));
    const popover = typeof box.showPopover === 'function';
    if (popover) box.setAttribute('popover', 'auto');     // the top layer: never clipped by the column, closed by Esc or a click elsewhere
    else box.classList.add('inline');
    box.addEventListener('toggle', (ev) => { if (ev.newState === 'closed' && card?.pop === box) closeCard(); });

    card = { pop: box, items, sync, release: () => { for (const off of subs) off(); for (const n of numbers) n.reset(); } };
    held = order;
    if (popover) {
      el.append(box);
      try { box.showPopover(); } catch { /* shown as a plain box */ }
    } else root.insertBefore(box, wrap);
    sync();
    if (card?.pop !== box) return;      // sync() found nothing left to edit
    if (popover) {
      // A floating box does not travel with its row by itself - and the row does travel: the table scrolls, and the
      // sections above this panel change their height with the selection. So the box follows the row frame by frame
      // while it is open (one rectangle read per frame), and closes when the row leaves the table's window.
      let frame = 0;
      const follow = () => {
        if (card?.pop !== box) return;
        if (!placeCard(box, tr)) { closeCard(); return; }
        frame = requestAnimationFrame(follow);
      };
      placeCard(box, tr);               // now that it has its texts: its height decides where it fits
      frame = requestAnimationFrame(follow);
      subs.push(() => cancelAnimationFrame(frame));
    }
    for (const item of items) entries.get(item)?.tr.classList.add('editing');
    const first = key === 'types' ? weights.find((w) => (spawn.types[w.type] ?? 0) > 0)?.field ?? weights[0].field
      : key === 'lvl' ? lo : numbers.find((n) => n.name === key)?.field;
    first?.focus();
    first?.input?.select?.();
  }

  // ---------------------------------------------------------------- everything

  function renderAll() {
    rows = store.map ? spawnRows(store.map) : [];
    const state = layerState();
    note.hidden = !state || (state.visible && !state.locked);
    note.textContent = !state ? '' : !state.visible ? 'The Spawns layer is hidden: its camps are not drawn and cannot be edited.'
      : state.locked ? 'The Spawns layer is locked: the table can be read, not edited.' : '';
    syncRegionLists();
    renderTable();
    renderTotals();
    syncPopulate();
    card?.sync();
    if (revealSoon) reveal();
  }
  // At most once per frame, however many commands a drag or a typed number brings.
  const refresh = rafThrottle(renderAll);

  store.on('load', () => {
    // another map object: nothing of the old one is kept
    closeCard();
    entries = new Map();
    anchor = null;
    filter.region = null;
    pop.region = null;
    refresh.cancel();
    renderAll();
    wrap.scrollTop = 0;
  });
  store.on('change', (change) => {
    const lists = (part) => part.spawns.length || part.regions.length;
    if (lists(change.added) || lists(change.removed) || lists(change.updated) || change.order.includes('regions')
      || change.props.includes('fallback') || change.props.includes('radius')) refresh();
  });
  store.on('selection', () => {
    markSelection();
    renderFoot();
    // a region picked on the map or in the Regions panel is the one Populate means
    const regions = store.selected('region');
    if (regions.length === 1 && pop.region !== regions[0]) {
      pop.region = regions[0];
      popRegion.set(pop.region);
      syncPopulate();
    }
    if (!fromPanel) reveal();
  });
  store.on('history', () => { popGo.disabled = !!populateBlock() || store.grouping; });
  ui.on('layers', renderAll);
  ui.on('overlays', (now, before) => { if (!!now?.levelColors !== !!before?.levelColors) renderTable(); });
  // the Populate form shows the Spawn tool's settings; ctx.tools is complete by now (tools are created before panels)
  ctx.tools?.spawn?.onTemplate?.(syncPopulate);

  renderAll();
  // every rendered frame: what a command changed is in the table before the frame is drawn
  return { update() { refresh.flush(); } };
}
