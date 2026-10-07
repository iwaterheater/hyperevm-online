// The clipboard of the editor (src/editor/clipboard.js) and the names of the keys in a hint (keymap.js keyTextFor):
// what a clip may hold, what of it may be pasted right now, and how one key is written on two kinds of keyboard.
// Nothing here needs a browser: Node has no localStorage, so a clip lives in the module's memory.
// Run: node --test test/clipboard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyMap } from '../src/map/format.js';
import * as cmd from '../src/editor/commands.js';
import { createStore } from '../src/editor/store.js';
import { createUi } from '../src/editor/state.js';
import { clipSize, instantiate, makeClip, pasteOpen, readClip, writeClip } from '../src/editor/clipboard.js';
import { keyTextFor } from '../src/editor/keymap.js';

// An island with one item of each kind a clip can hold, in a store - and the clip of all four.
function bench() {
  const map = emptyMap({ radius: 120 });
  const object = cmd.make('object', { m: 'tree', x: 10, z: 0 }), spawn = cmd.make('spawn', { x: 20, z: 0, r: 4 });
  const chest = cmd.make('chest', { x: 30, z: 0 }), npc = cmd.make('npc', { kind: 'trader', x: 40, z: 0 });
  map.objects.push(object);
  map.spawns.push(spawn);
  map.chests.push(chest);
  map.npcs.push(npc);
  const store = createStore(), ui = createUi({ storage: null });
  store.load(map);
  const ctx = { store, ui, cmd, viewport: { preview: 'neutral' } };
  return { ctx, store, ui, map, clip: makeClip(ctx, [object, spawn, chest, npc]) };
}
const sizes = (made) => [made.objects.length, made.spawns.length, made.chests.length, made.npcs.length, made.skipped];

test('a clip holds the four kinds; instantiate brings them all in while every layer is open', () => {
  const { ctx, clip } = bench();
  assert.equal(clipSize(clip), 4);
  assert.deepEqual(clip.pivot, { x: 25, z: 0 });
  const made = instantiate(ctx, clip, { x: 0, z: 50 });
  assert.deepEqual(sizes(made), [1, 1, 1, 1, 0]);
  assert.deepEqual([made.objects[0].x, made.objects[0].z, made.npcs[0].x], [-15, 50, 15], 'moved so that the pivot is at the point');
});

test('a pasted item keeps the layer of its source while that layer is there and open; else it takes the active one', () => {
  const { ctx, store, ui, map } = bench();
  store.exec(cmd.addLayer('Town'));
  store.exec(cmd.addLayer('Forest'));
  store.exec(cmd.set([map.objects[0], map.spawns[0]], { l: 'Town' }));
  const clip = makeClip(ctx, [map.objects[0], map.spawns[0], map.chests[0]]);
  assert.deepEqual([clip.objects[0].l, clip.spawns[0].l, clip.chests[0].l], ['Town', 'Town', undefined], 'the clip carries the layer');
  const layersOf = (made) => [made.objects[0].l, made.spawns[0].l, made.chests[0].l];
  ui.set('activeLayer', 'Forest');
  assert.deepEqual(layersOf(instantiate(ctx, clip)), ['Town', 'Town', null], 'what was on no layer stays on none');
  ui.setLayerState('Town', { visible: false });
  assert.deepEqual(layersOf(instantiate(ctx, clip)), ['Forest', 'Forest', null], 'a hidden layer would swallow the copy');
  ui.setLayerState('Town', { visible: true, locked: true });
  assert.deepEqual(layersOf(instantiate(ctx, clip)), ['Forest', 'Forest', null]);
  ui.setLayerState('Town', { locked: false });
  store.exec(cmd.removeLayer('Town'));
  assert.deepEqual(layersOf(instantiate(ctx, clip)), ['Forest', 'Forest', null], 'a layer the map does not have (a stamp of another map)');
  ui.set('activeLayer', null);
  assert.deepEqual(layersOf(instantiate(ctx, clip)), [null, null, null]);
});

test('in the Game preview a paste leaves the markers out: they are not drawn there, so nothing unseen is added', () => {
  const { ctx, ui, clip } = bench();
  ctx.viewport.preview = 'game';
  assert.deepEqual(['object', 'spawn', 'chest', 'npc'].map((kind) => pasteOpen(ctx, kind)), [true, false, false, false]);
  assert.deepEqual(sizes(instantiate(ctx, clip, { x: 0, z: 0 })), [1, 0, 0, 0, 3], 'the objects come in, three markers are counted as skipped');

  // the preview of the viewport decides; without a viewport (a test, a script) ui.preview does
  ctx.viewport.preview = 'graveyard';
  assert.deepEqual(sizes(instantiate(ctx, clip, { x: 0, z: 0 })), [1, 1, 1, 1, 0], 'a mood preview still shows the markers');
  delete ctx.viewport;
  ui.set('preview', 'game');
  assert.deepEqual(sizes(instantiate(ctx, clip, { x: 0, z: 0 })), [1, 0, 0, 0, 3]);
  ui.set('preview', 'neutral');

  // a closed layer is left out as before, whatever the preview
  ui.set('layers', { ...ui.layers, objects: { ...ui.layers.objects, locked: true }, chests: { ...ui.layers.chests, visible: false } });
  assert.deepEqual(['object', 'spawn', 'chest', 'npc'].map((kind) => pasteOpen(ctx, kind)), [false, true, false, true]);
  assert.deepEqual(sizes(instantiate(ctx, clip, { x: 0, z: 0 })), [0, 1, 0, 1, 2]);
});

test('a clip with a coordinate no map can have is not a clip: nothing to paste, nothing to jam the Paste tool', () => {
  const { clip } = bench();
  assert.equal(writeClip(clip), false, 'kept in memory (Node has no storage)');
  assert.equal(clipSize(readClip()), 4);
  const bad = (change) => { const c = structuredClone(clip); change(c); return c; };
  for (const [what, c] of [
    ['a pivot beyond every map', bad((c) => { c.pivot.x = 1e308; })],
    ['an object at 1e308', bad((c) => { c.objects[0].x = 1e308; })],
    ['an object far above the world', bad((c) => { c.objects[0].y = -1e9; })],
    ['a camp far out', bad((c) => { c.spawns[0].z = 5e7; })],
    ['a chest far out', bad((c) => { c.chests[0].x = -1e300; })],
    ['a number that is none', bad((c) => { c.npcs[0].x = Infinity; })],
  ]) assert.throws(() => writeClip(c), TypeError, what);
  assert.equal(clipSize(readClip()), 4, 'the clipboard still holds the last real clip');
  // a clip from a map that is larger than this one - or copied from beyond its shore - is still a clip
  assert.doesNotThrow(() => writeClip(bad((c) => { c.objects[0].x = 5000; c.pivot.z = -900; })));
});

test('keyTextFor: one key has one name - the signs of a Mac keyboard, the words of every other', () => {
  const mac = (text) => keyTextFor(text, true), pc = (text) => keyTextFor(text, false);
  // a modifier with a gesture, with a key, with another modifier, alone
  assert.equal(mac('Alt+click picks'), '⌥-click picks');
  assert.equal(mac('Alt+Shift+1 stores the view'), '⌥⇧1 stores the view');
  assert.equal(mac('Shift + wheel'), '⇧-wheel');
  assert.equal(mac('Alt: erase brush models · Alt+Shift: erase any'), '⌥: erase brush models · ⌥⇧: erase any');
  assert.equal(mac('Mod+click adds one, Shift+click a range'), '⌘-click adds one, ⇧-click a range');
  assert.equal(mac('Q / E turn it (Shift 90, Alt 1)'), 'Q / E turn it (⇧ 90, ⌥ 1)');
  assert.equal(mac('Shift+Alt+drag'), '⌥⇧-drag', 'the signs in the order macOS writes them');
  assert.equal(mac('Mod+Enter plays, Mod+S saves'), '⌘↩ plays, ⌘S saves');
  // the two keys that have a sign of their own
  assert.equal(mac('Enter / double-click: paint · Backspace: one back · Esc cancels'), '↩ / double-click: paint · ⌫: one back · Esc cancels');
  // everywhere else the words stay, and Mod is the Ctrl key
  assert.equal(pc('Alt+click picks'), 'Alt+click picks');
  assert.equal(pc('Mod+click adds one, Shift+click a range'), 'Ctrl+click adds one, Shift+click a range');
  assert.equal(pc('Mod held while dragging'), 'Ctrl held while dragging');
  assert.equal(pc('Enter / double-click: paint · Backspace: one back'), 'Enter / double-click: paint · Backspace: one back');
  // only whole words that are keys: nothing inside another word is touched
  for (const text of ['Model and models', 'Entered, Shifted, Alternative', 'Click: place', '']) {
    assert.equal(mac(text), text);
    assert.equal(pc(text), text);
  }
});
