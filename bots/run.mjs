// Runs the bots: cats that play the game on their own, so that the world is never empty.
//
//   node bots/run.mjs                       ten bots on http://localhost:8765
//   node bots/run.mjs --url http://localhost:8770 --count 4 --verbose
//
// A bot is a player like any other: it joins through the game's WebSocket, is saved by the server with its level and
// its gear, and comes back as it left. The first time a bot joins, the server gives it the character of its line in
// the roster (see botCharacter in server.js) - for that the bots have to run on the machine the server runs on.
// The roster is below: a name, a class, the level it starts at, and a role - how it treats other cats (ROLES in bot.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { normalize } from '../src/map/format.js';
import { createNav } from './nav.mjs';
import { Bot, LINES } from './bot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ROSTER = [
  { name: 'Mochi',     cls: 'fighter', lvl: 6,  role: 'farmer' },
  { name: 'Biscuit',   cls: 'mystic',  lvl: 5,  role: 'farmer' },
  { name: 'Pixel',     cls: 'mystic',  lvl: 3,  role: 'farmer' },
  { name: 'Luna',      cls: 'mystic',  lvl: 11, role: 'veteran', prof: 'cleric' },
  { name: 'SirPounce', cls: 'fighter', lvl: 12, role: 'guard',   prof: 'knight' },
  { name: 'Tofu',      cls: 'mystic',  lvl: 8,  role: 'duelist', prof: 'wizard' },
  { name: 'Whisk',     cls: 'fighter', lvl: 7,  role: 'duelist', family: 'bow', prof: 'archer' },
  { name: 'Nyx',       cls: 'fighter', lvl: 9,  role: 'pk',      family: 'daggers', prof: 'rogue' },
  { name: 'Grumbles',  cls: 'fighter', lvl: 10, role: 'pk',      family: 'greatsword' },
  { name: 'Bandit',    cls: 'fighter', lvl: 14, role: 'pk',      prof: 'rogue' },
];

const TICK = 0.1;   // seconds between two thoughts of a bot

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function options(argv) {
  const opt = { url: 'http://localhost:8765', count: ROSTER.length, verbose: false, breaks: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url') opt.url = argv[++i].replace(/\/$/, '');
    else if (argv[i] === '--count') opt.count = Math.max(1, Math.min(ROSTER.length, Number(argv[++i]) || 1));
    else if (argv[i] === '--verbose') opt.verbose = true;
    else if (argv[i] === '--no-breaks') opt.breaks = false;
  }
  return opt;
}

// What the bots share: the map, the grid to walk on, and one voice in the chat between them.
export async function createWorld(opt, roster = ROSTER.slice(0, opt.count)) {
  const world = { url: opt.url, map: null, rev: '', nav: null, bots: new Set(roster.map((spec) => spec.name)), list: [], time: 0 };
  const stamp = () => new Date().toTimeString().slice(0, 8);
  // `quiet` lines are the bot's small decisions: shown with --verbose only
  world.log = (bot, text, quiet = false) => { if (!quiet || opt.verbose) console.log(`${stamp()} ${bot ? bot.spec.name.padEnd(10) : ''}${text}`); };

  async function loadMap() {
    const res = await fetch(`${opt.url}/api/map`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`GET /api/map: ${res.status}`);
    world.rev = res.headers.get('x-map-rev') || (res.headers.get('etag') || '').replace(/^W\//, '').replace(/"/g, '');
    world.map = normalize(await res.json());
    world.nav = createNav(world.map, ROOT);
  }
  await loadMap();

  // The chat. A bot speaks when the moment and the dice say so, and never two lines in a row: one line a quarter of a
  // minute between all of them, one a minute and a half for each. It types for a moment first.
  let lastLine = -99;
  world.say = (bot, kind, chance = 1) => {
    if (Math.random() > chance || world.time - lastLine < 15 || world.time - (bot.spokeAt ?? -99) < 90) return;
    lastLine = bot.spokeAt = world.time;
    const text = pick(LINES[kind]);
    setTimeout(() => bot.send({ t: 'c', m: text }), rand(900, 3500));
  };
  // What the bots hear. Every bot gets every line, so the first one in the list answers for all.
  world.heard = (bot, msg) => {
    if (bot !== world.list.find((b) => b.joined)) return;
    const answer = (kind, chance) => { const who = pick(world.list.filter((b) => b.joined)); if (who) world.say(who, kind, chance); };
    if (msg.sys && / is now a /.test(msg.m ?? '')) answer('level', 0.3);
    else if (!msg.sys && !world.bots.has(msg.n) && /^(hi|hello|hey|yo|sup|o\/)\b/i.test(msg.m ?? '')) answer('hello', 0.9);
  };

  world.joined = (bot) => {
    world.log(bot, `joined (${bot.spec.cls} ${bot.spec.lvl}, ${bot.spec.role})`);
    world.say(bot, 'hello', 0.35);
  };
  // A bot that lost its connection comes back after a few seconds; one that left for a break, when the break is over.
  world.left = (bot, ws) => {
    if (bot.ws !== ws || world.stopped) return;
    const wait = bot.breakFor ?? rand(4, 9);
    world.log(bot, bot.breakFor ? `takes a break of ${Math.round(wait / 60)} min` : 'lost its connection');
    bot.breakFor = null;
    bot.back = setTimeout(() => bot.connect(WebSocket), wait * 1000);
  };
  // The map was saved in the editor: every bot loads it again and joins anew, as the game's own page does.
  let reloading = null;
  world.mapChanged = (rev) => {
    if (rev === world.rev || reloading) return;
    reloading = loadMap().then(() => { for (const bot of world.list) bot.disconnect(); }, (err) => world.log(null, `map reload failed: ${err.message}`)).finally(() => { reloading = null; });
  };

  world.list = roster.map((spec) => new Bot(world, spec));
  // They do not all arrive in the same second, and each takes a break now and then: people come and go.
  world.list.forEach((bot, i) => {
    bot.back = setTimeout(() => bot.connect(WebSocket), i === 0 ? 0 : rand(1, 6) * 1000 * i);
    bot.breakAt = rand(25, 70) * 60;
  });
  const timer = setInterval(() => {
    world.time += TICK;
    for (const bot of world.list) {
      try { bot.tick(TICK); } catch (err) { world.log(bot, `tick failed: ${err.stack}`); }
      if (opt.breaks && bot.joined && world.time > bot.breakAt && !bot.foe && bot.me && !bot.me.dead) {
        bot.breakAt = world.time + rand(25, 70) * 60;
        bot.breakFor = rand(2, 8) * 60;
        bot.send({ t: 'c', m: pick(LINES.bye) });
        setTimeout(() => bot.disconnect(), 1500);
      }
    }
  }, TICK * 1000);
  world.stop = () => {
    world.stopped = true;
    clearInterval(timer);
    for (const bot of world.list) { clearTimeout(bot.back); bot.disconnect(); }
  };
  return world;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opt = options(process.argv.slice(2));
  try {
    const world = await createWorld(opt);
    console.log(`${world.list.length} bots for ${opt.url} (map ${world.rev}); Ctrl + C stops them`);
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { world.stop(); setTimeout(() => process.exit(0), 300); });
    if (opt.verbose) {
      // a line a bot every half minute: where it is and how it is doing
      setInterval(() => {
        for (const b of world.list) {
          if (b.joined && b.me) world.log(b, `lvl ${b.me.level} hp ${Math.round(b.hp * 100)}% gold ${b.me.gold} pvp ${b.me.pvp} pk ${b.me.pk} karma ${b.me.karma} at ${Math.round(b.pos.x)}, ${Math.round(b.pos.z)}${b.foe ? ' FIGHTING A CAT' : b.errand ? ' in town' : b.resting ? ' resting' : ''}`);
        }
      }, 30000);
    }
  } catch (err) {
    console.error(`The bots could not start: ${err.message}. Is the game running at ${opt.url}?`);
    process.exit(1);
  }
}
