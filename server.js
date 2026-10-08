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
  PVP_FLAG, PVP_DAMAGE, KARMA_DEATH, CAT_R, karmaGain, karmaBurn, PVP_PEACE, PVP_FLAGGED, PVP_OUTLAW,
  TIERS, WEAPON_FAMILIES, weaponFamily, tierForLevel,
  ITEMS, itemOf, EQUIP_SLOTS, SHOP, POTION_CD, STARTER_KIT, KNIGHT_SHIELD, stackMax, sellPrice, heldFamily, fightStyle, equipError, wearItem, roomFor, addItem, takeItem,
  cleanBag, cleanEquip, lookCode, rollLoot, chestLoot, cleanBar, defaultBar, barAdd,
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
const LIBRARY_DIR = path.join(path.dirname(MAP_FILE), 'library');
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

// The checks of a request that only the editor may make - a save, and everything about the map library -, in this
// order. -> true, or false when the request has been answered.
function editorRequest(req, res) {
  const refuse = (status, error, headers) => { json(res, status, { ok: false, error }, headers); return false; };
  if (!EDITOR) return refuse(403, 'editor-off');
  if (TOKEN_MODE) {
    // the token comes first and a correct one always passes; the Origin is not looked at (a proxy rewrites Host, and a
    // token is not a credential the browser attaches by itself)
    if (!tokenOk(req.headers['x-editor-token'])) {
      return tokenFailure(req.socket.remoteAddress) ? refuse(429, 'rate', { 'Retry-After': 60 }) : refuse(401, 'token');
    }
  } else if (!localRequest(req)) return refuse(403, 'not-local');
  if (req.headers['x-editor'] !== '1') return refuse(403, 'header');   // a custom header: no plain form can send it
  return true;
}
// ... and of one that carries a map. Nothing of the body is read before the last of them has passed.
function mapRequest(req, res) {
  const refuse = (status, error, headers) => { json(res, status, { ok: false, error }, headers); return false; };
  if (!editorRequest(req, res)) return false;
  if (!TOKEN_MODE && !originOk(req)) return refuse(403, 'origin');
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' || req.headers['content-encoding'] !== undefined) return refuse(415, 'content-type');
  if (Number(req.headers['content-length']) > LIMITS.bodyBytes) return refuse(413, 'too-large', { Connection: 'close' });
  return true;
}

function postMap(req, res) {
  if (!mapRequest(req, res)) return;
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

// The map a request carries: { next, canonical, text, issues } - or { refused: [status, body] } when its bytes are
// not a map the game can load. The text is the server's own canonical one, never the bytes of the request.
function readMap(body) {
  const refused = (status, error, more) => ({ refused: [status, { ok: false, error, ...more }] });
  let file;
  try { file = JSON.parse(UTF8.decode(body)); } catch { return refused(400, 'bad-json'); }
  if (typeof file !== 'object' || file === null || Array.isArray(file)) return refused(400, 'bad-json');

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
  if (errors.length) return refused(422, 'invalid', { issues: errors.slice(0, 50) });
  const canonical = serialize(next);
  return { next, canonical, text: stringifyMap(canonical), issues };
}

// From the bytes of a request to its answer, [status, body, headers]. One synchronous function, so saves cannot interleave.
function saveMap(body, baseRev) {
  const refuse = (status, error, more, headers) => [status, { ok: false, error, ...more }, headers];
  const read = readMap(body);
  if (read.refused) return read.refused;
  const { next, canonical, text, issues } = read;
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

// Atomic: the text goes into a temp file beside the file, reaches the disk, and replaces the file in one rename.
function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* nothing to close */ }
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    throw err;
  }
}
const writeMapFile = (data) => writeFileAtomic(MAP_FILE, data);

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

// ---------------------------------------------------------------- the map library

// Named copies of a map, kept beside it in library/ for the editor's Maps menu: a version to go back to, a variant to
// compare with. <id>.json holds a map exactly as a save writes it, so a library map is also a file to import, and a
// map file put into the folder under such a name is a library map. Nothing here touches the map the game runs: the
// editor loads a library map as unsaved work, and it goes live only when it is saved.
const LIBRARY_ID = /^[a-z0-9][a-z0-9-]{0,47}$/, LIBRARY_MAX = 100;
const libraryFile = (id) => path.join(LIBRARY_DIR, `${id}.json`);
const libraryInfo = new Map();   // id -> { key, info }: a file is read again only when its time or its size changed

// What the library holds, newest first: { id, name, at, objects, spawns, rev }. `rev` is the revision the file would
// have as the live map, so the editor can tell which entry is the map the game runs.
function listLibrary() {
  let entries;
  try { entries = fs.readdirSync(LIBRARY_DIR, { withFileTypes: true }); } catch { return []; }
  const maps = [], size = (list) => (Array.isArray(list) ? list.length : 0);
  for (const entry of entries) {
    const id = entry.name.slice(0, -5);
    if (!entry.isFile() || !entry.name.endsWith('.json') || !LIBRARY_ID.test(id)) continue;
    try {
      const file = libraryFile(id), stat = fs.statSync(file), key = `${stat.mtimeMs}:${stat.size}`;
      let known = libraryInfo.get(id);
      if (known?.key !== key) {
        const text = fs.readFileSync(file, 'utf8'), raw = JSON.parse(text);
        known = { key, info: {
          id, name: String(raw?.name ?? '').slice(0, 64), at: Math.round(stat.mtimeMs), objects: size(raw?.objects), spawns: size(raw?.spawns),
          rev: sha256(text).digest('hex').slice(0, 16),
        } };
        libraryInfo.set(id, known);
      }
      maps.push(known.info);
    } catch { /* gone in between, or not JSON: not a map to offer */ }
  }
  return maps.sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
}

// GET /api/maps lists the library; GET /api/maps?id=<id> is one of its maps, as the file holds it.
function getLibrary(req, res) {
  if (!editorRequest(req, res)) return;
  const id = new URL(req.url, 'http://x').searchParams.get('id');
  if (id === null) { json(res, 200, { ok: true, maps: listLibrary() }); return; }
  if (!LIBRARY_ID.test(id)) { json(res, 400, { ok: false, error: 'bad-id' }); return; }
  let data;
  try { data = fs.readFileSync(libraryFile(id)); } catch { json(res, 404, { ok: false, error: 'not-found' }); return; }
  res.writeHead(200, { 'Content-Type': JSON_TYPE, 'Content-Length': data.length, 'Cache-Control': 'no-store' }).end(data);
}

// POST /api/maps?id=<id> keeps the map of the body in the library under that id. An id that is taken is refused
// unless the request says X-Overwrite: 1.
function postLibrary(req, res) {
  if (!mapRequest(req, res)) return;
  const id = new URL(req.url, 'http://x').searchParams.get('id') ?? '';
  if (!LIBRARY_ID.test(id)) { json(res, 400, { ok: false, error: 'bad-id' }, { Connection: 'close' }); return; }
  readBody(req, res, guarded(res, (body) => {
    const [status, answer] = keepMap(id, body, req.headers['x-overwrite'] === '1');
    json(res, status, answer);
  }));
}

function keepMap(id, body, overwrite) {
  const read = readMap(body);
  if (read.refused) return read.refused;
  const file = libraryFile(id), replaced = fs.existsSync(file);
  if (replaced && !overwrite) return [409, { ok: false, error: 'exists' }];
  if (!replaced && listLibrary().length >= LIBRARY_MAX) return [409, { ok: false, error: 'library-full' }];
  try {
    fs.mkdirSync(LIBRARY_DIR, { recursive: true });
    writeFileAtomic(file, read.text);
  } catch (err) {
    console.error('keeping a library map failed:', err);
    return [500, { ok: false, error: 'write-failed', code: err.code }];
  }
  return [200, { ok: true, id, replaced }];
}

// /api/* is matched by path and method before any file is looked for. No endpoint lists or serves backups.
const API = {
  '/api/map': { GET: getMap, POST: postMap },
  '/api/maps': { GET: getLibrary, POST: postLibrary },
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
  saved[p.token] = {
    name: p.name, cls: p.cls, level: p.level, xp: p.xp, sp: p.sp, skills: p.skills, gold: p.gold, weapon: p.weapon,
    inv: p.inv, equip: p.equip, bar: p.bar, pvp: p.pvp, pk: p.pk, karma: p.karma,
  };
  if (p.knightKit) saved[p.token].knightKit = 1;   // the Knight has had his shield (see grantShield)
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
const CLEAN = { kx: 0, kz: 0, target: 0, swing: null, cast: null, stunUntil: 0, sleepUntil: 0, slowUntil: 0, slowMult: 1, dot: null };
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

// A monster that would step onto ground nobody can walk on - water, lava, a lake - slides along its edge instead, as a
// player does. One that already stands there (its home was flooded by a map change) may walk out.
function keepAshore(m, fromX, fromZ) {
  if (!isBlocked(map, m.x, m.z) || isBlocked(map, fromX, fromZ)) return;
  if (!isBlocked(map, m.x, fromZ)) m.z = fromZ;
  else if (!isBlocked(map, fromX, m.z)) m.x = fromX;
  else { m.x = fromX; m.z = fromZ; }
}

// squared distance from point p to segment a-b
function segDist2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  const cx = ax + dx * t - px, cz = az + dz * t - pz;
  return cx * cx + cz * cz;
}

// ---------------------------------------------------------------- characters

// Recomputes every stat from class, level, weapon, passive skills, equipment and the buffs active right now.
function refresh(p) {
  const buffs = {};
  for (const [stat, b] of Object.entries(p.buffs)) if (now < b.until) buffs[stat] = b.mult;
  p.st = statsOf(p.cls, p.level, p.skills, p.weapon, buffs, p.equip);
  p.maxHp = p.st.maxHp;
  p.maxMp = p.st.maxMp;
  p.hp = Math.min(p.hp, p.maxHp);
  p.mp = Math.min(p.mp, p.maxMp);
}

// A skill the character has just learned goes onto its action bar, into the first empty slot. Only then: a skill the
// player has taken off the bar stays off. (A character that is still joining has no bar yet; it gets one right after.)
function slotSkill(p, id) {
  if (p.bar && barAdd(p.bar, id)) p.barDirty = true;
}
// Skills whose first rank costs nothing come with the class.
function grantFree(p) {
  for (const id of skillsFor(p.cls)) {
    const s = SKILLS[id];
    if (s.sp[0] === 0 && p.level >= s.lvl && !p.skills[id]) { p.skills[id] = 1; slotSkill(p, id); }
  }
}

// ---------------------------------------------------------------- items

// The bag or the equipment changed: the owner gets both with its next snapshot, and what is worn changes the stats.
function bagChanged(p) {
  p.bagDirty = true;
  refresh(p);
}
// An item request that cannot be done is answered with a line the client shows; nothing else happens.
function refuse(p, text) {
  p.events.push({ k: 'err', m: text });
}
// A Knight carries a shield: he is handed one with the profession, onto his off paw when that is free, else into the
// bag. Once per character (`knightKit` is saved with it), and a Knight from before shields were items - whose shield
// was part of his look - gets his the first time he comes back. One who owns a shield already needs none. With no
// free paw and a full bag the shield waits: the next time he enters the world it is tried again.
function grantShield(p) {
  if (p.cls !== 'knight' || p.knightKit) return;
  const has = (id) => ITEMS[id]?.kind === 'shield';
  if (!has(p.equip.offhand) && !p.inv.some((stack) => has(stack[0]))) {
    if (!p.equip.offhand && ITEMS[p.equip.weapon]?.hands !== 2) p.equip.offhand = KNIGHT_SHIELD;
    else if (!addItem(p.inv, KNIGHT_SHIELD, 1)) { refuse(p, `Your bag is full: your ${ITEMS[KNIGHT_SHIELD].name} waits until you come back with room for it`); return; }
    p.events.push({ k: 'gift', id: KNIGHT_SHIELD });
  }
  p.knightKit = 1;
  bagChanged(p);
}
// Loot goes straight into the bag; (x, z) is where the client floats its name up. What does not fit is lost, and said so.
function giveItem(p, id, n, x, z) {
  const got = addItem(p.inv, id, n);
  if (got) {
    p.bagDirty = true;
    p.events.push({ k: 'loot', id, n: got, x: r2(x), z: r2(z) });
  }
  if (got < n) refuse(p, `Your bag is full: ${ITEMS[id].name} was lost`);
}

// A physical attack on a monster, or on the stats of a cat (defOf): it can miss (Accuracy against Evasion) and can be a critical hit; P.Def reduces it.
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
    if (!q || q.dead) continue;
    addXp(q, m.xp);
    if (q.karma > 0) q.karma = Math.max(0, q.karma - karmaBurn(m.lvl));   // an outlaw works its karma off
  }
  // Loot is the killer's. The King is brought down together: everyone alive who wounded him gets a roll of their own.
  const looters = m.type === 'boss' ? [...m.dmgBy].map((id) => players.get(id)).filter((q) => q && !q.dead) : [p];
  for (const q of looters) for (const [id, n] of rollLoot(m.type, m.lvl)) giveItem(q, id, n, m.x, m.z);
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
  p.sleepUntil = 0;   // any damage wakes a sleeping cat
  p.invulnUntil = now + 0.5;
  p.events.push({ k: 'hurt' });
  if (p.hp <= 0) die(p);
}

// A cat falls: to a monster, or to the cat `by`, whose blow is `ev`. Death costs experience, never a level - but not
// in a fight between cats, unless the one that fell is an outlaw. What the winner gets depends on how the loser stood:
// see the rules in shared.js.
function die(q, by = null, ev = {}) {
  const state = pvpState(q);
  q.hp = 0;
  q.dead = true;
  q.deadUntil = now + 6;
  const lost = by && state !== PVP_OUTLAW ? 0 : Math.min(q.xp, Math.round(xpNext(q.level) * DEATH_XP_LOSS));
  q.xp -= lost;
  q.buffs = {};
  Object.assign(q, { flagUntil: 0, stunUntil: 0, sleepUntil: 0, slowUntil: 0, dot: null });
  if (state === PVP_OUTLAW) q.karma = Math.max(0, q.karma - KARMA_DEATH);
  q.events.push(by ? { k: 'died', xp: lost, by: by.name } : { k: 'died', xp: lost });
  emit({ k: 'kill', ...ev, id: 0, x: r2(q.x), z: r2(q.z), ti: -1 }, q.x, q.z);
  if (!by) { broadcast({ t: 'c', sys: 1, m: `${q.name} was slain` }); return; }
  const murder = state === PVP_PEACE;
  if (murder) {
    by.pk++;
    by.karma += karmaGain(by.pk);
    by.flagUntil = 0;   // an outlaw now: red, not purple
  } else by.pvp++;
  by.events.push({ k: 'pvp', n: q.name, pk: murder ? 1 : 0 });
  broadcast({ t: 'c', sys: 1, m: `${q.name} was ${murder ? 'murdered' : 'defeated'} by ${by.name}` });
}

// ---------------------------------------------------------------- PvP (the rules are told in shared.js)

const isCat = (o) => o.ws !== undefined;                      // a player, as opposed to a monster
const foeOf = (id) => mobById.get(id) ?? players.get(id);     // ids come from one counter: an id names one or the other
const bodyR = (o) => (isCat(o) ? CAT_R : o.r);
const defOf = (o) => (isCat(o) ? o.st : o);                   // where its P.Def, M.Def and Evasion are
const pvpState = (p) => (p.karma > 0 ? PVP_OUTLAW : now < p.flagUntil ? PVP_FLAGGED : PVP_PEACE);
const held = (p) => now < p.stunUntil || now < p.sleepUntil;  // stunned or asleep: it can neither move nor act
const ccFlags = (o) => (now < o.stunUntil ? 1 : 0) | (now < o.sleepUntil ? 2 : 0) | (now < o.slowUntil ? 4 : 0);

// May p attack the cat q right now? A safe region shelters everyone in it, outlaws too, and nobody fights out of one.
// (A play-test cat that cannot be hurt cannot be fought either.)
function canFight(p, q) {
  if (q === p || p.dead || q.dead || q.god) return false;
  return !(regions.isSafe(p.x, p.z) || regions.isSafe(q.x, q.z));
}
// whether the monster or cat p names is nothing it may strike
const noFoe = (p, m) => !m || m.dead || (isCat(m) && !canFight(p, m));
// p has turned on q: that flags p, unless q is an outlaw
function engage(p, q) {
  if (q.karma <= 0) p.flagUntil = now + PVP_FLAG;
}

// One cat's attack landing on another. -> whether it did damage: a miss, a dodge and a blow that may not be struck
// (the target has reached a safe region since the arrow left) do none.
function strikePlayer(q, hit, p) {
  if (!canFight(p, q) || now < q.dashUntil || now < q.invulnUntil) return false;
  engage(p, q);
  if (hit.miss) { emit({ k: 'miss', id: q.id, o: p.id }, q.x, q.z); return false; }
  const dmg = hit.dmg * PVP_DAMAGE;
  q.hp -= dmg;
  q.hurtAt = now;
  q.sit = false;
  q.sleepUntil = 0;
  q.events.push({ k: 'hurt', o: p.id });
  const ev = { x: r2(q.x), z: r2(q.z), o: p.id, d: r2(dmg), c: hit.crit ? 1 : 0 };
  if (q.hp > 0) emit({ k: 'hit', id: q.id, ...ev }, q.x, q.z);
  else die(q, p, ev);
  return true;
}
// An attack of p landing on a monster or on a cat. -> whether it did damage.
function strike(m, hit, dx, dz, knock, p) {
  if (isCat(m)) return strikePlayer(m, hit, p);
  damageMob(m, hit, dx, dz, knock, p);
  return !hit.miss;
}

function respawnPlayer(p) {
  const spot = startPoint(map);
  p.x = spot.x; p.z = spot.z; p.y = 0;
  p.hp = p.maxHp;
  p.mp = p.maxMp;
  p.dead = false;
  p.invulnUntil = now + 3;   // nobody is struck down again the moment it stands up
  p.lastMoveAt = now;
  grace(p);
  p.events.push({ k: 'tp', x: r2(p.x), z: r2(p.z) });
}

// ---------------------------------------------------------------- simulation

// What a Skeleton Mage and the King throw. The Mage's fireball follows the cat it was thrown at, but it turns only so
// fast: a jump over it, a dash through it or a sharp step aside at the last moment lets it fly past, and it has burnt
// out before it comes round again. The King's ring of eight flies straight: one at his target, the rest around him.
const ORB_SPEED = 12, ORB_TURN = 2.2, ORB_LIFE = 3.5, KING_ORB_SPEED = 10;
function throwOrbs(m, t) {
  if (!t || t.dead || t.safe) return;
  const king = m.type === 'boss', aim = Math.atan2(t.z - m.z, t.x - m.x), shots = king ? 8 : 1, speed = king ? KING_ORB_SPEED : ORB_SPEED;
  for (let i = 0; i < shots; i++) {
    const a = aim + i * Math.PI * 2 / shots, ox = Math.cos(a), oz = Math.sin(a);
    const o = { id: nextId++, x: m.x + ox * m.r, z: m.z + oz * m.r, vx: ox * speed, vz: oz * speed, speed, life: ORB_LIFE, from: m, kind: king ? 1 : 0, target: king ? 0 : t.id };
    orbs.push(o);
    emit({ k: 'orb', id: o.id, o: m.id, x: r2(o.x), z: r2(o.z), vx: r2(o.vx), vz: r2(o.vz) }, m.x, m.z);
  }
}

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
    m.cast = null;   // and the spell it was gathering is lost
    const fromX = m.x, fromZ = m.z;
    m.x += m.kx * dt; m.z += m.kz * dt;
    m.kx *= damp; m.kz *= damp;
    keepAshore(m, fromX, fromZ);
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
      if (m.fireT <= 0 && dist < 22 && !m.cast) {
        // the spell is gathered first, for as long as a blade takes to fall: everyone sees it coming (c: a cast)
        m.fireT = m.type === 'boss' ? 1.4 : 2.2;
        m.cast = { at: now + ATTACK_WINDUP, pid: t.id };
        emit({ k: 'atk', id: m.id, c: 1 }, m.x, m.z);
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

  // a spell: the Mage stands still to gather it (the King walks on), and it is thrown when the wind-up is over
  if (m.cast) {
    if (m.type === 'shooter') speed = 0;
    if (now >= m.cast.at) {
      throwOrbs(m, players.get(m.cast.pid));
      m.cast = null;
    }
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

  const fromX = m.x, fromZ = m.z;
  m.x += (mx * speed + m.kx) * dt;
  m.z += (mz * speed + m.kz) * dt;
  m.kx *= damp; m.kz *= damp;
  clampWorld(m, m.r);
  keepAshore(m, fromX, fromZ);
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
    if (p.dot && now >= p.dot.next) {   // a cat bleeds as a monster does, once a second
      const owner = players.get(p.dot.owner);
      if (!owner || now > p.dot.until) p.dot = null;
      else {
        p.dot.next += 1;
        strikePlayer(p, { dmg: p.dot.dps / PVP_DAMAGE, crit: false }, owner);   // the bleeding was worked out against this cat
      }
    }
  }

  for (const m of mobs) updateMob(m, dt);
  separateMobs();

  // arrows and bolts home in on the monster, or the cat, they were loosed at
  bullets = bullets.filter((b) => {
    const m = foeOf(b.target), p = players.get(b.owner);
    b.life -= dt;
    if (!m || m.dead || !p || b.life <= 0) return false;
    const dx = m.x - b.x, dz = m.z - b.z, d = Math.hypot(dx, dz) || 0.001, step = b.speed * dt;
    if (d <= step + bodyR(m)) {
      if (strike(m, b.hit, dx / d, dz / d, 4, p)) applyEffects(m, b, p);
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
      // An area skill never starts a fight: among cats it reaches only those who are in one already, and outlaws.
      for (const q of players.values()) {
        if (q === p || q.dead || pvpState(q) === PVP_PEACE) continue;
        if (Math.hypot(q.x - b.x, q.z - b.z) < b.radius + CAT_R) strikePlayer(q, (b.phys ? physical : magical)(p, b.power, q.st), p);
      }
    }
    return false;
  });

  orbs = orbs.filter((o) => {
    const ox = o.x, oz = o.z, t = o.target ? players.get(o.target) : null;
    if (t && !t.dead) {   // a fireball bends towards its cat, as fast as it can turn
      const want = Math.atan2(t.z - o.z, t.x - o.x), have = Math.atan2(o.vz, o.vx);
      const off = Math.atan2(Math.sin(want - have), Math.cos(want - have)), a = have + Math.max(-ORB_TURN * dt, Math.min(ORB_TURN * dt, off));
      o.vx = Math.cos(a) * o.speed; o.vz = Math.sin(a) * o.speed;
    }
    o.x += o.vx * dt; o.z += o.vz * dt;
    o.life -= dt;
    let hit = 0;
    if (o.life > 0 && !regions.isSafe(o.x, o.z)) {
      for (const p of players.values()) {
        if (!p.dead && p.y < 1.4 && now >= p.dashUntil && segDist2(p.x, p.z, ox, oz, o.x, o.z) < 0.6) {
          hurtPlayer(p, o.from, true);
          hit = 1;
          break;
        }
      }
      if (!hit) return true;
    }
    emit({ k: 'orbx', id: o.id, x: r2(o.x), z: r2(o.z), h: hit }, o.x, o.z);   // it burst on a cat (h), or burnt out
    return false;
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
      for (const [id, n] of chestLoot(c.gold, c.big)) giveItem(p, id, n, c.x, c.z);
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
        pvp: p.pvp, pk: p.pk, karma: p.karma, st: pvpState(p), cc: ccFlags(p), slow: now < p.slowUntil ? p.slowMult : 1,
        buffs: Object.entries(p.buffs).filter(([, b]) => now < b.until).map(([stat, b]) => [stat, Math.ceil(b.until - now), b.mult]),
      },
      p: [], m: [], g: [],
      o: orbs.filter(near).map((o) => [o.id, r2(o.x), r2(o.z), o.kind]),   // what the monsters have thrown: 0 a fireball, 1 the King's
      c: chests.filter((c) => now < c.openUntil && near(c)).map((c) => c.i),   // chests that currently stand open
      e: p.events,
    };
    if (p.bagDirty) {   // the bag and the equipment travel only when they changed
      snap.me.inv = p.inv;
      snap.me.eq = p.equip;
      p.bagDirty = false;
    }
    if (p.barDirty) {   // and so does the action bar
      snap.me.bar = p.bar;
      p.barDirty = false;
    }
    for (const q of players.values()) {
      if (q !== p && near(q)) {
        snap.p.push([q.id, r2(q.x), r2(q.y), r2(q.z), r2(q.yaw), q.speed, Math.ceil(q.hp), q.maxHp, q.level, q.dead ? 1 : 0, q.sit ? 1 : 0, CLASS_KEYS.indexOf(q.cls), lookCode(q.equip), pvpState(q), ccFlags(q)]);
      }
    }
    for (const m of mobs) {
      if (m.dead || !near(m)) continue;
      snap.m.push([m.id, m.ti, m.lvl, r2(m.x), r2(m.z), r2(Math.max(0, m.hp)), m.maxHp, ccFlags(m)]);
    }
    for (const g of gems) if (near(g)) snap.g.push([g.id, r2(g.x), r2(g.z)]);
    send(p.ws, snap);
    p.events = [];
  }
}

// ---------------------------------------------------------------- networking

const wss = new WebSocketServer({ server, maxPayload: 2048 });   // a join that carries a 256-character editor token fits

// What each kind of skill does once its cost and cooldown have been checked. Returns false to refuse the cast.
// `m` is the monster or the cat the skill was aimed at.
const SKILL_EFFECTS = {
  strike(p, s, R, m) {
    if (noFoe(p, m)) return false;
    const dx = m.x - p.x, dz = m.z - p.z, d = Math.hypot(dx, dz) || 0.001, foe = defOf(m);
    if (d > fightStyle(p.cls, heldFamily(p.cls, p.equip)).reach + bodyR(m) + 1.2) return false;
    if (!strike(m, physical(p, s.power[R], foe), dx / d, dz / d, 7, p)) return;
    applyEffects(m, { stun: s.stun?.[R], dot: s.dot && mitigate(s.dot[R] * p.st.pAtk / 2, foe.pDef), dotDur: s.dotDur }, p);
  },
  shot(p, s, R, m) { return SKILL_EFFECTS.bolt(p, s, R, m); },
  bolt(p, s, R, m) {
    if (noFoe(p, m) || Math.hypot(m.x - p.x, m.z - p.z) > s.range + 3) return false;   // a little slack for lag
    if (isCat(m)) engage(p, m);   // loosing it is the attack, wherever it lands
    bullets.push({
      x: p.x, z: p.z, target: m.id, life: 2.5, owner: p.id, speed: s.kind === 'shot' ? 42 : 34,
      hit: (s.kind === 'shot' ? physical : magical)(p, s.power[R], defOf(m)),
      stun: s.stun?.[R], slow: s.slow?.[R], slowDur: s.slowDur,
    });
  },
  sleep(p, s, R, m) {
    if (noFoe(p, m) || Math.hypot(m.x - p.x, m.z - p.z) > s.range + 3) return false;
    applyEffects(m, { sleep: s.dur[R] }, p);
    if (isCat(m)) engage(p, m);
    else if (!m.target) m.target = p.id;
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

const DEAD = 'You cannot do that while dead';
// The stack an item request means. It names the stack by its place in the bag AND by its item, so that a click which
// crossed another change of the bag on the wire can never sell, drink or destroy a different item. A request for a
// stack that is not there is dropped without an answer: the client's bag is simply a snapshot behind.
function stackOf(p, msg) {
  const stack = Number.isInteger(msg.i) ? p.inv[msg.i] : undefined;
  return stack && stack[0] === msg.id ? stack : null;
}

const handlers = {
  m(p, msg) {   // movement (client-side, sanity-checked here)
    if (p.dead) return;
    if (held(p)) { p.speed = 0; p.lastMoveAt = now; return; }   // stunned or asleep: it stays where it is
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
  a(p, msg) {   // auto-attack: one hit at the selected monster, or cat, with whatever is in the paw
    const m = foeOf(msg.id), c = fightStyle(p.cls, heldFamily(p.cls, p.equip));
    if (p.dead || held(p) || now < p.swingAt || noFoe(p, m)) return;
    const dx = m.x - p.x, dz = m.z - p.z, d = Math.hypot(dx, dz) || 0.001;
    if (d > c.reach + bodyR(m) + 1.2) return;   // out of reach (with a little slack for lag)
    p.swingAt = now + p.st.atkCd * 0.85;
    const kind = [0, 1, 2].includes(msg.c) ? msg.c : 2;   // which of the three swing animations to show
    emit({ k: 'swing', o: p.id, dx: r2(dx / d), dz: r2(dz / d), c: kind }, p.x, p.z);
    if (c.ranged) {
      if (isCat(m)) engage(p, m);
      bullets.push({ x: p.x, z: p.z, target: m.id, life: 2.5, owner: p.id, speed: 42, hit: physical(p, 2, defOf(m)) });
      emit({ k: 'shot', o: p.id, id: m.id, x: r2(p.x), z: r2(p.z), fx: 'arrow' }, p.x, p.z);
    } else {
      strike(m, physical(p, 2, defOf(m)), dx / d, dz / d, 5, p);
    }
  },
  k(p, msg) {   // started casting: only tells nearby players to play the animation
    const id = String(msg.s), s = own(SKILLS, id);
    if (p.dead || held(p) || now < p.castAt || !s || !p.skills[id]) return;
    p.castAt = now + 0.3;
    emit({ k: 'cast', o: p.id, s: id, d: r2(castTime(s, p.st)) }, p.x, p.z);
  },
  sk(p, msg) {   // use a skill
    const id = String(msg.s), s = own(SKILLS, id), rank = own(p.skills, id) | 0;
    if (p.dead || held(p) || !s || !rank || s.kind === 'passive' || !classLine(p.cls).includes(s.cls)) return;
    if (now < (p.cds[id] || 0) || p.mp < s.mp) return;
    const m = foeOf(msg.tid);
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
    if (!rank) slotSkill(p, id);
    refresh(p);
    p.events.push({ k: 'learned', s: id, rank: rank + 1 });
  },
  prof(p, msg) {   // choose a profession at a Sage
    const target = String(msg.cls), c = own(CLASSES, target);
    if (p.dead || !c || c.base !== p.cls || p.level < PROFESSION_LEVEL || !nearNpc(map, p, 'sage', SHOP_RANGE)) return;
    p.cls = target;
    grantFree(p);
    grantShield(p);
    bagChanged(p);   // the look and the stats follow the new profession
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
  eq(p, msg) {   // wear an item from the bag; what was in its slot, and what it pushes off the other paw, goes into the bag
    const stack = stackOf(p, msg);
    if (!stack) return;
    const err = (p.dead ? DEAD : equipError(p.cls, p.level, stack[0])) || wearItem(p.inv, p.equip, msg.i);
    if (err) { refuse(p, err); return; }
    bagChanged(p);
  },
  uneq(p, msg) {   // take a worn item off, into the bag
    const slot = EQUIP_SLOTS.includes(msg.slot) ? msg.slot : '', id = slot && p.equip[slot];
    if (!id) return;
    if (p.dead) { refuse(p, DEAD); return; }
    if (!addItem(p.inv, id, 1)) { refuse(p, 'Your bag is full'); return; }
    p.equip[slot] = null;
    bagChanged(p);
  },
  use(p, msg) {   // drink a potion
    const stack = stackOf(p, msg), it = stack && ITEMS[stack[0]];
    if (!stack) return;
    if (p.dead) { refuse(p, DEAD); return; }
    if (it.kind !== 'potion') { refuse(p, `${it.name} cannot be used`); return; }
    if (now < p.potionAt) { refuse(p, 'The potion is not ready yet'); return; }
    if (it.hp ? p.hp >= p.maxHp : p.mp >= p.maxMp) { refuse(p, `Your ${it.hp ? 'health' : 'mana'} is full`); return; }
    const hp = Math.min(p.maxHp, p.hp + (it.hp || 0)) - p.hp, mp = Math.min(p.maxMp, p.mp + (it.mp || 0)) - p.mp;
    p.hp += hp; p.mp += mp;
    p.potionAt = now + POTION_CD;
    takeItem(p.inv, msg.i, 1);
    p.bagDirty = true;
    p.events.push({ k: 'potion', id: stack[0], n: Math.round(hp || mp) });
  },
  buy(p, msg) {   // buy from a trader
    const id = msg.id, n = msg.n ?? 1;
    if (!itemOf(id) || !SHOP.includes(id) || !Number.isInteger(n) || n < 1 || n > stackMax(id)) return;
    if (p.dead) { refuse(p, DEAD); return; }
    if (!nearNpc(map, p, 'trader', SHOP_RANGE)) { refuse(p, 'The Trader is too far away'); return; }
    const cost = ITEMS[id].price * n;
    if (p.gold < cost) { refuse(p, 'Not enough gold'); return; }
    if (roomFor(p.inv, id, n) < n) { refuse(p, 'Your bag is full'); return; }
    p.gold -= cost;
    addItem(p.inv, id, n);
    p.bagDirty = true;
    p.events.push({ k: 'bought', id, n, gold: cost });
  },
  sell(p, msg) {   // sell from the bag to a trader, who pays a share of the price
    const stack = stackOf(p, msg), n = msg.n ?? 1;
    if (!stack || !Number.isInteger(n) || n < 1 || n > stack[1]) return;
    if (p.dead) { refuse(p, DEAD); return; }
    if (!nearNpc(map, p, 'trader', SHOP_RANGE)) { refuse(p, 'The Trader is too far away'); return; }
    const id = stack[0], gold = sellPrice(id) * n;
    takeItem(p.inv, msg.i, n);
    p.gold += gold;
    p.bagDirty = true;
    p.events.push({ k: 'sold', id, n, gold });
  },
  drop(p, msg) {   // throw an item away for good
    const stack = stackOf(p, msg), n = msg.n ?? stack?.[1];
    if (!stack || !Number.isInteger(n) || n < 1 || n > stack[1]) return;
    if (p.dead) { refuse(p, DEAD); return; }
    takeItem(p.inv, msg.i, n);
    p.bagDirty = true;
  },
  bar(p, msg) {   // arrange the action bar: all of its slots at once
    p.bar = cleanBar(msg.bar);
    // The owner shows its own arrangement at once and still gets the kept one back: what was not a skill or an item is
    // gone from it, and a skill the server slotted while this message was on its way is not lost from view.
    p.barDirty = true;
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

// A character a bot starts as (bots/run.mjs): a cat of some level that has what a cat of that level would have - the
// skills of its class, gear of its tier, a few potions and some gold. A profession needs its level; below that the bot
// starts in the base class. Asked for with the join, by a process on this machine only, and only for a token that has
// no character yet: from then on it is a character like any other, saved with whatever it makes of itself.
function botCharacter(start) {
  const level = Math.max(1, Math.min(40, Math.round(num(start.lvl)) || 1));
  let cls = typeof start.cls === 'string' && Object.hasOwn(CLASSES, start.cls) ? start.cls : START_CLASSES[0];
  if (CLASSES[cls].base && level < PROFESSION_LEVEL) cls = CLASSES[cls].base;
  const skills = {};
  for (const id of skillsFor(cls)) {
    const s = SKILLS[id];
    if (s.lvl <= level) skills[id] = Math.min(s.sp.length, 1 + Math.floor((level - s.lvl) / 8));   // a rank for every eight levels it has had the skill
  }
  const t = tierForLevel(level), tier = TIERS[t], below = TIERS[t - 1];
  const family = WEAPON_FAMILIES.includes(start.family) ? start.family : weaponFamily(cls);
  const equip = { weapon: `${tier.arms}_${family}`, head: `${tier.id}_head`, body: `${tier.id}_body` };
  if (below) Object.assign(equip, { hands: `${below.id}_hands`, feet: `${below.id}_feet` });
  return {
    cls, level, xp: 0, sp: 0, skills, gold: 40 * level, weapon: 1 + Math.floor(level / 5), equip,
    inv: [[level >= 10 ? 'hp_large' : 'hp_small', 5], ['mp_small', 3]],
  };
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
// `conn` is what the upgrade request said about the socket: { address, local, trusted }.
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
  let data = null, keeps = false;   // data: the saved character; null for one that has never played
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
    if (keeps) data = own(saved, token) || null;
    // a bot's first join brings the character it starts as (see botCharacter)
    if (keeps && !data && conn.local && msg.bot && typeof msg.bot === 'object' && !Array.isArray(msg.bot)) data = botCharacter(msg.bot);
  }
  // A character from before the game had items loads with an empty bag; only a new one gets the starter kit.
  const fresh = !data || !!test;
  data = data || {};
  const level = data.level || 1;
  // the class picked in the menu only counts for characters that do not have one yet
  const cls = Object.hasOwn(CLASSES, data.cls) ? data.cls : START_CLASSES.includes(msg.cls) ? msg.cls : START_CLASSES[0];
  const spot = joinPoint(at);
  const p = {
    id: nextId++, ws, token, persist: keeps, name, cls, rev,   // rev: the map revision this session joined under
    x: spot.x, y: 0, z: spot.z, yaw: 0, speed: 0,
    level, xp: Math.min(data.xp || 0, xpNext(level) - 1), sp: data.sp || 0, skills: { ...(data.skills || {}) },
    gold: data.gold || 0, weapon: data.weapon || 1,
    inv: cleanBag(fresh ? STARTER_KIT : data.inv), equip: cleanEquip(data.equip), bagDirty: true, potionAt: 0,
    bar: Array.isArray(data.bar) ? cleanBar(data.bar) : null, barDirty: true, knightKit: data.knightKit ? 1 : 0,
    hp: Infinity, mp: Infinity, buffs: {}, cds: {}, sit: false, dead: false, deadUntil: 0,
    castAt: 0, swingAt: 0, dashUntil: 0, dashSeq: 0, invulnUntil: 0, hurtAt: -99, chatAt: 0,
    // PvP: fights won, murders, the karma they left - and, never saved, how long the cat stays flagged
    pvp: data.pvp | 0, pk: data.pk | 0, karma: Math.max(0, data.karma | 0), flagUntil: 0,
    stunUntil: 0, sleepUntil: 0, slowUntil: 0, slowMult: 1, dot: null,   // what another cat's skills can do to it
    lastMoveAt: now, graceUntil: now + GRACE, slack: GRACE_SLACK, safe: false, god: !!test?.god, gone: false, events: [],
  };
  grantFree(p);
  // A character without a saved bar - a new one, or one from before the game had the bar - gets its skills and potions
  // laid out as the keys 1 - 8 and Q / E used to have them.
  if (!p.bar) p.bar = defaultBar(p.cls, p.skills, p.inv);
  grantShield(p);
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
  // local: the socket was opened by a program on this machine - not through a proxy, and not by a page, which always
  // names its Origin. That is what a bot's first join is asked.
  const conn = { address: req.socket.remoteAddress, local: localRequest(req) && req.headers.origin === undefined, trusted: EDITOR && !TOKEN_MODE && localRequest(req) && originOk(req) };
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
