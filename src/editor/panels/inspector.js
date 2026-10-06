import { h, row, button, numberField, angleField, selectField, checkField, textField, colorField, rafThrottle } from '../ui/dom.js';
import { FIELDS, withEnd } from '../fields.js';
import { keyText } from '../keymap.js';
import { editable } from '../tools/common.js';
import { LIMITS, spawnCount } from '../../map/format.js';
import { modelInfo } from '../../map/catalog.js';
import { MOB_TYPES } from '../../shared.js';

// The Inspector (#inspector): the fields of what is selected - or of the map itself when nothing is.
//
// It is generic: which fields a kind has, their types and limits come from the FIELDS schema (fields.js), and this
// file knows field TYPES, never kinds. A selection of one kind is edited as one: a field whose values differ shows a
// dash, a typed number sets it on every item, a relative entry ('+5', '*1.2') changes every item from its own value.
// A selection of several kinds shows only its breakdown: click a row to keep that part, Alt+click to drop it.
//
// Every edit is ONE undo step and goes through a command:
//   typing / scrubbing a number   onInput: store.begin + exec(cmd.set) on every change, onCommit: store.commit
//   a choice, a checkbox, a text  one exec(cmd.set) on commit
//   a relative entry in a mixed field, an end of a level range   one exec(cmd.setEach) with a patch per item
//   a field whose entry has `patch` (spawn types)                cmd.setEach(items, items.map((it) => field.patch(it, value)))
//   the map's own properties                                     cmd.setProps, on commit only (a radius resizes the ground)
// Items on a hidden or locked layer are shown but never changed (tools/common.js `editable`).

const NOUN = {
  object: ['object', 'objects'], spawn: ['spawn', 'spawns'], chest: ['chest', 'chests'],
  npc: ['NPC', 'NPCs'], region: ['region', 'regions'], start: ['start point', 'start points'],
};
const KIND_ORDER = ['object', 'spawn', 'chest', 'npc', 'region', 'start'];
const COLLIDER_MODES = [
  ['default', 'Catalog default'], ['none', 'None (walk through)'], ['factor', 'Circle × factor'], ['box', 'Box'], ['circles', 'Circles (model units)'],
];
const NEW_FACTOR = 0.5, NEW_CIRCLES = [{ x: 0, z: 0, r: 0.5 }];
const BUSY = 'Finish the current edit first';

const int = (n) => n.toLocaleString('en-US');
const plural = (n, kind) => `${int(n)} ${NOUN[kind][n === 1 ? 0 : 1]}`;
const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// deep equality of two field values: numbers, strings, null, small arrays and objects
function same(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) if (!Object.hasOwn(b, k) || !same(a[k], b[k])) return false;
  return true;
}

const applyRel = (v, rel) => (rel.op === '+' ? v + rel.n : rel.op === '-' ? v - rel.n : v * rel.n);
const clamp = (v, min, max) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));

const colliderMode = (col) => (col == null ? 'default' : col === 0 ? 'none' : col === 'box' ? 'box' : Array.isArray(col) ? 'circles' : 'factor');
function colliderText(col) {
  if (col === 'auto') return 'by size (a model the catalog does not list)';
  if (col === 0 || col == null) return 'none';
  if (col === 'box') return 'box';
  if (Array.isArray(col)) return `${col.length} circle${col.length === 1 ? '' : 's'}`;
  return `circle × ${col}`;
}
// -> [{ x, z, r }] from the JSON text of the Circles field, or null when it is not 1..8 circles
function parseCircles(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > LIMITS.colCircles) return null;
  const out = [];
  for (const c of raw) {
    if (c === null || typeof c !== 'object' || !finite(c.x) || !finite(c.z) || !finite(c.r) || !(c.r > 0)) return null;
    out.push({ x: c.x, z: c.z, r: c.r });
  }
  return out;
}

export default function mount(el, ctx) {
  const { store, ui, cmd, actions } = ctx;

  const head = h('div', { class: 'head' }), body = h('div', { class: 'fields' }), foot = h('div', { class: 'foot' });
  el.replaceChildren(head, body, foot);

  let kind = null;        // 'map' | one of the six kinds | 'mixed' | null (no map yet)
  let items = [];         // the selected items of that kind, in map order
  let targets = [];       // those of them that may be edited
  let controls = [];      // [{ refresh() }] - one per field of the form that is shown
  let subs = [];          // subscriptions of the form that is shown; released when it is rebuilt
  let own = false;        // the open store group is this panel's (a number that is being typed or scrubbed)
  let refused = false;    // the edit that is being typed was turned away (somebody else's group is open): said once
  let headKey = null;     // what the header shows, so a refresh rebuilds it only when that changed

  // ---------------------------------------------------------------- edits

  const fail = (err) => {
    console.error('[editor] inspector edit failed', err);
    ui.toast(`That value cannot be set: ${err?.message ?? err}`, 'error');
  };

  // One step of a live edit (a number while it is typed or scrubbed): the first opens the group, done() closes it.
  function live(command) {
    if (own && !store.grouping) own = false;   // somebody closed it under us: another map, a cancelled tool
    if (!targets.length) return;
    try {
      if (!own) {
        if (store.grouping) {                  // a drag or a grab is open: its group is not ours to write into
          if (!refused) ui.toast(BUSY, 'warn');
          refused = true;
          return;
        }
        store.begin(command.label);
        own = true;
      }
      store.exec(command);
    } catch (err) { fail(err); }
  }
  function done() {
    refused = false;
    if (!own) return;
    own = false;
    if (store.grouping) store.commit();
  }
  // An edit that is complete in itself. -> whether it ran
  function once(command) {
    done();
    if (store.grouping) { ui.toast(BUSY, 'warn'); return false; }
    try {
      store.exec(command);
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  }
  const setAll = (patch) => (kind === 'map' ? cmd.setProps(patch) : cmd.set(targets, patch));
  const setEach = (patchOf) => cmd.setEach(targets, targets.map(patchOf));

  // ---------------------------------------------------------------- values

  const shown = () => (targets.length ? targets : items);
  // -> { value, mixed } of a key over the items of the form (the map itself for the map's own form)
  function read(key, of = (item) => item[key]) {
    if (kind === 'map') return { value: store.map[key], mixed: false };
    const list = shown();
    if (!list.length) return { value: null, mixed: false };
    const value = of(list[0]);
    for (let i = 1; i < list.length; i++) if (!same(of(list[i]), value)) return { value, mixed: true };
    return { value, mixed: false };
  }
  const limit = (v) => (typeof v === 'function' ? v(store.map) : v);

  // ---------------------------------------------------------------- one control per field type

  // number, int, angle. `of` / `patchOf` let a part of a value (one end of a range, one weight) use the same field.
  function numberControl(f, { make = numberField, of, patchOf, liveEdit = true, label = f.label } = {}) {
    const whole = f.type === 'int', min = limit(f.min), max = limit(f.max);
    const get = of ?? ((item) => item[f.key]);
    const put = patchOf ?? ((item, v) => ({ [f.key]: v }));
    const fit = (v) => { const n = clamp(v, min, max); return whole ? Math.round(n) : n; };
    const field = make({
      min, max, step: f.step ?? (whole ? 1 : undefined), digits: whole ? 0 : f.digits,
      onInput: kind !== 'map' && liveEdit ? (v) => live(setEach((item) => put(item, v))) : null,
      onCommit: (v, { relative }) => {
        if (Number.isNaN(v)) {   // a relative entry in a field whose items differ: each from its own value
          if (relative) once(setEach((item) => put(item, fit(applyRel(get(item) ?? 0, relative)))));
        } else if (kind === 'map') once(cmd.setProps({ [f.key]: v }));
        else if (liveEdit) done();
        else once(setEach((item) => put(item, v)));
        refresh();
      },
    });
    const node = row(label, field);
    if (typeof f.title === 'string') node.title = f.title;   // what the number means, where the label cannot say it
    return {
      field, node,
      refresh() { const { value, mixed } = read(f.key, kind === 'map' ? undefined : get); field.set(value, mixed); },
      disable(on) { field.setDisabled(on); },
    };
  }

  function textControl(f) {
    const field = textField({
      minLength: f.minLength ?? 0, maxLength: f.maxLength ?? Infinity, pattern: f.pattern ?? null,
      // a group field: an empty text takes the items out of their group
      onCommit: (text) => { once(setAll({ [f.key]: f.type === 'group' && text === '' ? undefined : text })); refresh(); },
    });
    if (f.type === 'group') field.input.title = 'Group id: letters, digits, _ . - (at most 32 characters). Items with the same id are selected together. Empty = no group.';
    return {
      field, node: row(f.label, field),
      refresh() { const { value, mixed } = read(f.key); field.set(value ?? '', mixed); },
      disable(on) { field.setDisabled(on); },
    };
  }

  function boolControl(f) {
    const field = checkField({ onCommit: (on) => { once(setAll({ [f.key]: on })); refresh(); } });
    return {
      field, node: row(f.label, field),
      refresh() { const { value, mixed } = read(f.key); field.set(value, mixed); },
      disable(on) { field.setDisabled(on); },
    };
  }

  function selectControl(f) {
    const field = selectField({
      options: (f.options ?? []).map((value) => ({ value, label: value === null ? '(inherit)' : capital(String(value)) })),
      onCommit: (value) => { once(setAll({ [f.key]: value })); refresh(); },
    });
    return {
      field, node: row(f.label, field),
      refresh() { const { value, mixed } = read(f.key); field.set(value, mixed); },
      disable(on) { field.setDisabled(on); },
    };
  }

  function colorControl(f) {
    const field = colorField({ onCommit: (value) => { once(setAll({ [f.key]: value })); refresh(); } });
    return {
      field, node: row(f.label, field),
      refresh() { const { value, mixed } = read(f.key); field.set(value, mixed); },
      disable(on) { field.setDisabled(on); },
    };
  }

  // The model of the selected objects: any model of the catalog, or the one that is armed in the palette.
  function modelControl(f) {
    const list = ctx.models ?? [];
    const field = selectField({ onCommit: (id) => { once(setAll({ [f.key]: id })); refresh(); } });
    const fromPalette = button('Palette', () => {
      const id = ui.models?.[0];
      if (id) { once(setAll({ [f.key]: id })); refresh(); }
    });
    const syncPalette = () => {
      const id = ui.models?.[0];
      fromPalette.disabled = !id || !targets.length;
      fromPalette.title = id ? `Replace the model with the one chosen in the palette: ${id}` : 'Choose a model in the palette first';
    };
    subs.push(ui.on('models', syncPalette));
    let options = null;
    return {
      field, node: row(f.label, field, fromPalette),
      refresh() {
        const { value, mixed } = read(f.key);
        // a model the palette does not offer (a hidden one, a file that is gone) must still be shown as what it is
        const extra = [...new Set(shown().map((item) => item[f.key]))].filter((id) => !list.includes(id)).sort();
        const key = extra.join('\n');
        if (options !== key) {
          options = key;
          field.setOptions([...extra, ...list].map((id) => ({ value: id, label: id })));
        }
        field.set(value, mixed);
        syncPalette();
      },
      disable(on) { field.setDisabled(on); syncPalette(); },
    };
  }

  // The collider override of an object: the catalog's own, none, a circle (a share of the footprint), the box, or circles.
  function colliderControl(f) {
    const catalogOf = (item) => modelInfo(item.m)?.col ?? 'auto';
    // what an object gets when it is switched to a mode: what it has, else what the catalog says, else a small default
    const initial = (item, mode) => {
      const mine = item[f.key], theirs = catalogOf(item);
      if (mode === 'default') return undefined;
      if (mode === 'none') return 0;
      if (mode === 'box') return 'box';
      if (mode === 'factor') return typeof mine === 'number' && mine > 0 ? mine : typeof theirs === 'number' && theirs > 0 ? theirs : NEW_FACTOR;
      return Array.isArray(mine) ? mine : Array.isArray(theirs) ? theirs : NEW_CIRCLES;
    };
    const mode = selectField({
      options: COLLIDER_MODES.map(([value, label]) => ({ value, label })),
      onCommit: (m) => { once(setEach((item) => ({ [f.key]: initial(item, m) }))); refresh(); },
    });
    const factor = numberControl({ key: f.key, type: 'number', min: 0.05, max: LIMITS.colFactor, step: 0.05, digits: 2 }, {
      label: 'Factor', of: (item) => (typeof item[f.key] === 'number' ? item[f.key] : null),
    });
    factor.field.input.title = `The circle's radius as a share of the model's footprint radius (0.05 to ${LIMITS.colFactor})`;
    const circles = textField({
      maxLength: 800,
      onCommit: (text) => {
        const list = parseCircles(text);
        if (list) once(setAll({ [f.key]: list }));
        else ui.toast(`Circles are JSON, 1 to ${LIMITS.colCircles} of them in model units: [{"x":0,"z":0,"r":0.5}]`, 'warn');
        refresh();
      },
    });
    circles.input.classList.add('ui-mono');
    circles.input.title = `JSON: [{"x":0,"z":0,"r":0.5}, ...] - 1 to ${LIMITS.colCircles} circles in MODEL units (before the pack scale, the object's scale and its rotation)`;
    const factorRow = factor.node, circlesRow = row('Circles', circles), hint = h('div', { class: 'ui-hint catalog' });
    return {
      node: h('div', { class: 'collider' }, row(f.label, mode), factorRow, circlesRow, hint),
      refresh() {
        const m = read(f.key, (item) => colliderMode(item[f.key]));
        mode.set(m.value, m.mixed);
        factorRow.hidden = m.mixed || m.value !== 'factor';
        circlesRow.hidden = m.mixed || m.value !== 'circles';
        if (!factorRow.hidden) factor.refresh();
        if (!circlesRow.hidden) {
          const c = read(f.key);
          circles.set(c.mixed ? '' : JSON.stringify(c.value), c.mixed);
        }
        const cat = read(f.key, catalogOf);
        hint.textContent = cat.mixed ? 'Catalog: differs between the selected models' : `Catalog: ${colliderText(cat.value)}`;
      },
      disable(on) { mode.setDisabled(on); factor.disable(on); circles.setDisabled(on); },
    };
  }

  // One whole-number weight per option (0 = absent): the monster types of a spawn.
  function weightsControl(f) {
    const rows = (f.options ?? []).map((option) => {
      const weight = (item) => item[f.key]?.[option] ?? 0;
      // the new value of the whole field for one item, with this option set to v
      const next = (item, v) => {
        const value = { ...item[f.key] };
        if (v > 0) value[option] = v; else delete value[option];
        return value;
      };
      const patch = (item, value) => (f.patch ? f.patch(item, value) : { [f.key]: value });
      const fit = (v) => Math.round(clamp(v, limit(f.min) ?? 0, limit(f.max)));
      const field = numberField({
        min: limit(f.min) ?? 0, max: limit(f.max), step: 1, digits: 0,
        onCommit: (v, { relative }) => {
          const valueOf = Number.isNaN(v) ? (relative ? (item) => fit(applyRel(weight(item), relative)) : null) : () => v;
          if (valueOf) {
            const values = targets.map((item) => next(item, valueOf(item)));
            if (values.some((value) => !Object.keys(value).length)) ui.toast(`${f.label}: at least one must stay above 0`, 'warn');
            else once(cmd.setEach(targets, targets.map((item, i) => patch(item, values[i]))));
          }
          refresh();
        },
      });
      return { option, field, weight, node: row(MOB_TYPES[option]?.name ?? capital(String(option)), field) };
    });
    return {
      node: h('div', { class: 'weights' }, h('div', { class: 'caption' }, f.label, h('span', { class: 'ui-hint' }, 'weight, 0 = none')), rows.map((r) => r.node)),
      refresh() { for (const r of rows) { const { value, mixed } = read(f.key, r.weight); r.field.set(value, mixed); } },
      disable(on) { for (const r of rows) r.field.setDisabled(on); },
    };
  }

  // Two whole numbers, low and high (spawn levels). With `orNull` the pair may be absent altogether (region levels).
  // Each end is its own field, so one end typed over a mixed selection leaves every item's other end alone - only an
  // end that would cross the other takes it along.
  function rangeControl(f, orNull) {
    const min = limit(f.min), max = limit(f.max);
    const end = (i) => numberControl({ key: f.key, type: 'int', min, max }, {
      liveEdit: false,
      of: (item) => item[f.key]?.[i] ?? null,
      patchOf: (item, v) => ({ [f.key]: withEnd(item[f.key], i, v) }),
    });
    const lo = end(0), hi = end(1);
    lo.field.input.setAttribute('aria-label', `${f.label}, lowest`);
    hi.field.input.setAttribute('aria-label', `${f.label}, highest`);
    const has = orNull ? checkField({
      onCommit: (on) => { once(setEach((item) => ({ [f.key]: on ? (item[f.key] ?? [min ?? 1, min ?? 1]) : null }))); refresh(); },
    }) : null;
    if (has) has.el.title = `${f.label} set (off = none)`;
    const dash = h('span', { class: 'ui-dash' }, '–');
    return {
      node: row(f.label, lo.field, dash, hi.field, has),
      refresh() {
        lo.refresh();
        hi.refresh();
        if (!has) return;
        const set = read(f.key, (item) => item[f.key] != null);
        has.set(set.value, set.mixed);
        const none = !set.mixed && !set.value;
        lo.field.setDisabled(none || !targets.length);
        hi.field.setDisabled(none || !targets.length);
      },
      disable(on) { lo.disable(on); hi.disable(on); has?.setDisabled(on); },
    };
  }

  // Text the schema computes from an item (spawn stats). Several items: only when they agree.
  function computedControl(f) {
    const out = h('div', { class: 'computed ui-selectable' });
    return {
      node: h('div', { class: 'ui-row top' }, h('label', { class: 'ui-label' }, f.label), out),
      refresh() {
        let text = '—';
        try {
          const all = read('', (item) => String(f.text(item)));
          text = all.mixed ? '— (the selected items differ)' : all.value ?? '—';
        } catch (err) { console.error('[editor] inspector: a computed field failed', err); }
        if (out.textContent !== text) out.textContent = text;
      },
      disable() {},
    };
  }

  function actionControl(f) {
    const node = button(f.label, () => { done(); actions.run(f.action, targets.slice()); });
    return { node: row('', node), refresh() {}, disable(on) { node.disabled = on; } };
  }

  function controlFor(f) {
    switch (f.type) {
      case 'number': case 'int': return numberControl(f);
      case 'angle': return numberControl(f, { make: angleField });
      case 'text': case 'group': return textControl(f);
      case 'bool': return boolControl(f);
      case 'select': return selectControl(f);
      case 'color': return colorControl(f);
      case 'model': return modelControl(f);
      case 'collider': return colliderControl(f);
      case 'weights': return weightsControl(f);
      case 'intRange': return rangeControl(f, false);
      case 'intRangeOrNull': return rangeControl(f, true);
      case 'computed': return computedControl(f);
      case 'action': return actionControl(f);
      default: return null;   // a type this panel does not know yet: the field is left out, the rest works
    }
  }

  // ---------------------------------------------------------------- header and footer

  // What the selection consists of: [{ label, title, items }] - one row per kind when there are several, one per model
  // when the objects have several.
  function breakdown() {
    const byKind = new Map(), byModel = new Map();
    for (const item of store.selection) {
      const k = store.kindOf(item);
      if (!k) continue;
      if (!byKind.has(k)) byKind.set(k, []);
      byKind.get(k).push(item);
      if (k === 'object') {
        if (!byModel.has(item.m)) byModel.set(item.m, []);
        byModel.get(item.m).push(item);
      }
    }
    const rows = [];
    if (byKind.size > 1) for (const k of KIND_ORDER) if (byKind.has(k)) rows.push({ label: plural(byKind.get(k).length, k), n: null, items: byKind.get(k), kind: k });
    if (byModel.size > 1) {
      for (const [id, list] of [...byModel].sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1))) rows.push({ label: id, n: list.length, items: list, model: id });
    }
    return { rows, byKind };
  }

  function drawHead() {
    const map = store.map;
    if (!map) { headKey = null; head.replaceChildren(h('div', { class: 'ui-empty' }, 'No map loaded.')); return; }
    const { rows, byKind } = breakdown(), total = store.selection.size;
    const locked = kind !== 'map' && kind !== 'mixed' ? items.length - targets.length : 0;
    const one = total === 1 ? [...store.selection][0] : null;
    let label = '';
    if (one) { try { label = ctx.markers?.labelOf?.(one) ?? ''; } catch { /* a nicety */ } }
    const title = kind === 'map' ? 'Map' : byKind.size === 1 ? plural(total, [...byKind.keys()][0]) : `${int(total)} items`;
    const key = `${kind}\n${title}\n${label}\n${locked}\n${rows.map((r) => `${r.label}=${r.items.length}`).join('|')}`;
    if (key === headKey) return;
    headKey = key;

    const nodes = [h('div', { class: 'title' }, h('span', { class: 'what' }, title), label && typeof label === 'string' ? h('span', { class: 'label ui-dim', title: label }, label) : null)];
    if (kind === 'map') nodes.push(h('div', { class: 'ui-hint' }, 'Nothing is selected: these are the properties of the map itself.'));
    if (kind === 'mixed') nodes.push(h('div', { class: 'ui-hint' }, keyText('Several kinds are selected. Fields appear when the selection is of one kind: click a row to keep it, Alt+click to drop it.')));
    if (rows.length) {
      nodes.push(h('div', { class: 'ui-list breakdown' }, rows.map((r) => {
        const node = h('div', {
          class: ['ui-item', r.model ? 'model' : 'kind'], dataset: r.model ? { model: r.model } : { kind: r.kind },
          title: `${r.label}\n${keyText('Click: keep only these · Alt+click: take them out of the selection')}`,
        }, h('span', { class: 'name' }, r.label), r.n === null ? null : h('span', { class: 'count' }, `× ${int(r.n)}`));
        node.addEventListener('click', (ev) => {
          done();
          if (ev.altKey) { const drop = new Set(r.items); store.select([...store.selection].filter((item) => !drop.has(item))); }
          else store.select(r.items);
        });
        return node;
      })));
    }
    if (locked > 0) {
      nodes.push(h('div', { class: 'ui-hint locked' }, locked === items.length
        ? 'Hidden or locked (the layer, the model or the item itself): this selection cannot be edited.'
        : `${int(locked)} of them ${locked === 1 ? 'is' : 'are'} hidden or locked and will not change.`));
    }
    head.replaceChildren(...nodes);
  }

  // The map's own form ends with what the map holds.
  function drawFoot() {
    const map = store.map;
    if (kind !== 'map' || !map) { if (foot.childElementCount) foot.replaceChildren(); return; }
    const g = map.ground, monsters = spawnCount(map);
    const text = [
      `${plural(map.objects.length, 'object')} · ${plural(map.spawns.length, 'spawn')} (${int(monsters)} monster${monsters === 1 ? '' : 's'}) · ${plural(map.chests.length, 'chest')}`,
      `${plural(map.npcs.length, 'npc')} · ${plural(map.regions.length, 'region')} · ground ${g.size} × ${g.size}, cell ${g.cell}`,
    ].join('\n');
    if (foot.textContent !== text) foot.replaceChildren(h('div', { class: 'summary ui-hint' }, text));
  }

  // ---------------------------------------------------------------- the form

  // The fields show the map again. Fields the user is typing in keep their text (the widgets see to that).
  function refresh() {
    refreshSoon.cancel();
    if (!store.map || kind === null) return;
    if (kind !== 'map' && items.some((item) => store.kindOf(item) !== kind)) { rebuild(); return; }   // an item left the map
    drawHead();
    for (const c of controls) {
      try { c.refresh(); } catch (err) { console.error('[editor] inspector: a field failed to refresh', err); }
    }
    drawFoot();
  }
  const refreshSoon = rafThrottle(refresh);

  // Another selection, another map, another layer state: the form is built anew.
  function rebuild() {
    refreshSoon.cancel();
    done();   // a number that was being typed belongs to the old form: its edit ends here
    for (const off of subs) off?.();
    subs = [];
    controls = [];
    headKey = null;
    const map = store.map;
    if (!map) { kind = null; items = targets = []; body.replaceChildren(); drawHead(); drawFoot(); return; }

    const kinds = new Set();
    for (const item of store.selection) { const k = store.kindOf(item); if (k) kinds.add(k); }
    if (kinds.size === 0) { kind = 'map'; items = targets = []; } else if (kinds.size > 1) { kind = 'mixed'; items = targets = []; } else {
      kind = [...kinds][0];
      items = store.selected(kind);
      targets = editable(ctx, items);
    }

    const nodes = [];
    for (const f of (kind === 'mixed' ? [] : FIELDS[kind]) ?? []) {
      let c = null;
      try { c = controlFor(f); } catch (err) { console.error(`[editor] inspector: the field '${f.label}' could not be built`, err); }
      if (!c) continue;
      if (kind !== 'map' && !targets.length) c.disable(true);
      controls.push(c);
      nodes.push(c.node);
    }
    body.replaceChildren(...nodes);
    refresh();
  }

  // ---------------------------------------------------------------- wiring

  store.on('load', rebuild);
  store.on('selection', rebuild);
  store.on('change', refreshSoon);
  store.on('history', () => { if (own && !store.grouping) own = false; });   // the group was closed by somebody else
  ui.on('layers', rebuild);          // what may be edited has changed
  ui.on('hiddenModels', rebuild);
  ui.on('itemflags', rebuild);

  rebuild();
  return {
    // Every rendered frame: a refresh that is waiting for its animation frame is done with this one. A change of the
    // map always asks the viewport for a frame, so the fields follow it even where the browser hands out none (a
    // throttled window, a frame stepped by a script).
    update() { refreshSoon.flush(); },
  };
}
