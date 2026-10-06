import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  TICK, ATTACK_WINDUP, CHEST_REACH, SHOP_RANGE, AGGRO_R, BOSS_AGGRO_R, LEASH_R, WANDER_R,
  MOB_TYPES, MOB_KEYS, mobStats, CLASSES, CLASS_KEYS, START_CLASSES, PROFESSION_LEVEL, SKILLS, skillsFor, classLine, statsOf, castTime,
  mitigate, hitChance, xpNext, spFor, DEATH_XP_LOSS, upgradeCost,
} from './src/shared.js';
import {
  normalize, validate, serialize, stringifyMap, regionIndex, pushOutOfSafe, nearNpc, startPoint, spawnHome, pickType, pickLevel,
  isBlocked, MapError, LIMITS,
} from './src/map/format.js';
import { PACKS, listModels } from './src/map/catalog.js';

const PORT = process.env.PORT || 8765;   // PORT=0 picks a free port; the start-up line prints the real one
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SAVE_FILE = path.join(path.resolve(ROOT, process.env.DATA_DIR || 'data'), 'players.json');
const MAP_FILE = path.resolve(ROOT, process.env.MAP_FILE || 'map/world.json');
const BACKUP_DIR = path.join(path.dirname(MAP_FILE), 'backups');
const VIEW_R = 65;

// The world is a data file. Only in editor mode can it be saved over HTTP: without a token by this machine alone, with
// EDITOR_TOKEN by whoever knows the token. (The variable EDITOR is never read: on most hosts it names the user's text editor.)
const TOKEN = process.env.EDITOR_TOKEN;
if (TOKEN !== undefined && (TOKEN.length < 24 || TOKEN.length > 256)) {
  // an empty value is an error as well: an unset variable in a compose file must not quietly mean "no token"
  console.error('EDITOR_TOKEN must be 24 to 256 characters long.');
  process.exit(1);
}
const EDITOR_ASKED = process.argv.includes('--editor') || process.env.MAP_EDITOR === '1';
const EDITOR = EDITOR_ASKED && !(TOKEN === undefined && process.env.NODE_ENV === 'production');
const TOKEN_MODE = EDITOR && TOKEN !== undefined;   // the token alone does not switch the editor on
if (EDITOR_ASKED && !EDITOR) console.log('editor mode ignored: set EDITOR_TOKEN to use it in production');

// a lookup in a table by a key that a client sent: "constructor" and "__proto__" are not entries
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

// ---------------------------------------------------------------- static files

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.png': 'image/png',
};
const PAGES = ['index.html', 'editor.html'];   // the only files served from the root
const PUBLIC = ['src', 'assets'];              // and the only folders: never map/, data/, tools/, test/, docs/ or .git/

function notFound(res) {
  res.writeHead(404).end('Not found');
}

// What a client sends back in If-None-Match, without the quotes and without the W/ a proxy may have put in front.
const noneMatch = (req) => String(req.headers['if-none-match'] ?? '').replace(/^W\//, '').replace(/"/g, '');

// A callback of a request: whatever it throws becomes a 500 instead of reaching the process.
const guarded = (res, fn) => (...args) => {
  try { fn(...args); } catch (err) { internalError(res, err); }
};

function serveFile(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
    return;
  }
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { notFound(res); return; }
  if (rel.includes('\\') || rel.includes('\0')) { notFound(res); return; }
  if (rel === '/') rel = '/index.html';
  // The whitelist looks at the RESOLVED path: "/src/..%2fdata/players.json" starts with /src/ and ends up outside it.
  const file = path.join(ROOT, rel), parts = path.relative(ROOT, file).split(path.sep);
  if (!(parts.length === 1 ? PAGES : PUBLIC).includes(parts[0])) { notFound(res); return; }
  fs.stat(file, guarded(res, (err, st) => {
    if (err || !st.isFile()) { notFound(res); return; }
    // code is always re-fetched; models are large and rarely change, so browsers may keep them - except in editor mode,
    // where a model that was just replaced must not stay stale for a day
    const asset = parts[0] === 'assets';
    const headers = {
      'Content-Type': own(MIME, path.extname(file)) || 'application/octet-stream',
      'Cache-Control': asset && !EDITOR ? 'public, max-age=86400' : 'no-cache',
    };
    if (asset && EDITOR) {
      const tag = `${st.size}-${st.mtimeMs}`;
      headers.ETag = `"${tag}"`;
      if (noneMatch(req) === tag) { res.writeHead(304, headers).end(); return; }
    }
    if (req.method === 'HEAD') { res.writeHead(200, { ...headers, 'Content-Length': st.size }).end(); return; }
    fs.readFile(file, guarded(res, (failed, data) => {
      if (failed) { notFound(res); return; }
      res.writeHead(200, { ...headers, 'Content-Length': data.length }).end(data);
    }));
  }));
}

// ---------------------------------------------------------------- who may save

// Headers that only a proxy adds. Behind one, every request arrives from the proxy's own (often loopback) address.
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'via',
  'cf-connecting-ip', 'cf-ray', 'true-client-ip', 'x-original-host'];
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

// Node reports IPv4 loopback as ::ffff:127.0.0.1.
function isLoopback(address) {
  const a = String(address ?? '').replace(/^::ffff:/, '');
  return a === '::1' || /^127\.\d+\.\d+\.\d+$/.test(a);
}
// The page was opened under a local name: a foreign name that merely resolves to this machine (DNS rebinding) is refused.
const hostOk = (req) => LOCAL_HOSTS.includes(String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, ''));
const localRequest = (req) => isLoopback(req.socket.remoteAddress) && !PROXY_HEADERS.some((h) => req.headers[h] !== undefined) && hostOk(req);
// Sent by a page of this very server. A missing Origin, or "null", is not good enough.
const originOk = (req) => req.headers.origin === `http://${req.headers.host}`
  && (req.headers['sec-fetch-site'] === undefined || req.headers['sec-fetch-site'] === 'same-origin');

const sha256 = (text) => crypto.createHash('sha256').update(text);
const TOKEN_HASH = TOKEN_MODE ? sha256(TOKEN).digest() : null;
// Digests are compared, never the values: the same length whatever was sent, in constant time. The value goes through
// String() first - a join can carry a number, and hashing a number throws.
const tokenOk = (value) => crypto.timingSafeEqual(sha256(String(value ?? '')).digest(), TOKEN_HASH);

const FAIL_WINDOW = 60000, FAIL_LIMIT = 10, FAIL_ADDRESSES = 1000;
const failures = new Map();   // remote address -> the times of its recent wrong tokens, oldest first

// Notes one wrong token, sent over HTTP or in a join, and tells whether that address is past the limit.
// Only failures are counted and only failures are turned away: behind a proxy every request has the proxy's address,
// so a limiter that also refused the correct token would let any visitor lock the designer out.
function tokenFailure(address) {
  const t = performance.now(), key = String(address);
  for (const [a, times] of failures) {
    while (times.length && times[0] <= t - FAIL_WINDOW) times.shift();
    if (!times.length) failures.delete(a);
  }
  let times = failures.get(key);
  if (!times) {
    if (failures.size >= FAIL_ADDRESSES) failures.delete(failures.keys().next().value);
    failures.set(key, times = []);
  }
  if (times.length > FAIL_LIMIT) return true;
  times.push(t);
  return false;
}

// ---------------------------------------------------------------- api

const JSON_TYPE = 'application/json; charset=utf-8';
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const BODY_TIMEOUT = 20000;   // milliseconds a save has to arrive in

function json(res, status, body, headers) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': JSON_TYPE, 'Content-Length': data.length, 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

// Nothing a request does may take the process down, and no answer says what went wrong inside (no path, no message).
function internalError(res, err) {
  console.error('request failed:', err);
  if (res.headersSent) res.destroy();
  else json(res, 500, { ok: false, error: 'internal' });
}

function acceptsGzip(req) {
  for (const part of String(req.headers['accept-encoding'] ?? '').toLowerCase().split(',')) {
    const [coding, q] = part.split(';').map((s) => s.trim());
    if (coding === 'gzip') return !/^q=0(\.0*)?$/.test(q ?? '');
  }
  return false;
}

// The map as canonical text. Spawn and chest data is public by design.
function getMap(req, res) {
  // X-Map-Rev repeats the ETag where no proxy weakens or drops it: a client holding another revision can neither join nor save
  const headers = { ETag: `"${rev}"`, 'X-Map-Rev': rev, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
  if (noneMatch(req) === rev) { res.writeHead(304, headers).end(); return; }
  const gzip = acceptsGzip(req), body = gzip ? mapGzip : mapBuf;
  if (gzip) headers['Content-Encoding'] = 'gzip';
  res.writeHead(200, { 'Content-Type': JSON_TYPE, 'Content-Length': body.length, ...headers }).end(body);
}

// The model files of every pack, by name. No request input reaches the file system here.
const ASSET_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.(gltf|glb)$/;
let assetsBuf, assetsAt = -Infinity;
let models = new Set();   // every model id the game can serve, hidden ones included; rebuilt by each scan

function scanAssets() {
  const packs = {};
  for (const [id, pack] of Object.entries(PACKS)) {
    if (!pack.dir) continue;
    packs[id] = [];
    try {
      for (const entry of fs.readdirSync(path.join(ROOT, pack.dir), { withFileTypes: true })) {
        if (entry.isFile() && ASSET_RE.test(entry.name) && entry.name.endsWith(`.${pack.ext}`)) packs[id].push(entry.name.slice(0, -pack.ext.length - 1));
      }
    } catch { /* a pack without its folder has no models */ }
    packs[id].sort();
  }
  assetsBuf = Buffer.from(JSON.stringify({ packs }));
  models = new Set(listModels({ packs }, { hidden: true }));   // hidden models are valid map content
  assetsAt = performance.now();
}
// In editor mode a model dropped into a pack folder shows up without a restart; the scan runs once per 2 s at most.
function rescanAssets() {
  if (EDITOR && performance.now() - assetsAt >= 2000) scanAssets();
}

function getAssets(req, res) {
  rescanAssets();
  res.writeHead(200, { 'Content-Type': JSON_TYPE, 'Content-Length': assetsBuf.length, 'Cache-Control': 'no-store' }).end(assetsBuf);
}

// canSave answers for THIS request. In token mode it is true for every visitor: the token itself is asked for on save.
function getEditor(req, res) {
  json(res, 200, { enabled: EDITOR, tokenRequired: TOKEN_MODE, canSave: EDITOR && (TOKEN_MODE || localRequest(req)), rev });
}

// The checks of a save, in this order. Nothing of the body is read before the last of them has passed.
function postMap(req, res) {
  const refuse = (status, error, headers) => json(res, status, { ok: false, error }, headers);
  if (!EDITOR) { refuse(403, 'editor-off'); return; }
  if (TOKEN_MODE) {
    // the token comes first and a correct one always passes; the Origin is not looked at (a proxy rewrites Host, and a
    // token is not a credential the browser attaches by itself)
    if (!tokenOk(req.headers['x-editor-token'])) {
      if (tokenFailure(req.socket.remoteAddress)) refuse(429, 'rate', { 'Retry-After': 60 });
      else refuse(401, 'token');
      return;
    }
  } else if (!localRequest(req)) { refuse(403, 'not-local'); return; }
  if (req.headers['x-editor'] !== '1') { refuse(403, 'header'); return; }   // a custom header: no plain form can send it
  if (!TOKEN_MODE && !originOk(req)) { refuse(403, 'origin'); return; }
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' || req.headers['content-encoding'] !== undefined) { refuse(415, 'content-type'); return; }
  if (Number(req.headers['content-length']) > LIMITS.bodyBytes) { refuse(413, 'too-large', { Connection: 'close' }); return; }
  readBody(req, res, guarded(res, (body) => {
    const [status, answer, headers] = saveMap(body, req.headers['x-base-rev']);
    json(res, status, answer, headers);
  }));
}

// Collects the body of a save and hands it to `done`. One that is too long or too slow is refused here and its
// connection closed: the rest of it is not worth waiting for.
function readBody(req, res, done) {
  const chunks = [];
  let size = 0, open = true;
  const close = () => { open = false; clearTimeout(timer); };
  const refuse = (status, error) => {
    close();
    json(res, status, { ok: false, error }, { Connection: 'close' });
    res.once('finish', () => req.destroy());
  };
  const timer = setTimeout(() => refuse(408, 'timeout'), BODY_TIMEOUT);
  req.on('data', (chunk) => {
    if (!open) return;
    size += chunk.length;
    if (size > LIMITS.bodyBytes) refuse(413, 'too-large');
    else chunks.push(chunk);
  });
  req.on('end', () => {
    if (!open) return;
    close();
    done(Buffer.concat(chunks));
  });
  req.on('error', close);   // the client went away: nobody is left to answer
  req.on('close', close);
}

let savedAt = -Infinity;      // when the last save was accepted (performance.now())
let saves = 0;                // accepted saves since this server started
let sessionBackup = null;     // the backup made by the first of them: the map as this editing session found it

// From the bytes of a request to its answer, [status, body, headers]. One synchronous function, so saves cannot interleave.
function saveMap(body, baseRev) {
  const refuse = (status, error, more, headers) => [status, { ok: false, error, ...more }, headers];
  let file;
  try { file = JSON.parse(UTF8.decode(body)); } catch { return refuse(400, 'bad-json'); }
  if (typeof file !== 'object' || file === null || Array.isArray(file)) return refuse(400, 'bad-json');

  rescanAssets();
  let next, issues;
  try {
    next = normalize(file);
    issues = validate(next, { models, strictModels: true });   // here a model the game cannot serve is an error
  } catch (err) {
    if (!(err instanceof MapError)) throw err;
    issues = err.issues;
  }
  const errors = issues.filter((i) => i.level === 'error');
  if (errors.length) return refuse(422, 'invalid', { issues: errors.slice(0, 50) });

  // the server writes its own canonical text, never the bytes of the request
  const canonical = serialize(next), text = stringifyMap(canonical);
  const alive = () => mobs.reduce((n, m) => n + (m.dead ? 0 : 1), 0);
  if (text === mapText) return [200, { ok: true, unchanged: true, rev, monsters: alive(), backup: null, warnings: issues }];
  if (baseRev !== '*' && baseRev !== rev) return refuse(409, 'conflict', { rev });   // somebody else saved in between
  if (performance.now() - savedAt < 1000) return refuse(429, 'rate', null, { 'Retry-After': 1 });

  const world = buildWorld(next, canonical, text);   // may throw: nothing is touched yet
  let backup;
  try {
    backup = backupMapFile();
    writeMapFile(world.buf);
  } catch (err) {   // the old map stays live
    console.error('map save failed:', err);
    return refuse(500, 'write-failed', { code: err.code });
  }
  if (!saves++) sessionBackup = backup;
  savedAt = performance.now();
  applyMap(world);
  pruneBackups();
  return [200, { ok: true, unchanged: false, rev, monsters: alive(), backup, warnings: issues }];
}

// world-YYYYMMDD-HHMMSS-<rev>.json, or session-... for the first save of a run. The time is UTC.
const BACKUP_RE = /^(?:world|session)-(\d{8})-\d{6}-[0-9a-f]{16}\.json$/;
const backupDay = (date) => date.toISOString().slice(0, 10).replaceAll('-', '');

// Backups, oldest first. Other files in the folder are nobody's business, and so is a directory or a link with the
// name of a backup: it is neither a map to go back to nor something to rotate away.
function listBackups() {
  let entries;
  try { entries = fs.readdirSync(BACKUP_DIR, { withFileTypes: true }); } catch { return []; }
  const stamp = (name) => name.slice(name.indexOf('-') + 1);
  return entries.filter((entry) => entry.isFile() && BACKUP_RE.test(entry.name)).map((entry) => entry.name)
    .sort((a, b) => (stamp(a) < stamp(b) ? -1 : stamp(a) > stamp(b) ? 1 : 0));
}

// Copies the map file as it is on disk - not the map in memory - before it is overwritten. Returns the backup's name,
// or null when there is no file to back up. The name comes from the clock and the old revision, never from the client.
function backupMapFile() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });   // nothing else creates the folder; a fresh clone starts without it
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');   // YYYYMMDD-HHMMSS
  const name = `${saves ? 'world' : 'session'}-${stamp}-${rev}.json`;
  try {
    fs.copyFileSync(MAP_FILE, path.join(BACKUP_DIR, name), fs.constants.COPYFILE_EXCL);
  } catch (err) {
    if (err.code === 'ENOENT') return null;   // the map file is gone (a branch switch, say): nothing to keep
    if (err.code !== 'EEXIST') throw err;     // EEXIST: an attempt that failed later has already made this copy
  }
  return name;
}

// Atomic: the text goes into a temp file beside the map, reaches the disk, and replaces the map in one rename.
function writeMapFile(data) {
  const tmp = `${MAP_FILE}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, MAP_FILE);
  } catch (err) {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* nothing to close */ }
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    throw err;
  }
}

// Keeps the 20 newest backups, the oldest one of each of the last 14 days, and what this run started from.
// (With "the 20 newest" alone, twenty presses of Ctrl+S would erase every backup older than a few minutes.)
function pruneBackups() {
  try {
    const names = listBackups(), keep = new Set(names.slice(-20));
    if (sessionBackup) keep.add(sessionBackup);
    const days = new Set(Array.from({ length: 14 }, (_, i) => backupDay(new Date(Date.now() - i * 86400000))));
    for (const name of names) if (days.delete(BACKUP_RE.exec(name)[1])) keep.add(name);   // oldest first: the first of a day
    for (const name of names) {
      if (keep.has(name)) continue;
      // each on its own: one backup that cannot be removed must not stop the rotation of all the others
      try { fs.unlinkSync(path.join(BACKUP_DIR, name)); } catch (err) { console.error(`map backup ${name} was not removed (${err.code})`); }
    }
  } catch (err) {
    console.error('pruning the map backups failed:', err);
  }
}

// /api/* is matched by path and method before any file is looked for. No endpoint lists or serves backups.
const API = {
  '/api/map': { GET: getMap, POST: postMap },
  '/api/assets': { GET: getAssets },
  '/api/editor': { GET: getEditor },
};

function api(req, res, pathname) {
  const wrongMethod = (allow) => json(res, 405, { ok: false, error: 'method' }, { Allow: allow });
  if (req.method === 'OPTIONS') { wrongMethod('GET, POST'); return; }   // so every cross-origin preflight fails
  const route = own(API, pathname);
  if (!route) json(res, 404, { ok: false, error: 'not-found' });
  else if (!Object.hasOwn(route, req.method)) wrongMethod(Object.keys(route).join(', '));
  else route[req.method](req, res);
}

const server = http.createServer((req, res) => {
  try {
    let pathname;
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { pathname = ''; }
    if (pathname.startsWith('/api/')) api(req, res, pathname);
    else serveFile(req, res, pathname);
  } catch (err) {
    internalError(res, err);
  }
});

// ---------------------------------------------------------------- persistence

const saved = Object.create(null);   // keyed by the tokens clients send: without a prototype "__proto__" is a key like any other
try { Object.assign(saved, JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'))); } catch { /* first run */ }

function persist(p) {
  if (!p.persist) return;
  saved[p.token] = { name: p.name, cls: p.cls, level: p.level, xp: p.xp, sp: p.sp, skills: p.skills, gold: p.gold, weapon: p.weapon };
}
function flush() {
  for (const p of players.values()) persist(p);
  fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
  fs.writeFileSync(SAVE_FILE, JSON.stringify(saved));
}

// ---------------------------------------------------------------- world state

// The map and what is derived from it; applyMap() replaces them together.
// mapText is the server's own canonical text of the map (not the bytes on disk) and rev its hash.
let map, mapText, mapBuf, mapGzip, rev, regions;
let nextId = 1, now = 0;
const players = new Map();
let mobs = [], mobById = new Map(), mobsKey = null;
let bullets = [], orbs = [], gems = [], blasts = [];
let chests = [];

const rand = (a, b) => a + Math.random() * (b - a);
const r2 = (v) => Math.round(v * 100) / 100;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const CLEAN = { kx: 0, kz: 0, target: 0, swing: null, stunUntil: 0, sleepUntil: 0, slowUntil: 0, slowMult: 1, dot: null };
// Seconds the movement check stays loose after the server has put a player somewhere (a join, a respawn, a corrected
// position, a new map), and the units a step may then be beyond the speed limit. A cat that lands beside blocked ground
// or scenery is pushed several units by its own client; without the grace the server would snap it back for ever.
// The units are a budget for the whole grace, not for each message: they are there to settle once, not to travel on.
const GRACE = 3, GRACE_SLACK = 40;
const grace = (p) => { p.graceUntil = now + GRACE; p.slack = GRACE_SLACK; };

function makeMob(type, lvl, sx, sz, respawn) {
  const def = MOB_TYPES[type], st = mobStats(type, lvl);
  return {
    id: nextId++, type, ti: MOB_KEYS.indexOf(type), lvl, def, r: def.r, sx, sz, x: sx, z: sz, respawn,
    hp: st.maxHp, ...st, xp: def.xp * lvl,
    fireT: rand(1, 3), hitAt: 0, wx: sx, wz: sz, wanderAt: 0,
    dead: false, respawnAt: 0, dmgBy: new Set(), dashHit: '', strafe: Math.random() < 0.5 ? 1 : -1, ...CLEAN,
  };
}

// The monsters of a map. Each one rolls its type, its home and its level once and keeps them for life.
function spawnMobs(next) {
  const list = [];
  next.spawns.forEach((spawn, i) => {
    let homeless = 0;
    for (let n = 0; n < spawn.count; n++) {
      const type = pickType(spawn.types, Math.random());
      const home = spawnHome(next, spawn, MOB_TYPES[type].r);
      if (!home) { homeless++; continue; }
      list.push(makeMob(type, pickLevel(spawn.lvl, Math.random()), home.x, home.z, spawn.respawn));
    }
    if (homeless) console.warn(`spawns[${i}]: no room for ${homeless} of its ${spawn.count} monsters`);
  });
  return list;
}

// Everything a map turns into, built beside the running world; may throw. `file` is the map's canonical file form
// and `text` the text of that.
function buildWorld(next, file, text) {
  // Monsters start over only when their spawns, the safe regions or the radius changed, so that a scenery or terrain
  // edit does not reset the fights going on.
  const key = JSON.stringify([file.radius, file.spawns, file.regions.filter((r) => r.safe).map((r) => r.shape)]);
  const list = key === mobsKey ? null : spawnMobs(next);
  const same = (a, b) => Math.abs(a.x - b.x) < 0.011 && Math.abs(a.z - b.z) < 0.011;
  return {
    map: next, text, buf: Buffer.from(text), gzip: zlib.gzipSync(text), rev: sha256(text).digest('hex').slice(0, 16),
    regions: regionIndex(next), key, mobs: list, mobById: list && new Map(list.map((m) => [m.id, m])),
    // the wire index of a chest is its place in the list; one that stayed where it was stays open as long as it had left
    chests: next.chests.map((c, i) => ({ ...c, i, openUntil: chests.find((old) => same(old, c))?.openUntil ?? 0 })),
  };
}

// Swaps the world for one made by buildWorld(). Assignments only, so the swap cannot stop half way.
function applyMap(world) {
  map = world.map; mapText = world.text; mapBuf = world.buf; mapGzip = world.gzip; rev = world.rev; regions = world.regions;
  chests = world.chests;   // gems stay
  if (world.mobs) {
    // nextId is never reset: an id a client still holds can never name a new monster
    mobs = world.mobs; mobById = world.mobById; mobsKey = world.key;
    bullets = []; orbs = []; blasts = [];
  }
  for (const p of players.values()) {
    clampWorld(p, 1);
    grace(p);
  }
  // every socket, joined or not: it arrives before any snapshot of the new map, and the client reloads on it
  for (const ws of wss.clients) send(ws, { t: 'map', rev });
}

// Reads the map file, or ends the process saying why. There is no restore from a backup and no empty world instead, and
// the file is never rewritten here: an older format is migrated in memory and written by the next save.
function loadMap() {
  let text, next;
  try { text = fs.readFileSync(MAP_FILE, 'utf8'); } catch (err) {
    console.error(err.code === 'ENOENT' ? `Map file not found: ${MAP_FILE}. Run: npm run bake` : `Map file cannot be read (${err.code}): ${MAP_FILE}`);
    process.exit(1);
  }
  try { next = normalize(JSON.parse(text)); } catch (err) {
    const issues = err instanceof MapError ? err.issues : [{ path: 'JSON', message: err.message }];
    console.error(`Map file is not valid: ${MAP_FILE}`);
    for (const issue of issues.slice(0, 10)) console.error(`  ${issue.path}: ${issue.message}`);
    if (issues.length > 10) console.error(`  (+${issues.length - 10} more)`);
    console.error(`Newest backup: ${listBackups().pop() ?? 'no backup'}`);
    process.exit(1);
  }
  const warnings = validate(next, { models }).filter((i) => i.level === 'warning');
  for (const issue of warnings.slice(0, 20)) console.warn(`map warning: ${issue.path}: ${issue.message}`);
  if (warnings.length > 20) console.warn(`(+${warnings.length - 20} more map warnings)`);
  const file = serialize(next);
  return buildWorld(next, file, stringifyMap(file));
}

// Queue an event for every player close enough to see it.
function emit(ev, x, z, range = VIEW_R) {
  for (const p of players.values()) if (Math.hypot(p.x - x, p.z - z) < range) p.events.push(ev);
}

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(s);
}
function sendRoster() {
  broadcast({ t: 'r', l: [...players.values()].map((p) => [p.id, p.name]) });
}

function clampWorld(o, margin) {
  const d = Math.hypot(o.x, o.z), max = map.radius - margin;
  if (d > max) { o.x *= max / d; o.z *= max / d; }
}

// squared distance from point p to segment a-b
function segDist2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  const cx = ax + dx * t - px, cz = az + dz * t - pz;
  return cx * cx + cz * cz;
}

// ---------------------------------------------------------------- characters

// Recomputes every stat from class, level, weapon, passive skills and the buffs active right now.
function refresh(p) {
  const buffs = {};
  for (const [stat, b] of Object.entries(p.buffs)) if (now < b.until) buffs[stat] = b.mult;
  p.st = statsOf(p.cls, p.level, p.skills, p.weapon, buffs);
  p.maxHp = p.st.maxHp;
  p.maxMp = p.st.maxMp;
  p.hp = Math.min(p.hp, p.maxHp);
  p.mp = Math.min(p.mp, p.maxMp);
}

// Skills whose first rank costs nothing come with the class.
function grantFree(p) {
  for (const id of skillsFor(p.cls)) {
    const s = SKILLS[id];
    if (s.sp[0] === 0 && p.level >= s.lvl && !p.skills[id]) p.skills[id] = 1;
  }
}

// A physical attack on a monster: it can miss (Accuracy against Evasion) and can be a critical hit; P.Def reduces it.
// `power` is in the units of the skill table, where a plain weapon hit is 2.
function physical(p, power, m) {
  if (Math.random() > hitChance(p.st.acc, m.eva)) return { dmg: 0, miss: true };
  const crit = Math.random() < p.st.crit / 1000;
  return { dmg: mitigate(p.st.pAtk * power / 2 * (crit ? 2 : 1), m.pDef), crit };
}
// A spell always lands; M.Def reduces it.
function magical(p, power, m) {
  const crit = Math.random() < p.st.mCrit / 1000;
  return { dmg: mitigate(p.st.mAtk * power / 2 * (crit ? 2 : 1), m.mDef), crit };
}

function addXp(p, xp) {
  p.xp += xp;
  p.sp += spFor(xp);
  while (p.xp >= xpNext(p.level)) {
    p.xp -= xpNext(p.level);
    p.level++;
    grantFree(p);
    refresh(p);
    p.hp = p.maxHp;
    p.mp = p.maxMp;
    p.events.push({ k: 'lvl', level: p.level });
    emit({ k: 'lvlfx', x: r2(p.x), z: r2(p.z) }, p.x, p.z);
  }
}

// ---------------------------------------------------------------- combat

// `hit` is { dmg, crit }; the attacker sees the number float up over the monster.
function damageMob(m, hit, dx, dz, knock, p) {
  if (!m.target) m.target = p.id;
  if (hit.miss) { emit({ k: 'miss', id: m.id, o: p.id }, m.x, m.z); return; }
  m.hp -= hit.dmg;
  m.sleepUntil = 0;   // any damage wakes a sleeping monster
  m.dmgBy.add(p.id);
  m.kx += dx * knock / m.r; m.kz += dz * knock / m.r;
  const ev = { id: m.id, x: r2(m.x), z: r2(m.z), o: p.id, d: r2(hit.dmg), c: hit.crit ? 1 : 0 };
  if (m.hp > 0) { emit({ k: 'hit', ...ev }, m.x, m.z); return; }

  m.dead = true;
  m.respawnAt = now + m.respawn;
  emit({ k: 'kill', ti: m.ti, ...ev }, m.x, m.z);
  const drops = m.type === 'boss' ? 12 : m.type === 'tank' ? 3 : 1;
  for (let i = 0; i < drops; i++) {
    gems.push({
      id: nextId++, x: m.x + rand(-1, 1) * m.r * 1.5, z: m.z + rand(-1, 1) * m.r * 1.5,
      until: now + 25, gold: Math.ceil(rand(1, 3) * m.lvl),
    });
  }
  for (const id of m.dmgBy) {
    const q = players.get(id);
    if (q && !q.dead) addXp(q, m.xp);
  }
  if (m.type === 'boss') broadcast({ t: 'c', sys: 1, m: `The Skeleton King has fallen! Final blow: ${p.name}` });
  m.dmgBy.clear();
  m.target = 0;
}

// Stun, sleep, slow and bleeding carried by a skill. The King shrugs off stuns and sleep.
function applyEffects(m, fx, p) {
  if (m.dead) return;
  const immune = m.type === 'boss';
  if (fx.stun && !immune) m.stunUntil = Math.max(m.stunUntil, now + fx.stun);
  if (fx.sleep && !immune) m.sleepUntil = now + fx.sleep;
  if (fx.slow) { m.slowUntil = now + fx.slowDur; m.slowMult = fx.slow; }
  if (fx.dot) m.dot = { dps: fx.dot, until: now + fx.dotDur, next: now + 1, owner: p.id };
}

// A monster's attack on a player: physical blows can be dodged and are reduced by P.Def, spells by M.Def.
function hurtPlayer(p, m, magic) {
  if (p.god || p.dead || now < p.dashUntil || now < p.invulnUntil) return;
  if (!magic && Math.random() > hitChance(m.acc, p.st.eva)) { p.events.push({ k: 'dodge' }); return; }
  p.hp -= mitigate(m.pAtk, magic ? p.st.mDef : p.st.pDef);
  p.hurtAt = now;
  p.sit = false;
  p.invulnUntil = now + 0.5;
  p.events.push({ k: 'hurt' });
  if (p.hp <= 0) {
    p.hp = 0;
    p.dead = true;
    p.deadUntil = now + 6;
    const lost = Math.min(p.xp, Math.round(xpNext(p.level) * DEATH_XP_LOSS));   // death costs experience, never a level
    p.xp -= lost;
    p.buffs = {};
    p.events.push({ k: 'died', xp: lost });
    emit({ k: 'kill', id: 0, x: r2(p.x), z: r2(p.z), ti: -1 }, p.x, p.z);
    broadcast({ t: 'c', sys: 1, m: `${p.name} was slain` });
  }
}

function respawnPlayer(p) {
  const spot = startPoint(map);
  p.x = spot.x; p.z = spot.z; p.y = 0;
  p.hp = p.maxHp;
  p.mp = p.maxMp;
  p.dead = false;
  p.lastMoveAt = now;
  grace(p);
  p.events.push({ k: 'tp', x: r2(p.x), z: r2(p.z) });
}

// ---------------------------------------------------------------- simulation

function updateMob(m, dt) {
  if (m.dead) {
    if (now >= m.respawnAt) Object.assign(m, { dead: false, x: m.sx, z: m.sz, hp: m.maxHp }, CLEAN);
    return;
  }

  if (m.dot && now >= m.dot.next) {   // bleeding ticks once a second
    const owner = players.get(m.dot.owner);
    if (!owner || now > m.dot.until) m.dot = null;
    else {
      m.dot.next += 1;
      damageMob(m, { dmg: m.dot.dps, crit: false }, 0, 0, 0, owner);
      if (m.dead) return;
    }
  }

  const damp = Math.exp(-6 * dt);
  if (now < m.stunUntil || now < m.sleepUntil) {   // out of action: no thinking, no moving, no attacking
    m.swing = null;
    m.x += m.kx * dt; m.z += m.kz * dt;
    m.kx *= damp; m.kz *= damp;
    pushOutOfSafe(map, m, m.r + 0.5);   // a blow can knock it into a safe region; it does not stay there
    return;
  }

  let t = m.target ? players.get(m.target) : null;
  const leash = Math.hypot(m.x - m.sx, m.z - m.sz);
  if (t && (t.dead || t.safe || Math.hypot(t.x - m.x, t.z - m.z) > 26 || leash > LEASH_R + 4)) t = null;
  if (!t) {
    m.target = 0;
    let bestD = m.type === 'boss' ? BOSS_AGGRO_R : AGGRO_R;
    for (const p of players.values()) {
      if (p.dead || p.safe) continue;
      const d = Math.hypot(p.x - m.x, p.z - m.z);
      if (d < bestD && leash < LEASH_R) { bestD = d; t = p; }
    }
    if (t) m.target = t.id;
  }

  let mx = 0, mz = 0, speed = m.def.speed * (now < m.slowUntil ? m.slowMult : 1);
  if (t) {
    let dx = t.x - m.x, dz = t.z - m.z;
    const dist = Math.hypot(dx, dz) || 0.001;
    dx /= dist; dz /= dist;
    mx = dx; mz = dz;
    if (m.type !== 'shooter' && dist < m.r + 0.9) { mx = 0; mz = 0; }   // melee monsters stop at arm's length instead of walking into the player
    if (m.type === 'shooter' || m.type === 'boss') {
      if (m.type === 'shooter') {
        if (dist < 9) { mx = -dx; mz = -dz; } else if (dist < 14) { mx = -dz * m.strafe; mz = dx * m.strafe; }
      }
      m.fireT -= dt;
      if (m.fireT <= 0 && dist < 22) {
        m.fireT = m.type === 'boss' ? 1.4 : 2.2;
        emit({ k: 'atk', id: m.id }, m.x, m.z);
        const shots = m.type === 'boss' ? 8 : 1;
        for (let i = 0; i < shots; i++) {
          const a = Math.atan2(dz, dx) + i * Math.PI * 2 / shots;
          const ox = Math.cos(a), oz = Math.sin(a);
          orbs.push({ x: m.x + ox * m.r, z: m.z + oz * m.r, vx: ox * 10, vz: oz * 10, life: 3.5, from: m });
          emit({ k: 'orb', x: r2(m.x + ox * m.r), z: r2(m.z + oz * m.r), dx: r2(ox), dz: r2(oz) }, m.x, m.z);
        }
      }
    }
  } else {
    // idle: heal up and wander around the spawn point
    m.hp = Math.min(m.maxHp, m.hp + m.maxHp * 0.25 * dt);
    if (m.hp >= m.maxHp) m.dmgBy.clear();
    if (now >= m.wanderAt) {
      m.wanderAt = now + rand(2, 6);
      m.wx = m.sx + rand(-WANDER_R, WANDER_R); m.wz = m.sz + rand(-WANDER_R, WANDER_R);
    }
    const dx = m.wx - m.x, dz = m.wz - m.z, dist = Math.hypot(dx, dz);
    if (dist > 0.5) { mx = dx / dist; mz = dz / dist; speed *= leash > 12 ? 1.5 : 0.4; }
  }

  // a melee swing: the monster plants its feet, and the hit lands after the wind-up if the target is still close
  if (m.swing) {
    speed = 0;
    if (now >= m.swing.at) {
      const p = players.get(m.swing.pid);
      if (p && Math.hypot(p.x - m.x, p.z - m.z) < m.r + 1.5 && p.y < m.r * 2 + 0.2) hurtPlayer(p, m, false);
      m.swing = null;
    }
  }

  m.x += (mx * speed + m.kx) * dt;
  m.z += (mz * speed + m.kz) * dt;
  m.kx *= damp; m.kz *= damp;
  clampWorld(m, m.r);
  // Safe regions eject monsters rather than stop them at the edge: one that got further in than a tick of travel - by a
  // knockback, a shove from its neighbours or a bad home - would otherwise stand there as a free punching bag.
  pushOutOfSafe(map, m, m.r + 0.5);

  for (const p of players.values()) {
    if (p.dead) continue;
    const dx = p.x - m.x, dz = p.z - m.z, dist = Math.hypot(dx, dz) || 0.001;
    if (dist > m.r + 1.1 || p.y > m.r * 2 + 0.2) continue;
    if (now < p.dashUntil) {
      const key = `${p.id}:${p.dashSeq}`;
      if (m.dashHit !== key) {
        m.dashHit = key;
        damageMob(m, physical(p, 3, m), -dx / dist, -dz / dist, 14, p);
        if (m.dead) return;
      }
    } else if (now >= m.hitAt && !m.swing) {
      m.hitAt = now + 1.2;
      m.swing = { at: now + ATTACK_WINDUP, pid: p.id };
      emit({ k: 'atk', id: m.id }, m.x, m.z);
    }
  }
}

function separateMobs() {
  const active = mobs.filter((m) => !m.dead && m.target), shoved = new Set();
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i], b = active[j];
      const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz) || 0.001, min = a.r + b.r;
      if (d < min) {
        const push = (min - d) / 2 / d;
        a.x -= dx * push; a.z -= dz * push;
        b.x += dx * push; b.z += dz * push;
        shoved.add(a).add(b);
      }
    }
  }
  for (const m of shoved) pushOutOfSafe(map, m, m.r + 0.5);
}

function tick() {
  now = performance.now() / 1000;
  const dt = TICK;

  for (const p of players.values()) {
    if (p.dead && now >= p.deadUntil) respawnPlayer(p);
    p.safe = regions.isSafe(p.x, p.z);   // once per tick: monsters neither target nor follow a player in a safe region
    if (p.dead) continue;
    refresh(p);   // buffs come and go
    // regeneration: fast in a safe region, slow in the field, and much faster while sitting down to rest
    const resting = p.sit && now - p.hurtAt > 2;
    if (p.safe) p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.2 * dt);
    else if (resting) p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.05 * dt);
    else if (now - p.hurtAt > 6) p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.012 * dt);
    p.mp = Math.min(p.maxMp, p.mp + p.maxMp * (p.safe ? 0.08 : resting ? 0.06 : 0.015) * dt);
  }

  for (const m of mobs) updateMob(m, dt);
  separateMobs();

  // arrows and bolts home in on the monster they were loosed at
  bullets = bullets.filter((b) => {
    const m = mobById.get(b.target), p = players.get(b.owner);
    b.life -= dt;
    if (!m || m.dead || !p || b.life <= 0) return false;
    const dx = m.x - b.x, dz = m.z - b.z, d = Math.hypot(dx, dz) || 0.001, step = b.speed * dt;
    if (d <= step + m.r) {
      damageMob(m, b.hit, dx / d, dz / d, 4, p);
      if (!b.hit.miss) applyEffects(m, b, p);
      return false;
    }
    b.x += dx / d * step; b.z += dz / d * step;
    return true;
  });

  // area skills land a moment after they were cast
  blasts = blasts.filter((b) => {
    if (now < b.at) return true;
    emit({ k: 'boom', x: r2(b.x), z: r2(b.z), r: b.radius }, b.x, b.z);
    const p = players.get(b.owner);
    if (p) {
      for (const m of mobs) {
        if (m.dead) continue;
        const dx = m.x - b.x, dz = m.z - b.z, d = Math.hypot(dx, dz) || 1;
        if (d < b.radius + m.r) damageMob(m, (b.phys ? physical : magical)(p, b.power, m), dx / d, dz / d, 10, p);
      }
    }
    return false;
  });

  orbs = orbs.filter((o) => {
    const ox = o.x, oz = o.z;
    o.x += o.vx * dt; o.z += o.vz * dt;
    o.life -= dt;
    if (o.life <= 0 || regions.isSafe(o.x, o.z)) return false;
    for (const p of players.values()) {
      if (!p.dead && p.y < 1.4 && now >= p.dashUntil && segDist2(p.x, p.z, ox, oz, o.x, o.z) < 0.6) {
        hurtPlayer(p, o.from, true);
        return false;
      }
    }
    return true;
  });

  gems = gems.filter((g) => {
    if (now >= g.until) return false;
    for (const p of players.values()) {
      if (!p.dead && Math.hypot(p.x - g.x, p.z - g.z) < 1.6) {
        p.gold += g.gold;
        p.events.push({ k: 'gem', gold: g.gold });
        return false;
      }
    }
    return true;
  });

  // a closed chest opens for the first player who walks up to it, then refills after a while
  for (const c of chests) {
    if (now < c.openUntil) continue;
    for (const p of players.values()) {
      if (p.dead || Math.hypot(p.x - c.x, p.z - c.z) > CHEST_REACH) continue;
      const gold = Math.round(c.gold * rand(0.8, 1.3));
      p.gold += gold;
      p.events.push({ k: 'chest', gold });
      emit({ k: 'open', i: c.i }, c.x, c.z);
      c.openUntil = now + c.respawn;
      break;
    }
  }

  for (const p of players.values()) {
    const near = (o) => Math.abs(o.x - p.x) < VIEW_R && Math.abs(o.z - p.z) < VIEW_R;
    const snap = {
      t: 's',
      n: players.size,
      me: {
        hp: Math.ceil(p.hp), maxHp: p.maxHp, mp: Math.floor(p.mp), maxMp: p.maxMp, xp: p.xp, sp: p.sp, level: p.level, gold: p.gold,
        weapon: p.weapon, cls: p.cls, skills: p.skills, dead: p.dead ? 1 : 0,
        buffs: Object.entries(p.buffs).filter(([, b]) => now < b.until).map(([stat, b]) => [stat, Math.ceil(b.until - now), b.mult]),
      },
      p: [], m: [], g: [],
      c: chests.filter((c) => now < c.openUntil && near(c)).map((c) => c.i),   // chests that currently stand open
      e: p.events,
    };
    for (const q of players.values()) {
      if (q !== p && near(q)) {
        snap.p.push([q.id, r2(q.x), r2(q.y), r2(q.z), r2(q.yaw), q.speed, Math.ceil(q.hp), q.maxHp, q.level, q.dead ? 1 : 0, q.sit ? 1 : 0, CLASS_KEYS.indexOf(q.cls)]);
      }
    }
    for (const m of mobs) {
      if (m.dead || !near(m)) continue;
      const flags = (now < m.stunUntil ? 1 : 0) | (now < m.sleepUntil ? 2 : 0) | (now < m.slowUntil ? 4 : 0);
      snap.m.push([m.id, m.ti, m.lvl, r2(m.x), r2(m.z), r2(Math.max(0, m.hp)), m.maxHp, flags]);
    }
    for (const g of gems) if (near(g)) snap.g.push([g.id, r2(g.x), r2(g.z)]);
    send(p.ws, snap);
    p.events = [];
  }
}

// ---------------------------------------------------------------- networking

const wss = new WebSocketServer({ server, maxPayload: 2048 });   // a join that carries a 256-character editor token fits

// What each kind of skill does once its cost and cooldown have been checked. Returns false to refuse the cast.
const SKILL_EFFECTS = {
  strike(p, s, R, m) {
    if (!m || m.dead) return false;
    const dx = m.x - p.x, dz = m.z - p.z, d = Math.hypot(dx, dz) || 0.001;
    if (d > CLASSES[p.cls].reach + m.r + 1.2) return false;
    const hit = physical(p, s.power[R], m);
    damageMob(m, hit, dx / d, dz / d, 7, p);
    if (!hit.miss) applyEffects(m, { stun: s.stun?.[R], dot: s.dot && mitigate(s.dot[R] * p.st.pAtk / 2, m.pDef), dotDur: s.dotDur }, p);
  },
  shot(p, s, R, m) { return SKILL_EFFECTS.bolt(p, s, R, m); },
  bolt(p, s, R, m) {
    if (!m || m.dead || Math.hypot(m.x - p.x, m.z - p.z) > s.range + 3) return false;   // a little slack for lag
    bullets.push({
      x: p.x, z: p.z, target: m.id, life: 2.5, owner: p.id, speed: s.kind === 'shot' ? 42 : 34,
      hit: (s.kind === 'shot' ? physical : magical)(p, s.power[R], m),
      stun: s.stun?.[R], slow: s.slow?.[R], slowDur: s.slowDur,
    });
  },
  sleep(p, s, R, m) {
    if (!m || m.dead || Math.hypot(m.x - p.x, m.z - p.z) > s.range + 3) return false;
    applyEffects(m, { sleep: s.dur[R] }, p);
    if (!m.target) m.target = p.id;
  },
  ground(p, s, R, m, msg) {
    let dx = num(msg.x) - p.x, dz = num(msg.z) - p.z;
    const d = Math.hypot(dx, dz);
    if (d > s.range) { dx *= s.range / d; dz *= s.range / d; }
    const x = p.x + dx, z = p.z + dz;
    blasts.push({ at: now + s.delay, x, z, owner: p.id, radius: s.radius, power: s.power[R], phys: !!s.phys });
    msg.x = x; msg.z = z;   // the clamped point is what everyone sees
  },
  heal(p, s, R) {
    for (const q of s.radius ? players.values() : [p]) {
      if (q.dead || Math.hypot(q.x - p.x, q.z - p.z) > (s.radius || 0)) continue;
      const amount = Math.round(s.power[R] * (0.4 + 0.6 * p.st.mAtk / 24));   // healing grows with M.Atk
      q.hp = Math.min(q.maxHp, q.hp + amount);
      q.events.push({ k: 'healed', n: amount });
    }
  },
  buff(p, s, R) {
    for (const q of s.radius ? players.values() : [p]) {
      if (q.dead || Math.hypot(q.x - p.x, q.z - p.z) > (s.radius || 0)) continue;
      q.buffs[s.stat] = { mult: s.mult[R], until: now + s.dur };
    }
  },
  taunt(p, s) {
    for (const m of mobs) {
      if (!m.dead && m.type !== 'boss' && Math.hypot(m.x - p.x, m.z - p.z) < s.radius + m.r) m.target = p.id;
    }
  },
  dash(p) {
    p.dashUntil = now + 0.25;
    p.dashSeq++;
  },
  revive(p, s) {
    for (const q of players.values()) {
      if (!q.dead || Math.hypot(q.x - p.x, q.z - p.z) > s.radius) continue;
      q.dead = false;
      q.hp = q.maxHp * 0.5;
      q.invulnUntil = now + 2;
      q.events.push({ k: 'revived' });
    }
  },
};

const handlers = {
  m(p, msg) {   // movement (client-side, sanity-checked here)
    if (p.dead) return;
    const x = num(msg.x), z = num(msg.z);
    const elapsed = Math.min(1, now - p.lastMoveAt);
    const over = Math.hypot(x - p.x, z - p.z) - 36 * elapsed;   // units beyond the speed limit; 3 are always fine
    if (over > (now < p.graceUntil ? p.slack : 3)) {
      p.events.push({ k: 'tp', x: r2(p.x), z: r2(p.z) });
      p.lastMoveAt = now;
      // The client is put back, and may be pushed out of scenery from there too. But a new grace starts only when the
      // last one has run out: a refusal that always renewed it would buy 40 more units with every message.
      if (now >= p.graceUntil) grace(p);
      return;
    }
    if (over > 3) p.slack -= over - 3;   // what the grace paid for is spent; the slack never gets below 3
    p.x = x; p.z = z;
    p.y = Math.max(0, Math.min(8, num(msg.y)));
    p.yaw = num(msg.yaw);
    p.speed = msg.s ? 9 : 0;
    p.sit = !!msg.st;
    p.lastMoveAt = now;
    clampWorld(p, 1);
  },
  a(p, msg) {   // auto-attack: one hit at the selected monster with whatever the class wields
    const m = mobById.get(msg.id), c = CLASSES[p.cls];
    if (p.dead || now < p.swingAt || !m || m.dead) return;
    const dx = m.x - p.x, dz = m.z - p.z, d = Math.hypot(dx, dz) || 0.001;
    if (d > c.reach + m.r + 1.2) return;   // out of reach (with a little slack for lag)
    p.swingAt = now + p.st.atkCd * 0.85;
    const kind = [0, 1, 2].includes(msg.c) ? msg.c : 2;   // which of the three swing animations to show
    emit({ k: 'swing', o: p.id, dx: r2(dx / d), dz: r2(dz / d), c: kind }, p.x, p.z);
    if (c.ranged) {
      bullets.push({ x: p.x, z: p.z, target: m.id, life: 2.5, owner: p.id, speed: 42, hit: physical(p, 2, m) });
      emit({ k: 'shot', o: p.id, id: m.id, x: r2(p.x), z: r2(p.z), fx: 'arrow' }, p.x, p.z);
    } else {
      damageMob(m, physical(p, 2, m), dx / d, dz / d, 5, p);
    }
  },
  k(p, msg) {   // started casting: only tells nearby players to play the animation
    const id = String(msg.s), s = own(SKILLS, id);
    if (p.dead || now < p.castAt || !s || !p.skills[id]) return;
    p.castAt = now + 0.3;
    emit({ k: 'cast', o: p.id, s: id, d: r2(castTime(s, p.st)) }, p.x, p.z);
  },
  sk(p, msg) {   // use a skill
    const id = String(msg.s), s = own(SKILLS, id), rank = own(p.skills, id) | 0;
    if (p.dead || !s || !rank || s.kind === 'passive' || !classLine(p.cls).includes(s.cls)) return;
    if (now < (p.cds[id] || 0) || p.mp < s.mp) return;
    const m = mobById.get(msg.tid);
    if (SKILL_EFFECTS[s.kind](p, s, rank - 1, m, msg) === false) return;
    p.mp -= s.mp;
    p.sit = false;
    p.cds[id] = now + Math.max(s.cd, castTime(s, p.st) * 0.85, 0.3) - 0.1;
    emit({ k: 'skill', o: p.id, s: id, tid: m ? m.id : 0, x: r2(num(msg.x)), z: r2(num(msg.z)) }, p.x, p.z);
  },
  learn(p, msg) {   // buy the next rank of a skill from a Sage
    const id = String(msg.s), s = own(SKILLS, id), rank = own(p.skills, id) | 0;
    if (p.dead || !s || !nearNpc(map, p, 'sage', SHOP_RANGE) || !classLine(p.cls).includes(s.cls)) return;
    if (p.level < s.lvl || rank >= s.sp.length || p.sp < s.sp[rank]) return;
    p.sp -= s.sp[rank];
    p.skills[id] = rank + 1;
    refresh(p);
    p.events.push({ k: 'learned', s: id, rank: rank + 1 });
  },
  prof(p, msg) {   // choose a profession at a Sage
    const target = String(msg.cls), c = own(CLASSES, target);
    if (p.dead || !c || c.base !== p.cls || p.level < PROFESSION_LEVEL || !nearNpc(map, p, 'sage', SHOP_RANGE)) return;
    p.cls = target;
    grantFree(p);
    refresh(p);
    p.hp = p.maxHp;
    p.mp = p.maxMp;
    p.events.push({ k: 'prof', cls: target });
    emit({ k: 'lvlfx', x: r2(p.x), z: r2(p.z) }, p.x, p.z);
    broadcast({ t: 'c', sys: 1, m: `${p.name} is now a ${c.name}` });
  },
  b(p) {        // buy a weapon upgrade from a blacksmith
    const cost = upgradeCost(p.weapon);
    if (p.dead || !nearNpc(map, p, 'blacksmith', SHOP_RANGE) || p.gold < cost) return;
    p.gold -= cost;
    p.weapon++;
    refresh(p);
    p.events.push({ k: 'up', weapon: p.weapon });
  },
  c(p, msg) {   // chat
    const text = String(msg.m || '').trim().slice(0, 140);
    if (!text || now < p.chatAt) return;
    p.chatAt = now + 0.5;
    broadcast({ t: 'c', n: p.name, m: text });
  },
};

// A play-test character made up by the editor: any class at any level, with every skill of that level at its top rank.
function testCharacter(test) {
  const level = Math.max(1, Math.min(40, Math.round(num(test.lvl))));
  // an own key, not a truthy lookup: "constructor" is not a class
  const cls = typeof test.cls === 'string' && Object.hasOwn(CLASSES, test.cls) ? test.cls : START_CLASSES[0];
  const skills = {};
  for (const id of skillsFor(cls)) if (SKILLS[id].lvl <= level) skills[id] = SKILLS[id].sp.length;
  return { cls, level, xp: 0, skills, weapon: Math.min(10, 1 + Math.floor(level / 4)) };
}

// Where a joining player appears: the point a trusted client names, else somewhere in the start disc.
function joinPoint(at) {
  if (Array.isArray(at)) {
    const spot = { x: num(at[0]), z: num(at[1]) };
    clampWorld(spot, 1);
    if (!isBlocked(map, spot.x, spot.z)) return spot;
  }
  return startPoint(map);
}

function leave(p) {
  persist(p);
  players.delete(p.id);
  sendRoster();
  broadcast({ t: 'c', sys: 1, m: `${p.name} left` });
}

// Ends a session from outside its own socket. `gone` makes that socket's listeners return at once, so its later close
// neither saves the stale character a second time nor announces a second "left".
function dropSession(old) {
  old.gone = true;
  leave(old);
  old.ws.close();
}

// The first message of a socket. Returns the new player, or null when the client has to load the map again first.
// `conn` is what the upgrade request said about the socket: { address, trusted }.
function join(ws, msg, conn) {
  if (msg.rev !== rev) { send(ws, { t: 'map', rev }); return null; }

  // Trusted = the same check as saving. Without a token it was settled by where the socket came from; with one, by the join.
  let trusted = conn.trusted;
  if (TOKEN_MODE) {
    const given = String(msg.editorToken ?? '');
    trusted = tokenOk(given);
    if (!trusted && given) tokenFailure(conn.address);   // counted, and the join goes on as anybody's
  }
  // only the editor may choose where a cat appears or play a made-up character; from anyone else both are ignored
  const test = trusted && msg.test && typeof msg.test === 'object' && !Array.isArray(msg.test) ? msg.test : null;
  const at = !trusted ? null : test ? test.at : msg.at;

  const name = String(msg.name || '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Cat';
  // a play-test has no token: the designer's real character is neither read nor written, and a game tab of the same
  // browser is not its duplicate
  const token = test ? '' : String(msg.token || '').slice(0, 64);
  let data = {}, keeps = false;
  if (test) data = testCharacter(test);
  else if (token) {
    // A reloading client can be back before its old socket has closed. That session ends here, saved, or the newcomer
    // would be its duplicate. A rejoin that names its position (after a map save) takes over even from a live socket,
    // but only from a session of an OLDER map revision: that is the tab's own stale session, whereas a session that
    // already joined this revision is a second tab of the same browser and keeps playing.
    for (const old of [...players.values()]) {
      if (old.token === token && (old.ws.readyState !== 1 || (Array.isArray(at) && old.rev !== rev))) dropSession(old);
    }
    // a second tab with the same token plays as an unsaved guest
    keeps = ![...players.values()].some((q) => q.token === token);
    if (keeps) data = own(saved, token) || {};
  }
  const level = data.level || 1;
  // the class picked in the menu only counts for characters that do not have one yet
  const cls = Object.hasOwn(CLASSES, data.cls) ? data.cls : START_CLASSES.includes(msg.cls) ? msg.cls : START_CLASSES[0];
  const spot = joinPoint(at);
  const p = {
    id: nextId++, ws, token, persist: keeps, name, cls, rev,   // rev: the map revision this session joined under
    x: spot.x, y: 0, z: spot.z, yaw: 0, speed: 0,
    level, xp: Math.min(data.xp || 0, xpNext(level) - 1), sp: data.sp || 0, skills: { ...(data.skills || {}) },
    gold: data.gold || 0, weapon: data.weapon || 1,
    hp: Infinity, mp: Infinity, buffs: {}, cds: {}, sit: false, dead: false, deadUntil: 0,
    castAt: 0, swingAt: 0, dashUntil: 0, dashSeq: 0, invulnUntil: 0, hurtAt: -99, chatAt: 0,
    lastMoveAt: now, graceUntil: now + GRACE, slack: GRACE_SLACK, safe: false, god: !!test?.god, gone: false, events: [],
  };
  grantFree(p);
  refresh(p);   // also brings health and mana down to their maximum
  players.set(p.id, p);
  const hello = { t: 'w', id: p.id, x: r2(p.x), z: r2(p.z), rev };
  if (test) hello.test = { god: p.god, speed: test.speed === 2 ? 2 : 1 };   // the client moves itself: it applies the speed
  send(ws, hello);
  sendRoster();
  broadcast({ t: 'c', sys: 1, m: `${p.name} joined the world` });
  return p;
}

wss.on('connection', (ws, req) => {
  let p = null;
  // WebSockets ignore the same-origin policy, so here the Origin rule is what keeps a foreign page out.
  const conn = { address: req.socket.remoteAddress, trusted: EDITOR && !TOKEN_MODE && localRequest(req) && originOk(req) };
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {   // nothing a client sends may take the process down
      if (!msg || typeof msg !== 'object' || p?.gone) return;
      if (!p) {
        if (msg.t === 'join') p = join(ws, msg, conn);
      } else if (Object.hasOwn(handlers, msg.t)) handlers[msg.t](p, msg);
    } catch (err) {
      console.error('message failed:', err);
    }
  });
  ws.on('close', () => {
    try {
      if (p && !p.gone) leave(p);
    } catch (err) {
      console.error('close failed:', err);
    }
  });
  ws.on('error', () => ws.close());
});

// ---------------------------------------------------------------- start-up

try { fs.unlinkSync(`${MAP_FILE}.tmp`); } catch { /* no save was cut short */ }   // the only temp file the server ever writes
scanAssets();
applyMap(loadMap());

setInterval(tick, 1000 * TICK);
setInterval(flush, 30000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush(); process.exit(0); });

server.listen(PORT, () => {
  const { port } = server.address();
  console.log(`HyperCat MMO: http://localhost:${port}`);
  if (EDITOR) console.log(`MAP EDITOR ON (${TOKEN_MODE ? 'token' : 'local only'}) http://localhost:${port}/editor.html`);
});
