import { normalize, serialize, validate } from '../map/format.js';
import { leaveField } from './ui/dom.js';

// The editor's side of the server API: load the map and the asset list, save the map, read and fill the map library,
// keep the token of token mode.
//
//   const net = createNet();
//   const { map, assets, info } = await net.loadAll();   // needs nothing but the server: it runs before ui and store exist
//   ...
//   net.install(ctx);                                    // once ctx has store, ui, actions and modelSet: sets
//                                                        // ui.readOnly (with its toast) and registers 'file.save'
//
// The token never goes into a URL: it travels in the header X-Editor-Token and lives in sessionStorage, where the game
// reads it for play-testing.

const TOKEN_KEY = 'hypercat-editor-token';   // sessionStorage, shared with the game in play mode
const DRAFT_KEY = 'hypercat-editor-draft';   // localStorage, written by io.js; removed here after a save - see net.draftKept
const READ_ONLY = 'Read-only: server is not in editor mode';
const SENDABLE = /^[\x21-\x7e]{1,256}$/;     // what fits a header value and the server's 256 characters
const RETRY_MAX_S = 2;                       // a 429 that asks for no more than this is waited out, once

// what the server's error codes mean to the person at the keyboard
const REASONS = {
  'editor-off': 'the server is not in editor mode',
  'not-local': 'without a token, saving is allowed from the server\'s own machine only',
  origin: 'the page must be opened from the server\'s own address',
  header: 'the request was refused',
  'content-type': 'the request was refused',
  'too-large': 'the map is too large',
  timeout: 'the upload took too long',
  'bad-json': 'the server could not read the map',
  rate: 'too many attempts, try again in a moment',
  'write-failed': 'the server could not write the file',
  internal: 'server error',
  'not-found': 'this server has no map API',
  token: 'the editor token was not accepted',
  'bad-id': 'that name cannot be used',
  'library-full': 'the library is full: remove a file from the library folder first',
  invalid: 'the map has errors',
};

// the rev of the map a response carries: the plain header first, the ETag as a fallback (a proxy may weaken or drop either)
const revOf = (res) => res.headers.get('X-Map-Rev') || (res.headers.get('ETag') || '').replace(/^W\//, '').replace(/"/g, '');

async function getJson(url) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } });
  } catch {
    throw new Error(`The server cannot be reached (${url}).`);
  }
  if (!res.ok) throw new Error(`${url} answered ${res.status}.`);
  try {
    return { res, body: await res.json() };
  } catch {
    throw new Error(`${url} did not answer with JSON.`);
  }
}

// what an answer that refuses says, in those words; '' for a code this page does not know
const reasonOf = (data) => (typeof data?.error === 'string' && Object.hasOwn(REASONS, data.error) ? REASONS[data.error] : '');

const count = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const lines = (issues, max = 3) => {
  const list = issues.filter((i) => typeof i?.message === 'string').map((i) => i.message.slice(0, 240));
  const more = issues.length - Math.min(list.length, max);
  return [...list.slice(0, max), ...(more > 0 ? [`... and ${more} more`] : [])].join('\n');
};

export function createNet() {
  let ctx = null;          // set by install()
  let saving = null;       // the save in flight: a second Mod+S joins it instead of posting again
  let asking = null;       // the token prompt that is open
  let memoryToken = '';    // the token, when sessionStorage refuses to keep it
  let changes = 0;         // store 'change' events seen ...
  let loads = 0;           // ... and maps loaded: what happened while a POST was under way

  const readToken = () => {
    try {
      const t = sessionStorage.getItem(TOKEN_KEY);
      if (typeof t === 'string' && SENDABLE.test(t)) return t;
    } catch { /* storage disabled */ }
    return memoryToken;
  };
  const writeToken = (t) => {
    memoryToken = t;
    try {
      if (t) sessionStorage.setItem(TOKEN_KEY, t);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch { /* storage full or disabled: the token lives until the tab closes */ }
  };
  const askToken = async (text) => {
    const typed = (await ctx.ui.prompt(text, ''))?.trim();
    if (!typed) return null;
    if (!SENDABLE.test(typed)) {
      ctx.ui.toast('That cannot be the editor token: it has spaces or characters a token never has', 'warn');
      return null;
    }
    writeToken(typed);
    return typed;
  };
  const clearDraft = () => {
    try { localStorage.removeItem(DRAFT_KEY); } catch { /* storage disabled */ }
  };
  const openIssues = () => {
    if (ctx.actions.has('validation.open')) ctx.actions.run('validation.open');
  };

  // One POST and what follows from its answer. body: the JSON text; seen: the change and load counters when that text
  // was made; again: a 401 may still ask for the token and retry; patient: a short 429 may still be waited out.
  async function post(body, seen, force, again, patient = true) {
    const { store, ui } = ctx;
    const headers = { 'Content-Type': 'application/json', 'X-Editor': '1' };
    const base = force ? '*' : net.baseRev;
    if (base) headers['X-Base-Rev'] = base;   // no known rev: the server answers 409 and the person decides
    if (net.info.tokenRequired) {
      const token = await net.token();
      if (!token) {
        ui.toast('Not saved: the editor token is needed', 'warn');
        return false;
      }
      headers['X-Editor-Token'] = token;
    }

    let res;
    try {
      res = await fetch('/api/map', { method: 'POST', headers, body, cache: 'no-store' });
    } catch {
      ui.toast('Save failed: the server cannot be reached', 'error');
      return false;
    }
    const data = await res.json().catch(() => null);

    if (res.status === 200 && data?.ok === true) {
      const rev = typeof data.rev === 'string' && data.rev ? data.rev : revOf(res);
      const sameMap = loads === seen.loads, untouched = sameMap && changes === seen.changes;
      if (sameMap) {
        net.baseRev = rev;
        net.info = { ...net.info, rev };
      }
      // an edit made while the request was under way is not in the file: the map stays dirty and keeps its draft
      if (untouched) {
        // The draft is this page's unsaved state, which the file holds now. A save with nothing unsaved ('No changes')
        // has written nothing of ours: whatever is in storage then - a draft of an earlier session that waits for an
        // answer, another tab's work - is not ours to remove.
        const unsaved = store.dirty;
        store.markSaved();
        if (unsaved && !net.draftKept) clearDraft();
      }
      const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
      const what = data.unchanged ? 'No changes' : `Saved ${time} \u00b7 ${count(store.map.objects.length, 'object')} \u00b7 ${count(store.map.spawns.length, 'spawn')}`;
      ui.toast(untouched ? what : `${what} (edits made meanwhile are not saved yet)`);
      return true;
    }

    if (res.status === 401) {
      net.info = { ...net.info, tokenRequired: true };
      writeToken('');
      const token = again ? await askToken('The server did not accept the editor token.\nEditor token') : null;
      if (token) return post(body, seen, force, false, patient);
      ui.toast(again ? 'Not saved: the editor token is needed' : 'Save failed (401): the editor token was not accepted', again ? 'warn' : 'error');
      return false;
    }

    if (res.status === 409) {
      const answer = await ui.choose(
        'The map on the server changed since you loaded it.\n\n'
        + 'Overwrite replaces the server\'s map with yours.\nReload discards your unsaved edits and loads the server\'s map.',
        [{ id: 'overwrite', label: 'Overwrite', danger: true }, { id: 'reload', label: 'Reload', danger: true }, { id: 'cancel', label: 'Cancel' }],
      );
      if (answer === 'overwrite') return post(body, seen, true, again, patient);
      if (answer === 'reload') {
        try {
          store.load(await net.loadMap());
          if (!net.draftKept) clearDraft();   // the edits were given up; their draft must not come back on the next start
          ui.toast('Loaded the map from the server');
        } catch (e) {
          ui.toast(`Reload failed: ${e?.message ?? e}`, 'error');
        }
      }
      return false;
    }

    if (res.status === 422) {
      const issues = Array.isArray(data?.issues) ? data.issues : [];
      ui.toast({
        text: `The server rejected the map (422):\n${lines(issues) || 'it is not valid'}`,
        action: { label: 'Show issues', run: openIssues },
      }, 'error');
      return false;
    }

    if (res.status === 429 && patient) {
      // The server takes one changing save a second and says so with Retry-After: 1. A second Mod+S right behind the
      // first (or a Play behind a save) is not a failure: the answer is waited out and the same request sent once
      // more. A longer wait is the lock after wrong tokens - that one is told, below.
      const wait = Number(res.headers.get('Retry-After'));
      if (Number.isFinite(wait) && wait > 0 && wait <= RETRY_MAX_S) {
        await new Promise((resolve) => { setTimeout(resolve, wait * 1000 + 50); });
        return post(body, seen, force, again, false);
      }
    }

    const reason = reasonOf(data);
    ui.toast(`Save failed (${res.status})${reason ? `: ${reason}` : ''}`, 'error');
    return false;
  }

  // The whole save: open edits first, validate, POST.
  async function run(force) {
    const { store, ui } = ctx;
    // a field that is being typed in commits when it is left, so the save never posts a half-typed value
    if (!leaveField()) document.activeElement?.blur?.();
    if (store.grouping) {
      ui.toast('Finish the current edit first', 'warn');
      return false;
    }
    if (!store.map) return false;
    if (ui.readOnly) {
      ui.toast(READ_ONLY, 'warn');
      return false;
    }
    // the same check the server runs: what fails here would come back as 422
    const errors = validate(store.map, { models: ctx.modelSet ?? null, strictModels: true }).filter((i) => i.level === 'error');
    if (errors.length) {
      ui.toast({
        text: `Cannot save, ${count(errors.length, 'error')}:\n${lines(errors)}`,
        action: { label: 'Show issues', run: openIssues },
      }, 'error');
      openIssues();
      return false;
    }
    const seen = { changes, loads };
    return post(JSON.stringify(serialize(store.map, { check: false })), seen, force, true);   // validated just above
  }

  // One request about the map library, sent as the editor's own: X-Editor and, in token mode, the token.
  // -> the Response when its status is 200 or one of `also`; anything else throws an Error that says why.
  async function libraryFetch(url, init = {}, also = []) {
    const headers = { Accept: 'application/json', 'X-Editor': '1', ...init.headers };
    if (net.info.tokenRequired) {
      const token = await net.token();
      if (!token) throw new Error('the editor token is needed');
      headers['X-Editor-Token'] = token;
    }
    let res;
    try {
      res = await fetch(url, { cache: 'no-store', ...init, headers });
    } catch {
      throw new Error('the server cannot be reached');
    }
    if (res.status === 200 || also.includes(res.status)) return res;
    if (res.status === 401) writeToken('');   // the next attempt asks for it again
    const data = await res.json().catch(() => null);
    throw new Error(reasonOf(data) || `the server answered ${res.status}`);
  }

  const net = {
    info: { enabled: false, tokenRequired: false, canSave: false, rev: '' },   // the body of GET /api/editor
    baseRev: '',                                                              // rev of the map the store was loaded from or last saved as
    // Set by io.js while the draft in storage is NOT this page's work: a draft of an earlier session that was offered
    // and neither restored nor discarded. No save and no reload removes it; only the user's answer does.
    draftKept: false,

    // -> { map, assets, info }. Throws a MapError when the server's map does not load (its .issues say why) and an
    // Error when the server cannot be asked. A server without /api/editor is a read-only one.
    async loadAll() {
      const [editor, map, assets] = await Promise.all([getJson('/api/editor').catch(() => null), getJson('/api/map'), getJson('/api/assets')]);
      const e = editor?.body;
      net.info = {
        enabled: e?.enabled === true, tokenRequired: e?.tokenRequired === true, canSave: e?.canSave === true,
        rev: typeof e?.rev === 'string' ? e.rev : '',
      };
      net.baseRev = revOf(map.res);
      const packs = {};
      const given = assets.body?.packs;
      if (given !== null && typeof given === 'object') {
        for (const [pack, names] of Object.entries(given)) if (Array.isArray(names)) packs[pack] = names.filter((n) => typeof n === 'string');
      }
      return { map: normalize(map.body), assets: { packs }, info: net.info };
    },

    // -> the server's map, fetched now. baseRev follows only when the map loads: until then the store holds the old one.
    async loadMap() {
      const { res, body } = await getJson('/api/map');
      const map = normalize(body);
      net.baseRev = revOf(res);
      net.info = { ...net.info, rev: net.baseRev };
      return map;
    },

    // -> true when the server has the map. Never rejects: every outcome is a toast or a dialog.
    // force: send X-Base-Rev: * (overwrite whatever the server has).
    save({ force = false } = {}) {
      if (!ctx) return Promise.resolve(false);
      if (!saving) {
        saving = run(force)
          .catch((e) => {
            console.error('[editor] save failed', e);
            ctx.ui.toast(`Save failed: ${e?.message ?? e}`, 'error');
            return false;
          })
          .finally(() => { saving = null; });
      }
      return saving;
    },

    // ---- the map library: named copies of a map on the server (GET and POST /api/maps). Each of the three says what
    // went wrong in the message of the Error it throws.

    // -> [{ id, name, at, objects, spawns, rev }], newest first
    async library() {
      const res = await libraryFetch('/api/maps');
      const maps = (await res.json().catch(() => null))?.maps;
      if (!Array.isArray(maps)) throw new Error('The server did not answer with a list of maps.');
      return maps.filter((m) => typeof m?.id === 'string');
    },

    // -> the map kept under `id`, decoded like an imported file: DECODE errors throw a MapError, RANGE errors come along
    async libraryMap(id) {
      const res = await libraryFetch(`/api/maps?id=${encodeURIComponent(id)}`, {}, [404]);
      if (res.status === 404) throw new Error(`"${id}" is no longer in the library`);
      let raw;
      try { raw = await res.json(); } catch { throw new Error(`"${id}" is not a JSON file.`); }
      return normalize(raw, { check: false });
    },

    // Keeps `map` in the library under `id`. -> { ok: true, replaced } | { ok: false, exists: true } when the id is
    // taken and `overwrite` was not set. A map with errors is refused by the server, as on Save.
    async keep(id, map, overwrite = false) {
      const res = await libraryFetch(`/api/maps?id=${encodeURIComponent(id)}`, {
        method: 'POST', body: JSON.stringify(serialize(map, { check: false })),
        headers: { 'Content-Type': 'application/json', ...(overwrite ? { 'X-Overwrite': '1' } : {}) },
      }, [409]);
      const data = await res.json().catch(() => null);
      if (res.status === 409 && data?.error === 'exists') return { ok: false, exists: true };
      if (res.status !== 200) throw new Error(reasonOf(data) || `the server answered ${res.status}`);
      return { ok: true, replaced: data?.replaced === true };
    },

    // -> the editor token, or null. Asks for it once, and only in token mode; after that sessionStorage has it.
    async token() {
      const stored = readToken();
      if (stored) return stored;
      if (!ctx || !net.info.tokenRequired) return null;
      asking ??= askToken('This server asks for the editor token before it saves.\nEditor token').finally(() => { asking = null; });
      return asking;
    },

    // Connects the save to the editor. ctx: { store, ui, actions, modelSet }.
    install(context) {
      ctx = context;
      ctx.store.on('change', () => { changes++; });
      ctx.store.on('load', () => { loads++; });
      const readOnly = !(net.info.enabled && net.info.canSave);
      ctx.ui.set('readOnly', readOnly);
      if (readOnly) ctx.ui.toast(READ_ONLY, 'warn');
      // Always "enabled": in read-only mode Mod+S answers with the toast above instead of doing nothing at all.
      // The Save button shows the disabled state (panels/menubar.js).
      ctx.actions.register('file.save', (options) => net.save(options?.force === true ? { force: true } : {}));
      return net;
    },
  };
  return net;
}
