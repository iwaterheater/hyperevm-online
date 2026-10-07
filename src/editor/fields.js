// The field schema: which fields each kind of item shows in the inspector, with their types and limits.
// Pure - no DOM. The inspector renders it generically, so a tool owner never edits the inspector and the inspector
// never hard-codes a kind. The limits are the ones validate() checks (LIMITS): one table for the widgets and the server.
//
// Entry: { key, label, type, ...options }
//   type      number | int | angle | text | bool | select | color | model | collider | group | layer | weights |
//             intRange | intRangeOrNull | computed | action
//   min, max  numbers, or a function of the map (called when the field is drawn)
//   patch     (item, value) -> patch: when present, EVERY editor of that key builds its command as
//             cmd.setEach(items, items.map((it) => field.patch(it, value))) instead of cmd.set(items, { [key]: value })
//   text      (item) -> string, for `computed`
//   action    an action id, for `action`: ctx.actions.run(action, items)
import { MOB_KEYS, MOB_TYPES, mobStats } from '../shared.js';
import { LIMITS, MOODS, NPC_KINDS, maxRadius } from '../map/format.js';

// A group id (the `g` of objects, spawns, chests and NPCs), as validate() accepts it. An empty text clears the group.
export const GROUP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;

const RESPAWN = 14, BOSS_RESPAWN = 90;      // seconds: what a camp gets by default, and what the boss had before maps were data

// The patch for new `types` of a spawn, with the boss respawn rule: a camp that becomes the boss alone takes the
// boss's respawn time, a boss spawn that loses its boss takes the camp's - but only from the other default, never
// over a time somebody chose. Pure: neither argument is changed.
// A weight of 0 means "absent" in the weight widgets, so such keys are left out of the result.
export function typesPatch(spawn, types) {
  const next = {};
  for (const k of Object.keys(types)) if (types[k] !== 0) next[k] = types[k];
  const keys = Object.keys(next), has = Object.hasOwn(next, 'boss'), had = Object.hasOwn(spawn.types, 'boss');
  if (has && keys.length === 1 && spawn.respawn === RESPAWN) return { types: next, respawn: BOSS_RESPAWN };
  if (had && !has && spawn.respawn === BOSS_RESPAWN) return { types: next, respawn: RESPAWN };
  return { types: next };
}

// One end of an ordered pair (the levels of a spawn or of a region) typed into a field, as the new pair of ONE item:
// the other end stays the item's own, and an end typed past it takes it along. An item that has no pair yet gets the
// value at both ends. Every editor of a pair builds one patch per item with this - a pair read from the field would
// write the other end of whatever item the field happened to show over all of them. Pure: `pair` is not changed.
//   end: 0 = the low end, 1 = the high end
export function withEnd(pair, end, value) {
  const next = Array.isArray(pair) ? [pair[0], pair[1]] : [value, value];
  next[end] = value;
  if (next[0] > next[1]) next[1 - end] = value;
  return next;
}

const span = (a, b) => (a === b ? a.toLocaleString('en-US') : `${a.toLocaleString('en-US')}–${b.toLocaleString('en-US')}`);

// One line per monster type of the spawn: its HP, P.Atk and XP at the lowest and the highest level.
function statsText(spawn) {
  const lvl = spawn.lvl, ok = (v) => Number.isInteger(v) && v >= LIMITS.level[0] && v <= LIMITS.level[1];
  if (!Array.isArray(lvl) || !ok(lvl[0]) || !ok(lvl[1]) || lvl[0] > lvl[1]) return '—';
  const lines = [];
  for (const type of MOB_KEYS) {
    if (!Object.hasOwn(spawn.types, type)) continue;
    const lo = mobStats(type, lvl[0]), hi = mobStats(type, lvl[1]), xp = MOB_TYPES[type].xp;      // the server pays xp × level
    lines.push(`${MOB_TYPES[type].name}: HP ${span(lo.maxHp, hi.maxHp)} · P.Atk ${span(lo.pAtk, hi.pAtk)} · XP ${span(xp * lvl[0], xp * lvl[1])}`);
  }
  return lines.length ? lines.join('\n') : '—';
}

const L = LIMITS;
const X = { key: 'x', type: 'number', step: 0.1 }, Z = { key: 'z', type: 'number', step: 0.1 };
const RY = { key: 'ry', label: 'Rotation', type: 'angle' };
const GROUP = { key: 'g', label: 'Group', type: 'group', pattern: GROUP_PATTERN, maxLength: 32 };
// The layer of the map's own (map.layers) that an object, spawn, chest or NPC is on: a choice of them, or none (null).
// Exported: a selection of several kinds shows this one field, the only one they all have.
export const LAYER = Object.freeze({ key: 'l', label: 'Layer', type: 'layer' });

const SCHEMA = {
  object: [
    { key: 'm', label: 'Model', type: 'model' },
    // y is counted from the ground under the object: on a hill it stands on the hill at y = 0
    X, { key: 'y', type: 'number', step: 0.1, min: L.objectY[0], max: L.objectY[1], title: 'Height above the ground under the object (0 = standing on it)' }, Z,
    RY, { key: 'rx', label: 'Tilt X', type: 'angle' }, { key: 'rz', label: 'Tilt Z', type: 'angle' },
    { key: 's', label: 'Scale', type: 'number', min: L.scale[0], max: L.scale[1], step: 0.05, digits: 3 },
    { key: 'sy', label: 'Height ×', type: 'number', min: L.scale[0], max: L.scale[1], step: 0.05, digits: 3 },
    { key: 'col', label: 'Collider', type: 'collider' },      // catalog default | none | factor | box | circles (JSON text)
    GROUP, LAYER,
  ],
  spawn: [
    { key: 'types', label: 'Monsters', type: 'weights', options: [...MOB_KEYS], min: 0, max: L.spawnWeight[1], patch: typesPatch },
    { key: 'lvl', label: 'Level', type: 'intRange', min: L.level[0], max: L.level[1] },
    X, Z,
    { key: 'r', label: 'Radius', type: 'number', min: L.spawnR[0], max: L.spawnR[1], step: 0.5 },
    { key: 'count', type: 'int', min: L.spawnCount[0], max: L.spawnCount[1] },
    { key: 'respawn', label: 'Respawn (s)', type: 'int', min: L.spawnRespawn[0], max: L.spawnRespawn[1] },
    { label: 'Stats', type: 'computed', text: statsText },
    GROUP, LAYER,
  ],
  chest: [
    X, Z, RY,
    { key: 'gold', type: 'int', min: L.chestGold[0], max: L.chestGold[1] },
    { key: 'big', type: 'bool' },
    { key: 'respawn', label: 'Respawn (s)', type: 'int', min: L.chestRespawn[0], max: L.chestRespawn[1] },
    GROUP, LAYER,
  ],
  npc: [{ key: 'kind', type: 'select', options: [...NPC_KINDS] }, X, Z, RY, GROUP, LAYER],
  region: [
    { key: 'name', type: 'text', minLength: L.regionName[0], maxLength: L.regionName[1] },
    { key: 'levels', label: 'Levels', type: 'intRangeOrNull', min: L.level[0], max: L.level[1] },
    { label: 'Set from spawns', type: 'action', action: 'region.levelsFromSpawns' },
    { key: 'mood', type: 'select', options: [null, ...Object.keys(MOODS)] },      // null = '(inherit)'
    { key: 'safe', type: 'bool' },
    { key: 'color', label: 'Colour', type: 'color' },      // the word every other panel uses
  ],
  start: [X, Z, { key: 'r', label: 'Radius', type: 'number', min: L.startR[0], max: L.startR[1], step: 0.5 }],
  // nothing selected: the map itself, written with cmd.setProps
  map: [
    { key: 'name', type: 'text', minLength: L.name[0], maxLength: L.name[1] },
    // what the ground grid can cover as well: 492 on a cell-2 map
    { key: 'radius', type: 'int', min: L.radius[0], max: (map) => Math.min(L.radius[1], maxRadius(map.ground)) },
    { key: 'foliage', type: 'bool' },
  ],
};

const capitalised = (key) => key[0].toUpperCase() + key.slice(1);

// Every entry gets its own frozen object with `label` filled in (it defaults to the capitalised key): the schema is
// shared by every panel and nobody may bend it.
export const FIELDS = Object.freeze(Object.fromEntries(Object.entries(SCHEMA).map(([kind, entries]) => [
  kind,
  Object.freeze(entries.map((entry) => Object.freeze({
    ...entry,
    label: entry.label ?? capitalised(entry.key),
    ...(entry.options ? { options: Object.freeze(entry.options) } : null),
  }))),
])));
