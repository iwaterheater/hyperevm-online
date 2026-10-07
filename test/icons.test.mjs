// Icons (src/icons.js, assets/icons): every skill and every item of src/shared.js has a picture, the files the module
// lists are the files on the disk, and each is a 128 px RGBA PNG.
// Run: node --test test/icons.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_KEYS, ITEMS, ITEM_KEYS } from '../src/shared.js';
import { skillIcon, itemIcon, ATTACK_ICON, ICON_FILES } from '../src/icons.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// a URL of the page ("./assets/...") as a file of the project
const fileOf = (url) => path.join(ROOT, url.replace(/^\.\//, ''));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('every skill has an icon of its own', () => {
  const seen = new Set();
  for (const id of SKILL_KEYS) {
    const url = skillIcon(id);
    assert.equal(url, `./assets/icons/skills/${id}.png`);
    assert.ok(fs.existsSync(fileOf(url)), `${url} exists`);
    seen.add(url);
  }
  assert.equal(seen.size, SKILL_KEYS.length);
});

test('every item has an icon: one per weapon family, armour slot and potion, shared by the tiers', () => {
  for (const id of ITEM_KEYS) {
    const it = ITEMS[id], url = itemIcon(id);
    assert.ok(url, `${id} has an icon`);
    assert.ok(fs.existsSync(fileOf(url)), `${url} exists`);
    // kinds that are being added (a shield for the off hand) may name their picture by family, slot, kind or id
    const key = it.kind === 'potion' ? id : it.kind === 'weapon' ? it.family : ['head', 'body', 'hands', 'feet'].includes(it.slot) ? it.slot : null;
    if (key) assert.equal(url, `./assets/icons/items/${key}.png`, id);
  }
  assert.equal(itemIcon('iron_sword'), itemIcon('hypurr_sword'));
  assert.equal(itemIcon('leather_head'), itemIcon('steel_head'));
  assert.notEqual(itemIcon('hp_small'), itemIcon('hp_large'));
});

test('the kinds of item that are on their way, and the basic attack, have icons already', () => {
  for (const key of ['greatsword', 'shield', 'attack']) {
    assert.equal(itemIcon(key), `./assets/icons/items/${key}.png`);
    assert.ok(fs.existsSync(fileOf(itemIcon(key))), `${key} exists`);
  }
  assert.equal(ATTACK_ICON, './assets/icons/items/attack.png');
});

test('what is not a skill or an item has no icon', () => {
  for (const id of ['', 'nothing', 'constructor', '__proto__', 'weapon', 'potion', 7, null, undefined]) {
    assert.equal(skillIcon(id), undefined, `skill ${String(id)}`);
    assert.equal(itemIcon(id), undefined, `item ${String(id)}`);
  }
  assert.equal(skillIcon('sword'), undefined);
  assert.equal(itemIcon('power_strike'), undefined);
});

test('the listed files are the files of assets/icons, each a 128 px RGBA PNG, no two alike', () => {
  assert.equal(new Set(ICON_FILES).size, ICON_FILES.length);
  assert.equal(ICON_FILES.length, SKILL_KEYS.length + 15);
  const bodies = new Map();
  for (const file of ICON_FILES) {
    const data = fs.readFileSync(path.join(ROOT, file));
    assert.ok(data.subarray(0, 8).equals(PNG) && data.toString('latin1', 12, 16) === 'IHDR', `${file} is a PNG`);
    assert.deepEqual([data.readUInt32BE(16), data.readUInt32BE(20)], [128, 128], `${file} is 128 x 128`);
    assert.deepEqual([data[24], data[25]], [8, 6], `${file} is 8-bit RGBA`);
    const body = data.toString('base64');
    assert.ok(!bodies.has(body), `${file} is not a copy of ${bodies.get(body)}`);
    bodies.set(body, file);
  }
  for (const dir of ['skills', 'items']) {
    const onDisk = fs.readdirSync(path.join(ROOT, 'assets', 'icons', dir)).filter((f) => !f.startsWith('.')).map((f) => `assets/icons/${dir}/${f}`).sort();
    assert.deepEqual(onDisk, ICON_FILES.filter((f) => f.startsWith(`assets/icons/${dir}/`)).sort(), `assets/icons/${dir} holds the listed files and nothing else`);
  }
});
