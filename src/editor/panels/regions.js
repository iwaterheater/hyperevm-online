// The Regions panel (#regions): the regions of the map as a list, and the properties of the selected ones.
//
// - The list shows the WINNING region at the top - the reverse of the file order, like the layers of an image editor.
//   Dragging a row to another place is one cmd.reorder: where regions overlap, the higher row decides the name on the
//   banner, the levels and the mood (regionAt). The last row is the fallback region: what applies where no region
//   does. It has no shape, cannot be moved or deleted, and is edited with cmd.setProps({ fallback }).
// - A row: colour chip, the banner text, a "safe" badge, the mood, eye and lock (per-item flags of `ui`, not part of
//   the map) and a button that previews the row's mood in the viewport.
// - A click on a row selects the region (Shift / Mod: toggles it), a double-click also frames it in the viewport.
//   Under the list the selected regions are edited: name, mood, safe, levels (by hand or from the spawns inside),
//   colour. Several selected regions are edited together; a value they do not share shows as mixed.
//
// The panel only reads the store and `ui` and runs commands: one undo step per committed field.
// It also registers the action 'region.levelsFromSpawns' (args: regions[]), which the inspector's button runs too;
// the list may hold map.fallback, which is how this panel sets the levels of the fallback region the same way.
import { LIMITS, MOODS, moodAt, regionColor, regionLabel, shapeCentre } from '../../map/format.js';
import { h, row, button, textField, selectField, checkField, intRangeField, colorField, rafThrottle } from '../ui/dom.js';
import { mod, hintFor } from '../keymap.js';
import { editable } from '../tools/common.js';
import { polygonArea } from '../tools/measure.js';

const DRAG_PX = 4;             // a press that travels less is a click on the row
const SCROLL_EDGE = 18;        // px from the edge of the list where a drag scrolls it
const BUSY = 'Finish the current edit first';
const HEX = /^#[0-9a-f]{6}$/i;
// Colours for regions that should stand out from the three mood colours: the palette of the chips. Data, not styling.
const PRESETS = ['#6fbf55', '#b59a6a', '#ff5a70', '#7fe8d6', '#3a8fb0', '#4d7cff', '#a98bff', '#ff8a3d', '#e0c04a', '#c9d2da'];

const ICONS = {
  grip: 'M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01',
  eye: 'M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8zM8 6.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z',
  eyeOff: 'M1.5 8s2.4-4.2 6.5-4.2S14.5 8 14.5 8s-2.4 4.2-6.5 4.2S1.5 8 1.5 8zM3 13L13 3',
  lock: 'M4.5 7.5h7v5.5h-7zM6 7.5V5.5a2 2 0 0 1 4 0v2',
  unlock: 'M4.5 7.5h7v5.5h-7zM6 7.5V5.5a2 2 0 0 1 3.8-.9',
  sun: 'M8 5.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6zM8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1',
};
const SVG = 'http://www.w3.org/2000/svg';

// A 16 x 16 line icon in the current text colour. The path data are the constants above, never anything from the map.
function icon(name) {
  const svg = document.createElementNS(SVG, 'svg'), path = document.createElementNS(SVG, 'path');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', `icon icon-${name}`);
  svg.setAttribute('aria-hidden', 'true');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const trim = (v) => String(Number(v.toFixed(2)));
const levelsText = (l) => (l ? (l[0] === l[1] ? `Lv ${l[0]}` : `Lv ${l[0]}–${l[1]}`) : 'no levels');
const safeColor = (color) => (typeof color === 'string' && HEX.test(color) ? color : 'transparent');

// ---------------------------------------------------------------- pure helpers

// The list shows the winner first: row d of n stands for map index n - 1 - d. A row dragged into slot k
// (0 = above the first row ... n = below the last one) ends up at this map index - its own when nothing changes.
export function dropIndex(n, from, slot) {
  const d = n - 1 - from, to = Math.max(0, Math.min(n - 1, slot > d ? slot - 1 : slot));
  return n - 1 - to;
}

// "Circle, r 24 at 0, 0" / "Polygon, 5 points, area 320.5"
export function shapeSummary(shape) {
  if (shape.type === 'circle') return `Circle · r ${trim(shape.r)} · centre ${trim(shape.x)}, ${trim(shape.z)}`;
  return `Polygon · ${plural(shape.points.length, 'point')} · area ${polygonArea(shape.points).toFixed(1)}`;
}

// The mood that lights a region: its own, or - when it inherits - the one in force at the middle of its shape.
export function effectiveMood(map, region) {
  if (region.mood != null) return region.mood;
  if (!region.shape) return map.fallback.mood;
  const c = shapeCentre(region.shape);
  return moodAt(map, c.x, c.z);
}

// One value for several items: [value of the first, whether they differ].
function shared(items, get, same = Object.is) {
  const first = get(items[0]);
  return [first, items.some((item) => !same(get(item), first))];
}
const samePair = (a, b) => (a === null || b === null ? a === b : a[0] === b[0] && a[1] === b[1]);

// ---------------------------------------------------------------- the panel

export default function mount(el, ctx) {
  const { store, ui, cmd, actions, viewport } = ctx;

  let fallbackOpen = false;      // the fallback row was clicked: the form below edits the fallback, not the selection
  let rows = new Map();          // row element -> { region, index } (region null: the fallback row)
  let press = null;              // a press on a row: { el, region, index, x, y, id, toggle, dragging, slot }
  let stale = false;             // a refresh came in the middle of a drag: it is done when the row is dropped

  const layerOpen = () => { const l = ui.layers?.regions; return !l || (l.visible !== false && !l.locked); };
  const layerWord = () => (ui.layers?.regions?.visible === false ? 'hidden' : 'locked');
  const refuseLayer = () => ui.toast(`Layer ${layerWord()}: regions`, 'warn');
  const selectedRegions = () => (store.map ? store.selected('region') : []);
  // what the form edits: the fallback, the selected regions, or nothing
  const target = () => (!store.map ? 'none' : fallbackOpen ? 'fallback' : selectedRegions().length ? 'regions' : 'none');

  // ---- head: how many, the tint switch, the two ways to draw

  const count = h('span', { class: 'count' });
  const tint = button('Tint', () => ui.set('overlays', { ...ui.overlays, regiontint: !ui.overlays.regiontint }),
    { title: 'Tint the ground with the colour of the region that wins there' });
  const drawWith = (mode) => () => {
    if (!actions.run('tool.region')) { if (!layerOpen()) refuseLayer(); return; }
    ctx.tools?.region?.setMode?.(mode);
  };
  const keyHint = hintFor('tool.region');
  const drawCircle = button('+ Circle', drawWith('circle'), { title: `Draw a circle region: drag from the centre to the radius${keyHint ? ` (Region tool, ${keyHint})` : ''}` });
  const drawPoly = button('+ Polygon', drawWith('poly'), { title: 'Draw a polygon region: click its points, Enter closes it' });
  const head = h('div', { class: 'head' }, count, tint, drawCircle, drawPoly);

  // ---- the list

  const drop = h('div', { class: 'drop', hidden: true });
  const list = h('div', { class: 'ui-list list', role: 'listbox', 'aria-label': 'Regions, the winning one first' });
  const hint = h('div', { class: 'ui-hint hint' });

  const flagButton = (region, flag, on, icons, titles) => {
    const b = button(icon(icons[on ? 1 : 0]), () => ui.setItemFlag(region, flag, !on), { title: titles[on ? 1 : 0] });
    b.classList.add('flat', 'icon');
    b.setAttribute('aria-pressed', String(on));
    return b;
  };
  const previewButton = (mood) => {
    const on = ui.preview === mood, name = MOODS[mood]?.name ?? mood;
    const b = button(icon('sun'), () => viewport.setPreview(ui.preview === mood ? 'neutral' : mood),
      { title: on ? `Back to the neutral light (now: ${name})` : `Preview mood: light the viewport as ${name}` });
    b.classList.add('flat', 'icon');
    b.setAttribute('aria-pressed', String(on));
    return b;
  };
  const moodCell = (map, region) => {
    const mood = effectiveMood(map, region), inherited = region.mood == null;
    return h('span', { class: ['mood', inherited && 'inherited'], title: inherited ? `Mood: inherits ${MOODS[mood]?.name ?? mood}` : `Mood: ${MOODS[mood]?.name ?? mood}` },
      MOODS[mood]?.name ?? mood);
  };

  function regionRow(map, region, index) {
    const selected = !fallbackOpen && store.selection.has(region);
    const hidden = ui.itemFlag(region, 'hidden'), locked = ui.itemFlag(region, 'locked');
    const node = h('div', {
      class: ['ui-item', 'row', selected && 'selected', hidden && 'is-hidden', locked && 'is-locked'],
      role: 'option', 'aria-selected': String(selected),
      title: `${regionLabel(region)}\n${shapeSummary(region.shape)}\nDrag to change the order: a higher row wins where regions overlap`,
    },
    h('span', { class: 'grip' }, icon('grip')),
    h('span', { class: 'ui-swatch', style: { background: safeColor(regionColor(map, region)) } }),
    h('span', { class: 'name' }, regionLabel(region)),       // a text node: names come from the map
    region.safe && h('span', { class: 'ui-badge ok', title: 'Safe: fast regeneration, monsters keep out' }, 'safe'),
    moodCell(map, region),
    flagButton(region, 'hidden', hidden, ['eye', 'eyeOff'], ['Hide the outline of this region', 'Show this region']),
    flagButton(region, 'locked', locked, ['unlock', 'lock'], ['Lock: the region cannot be picked or edited', 'Unlock this region']),
    previewButton(effectiveMood(map, region)));
    rows.set(node, { region, index });
    return node;
  }

  function fallbackRow(map) {
    const f = map.fallback;
    const node = h('div', {
      class: ['ui-item', 'row', 'fallback', fallbackOpen && 'selected'], role: 'option', 'aria-selected': String(fallbackOpen),
      title: `${regionLabel(f)}\nThe fallback region: what applies wherever no region does. It cannot be moved or deleted`,
    },
    h('span', { class: 'grip' }),
    h('span', { class: 'ui-swatch', style: { background: safeColor(regionColor(map, f)) } }),
    h('span', { class: 'name' }, regionLabel(f)),
    h('span', { class: 'ui-badge' }, 'fallback'),
    moodCell(map, f),
    previewButton(f.mood));
    rows.set(node, { region: null, index: -1 });
    return node;
  }

  function renderList() {
    const map = store.map;
    rows = new Map();
    if (!map) {
      list.replaceChildren();
      hint.textContent = '';
      return;
    }
    const nodes = [];
    for (let i = map.regions.length - 1; i >= 0; i--) nodes.push(regionRow(map, map.regions[i], i));
    nodes.push(fallbackRow(map), drop);
    list.replaceChildren(...nodes);
    const n = map.regions.length;
    hint.textContent = !layerOpen() ? `The Regions layer is ${layerWord()}: nothing here can be edited`
      : n === 0 ? `No regions yet: the whole map is "${map.fallback.name}". Draw one with + Circle or + Polygon`
        : n === 1 ? 'Draw more regions with + Circle or + Polygon' : 'The top row wins where regions overlap. Drag a row to change the order';
  }

  function renderHead() {
    const map = store.map, open = layerOpen();
    count.textContent = map ? plural(map.regions.length, 'region') : '';
    tint.classList.toggle('active', !!ui.overlays.regiontint);
    tint.setAttribute('aria-pressed', String(!!ui.overlays.regiontint));
    drawCircle.disabled = drawPoly.disabled = !map || !open;
  }

  // ---- the form under the list

  // One undo step with the edit, or the reason why not. -> whether it ran
  function apply(patch, label = null) {
    const t = target();
    if (t === 'none') return false;
    if (store.grouping) { ui.toast(BUSY, 'warn'); return false; }
    if (!layerOpen()) { refuseLayer(); return false; }
    let command;
    if (t === 'fallback') command = cmd.setProps({ fallback: patch });
    else {
      const items = editable(ctx, selectedRegions());
      if (!items.length) { ui.toast('The region is locked or hidden: unlock it to edit it', 'warn'); return false; }
      command = cmd.set(items, patch);
    }
    if (!label) { store.exec(command); return true; }
    store.begin(label);
    try { store.exec(command); } finally { store.commit(); }
    return true;
  }
  // a field whose edit was refused shows what the map holds again
  const commit = (patch, label) => { if (!apply(patch, label)) syncForm(); };

  const title = h('div', { class: 'detail-title' });
  const note = h('div', { class: 'note', hidden: true });
  const name = textField({ value: '', minLength: LIMITS.regionName[0], maxLength: LIMITS.regionName[1], onCommit: (text) => commit({ name: text }) });
  const mood = selectField({ value: null, options: [], onCommit: (value) => commit({ mood: value }) });
  const safe = checkField({ value: false, onCommit: (on) => commit({ safe: on }) });
  const levelsOn = checkField({ value: false, onCommit: (on) => commit({ levels: on ? levelsRange.value ?? [LIMITS.level[0], LIMITS.level[0]] : null }) });
  const levelsRange = intRangeField({ value: null, min: LIMITS.level[0], max: LIMITS.level[1], onCommit: (pair) => commit({ levels: pair }) });
  const fromSpawns = button('From spawns', () => actions.run('region.levelsFromSpawns', target() === 'fallback' ? [store.map.fallback] : selectedRegions()),
    { title: 'Set the levels to the lowest and the highest level of the spawns inside the region' });
  levelsOn.el.title = 'Does the region show a level range on its banner?';

  const auto = button('Auto', () => commit({ color: null }, 'Reset the colour of a region'), { title: 'No colour of its own: the safe colour, or the colour of its mood' });
  auto.classList.add('chip', 'auto');
  const chips = PRESETS.map((color) => {
    const b = button('', () => commit({ color }), { title: color });
    b.classList.add('chip');
    b.style.background = color;
    b.dataset.color = color;
    return b;
  });
  const custom = colorField({ value: null, nullable: false, onCommit: (color) => commit({ color }) });
  custom.input.title = 'Any other colour';
  const swatches = h('div', { class: 'swatches' }, auto, chips, custom);

  const info = h('div', { class: 'ui-hint info ui-selectable' });
  const focusBtn = button('Focus', () => { const all = selectedRegions(); if (all.length) viewport.focus(all); }, { title: 'Frame the selected regions in the viewport' });
  const raise = button('Raise', () => step(1), { title: 'One row up: the region wins over the one above it' });
  const lower = button('Lower', () => step(-1), { title: 'One row down: the region loses to the one below it' });
  const remove = button('Delete', () => {
    const items = editable(ctx, selectedRegions());
    if (!items.length) return;
    if (store.grouping) { ui.toast(BUSY, 'warn'); return; }
    if (!layerOpen()) { refuseLayer(); return; }
    store.exec(cmd.remove(items));
  }, { title: 'Delete the selected regions', danger: true });

  const rowName = row('Name', name), rowMood = row('Mood', mood), rowSafe = row('Safe', safe);
  const rowLevels = row('Levels', levelsOn, levelsRange, fromSpawns), rowColour = row('Colour', swatches);
  const rowActions = h('div', { class: 'actions' }, focusBtn, raise, lower, remove);
  const form = h('div', { class: 'detail', hidden: true }, title, note, rowName, rowMood, rowSafe, rowLevels, rowColour, info, rowActions);
  const idle = h('div', { class: 'ui-empty', hidden: true }, 'Click a row - or an outline in the viewport - to edit that region.');

  const MOOD_OPTIONS = Object.keys(MOODS).map((key) => ({ value: key, label: MOODS[key].name }));
  const REGION_MOODS = [{ value: null, label: '(inherit)' }, ...MOOD_OPTIONS];
  let moodsFor = null;   // which option list the mood select holds: 'regions' | 'fallback'

  // One step up or down in the list, for exactly one selected region.
  function step(dir) {
    const all = selectedRegions();
    if (all.length !== 1) return;
    reorder(all[0], store.indexOf(all[0]) + dir);
  }

  function reorder(region, toIndex) {
    const from = store.indexOf(region), n = store.map.regions.length;
    if (from < 0 || toIndex < 0 || toIndex >= n || toIndex === from) return false;
    if (store.grouping) { ui.toast(BUSY, 'warn'); return false; }
    if (!ui.isPickable('region', region)) {
      if (!layerOpen()) refuseLayer();
      else ui.toast('The region is locked or hidden: unlock it to move it', 'warn');
      return false;
    }
    store.exec(cmd.reorder('region', region, toIndex));
    return true;
  }

  function syncForm() {
    const map = store.map, t = target();
    form.hidden = t === 'none';
    idle.hidden = t !== 'none' || !map;
    if (t === 'none') return;
    const open = layerOpen(), regions = t === 'regions';
    rowSafe.hidden = rowColour.hidden = info.hidden = rowActions.hidden = !regions;
    if (moodsFor !== t) {
      mood.setOptions(regions ? REGION_MOODS : MOOD_OPTIONS);   // the fallback always has a mood of its own
      moodsFor = t;
    }
    let disabled = !open, levels, levelsMixed = false, ends = false;
    if (!regions) {
      const f = map.fallback;
      title.textContent = 'Fallback region';
      note.textContent = open ? 'Applies wherever no region does. It has no shape and is never safe.' : `The Regions layer is ${layerWord()}`;
      note.hidden = false;
      name.set(f.name);
      mood.set(f.mood);
      levels = f.levels;
    } else {
      const all = selectedRegions(), can = editable(ctx, all), one = all.length === 1;
      disabled = can.length === 0;
      title.textContent = one ? all[0].name : plural(all.length, 'region');
      note.hidden = can.length === all.length;
      note.textContent = !open ? `The Regions layer is ${layerWord()}: unlock it to edit`
        : can.length ? `${plural(all.length - can.length, 'region')} of the selection locked or hidden: left as they are`
          : 'Locked or hidden: use the lock and the eye of its row to edit it';
      const [n, nMixed] = shared(all, (r) => r.name), [m, mMixed] = shared(all, (r) => r.mood), [s, sMixed] = shared(all, (r) => r.safe);
      const [c, cMixed] = shared(all, (r) => r.color);
      [levels, levelsMixed] = shared(all, (r) => r.levels, samePair);
      ends = [shared(all, (r) => r.levels?.[0])[1], shared(all, (r) => r.levels?.[1])[1]];   // each end is mixed on its own
      name.set(n, nMixed);
      mood.set(m, mMixed);
      safe.set(s, sMixed);
      const current = cMixed ? undefined : c;
      auto.classList.toggle('active', current === null);
      // "Auto" wears the colour the region has without one of its own
      auto.style.borderColor = one ? safeColor(regionColor(map, { ...all[0], color: null })) : '';
      for (const chip of chips) chip.classList.toggle('active', chip.dataset.color === current);
      custom.set(cMixed ? null : c, cMixed);
      info.textContent = one ? shapeSummary(all[0].shape) : `${plural(all.length, 'region')} selected: a field you change is set on all of them`;
      const index = one ? store.indexOf(all[0]) : -1;
      raise.disabled = disabled || !one || index >= map.regions.length - 1;
      lower.disabled = disabled || !one || index <= 0;
      remove.disabled = disabled;
      safe.setDisabled(disabled);
      auto.disabled = disabled;
      for (const chip of chips) chip.disabled = disabled;
      custom.setDisabled(disabled);
    }
    fromSpawns.disabled = disabled;
    // some of the regions with levels and some without: the box is undecided and the numbers are a dash
    const some = levelsMixed && regions && selectedRegions().some((r) => r.levels) && selectedRegions().some((r) => !r.levels);
    levelsOn.set(!!levels && !some, some);
    if (levels && !some) levelsRange.set(levels, ends);
    else levelsRange.set(null);
    name.setDisabled(disabled);
    mood.setDisabled(disabled);
    levelsOn.setDisabled(disabled);
    levelsRange.setDisabled(disabled || !levels || some);
  }

  // ---- the action of the "from spawns" buttons (this panel's and the inspector's)

  // given: region items; map.fallback may be among them. Without any, the selected regions.
  async function levelsFromSpawns(given) {
    const map = store.map;
    if (!map) return;
    const args = Array.isArray(given) && given.length ? given : selectedRegions();
    const asked = args.filter((r) => store.kindOf(r) === 'region'), fallback = args.includes(map.fallback);
    const list = editable(ctx, asked);
    if (fallback && !layerOpen()) { refuseLayer(); return; }
    if (!list.length && !fallback) {
      ui.toast(asked.length ? 'The region is locked or hidden: unlock it to edit it' : 'Select a region first', 'warn');
      return;
    }
    if (store.grouping) { ui.toast(BUSY, 'warn'); return; }
    // Another owner's helper: loaded here, where it is needed, so that this panel loads whatever state that file is in.
    let helper;
    try {
      ({ levelsFromSpawns: helper } = await import('../spawnstats.js'));
      if (typeof helper !== 'function') throw new TypeError('spawnstats.js has no levelsFromSpawns');
    } catch (err) {
      console.warn('[editor] region.levelsFromSpawns: spawnstats.js is not available', err);
      ui.toast('Levels from spawns are not available yet', 'warn');
      return;
    }
    if (store.map !== map || store.grouping) return;   // the page went on while the module loaded: another map, an open edit
    const band = (lv) => (Array.isArray(lv) && lv.length === 2 && Number.isInteger(lv[0]) && Number.isInteger(lv[1]) && lv[0] <= lv[1] ? [lv[0], lv[1]] : null);
    // named: what gets levels, as { name, levels } - plain data, because setProps replaces the fallback object
    const items = [], patches = [], named = [], empty = [];
    let fallbackLevels = null;
    try {
      for (const region of list) {
        if (store.kindOf(region) !== 'region') continue;
        const lv = band(helper(map, region));
        if (lv) { items.push(region); patches.push({ levels: lv }); named.push({ name: region.name, levels: lv }); } else empty.push(region);
      }
      if (fallback) {
        fallbackLevels = band(helper(map, map.fallback));
        if (fallbackLevels) named.push({ name: map.fallback.name, levels: fallbackLevels });
        else empty.push(map.fallback);
      }
    } catch (err) {
      console.warn('[editor] region.levelsFromSpawns failed', err);
      ui.toast('Levels from spawns are not available yet', 'warn');
      return;
    }
    if (!named.length) {
      ui.toast(empty.length === 1 ? `No spawn has its centre in "${empty[0].name}"` : 'No spawn has its centre in the selected regions', 'warn');
      return;
    }
    store.begin(`Set the levels of ${plural(named.length, 'region')} from spawns`);
    let changed;
    try {
      if (items.length) store.exec(cmd.setEach(items, patches));
      if (fallbackLevels) store.exec(cmd.setProps({ fallback: { levels: fallbackLevels } }));
    } finally {
      changed = store.commit();
    }
    const what = named.length === 1 ? `"${named[0].name}": ${levelsText(named[0].levels)}` : plural(named.length, 'region');
    ui.toast(`${changed ? 'Levels set from spawns' : 'The levels already match the spawns'} \u00b7 ${what}${empty.length ? ` \u00b7 ${plural(empty.length, 'region')} without spawns left alone` : ''}`);
  }
  if (!actions.has('region.levelsFromSpawns')) actions.register('region.levelsFromSpawns', levelsFromSpawns);

  // ---- refresh

  function render() {
    if (press?.dragging) { stale = true; return; }   // the row under the pointer must stay the same element
    stale = false;
    renderHead();
    renderList();
    syncForm();
    keepInView();
  }
  const refresh = rafThrottle(render);

  // A region selected in the viewport is brought into view in the list - inside the list only: the right column
  // must not jump because of it.
  let shown = null;
  function keepInView() {
    const first = selectedRegions()[0] ?? null;
    if (first === shown) return;
    shown = first;
    if (!first) return;
    for (const [node, entry] of rows) {
      if (entry.region !== first) continue;
      if (node.offsetTop < list.scrollTop) list.scrollTop = node.offsetTop;
      else if (node.offsetTop + node.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = node.offsetTop + node.offsetHeight - list.clientHeight;
      return;
    }
  }

  // ---- the pointer on the list: click, double-click, drag to reorder

  const regionNodes = () => [...rows].filter(([, entry]) => entry.region).map(([node]) => node);

  // -> the slot the pointer is over: 0 = above the first region row ... n = below the last one
  function slotAt(clientY) {
    const nodes = regionNodes();
    for (let k = 0; k < nodes.length; k++) {
      const r = nodes[k].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return k;
    }
    return nodes.length;
  }

  function showDrop(slot) {
    const nodes = regionNodes(), last = nodes[nodes.length - 1];
    const y = slot < nodes.length ? nodes[slot].offsetTop : last.offsetTop + last.offsetHeight;
    drop.style.top = `${y - 1}px`;
    drop.hidden = false;
  }

  function endPress() {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onCancel, true);
    const p = press;
    press = null;
    if (!p) return null;
    p.el.classList.remove('dragging');
    list.classList.remove('reordering');
    drop.hidden = true;
    return p;
  }

  function onMove(ev) {
    const p = press;
    if (!p || ev.pointerId !== p.id) return;
    if (!p.dragging) {
      if (Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < DRAG_PX) return;
      // the fallback has no place to go; a locked row and a locked layer stay where they are
      if (!p.region || !ui.isPickable('region', p.region) || store.grouping) { p.dead = true; return; }
      p.dragging = true;
      p.el.classList.add('dragging');
      list.classList.add('reordering');
    }
    const box = list.getBoundingClientRect();
    if (ev.clientY < box.top + SCROLL_EDGE) list.scrollTop -= 12;
    else if (ev.clientY > box.bottom - SCROLL_EDGE) list.scrollTop += 12;
    p.slot = slotAt(ev.clientY);
    showDrop(p.slot);
  }

  function onUp(ev) {
    if (!press || ev.pointerId !== press.id) return;
    const p = endPress();
    if (p.dragging) {
      const n = store.map?.regions.length ?? 0, from = store.indexOf(p.region);
      if (from >= 0 && p.slot != null) reorder(p.region, dropIndex(n, from, p.slot));
    } else if (!p.dead) click(p);
    if (stale || p.dragging) render();
  }

  function onCancel(ev) {
    if (!press || ev.pointerId !== press.id) return;
    const p = endPress();
    if (stale || p.dragging) render();
  }

  function click(p) {
    if (!p.region) {
      fallbackOpen = !fallbackOpen;
      render();
      return;
    }
    if (store.kindOf(p.region) !== 'region') return;   // deleted in the meantime
    fallbackOpen = false;
    if (p.toggle) store.select([p.region], { toggle: true });
    else store.select([p.region]);
    render();   // also when the selection did not change: the form may have shown the fallback
  }

  list.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || press) return;
    const node = ev.target.closest?.('.row');
    const entry = node && rows.get(node);
    if (!entry || ev.target.closest('button')) return;   // the buttons of a row are their own business
    press = { el: node, region: entry.region, index: entry.index, x: ev.clientX, y: ev.clientY, id: ev.pointerId, toggle: ev.shiftKey || mod(ev), dragging: false, dead: false, slot: null };
    // on the window: the pointer may leave the list during a drag, and a row that is rebuilt would lose a capture
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
  });
  list.addEventListener('dblclick', (ev) => {
    const node = ev.target.closest?.('.row'), entry = node && rows.get(node);
    if (!entry?.region || ev.target.closest('button') || store.kindOf(entry.region) !== 'region') return;
    viewport.focus([entry.region]);
  });

  // ---- wiring

  el.replaceChildren(head, list, hint, form, idle);

  const touches = (change) => change.added.regions.length || change.removed.regions.length || change.updated.regions.length
    || change.order.includes('regions') || change.props.includes('fallback');
  store.on('load', () => {   // another map: its regions are other objects, and so is its fallback
    fallbackOpen = false;
    shown = null;
    endPress();
    refresh();
  });
  store.on('change', (change) => { if (touches(change)) refresh(); });
  store.on('selection', () => {
    fallbackOpen = false;   // what was picked is what the form shows
    refresh();
  });
  ui.on('itemflags', refresh);
  ui.on('layers', refresh);
  ui.on('overlays', refresh);
  ui.on('preview', refresh);
  render();
  return {};
}
