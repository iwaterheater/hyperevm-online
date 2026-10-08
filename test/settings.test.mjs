// The player's settings (src/settings.js): what is read back from the browser is checked, and what the renderer and
// the sound make of it. Pure: no browser.
// Run: node --test test/settings.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, RESOLUTIONS, cleanSettings, loudness, pixelRatio } from '../src/settings.js';

test('cleanSettings: nothing stored, or nonsense, gives the defaults', () => {
  for (const raw of [null, undefined, 'loud', 7, [], {}]) assert.deepEqual(cleanSettings(raw), DEFAULT_SETTINGS);
  assert.notEqual(cleanSettings(null), DEFAULT_SETTINGS, 'a copy, so changing it leaves the defaults alone');
});

test('cleanSettings: keeps what is valid, replaces what is not, drops what it does not know', () => {
  const s = cleanSettings({ sound: false, volume: 35, resolution: 'low', shadows: false, glow: false, grass: false, cheat: true });
  assert.deepEqual(s, { sound: false, volume: 35, resolution: 'low', shadows: false, glow: false, grass: false });
  assert.deepEqual(cleanSettings({ sound: 0, volume: '50', resolution: 'ultra', shadows: 'no', glow: null }), DEFAULT_SETTINGS);
  assert.equal(cleanSettings({ volume: 250 }).volume, 100);
  assert.equal(cleanSettings({ volume: -4 }).volume, 0);
  assert.equal(cleanSettings({ volume: 49.6 }).volume, 50);
  assert.equal(cleanSettings({ volume: NaN }).volume, DEFAULT_SETTINGS.volume);
  assert.equal(cleanSettings({ resolution: 'toString' }).resolution, DEFAULT_SETTINGS.resolution);
});

test('pixelRatio: a share of the screen\'s own, which counts up to 2', () => {
  assert.equal(pixelRatio('high', 1), 1);
  assert.equal(pixelRatio('high', 2), 2);
  assert.equal(pixelRatio('high', 3), 2);
  assert.equal(pixelRatio('medium', 2), 1.5);
  assert.equal(pixelRatio('low', 2), 1);
  assert.equal(pixelRatio('low', 1), 0.5);
  assert.equal(pixelRatio('high', undefined), 1);
  assert.equal(pixelRatio('high', 0), 1);
  for (const key of Object.keys(RESOLUTIONS)) assert.ok(pixelRatio(key, 1) > 0 && pixelRatio(key, 1) <= 1);
});

test('loudness: the volume as a factor, nothing while the sound is off', () => {
  assert.equal(loudness(DEFAULT_SETTINGS), 1);
  assert.equal(loudness({ ...DEFAULT_SETTINGS, volume: 40 }), 0.4);
  assert.equal(loudness({ ...DEFAULT_SETTINGS, sound: false }), 0);
  assert.equal(loudness({ ...DEFAULT_SETTINGS, volume: 0 }), 0);
});
