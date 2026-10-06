// The map format (version 1): schema, limits, the load / save pipeline, the ground grid, regions and queries.
// Pure - no three, no DOM, no Node APIs - so the server, the bake, the tests, the game and the editor all run this one file.
//
// Two forms of one map:
//   file form     the JSON of map/world.json: degrees, defaults omitted, the ground as text rows
//   runtime form  what normalize() returns (a GameMap): radians, every field present, ground.cells as a Uint8Array
// normalize() = migrate -> decode -> validate.  serialize() + stringifyMap() write the file back, byte for byte.
import { MOB_TYPES, MOB_KEYS, SHOP_RANGE, WANDER_R, AGGRO_R, BOSS_AGGRO_R } from '../shared.js';
import { PACKS, BUILTIN, MODEL_ALIASES } from './catalog.js';

export const FORMAT_VERSION = 1;
export const KINDS = ['object', 'spawn', 'chest', 'npc', 'region', 'start'];
export const COLLECTION = { object: 'objects', spawn: 'spawns', chest: 'chests', npc: 'npcs', region: 'regions' };
export const LAYERS = ['ground', 'foliage', 'objects', 'spawns', 'chests', 'npcs', 'regions', 'start'];
export const LAYER_OF = { object: 'objects', spawn: 'spawns', chest: 'chests', npc: 'npcs', region: 'regions', start: 'start' };
export const NPC_KINDS = ['blacksmith', 'sage', 'trader', 'guard'];   // src/npc.js KINDS must have exactly these keys
export const NPC_RADIUS = 0.55;                                       // every NPC is a collision circle of this radius

// Ground types. The index is the runtime cell value; files carry the ids, never the indices.
// a / b: the two colours blended by value noise. foliage: tufts and flowers per square unit, grown automatically.
// block: cannot be walked on. Append only (52 entries at most: one letter each in a file's rows).
export const GROUND_TYPES = [
  { id: 'grass',     name: 'Grass',     a: 0x4f8f3a, b: 0x74b04c, foliage: { tuft: 0.14, flower: 0.042 } },   // today's meadow
  { id: 'dirt',      name: 'Dirt road', a: 0x968058, b: 0xaa9469 },
  { id: 'dirt_dark', name: 'Dark road', a: 0x524440, b: 0x62524c },
  { id: 'paving',    name: 'Paving',    a: 0x9a9484, b: 0xb3ad9c },
  { id: 'dust',      name: 'Dust',      a: 0x6f6150, b: 0x8d7c64 },
  { id: 'ash',       name: 'Ash',       a: 0x2b2329, b: 0x47303a },
  { id: 'sand',      name: 'Sand',      a: 0xcbbb88, b: 0xd9cb9a },
  { id: 'stone',     name: 'Stone',     a: 0x7d7f84, b: 0x94979c },
  { id: 'snow',      name: 'Snow',      a: 0xdfe7ee, b: 0xf4f8fb },
  { id: 'dry_grass', name: 'Dry grass', a: 0x8a8f45, b: 0xa9a85a, foliage: { tuft: 0.05, flower: 0 } },
  { id: 'swamp',     name: 'Swamp',     a: 0x3e4f33, b: 0x55633c },
  { id: 'lawn',      name: 'Lawn (grass without foliage)', a: 0x4f8f3a, b: 0x74b04c },
  { id: 'water',     name: 'Water',     a: 0x2f7d9c, b: 0x3a8fb0, block: true },
  { id: 'lava',      name: 'Lava',      a: 0xc43a12, b: 0xff7a1a, block: true },
];
export const GROUND_INDEX = Object.fromEntries(GROUND_TYPES.map((t, i) => [t.id, i]));
export const GROUND_ALIASES = {};   // renamed or removed ground type id -> current id
export const GROUND_SYMBOLS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

// Sky and light presets a region can pick. Hex numbers, not THREE.Color: this module stays pure. radar: the region's ring colour.
export const MOODS = {
  meadow:    { name: 'Meadow',    radar: 0x6fbf55, sky: 0x9fd3e6, sun: 0xfff2d6, sunI: 2.0, hemiSky: 0xcfe9ff, hemiGround: 0x4a6b3a, hemiI: 0.95 },
  graveyard: { name: 'Graveyard', radar: 0xb59a6a, sky: 0x8f887c, sun: 0xffd9a8, sunI: 1.6, hemiSky: 0xd8cbb5, hemiGround: 0x4a4034, hemiI: 0.8 },
  cursed:    { name: 'Cursed',    radar: 0xff5a70, sky: 0x3a2230, sun: 0xffb9a0, sunI: 1.7, hemiSky: 0xb98aa6, hemiGround: 0x3a2028, hemiI: 1.05 },   // dusk, but readable
};
const SAFE_COLOR = '#7fe8d6';

// One table for the server, validate() and the inspector's fields. Pairs are [min, max], both inclusive.
// The *Margin values are how far inside `radius` a start disc, a spawn disc, a chest or an NPC must stay.
export const LIMITS = {
  name: [1, 64], regionName: [1, 48], radius: [40, 600],
  groundCells: [1, 2, 4], groundSize: [33, 513], groundTypes: 52, groundMargin: 20,
  startR: [0, 40], startMargin: 2,
  regions: 64, regionR: [1, 1200], regionReach: 2, polyPoints: [3, 64], polyArea: 1, level: [1, 99],
  objects: 50000, objectsWarn: 20000, objectY: [-20, 100], scale: [0.05, 20], colFactor: 4, colCircles: 8, colExtent: 50,
  spawns: 300, spawnR: [0, 80], spawnCount: [1, 30], spawnRespawn: [3, 3600], spawnWeight: [1, 100], spawnMargin: 3,
  monsters: 1200, monstersWarn: 800,
  chests: 200, chestGold: [1, 100000], chestRespawn: [10, 86400], chestMargin: 1,
  npcs: 40, npcMargin: 1,
  bodyBytes: 8388608, issues: 100,
};

// Issue = { level: 'error' | 'warning', code, path, message, kind?, index?, x?, z? } - plain data (it crosses HTTP).
// `path` addresses the file form ("objects[12].s"); kind + index name the item, x / z a world point to look at.
export class MapError extends Error {
  constructor(issues) {
    super(`${issues[0].path}: ${issues[0].message}${issues.length > 1 ? ` (+${issues.length - 1} more)` : ''}`);
    this.name = 'MapError';
    this.issues = issues;
  }
}

// ---------------------------------------------------------------- quantisation

// Every number in a map sits on a grid: positions and radii 0.01, scales 0.001, angles 0.01 degree. normalize() and every
// editor command quantise what they write, so the store, the view and the file always hold the same values.
export const qPos   = (v) => { const q = Math.round(v * 100) / 100;   return q === 0 ? 0 : q; };
export const qScale = (v) => { const q = Math.round(v * 1000) / 1000; return q === 0 ? 0 : q; };
export const toDeg = (rad) => { const d = Math.round(rad * 18000 / Math.PI) / 100; return d === 0 ? 0 : d; };
export const toRad = (deg) => deg * Math.PI / 180;

// radians -> radians on the 0.01 degree grid, wrapped into (-PI, PI]. toDeg() of the result is exact.
export function qAngle(rad) {
  let c = Math.round(rad * 180 / Math.PI * 100);    // hundredths of a degree
  c -= 36000 * Math.ceil((c - 18000) / 36000);
  const d = c / 100;
  return d === 0 ? 0 : d * Math.PI / 180;
}

// Quantises one runtime item in place and returns it.
export function quantizeItem(kind, item) {
  if (kind === 'region') {
    const s = item.shape;
    if (s.type === 'circle') { s.x = qPos(s.x); s.z = qPos(s.z); s.r = qPos(s.r); }
    else for (const p of s.points) { p[0] = qPos(p[0]); p[1] = qPos(p[1]); }
    return item;
  }
  item.x = qPos(item.x);
  item.z = qPos(item.z);
  if (kind === 'object') {
    item.y = qPos(item.y);
    item.rx = qAngle(item.rx); item.ry = qAngle(item.ry); item.rz = qAngle(item.rz);
    item.s = qScale(item.s); item.sy = qScale(item.sy);
    if (typeof item.col === 'number') item.col = qPos(item.col);
    else if (Array.isArray(item.col)) for (const c of item.col) { c.x = qScale(c.x); c.z = qScale(c.z); c.r = qScale(c.r); }
  } else if (kind === 'spawn' || kind === 'start') item.r = qPos(item.r);
  else if (kind === 'chest' || kind === 'npc') item.ry = qAngle(item.ry);
  return item;
}

// ---------------------------------------------------------------- ground

// Ground data is per vertex: `size` (odd) vertices per side, `cell` world units apart, centred on the origin.
// Vertex (ix, iz) is cells[iz * size + ix]; ix grows with +x, iz with +z - the vertex order of a three.js PlaneGeometry.
export const groundHalf = (g) => (g.size - 1) / 2 * g.cell;
export const groundIx   = (g, x) => Math.max(0, Math.min(g.size - 1, Math.floor(x / g.cell + (g.size - 1) / 2 + 0.5)));   // also for iz with z
export const groundX    = (g, ix) => (ix - (g.size - 1) / 2) * g.cell;                                                    // also for z with iz
// largest radius a grid with this cell can cover at size 513: 236 (cell 1), 492 (cell 2), 1004 (cell 4)
export const maxRadius  = (g) => (LIMITS.groundSize[1] - 1) / 2 * g.cell - LIMITS.groundMargin;

// Index of the nearest vertex, or -1 when the point is more than half a cell outside the grid.
export function cellIndex(ground, x, z) {
  const reach = groundHalf(ground) + ground.cell / 2;
  if (!(Math.abs(x) <= reach && Math.abs(z) <= reach)) return -1;
  return groundIx(ground, z) * ground.size + groundIx(ground, x);
}

export function cellXZ(ground, index) {
  const ix = index % ground.size, iz = Math.floor(index / ground.size);
  return { x: groundX(ground, ix), z: groundX(ground, iz), ix, iz };
}

// The ground type under a world point: that of the nearest vertex, clamped to the grid edge.
export function groundAt(map, x, z) {
  const g = map.ground;
  return GROUND_TYPES[g.cells[groundIx(g, z) * g.size + groundIx(g, x)]];
}
export function isBlocked(map, x, z) {
  return groundAt(map, x, z)?.block === true;
}

// The same ground when it already reaches radius + 20; otherwise a NEW, larger one (same cell, smallest odd size that does):
// the old cells stay centred and each new vertex takes the nearest old edge value.
export function resizeGround(ground, radius) {
  const need = radius + LIMITS.groundMargin;
  if (groundHalf(ground) >= need) return ground;
  const { cell, size: old } = ground, size = 2 * Math.ceil(need / cell) + 1, shift = (size - old) / 2;
  const cells = new Uint8Array(size * size);
  for (let iz = 0; iz < size; iz++) {
    const row = Math.max(0, Math.min(old - 1, iz - shift)) * old;
    for (let ix = 0; ix < size; ix++) cells[iz * size + ix] = ground.cells[row + Math.max(0, Math.min(old - 1, ix - shift))];
  }
  return { cell, size, cells };
}

const sizeOk = (size) => Number.isInteger(size) && size % 2 === 1 && size >= LIMITS.groundSize[0] && size <= LIMITS.groundSize[1];
const SIZE_MESSAGE = `The ground size must be an odd whole number from ${LIMITS.groundSize[0]} to ${LIMITS.groundSize[1]}.`;
const CELL_MESSAGE = `The ground cell size must be one of ${LIMITS.groundCells.join(', ')}.`;

// The cells as text, one string per grid row, so a brush stroke changes only the rows it touches in a git diff.
// A row is runs of "count symbol" (the count only when it is 2 or more); the symbol's position in GROUND_SYMBOLS is an
// index into `types`, the ids that occur in the cells, in GROUND_TYPES order. Canonical: runs are maximal.
export function encodeRows(cells, size) {
  const symbol = new Array(GROUND_TYPES.length).fill(null), types = [];
  for (let i = 0; i < size * size; i++) {
    if (!(cells[i] < GROUND_TYPES.length)) {
      throw new MapError([{ level: 'error', code: 'ground-types', path: 'ground', message: `Ground cell ${i} holds no known ground type.` }]);
    }
    symbol[cells[i]] = '';
  }
  GROUND_TYPES.forEach((t, i) => { if (symbol[i] !== null) { symbol[i] = GROUND_SYMBOLS[types.length]; types.push(t.id); } });
  const rows = [];
  for (let iz = 0; iz < size; iz++) {
    let row = '';
    for (let ix = 0, end; ix < size; ix = end) {
      const type = cells[iz * size + ix];
      for (end = ix + 1; end < size && cells[iz * size + end] === type; end++);
      row += (end - ix > 1 ? end - ix : '') + symbol[type];
    }
    rows.push(row);
  }
  return { types, rows };
}

const ROW_RE = /^(?:(?:[1-9]\d*)?[a-zA-Z])+$/;

// Writes one row of a file into `cells` at `offset`; returns what is wrong with it, or null. `lut` maps a symbol's
// position to a GROUND_TYPES index. Runs need not be maximal here: hand-edited rows are fine.
function decodeRow(row, lut, cells, offset, size) {
  if (typeof row !== 'string') return 'Expected a string.';
  if (!ROW_RE.test(row)) return 'A ground row is a list of runs such as "12a3b": a count (omitted for 1) and a letter.';
  let ix = 0, count = 0;
  for (let i = 0; i < row.length; i++) {
    const ch = row.charCodeAt(i);
    if (ch < 65) {                                   // a digit
      count = count * 10 + ch - 48;
      if (count > size) break;
      continue;
    }
    const k = ch >= 97 ? ch - 97 : ch - 39;          // a-z -> 0..25, A-Z -> 26..51
    if (k >= lut.length) return `The symbol "${row[i]}" is not in the types list.`;
    const n = count || 1;
    if (ix + n > size) { count = size + 1; break; }
    cells.fill(lut[k], offset + ix, offset + ix + n);
    ix += n;
    count = 0;
  }
  return count > size || ix !== size ? `The runs of a ground row must add up to ${size} cells.` : null;
}

// The cells of a file: Uint8Array(size * size) of GROUND_TYPES indices. `types` is the file's own palette.
// Throws a MapError listing everything wrong with the palette and the rows.
export function decodeRows(types, rows, size) {
  const issues = [];
  const fail = (code, path, message) => { if (issues.length < LIMITS.issues) issues.push({ level: 'error', code, path, message }); };
  let lut = null, cells = null;
  if (!sizeOk(size)) fail('ground-size', 'ground.size', SIZE_MESSAGE);
  if (!Array.isArray(types)) fail('type', 'ground.types', types === undefined ? MISSING : 'Expected an array.');
  else if (types.length < 1 || types.length > LIMITS.groundTypes) {
    fail('ground-types', 'ground.types', `A map lists 1 to ${LIMITS.groundTypes} ground types.`);
  } else {
    lut = new Uint8Array(types.length);
    types.forEach((id, k) => {
      const path = `ground.types[${k}]`;
      if (typeof id !== 'string') return fail('type', path, 'Expected a string.');
      if (types.indexOf(id) !== k) return fail('ground-types', path, `The ground type "${clip(id)}" is listed twice.`);
      const now = Object.hasOwn(GROUND_ALIASES, id) ? GROUND_ALIASES[id] : id;
      // never replaced silently: a fallback followed by Save would destroy the terrain
      if (!Object.hasOwn(GROUND_INDEX, now)) return fail('ground-types', path, `Unknown ground type "${clip(id)}".`);
      lut[k] = GROUND_INDEX[now];
    });
  }
  if (!Array.isArray(rows)) fail('type', 'ground.rows', rows === undefined ? MISSING : 'Expected an array.');
  else if (sizeOk(size) && rows.length !== size) fail('ground-rows', 'ground.rows', `Expected ${size} rows, one per grid row, but found ${rows.length}.`);
  else if (sizeOk(size) && lut) {
    cells = new Uint8Array(size * size);
    for (let iz = 0; iz < size; iz++) {
      const wrong = decodeRow(rows[iz], lut, cells, iz * size, size);
      if (wrong) fail(typeof rows[iz] === 'string' ? 'ground-rows' : 'type', `ground.rows[${iz}]`, wrong);
    }
  }
  if (issues.length) throw new MapError(issues);
  return cells;
}

// Deterministic 0..1 per vertex, identical on every client: automatic foliage and brush dithering.
export function cellHash(ix, iz, salt) {
  let v = Math.imul(ix + salt * 374761393, 73856093) ^ Math.imul(iz, 19349663);
  v = Math.imul(v ^ (v >>> 13), 0x5bd1e995);
  return ((v ^ (v >>> 15)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- regions

const EPS = 1e-9;

// Circles are edge-inclusive, polygons use the even-odd rule (either winding). Client, server and editor all call this.
export function inShape(s, x, z) {
  if (s.type === 'circle') { const dx = x - s.x, dz = z - s.z; return dx * dx + dz * dz <= s.r * s.r; }
  let inside = false; const p = s.points;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const xi = p[i][0], zi = p[i][1], xj = p[j][0], zj = p[j][1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export function shapeBounds(s) {
  if (s.type === 'circle') return { minX: s.x - s.r, maxX: s.x + s.r, minZ: s.z - s.r, maxZ: s.z + s.r };
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const [x, z] of s.points) {
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (z < b.minZ) b.minZ = z;
    if (z > b.maxZ) b.maxZ = z;
  }
  return b;
}

// The circle's centre, or the average of the polygon's vertices.
export function shapeCentre(s) {
  if (s.type === 'circle') return { x: s.x, z: s.z };
  let x = 0, z = 0;
  for (const p of s.points) { x += p[0]; z += p[1]; }
  return { x: x / s.points.length, z: z / s.points.length };
}

// Later regions win. The fallback has no shape and is never safe.
export function regionAt(map, x, z) {
  for (let i = map.regions.length - 1; i >= 0; i--) if (inShape(map.regions[i].shape, x, z)) return map.regions[i];
  return map.fallback;
}

// The mood of the last containing region that defines one: a small naming region without a mood does not change the sky.
export function moodAt(map, x, z) {
  for (let i = map.regions.length - 1; i >= 0; i--) {
    const r = map.regions[i];
    if (r.mood != null && inShape(r.shape, x, z)) return r.mood;
  }
  return map.fallback.mood;
}

// The zone banner: "Name", "Name · Lv 5" or "Name · Lv 5–9".
export function regionLabel(region) {
  const l = region.levels;
  if (!l) return region.name;
  return l[0] === l[1] ? `${region.name} · Lv ${l[0]}` : `${region.name} · Lv ${l[0]}–${l[1]}`;
}

// '#rrggbb' for the radar and the editor: the region's own colour, else the safe colour, else the radar colour of its mood
// (its own, or the one in force at the middle of its shape). Works for map.fallback too.
export function regionColor(map, region) {
  if (region.color) return region.color;
  if (region.safe) return SAFE_COLOR;
  let mood = region.mood;
  if (!mood && region.shape) { const c = shapeCentre(region.shape); mood = moodAt(map, c.x, c.z); }
  if (!mood || !Object.hasOwn(MOODS, mood)) mood = map.fallback.mood;
  return `#${MOODS[mood].radar.toString(16).padStart(6, '0')}`;
}

// A point is safe when ANY safe region contains it: naming a corner of the town cannot make it unsafe.
export function isSafe(map, x, z) {
  for (const r of map.regions) if (r.safe && inShape(r.shape, x, z)) return true;
  return false;
}

// The three lookups with a bounding box cached per region (tested before inShape). The server builds one per loaded map;
// it is a snapshot of the region list, so rebuild it after any region change.
export function regionIndex(map) {
  const regions = map.regions.slice(), safe = [];
  const boxes = regions.map((r) => shapeBounds(r.shape));
  regions.forEach((r, i) => { if (r.safe) safe.push(i); });
  // the box is a little generous, so rounding can never make it reject a point that inShape accepts
  const hit = (i, x, z) => {
    const b = boxes[i];
    return x >= b.minX - 1e-6 && x <= b.maxX + 1e-6 && z >= b.minZ - 1e-6 && z <= b.maxZ + 1e-6 && inShape(regions[i].shape, x, z);
  };
  return {
    regionAt(x, z) {
      for (let i = regions.length - 1; i >= 0; i--) if (hit(i, x, z)) return regions[i];
      return map.fallback;
    },
    moodAt(x, z) {
      for (let i = regions.length - 1; i >= 0; i--) if (regions[i].mood != null && hit(i, x, z)) return regions[i].mood;
      return map.fallback.mood;
    },
    isSafe(x, z) {
      for (const i of safe) if (hit(i, x, z)) return true;
      return false;
    },
  };
}

// Nearest point of a polygon's outline to (x, z), with the direction of the edge it lies on.
// The result is one reused object: monsters ask every tick and must not allocate.
const nearest = { x: 0, z: 0, ex: 0, ez: 0, d2: Infinity };
function nearestOnOutline(points, x, z) {
  nearest.d2 = Infinity;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const ax = points[j][0], az = points[j][1], ex = points[i][0] - ax, ez = points[i][1] - az, l2 = ex * ex + ez * ez;
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0;
    const qx = ax + ex * t, qz = az + ez * t, d2 = (x - qx) * (x - qx) + (z - qz) * (z - qz);
    if (d2 < nearest.d2) { nearest.x = qx; nearest.z = qz; nearest.ex = ex; nearest.ez = ez; nearest.d2 = d2; }
  }
  return nearest;
}

// distance from a point to a shape; 0 inside
function shapeDistance(s, x, z) {
  if (s.type === 'circle') return Math.max(0, Math.hypot(x - s.x, z - s.z) - s.r);
  return inShape(s, x, z) ? 0 : Math.sqrt(nearestOnOutline(s.points, x, z).d2);
}

// Moves p to `margin` outside one shape when it is inside or closer than that; returns whether it moved.
function pushOutOfShape(s, p, margin) {
  if (s.type === 'circle') {
    const dx = p.x - s.x, dz = p.z - s.z, d = Math.hypot(dx, dz), min = s.r + margin;
    if (d >= min - EPS) return false;
    if (d === 0) { p.x = s.x + min; p.z = s.z; }             // dead centre: any way out is as good, take +x
    else { p.x = s.x + dx * min / d; p.z = s.z + dz * min / d; }
    return true;
  }
  const q = nearestOnOutline(s.points, p.x, p.z), d = Math.sqrt(q.d2), inside = inShape(s, p.x, p.z);
  if (d === Infinity || (!inside && d >= margin - EPS)) return false;
  let nx, nz;
  if (d > EPS) {   // out through the nearest point of the outline
    nx = (p.x - q.x) / d * (inside ? -1 : 1);
    nz = (p.z - q.z) / d * (inside ? -1 : 1);
  } else {         // on the outline itself: the edge normal, on whichever side is outside
    const l = Math.hypot(q.ex, q.ez);
    nx = l ? q.ez / l : 1;
    nz = l ? -q.ex / l : 0;
    if (inShape(s, q.x + nx * 1e-3, q.z + nz * 1e-3)) { nx = -nx; nz = -nz; }
  }
  p.x = q.x + nx * margin;
  p.z = q.z + nz * margin;
  return true;
}

// Ejects p from every safe region: the point ends `margin` outside each shape that held it or came closer than that.
// Mutates p.x / p.z and returns whether it moved. Up to 4 passes, because leaving one region can enter the next.
export function pushOutOfSafe(map, p, margin) {
  let moved = false;
  for (let pass = 0; pass < 4; pass++) {
    let again = false;
    for (const r of map.regions) if (r.safe && pushOutOfShape(r.shape, p, margin)) again = true;
    if (!again) break;
    moved = true;
  }
  return moved;
}

// ---------------------------------------------------------------- queries

export const npcsOf  = (map, kind) => map.npcs.filter((n) => n.kind === kind);
// false when the map has none of that kind; any of several counts
export const nearNpc = (map, p, kind, range = SHOP_RANGE) =>
  map.npcs.some((n) => n.kind === kind && Math.hypot(p.x - n.x, p.z - n.z) < range);

const TRIES = 20;

// Where a player appears: an area-uniform point of the start disc, the centre if 20 draws all land on blocked ground.
export function startPoint(map, rnd = Math.random) {
  const s = map.start;
  for (let i = 0; i < TRIES; i++) {
    const a = rnd() * Math.PI * 2, d = s.r * Math.sqrt(rnd());
    const x = s.x + Math.cos(a) * d, z = s.z + Math.sin(a) * d;
    if (!isBlocked(map, x, z)) return { x, z };
  }
  return { x: s.x, z: s.z };
}

// A monster's home: an area-uniform point of the spawn disc that is inside the world, on walkable ground and not where
// a safe region would eject a monster of radius mobR. null when 20 draws find none.
export function spawnHome(map, spawn, mobR, rnd = Math.random) {
  for (let i = 0; i < TRIES; i++) {
    const a = rnd() * Math.PI * 2, d = spawn.r * Math.sqrt(rnd());
    const x = spawn.x + Math.cos(a) * d, z = spawn.z + Math.sin(a) * d;
    if (Math.hypot(x, z) > map.radius - mobR || isBlocked(map, x, z) || pushOutOfSafe(map, { x, z }, mobR + 0.5)) continue;
    return { x, z };
  }
  return null;
}

// A mob type id by weight; u in [0, 1). The weights are walked in MOB_KEYS order.
export function pickType(types, u) {
  let total = 0, last = MOB_KEYS[0];
  for (const k of MOB_KEYS) if (Object.hasOwn(types, k)) total += types[k];
  let left = u * total;
  for (const k of MOB_KEYS) {
    if (!Object.hasOwn(types, k)) continue;
    last = k;
    if ((left -= types[k]) < 0) return k;
  }
  return last;
}
export function pickLevel(lvl, u) {
  return lvl[0] + Math.floor(u * (lvl[1] - lvl[0] + 1));
}

export function spawnCount(map) {
  let n = 0;
  for (const s of map.spawns) n += s.count;
  return n;
}
export function hasBoss(spawn) {
  return Object.hasOwn(spawn.types, 'boss');
}

// [{ kind, item }] of every object, spawn, chest and NPC in group g.
export function groupItems(map, g) {
  const out = [];
  if (g == null) return out;
  for (const kind of ['object', 'spawn', 'chest', 'npc']) {
    for (const item of map[COLLECTION[kind]]) if (item.g === g) out.push({ kind, item });
  }
  return out;
}

// ---------------------------------------------------------------- file form: decoding

// The keys of the file form, in the order the canonical writer emits them. The decoder accepts exactly these.
const TOP_KEYS = ['version', 'name', 'radius', 'start', 'foliage', 'fallback', 'regions', 'spawns', 'chests', 'npcs', 'ground', 'objects'];
const XZR = ['x', 'z', 'r'];
const FILE_KEYS = {
  object: ['m', 'x', 'y', 'z', 'rx', 'ry', 'rz', 's', 'sy', 'col', 'g'],
  spawn: ['types', 'lvl', 'x', 'z', 'r', 'count', 'respawn', 'g'],
  chest: ['x', 'z', 'ry', 'gold', 'big', 'respawn', 'g'],
  npc: ['kind', 'x', 'z', 'ry', 'g'],
  region: ['name', 'levels', 'mood', 'safe', 'color', 'shape'],
  circle: ['type', 'x', 'z', 'r'],
  poly: ['type', 'points'],
  fallback: ['name', 'levels', 'mood'],
  start: XZR,
  ground: ['cell', 'size', 'types', 'rows'],
};
const SHAPES = ['circle', 'poly'];
const MISSING = 'This key is required.';

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const clip = (s) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);   // keys and ids quoted in messages come from untrusted files
const at = (path, key) => (path ? `${path}.${key}` : key);

// Readers for the decode step. They collect DECODE errors - problems that leave no runtime form - and return a
// placeholder after one: the caller throws the whole list at the end. Ranges are NOT checked here; validate() does that.
function decoder() {
  const issues = [];
  const fail = (code, path, message) => { if (issues.length < LIMITS.issues) issues.push({ level: 'error', code, path, message }); };
  const wrong = (v, path, what) => fail('type', path, v === undefined ? MISSING : `Expected ${what}.`);
  // a finite number, or NaN after reporting why not
  const number = (v, path) => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'number') fail('not-finite', path, 'Expected a finite number.');
    else wrong(v, path, 'a number');
    return NaN;
  };
  const d = {
    issues, fail, wrong, number,
    // a JSON object with no key the format does not define
    obj(v, path, keys) {
      if (!isObj(v)) { wrong(v, path, 'an object'); return false; }
      for (const k of Object.keys(v)) if (!keys.includes(k)) fail('unknown-key', at(path, clip(k)), `Unknown key "${clip(k)}".`);
      return true;
    },
    // `def` makes the key optional
    num(o, key, path, def) {
      const v = o[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      return v === undefined && def !== undefined ? def : number(v, at(path, key));
    },
    str(o, key, path) {
      if (typeof o[key] === 'string') return o[key];
      wrong(o[key], at(path, key), 'a string');
      return '';
    },
    bool(o, key, path, def) {
      const v = o[key];
      if (typeof v === 'boolean') return v;
      if (v === undefined && def !== undefined) return def;
      wrong(v, at(path, key), 'true or false');
      return false;
    },
    // an optional string where null and absent mean the same: g, color
    text(o, key, path) {
      const v = o[key];
      if (v === undefined || v === null || typeof v === 'string') return v ?? null;
      wrong(v, at(path, key), 'a string');
      return null;
    },
    // a key of a table, such as a mood; `what` names the thing in the message
    key(o, key, path, table, what) {
      const v = o[key];
      if (typeof v !== 'string') { wrong(v, at(path, key), 'a string'); return null; }
      if (Array.isArray(table) ? table.includes(v) : Object.hasOwn(table, v)) return v;
      fail('enum', at(path, key), `Unknown ${what} "${clip(v)}".`);
      return null;
    },
    // [min, max]: levels and lvl
    pair(o, key, path) {
      const v = o[key], here = at(path, key);
      if (!Array.isArray(v) || v.length !== 2) { wrong(v, here, 'two numbers, [min, max]'); return [NaN, NaN]; }
      return [number(v[0], `${here}[0]`), number(v[1], `${here}[1]`)];
    },
  };
  return d;
}

function decodeCol(d, raw, path) {
  const v = raw.col;
  if (v === undefined || v === null) return null;                    // the catalog's collider
  if (v === 'box') return v;
  if (typeof v === 'number') return d.num(raw, 'col', path);
  if (!Array.isArray(v)) { d.wrong(v, at(path, 'col'), '0, a number, "box" or a list of circles'); return null; }   // any other string too
  return v.map((c, i) => {
    const p = `${at(path, 'col')}[${i}]`;
    return d.obj(c, p, XZR) ? { x: d.num(c, 'x', p), z: d.num(c, 'z', p), r: d.num(c, 'r', p) } : { x: NaN, z: NaN, r: NaN };
  });
}

function decodeObject(d, raw, path) {
  if (!d.obj(raw, path, FILE_KEYS.object)) return null;
  const id = d.str(raw, 'm', path);
  return quantizeItem('object', {
    m: Object.hasOwn(MODEL_ALIASES, id) ? MODEL_ALIASES[id] : id,
    x: d.num(raw, 'x', path), y: d.num(raw, 'y', path, 0), z: d.num(raw, 'z', path),
    rx: toRad(d.num(raw, 'rx', path, 0)), ry: toRad(d.num(raw, 'ry', path, 0)), rz: toRad(d.num(raw, 'rz', path, 0)),
    s: d.num(raw, 's', path, 1), sy: d.num(raw, 'sy', path, 1),
    col: decodeCol(d, raw, path), g: d.text(raw, 'g', path),
  });
}

function decodeSpawn(d, raw, path) {
  if (!d.obj(raw, path, FILE_KEYS.spawn)) return null;
  const types = {}, t = raw.types;
  if (!isObj(t)) d.wrong(t, at(path, 'types'), 'an object of monster types and weights');
  else {
    for (const k of Object.keys(t)) {
      if (!Object.hasOwn(MOB_TYPES, k)) d.fail('enum', at(at(path, 'types'), clip(k)), `Unknown monster type "${clip(k)}".`);
    }
    for (const k of MOB_KEYS) if (Object.hasOwn(t, k)) types[k] = d.num(t, k, at(path, 'types'));
  }
  return quantizeItem('spawn', {
    types, lvl: d.pair(raw, 'lvl', path), x: d.num(raw, 'x', path), z: d.num(raw, 'z', path), r: d.num(raw, 'r', path),
    count: d.num(raw, 'count', path), respawn: d.num(raw, 'respawn', path), g: d.text(raw, 'g', path),
  });
}

function decodeChest(d, raw, path) {
  if (!d.obj(raw, path, FILE_KEYS.chest)) return null;
  return quantizeItem('chest', {
    x: d.num(raw, 'x', path), z: d.num(raw, 'z', path), ry: toRad(d.num(raw, 'ry', path, 0)),
    gold: d.num(raw, 'gold', path), big: d.bool(raw, 'big', path, false), respawn: d.num(raw, 'respawn', path), g: d.text(raw, 'g', path),
  });
}

function decodeNpc(d, raw, path) {
  if (!d.obj(raw, path, FILE_KEYS.npc)) return null;
  return quantizeItem('npc', {
    kind: d.key(raw, 'kind', path, NPC_KINDS, 'NPC kind'),
    x: d.num(raw, 'x', path), z: d.num(raw, 'z', path), ry: toRad(d.num(raw, 'ry', path, 0)), g: d.text(raw, 'g', path),
  });
}

// A polygon as normalize keeps it: no point equal to the one before it, no closing point equal to the first.
function cleanPoints(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  if (out.length > 1 && out[0][0] === out[out.length - 1][0] && out[0][1] === out[out.length - 1][1]) out.pop();
  return out;
}

function decodeShape(d, raw, path) {
  if (!isObj(raw)) { d.wrong(raw, path, 'an object'); return null; }
  const type = d.key(raw, 'type', path, SHAPES, 'shape type');
  if (type === null) return null;
  d.obj(raw, path, FILE_KEYS[type]);
  if (type === 'circle') return { type, x: d.num(raw, 'x', path), z: d.num(raw, 'z', path), r: d.num(raw, 'r', path) };
  const points = [], list = raw.points;
  if (!Array.isArray(list)) d.wrong(list, at(path, 'points'), 'an array of [x, z] points');
  else {
    list.forEach((p, i) => {
      const here = `${at(path, 'points')}[${i}]`;
      if (!Array.isArray(p) || p.length !== 2) d.wrong(p, here, 'a point, [x, z]');
      else points.push([qPos(d.number(p[0], `${here}[0]`)), qPos(d.number(p[1], `${here}[1]`))]);
    });
  }
  return { type, points: cleanPoints(points) };
}

function decodeRegion(d, raw, path) {
  if (!d.obj(raw, path, FILE_KEYS.region)) return null;
  const region = {
    name: d.str(raw, 'name', path),
    levels: raw.levels === undefined || raw.levels === null ? null : d.pair(raw, 'levels', path),
    mood: raw.mood === undefined || raw.mood === null ? null : d.key(raw, 'mood', path, MOODS, 'mood'),
    safe: d.bool(raw, 'safe', path, false), color: d.text(raw, 'color', path),
    shape: decodeShape(d, raw.shape, at(path, 'shape')),
  };
  return region.shape ? quantizeItem('region', region) : region;
}

function decodeFallback(d, raw) {
  if (!d.obj(raw, 'fallback', FILE_KEYS.fallback)) return null;
  return {
    name: d.str(raw, 'name', 'fallback'),
    levels: raw.levels === undefined || raw.levels === null ? null : d.pair(raw, 'levels', 'fallback'),
    mood: d.key(raw, 'mood', 'fallback', MOODS, 'mood'),
  };
}

function decodeStart(d, raw) {
  if (!d.obj(raw, 'start', FILE_KEYS.start)) return null;
  return quantizeItem('start', { x: d.num(raw, 'x', 'start'), z: d.num(raw, 'z', 'start'), r: d.num(raw, 'r', 'start') });
}

function decodeGround(d, raw) {
  if (!d.obj(raw, 'ground', FILE_KEYS.ground)) return null;
  const cell = d.num(raw, 'cell', 'ground'), size = d.num(raw, 'size', 'ground');
  if (Number.isFinite(cell) && !LIMITS.groundCells.includes(cell)) d.fail('ground-cell', 'ground.cell', CELL_MESSAGE);
  let cells = null;
  if (Number.isFinite(size)) {
    try { cells = decodeRows(raw.types, raw.rows, size); } catch (e) {
      if (!(e instanceof MapError)) throw e;
      for (const issue of e.issues) d.fail(issue.code, issue.path, issue.message);
    }
  }
  return { cell, size, cells };
}

const DECODERS = { object: decodeObject, spawn: decodeSpawn, chest: decodeChest, npc: decodeNpc, region: decodeRegion };

// File form -> runtime form, every value built from scratch from known keys only: nothing of `file` is referenced
// afterwards, and an unknown key is an error, so a typo or a field of a newer build is never dropped by the next save.
function decode(file) {
  const d = decoder();
  d.obj(file, '', TOP_KEYS);
  const list = (key, kind) => {
    const v = file[key];
    if (!Array.isArray(v)) { d.wrong(v, key, 'an array'); return []; }
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = DECODERS[kind](d, v[i], `${key}[${i}]`);
    return out;
  };
  const map = {
    version: FORMAT_VERSION,
    name: d.str(file, 'name', ''),
    radius: d.num(file, 'radius', ''),
    start: decodeStart(d, file.start),
    foliage: d.bool(file, 'foliage', ''),
    fallback: decodeFallback(d, file.fallback),
    regions: list('regions', 'region'), spawns: list('spawns', 'spawn'), chests: list('chests', 'chest'), npcs: list('npcs', 'npc'),
    ground: decodeGround(d, file.ground),
    objects: list('objects', 'object'),
  };
  if (d.issues.length) throw new MapError(d.issues);
  return map;
}

const MIGRATIONS = {};   // MIGRATIONS[n] = (file) => file at version n + 1; pure

// A file of any older version -> the same map at FORMAT_VERSION. A file newer than this code is refused, never loaded best-effort.
export function migrate(file) {
  const fail = (code, path, message) => { throw new MapError([{ level: 'error', code, path, message }]); };
  if (!isObj(file)) fail('type', 'map', 'A map must be a JSON object.');
  const v = file.version;
  if (!Number.isInteger(v) || v < 1) fail('version-invalid', 'version', 'The map version must be a whole number, 1 or higher.');
  if (v > FORMAT_VERSION) {
    fail('version-newer', 'version', `This map is version ${v}, but this build reads version ${FORMAT_VERSION} at most. Update the game to load it.`);
  }
  for (let n = v; n < FORMAT_VERSION; n++) {
    if (!Object.hasOwn(MIGRATIONS, n)) fail('version-invalid', 'version', `Maps of version ${n} can no longer be read.`);
    file = MIGRATIONS[n](file);
  }
  return file;
}

const throwOnErrors = (issues) => {
  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length) throw new MapError(errors.slice(0, LIMITS.issues));
};

// A parsed map file -> GameMap. Throws one MapError listing every DECODE error, or - with `check` - every RANGE error.
// It never clamps or repairs, except: angles wrap into (-180, 180], a polygon loses repeated and closing points, and
// numbers are quantised. With check: false a map that decodes is returned unvalidated (the editor's Import and draft restore).
export function normalize(file, { check = true } = {}) {
  const map = decode(migrate(file));
  if (check) throwOnErrors(validate(map));
  return map;
}

// One file-form item (from the clipboard, a stamp) -> a new runtime item. Throws a MapError on a DECODE error;
// RANGE errors of the item are found by validate() once it is in a map.
export function decodeItem(kind, raw) {
  if (!Object.hasOwn(DECODERS, kind)) throw new TypeError(`decodeItem: no such kind of item: ${kind}`);
  const d = decoder(), item = DECODERS[kind](d, raw, kind);
  if (d.issues.length) throw new MapError(d.issues);
  return item;
}

// ---------------------------------------------------------------- validation

const GROUP_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/;
const MODEL_RE = /^[a-z][a-z0-9_]{0,23}\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const GROUP_MESSAGE = 'A group name is 1 to 32 letters, digits, "_", "." or "-", starting with a letter or a digit.';
const DENSE_R = 65, DENSE_COUNT = 80;      // the server's view radius, and how many monsters one snapshot carries comfortably
const OUTSIDE = 10;                        // an object this far beyond the radius is probably lost
// 16 points on the rim of a unit disc: start and spawn discs are sampled at their centre and these
const RIM = Array.from({ length: 16 }, (_, k) => [Math.cos(k * Math.PI / 8), Math.sin(k * Math.PI / 8)]);

// every comparison is written so that NaN fails it; a string that looks like a number is not a number
const num = (v) => (typeof v === 'number' ? v : NaN);
const within = (v, range) => typeof v === 'number' && v >= range[0] && v <= range[1];
const intIn = (v, range) => Number.isInteger(v) && within(v, range);
const moodOk = (mood) => typeof mood === 'string' && Object.hasOwn(MOODS, mood);
const ANGLE_MESSAGE = 'A rotation must be a finite number.';
const BOOL_MESSAGE = 'Expected true or false.';
const span = (range) => `${range[0]} to ${range[1].toLocaleString('en-US')}`;
const levelsOk = (l) => Array.isArray(l) && l.length === 2 && intIn(l[0], LIMITS.level) && intIn(l[1], LIMITS.level) && l[0] <= l[1];
const groupOk = (g) => g == null || (typeof g === 'string' && GROUP_RE.test(g));

// what is wrong with a free-text name, as the end of a sentence; null when it is fine
function nameProblem(s, range) {
  if (typeof s !== 'string' || s.length < range[0]) return 'must not be empty';
  if (s.length > range[1]) return `must be at most ${range[1]} characters long`;
  if (s !== s.trim()) return 'must not start or end with white space';
  return CONTROL_RE.test(s) ? 'must not contain control characters' : null;
}

function modelProblem(id) {
  if (typeof id !== 'string' || !MODEL_RE.test(id)) return 'A model id looks like "pack/name".';
  const cut = id.indexOf('/'), pack = id.slice(0, cut);
  if (!Object.hasOwn(PACKS, pack)) return `There is no model pack "${pack}".`;
  if (pack === 'builtin' && !BUILTIN.includes(id.slice(cut + 1))) return `There is no built-in model "${id.slice(cut + 1)}".`;
  return null;
}

function colProblem(col) {
  const L = LIMITS;
  if (col === 0 || col === 'box') return null;
  if (typeof col === 'number') return col > 0 && col <= L.colFactor ? null : `A collider factor must be above 0 and at most ${L.colFactor}.`;
  if (!Array.isArray(col)) return 'A collider is 0, a factor, "box" or a list of circles.';
  if (col.length < 1 || col.length > L.colCircles) return `A collider has 1 to ${L.colCircles} circles.`;
  const ok = (c) => c && Math.abs(c.x) <= L.colExtent && Math.abs(c.z) <= L.colExtent && c.r > 0 && c.r <= L.colExtent;
  return col.every(ok) ? null : `A collider circle needs x and z within ${L.colExtent} of the origin and a radius above 0, up to ${L.colExtent}.`;
}

const polyArea = (points) => {
  let a = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) a += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  return a / 2;
};

// true when two edges of the outline that do not share a vertex cross each other
function selfIntersects(points) {
  const n = points.length;
  const side = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  for (let i = 0; i < n; i++) {
    const a = points[i], b = points[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;      // the closing edge is a neighbour of the first
      const c = points[j], e = points[(j + 1) % n];
      if (side(a, b, c) * side(a, b, e) < 0 && side(c, e, a) * side(c, e, b) < 0) return true;
    }
  }
  return false;
}

// Pairs [index, earlier index] of objects that repeat an earlier object's model within 0.05 units in x and z.
// A hash grid per model over hundredths of a unit; a spot already taken is not stored twice, so the cost stays linear.
function duplicateObjects(objects, n) {
  const out = [], grids = new Map(), cx = new Int32Array(n), cz = new Int32Array(n), next = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const o = objects[i];
    if (!(Math.abs(o.x) < 20000 && Math.abs(o.z) < 20000)) continue;    // far off every ground: object-pos reports it
    const x = cx[i] = Math.round(o.x * 100), z = cz[i] = Math.round(o.z * 100), bx = Math.floor(x / 5), bz = Math.floor(z / 5);
    let grid = grids.get(o.m), twin = -1;
    if (!grid) grids.set(o.m, grid = new Map());
    for (let gx = bx - 1; gx <= bx + 1 && twin < 0; gx++) {
      for (let gz = bz - 1; gz <= bz + 1 && twin < 0; gz++) {
        for (let j = grid.get(gx * 1048576 + gz) ?? -1; j >= 0; j = next[j]) {
          if (Math.abs(cx[j] - x) <= 5 && Math.abs(cz[j] - z) <= 5) { twin = j; break; }
        }
      }
    }
    if (twin >= 0) out.push([i, twin]);
    if (twin >= 0 && cx[twin] === x && cz[twin] === z) continue;
    next[i] = grid.get(bx * 1048576 + bz) ?? -1;
    grid.set(bx * 1048576 + bz, i);
  }
  return out;
}

// GameMap -> Issue[], errors first. Never throws. Errors are the RANGE rules of the limits table - everything an edit of
// a runtime map can break - so a map is saveable exactly when this returns no error; warnings never block a save.
// It also catches what only a bug can put into a runtime map (a NaN angle, an unknown mood): such a map would be written
// as a file that does not load. `models` (a Set of ids the server can serve) enables model-missing: an error with
// strictModels, else a warning.
export function validate(map, { models = null, strictModels = false } = {}) {
  try {
    return check(map, models, strictModels);
  } catch (e) {   // only an object that is not a GameMap at all gets here
    return [{ level: 'error', code: 'type', path: 'map', message: `The map could not be checked (${e?.message ?? e}).` }];
  }
}

function check(map, models, strictModels) {
  const L = LIMITS, errors = [], warnings = [];
  const error = (code, path, message, where) => errors.push({ level: 'error', code, path, message, ...where });
  const warn = (code, path, message, where) => warnings.push({ level: 'warning', code, path, message, ...where });
  const on = (kind, index, p) => ({ kind, index, x: p.x, z: p.z });
  const { radius, ground, start, fallback } = map, half = groundHalf(ground);
  let bad;
  for (const key of Object.values(COLLECTION)) if (!Array.isArray(map[key])) throw new TypeError(`"${key}" is not a list`);

  // ---- the map itself and its ground
  if ((bad = nameProblem(map.name, L.name))) error('string', 'name', `The map name ${bad}.`);
  if (typeof map.foliage !== 'boolean') error('type', 'foliage', BOOL_MESSAGE);
  if (!intIn(radius, L.radius)) error('radius', 'radius', `The radius must be a whole number from ${span(L.radius)}.`);
  const gridOk = sizeOk(ground.size) && ground.cells.length === ground.size * ground.size;
  if (!gridOk) error('ground-size', 'ground.size', SIZE_MESSAGE);
  if (!L.groundCells.includes(ground.cell)) error('ground-cell', 'ground.cell', CELL_MESSAGE);
  for (let i = 0; gridOk && i < ground.cells.length; i++) {
    if (ground.cells[i] < GROUND_TYPES.length) continue;
    const cell = cellXZ(ground, i);
    error('ground-types', `ground.rows[${cell.iz}]`, 'A ground cell holds no known ground type.', { x: cell.x, z: cell.z });
    break;
  }
  if (!(half >= radius + L.groundMargin)) {
    error('ground-cover', 'ground',
      `The ground reaches ${half} units from the centre; it must reach the radius plus ${L.groundMargin} (${radius + L.groundMargin}).`);
  }
  const blocked = (x, z) => gridOk && isBlocked(map, x, z);

  // ---- regions
  const regions = map.regions, reach = L.regionReach * half;
  if (regions.length > L.regions) error('too-many', 'regions', `The map has ${regions.length} regions; the limit is ${L.regions}.`);
  if ((bad = nameProblem(fallback.name, L.regionName))) error('string', 'fallback.name', `The fallback region's name ${bad}.`);
  if (fallback.levels != null && !levelsOk(fallback.levels)) {
    error('region-levels', 'fallback.levels', `Levels must be two whole numbers from ${span(L.level)}, lowest first.`);
  }
  if (!moodOk(fallback.mood)) error('enum', 'fallback.mood', 'The fallback region needs one of the known moods.');
  // Point lookups below use only the regions that are sound: a list or an outline over its cap is an error by
  // itself, and leaving it out keeps the cost of a hostile file bounded.
  const sound = [];
  for (let i = 0; i < Math.min(regions.length, L.regions); i++) {
    const r = regions[i], s = r.shape, path = `regions[${i}]`, here = () => on('region', i, shapeCentre(s));
    if (s.type !== 'circle' && s.type !== 'poly') {
      error('enum', `${path}.shape.type`, 'A shape is a circle or a polygon.', { kind: 'region', index: i });
      continue;
    }
    if ((bad = nameProblem(r.name, L.regionName))) error('string', `${path}.name`, `The region's name ${bad}.`, here());
    if (r.mood != null && !moodOk(r.mood)) error('enum', `${path}.mood`, 'A region has one of the known moods, or none.', here());
    if (typeof r.safe !== 'boolean') error('type', `${path}.safe`, BOOL_MESSAGE, here());
    if (r.levels != null && !levelsOk(r.levels)) {
      error('region-levels', `${path}.levels`, `Levels must be two whole numbers from ${span(L.level)}, lowest first.`, here());
    }
    if (r.color != null && !(typeof r.color === 'string' && COLOR_RE.test(r.color))) {
      error('enum', `${path}.color`, 'A colour is written "#rrggbb" in lower case.', here());
    }
    if (s.type === 'circle') {
      sound.push(r);
      if (!within(s.r, L.regionR)) error('region-circle', `${path}.shape.r`, `A region's radius must be from ${span(L.regionR)}.`, here());
      if (!(Math.abs(num(s.x)) <= reach && Math.abs(num(s.z)) <= reach)) {
        error('region-pos', `${path}.shape`, `A region's centre must be within ${reach} units of the map centre on both axes.`, here());
      }
    } else {
      const points = cleanPoints(s.points), far = s.points.findIndex((p) => !(Math.abs(num(p[0])) <= reach && Math.abs(num(p[1])) <= reach));
      if (!within(points.length, L.polyPoints)) {
        error('region-poly', `${path}.shape.points`, `A polygon needs ${span(L.polyPoints)} distinct points; this one has ${points.length}.`, here());
      } else {
        sound.push(r);
        if (!(Math.abs(polyArea(points)) >= L.polyArea)) {
          error('region-poly', `${path}.shape.points`, `A polygon must cover at least ${L.polyArea} square unit.`, here());
        }
        if (selfIntersects(points)) warn('region-self-intersect', `${path}.shape.points`, 'The outline of this region crosses itself.', here());
      }
      if (far >= 0) {
        error('region-pos', `${path}.shape.points[${far}]`, `A region's points must be within ${reach} units of the map centre on both axes.`, here());
      }
    }
    if (shapeDistance(s, 0, 0) > radius) warn('region-outside', path, 'No part of this region is inside the map radius.', here());
  }
  const index = regionIndex({ regions: sound, fallback }), safeShapes = sound.filter((r) => r.safe).map((r) => r.shape);
  if (!regions.some((r) => r.safe)) {
    warn('no-safe-region', 'regions', 'No region is safe: players have nowhere to rest and monsters can reach the start.');
  }

  // ---- start
  const startDisc = [[start.x, start.z], ...RIM.map(([cos, sin]) => [start.x + cos * start.r, start.z + sin * start.r])];
  const exposed = startDisc.filter(([x, z]) => !index.isSafe(x, z));     // the points of the start disc a monster could reach
  if (!within(start.r, L.startR)) error('start', 'start.r', `The start radius must be from ${span(L.startR)}.`, on('start', 0, start));
  else if (!(Math.hypot(num(start.x), num(start.z)) + start.r <= radius - L.startMargin + EPS)) {
    error('start', 'start', `The start disc must stay ${L.startMargin} units inside the map radius.`, on('start', 0, start));
  }
  if (blocked(start.x, start.z)) error('start-blocked', 'start', 'The start point is on ground that cannot be walked on.', on('start', 0, start));
  if (exposed.length) warn('start-unsafe', 'start', 'Part of the start disc is outside every safe region.', on('start', 0, start));

  // ---- spawns
  const spawns = map.spawns, nSpawns = Math.min(spawns.length, L.spawns), total = spawnCount(map);
  if (spawns.length > L.spawns) error('too-many', 'spawns', `The map has ${spawns.length} spawns; the limit is ${L.spawns}.`);
  if (total > L.monsters) error('spawn-total', 'spawns', `The spawns add up to ${total} monsters; the limit is ${L.monsters.toLocaleString('en-US')}.`);
  else if (total > L.monstersWarn) {
    warn('many-monsters', 'spawns', `The spawns add up to ${total} monsters; more than ${L.monstersWarn} is heavy for the server.`);
  }
  if (!spawns.length) warn('no-spawns', 'spawns', 'The map has no monster spawns.');
  if (spawns.filter(hasBoss).length > 1) warn('multi-boss', 'spawns', 'More than one spawn has a boss.');
  for (let i = 0; i < nSpawns; i++) {
    const s = spawns[i], path = `spawns[${i}]`, here = () => on('spawn', i, s), kinds = Object.keys(s.types);
    if (!kinds.length || !kinds.every((k) => Object.hasOwn(MOB_TYPES, k) && intIn(s.types[k], L.spawnWeight))) {
      error('spawn-types', `${path}.types`,
        `A spawn needs at least one monster type, each with a whole-number weight from ${span(L.spawnWeight)}.`, here());
    }
    if (!levelsOk(s.lvl)) error('spawn-lvl', `${path}.lvl`, `Spawn levels must be two whole numbers from ${span(L.level)}, lowest first.`, here());
    if (!within(s.r, L.spawnR)) error('spawn-r', `${path}.r`, `A spawn's radius must be from ${span(L.spawnR)}.`, here());
    if (!intIn(s.count, L.spawnCount)) error('spawn-count', `${path}.count`, `A spawn's count must be a whole number from ${span(L.spawnCount)}.`, here());
    if (!intIn(s.respawn, L.spawnRespawn)) {
      error('spawn-respawn', `${path}.respawn`, `A spawn's respawn time must be a whole number of seconds from ${span(L.spawnRespawn)}.`, here());
    }
    if (!(Math.hypot(num(s.x), num(s.z)) + num(s.r) <= radius - L.spawnMargin + EPS)) {
      error('spawn-pos', path, `A spawn's disc must stay ${L.spawnMargin} units inside the map radius.`, here());
    }
    if (!groupOk(s.g)) error('enum', `${path}.g`, GROUP_MESSAGE, here());
    if (index.isSafe(s.x, s.z)) error('spawn-in-safe', path, 'A spawn cannot have its centre inside a safe region.', here());
    else if (safeShapes.some((shape) => shapeDistance(shape, s.x, s.z) < s.r + WANDER_R)) {
      warn('spawn-near-safe', path, 'Monsters of this spawn wander up to the edge of a safe region.', here());
    }
    const threat = s.r + WANDER_R + (hasBoss(s) ? BOSS_AGGRO_R : AGGRO_R);
    if (exposed.some(([x, z]) => Math.hypot(x - s.x, z - s.z) <= threat)) {
      warn('spawn-threat-start', path, 'Monsters of this spawn can attack players where they appear.', here());
    }
    if (blocked(s.x, s.z)) warn('spawn-blocked', path, 'The centre of this spawn is on ground that cannot be walked on.', here());
    const unusable = (x, z) => index.isSafe(x, z) || blocked(x, z) || Math.hypot(x, z) > radius - L.spawnMargin;
    if (unusable(s.x, s.z) && RIM.every(([cos, sin]) => unusable(s.x + cos * s.r, s.z + sin * s.r))) {
      warn('spawn-unplaceable', path, 'This spawn has no room for a monster: its disc is safe, blocked or outside the map.', here());
    }
    if (s.r === 0 && s.count > 1) warn('spawn-stacked', path, `${s.count} monsters spawn on one spot: give the spawn a radius.`, here());
    const region = index.regionAt(s.x, s.z);
    if (levelsOk(region.levels) && levelsOk(s.lvl) && !hasBoss(s) && (s.lvl[0] < region.levels[0] || s.lvl[1] > region.levels[1])) {
      warn('spawn-levels', `${path}.lvl`, `Levels ${s.lvl[0]}–${s.lvl[1]} do not fit the region here, ${clip(regionLabel(region))}.`, here());
    }
    let crowd = 0;
    for (let j = 0; j < nSpawns; j++) if (Math.hypot(spawns[j].x - s.x, spawns[j].z - s.z) <= DENSE_R) crowd += spawns[j].count;
    if (crowd > DENSE_COUNT) {
      warn('spawn-dense', path, `${crowd} monsters live within ${DENSE_R} units of this spawn; more than ${DENSE_COUNT} is a lot to see at once.`, here());
    }
  }

  // ---- chests
  const chests = map.chests;
  if (chests.length > L.chests) error('too-many', 'chests', `The map has ${chests.length} chests; the limit is ${L.chests}.`);
  for (let i = 0; i < Math.min(chests.length, L.chests); i++) {
    const c = chests[i], path = `chests[${i}]`, here = () => on('chest', i, c);
    if (!intIn(c.gold, L.chestGold)) error('chest-gold', `${path}.gold`, `A chest's gold must be a whole number from ${span(L.chestGold)}.`, here());
    if (!intIn(c.respawn, L.chestRespawn)) {
      error('chest-respawn', `${path}.respawn`, `A chest's respawn time must be a whole number of seconds from ${span(L.chestRespawn)}.`, here());
    }
    if (!(Math.hypot(num(c.x), num(c.z)) <= radius - L.chestMargin + EPS)) {
      error('chest-pos', path, `A chest must stay ${L.chestMargin} unit inside the map radius.`, here());
    }
    if (!groupOk(c.g)) error('enum', `${path}.g`, GROUP_MESSAGE, here());
    if (!Number.isFinite(c.ry)) error('not-finite', `${path}.ry`, ANGLE_MESSAGE, here());
    if (typeof c.big !== 'boolean') error('type', `${path}.big`, BOOL_MESSAGE, here());
    if (blocked(c.x, c.z)) warn('chest-blocked', path, 'This chest is on ground that cannot be walked on.', here());
  }

  // ---- NPCs
  const npcs = map.npcs;
  if (npcs.length > L.npcs) error('too-many', 'npcs', `The map has ${npcs.length} NPCs; the limit is ${L.npcs}.`);
  for (let i = 0; i < Math.min(npcs.length, L.npcs); i++) {
    const n = npcs[i], path = `npcs[${i}]`, here = () => on('npc', i, n);
    if (!(Math.hypot(num(n.x), num(n.z)) <= radius - L.npcMargin + EPS)) {
      error('npc-pos', path, `An NPC must stay ${L.npcMargin} unit inside the map radius.`, here());
    }
    if (!groupOk(n.g)) error('enum', `${path}.g`, GROUP_MESSAGE, here());
    if (!NPC_KINDS.includes(n.kind)) error('enum', `${path}.kind`, `An NPC is one of: ${NPC_KINDS.join(', ')}.`, here());
    if (!Number.isFinite(n.ry)) error('not-finite', `${path}.ry`, ANGLE_MESSAGE, here());
    if (blocked(n.x, n.z)) warn('npc-blocked', path, 'This NPC is on ground that cannot be walked on.', here());
    if ((n.kind === 'blacksmith' || n.kind === 'sage') && !index.isSafe(n.x, n.z)) {
      warn('npc-unsafe', path, `This ${n.kind} stands outside every safe region: monsters can reach its customers.`, here());
    }
  }
  if (!npcs.some((n) => n.kind === 'blacksmith')) warn('no-blacksmith', 'npcs', 'No Blacksmith on the map: weapon upgrades are unavailable.');
  if (!npcs.some((n) => n.kind === 'sage')) warn('no-sage', 'npcs', 'No Sage on the map: players cannot learn skills or choose a profession.');

  // ---- objects
  const objects = map.objects, nObjects = Math.min(objects.length, L.objects), known = new Map(), missing = new Map();
  if (objects.length > L.objects) {
    error('too-many', 'objects', `The map has ${objects.length} objects; the limit is ${L.objects.toLocaleString('en-US')}.`);
  } else if (objects.length > L.objectsWarn) {
    warn('many-objects', 'objects', `The map has ${objects.length} objects; more than ${L.objectsWarn.toLocaleString('en-US')} is heavy to draw.`);
  }
  for (let i = 0; i < nObjects; i++) {
    const o = objects[i];
    if ((bad = known.get(o.m)) === undefined) known.set(o.m, bad = modelProblem(o.m));
    if (bad) error('enum', `objects[${i}].m`, bad, on('object', i, o));
    else if (models && !models.has(o.m)) {
      const seen = missing.get(o.m);
      if (seen) seen.n++; else missing.set(o.m, { i, n: 1 });
    }
    if (!(Math.abs(num(o.x)) <= half && Math.abs(num(o.z)) <= half)) {
      error('object-pos', `objects[${i}]`, `An object must stay on the ground grid: within ${half} units of the centre on both axes.`, on('object', i, o));
    } else if (!within(o.y, L.objectY)) {
      error('object-pos', `objects[${i}].y`, `An object's height must be from ${span(L.objectY)}.`, on('object', i, o));
    }
    if (!within(o.s, L.scale)) error('object-scale', `objects[${i}].s`, `An object's scale must be from ${span(L.scale)}.`, on('object', i, o));
    else if (!within(o.sy, L.scale)) {
      error('object-scale', `objects[${i}].sy`, `An object's height scale must be from ${span(L.scale)}.`, on('object', i, o));
    }
    if (o.col != null && (bad = colProblem(o.col))) error('col', `objects[${i}].col`, bad, on('object', i, o));
    if (!groupOk(o.g)) error('enum', `objects[${i}].g`, GROUP_MESSAGE, on('object', i, o));
    if (!(Number.isFinite(o.rx) && Number.isFinite(o.ry) && Number.isFinite(o.rz))) {
      error('not-finite', `objects[${i}].ry`, ANGLE_MESSAGE, on('object', i, o));
    }
    if (Math.hypot(o.x, o.z) > radius + OUTSIDE) {
      warn('object-outside', `objects[${i}]`, `This object is more than ${OUTSIDE} units beyond the map radius.`, on('object', i, o));
    }
  }
  // one issue per model, not per object: a missing pack would otherwise bury everything else
  for (const [id, { i, n }] of missing) {
    (strictModels ? error : warn)('model-missing', `objects[${i}].m`,
      `The model "${id}" is not among the game's assets${n > 1 ? ` (${n} objects use it)` : ''}.`, on('object', i, objects[i]));
  }
  for (const [i, j] of duplicateObjects(objects, nObjects)) {
    warn('object-duplicate', `objects[${i}]`, `This object sits on top of objects[${j}], the same model.`, on('object', i, objects[i]));
  }

  return [...errors, ...warnings];
}

// ---------------------------------------------------------------- file form: writing

const degrees = (rad) => toDeg(qAngle(rad));
const put = (file, key, value, def) => { if (value !== def) file[key] = value; };
const pairOf = (l) => [l[0], l[1]];

// One runtime item -> its file form: degrees, defaults omitted, keys in canonical order. For 'object', 'spawn', 'chest',
// 'npc' and 'region' (the clipboard and stamps use it too); the start has no file form of its own.
export function encodeItem(kind, item) {
  if (kind === 'object') {
    const f = { m: item.m, x: qPos(item.x) }, col = item.col;
    put(f, 'y', qPos(item.y), 0);
    f.z = qPos(item.z);
    put(f, 'rx', degrees(item.rx), 0); put(f, 'ry', degrees(item.ry), 0); put(f, 'rz', degrees(item.rz), 0);
    put(f, 's', qScale(item.s), 1); put(f, 'sy', qScale(item.sy), 1);
    if (Array.isArray(col)) f.col = col.map((c) => ({ x: qScale(c.x), z: qScale(c.z), r: qScale(c.r) }));
    else if (col != null) f.col = typeof col === 'number' ? qPos(col) : col;
    if (item.g != null) f.g = item.g;
    return f;
  }
  if (kind === 'spawn') {
    const types = {};
    for (const k of MOB_KEYS) if (Object.hasOwn(item.types, k)) types[k] = item.types[k];
    for (const k of Object.keys(item.types)) if (!Object.hasOwn(types, k)) types[k] = item.types[k];   // unknown ids are kept: the next load reports them
    const f = { types, lvl: pairOf(item.lvl), x: qPos(item.x), z: qPos(item.z), r: qPos(item.r), count: item.count, respawn: item.respawn };
    if (item.g != null) f.g = item.g;
    return f;
  }
  if (kind === 'chest') {
    const f = { x: qPos(item.x), z: qPos(item.z) };
    put(f, 'ry', degrees(item.ry), 0);
    f.gold = item.gold;
    put(f, 'big', item.big, false);
    f.respawn = item.respawn;
    if (item.g != null) f.g = item.g;
    return f;
  }
  if (kind === 'npc') {
    const f = { kind: item.kind, x: qPos(item.x), z: qPos(item.z) };
    put(f, 'ry', degrees(item.ry), 0);
    if (item.g != null) f.g = item.g;
    return f;
  }
  if (kind === 'region') {
    const f = { name: item.name }, s = item.shape;
    if (item.levels != null) f.levels = pairOf(item.levels);
    if (item.mood != null) f.mood = item.mood;
    put(f, 'safe', item.safe, false);
    if (item.color != null) f.color = item.color;
    f.shape = s.type === 'circle'
      ? { type: 'circle', x: qPos(s.x), z: qPos(s.z), r: qPos(s.r) }
      : { type: 'poly', points: s.points.map((p) => [qPos(p[0]), qPos(p[1])]) };
    return f;
  }
  throw new TypeError(`encodeItem: no such kind of item: ${kind}`);
}

// GameMap -> the canonical file-form object. Pure. With `check` it throws a MapError when validate(map) has errors;
// check: false is for the autosave draft and for exporting work in progress.
export function serialize(map, { check = true } = {}) {
  if (check) throwOnErrors(validate(map));
  const { start, fallback, ground } = map, objects = [], byModel = new Map();
  // objects are stable-sorted by model id, which groups each model's lines; every other list keeps its order
  for (const o of map.objects) {
    const list = byModel.get(o.m);
    if (list) list.push(o); else byModel.set(o.m, [o]);
  }
  for (const m of [...byModel.keys()].sort()) for (const o of byModel.get(m)) objects.push(encodeItem('object', o));
  const fb = { name: fallback.name };
  if (fallback.levels != null) fb.levels = pairOf(fallback.levels);
  fb.mood = fallback.mood;
  return {
    version: FORMAT_VERSION,
    name: map.name,
    radius: map.radius,
    start: { x: qPos(start.x), z: qPos(start.z), r: qPos(start.r) },
    foliage: map.foliage,
    fallback: fb,
    regions: map.regions.map((r) => encodeItem('region', r)),
    spawns: map.spawns.map((s) => encodeItem('spawn', s)),
    chests: map.chests.map((c) => encodeItem('chest', c)),
    npcs: map.npcs.map((n) => encodeItem('npc', n)),
    ground: { cell: ground.cell, size: ground.size, ...encodeRows(ground.cells, ground.size) },
    objects,
  };
}

// Key order of a value, by the key it is stored under; the elements of an array share their array's order.
const ORDER = {
  start: XZR, fallback: FILE_KEYS.fallback, regions: FILE_KEYS.region, spawns: FILE_KEYS.spawn, chests: FILE_KEYS.chest,
  npcs: FILE_KEYS.npc, objects: FILE_KEYS.object, shape: ['type', 'x', 'z', 'r', 'points'], col: XZR, types: MOB_KEYS,
};
const LISTS = ['regions', 'spawns', 'chests', 'npcs', 'objects'];     // written one item per line
const orderOf = (key) => (Object.hasOwn(ORDER, key) ? ORDER[key] : []);

// One value on one line: { "k": v, "k": v } and [a, b]. Known keys come first, in canonical order.
function inline(v, order) {
  if (Array.isArray(v)) return `[${v.map((e) => inline(e, order)).join(', ')}]`;
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';     // String(n) for a finite number, never "-0"
  const keys = [...order.filter((k) => Object.hasOwn(v, k)), ...Object.keys(v).filter((k) => !order.includes(k))].filter((k) => v[k] !== undefined);
  return keys.length ? `{ ${keys.map((k) => `${JSON.stringify(k)}: ${inline(v[k], orderOf(k))}`).join(', ')} }` : '{}';
}

// A file-form object -> the text of a map file. The ONLY function that produces those bytes (server save, bake, Export):
// LF, 2-space indent, one top-level key per line, one item per line, one ground row per line.
// JSON.parse(stringifyMap(f)) deep-equals f, and the text of a canonical file comes back unchanged.
export function stringifyMap(file) {
  const block = (key, open, lines, close) => (lines.length ? `${key}: ${open}\n${lines.join(',\n')}\n${close}` : `${key}: ${open}${close.trim()}`);
  const entries = [];
  for (const k of [...TOP_KEYS, ...Object.keys(file).filter((key) => !TOP_KEYS.includes(key))]) {
    const v = file[k], key = `  ${JSON.stringify(k)}`;
    if (v === undefined) continue;
    if (k === 'ground' && isObj(v)) {
      const rest = Object.keys(v).filter((g) => v[g] !== undefined && g !== 'rows');
      const lines = [...FILE_KEYS.ground.filter((g) => rest.includes(g)), ...rest.filter((g) => !FILE_KEYS.ground.includes(g))]
        .map((g) => `    ${JSON.stringify(g)}: ${inline(v[g], [])}`);
      if (Array.isArray(v.rows)) lines.push(block('    "rows"', '[', v.rows.map((row) => `      ${inline(row, [])}`), '    ]'));
      else if (v.rows !== undefined) lines.push(`    "rows": ${inline(v.rows, [])}`);
      entries.push(block(key, '{', lines, '  }'));
    } else if (Array.isArray(v) && LISTS.includes(k)) {
      entries.push(block(key, '[', v.map((item) => `    ${inline(item, ORDER[k])}`), '  ]'));
    } else entries.push(`${key}: ${inline(v, orderOf(k))}`);
  }
  return `{\n${entries.join(',\n')}\n}\n`;
}

// ---------------------------------------------------------------- a blank map

// A valid empty island: grass inside, a sand shore, no items. The radius is rounded and clamped to what a cell-2 grid
// can cover (40..492), so the result always passes validate() - with warnings only, for everything it still lacks.
export function emptyMap({ radius = 260 } = {}) {
  const cell = 2, most = Math.min(LIMITS.radius[1], maxRadius({ cell }));
  const r = Math.max(LIMITS.radius[0], Math.min(most, Math.round(Number.isFinite(radius) ? radius : 260)));
  const size = 2 * Math.ceil((r + LIMITS.groundMargin) / cell) + 1;
  const ground = { cell, size, cells: new Uint8Array(size * size) };
  for (let iz = 0; iz < size; iz++) {
    for (let ix = 0; ix < size; ix++) {
      const shore = Math.hypot(groundX(ground, ix), groundX(ground, iz)) > r - 2;
      ground.cells[iz * size + ix] = shore ? GROUND_INDEX.sand : GROUND_INDEX.grass;
    }
  }
  return {
    version: FORMAT_VERSION, name: 'New map', radius: r,
    start: { x: 0, z: 0, r: 5 },
    foliage: true,
    fallback: { name: 'Open Sea', levels: null, mood: 'meadow' },
    regions: [], spawns: [], chests: [], npcs: [],
    ground,
    objects: [],
  };
}
