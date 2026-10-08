import { LIMITS, MapError, emptyMap, maxRadius, normalize, serialize, stringifyMap, validate } from '../map/format.js';
import { h, button, leaveField } from './ui/dom.js';

// The file side of the editor that is not Save (#menu-io): New, Import, Export, Revert, Maps - and what guards unsaved work:
// the autosave draft, its restore offer when the editor starts, the dot in the tab title and the "leave this page?"
// question of the browser.
//
//   file.new      an empty island replaces the map in the editor (the server's map changes only on Save)
//   file.import   a .json file: parsed, decoded (normalize with check: false) and loaded as unsaved work. A file that
//                 does not decode shows its first issues and loads nothing; a map with RANGE errors loads, the Issues
//                 panel lists them and Save stays disabled until they are fixed. A .json dropped on the window is
//                 imported the same way. actions.run('file.import', file) takes a File or Blob directly (scripts).
//   file.export   downloads stringifyMap(serialize(map, { check: false })) as '<map name>.json' - byte for byte what
//                 Save would write, also for work in progress
//   file.revert   loads the server's map again (asks first when there are unsaved changes)
//   file.library  opens the Maps menu: the map library of the server (map/library/) - named copies of a map to go
//                 back to or to compare with. A click on one loads it as unsaved work, exactly like an import: the game
//                 keeps running its own map until Save makes this one the live map. Until it is edited it is nobody's
//                 unsaved work: it is replaced without a question, writes no draft and lets the tab close. The entry
//                 that IS the live map loads like Revert. "Keep a copy" stores the map in the editor under a name (a map with errors is
//                 refused, as on Save). actions.run('file.library', id) opens that map directly (scripts).
//
// The draft: 3 s after the last change the map is written to localStorage['hypercat-editor-draft'] as
// { rev, at, map } - never while an edit is open, and never while nothing is unsaved (Save removes the draft itself,
// in net.js, and a timer that fires just after must not bring it back). It is offered on the first map the editor
// loads. Restoring is exactly an import, so a draft made while the map had errors - the states in which Save is
// disabled and the draft is the only copy - comes back with its errors listed.
//
// A draft is unsaved work, possibly the only copy of it: it leaves the storage when the user says Restore or Discard,
// and for no other reason. A draft that was offered and not answered (Esc) is KEPT: it stays where it is, a button in
// the menu bar ("Draft 14:02?") asks again at any time, no save, revert or reload removes it (net.draftKept), and this
// page writes no draft of its own over it - so the question comes back by itself once, as soon as this page has
// unsaved changes that would need the place.
//
// Backups are the server's business: it copies the map file into map/backups/ before every save that changes it, and
// no endpoint serves them, so there is nothing for this module to list.

const DRAFT_KEY = 'hypercat-editor-draft';
const DRAFT_MS = 3000;             // after the last change
const DRAFT_RETRY_MS = 1000;       // an edit was still open when the draft was due: look again
const ISSUES_SHOWN = 10;
const MAX_FILE = 4 * LIMITS.bodyBytes;   // a file beyond this is not a map of ours; reading it would only freeze the page
const BUSY = 'Finish the current edit first';

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const sizeOf = (map) => `${count(map.objects.length, 'object')} \u00b7 ${count(map.spawns.length, 'spawn')}`;
const canonical = (map) => stringifyMap(serialize(map, { check: false }));

// 'HH:MM' for a time of today, with the day in front of it for an older one.
function clock(at) {
  if (!Number.isFinite(at) || at <= 0) return 'an unknown time';
  const d = new Date(at), time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
}

// '<map name>.json', without the characters a file name cannot have on one system or another.
function fileName(name) {
  const safe = String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '-').replace(/^[\s.-]+|[\s.-]+$/g, '').slice(0, 64);
  return `${safe || 'map'}.json`;
}

export default function mount(el, ctx) {
  const { store, ui, net, actions } = ctx;
  const baseTitle = document.title.replace(/^\u2022\s*/, '') || 'HyperEVM Map Editor';

  const errorsOf = (map) => validate(map, { models: ctx.modelSet ?? null, strictModels: true }).filter((i) => i.level === 'error');
  const openIssues = () => { if (actions.has('validation.open')) actions.run('validation.open'); };
  const dialogOpen = () => { const m = document.getElementById('modal'); return !!m && !m.hidden; };

  // The rule of every file action: a field that is being typed in commits first, and an edit that is still open
  // (a grab, a drag, a path) stops the action - a file must never hold half an edit. -> true when the map is settled
  const settled = () => {
    if (!leaveField()) document.activeElement?.blur?.();
    if (!store.map) return false;
    if (store.grouping) { ui.toast(BUSY, 'warn'); return false; }
    return true;
  };

  // What comes after a map with RANGE errors was loaded: say so, and show where they are.
  const reportErrors = (map, what) => {
    const errors = errorsOf(map);
    if (!errors.length) return;
    ui.toast({
      text: `${what} has ${count(errors.length, 'error')}: Save is disabled until ${errors.length === 1 ? 'it is' : 'they are'} fixed`,
      action: { label: 'Show issues', run: openIssues },
    }, 'warn');
    openIssues();
  };

  // A list of issues in a dialog: the first ten, each as "path: message". Text nodes only - the messages quote the file.
  const showIssues = (title, issues) => {
    const list = Array.isArray(issues) && issues.length ? issues : [{ path: '', message: 'The file is not a map.' }];
    const lines = list.slice(0, ISSUES_SHOWN).map((i) => `${i?.path ? `${i.path}: ` : ''}${String(i?.message ?? 'invalid').slice(0, 240)}`);
    if (list.length > ISSUES_SHOWN) lines.push(`... and ${list.length - ISSUES_SHOWN} more`);
    return ui.choose(h('div', null, `${title}\n\n`, h('span', { class: 'ui-mono' }, lines.join('\n'))), [{ id: 'close', label: 'Close' }]);
  };

  // ---------------------------------------------------------------- the draft

  let draftTimer = 0;
  let quotaToasted = false;     // 'Draft not saved' is said once, not every three seconds
  let offering = false;         // the restore question is open: the draft it asks about must not be overwritten
  let ownDraft = false;         // this page has written a draft that - as far as it knows - is still in storage
  let kept = null;              // { draft, map }: the draft of an earlier session, offered and not answered yet
  let reminded = false;         // ... and the question was repeated once, when this page had changes of its own

  // A map opened from the library counts as unsaved - Save would make it the live map - but until it is edited there is
  // nothing of the user's in it: the library has it. Such a map is replaced without a question and needs no draft.
  let untouched = false;        // the map in the editor is a library map exactly as it was opened
  let openingLibrary = false;   // ... and the load that is under way brings one in
  // Is there unsaved work in the editor that a new map, a reload or a closed tab would lose?
  const work = () => !!store.map && store.dirty && !untouched;

  // The small note beside the buttons: "Draft 14:02" while the unsaved state of the map is safe in storage.
  const draftNote = h('span', { class: 'ui-hint', hidden: true });
  const showDraft = (at) => {
    draftNote.hidden = !at;
    draftNote.textContent = at ? `Draft ${clock(at)}` : '';
    draftNote.title = at ? 'Your unsaved changes are kept in this browser as a draft: it is offered when the editor opens again' : '';
  };
  // The button of a kept draft: the question it stands for can be answered at any time.
  const keptButton = button('', () => { if (settled()) askKept(); });
  keptButton.classList.add('kept');
  keptButton.hidden = true;
  const keep = (value) => {
    kept = value;
    net.draftKept = !!value;        // net.js removes the draft after a save - but never this one
    keptButton.hidden = !value;
    keptButton.textContent = value ? `Draft ${clock(value.draft.at)}?` : '';
    keptButton.title = value
      ? `An unsaved draft from ${clock(value.draft.at)} is waiting for your answer: click to restore or discard it.\n`
        + 'Until then it is kept as it is, and the changes you make now are NOT kept as a draft.'
      : '';
  };
  const clearDraft = () => {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* storage disabled: there is no draft */ }
    ownDraft = false;
    keep(null);
    showDraft(0);
  };
  // -> { rev, at, map } as it was stored, or null. The storage may be disabled or hold anything.
  const readDraft = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(DRAFT_KEY));
      if (!isObj(raw) || !isObj(raw.map)) return null;
      return { rev: typeof raw.rev === 'string' ? raw.rev : '', at: Number.isFinite(raw.at) ? raw.at : 0, map: raw.map };
    } catch { return null; }
  };

  // ask: false when the page is being hidden or closed - no time for a question.
  function writeDraft(ask = true) {
    clearTimeout(draftTimer);
    draftTimer = 0;
    if (!store.map || offering) return;
    if (store.grouping) { scheduleDraft(DRAFT_RETRY_MS); return; }      // never half an edit
    if (!work()) {
      // nothing is unsaved (a save, every edit undone, a library map just opened): a draft of ours still in storage
      // holds changes that are gone. A draft from an earlier session that was offered and neither restored nor
      // discarded is not ours: it stays.
      if (ownDraft) clearDraft();
      return;
    }
    if (kept) {
      // The storage holds the draft that still waits for its answer, and it is never written over. Now that this page
      // has unsaved work of its own, which needs the place, the question is asked a second time - once.
      if (ask && !reminded) {
        reminded = true;
        askKept();
      }
      return;
    }
    let text;
    const at = Date.now();
    try {
      text = JSON.stringify({ rev: net.baseRev ?? '', at, map: serialize(store.map, { check: false }) });
    } catch (err) {
      console.error('[editor] the draft could not be built', err);
      return;
    }
    try {
      localStorage.setItem(DRAFT_KEY, text);
      ownDraft = true;
      showDraft(at);
    } catch {
      // QuotaExceededError (a very large map), or storage disabled: the editor works on without a draft
      showDraft(0);
      if (!quotaToasted) {
        quotaToasted = true;
        ui.toast('Draft not saved', 'warn');
      }
    }
  }
  function scheduleDraft(ms = DRAFT_MS) {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(writeDraft, ms);
  }
  // The tab is being hidden or closed with a draft still due: write it now, the timer may never fire.
  const flushDraft = () => { if (draftTimer) writeDraft(false); };

  // Loads a decoded map as unsaved work - the one path of Import, New and a restored draft.
  const loadUnsaved = (map) => {
    store.load(map, { dirty: true });       // 'load' schedules its draft
  };

  // The first map is on screen: is there a draft of unsaved work from last time?
  function offerDraft() {
    const draft = readDraft();
    if (!draft) return;
    let map;
    try {
      map = normalize(draft.map, { check: false });       // DECODE errors throw; RANGE errors come along and are listed
    } catch (err) {
      console.warn('[editor] the draft could not be read', err);
      clearDraft();
      ui.toast('The unsaved draft could not be read and was discarded', 'warn');
      return;
    }
    try {
      if (canonical(map) === canonical(store.map)) { clearDraft(); return; }     // it is the map that was just loaded
    } catch { /* cannot tell: ask */ }
    // from here on the draft is the user's: only Restore or Discard takes it out of the storage
    keep({ draft, map });
    askKept();
  }

  // The question about the kept draft: Restore, Discard - or Escape, which leaves it kept.
  function askKept() {
    if (!kept || offering) return;
    const { draft, map } = kept, when = clock(draft.at);
    const sameRev = draft.rev === (net.baseRev ?? '');   // asked again later, this page may have saved in between
    const unsaved = work();                           // ... or have changes of its own by now
    let text = sameRev
      ? `Restore the unsaved draft from ${when}?\n\nIt holds changes that were never saved to the server (${sizeOf(map)}).`
      : `An unsaved draft from ${when} was found, but the map on the server has changed since it was made.\n\n`
        + `Restore anyway brings the draft back (${sizeOf(map)}); saving it will then ask before it overwrites the server's map.`;
    if (unsaved) {
      text += '\n\nRestoring it replaces the map in the editor: the changes you have made since this page opened are lost, and so is the undo history. '
        + 'Discard deletes the draft for good; your changes are then kept as the new draft.';
    }
    offering = true;
    // sticky: a stray click beside the dialog must not answer for the user; Escape means "not now"
    ui.choose(text, [{ id: 'discard', label: 'Discard', danger: true }, { id: 'restore', label: sameRev ? 'Restore' : 'Restore anyway' }], { sticky: true }).then((answer) => {
      offering = false;
      if (answer === 'restore') {
        if (store.grouping) { ui.toast(BUSY, 'warn'); return; }      // (the dialog is modal: nothing can have opened an edit)
        keep(null);
        ownDraft = true;                    // what is in storage is the state of this page now
        loadUnsaved(map);
        // the draft was made from that revision: a save must meet the conflict dialog, not overwrite silently
        if (!sameRev) net.baseRev = draft.rev;
        ui.toast('Draft restored');
        reportErrors(map, 'The restored draft');
      } else if (answer === 'discard') {
        clearDraft();
        ui.toast('Draft discarded');
        if (work()) writeDraft();           // the place is free: the changes of this page go there now
      } else {
        ui.toast({
          text: `The draft from ${when} is kept: "${keptButton.textContent}" in the menu bar asks again. Until you answer, your new changes are not kept as a draft`,
          action: { label: 'Answer now', run: () => { if (settled()) askKept(); } },
        }, unsaved ? 'warn' : 'info');
      }
    }).catch((err) => {
      offering = false;
      console.error('[editor] the draft offer failed', err);
    });
  }

  // ---------------------------------------------------------------- export

  function exportMap() {
    if (!settled()) return false;
    const map = store.map, text = canonical(map), name = fileName(map.name);
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = h('a', { href: url, download: name, hidden: true });
    el.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);     // the download has its copy long before
    const errors = errorsOf(map).length;
    if (errors) {
      ui.toast({
        text: `Exported ${name} with ${count(errors, 'error')}: the game cannot load this file until ${errors === 1 ? 'it is' : 'they are'} fixed`,
        action: { label: 'Show issues', run: openIssues },
      }, 'warn');
    } else ui.toast(`Exported ${name} \u00b7 ${sizeOf(map)}`);
    return true;
  }

  // ---------------------------------------------------------------- import

  let importing = false;

  async function importFile(file) {
    if (importing) return false;
    importing = true;
    try {
      const name = String(file.name || 'the file').slice(0, 80);
      if (file.size > MAX_FILE) {
        ui.toast(`Import failed: ${name} is larger than a map can be`, 'error');
        return false;
      }
      let raw;
      try {
        raw = JSON.parse(await file.text());
      } catch {
        ui.toast(`Import failed: ${name} is not a JSON file`, 'error');
        return false;
      }
      let map;
      try {
        map = normalize(raw, { check: false });
      } catch (err) {
        if (!(err instanceof MapError)) console.error('[editor] import failed', err);
        await showIssues(`${name} is not a map this editor can load. Nothing was imported.`, err?.issues);
        return false;
      }
      if (!settled()) return false;       // an edit was opened while the file was being read
      if (work() && !(await ui.confirm(
        `Replace the map in the editor with ${name}?\n\nYour unsaved changes will be lost, and so will the undo history.`,
        { ok: 'Import', cancel: 'Cancel', danger: true },     // Cancel has the focus: Enter loses nothing
      ))) return false;
      if (!settled()) return false;
      loadUnsaved(map);
      ui.toast(`Imported ${name} \u00b7 ${sizeOf(map)}`);
      reportErrors(map, 'The imported map');
      return true;
    } finally {
      importing = false;
    }
  }

  // The file picker is the browser's: it opens only from inside the click that asked for it.
  const picker = h('input', { type: 'file', accept: '.json,application/json', hidden: true, tabIndex: -1 });
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    picker.value = '';                    // the same file can be chosen again
    if (file) importFile(file).catch((err) => console.error('[editor] import failed', err));
  });
  function importMap(file) {
    if (typeof Blob !== 'undefined' && file instanceof Blob) return importFile(file);
    if (!settled()) return false;
    picker.click();
    return true;
  }

  // A map file dropped anywhere on the page is imported - and a file dropped by accident no longer makes the browser
  // leave the editor to show it. Only file drags are touched: a drag inside the page (a palette tile, a row) is not ours.
  const hasFiles = (ev) => Array.from(ev.dataTransfer?.types ?? []).includes('Files');
  window.addEventListener('dragover', (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = dialogOpen() ? 'none' : 'copy';
  });
  window.addEventListener('drop', (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    if (dialogOpen()) return;
    const file = Array.from(ev.dataTransfer.files ?? []).find((f) => /\.json$/i.test(f.name) || f.type === 'application/json');
    if (!file) { ui.toast('Drop a map file (.json) to import it', 'warn'); return; }
    importFile(file).catch((err) => console.error('[editor] import failed', err));
  });

  // ---------------------------------------------------------------- revert, new

  let reverting = false;

  async function revert() {
    if (reverting || !settled()) return false;
    const dirty = work();
    if (dirty && !(await ui.confirm(
      'Revert to the saved map?\n\nEvery change since the last save will be lost, and so will the undo history.',
      { ok: 'Revert', cancel: 'Cancel', danger: true },       // Cancel has the focus: Enter loses nothing
    ))) return false;
    reverting = true;
    try {
      const map = await net.loadMap();
      store.load(map);
      // the changes were given up: their draft must not come back on the next start. A kept draft is not theirs.
      if (!kept) clearDraft();
      ui.toast(dirty ? 'Reverted to the saved map' : 'Loaded the map from the server');
      return true;
    } catch (err) {
      console.error('[editor] revert failed', err);
      ui.toast(`Revert failed: ${String(err?.message ?? err).slice(0, 240)}`, 'error');
      return false;
    } finally {
      reverting = false;
    }
  }

  async function newMap() {
    if (!settled()) return false;
    const [least] = LIMITS.radius, most = Math.min(LIMITS.radius[1], maxRadius({ cell: 2 }));
    const typed = await ui.prompt(
      `New map: an empty island of grass with a sand shore.${work() ? '\nYour unsaved changes will be lost.' : ''}\n`
      + `The map on the server stays as it is until you save.\n\nRadius of the island (${least}\u2013${most})`,
      String(store.map?.radius ?? 260),
    );
    if (typed === null) return false;
    const radius = Number(typed.trim().replace(',', '.'));
    if (!Number.isFinite(radius) || radius < least || radius > most) {
      ui.toast(`No new map: the radius must be a number from ${least} to ${most}`, 'warn');
      return false;
    }
    if (!settled()) return false;
    const map = emptyMap({ radius });
    loadUnsaved(map);
    if (actions.has('view.home')) actions.run('view.home');     // the camera may be looking at where the old island was
    ui.toast(`New map: an empty island, radius ${map.radius}`);
    return true;
  }

  // ---------------------------------------------------------------- the map library

  const why = (err) => String(err?.message ?? err).slice(0, 240);
  // A name as the library files it: lower case, digits and single dashes.
  const libraryId = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  let libraryMaps = [];         // what the server listed last
  let opening = false;

  // Loads the library map `entry` ({ id, rev }) into the editor.
  async function openLibraryMap(entry) {
    if (opening || !settled()) return false;
    opening = true;
    try {
      const live = !!entry.rev && entry.rev === net.info.rev;
      let map;
      try {
        map = live ? null : await net.libraryMap(entry.id);
      } catch (err) {
        if (err instanceof MapError) await showIssues(`"${entry.id}" is not a map this editor can load. Nothing was opened.`, err.issues);
        else ui.toast(`"${entry.id}" was not opened: ${why(err)}`, 'error');
        return false;
      }
      if (!settled()) return false;       // an edit was opened while the map was on its way
      if (work() && !(await ui.confirm(
        `Replace the map in the editor with "${entry.id}"?\n\nYour unsaved changes will be lost, and so will the undo history.`,
        { ok: 'Open', cancel: 'Cancel', danger: true },       // Cancel has the focus: Enter loses nothing
      ))) return false;
      if (!settled()) return false;
      if (live) {                         // the map the game runs: nothing about it is unsaved
        try {
          store.load(await net.loadMap());
        } catch (err) {
          ui.toast(`"${entry.id}" was not opened: ${why(err)}`, 'error');
          return false;
        }
        if (!kept) clearDraft();
        ui.toast(`Opened "${entry.id}": it is the map the game runs`);
        return true;
      }
      openingLibrary = true;
      try { loadUnsaved(map); } finally { openingLibrary = false; }
      writeDraft();                       // (nothing to write: this takes away the draft of what was given up)
      ui.toast(`Opened "${entry.id}" \u00b7 ${sizeOf(map)}. The game keeps its own map until you save`);
      reportErrors(map, 'The opened map');
      return true;
    } finally {
      opening = false;
    }
  }

  async function keepCopy() {
    if (!settled()) return false;
    const typed = await ui.prompt(
      'Keep a copy of the map in the editor in the library.\nIt is stored on the server beside the map file, under this name '
      + '(letters, digits and dashes).\n\nName',
      libraryId(store.map.name),
    );
    if (typed === null) return false;
    const id = libraryId(typed);
    if (!id) { ui.toast('No copy kept: the name needs a letter or a digit', 'warn'); return false; }
    if (!settled()) return false;
    try {
      let answer = await net.keep(id, store.map);
      if (answer.exists) {
        if (!(await ui.confirm(`The library already has a map named "${id}". Replace it?`, { ok: 'Replace', cancel: 'Cancel', danger: true }))) return false;
        if (!settled()) return false;
        answer = await net.keep(id, store.map, true);
      }
      ui.toast(`${answer.replaced ? 'Replaced' : 'Kept as'} "${id}" in the library \u00b7 ${sizeOf(store.map)}`);
      return true;
    } catch (err) {
      const errors = errorsOf(store.map).length;
      ui.toast(errors
        ? { text: `No copy kept: the map has ${count(errors, 'error')}. Fix them, or use Export`, action: { label: 'Show issues', run: openIssues } }
        : `No copy kept: ${why(err)}`, 'error');
      return false;
    }
  }

  const libraryButton = button('Maps \u25be', null, { title: 'The map library: open a map that was kept on the server, or keep a copy of this one' });
  libraryButton.setAttribute('aria-haspopup', 'true');
  const libraryList = h('div', { class: 'ui-list' });
  const keepButton = button('Keep a copy\u2026', () => { closeLibrary(); keepCopy().catch(report('keeping a copy')); },
    { title: 'Store the map in the editor in the library, under a name' });
  const libraryBox = h('div', { class: 'ui-popover maps' },
    h('div', { class: 'ui-hint' }, 'Maps kept on the server. Opening one loads it as unsaved work: the game keeps its own map until you save.'),
    libraryList, keepButton);

  // One row per map: its name, what it holds and when it was kept; the map the game runs is marked.
  function showLibrary(maps, note = '') {
    libraryMaps = maps;
    if (!maps.length) {
      libraryList.replaceChildren(h('div', { class: 'ui-empty' }, note || 'The library is empty. "Keep a copy" puts the map in the editor into it.'));
      return;
    }
    libraryList.replaceChildren(...maps.map((m) => {
      const live = !!m.rev && m.rev === net.info.rev;
      const item = h('button', { type: 'button', class: ['ui-item', live && 'selected'], title: live ? 'The map the game runs' : `Open "${m.id}" in the editor` },
        h('span', { class: 'id' }, m.id, live && h('span', { class: 'ui-badge ok' }, 'live')),
        h('span', { class: 'ui-dim' }, `${count(Number(m.objects) || 0, 'object')} \u00b7 ${count(Number(m.spawns) || 0, 'spawn')} \u00b7 ${clock(Number(m.at))}`));
      item.addEventListener('click', () => { closeLibrary(); openLibraryMap(m).catch(report('opening a library map')); });
      return item;
    }));
  }
  function refreshLibrary() {
    if (!libraryMaps.length) showLibrary([], 'Loading\u2026');
    net.library().then((maps) => showLibrary(maps), (err) => showLibrary([], `The library cannot be read: ${why(err)}.`));
  }

  // The box opens like the options of Play (play.js): through the popover API, which lifts it above the menu bar and
  // closes it on a click elsewhere and on Escape; without that API it is toggled by hand.
  const nativeBox = typeof libraryBox.showPopover === 'function';
  const placeLibrary = () => {
    const r = libraryButton.getBoundingClientRect();
    libraryBox.style.inset = 'auto';
    libraryBox.style.top = `${Math.round(r.bottom + 4)}px`;
    libraryBox.style.left = `${Math.max(8, Math.round(r.left))}px`;
  };
  const libraryOpened = () => { placeLibrary(); refreshLibrary(); };
  if (nativeBox) {
    libraryBox.popover = 'auto';
    libraryButton.popoverTargetElement = libraryBox;
    libraryBox.addEventListener('beforetoggle', (ev) => { if (ev.newState === 'open') libraryOpened(); });
    libraryBox.addEventListener('toggle', (ev) => libraryButton.classList.toggle('active', ev.newState === 'open'));
  } else {
    libraryBox.hidden = true;
    libraryBox.style.position = 'fixed';
    libraryButton.addEventListener('click', () => {
      libraryBox.hidden = !libraryBox.hidden;
      if (!libraryBox.hidden) libraryOpened();
      libraryButton.classList.toggle('active', !libraryBox.hidden);
    });
  }
  function closeLibrary() {
    if (!nativeBox) { libraryBox.hidden = true; libraryButton.classList.remove('active'); return; }
    try { if (libraryBox.matches(':popover-open')) libraryBox.hidePopover(); } catch { /* not open */ }
  }
  function openLibrary() {
    if (!nativeBox) { if (libraryBox.hidden) libraryButton.click(); return; }
    try { if (!libraryBox.matches(':popover-open')) libraryBox.showPopover(); } catch { /* cannot open now */ }
  }

  // ---------------------------------------------------------------- the menu

  const report = (what) => (err) => console.error(`[editor] ${what} failed`, err);
  const newButton = button('New', () => actions.run('file.new'));
  const importButton = button('Import', () => actions.run('file.import'));
  const exportButton = button('Export', () => actions.run('file.export'));
  const revertButton = button('Revert', () => actions.run('file.revert'));
  newButton.title = 'Start an empty island (the map on the server changes only when you save)';
  importButton.title = 'Load a map file (.json) into the editor as unsaved work. You can also drop the file on the window';
  exportButton.title = 'Download the map as a .json file, exactly as Save would write it';
  el.replaceChildren(newButton, importButton, exportButton, revertButton, libraryButton, draftNote, keptButton, picker, libraryBox);

  // An id somebody registered already is left alone (registering twice throws).
  const offer = (id, fn) => { if (!actions.has(id)) actions.register(id, fn); };
  offer('file.new', () => { newMap().catch(report('new map')); });
  offer('file.import', (file) => { Promise.resolve(importMap(file)).catch(report('import')); });
  offer('file.export', exportMap);
  offer('file.revert', () => { revert().catch(report('revert')); });
  offer('file.library', (id) => {
    if (typeof id !== 'string') { openLibrary(); return; }
    net.library().then((maps) => {
      const entry = maps.find((m) => m.id === id);
      if (entry) return openLibraryMap(entry);
      ui.toast(`The library has no map named "${id}"`, 'warn');
      return false;
    }).catch((err) => ui.toast(`The library cannot be read: ${why(err)}`, 'error'));
  });

  // ---------------------------------------------------------------- unsaved changes: the title, the buttons, the tab

  const sync = () => {
    const map = store.map, dirty = !!map && store.dirty;
    document.title = `${dirty ? '\u2022 ' : ''}${map?.name ? `${map.name} \u2014 ` : ''}${baseTitle}`;
    for (const node of [newButton, importButton, exportButton, revertButton]) node.disabled = !map;
    // the library is the server's: one that is not in editor mode keeps none
    libraryButton.disabled = !map || !!ui.readOnly;
    keepButton.disabled = !map;
    revertButton.title = dirty
      ? 'Give up every unsaved change and load the map from the server again'
      : 'Load the map from the server again (there are no unsaved changes)';
    if (!dirty) showDraft(0);                 // saved (net.js has removed the draft) or undone: nothing is waiting in it
  };

  let first = true;
  store.on('load', () => {
    untouched = openingLibrary;
    sync();
    showDraft(0);
    if (first) {
      first = false;
      offerDraft();
    } else if (work()) scheduleDraft();           // an import, a new map, a restored draft: unsaved from the start
  });
  store.on('change', (change) => {
    untouched = false;                            // the first edit makes an opened library map the user's own work
    scheduleDraft();
    if (change?.props?.includes('name')) sync();
  });
  store.on('history', sync);
  ui.on('readOnly', sync);
  window.addEventListener('beforeunload', (ev) => {
    if (!work()) return;
    ev.preventDefault();
    ev.returnValue = true;    // older browsers ask "Leave site? Changes you made may not be saved" only for this
  });
  window.addEventListener('pagehide', flushDraft);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushDraft(); });

  sync();
  if (store.map) {            // mounted after the map (never in today's boot order): the first load has happened
    first = false;
    offerDraft();
  }
  return {};
}
