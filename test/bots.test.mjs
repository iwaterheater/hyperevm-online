// The bots (bots/): the grid they walk on, the character the server starts one with, and two of them let loose on a
// server of their own - one that hunts, one that murders.
// Run: node --test test/bots.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { normalize, stringifyMap, isBlocked, isSafe } from '../src/map/format.js';
import { ITEMS, SKILLS, CLASSES, equipError } from '../src/shared.js';
import { createNav, CELL } from '../bots/nav.mjs';
import { createWorld, ROSTER } from '../bots/run.mjs';
import { ROLES } from '../bots/bot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hypercat-bots-'));
const stops = [];
test.after(async () => {
  await Promise.all(stops.map((stop) => stop()));
  fs.rmSync(DIR, { recursive: true, force: true });
});

const bake = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'bake-map.mjs'), '--out', path.join(DIR, 'baked.json')], { cwd: DIR, encoding: 'utf8' });
assert.equal(bake.status, 0, `the bake failed: ${bake.stderr}`);
const FILE = JSON.parse(fs.readFileSync(path.join(DIR, 'baked.json'), 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A server of its own, on a free port, with the given map file and an empty data folder.
async function boot(file) {
  const dir = fs.mkdtempSync(path.join(DIR, 'run-'));
  fs.writeFileSync(path.join(dir, 'world.json'), stringifyMap(file));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, PORT: '0', MAP_FILE: path.join(dir, 'world.json'), DATA_DIR: path.join(dir, 'data') },
  });
  let out = '';
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', (data) => { out += data; const m = /localhost:(\d+)$/m.exec(out); if (m) resolve(Number(m[1])); });
    child.on('close', () => reject(new Error(`the server did not start:\n${out}`)));
  });
  const stop = () => new Promise((resolve) => { if (child.exitCode !== null) resolve(); else { child.on('close', resolve); child.kill('SIGKILL'); } });
  stops.push(stop);
  return { url: `http://localhost:${port}`, port, dir, stop };
}
// One join over a socket of its own; resolves with the first snapshot's `me` (bag and equipment included).
function joinOnce(s, msg, origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${s.port}`, origin ? { origin } : {});
    const timer = setTimeout(() => { ws.close(); reject(new Error('no snapshot')); }, 15000);
    ws.on('open', async () => {
      const rev = (await fetch(`${s.url}/api/map`)).headers.get('x-map-rev');
      ws.send(JSON.stringify({ t: 'join', name: 'Probe', cls: 'fighter', rev, ...msg }));
    });
    ws.on('message', (data) => {
      const m = JSON.parse(data);
      if (m.t !== 's') return;
      clearTimeout(timer);
      ws.once('close', () => resolve(m.me));
      ws.close();
    });
    ws.on('error', reject);
  });
}

test('the roster: ten bots with names of their own, classes that exist and roles that are known - some of them fighters of cats', () => {
  assert.equal(ROSTER.length, 10);
  assert.equal(new Set(ROSTER.map((b) => b.name)).size, 10);
  for (const b of ROSTER) {
    assert.ok(CLASSES[b.cls] && !CLASSES[b.cls].base, `${b.name}: a starting class`);
    assert.ok(ROLES[b.role], `${b.name}: ${b.role}`);
    assert.ok(/^[A-Za-z]{3,16}$/.test(b.name) && b.lvl >= 1 && b.cap >= b.lvl && b.cap <= b.lvl + 3);
  }
  const aggro = (kind) => ROSTER.filter((b) => ROLES[b.role].aggro === kind).length;
  assert.ok(aggro('pk') >= 2 && aggro('duel') >= 1 && aggro('guard') >= 1);
  assert.ok(ROSTER.some((b) => !ROLES[b.role].aggro), 'and some that only want to hunt in peace');
  assert.ok(ROSTER.filter((b) => b.cap <= 6).length >= 3, 'some stay small for good');
});

test('the grid: a bot walks only where a player can, and finds its way from the town to every camp', () => {
  const map = normalize(FILE), nav = createNav(map, ROOT);
  assert.ok(nav.free(map.start.x, map.start.z));
  assert.ok(!nav.free(map.radius + 5, 0), 'beyond the rim');
  // What the game calls blocked is blocked here. The island of the committed map has the sea, lakes and cliffs for it;
  // any map will do for this, and nothing is written.
  const island = normalize(JSON.parse(fs.readFileSync(path.join(ROOT, 'map', 'world.json'), 'utf8'))), shore = createNav(island, ROOT);
  let wet = 0, dry = 0;
  for (let x = -island.radius; x <= island.radius; x += 7.3) {
    for (let z = -island.radius; z <= island.radius; z += 7.3) {
      const c = shore.centre(x, z);
      assert.ok(Math.abs(c.x - x) <= CELL / 2 + 1e-9 && Math.abs(c.z - z) <= CELL / 2 + 1e-9);
      if (isBlocked(island, c.x, c.z)) { assert.ok(!shore.free(x, z), `${x}, ${z}`); wet++; } else if (shore.free(x, z)) dry++;
    }
  }
  assert.ok(wet > 20 && dry > 20, `${wet} blocked and ${dry} free points looked at`);
  // a tree stands in the way of a straight line, and the path goes around it
  const tree = map.objects.find((o) => /tree/i.test(o.m) && !nav.free(o.x, o.z) && nav.free(o.x - 6, o.z) && nav.free(o.x + 6, o.z));
  assert.ok(tree, 'a tree with room on both sides');
  assert.ok(!nav.clear(tree.x - 6, tree.z, tree.x + 6, tree.z));
  const round = nav.path(tree.x - 6, tree.z, tree.x + 6, tree.z);
  assert.ok(round.length >= 2, 'more than one leg');
  for (const spawn of map.spawns) {
    const way = nav.path(map.start.x, map.start.z, spawn.x, spawn.z);
    assert.ok(way, `no way to the camp at ${spawn.x}, ${spawn.z}`);
    let at = nav.nearestFree(map.start.x, map.start.z);
    for (const p of way) {
      assert.ok(nav.free(p.x, p.z));
      assert.ok(nav.clear(at.x, at.z, p.x, p.z), 'every leg is a straight walk');
      at = p;
    }
  }
  assert.equal(nav.path(0, 0, map.radius + 50, 0), null, 'nowhere to stand out there');
});

test('a bot starts as the character of its roster line - asked by a program on this machine, once, and never by a page', { timeout: 60000 }, async () => {
  const s = await boot(FILE);
  const me = await joinOnce(s, { token: 'bot-a', bot: { lvl: 12, cls: 'knight', family: 'greatsword' } });
  assert.deepEqual([me.level, me.cls, me.xp, me.gold], [12, 'fighter', 0, 480], 'a profession waits for its level');
  assert.deepEqual(me.eq, { weapon: 'steel_greatsword', offhand: null, head: 'steel_head', body: 'steel_body', hands: 'iron_hands', feet: 'iron_feet' });
  for (const id of Object.values(me.eq)) if (id) assert.ok(!equipError(me.cls, me.level, id), id);
  assert.deepEqual(me.inv, [['hp_large', 5], ['mp_small', 3]]);
  assert.deepEqual(me.skills, { power_strike: 2, weapon_mastery: 2, stun_strike: 1, war_cry: 1, armor_mastery: 1 });
  for (const id of Object.keys(me.skills)) assert.ok(SKILLS[id].lvl <= 12 && me.skills[id] <= SKILLS[id].sp.length);
  // the character is the token's from then on: what a later join asks for is not heard
  const again = await joinOnce(s, { token: 'bot-a', bot: { lvl: 40, cls: 'mystic' } });
  assert.deepEqual([again.level, again.cls], [12, 'fighter']);
  // at the level of a profession it starts in it; junk is a level 1 Fighter
  const high = await joinOnce(s, { token: 'bot-b', bot: { lvl: 25, cls: 'wizard' } });
  assert.deepEqual([high.level, high.cls, high.eq.weapon], [25, 'wizard', 'hypurr_staff']);
  const junk = await joinOnce(s, { token: 'bot-c', bot: { lvl: 'many', cls: 'constructor', family: '__proto__' } });
  assert.deepEqual([junk.level, junk.cls, junk.eq.weapon], [1, 'fighter', 'bronze_sword']);
  // a page - it names its Origin - gets a new cat like everybody
  const page = await joinOnce(s, { token: 'page', bot: { lvl: 30 } }, s.url);
  assert.deepEqual([page.level, page.gold, page.eq.weapon], [1, 0, null]);
  assert.ok(ITEMS[me.eq.weapon]);
});

test('bots at large: both walk out to the camp and hunt, and the murderer brings the peaceful one down', { timeout: 180000 }, async () => {
  // one camp of weak monsters on open ground far from the town: where both of them will go
  const camp = { ...FILE.spawns[0], types: { chaser: 1 }, lvl: [1, 2], x: 100, z: 100, r: 6, count: 5 };
  const s = await boot({ ...FILE, spawns: [camp] });
  const quiet = { url: s.url, verbose: false, breaks: false };
  // Two worlds, so that each takes the other for a person: bots of one roster seldom fight each other.
  const lines = [], listen = new WebSocket(`ws://localhost:${s.port}`);
  listen.on('message', (data) => { const m = JSON.parse(data); if (m.t === 'c' && m.sys) lines.push(m.m); });
  listen.on('open', async () => listen.send(JSON.stringify({ t: 'join', name: 'Watcher', cls: 'fighter', rev: (await fetch(`${s.url}/api/map`)).headers.get('x-map-rev') })));
  const lambs = await createWorld(quiet, [{ name: 'Lamb', cls: 'fighter', lvl: 2, role: 'farmer' }]);
  const wolves = await createWorld(quiet, [{ name: 'Fang', cls: 'fighter', lvl: 6, cap: 6, role: 'pk' }]);
  for (const world of [lambs, wolves]) { world.log = () => {}; stops.push(async () => world.stop()); }
  const lamb = lambs.list[0], fang = wolves.list[0], map = lambs.map;
  const until = async (what, fn, ms) => {
    for (const end = Date.now() + ms; !fn();) { assert.ok(Date.now() < end, `${what}: not within ${ms} ms`); await sleep(100); }
  };
  await until('both in the world', () => lamb.me && fang.me, 20000);
  assert.deepEqual([lamb.me.level, fang.me.level, fang.eq.weapon], [2, 6, 'iron_sword']);
  // on the way they never stand where a player could not
  let strayed = 0;
  const watch = setInterval(() => { for (const b of [lamb, fang]) if (b.me && !b.me.dead && isBlocked(map, b.pos.x, b.pos.z)) strayed++; }, 200);
  await until('the murder', () => lines.includes('Lamb was murdered by Fang'), 150000);
  clearInterval(watch);
  assert.equal(strayed, 0);
  await until('the count', () => fang.me.pk === 1 && fang.me.karma > 0, 5000);
  assert.ok(!isSafe(map, fang.pos.x, fang.pos.z), 'out in the field');
  assert.ok(fang.me.xp > 0 || lamb.me.xp > 0 || fang.me.gold !== 240, 'somebody found a monster first');
  // the murderer goes on hunting, and stays the size its roster line says: what it kills teaches it, but it does not grow
  await until('a monster down', () => fang.me.sp > 0, 90000);
  assert.deepEqual([fang.me.level, fang.me.xp], [6, 0]);
  listen.close();
  lambs.stop(); wolves.stop();
});
