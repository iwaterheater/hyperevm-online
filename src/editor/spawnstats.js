// The numbers behind monster camps: what the Spawns panel lists and totals, what "Set from spawns" writes into a
// region, where "Populate region" drops new camps, and the camp template of the Spawn tool.
// PURE: no DOM, no three - the panel and the tool draw what these functions return, and test/spawnstats.test.mjs runs
// them in plain Node.
//
// A camp belongs to the region that WINS at its centre (regionAt: later regions win, the fallback takes the rest).
// That is the region whose level band validate() compares the camp with (spawn-levels), and the one whose banner a
// player sees while fighting there - not every region whose shape happens to contain the point: "Cursed Lands"
// covers the whole island, and its camps are still only the ones of the outer ring.
import { MOB_KEYS, MOB_TYPES, AGGRO_R, BOSS_AGGRO_R, WANDER_R } from '../shared.js';
import { LIMITS, hasBoss, isBlocked, pushOutOfSafe, qPos, regionIndex, shapeBounds } from '../map/format.js';
import { make } from './commands.js';

const clamp = (v, [min, max]) => Math.max(min, Math.min(max, v));
const whole = (v, range, fallback) => (Number.isFinite(v) ? clamp(Math.round(v), range) : fallback);

// ---------------------------------------------------------------- one camp

// The monster types of a camp, in MOB_KEYS order (a weight of 0 or less is "absent", as in the weight fields).
export function typeKeys(types) {
  return MOB_KEYS.filter((key) => Object.hasOwn(types ?? {}, key) && types[key] > 0);
}

// How many monsters of each type a camp holds on average: count x weight / the sum of its weights.
// -> { [mobType]: number } with the keys in MOB_KEYS order; {} for a camp without a usable type.
export function expectedByType(spawn) {
  const keys = typeKeys(spawn.types), out = {};
  let total = 0;
  for (const key of keys) total += spawn.types[key];
  if (!(total > 0) || !(spawn.count > 0)) return out;
  for (const key of keys) out[key] = spawn.count * spawn.types[key] / total;
  return out;
}

// 'Skeleton Minion' for one type, 'chaser 3 : runner 2' for a mix - the wording of the marker labels.
export function mixText(types) {
  const keys = typeKeys(types);
  if (!keys.length) return 'no monsters';
  if (keys.length === 1) return MOB_TYPES[keys[0]].name;
  return keys.map((key) => `${key} ${types[key]}`).join(' : ');
}

export const levelText = (lvl) => (lvl[0] === lvl[1] ? `Lv ${lvl[0]}` : `Lv ${lvl[0]}–${lvl[1]}`);

// '4x Skeleton Minion · Lv 1-2 · 14 s': a camp or a template in one line.
export function campText(spawn) {
  return `${spawn.count}× ${mixText(spawn.types)} · ${levelText(spawn.lvl)} · ${spawn.respawn} s`;
}

// The monster type a camp is drawn in: the highest weight, ties by MOB_KEYS order (the rule of the map markers).
export function dominantType(types) {
  let best = null, weight = -Infinity;
  for (const key of typeKeys(types)) if (types[key] > weight) { best = key; weight = types[key]; }
  return best;
}

// green -> red over levels 1..20 (the middle of the camp's range), as a hex number: the "colour by level" of the
// viewport. HSL (120..0 degrees, 75 %, 50 %) written out, so that this module needs no three.
export function levelColor(lvl) {
  const t = Math.max(0, Math.min(1, ((lvl[0] + lvl[1]) / 2 - 1) / 19)), h = (1 - t) / 3, s = 0.75, l = 0.5;
  const q = l + s - l * s, p = 2 * l - q;
  const channel = (x) => {
    const u = ((x % 1) + 1) % 1;
    const v = u < 1 / 6 ? p + (q - p) * 6 * u : u < 1 / 2 ? q : u < 2 / 3 ? p + (q - p) * 6 * (2 / 3 - u) : p;
    return Math.round(Math.max(0, Math.min(1, v)) * 255);
  };
  return (channel(h + 1 / 3) << 16) | (channel(h) << 8) | channel(h - 1 / 3);
}

// The colour of a camp as a hex number: of its dominant monster type, or of its level when the overlay asks for that.
export function campColor(spawn, byLevel = false) {
  if (byLevel) return levelColor(spawn.lvl);
  const type = dominantType(spawn.types);
  return type ? MOB_TYPES[type].color : 0xffffff;
}

// How far from its centre a camp is dangerous: its monsters stroll WANDER_R beyond the disc and notice a player from
// there (the dashed threat ring of the viewport).
export function threatOf(spawn) {
  return spawn.r + WANDER_R + (hasBoss(spawn) ? BOSS_AGGRO_R : AGGRO_R);
}

// ---------------------------------------------------------------- the camp template

// The settings a new camp copies: { types, lvl, count, r, respawn }, every value inside LIMITS and owned by the result.
// Anything unusable falls back to the format's defaults, so a template can always be placed.
export function cleanTemplate(t) {
  const types = {};
  for (const key of MOB_KEYS) {
    const w = t?.types?.[key];
    if (Number.isFinite(w) && Math.round(w) >= 1) types[key] = clamp(Math.round(w), LIMITS.spawnWeight);
  }
  if (!Object.keys(types).length) types[MOB_KEYS[0]] = 1;
  let lo = whole(t?.lvl?.[0], LIMITS.level, 1), hi = whole(t?.lvl?.[1], LIMITS.level, lo);
  if (lo > hi) [lo, hi] = [hi, lo];
  return {
    types, lvl: [lo, hi],
    count: whole(t?.count, LIMITS.spawnCount, 3),
    r: Number.isFinite(t?.r) ? qPos(clamp(t.r, LIMITS.spawnR)) : 8,
    respawn: whole(t?.respawn, LIMITS.spawnRespawn, 14),
  };
}

// The template a camp stands for: its five settings, without its place.
export const templateOf = (spawn) => cleanTemplate(spawn);

export function sameTemplate(a, b) {
  const ka = typeKeys(a.types), kb = typeKeys(b.types);
  return ka.length === kb.length && ka.every((key, i) => key === kb[i] && a.types[key] === b.types[key])
    && a.lvl[0] === b.lvl[0] && a.lvl[1] === b.lvl[1] && a.count === b.count && a.r === b.r && a.respawn === b.respawn;
}

// Ready-made camps: the three zone packs of the baked world (their mixes, sizes and level bands), one camp per single
// monster type, and the boss.
export const SPAWN_PRESETS = [
  { id: 'meadow', label: 'Meadow pack', template: { types: { chaser: 3, runner: 2 }, lvl: [1, 3], count: 3, r: 14, respawn: 14 } },
  { id: 'graveyard', label: 'Graveyard pack', template: { types: { chaser: 1, runner: 1, shooter: 2 }, lvl: [5, 7], count: 4, r: 16, respawn: 14 } },
  { id: 'cursed', label: 'Cursed pack', template: { types: { chaser: 1, runner: 1, shooter: 1, tank: 2 }, lvl: [10, 12], count: 4, r: 16, respawn: 14 } },
  { id: 'minions', label: 'Minions', template: { types: { chaser: 1 }, lvl: [1, 2], count: 4, r: 12, respawn: 14 } },
  { id: 'rogues', label: 'Rogue ambush', template: { types: { runner: 1 }, lvl: [3, 5], count: 3, r: 10, respawn: 14 } },
  { id: 'mages', label: 'Mage circle', template: { types: { shooter: 1 }, lvl: [6, 8], count: 3, r: 10, respawn: 20 } },
  { id: 'warriors', label: 'Warrior guard', template: { types: { tank: 1 }, lvl: [10, 12], count: 2, r: 8, respawn: 30 } },
  { id: 'boss', label: 'Boss', template: { types: { boss: 1 }, lvl: [18, 18], count: 1, r: 0, respawn: 90 } },
];

// ---------------------------------------------------------------- the table

// One row per camp, in map order: { spawn, index, region, types, lvl, count, r, respawn }.
// region: the region that wins at the camp's centre, or map.fallback. types and lvl are copies - a row is a
// snapshot, and nothing a reader does to it reaches the map.
export function spawnRows(map) {
  const index = regionIndex(map);
  return map.spawns.map((spawn, i) => ({
    spawn, index: i, region: index.regionAt(spawn.x, spawn.z),
    types: { ...spawn.types }, lvl: [spawn.lvl[0], spawn.lvl[1]], count: spawn.count, r: spawn.r, respawn: spawn.respawn,
  }));
}

const widen = (range, lvl) => {
  if (!Array.isArray(lvl) || !Number.isFinite(lvl[0]) || !Number.isFinite(lvl[1])) return range;
  return range ? [Math.min(range[0], lvl[0]), Math.max(range[1], lvl[1])] : [lvl[0], lvl[1]];
};

// The monsters of every region: [{ region, camps, monsters, byType: { [mobType]: expected count }, lvl: [min, max] | null }].
// One entry per region in file order (so the LAST one wins where two overlap), then map.fallback - also for a region
// that holds no camp (monsters 0, byType {}, lvl null). The `monsters` of all entries add up to spawnCount(map).
// lvl is the real range of the monsters there, a boss included.
export function totalsByRegion(map) {
  const index = regionIndex(map), totals = new Map();
  for (const region of [...map.regions, map.fallback]) totals.set(region, { region, camps: 0, monsters: 0, byType: {}, lvl: null });
  for (const spawn of map.spawns) {
    const t = totals.get(index.regionAt(spawn.x, spawn.z));
    if (!t) continue;
    t.camps++;
    t.monsters += spawn.count;
    t.lvl = widen(t.lvl, spawn.lvl);
    const expected = expectedByType(spawn);
    for (const key of Object.keys(expected)) t.byType[key] = (t.byType[key] ?? 0) + expected[key];
  }
  // byType in MOB_KEYS order, whatever order the camps came in
  for (const t of totals.values()) t.byType = Object.fromEntries(MOB_KEYS.filter((key) => key in t.byType).map((key) => [key, t.byType[key]]));
  return [...totals.values()];
}

// The level band of a region, read off its camps: [lowest min, highest max] over the camps the region wins, or null
// when it has none. A camp with a boss is left out, as validate() leaves it out of spawn-levels: the King is level 18
// in a land of 10-15, and the banner should say what a player meets on the way. Only a region that holds nothing but
// boss camps takes their levels. `region` may be map.fallback.
export function levelsFromSpawns(map, region) {
  const index = regionIndex(map);
  let plain = null, all = null;
  for (const spawn of map.spawns) {
    if (index.regionAt(spawn.x, spawn.z) !== region) continue;
    all = widen(all, spawn.lvl);
    if (!hasBoss(spawn)) plain = widen(plain, spawn.lvl);
  }
  return plain ?? all;
}

// ---------------------------------------------------------------- sorting and filtering the table

export const SORT_KEYS = ['index', 'region', 'types', 'lvl', 'count', 'r', 'respawn'];

// What the "Monsters" column sorts by: the strongest type present first (boss, tank, ...), then the richer mix.
const mixRank = (types) => {
  const keys = typeKeys(types);
  return keys.length ? MOB_KEYS.indexOf(keys[keys.length - 1]) * 10 + keys.length : -1;
};

// -> a new array of the rows sorted by one column. dir: 1 ascending, -1 descending. Rows that tie keep map order.
export function sortRows(rows, key = 'index', dir = 1) {
  const sign = dir < 0 ? -1 : 1;
  const by = {
    index: () => 0,
    region: (a, b) => String(a.region?.name ?? '').localeCompare(String(b.region?.name ?? '')),
    types: (a, b) => mixRank(a.types) - mixRank(b.types),
    lvl: (a, b) => a.lvl[0] - b.lvl[0] || a.lvl[1] - b.lvl[1],
    count: (a, b) => a.count - b.count,
    r: (a, b) => a.r - b.r,
    respawn: (a, b) => a.respawn - b.respawn,
  }[key] ?? (() => 0);
  return rows.slice().sort((a, b) => sign * by(a, b) || sign * (a.index - b.index));
}

// A filter text as the panel's search box takes it: words that must all be found in the camp's region name or among
// its monster types (ids and names), and level terms - 'lv7' (camps that can hold a level 7 monster), 'lv5-9'.
// -> { words: string[], levels: [min, max][] }
export function parseFilter(text) {
  const words = [], levels = [];
  for (const token of String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean)) {
    const m = /^(?:lv|lvl|level)(\d{1,3})(?:[-–](\d{1,3}))?$/.exec(token);
    if (m) {
      const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
      levels.push([Math.min(a, b), Math.max(a, b)]);
    } else words.push(token);
  }
  return { words, levels };
}

// -> the rows that pass. text: see parseFilter. region: a region object (or map.fallback) to keep only its camps;
// null / undefined = every region.
export function filterRows(rows, { text = '', region = null } = {}) {
  const { words, levels } = parseFilter(text);
  if (!words.length && !levels.length && !region) return rows.slice();
  return rows.filter((row) => {
    if (region && row.region !== region) return false;
    for (const [min, max] of levels) if (row.lvl[1] < min || row.lvl[0] > max) return false;
    if (!words.length) return true;
    const keys = typeKeys(row.types);
    const hay = `${row.region?.name ?? ''} ${keys.join(' ')} ${keys.map((key) => MOB_TYPES[key].name).join(' ')}`.toLowerCase();
    return words.every((word) => hay.includes(word));
  });
}

// ---------------------------------------------------------------- populate

const MAX_TRIES = 20000;

// New camps for a region: up to `n` copies of `template`, dropped at random where a camp may stand.
// -> Spawn[]: new items (made with make, not yet added to the map), in the order they were found. Fewer than n when
// the region has no room for more; [] when it has none at all. The map is not changed.
// A point is taken when
//   - `region` wins there (regionAt) - so a camp for the outer land never lands in the meadows inside it;
//     `region` may be map.fallback;
//   - the whole disc stays LIMITS.spawnMargin inside the map radius;
//   - no safe region is closer to the centre than r + WANDER_R (monsters would stroll up to its edge), and the centre
//     is not on blocked ground;
//   - the disc stays `keepOut` away from every chest and NPC and from the start disc;
//   - the centre is at least `spacing` from every other camp, old and new (default: discs and their strolling
//     margins do not overlap).
// rnd: () => [0, 1) - pass a seeded one for a repeatable layout. The collection cap of the format is respected: the
// map never ends up with more than LIMITS.spawns camps.
export function populate(map, region, { n, spacing = null, template, keepOut = 6, rnd = Math.random } = {}) {
  const out = [];
  if (!map || !region || !template) return out;
  const t = cleanTemplate(template), r = t.r;
  const want = Math.min(Number.isFinite(n) ? Math.floor(n) : 0, LIMITS.spawns - map.spawns.length);
  const reach = map.radius - LIMITS.spawnMargin - r;       // how far from the middle a centre may be
  if (!(want >= 1) || !(reach >= 0)) return out;
  const gap = Number.isFinite(spacing) && spacing >= 0 ? spacing : 2 * (r + WANDER_R);
  const margin = Number.isFinite(keepOut) && keepOut > 0 ? keepOut : 0;

  // the box to throw darts into: the region's own, cut to where a centre may be at all
  const b = region.shape ? shapeBounds(region.shape) : { minX: -reach, maxX: reach, minZ: -reach, maxZ: reach };
  const minX = Math.max(b.minX, -reach), maxX = Math.min(b.maxX, reach), minZ = Math.max(b.minZ, -reach), maxZ = Math.min(b.maxZ, reach);
  if (!(minX <= maxX && minZ <= maxZ)) return out;

  const index = regionIndex(map), probe = { x: 0, z: 0 };
  const camps = map.spawns.map((s) => [s.x, s.z]);
  const avoid = [...map.chests, ...map.npcs].map((p) => [p.x, p.z, r + margin]);
  avoid.push([map.start.x, map.start.z, map.start.r + r + margin]);
  const near = (list, x, z, d) => list.some((p) => Math.hypot(x - p[0], z - p[1]) < (d ?? p[2]));

  const tries = Math.min(MAX_TRIES, Math.max(400, want * 400));
  for (let i = 0; i < tries && out.length < want; i++) {
    const x = qPos(minX + rnd() * (maxX - minX)), z = qPos(minZ + rnd() * (maxZ - minZ));
    if (Math.hypot(x, z) > reach || index.regionAt(x, z) !== region || isBlocked(map, x, z)) continue;
    probe.x = x; probe.z = z;
    if (pushOutOfSafe(map, probe, r + WANDER_R)) continue;      // it moved: a safe region holds the point or comes too close
    if (near(avoid, x, z) || near(camps, x, z, gap)) continue;
    out.push(make('spawn', { types: t.types, lvl: t.lvl, x, z, r, count: t.count, respawn: t.respawn }));
    camps.push([x, z]);
  }
  return out;
}
