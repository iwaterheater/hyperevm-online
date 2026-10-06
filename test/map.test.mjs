// The committed map (map/world.json) must always load: its text is canonical and it has no validation error.
// Nothing else may be asserted on it. The map is edited by hand in the map editor, so any fact about its content
// would fail after the next save; facts about the bake are checked on a fresh bake in test/bake.test.mjs.
// Run: node --test test/map.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalize, serialize, stringifyMap, validate } from '../src/map/format.js';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'map', 'world.json');
const text = fs.readFileSync(FILE, 'utf8');

// Where two texts part, in a form short enough to read: comparing them with assert.equal would print the whole map.
function firstDifference(actual, expected) {
  const a = actual.split('\n'), e = expected.split('\n');
  const i = e.findIndex((line, k) => line !== a[k]);
  const n = i < 0 ? e.length : i, show = (line) => (line === undefined ? 'nothing' : JSON.stringify(line.length > 120 ? `${line.slice(0, 120)}…` : line));
  return `line ${n + 1}: the file has ${show(a[n])}, the canonical writer produces ${show(e[n])}`;
}

test('map/world.json is canonical text', () => {
  const canonical = stringifyMap(serialize(normalize(JSON.parse(text))));
  assert.ok(canonical === text, `map/world.json was not written by the map editor or the bake - ${firstDifference(text, canonical)}`);
});

test('map/world.json has no validation error', () => {
  assert.deepEqual(validate(normalize(JSON.parse(text))).filter((issue) => issue.level === 'error'), []);
});
