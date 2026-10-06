import { LIMITS, MapError, emptyMap, maxRadius, normalize, serialize, stringifyMap, validate } from '../map/format.js';
import { h, button, leaveField } from './ui/dom.js';

// The file side of the editor that is not Save (#menu-io): New, Import, Export, Revert - and what guards unsaved work:
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
//
// The draft: 3 s after the last change the map is written to localStorage['hypercat-editor-draft'] as
// { rev, at, map } - never while an edit is open, and never while nothing is unsaved (Save removes the draft itself,
// in net.js, and a timer that fires just after must not bring it back). It is offered once, on the first map the
// editor loads. Restoring is exactly an import, so a draft made while the map had errors - the states in which Save
// is disabled and the draft is the only copy - comes back with its errors listed.
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
  const baseTitle = document.title.replace(/^\u2022\s*/, '') || 'HyperCat Map Editor';

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

  // The small note beside the buttons: "Draft 14:02" while the unsaved state of the map is safe in storage.
  const draftNote = h('span', { class: 'ui-hint', hidden: true });
  const showDraft = (at) => {
    draftNote.hidden = !at;
    draftNote.textContent = at ? `Draft ${clock(at)}` : '';
    draftNote.title = at ? 'Your unsaved changes are kept in this browser as a draft: it is offered when the editor opens again' : '';
  };
  const clearDraft = () => {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* storage disabled: there is no draft */ }
    ownDraft = false;
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

  function writeDraft() {
    clearTimeout(draftTimer);
    draftTimer = 0;
    if (!store.map || offering) return;
    if (store.grouping) { scheduleDraft(DRAFT_RETRY_MS); return; }      // never half an edit
    if (!store.dirty) {
      // nothing is unsaved (a save, or every edit undone): a draft of ours still in storage holds changes that are
      // gone. A draft from an earlier session that was offered and neither restored nor discarded is not ours: it stays.
      if (ownDraft) clearDraft();
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
  const flushDraft = () => { if (draftTimer) writeDraft(); };

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

    const sameRev = draft.rev === (net.baseRev ?? ''), when = clock(draft.at);
    const text = sameRev
      ? `Restore the unsaved draft from ${when}?\n\nIt holds changes that were never saved to the server (${sizeOf(map)}).`
      : `An unsaved draft from ${when} was found, but the map on the server has changed since it was made.\n\n`
        + `Restore anyway brings the draft back (${sizeOf(map)}); saving it will then ask before it overwrites the server's map.`;
    offering = true;
    ui.choose(text, [{ id: 'discard', label: 'Discard', danger: true }, { id: 'restore', label: sameRev ? 'Restore' : 'Restore anyway' }]).then((answer) => {
      offering = false;
      if (answer === 'restore') {
        loadUnsaved(map);
        // the draft was made from that revision: a save must meet the conflict dialog, not overwrite silently
        if (!sameRev) net.baseRev = draft.rev;
        ui.toast('Draft restored');
        reportErrors(map, 'The restored draft');
      } else if (answer === 'discard') {
        clearDraft();
        ui.toast('Draft discarded');
      } else ui.toast('The draft is kept until your next edit; reload the page to be asked again');
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
      if (store.dirty && !(await ui.confirm(
        `Replace the map in the editor with ${name}?\n\nYour unsaved changes will be lost, and so will the undo history.`,
        { ok: 'Import', cancel: 'Cancel' },
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
    const dirty = store.dirty;
    if (dirty && !(await ui.confirm(
      'Revert to the saved map?\n\nEvery change since the last save will be lost, and so will the undo history.',
      { ok: 'Revert', cancel: 'Cancel' },
    ))) return false;
    reverting = true;
    try {
      const map = await net.loadMap();
      store.load(map);
      clearDraft();       // the changes were given up: their draft must not come back on the next start
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
      `New map: an empty island of grass with a sand shore.${store.dirty ? '\nYour unsaved changes will be lost.' : ''}\n`
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

  // ---------------------------------------------------------------- the menu

  const report = (what) => (err) => console.error(`[editor] ${what} failed`, err);
  const newButton = button('New', () => actions.run('file.new'));
  const importButton = button('Import', () => actions.run('file.import'));
  const exportButton = button('Export', () => actions.run('file.export'));
  const revertButton = button('Revert', () => actions.run('file.revert'));
  newButton.title = 'Start an empty island (the map on the server changes only when you save)';
  importButton.title = 'Load a map file (.json) into the editor as unsaved work. You can also drop the file on the window';
  exportButton.title = 'Download the map as a .json file, exactly as Save would write it';
  el.replaceChildren(newButton, importButton, exportButton, revertButton, draftNote, picker);

  // An id somebody registered already is left alone (registering twice throws).
  const offer = (id, fn) => { if (!actions.has(id)) actions.register(id, fn); };
  offer('file.new', () => { newMap().catch(report('new map')); });
  offer('file.import', (file) => { Promise.resolve(importMap(file)).catch(report('import')); });
  offer('file.export', exportMap);
  offer('file.revert', () => { revert().catch(report('revert')); });

  // ---------------------------------------------------------------- unsaved changes: the title, the buttons, the tab

  const sync = () => {
    const map = store.map, dirty = !!map && store.dirty;
    document.title = `${dirty ? '\u2022 ' : ''}${map?.name ? `${map.name} \u2014 ` : ''}${baseTitle}`;
    for (const node of [newButton, importButton, exportButton, revertButton]) node.disabled = !map;
    revertButton.title = dirty
      ? 'Give up every unsaved change and load the map from the server again'
      : 'Load the map from the server again (there are no unsaved changes)';
    if (!dirty) showDraft(0);                 // saved (net.js has removed the draft) or undone: nothing is waiting in it
  };

  let first = true;
  store.on('load', () => {
    sync();
    showDraft(0);
    if (first) {
      first = false;
      offerDraft();
    } else if (store.dirty) scheduleDraft();      // an import, a new map, a restored draft: unsaved from the start
  });
  store.on('change', (change) => {
    scheduleDraft();
    if (change?.props?.includes('name')) sync();
  });
  store.on('history', sync);
  window.addEventListener('beforeunload', (ev) => {
    if (!store.map || !store.dirty) return;
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
