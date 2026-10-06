// Tests for the editor's save (src/editor/net.js): what a save does with the autosave draft, and how it meets the
// server's "one changing save a second".
//
//   node --test test/net.test.mjs
//
// net.js is page code: it asks `fetch`, `localStorage`, `sessionStorage` and (to commit a field that is being typed
// in) `document.activeElement`. This file gives it the four as small stand-ins; no browser, no server.
import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyMap } from '../src/map/format.js';
import { createStore } from '../src/editor/store.js';
import { createUi } from '../src/editor/state.js';
import { createActions } from '../src/editor/actions.js';
import * as cmd from '../src/editor/commands.js';
import { createNet } from '../src/editor/net.js';

const DRAFT_KEY = 'hypercat-editor-draft';

function storage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
  };
}

// The page around one net: a store with a small map, a ui that records its toasts, and a server that answers each POST
// with the next entry of `answers` ({ status, body, headers }).
function page(answers) {
  globalThis.document = { activeElement: null };
  globalThis.localStorage = storage();
  globalThis.sessionStorage = storage();
  const posts = [];
  globalThis.fetch = async (url, init = {}) => {
    posts.push({ url, method: init.method, headers: init.headers, at: performance.now() });
    const a = answers.shift() ?? { status: 500, body: { ok: false, error: 'internal' } };
    const headers = new Map(Object.entries(a.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return { status: a.status, ok: a.status >= 200 && a.status < 300, headers: { get: (name) => headers.get(name.toLowerCase()) ?? null }, json: async () => a.body };
  };
  const store = createStore(), ui = createUi({ storage: null }), toasts = [];
  ui.attach({ toast: (text, level) => toasts.push([typeof text === 'string' ? text : text.text, level]) });
  const map = emptyMap();
  map.objects.push(cmd.make('object', { m: 'medieval/barrel', x: 10, z: 10 }));
  store.load(map);
  const net = createNet();
  net.info = { enabled: true, tokenRequired: false, canSave: true, rev: 'r1' };
  net.baseRev = 'r1';
  net.install({ store, ui, actions: createActions(ui), modelSet: null });
  const edit = () => store.exec(cmd.set([map.objects[0]], { x: map.objects[0].x + 1 }));
  return { store, ui, net, map, toasts, posts, edit };
}

const saved = (rev) => ({ status: 200, body: { ok: true, rev } });
const unchanged = (rev) => ({ status: 200, body: { ok: true, rev, unchanged: true } });

test('a save that wrote unsaved work removes its draft; a save with nothing unsaved removes nothing', async () => {
  const { store, net, toasts, edit } = page([saved('r2'), unchanged('r2')]);
  edit();
  localStorage.setItem(DRAFT_KEY, '{"mine":true}');              // what io.js wrote 3 s after the edit
  assert.equal(await net.save(), true);
  assert.deepEqual([store.dirty, net.baseRev, localStorage.getItem(DRAFT_KEY)], [false, 'r2', null]);
  assert.match(toasts.at(-1)[0], /^Saved /);

  // Mod+S by reflex with nothing unsaved: "No changes". Whatever is in storage now is not this page's unsaved work -
  // a draft of an earlier session that still waits for its answer, another tab's - and it stays.
  localStorage.setItem(DRAFT_KEY, '{"somebody":"else"}');
  assert.equal(await net.save(), true);
  assert.equal(toasts.at(-1)[0], 'No changes');
  assert.equal(localStorage.getItem(DRAFT_KEY), '{"somebody":"else"}');
});

test('a draft that waits for its answer (net.draftKept) survives every save and the reload of a conflict', async () => {
  const { store, ui, net, edit } = page([saved('r2'), { status: 409, body: { ok: false, error: 'conflict', rev: 'r9' } }]);
  localStorage.setItem(DRAFT_KEY, '{"kept":true}');
  net.draftKept = true;
  edit();
  assert.equal(await net.save(), true);
  assert.deepEqual([store.dirty, localStorage.getItem(DRAFT_KEY)], [false, '{"kept":true}']);

  // 409, and the user says Reload: the edits of this page are given up - the kept draft is not theirs
  edit();
  ui.attach({ choose: async () => 'reload' });
  net.loadMap = async () => emptyMap();
  assert.equal(await net.save(), false);
  assert.deepEqual([store.dirty, localStorage.getItem(DRAFT_KEY)], [false, '{"kept":true}']);

  // without the flag the same reload removes the page's own draft, as before
  net.draftKept = false;
  const again = page([{ status: 409, body: { ok: false, error: 'conflict', rev: 'r9' } }]);
  again.edit();
  localStorage.setItem(DRAFT_KEY, '{"mine":true}');
  again.ui.attach({ choose: async () => 'reload' });
  again.net.loadMap = async () => emptyMap();
  assert.equal(await again.net.save(), false);
  assert.equal(localStorage.getItem(DRAFT_KEY), null);
});

test('429 with a short Retry-After is waited out and the save sent once more; a long one is an error', async () => {
  // the server takes one changing save a second: the second Mod+S right behind the first is not a failure
  const quick = page([{ status: 429, body: { ok: false, error: 'rate' }, headers: { 'Retry-After': 1 } }, saved('r2')]);
  quick.edit();
  assert.equal(await quick.net.save(), true);
  assert.equal(quick.posts.length, 2);
  assert.ok(quick.posts[1].at - quick.posts[0].at >= 1000, 'the second request waits for the time the server asked for');
  assert.deepEqual([quick.store.dirty, quick.net.baseRev], [false, 'r2']);
  assert.deepEqual(quick.toasts.map((t) => t[1]), ['info'], 'one toast: Saved');

  // ... once: a server that keeps refusing is told
  const stuck = page([
    { status: 429, body: { ok: false, error: 'rate' }, headers: { 'Retry-After': 1 } },
    { status: 429, body: { ok: false, error: 'rate' }, headers: { 'Retry-After': 1 } },
  ]);
  stuck.edit();
  assert.equal(await stuck.net.save(), false);
  assert.equal(stuck.posts.length, 2);
  assert.deepEqual(stuck.toasts.at(-1), ['Save failed (429): too many attempts, try again in a moment', 'error']);
  assert.equal(stuck.store.dirty, true);

  // the lock after wrong tokens asks for a minute: nobody waits for that in silence
  const locked = page([{ status: 429, body: { ok: false, error: 'rate' }, headers: { 'Retry-After': 60 } }]);
  locked.edit();
  assert.equal(await locked.net.save(), false);
  assert.equal(locked.posts.length, 1);
  assert.equal(locked.toasts.at(-1)[1], 'error');
});

test('an edit made while a save waits keeps the map dirty and its draft', async () => {
  const p = page([{ status: 429, body: { ok: false, error: 'rate' }, headers: { 'Retry-After': 1 } }, saved('r2')]);
  p.edit();
  const saving = p.net.save();
  await new Promise((resolve) => { setTimeout(resolve, 200); });
  p.edit();                                                      // during the wait
  localStorage.setItem(DRAFT_KEY, '{"mine":true}');
  assert.equal(await saving, true);
  assert.deepEqual([p.store.dirty, p.net.baseRev, localStorage.getItem(DRAFT_KEY)], [true, 'r2', '{"mine":true}']);
  assert.match(p.toasts.at(-1)[0], /edits made meanwhile are not saved yet/);
});
