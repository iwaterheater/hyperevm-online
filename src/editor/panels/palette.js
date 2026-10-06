import { h, button, leaveField } from '../ui/dom.js';
import { hintFor, mod } from '../keymap.js';
import { CATEGORIES, MODELS, PACKS, modelInfo } from '../../map/catalog.js';
import { createThumbs } from '../thumbs.js';
import { clipSize, deleteStamp, exportStamps, importStamps, listStamps, readClip, renameStamp, stampName, subscribe } from '../clipboard.js';

// The palette (#palette, the left column): what can be put on the map.
//
//   Models  every model of the catalog as a tile - grouped by pack, then by category - with a search box, favourites
//           and the models used recently. A click arms the Place tool with the model (ui.models = [id]);
//           Mod+click adds or removes one, Shift+click adds a range: several models for the Scatter brush.
//           Hovering a tile shows the model large and turning, with its size in world units and what it blocks.
//   Stamps  named clips kept in the browser: place, rename, delete, and export / import of the whole set as a file.
//           The clipboard is shown there too.
//
// The panel only writes ui.models and runs actions (tool.place, stamp.save, stamp.place, edit.paste): placing is the
// business of the tools. Thumbnails are drawn by thumbs.js when a tile scrolls into view; until then a tile shows
// the model's name on the colour of its category. Model ids, stamp names and file contents reach the page as text
// nodes only.

const PREFS_KEY = 'hypercat-editor-palette';   // { v: 1, favourites: [id], recent: [id], tab } (+ the Place tool's yOffset)
const RECENT_MAX = 12;
const HOVER_MS = 280;          // the cursor rests this long on a tile before the large preview opens
const PREVIEW_PX = 220;
const SCAN_MS = 250;
const IMPORT_MAX = 20e6;       // bytes of a stamp file we are willing to read
const CAT_LABELS = {
  buildings: 'Buildings', walls: 'Walls and fences', trees: 'Trees', rocks: 'Rocks and hills', props: 'Props',
  graves: 'Graves', lights: 'Lights', ruins: 'Ruins', foliage: 'Foliage', special: 'Special',
};
const KIND_WORDS = [['objects', 'object'], ['spawns', 'spawn'], ['chests', 'chest'], ['npcs', 'NPC']];

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v, digits = 1) => String(Number(v.toFixed(digits)));
const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

// '12 objects, 1 spawn' - what a clip holds
function contents(clip) {
  return KIND_WORDS.filter(([list]) => clip[list].length).map(([list, word]) => plural(clip[list].length, word)).join(', ');
}

// What a model blocks, in words, from the catalog's rule and the loaded model's size (world units at scale 1).
function colliderText(info, model) {
  const c = info.col, w = model.size.x, d = model.size.z, r = Math.max(w, d) / 2;
  const circle = (factor) => `circle, radius ${num(factor * r, 2)}`;
  if (Array.isArray(c)) return c.length === 1 ? `circle, radius ${num(c[0].r * info.scale, 2)}` : `${c.length} circles`;
  if (c === 'box') return `box ${num(w)} × ${num(d)}`;
  if (c === 'auto') {   // a file the catalog does not list: the rule of catalog.colliderOf
    if (r < 0.6) return 'none (small: walk-through)';
    return Math.max(w, d) >= 2.5 * Math.min(w, d) ? `box ${num(w)} × ${num(d)} (automatic)` : `${circle(0.45)} (automatic)`;
  }
  return typeof c === 'number' && c > 0 ? circle(c) : 'none (walk-through)';
}

export default function mount(el, ctx) {
  const { ui, store, actions } = ctx;
  const thumbs = createThumbs(ctx);

  // ---------------------------------------------------------------- the catalog as the palette shows it

  const known = new Set(ctx.models ?? []);
  const entries = (ctx.models ?? []).map((id) => {
    const info = modelInfo(id);
    if (!info) return null;
    const cat = Object.hasOwn(MODELS, id) ? info.cat : null;   // a file without a catalog entry: Uncategorised
    const pack = PACKS[info.pack]?.label ?? info.pack;
    return { id, info, cat, pack, text: `${id} ${info.label} ${cat ? CAT_LABELS[cat] ?? cat : 'uncategorised'} ${pack}`.toLowerCase() };
  }).filter(Boolean);
  const byId = new Map(entries.map((e) => [e.id, e]));

  // ---------------------------------------------------------------- what the browser remembers

  function readPrefs() {
    try {
      const raw = JSON.parse(globalThis.localStorage?.getItem(PREFS_KEY) ?? 'null');
      return isObj(raw) ? raw : {};
    } catch { return {}; }
  }
  const idList = (v, max) => (Array.isArray(v) ? [...new Set(v.filter((id) => typeof id === 'string' && known.has(id)))].slice(0, max) : []);
  const stored = readPrefs();
  const prefs = {
    favourites: idList(stored.favourites, 500),
    recent: idList(stored.recent, RECENT_MAX),
    tab: stored.tab === 'stamps' ? 'stamps' : 'models',
  };
  // Our keys are merged into what is stored: the Place tool keeps its Y offsets under the same key.
  function savePrefs() {
    try {
      globalThis.localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), v: 1, ...prefs }));
    } catch { /* full or disabled: the palette works without remembering */ }
  }

  // ---------------------------------------------------------------- tiles and thumbnails

  const nodes = new Map();        // id -> Set of elements that show the model (its tile, its chips)
  const unasked = new Set();      // elements whose thumbnail has not been asked for yet
  const asked = new Set();        // ids whose thumbnail was asked for
  let ioAlive = false, lastScan = 0;

  function setShot(node, url) {
    const box = node.firstElementChild;
    if (box.classList.contains('ready')) return;
    box.append(h('img', { class: 'shot', src: url, alt: '', draggable: false }));
    box.classList.add('ready');
  }
  function want(node) {
    const id = node.dataset.id;
    unasked.delete(node);
    observer?.unobserve(node);
    const url = thumbs.url(id);
    if (url) { setShot(node, url); return; }
    if (asked.has(id)) return;   // when it arrives, every element of the id gets it
    asked.add(id);
    thumbs.get(id).then((ready) => {
      for (const n of nodes.get(id) ?? []) setShot(n, ready);
    }, () => { /* no WebGL for thumbnails: the name on its colour stays */ });
  }
  // Tiles ask for their thumbnail when they scroll into view.
  let observer = null;
  function track(node) {
    const id = node.dataset.id;
    if (!nodes.has(id)) nodes.set(id, new Set());
    nodes.get(id).add(node);
    const url = thumbs.url(id);
    if (url) { setShot(node, url); return; }
    unasked.add(node);
    observer?.observe(node);
  }
  function untrack(node) {
    nodes.get(node.dataset.id)?.delete(node);
    unasked.delete(node);
    observer?.unobserve(node);
  }
  // A page that is not being shown gets no IntersectionObserver callbacks (a background tab, a pane driven by a
  // script): then the same question is answered by measuring, a few times a second at most.
  function scan(force = false) {
    if (ioAlive && !document.hidden) return;
    const now = performance.now();
    if (!force && now - lastScan < SCAN_MS) return;
    lastScan = now;
    if (!unasked.size || models.hidden) return;
    const box = scroll.getBoundingClientRect();
    if (!box.height) return;
    for (const node of [...unasked]) {
      const r = node.getBoundingClientRect();
      if (r.height && r.bottom > box.top - 200 && r.top < box.bottom + 200) want(node);
    }
  }

  function thumbBox(entry, small) {
    return h('div', { class: 'thumb' }, h('span', { class: 'name' }, small ? entry.info.name : entry.info.label));
  }
  function makeTile(entry) {
    const star = h('span', { class: 'star', role: 'button', title: 'Favourite', 'aria-label': 'Favourite' }, '★');
    // no title: the large preview names the model, and a tooltip on top of it would only be in the way
    return h('div', { class: 'tile', role: 'option', 'aria-label': entry.id, dataset: { id: entry.id, cat: entry.cat ?? 'none' } },
      thumbBox(entry, false), h('div', { class: 'caption' }, entry.info.label), star);
  }
  function makeChip(entry) {
    return h('div', { class: 'chip', role: 'option', 'aria-label': entry.id, dataset: { id: entry.id, cat: entry.cat ?? 'none' } }, thumbBox(entry, true));
  }

  // ---------------------------------------------------------------- static DOM: the Models tab

  const tabs = [['models', 'Models'], ['stamps', 'Stamps']].map(([id, label]) => {
    const count = h('span', { class: 'n' });
    const node = h('button', { type: 'button', class: 'ui-tab', role: 'tab', dataset: { tab: id } }, label, count);
    node.addEventListener('mousedown', (ev) => { ev.preventDefault(); leaveField(); });   // a tab never takes the keys away
    node.addEventListener('click', () => showTab(id));
    return { id, node, count };
  });

  const search = h('input', {
    type: 'search', class: 'ui-input ui-text', placeholder: `Search ${entries.length} models`, autocomplete: 'off', spellcheck: false,
    'aria-label': 'Search models', title: 'Search by name, category or pack. Several words narrow the search',
  });
  const found = h('span', { class: 'count' });
  const picked = h('span', { class: 'what' });
  const pickedBar = h('div', { class: 'picked', hidden: true }, picked,
    button('Clear', () => ui.set('models', []), { title: 'Select no model' }));

  const favChips = h('div', { class: 'chips', role: 'listbox', 'aria-label': 'Favourites' });
  const recentChips = h('div', { class: 'chips', role: 'listbox', 'aria-label': 'Recent' });
  const favSection = h('div', { class: 'shortcuts', hidden: true }, h('div', { class: 'cat' }, '★ Favourites'), favChips);
  const recentSection = h('div', { class: 'shortcuts', hidden: true }, h('div', { class: 'cat' }, 'Recent'), recentChips);

  // pack -> category -> tiles, in the order of the catalog; files the catalog does not list come last
  const tiles = new Map();        // id -> tile
  const sections = [];            // { node, cats: [{ node, count, ids }] }
  const section = (title, groups) => {
    const cats = groups.filter((g) => g.list.length).map((g) => {
      const count = h('span', { class: 'n' }, String(g.list.length));
      const grid = h('div', { class: 'grid', role: 'listbox', 'aria-label': `${title}: ${g.title}` });
      for (const entry of g.list) {
        const tile = makeTile(entry);
        tiles.set(entry.id, tile);
        grid.append(tile);
      }
      return { node: h('div', { class: 'group' }, h('div', { class: 'cat' }, g.title, count), grid), count, ids: g.list.map((e) => e.id), total: g.list.length };
    });
    if (!cats.length) return;
    sections.push({ node: h('div', { class: 'section' }, h('div', { class: 'pack' }, title), cats.map((c) => c.node)), cats });
  };
  for (const key of Object.keys(PACKS)) {
    const own = entries.filter((e) => e.info.pack === key && e.cat);
    section(PACKS[key].label, CATEGORIES.map((cat) => ({ title: CAT_LABELS[cat] ?? cat, list: own.filter((e) => e.cat === cat) })));
  }
  section('Uncategorised', Object.keys(PACKS).map((key) => ({ title: PACKS[key].label, list: entries.filter((e) => e.info.pack === key && !e.cat) })));

  const empty = h('div', { class: 'ui-empty', hidden: true });
  const scroll = h('div', { class: 'scroll' }, favSection, recentSection, sections.map((s) => s.node), empty);
  const modKey = hintFor('edit.copy').replace(/C$/, '').replace(/\+$/, '') || 'Ctrl';
  const models = h('div', { class: 'pane', dataset: { pane: 'models' } },
    h('div', { class: 'bar' }, search, found),
    pickedBar, scroll,
    h('div', { class: 'foot ui-hint' }, `Click: place · ${modKey}-click or Shift-click: several, for Scatter · ★: favourite`));

  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver((list) => {
      ioAlive = true;
      for (const entry of list) if (entry.isIntersecting) want(entry.target);
    }, { root: scroll, rootMargin: '200px 0px' });
  }
  for (const tile of tiles.values()) track(tile);

  // ---------------------------------------------------------------- selection, favourites, recent

  let anchor = null;              // the tile a Shift+click extends from
  let marked = new Set();

  function mark() {
    const list = Array.isArray(ui.models) ? ui.models : [], next = new Set(list), first = list[0] ?? null;
    for (const id of new Set([...marked, ...next])) {
      for (const node of nodes.get(id) ?? []) {
        node.classList.toggle('selected', next.has(id));
        node.classList.toggle('primary', id === first);
        node.setAttribute('aria-selected', String(next.has(id)));
      }
    }
    marked = next;
    pickedBar.hidden = list.length < 2;
    if (list.length >= 2) picked.textContent = `${list.length} models selected: Scatter uses all, Place the first`;
  }

  // The chips of a shortcut row, rebuilt. The list below keeps its place on screen when the row grows or goes.
  function fill(box, sectionNode, ids) {
    const before = scroll.scrollHeight, top = scroll.scrollTop;
    for (const chip of [...box.children]) untrack(chip);
    box.replaceChildren();
    for (const id of ids) {
      const entry = byId.get(id);
      if (!entry) continue;
      const chip = makeChip(entry);
      box.append(chip);
      track(chip);
    }
    sectionNode.hidden = !box.children.length || searching();
    if (top > 0) scroll.scrollTop = top + (scroll.scrollHeight - before);
    marked = new Set();   // the new chips have no marks yet
    mark();
  }
  function showStars() {
    const fav = new Set(prefs.favourites);
    for (const [id, tile] of tiles) {
      const star = tile.lastElementChild, on = fav.has(id);
      star.classList.toggle('on', on);
      star.title = on ? 'Remove from the favourites' : 'Add to the favourites';
      star.setAttribute('aria-pressed', String(on));
    }
  }
  function toggleFavourite(id) {
    const i = prefs.favourites.indexOf(id);
    if (i >= 0) prefs.favourites.splice(i, 1);
    else prefs.favourites.push(id);
    savePrefs();
    showStars();
    fill(favChips, favSection, prefs.favourites);
  }
  // A model that is armed becomes "recent". One that is in the row already keeps its place: the row must not
  // reshuffle under the cursor that just clicked it.
  function noteRecent(ids) {
    const fresh = ids.filter((id) => known.has(id) && !prefs.recent.includes(id));
    if (!fresh.length) return;
    prefs.recent = [...fresh.reverse(), ...prefs.recent].slice(0, RECENT_MAX);
    savePrefs();
    fill(recentChips, recentSection, prefs.recent);
  }

  // The Place tool, unless its layer is closed - then the reason, as the toolbar would give it.
  function enterPlace() {
    if (!actions.has('tool.place')) { ui.set('tool', 'place'); return; }
    if (actions.run('tool.place')) return;
    const l = ui.layers?.objects;
    if (l && (!l.visible || l.locked)) ui.toast(`Layer ${l.visible ? 'locked' : 'hidden'}: objects`, 'warn');
  }

  // The visible tiles from one id to another, in the order of the page (the tiles are grouped, not sorted by id).
  function range(from, to) {
    const list = [...tiles.values()].filter((t) => !t.hidden).map((t) => t.dataset.id);
    const a = list.indexOf(from), b = list.indexOf(to);
    if (a < 0 || b < 0) return [to];
    return list.slice(Math.min(a, b), Math.max(a, b) + 1);
  }

  function choose(id, ev) {
    const now = Array.isArray(ui.models) ? ui.models : [];
    if (ev.shiftKey || mod(ev)) {
      // several models: what the Scatter brush paints with. The tool is left alone.
      let next;
      if (ev.shiftKey && anchor && anchor !== id) next = [...new Set([...now, ...range(anchor, id)])];
      else next = now.includes(id) ? now.filter((m) => m !== id) : [...now, id];
      anchor = id;
      ui.set('models', next);
      return;
    }
    anchor = id;
    ui.set('models', [id]);
    if (ui.tool !== 'scatter' && ui.tool !== 'place') enterPlace();
  }

  // ---------------------------------------------------------------- search

  const searching = () => search.value.trim() !== '';

  function filter() {
    const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const s of sections) {
      let inSection = 0;
      for (const c of s.cats) {
        let n = 0;
        for (const id of c.ids) {
          const hit = words.every((w) => byId.get(id).text.includes(w));
          tiles.get(id).hidden = !hit;
          if (hit) n++;
        }
        c.node.hidden = n === 0;
        c.count.textContent = n === c.total ? String(n) : `${n} / ${c.total}`;
        inSection += n;
      }
      s.node.hidden = inSection === 0;
      shown += inSection;
    }
    const active = words.length > 0;
    favSection.hidden = active || !favChips.children.length;
    recentSection.hidden = active || !recentChips.children.length;
    found.textContent = active ? `${shown} of ${entries.length}` : '';
    empty.hidden = shown > 0;
    if (!shown) empty.textContent = entries.length ? `No model matches "${search.value.trim()}"` : 'The server reported no models';
    scan(true);
  }
  search.addEventListener('input', filter);

  // ---------------------------------------------------------------- the large preview

  const view = h('canvas', { class: 'view' });
  const facts = { title: h('div', { class: 'title' }), id: h('div', { class: 'id ui-mono' }), size: h('span'), col: h('span'), more: h('span') };
  const preview = h('div', { class: 'preview', hidden: true },
    view, facts.title, facts.id,
    h('div', { class: 'fact' }, h('span', { class: 'ui-dim' }, 'Size '), facts.size),
    h('div', { class: 'fact' }, h('span', { class: 'ui-dim' }, 'Collider '), facts.col),
    h('div', { class: 'fact ui-dim' }, facts.more));
  let hoverId = null, hoverTimer = 0, stopSpin = null;

  function hidePreview() {
    clearTimeout(hoverTimer);
    hoverTimer = 0;
    hoverId = null;
    stopSpin?.();
    stopSpin = null;
    preview.hidden = true;
  }
  function showPreview(node) {
    const id = node.dataset.id, entry = byId.get(id);
    if (!entry || !node.isConnected) return;
    stopSpin?.();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    view.width = view.height = Math.round(PREVIEW_PX * ratio);
    preview.dataset.cat = entry.cat ?? 'none';
    facts.title.textContent = entry.info.label;
    facts.id.textContent = id;
    facts.size.textContent = facts.col.textContent = '…';
    const where = `${entry.cat ? CAT_LABELS[entry.cat] ?? entry.cat : 'Uncategorised'} · ${entry.pack}`;
    facts.more.textContent = where;
    preview.hidden = false;
    // beside the palette, level with the tile, inside the window
    const tile = node.getBoundingClientRect(), column = el.getBoundingClientRect(), height = preview.offsetHeight;
    preview.style.left = `${Math.round(column.right + 8)}px`;
    preview.style.top = `${Math.round(Math.max(8, Math.min(window.innerHeight - height - 8, tile.top + tile.height / 2 - height / 2)))}px`;
    stopSpin = thumbs.spin(id, view);
    ctx.view.loadModel(id).then((model) => {
      if (hoverId !== id || preview.hidden) return;
      const s = model.size;
      facts.size.textContent = model.missing ? 'the model failed to load' : `${num(s.x)} × ${num(s.y)} × ${num(s.z)} (w × h × d)`;
      facts.col.textContent = model.missing ? '—' : colliderText(entry.info, model);
      facts.more.textContent = model.missing ? where : `${where} · ${model.triangles.toLocaleString('en-US')} triangles`;
    });
  }
  function hover(node) {
    const id = node?.dataset.id ?? null;
    if (id === hoverId) return;
    if (!id) { hidePreview(); return; }
    const open = !preview.hidden;
    clearTimeout(hoverTimer);
    hoverId = id;
    if (open) showPreview(node);   // already looking: the next tile shows at once
    else hoverTimer = setTimeout(() => { if (hoverId === id) showPreview(node); }, HOVER_MS);
  }

  scroll.addEventListener('pointerover', (ev) => {
    if (ev.pointerType === 'touch') return;
    hover(ev.target.closest?.('[data-id]') ?? null);
  });
  scroll.addEventListener('pointerleave', hidePreview);
  scroll.addEventListener('scroll', () => { hidePreview(); scan(); }, { passive: true });
  scroll.addEventListener('click', (ev) => {
    const node = ev.target.closest?.('[data-id]');
    if (!node) return;
    if (ev.target.closest('.star')) { toggleFavourite(node.dataset.id); return; }
    choose(node.dataset.id, ev);
  });
  window.addEventListener('blur', hidePreview);

  // ---------------------------------------------------------------- the Stamps tab

  const saveStampButton = button('Save selection as stamp…', () => actions.run('stamp.save'), { title: 'Keep the selected objects, spawns, chests and NPCs as a named stamp' });
  const pasteKey = hintFor('edit.paste');
  const clipText = h('span', { class: 'what' });
  const clipPaste = button(pasteKey ? ['Paste', h('kbd', { class: 'ui-kbd' }, pasteKey)] : 'Paste', () => actions.run('edit.paste'), { title: 'Place what was copied' });
  const stampList = h('div', { class: 'ui-list list' });
  const stampEmpty = h('div', { class: 'ui-empty' }, 'No stamps yet. Select a few objects - a gate, a camp with its monsters - and save them as a stamp to place them again and again.');
  const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true, tabIndex: -1 });
  const importButton = button('Import…', () => { file.value = ''; file.click(); }, { title: 'Add the stamps of a file that Export wrote' });
  const exportButton = button('Export', () => exportFile(), { title: 'Download every stamp as one JSON file' });
  const stamps = h('div', { class: 'pane', dataset: { pane: 'stamps' }, hidden: true },
    h('div', { class: 'bar' }, saveStampButton),
    h('div', { class: 'clip' }, clipText, clipPaste),
    h('div', { class: 'scroll' }, stampEmpty, stampList),
    h('div', { class: 'bar end' }, importButton, exportButton, file),
    h('div', { class: 'foot ui-hint' }, 'Click a stamp to place it. Stamps are kept in this browser: export them to keep them safe or to share them.'));

  async function rename(name) {
    const typed = await ui.prompt(`Rename the stamp "${name}"`, name);
    if (typed === null) return;
    const next = stampName(typed);
    if (next === null) { ui.toast('A stamp name is 1 to 48 characters', 'warn'); return; }
    try {
      renameStamp(name, next);
    } catch (err) {
      ui.toast(String(err?.message ?? err), 'warn');
    }
  }
  async function remove(name) {
    if (!(await ui.confirm(`Delete the stamp "${name}"?`, { ok: 'Delete' }))) return;
    try {
      if (deleteStamp(name)) ui.toast(`Deleted the stamp "${name}"`);
    } catch (err) {
      ui.toast(String(err?.message ?? err), 'error');
    }
  }
  const guard = (promise) => promise.catch((err) => console.error('[editor] palette: a stamp action failed', err));

  function exportFile() {
    const text = exportStamps(), url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = h('a', { href: url, download: 'hypercat-stamps.json', hidden: true });
    el.append(link);   // inside our own container; gone again at once
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  file.addEventListener('change', () => {
    const picked2 = file.files?.[0];
    if (!picked2) return;
    if (picked2.size > IMPORT_MAX) { ui.toast('That file is too large to be a stamp file', 'error'); return; }
    picked2.text().then((text) => {
      const n = importStamps(text);
      ui.toast(n ? `Imported ${plural(n, 'stamp')}` : 'No new stamps in that file', n ? 'info' : 'warn');
    }).catch((err) => {
      ui.toast(err instanceof SyntaxError ? 'That file is not JSON' : String(err?.message ?? 'The file could not be read'), 'error');
    });
  });

  function drawStamps() {
    let list = [];
    try { list = listStamps(); } catch { list = []; }
    tabs[1].count.textContent = list.length ? ` ${list.length}` : '';
    stampEmpty.hidden = list.length > 0;
    exportButton.disabled = list.length === 0;
    stampList.replaceChildren(...list.map(({ name, clip }) => {
      const edit = button('✎', () => guard(rename(name)), { title: 'Rename' });
      const del = button('✕', () => guard(remove(name)), { title: 'Delete', danger: true });
      edit.classList.add('flat', 'icon');
      del.classList.add('flat', 'icon');
      const item = h('div', { class: 'ui-item stamp', title: `Place "${name}": ${contents(clip)}` },
        h('span', { class: 'name' }, name), h('span', { class: 'n' }, String(clipSize(clip))), edit, del);
      item.addEventListener('click', (ev) => {
        if (ev.target.closest('.ui-button')) return;
        actions.run('stamp.place', name);
      });
      return item;
    }));
  }
  function drawClip() {
    let clip = null;
    try { clip = readClip(); } catch { clip = null; }
    clipText.textContent = clip ? `Clipboard: ${contents(clip)}` : 'Clipboard: empty';
    clipPaste.disabled = !clip;
  }
  // Save needs something that can be kept: objects, spawns, chests or NPCs in the selection.
  function drawSave() {
    let ok = false;
    for (const item of store.selection) {
      const kind = store.kindOf(item);
      if (kind === 'object' || kind === 'spawn' || kind === 'chest' || kind === 'npc') { ok = true; break; }
    }
    saveStampButton.disabled = !ok;
    saveStampButton.title = ok ? 'Keep the selected objects, spawns, chests and NPCs as a named stamp'
      : 'Select objects, spawns, chests or NPCs first';
  }

  // ---------------------------------------------------------------- tabs

  function showTab(id) {
    const tab = id === 'stamps' ? 'stamps' : 'models';
    for (const t of tabs) {
      t.node.classList.toggle('active', t.id === tab);
      t.node.setAttribute('aria-selected', String(t.id === tab));
    }
    models.hidden = tab !== 'models';
    stamps.hidden = tab !== 'stamps';
    hidePreview();
    if (tab === 'stamps') { drawStamps(); drawClip(); drawSave(); }
    else scan(true);
    if (prefs.tab !== tab) {
      prefs.tab = tab;
      savePrefs();
    }
  }

  // ---------------------------------------------------------------- start

  el.replaceChildren(h('div', { class: 'ui-tabs', role: 'tablist' }, tabs.map((t) => t.node)), models, stamps, preview);

  ui.on('models', (list) => {
    mark();
    if (Array.isArray(list) && list.length) noteRecent(list);
  });
  store.on('selection', drawSave);
  subscribe((what) => {
    if (what === 'stamps') drawStamps();
    else drawClip();
  });

  showStars();
  fill(favChips, favSection, prefs.favourites);
  fill(recentChips, recentSection, prefs.recent);
  filter();
  drawStamps();
  drawClip();
  drawSave();
  showTab(prefs.tab);
  mark();

  return {
    // every rendered frame: the thumbnail queue moves with the viewport's tick as well as on its own
    update() {
      thumbs.pump();
      scan();
    },
    thumbs,
  };
}
