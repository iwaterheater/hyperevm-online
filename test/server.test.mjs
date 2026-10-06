// The server as a whole (server.js), run as a child process: static files, the /api routes, who may save, the save itself
// with its backups, the hot swap, and what the map editor adds to the WebSocket protocol.
// Every test starts its own server on a free port (PORT=0) with a map file and a data directory in a temp folder, so
// nothing here touches port 8765, map/world.json or data/.
// The map is a FRESH bake (tools/bake-map.mjs), never the committed map: that one is edited by hand, and the checks
// below lean on bake facts - the point (100, 100) is walkable, the start disc lies in the town, there is a sage to remove.
// Run: node --test test/server.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { LIMITS, emptyMap, serialize, stringifyMap } from '../src/map/format.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hypercat-server-'));
const running = new Set();
test.after(async () => {
  await Promise.all([...running].map((s) => s.stop('SIGKILL')));
  fs.rmSync(DIR, { recursive: true, force: true });
});

const bake = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'bake-map.mjs'), '--out', path.join(DIR, 'baked.json')], { cwd: DIR, encoding: 'utf8' });
assert.equal(bake.status, 0, `the bake failed: ${bake.stderr}`);
const BAKED = fs.readFileSync(path.join(DIR, 'baked.json'), 'utf8');
const FILE = JSON.parse(BAKED);
const TOKEN = 'correct-horse-battery-staple-42!';   // 32 characters
const BACKUP = /^(world|session)-\d{8}-\d{6}-([0-9a-f]{16})\.json$/;

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, fn) => test(name, { timeout: 120000 }, fn);

// The baked map with one thing changed. Any JSON is fine for a request or for a start: the server writes its own text.
const renamed = (name) => BAKED.replace('"name": "Hypercat World"', `"name": ${JSON.stringify(name)}`);
const edited = (change) => { const file = JSON.parse(BAKED); change(file); return stringifyMap(file); };

// Starts `node server.js` in a folder of its own: <dir>/world.json (unless `map` is null) and <dir>/data.
// The environment is built from scratch, so an EDITOR or a NODE_ENV of the shell running the tests does not leak in.
function boot({ args = ['--editor'], env = {}, map = BAKED, setup } = {}) {
  const dir = fs.mkdtempSync(path.join(DIR, 'run-'));
  const s = { dir, mapFile: path.join(dir, 'world.json'), dataDir: path.join(dir, 'data'), backups: path.join(dir, 'backups'), port: 0, out: '' };
  if (map !== null) fs.writeFileSync(s.mapFile, map);
  setup?.(s);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), ...args], {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, PORT: '0', MAP_FILE: s.mapFile, DATA_DIR: s.dataDir, ...env },
  });
  running.add(s);
  let stdout = '';
  s.closed = new Promise((resolve) => child.on('close', (code) => { running.delete(s); resolve(code); }));
  s.ready = new Promise((resolve) => {
    child.stdout.on('data', (data) => {
      stdout += data;
      s.out += data;
      const line = /^HyperCat MMO: http:\/\/localhost:(\d+)$/m.exec(stdout);
      if (line && !s.port) { s.port = Number(line[1]); resolve(true); }
    });
    s.closed.then(() => resolve(false));
  });
  child.stderr.on('data', (data) => { s.out += data; });
  s.stop = (signal = 'SIGTERM') => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
    return s.closed;
  };
  return s;
}

// Runs fn(server) against a started server and stops it whatever happens. Resolves with the server, whose `out` then
// holds everything it printed.
async function withServer(options, fn) {
  const s = boot(options);
  try {
    assert.ok(await s.ready, `the server did not start:\n${s.out}`);
    await fn(s);
  } finally {
    await s.stop();
  }
  return s;
}

// A start that has to fail: resolves with the exit code and what was printed.
async function refusedStart(options) {
  const s = boot(options);
  if (await s.ready) {
    await s.stop();
    assert.fail(`the server started:\n${s.out}`);
  }
  return { ...s, code: await s.closed };
}

// One HTTP request on a connection of its own. Headers go out as given - Host and Origin included; a header set to
// undefined is left out. Resolves with { status, headers, body, json }.
function call(s, method, url, { headers = {}, body } = {}) {
  const sent = Object.fromEntries(Object.entries(headers).filter(([, v]) => v !== undefined));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: 'localhost', port: s.port, method, path: url, headers: sent, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: data, get json() { return JSON.parse(data.toString()); } });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
const get = (s, url, headers) => call(s, 'GET', url, { headers });
// A save as the editor's own page sends it; `headers` replace or remove single ones.
const save = (s, text, headers = {}) => call(s, 'POST', '/api/map', {
  headers: { 'Content-Type': 'application/json', 'X-Editor': '1', Origin: `http://localhost:${s.port}`, 'X-Base-Rev': '*', ...headers },
  body: text,
});
const revOf = async (s) => (await get(s, '/api/editor')).json.rev;

// Bytes on a socket, for what an HTTP client will not send. Resolves with everything the server answered before the
// connection closed.
function raw(s, ...parts) {
  return new Promise((resolve) => {
    const socket = net.connect(s.port, 'localhost');
    let answer = '';
    socket.setTimeout(30000, () => socket.destroy());
    socket.on('data', (data) => { answer += data; });
    socket.on('error', () => {});
    socket.on('close', () => resolve(answer));
    for (const part of parts) socket.write(part);
  });
}

// A WebSocket client that keeps what it receives. `origin` is the Origin header a browser would add (none when omitted).
function connect(s, origin) {
  const ws = new WebSocket(`ws://localhost:${s.port}`, origin ? { origin } : {});
  const inbox = [];
  let wake = () => {};
  ws.on('message', (data) => { inbox.push(JSON.parse(data)); wake(); });
  ws.on('error', () => {});
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  opened.catch(() => {});   // reported by the send() that waits for it, not as an unhandled rejection
  const closed = new Promise((resolve) => ws.once('close', resolve));
  return {
    ws, inbox, closed,
    async send(msg) {
      await opened;
      ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    },
    // the oldest message of type t (that `where` accepts) which has not been taken yet; waits for one
    async take(t, where = () => true, ms = 20000) {
      const until = Date.now() + ms;
      for (;;) {
        const i = inbox.findIndex((m) => m.t === t && where(m));
        if (i >= 0) return inbox.splice(i, 1)[0];
        const left = until - Date.now();
        assert.ok(left > 0, `no "${t}" message within ${ms} ms`);
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, left);
          wake = () => { clearTimeout(timer); resolve(); };
        });
      }
    },
    close() { ws.close(); return closed; },
  };
}
const local = (s) => `http://localhost:${s.port}`;
// Connects and sends a join for the map the server has now. An `origin` of null sends no Origin header.
async function join(s, msg = {}, origin = local(s)) {
  const c = connect(s, origin);
  await c.send({ t: 'join', name: 'Tester', cls: 'fighter', rev: await revOf(s), ...msg });
  return c;
}
const inStartDisc = (w) => Math.hypot(w.x - FILE.start.x, w.z - FILE.start.z) <= FILE.start.r + 0.01;
const savedPlayers = (s) => (fs.existsSync(path.join(s.dataDir, 'players.json')) ? JSON.parse(fs.readFileSync(path.join(s.dataDir, 'players.json'), 'utf8')) : {});

// ---------------------------------------------------------------- static files

check('static files: only the two pages, src/ and assets/ - whatever the path is dressed up as', () => withServer({}, async (s) => {
  // package.json and server.js exist right above src/, so these would be served by a whitelist that looks at the raw path
  for (const url of ['/src/..%2fdata/players.json', '/src/..%2fpackage.json', '/src/..%2Fserver.js', '/src/%2e%2e/package.json',
    '/assets/..%2f..%2fpackage.json', '/src/..%5cpackage.json', '/src%5cshared.js', '/src/shared.js%00', '/%E0%A4%A',
    '/map/world.json', '/data/players.json', '/package.json', '/server.js', '/tools/bake-map.mjs', '/test/server.test.mjs',
    '/docs/dev/map-editor-spec.md', '/.git', '/.gitignore', '/src', '/src/', '/src/map', '/index.html/', '/nothing.html']) {
    assert.equal((await get(s, url)).status, 404, url);
  }
  const page = await get(s, '/');
  assert.equal(page.status, 200);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  assert.ok(page.body.equals(fs.readFileSync(path.join(ROOT, 'index.html'))));
  const code = await get(s, '/src/shared.js');
  assert.equal(code.status, 200);
  assert.equal(code.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(code.headers['cache-control'], 'no-cache');
  assert.equal(code.headers['access-control-allow-origin'], undefined);
  // editor.html arrives with a later step: until then 404, afterwards 200 - never 403 or 500
  assert.ok([200, 404].includes((await get(s, '/editor.html')).status));

  const head = await call(s, 'HEAD', '/src/shared.js');
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(Number(head.headers['content-length']), code.body.length);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const refused = await call(s, method, '/src/shared.js');
    assert.equal(refused.status, 405, method);
    assert.equal(refused.headers.allow, 'GET, HEAD');
  }
}));

check('assets: cached for a day in the game, revalidated in editor mode', async () => {
  const name = fs.readdirSync(path.join(ROOT, 'assets', 'dungeon')).find((f) => f.endsWith('.glb'));
  await withServer({}, async (s) => {
    const first = await get(s, `/assets/dungeon/${name}`);
    assert.equal(first.status, 200);
    assert.equal(first.headers['content-type'], 'model/gltf-binary');
    assert.equal(first.headers['cache-control'], 'no-cache');
    assert.match(first.headers.etag, /^"\d+-[\d.]+"$/);
    const again = await get(s, `/assets/dungeon/${name}`, { 'If-None-Match': first.headers.etag });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);
    assert.equal((await get(s, `/assets/dungeon/${name}`, { 'If-None-Match': '"1-1"' })).status, 200);
  });
  await withServer({ args: [] }, async (s) => {
    const plain = await get(s, `/assets/dungeon/${name}`);
    assert.equal(plain.status, 200);
    assert.equal(plain.headers['cache-control'], 'public, max-age=86400');
    assert.equal(plain.headers.etag, undefined);
  });
});

// ---------------------------------------------------------------- reading the api

check('GET /api/map: the canonical text, with its revision as ETag and X-Map-Rev; 304 for a client that has it', () => withServer({}, async (s) => {
  const info = await get(s, '/api/editor');
  assert.equal(info.status, 200);
  assert.equal(info.headers['cache-control'], 'no-store');
  assert.deepEqual(info.json, { enabled: true, tokenRequired: false, canSave: true, rev: info.json.rev });
  const { rev } = info.json;
  assert.match(rev, /^[0-9a-f]{16}$/);

  const map = await get(s, '/api/map');
  assert.equal(map.status, 200);
  assert.equal(map.headers.etag, `"${rev}"`);
  assert.equal(map.headers['x-map-rev'], rev);
  assert.equal(map.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(map.headers['cache-control'], 'no-cache');
  assert.equal(map.headers.vary, 'Accept-Encoding');
  assert.equal(map.headers['content-encoding'], undefined);
  assert.ok(map.body.toString() === BAKED, 'the body is not the text of the map file');

  for (const tag of [`"${rev}"`, `W/"${rev}"`]) {
    const cached = await get(s, '/api/map', { 'If-None-Match': tag });
    assert.equal(cached.status, 304, tag);
    assert.equal(cached.body.length, 0);
    assert.equal(cached.headers.etag, `"${rev}"`);
    assert.equal(cached.headers['x-map-rev'], rev);
  }
  assert.equal((await get(s, '/api/map', { 'If-None-Match': '"0123456789abcdef"' })).status, 200);

  const packed = await get(s, '/api/map', { 'Accept-Encoding': 'br, gzip' });
  assert.equal(packed.headers['content-encoding'], 'gzip');
  assert.equal(packed.headers['x-map-rev'], rev);
  assert.ok(zlib.gunzipSync(packed.body).toString() === BAKED);
  assert.equal((await get(s, '/api/map', { 'Accept-Encoding': 'gzip;q=0, identity' })).headers['content-encoding'], undefined);

  // canSave is about THIS request: the same server seen under a foreign name, or through a proxy, cannot save
  assert.equal((await get(s, '/api/editor', { Host: 'evil.example' })).json.canSave, false);
  assert.equal((await get(s, '/api/editor', { 'X-Forwarded-For': '10.0.0.7' })).json.canSave, false);
}));

check('GET /api/assets lists the model files of every pack', () => withServer({}, async (s) => {
  const res = await get(s, '/api/assets');
  assert.equal(res.status, 200);
  assert.equal(res.headers['cache-control'], 'no-store');
  const onDisk = (pack, ext) => fs.readdirSync(path.join(ROOT, 'assets', pack)).filter((f) => f.endsWith(`.${ext}`)).map((f) => f.slice(0, -ext.length - 1)).sort();
  assert.deepEqual(res.json, { packs: { medieval: onDisk('medieval', 'gltf'), halloween: onDisk('halloween', 'gltf'), dungeon: onDisk('dungeon', 'glb') } });
  assert.ok(res.json.packs.medieval.includes('barrel') && res.json.packs.dungeon.includes('chest'));
}));

check('the api answers unknown routes with 404 and wrong methods with 405', () => withServer({}, async (s) => {
  const options = await call(s, 'OPTIONS', '/api/map', { headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(options.status, 405);
  assert.equal(options.headers.allow, 'GET, POST');
  assert.equal(options.headers['access-control-allow-origin'], undefined);
  assert.equal((await call(s, 'OPTIONS', '/api/anything')).status, 405);
  const missing = await get(s, '/api/backups');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, { ok: false, error: 'not-found' });
  for (const [method, url, allow] of [['DELETE', '/api/map', 'GET, POST'], ['HEAD', '/api/map', 'GET, POST'], ['POST', '/api/editor', 'GET'], ['PUT', '/api/assets', 'GET']]) {
    const res = await call(s, method, url);
    assert.equal(res.status, 405, `${method} ${url}`);
    assert.equal(res.headers.allow, allow);
  }
}));

// ---------------------------------------------------------------- saving

check('POST /api/map: each check of the save gate, in order', () => withServer({}, async (s) => {
  const rev = await revOf(s), changed = renamed('Edited');
  assert.notEqual(changed, BAKED);
  const refused = async (res, status, error) => {
    assert.equal(res.status, status, error);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.error, error);
    return res;
  };
  // The checks that come before the body are answered whatever the body is: "{" would be a 400 if anybody looked at it.
  // (A body this small also arrives together with its headers. The answer to a large one would race the rest of the
  // upload on these connections, which close after one request; a browser keeps its connection and has no such race.)
  await refused(await save(s, '{', { 'X-Editor': undefined }), 403, 'header');
  await refused(await save(s, '{', { Origin: 'http://evil.example' }), 403, 'origin');
  await refused(await save(s, '{', { Origin: undefined }), 403, 'origin');
  await refused(await save(s, '{', { Origin: 'null' }), 403, 'origin');
  await refused(await save(s, '{', { 'Sec-Fetch-Site': 'cross-site' }), 403, 'origin');
  await refused(await save(s, '{', { Host: 'evil.example', Origin: 'http://evil.example' }), 403, 'not-local');
  await refused(await save(s, '{', { 'X-Forwarded-For': '127.0.0.1' }), 403, 'not-local');
  await refused(await save(s, '{', { Via: '1.1 proxy' }), 403, 'not-local');
  await refused(await save(s, '{', { 'X-Forwarded-For': '127.0.0.1', 'X-Editor': undefined, Origin: undefined }), 403, 'not-local');   // the first check that fails answers
  await refused(await save(s, '{', { 'Content-Type': 'text/plain' }), 415, 'content-type');
  await refused(await save(s, '{', { 'Content-Type': undefined }), 415, 'content-type');
  await refused(await save(s, zlib.gzipSync('{}'), { 'Content-Encoding': 'gzip' }), 415, 'content-type');
  await refused(await save(s, '{'), 400, 'bad-json');
  await refused(await save(s, '[]'), 400, 'bad-json');
  await refused(await save(s, 'null'), 400, 'bad-json');
  await refused(await save(s, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])), 400, 'bad-json');   // not UTF-8

  // JSON.parse turns 1e999 into Infinity, and "constructor" is a key of every object
  const infinite = BAKED.replace(/"lvl": \[\d+, \d+\]/, '"lvl": [1e999, 1e999]');
  const proto = BAKED.replace(/"types": \{[^}]*\}/, '"types": { "constructor": 1 }');
  const noModel = BAKED.replace(/"m": "medieval\/[a-zA-Z_]+"/, '"m": "medieval/no_such_model"');
  for (const [text, code] of [[infinite, 'not-finite'], [proto, 'enum'], [noModel, 'model-missing'], [edited((f) => { f.radius = 10; }), 'radius'],
    [edited((f) => { f.surprise = 1; }), 'unknown-key'], [edited((f) => { f.version = 2; }), 'version-newer']]) {
    assert.notEqual(text, BAKED);
    const res = await refused(await save(s, text), 422, 'invalid');
    assert.ok(res.json.issues.length >= 1 && res.json.issues.length <= 50, code);
    assert.ok(res.json.issues.every((i) => i.level === 'error'));
    assert.ok(res.json.issues.some((i) => i.code === code), `${code} is not among ${res.json.issues.map((i) => i.code)}`);
  }
  const many = await refused(await save(s, edited((f) => { for (const o of f.objects) o.s = 99; })), 422, 'invalid');
  assert.equal(many.json.issues.length, 50);

  // an unchanged map is answered before the conflict check; a changed one needs the revision it was made from
  for (const base of ['0123456789abcdef', undefined]) {
    const conflict = await refused(await save(s, changed, { 'X-Base-Rev': base }), 409, 'conflict');
    assert.equal(conflict.json.rev, rev);
    const same = await save(s, BAKED, { 'X-Base-Rev': base });
    assert.equal(same.status, 200);
    assert.equal(same.json.unchanged, true);
  }
  const compact = await save(s, JSON.stringify(FILE), { 'Content-Type': 'application/json; charset=utf-8' });   // parameters are ignored
  assert.deepEqual({ ...compact.json, monsters: 0 }, { ok: true, unchanged: true, rev, monsters: 0, backup: null, warnings: [] });
  assert.ok(compact.json.monsters > 300);

  // none of this wrote anything
  assert.equal(await revOf(s), rev);
  assert.ok(fs.readFileSync(s.mapFile, 'utf8') === BAKED);
  assert.deepEqual(fs.readdirSync(s.dir).sort(), ['data', 'world.json'].filter((f) => f !== 'data' || fs.existsSync(s.dataDir)));
}));

check('a body that is too large is refused: by its Content-Length before any of it is read, or while it streams in', () => withServer({}, async (s) => {
  const head = (length) => `POST /api/map HTTP/1.1\r\nHost: localhost:${s.port}\r\nOrigin: http://localhost:${s.port}\r\nX-Editor: 1\r\n`
    + `X-Base-Rev: *\r\nContent-Type: application/json\r\n${length}\r\n\r\n`;
  const declared = await raw(s, head('Content-Length: 9000000'));
  assert.match(declared, /^HTTP\/1\.1 413 /);
  assert.match(declared, /^Connection: close\r$/mi);
  assert.ok(declared.endsWith('{"ok":false,"error":"too-large"}'));
  // one chunk of exactly one byte more than the limit, and nothing after it
  const size = LIMITS.bodyBytes + 1;
  const streamed = await raw(s, head('Transfer-Encoding: chunked'), `${size.toString(16)}\r\n`, Buffer.alloc(size, 0x20));
  assert.match(streamed, /^HTTP\/1\.1 413 /);
  assert.ok(streamed.endsWith('{"ok":false,"error":"too-large"}'));
  assert.equal((await get(s, '/api/editor')).status, 200);
}));

check('a save writes the file, keeps a backup, swaps the world and tells every socket; the same save again changes nothing', () => withServer({}, async (s) => {
  const before = await get(s, '/api/map'), rev = before.headers['x-map-rev'];
  const player = await join(s), idle = connect(s);
  const hello = await player.take('w');
  assert.equal(hello.rev, rev);
  assert.ok(Number.isInteger(hello.id) && inStartDisc(hello));
  assert.equal(hello.test, undefined);
  await idle.send('{"t":"hello"}');   // connected, never joined

  assert.equal(fs.existsSync(s.backups), false);   // a temp map folder, like a fresh clone, starts without the directory
  const changed = renamed('Edited'), res = await save(s, changed, { 'X-Base-Rev': rev });
  assert.equal(res.status, 200);
  const { rev: next, backup, monsters } = res.json;
  assert.deepEqual(res.json, { ok: true, unchanged: false, rev: next, monsters, backup, warnings: [] });
  assert.match(next, /^[0-9a-f]{16}$/);
  assert.notEqual(next, rev);
  assert.ok(monsters > 300);
  assert.equal(backup, BACKUP.exec(backup)?.[0]);
  assert.ok(backup.startsWith('session-') && backup.endsWith(`-${rev}.json`), backup);   // the first save of a run; named after the OLD revision
  assert.deepEqual(fs.readdirSync(s.backups), [backup]);
  assert.ok(fs.readFileSync(path.join(s.backups, backup), 'utf8') === BAKED);
  assert.ok(fs.readFileSync(s.mapFile, 'utf8') === changed);
  assert.deepEqual(fs.readdirSync(s.dir).filter((f) => f.endsWith('.tmp')), []);

  const after = await get(s, '/api/map');
  assert.equal(after.headers['x-map-rev'], next);
  assert.ok(after.body.toString() === changed);
  assert.deepEqual(await player.take('map'), { t: 'map', rev: next });
  assert.deepEqual(await idle.take('map'), { t: 'map', rev: next });

  const again = await save(s, changed, { 'X-Base-Rev': next });
  assert.equal(again.status, 200);
  assert.deepEqual(again.json, { ok: true, unchanged: true, rev: next, monsters, backup: null, warnings: [] });
  assert.deepEqual(fs.readdirSync(s.backups), [backup]);

  // a client that still holds the old map is sent to fetch the new one and gets no character
  const stale = connect(s, local(s));
  await stale.send({ t: 'join', name: 'Late', cls: 'fighter', rev });
  assert.deepEqual(await stale.take('map'), { t: 'map', rev: next });
  await sleep(300);
  assert.deepEqual(stale.inbox, []);
  await stale.send({ t: 'join', name: 'Late', cls: 'fighter', rev: next });   // the same socket may try again
  assert.equal((await stale.take('w')).rev, next);
}));

check('saves less than a second apart are refused; later ones are backed up as world-*', async () => {
  // a small map, so that two saves reach the server within a few milliseconds of each other
  const small = (name) => stringifyMap(serialize({ ...emptyMap({ radius: 40 }), name }));
  const s = await withServer({ map: small('One') }, async (s) => {
    const first = await save(s, small('Two'));
    const second = await save(s, small('Three'));
    assert.equal(first.status, 200);
    assert.match(first.json.backup, /^session-/);
    assert.deepEqual(first.json.warnings.map((i) => i.level), first.json.warnings.map(() => 'warning'));
    assert.ok(first.json.warnings.some((i) => i.code === 'no-safe-region'));
    assert.equal(first.json.monsters, 0);
    assert.equal(second.status, 429);
    assert.deepEqual(second.json, { ok: false, error: 'rate' });
    assert.equal(second.headers['retry-after'], '1');
    assert.equal(await revOf(s), first.json.rev);
    await sleep(1100);
    const third = await save(s, small('Three'), { 'X-Base-Rev': first.json.rev });
    assert.equal(third.status, 200);
    assert.match(third.json.backup, /^world-/);
    assert.deepEqual(fs.readdirSync(s.backups).sort(), [first.json.backup, third.json.backup].sort());
    assert.ok(fs.readFileSync(path.join(s.backups, third.json.backup), 'utf8') === small('Two'));
  });
  assert.match(s.out, /^map warning: regions: /m);   // warnings of the map are logged at start-up, they do not stop it
});

check('a save that cannot be written leaves the old map live', () => withServer({ setup: (s) => fs.writeFileSync(s.backups, 'not a directory') }, async (s) => {
  const rev = await revOf(s);
  const res = await save(s, renamed('Edited'));
  assert.equal(res.status, 500);
  assert.deepEqual(res.json, { ok: false, error: 'write-failed', code: 'EEXIST' });
  assert.equal((await get(s, '/api/map')).headers['x-map-rev'], rev);
  assert.ok(fs.readFileSync(s.mapFile, 'utf8') === BAKED);
  assert.deepEqual(fs.readdirSync(s.dir).filter((f) => f.endsWith('.tmp')), []);
  assert.ok(!res.body.toString().includes(s.dir), 'the answer names a path');

  // with the obstacle gone the same save goes through - and a map file that has vanished meanwhile is simply written anew
  fs.rmSync(s.backups);
  fs.rmSync(s.mapFile);
  const retry = await save(s, renamed('Edited'));
  assert.equal(retry.status, 200);
  assert.equal(retry.json.backup, null);
  assert.ok(fs.readFileSync(s.mapFile, 'utf8') === renamed('Edited'));
  assert.deepEqual(fs.readdirSync(s.backups), []);
}));

check('old backups are pruned: the 20 newest stay, and the oldest of each of the last 14 days, and what the run started from', async () => {
  // three backups a day for twenty days, oldest first within a day; days[0] is today (UTC, as in the file names)
  const days = Array.from({ length: 20 }, (_, d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10).replaceAll('-', ''));
  const fileOf = (day, n) => `world-${day}-00000${n}-${'0123456789abcdef'.slice(n).padEnd(16, '0')}.json`;
  const old = days.flatMap((day) => [1, 2, 3].map((n) => fileOf(day, n)));
  // A folder with the name of a backup, older than all of them. It cannot be unlinked - and it is the first in line: a
  // rotation that gives up at the first entry it cannot remove would never remove anything again.
  const folder = 'world-20200101-000000-0123456789abcdef.json';
  const setup = (s) => {
    fs.mkdirSync(path.join(s.backups, folder), { recursive: true });
    for (const name of [...old, 'notes.txt', 'world-copy.json']) fs.writeFileSync(path.join(s.backups, name), '{}');
  };
  await withServer({ setup }, async (s) => {
    const res = await save(s, renamed('Edited'));
    assert.equal(res.status, 200);
    const left = fs.readdirSync(s.backups), stamp = (name) => name.slice(name.indexOf('-') + 1);
    assert.ok(left.includes('notes.txt') && left.includes('world-copy.json'), 'a file that is not a backup was touched');
    assert.ok(left.includes(folder) && fs.statSync(path.join(s.backups, folder)).isDirectory(), 'a folder was taken for a backup');
    assert.ok(left.includes(res.json.backup));
    const newest = [...old, res.json.backup].sort((a, b) => (stamp(a) < stamp(b) ? -1 : 1)).slice(-20);
    assert.deepEqual(newest.filter((name) => !left.includes(name)), []);
    // the days next to the 14-day boundary are left out: the test may run across midnight
    for (let d = 0; d <= 12; d++) assert.ok(left.includes(fileOf(days[d], 1)), `the oldest backup of ${days[d]} is gone`);
    for (let d = 8; d <= 12; d++) assert.deepEqual(left.filter((name) => name.includes(`-${days[d]}-`)), [fileOf(days[d], 1)]);
    for (let d = 15; d <= 19; d++) assert.deepEqual(left.filter((name) => name.includes(`-${days[d]}-`)), []);
  });
});

check('a save restarts the monsters only when spawns, safe regions or the radius changed', () => withServer({}, async (s) => {
  const camp = FILE.spawns[0];
  const c = await join(s, { test: { at: [camp.x, camp.z], god: true, lvl: 40 } });
  await c.take('w');
  // the monsters the tester sees, once the swap of revision `rev` (if any) has reached the socket
  const seen = async (rev) => {
    if (rev) assert.equal((await c.take('map')).rev, rev);
    c.inbox.length = 0;
    for (let i = 0; i < 100; i++) {
      const snap = await c.take('s');
      if (snap.m.length) return snap.m.map((m) => m[0]);
    }
    return [];
  };
  const first = await seen();
  assert.ok(first.length > 0, 'no monster near the first spawn');

  const scenery = await save(s, edited((f) => { f.name = 'Scenery'; f.objects.pop(); f.chests.pop(); }));
  assert.equal(scenery.status, 200);
  const kept = await seen(scenery.json.rev);
  assert.ok(kept.some((id) => first.includes(id)), 'a scenery edit replaced the monsters');

  await sleep(1100);
  const spawns = await save(s, edited((f) => { f.name = 'Scenery'; f.objects.pop(); f.chests.pop(); f.spawns[0].count += 1; }));
  assert.equal(spawns.status, 200);
  assert.equal(spawns.json.monsters, scenery.json.monsters + 1);
  const fresh = await seen(spawns.json.rev);
  assert.ok(fresh.length > 0 && Math.min(...fresh) > Math.max(...first, ...kept), 'a spawn edit kept old monsters, or reused their ids');
}));

// ---------------------------------------------------------------- editor mode and the token

check('start-up: a missing or broken map file, or a bad token, ends the process with a reason', async () => {
  const missing = await refusedStart({ map: null });
  assert.equal(missing.code, 1);
  assert.ok(missing.out.includes(`Map file not found: ${missing.mapFile}. Run: npm run bake`), missing.out);
  assert.equal(fs.existsSync(missing.mapFile), false);

  const broken = await refusedStart({ map: '{' });
  assert.equal(broken.code, 1);
  assert.match(broken.out, /^Newest backup: no backup$/m);
  assert.equal(fs.readFileSync(broken.mapFile, 'utf8'), '{');   // byte-identical: the server never repairs or rewrites at boot
  assert.deepEqual(fs.readdirSync(broken.dir), ['world.json']);

  // what is wrong is listed (ten issues at most), and the newest backup is named - a file, not a folder with a newer name
  const names = ['world-20250101-000000-0123456789abcdef.json', 'session-20250301-120000-0123456789abcdef.json', 'world-20250215-235959-fedcba9876543210.json', 'notes.txt'];
  const folder = 'world-20990101-000000-0123456789abcdef.json';
  const invalid = await refusedStart({
    map: edited((f) => { f.radius = 10; for (const c of f.chests) c.gold = 0; }),
    setup: (s) => { fs.mkdirSync(path.join(s.backups, folder), { recursive: true }); for (const name of names) fs.writeFileSync(path.join(s.backups, name), '{}'); },
  });
  assert.equal(invalid.code, 1);
  assert.match(invalid.out, /^ {2}radius: /m);
  assert.equal(invalid.out.match(/^ {2}\S.*: /gm).length, 10);
  assert.match(invalid.out, /^Newest backup: session-20250301-120000-0123456789abcdef\.json$/m);
  assert.deepEqual(fs.readdirSync(invalid.backups).sort(), [...names, folder].sort());
  assert.doesNotMatch(invalid.out, /^\s+at /m, 'died with a stack trace');

  const newer = await refusedStart({ map: edited((f) => { f.version = 2; }) });
  assert.equal(newer.code, 1);
  assert.match(newer.out, /version 2/);

  for (const [args, token] of [[['--editor'], 'short'], [['--editor'], ''], [[], 'short'], [['--editor'], 'x'.repeat(257)]]) {
    const refused = await refusedStart({ args, env: { EDITOR_TOKEN: token } });
    assert.equal(refused.code, 1, `EDITOR_TOKEN=${token.slice(0, 8)}`);
    assert.match(refused.out, /EDITOR_TOKEN/);
  }
});

check('editor mode is on only when asked for by --editor or MAP_EDITOR=1', async () => {
  const off = (s) => async () => {
    assert.deepEqual((await get(s, '/api/editor')).json, { enabled: false, tokenRequired: false, canSave: false, rev: await revOf(s) });
    const res = await save(s, '{');   // refused before the body is looked at
    assert.equal(res.status, 403);
    assert.deepEqual(res.json, { ok: false, error: 'editor-off' });
  };
  // EDITOR is the user's text editor on most hosts; a token alone enables nothing; MAP_EDITOR is compared as a string
  for (const env of [{ EDITOR: 'vim' }, { EDITOR: '1', EDITOR_TOKEN: TOKEN }, { MAP_EDITOR: 'true' }]) {
    const s = await withServer({ args: [], env }, (server) => off(server)());
    assert.doesNotMatch(s.out, /MAP EDITOR/, JSON.stringify(env));
  }
  const production = await withServer({ env: { NODE_ENV: 'production' } }, (server) => off(server)());
  assert.match(production.out, /^editor mode ignored: set EDITOR_TOKEN to use it in production$/m);
  assert.doesNotMatch(production.out, /MAP EDITOR/);

  const on = await withServer({ args: [], env: { MAP_EDITOR: '1' } }, async (s) => {
    assert.deepEqual((await get(s, '/api/editor')).json, { enabled: true, tokenRequired: false, canSave: true, rev: await revOf(s) });
  });
  assert.match(on.out, new RegExp(`^HyperCat MMO: http://localhost:${on.port}\\nMAP EDITOR ON \\(local only\\) http://localhost:${on.port}/editor\\.html$`, 'm'));
});

check('token mode: the token decides, wherever the request comes from; wrong tokens are counted, the right one never is', async () => {
  const s = await withServer({ env: { EDITOR_TOKEN: TOKEN, NODE_ENV: 'production' } }, async (s) => {
    const rev = await revOf(s);
    assert.deepEqual((await get(s, '/api/editor', { Host: 'game.example' })).json, { enabled: true, tokenRequired: true, canSave: true, rev });
    const wrong = () => save(s, '{', { 'X-Editor-Token': `${TOKEN}?` });   // the body is not looked at, or this would be a 400
    const none = await save(s, '{');
    assert.equal(none.status, 401);
    assert.deepEqual(none.json, { ok: false, error: 'token' });
    assert.equal((await wrong()).status, 401);
    // the right token from a foreign page, through a proxy: the Origin is not compared in token mode
    const right = await save(s, renamed('Edited'), { 'X-Editor-Token': TOKEN, Origin: 'http://evil.example', Host: 'game.example', 'X-Forwarded-For': '10.0.0.7' });
    assert.equal(right.status, 200);
    assert.equal(right.json.unchanged, false);
    assert.equal((await save(s, '{', { 'X-Editor-Token': TOKEN, 'X-Editor': undefined })).status, 403);   // the header is still asked for

    for (let i = 3; i <= 11; i++) assert.equal((await wrong()).status, 401, `wrong token number ${i}`);
    const limited = await wrong();   // the twelfth failure within a minute
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.json, { ok: false, error: 'rate' });
    assert.equal(limited.headers['retry-after'], '60');
    assert.equal((await save(s, '{')).status, 429);   // and the body is not looked at
    const still = await save(s, renamed('Edited'), { 'X-Editor-Token': TOKEN });
    assert.equal(still.status, 200);
    assert.equal(still.json.unchanged, true);
  });
  assert.match(s.out, new RegExp(`^MAP EDITOR ON \\(token\\) http://localhost:${s.port}/editor\\.html$`, 'm'));
  assert.ok(!s.out.includes(TOKEN), 'the token was printed');
});

// ---------------------------------------------------------------- websocket

check('join.at and join.test count only on a socket opened by a page of this server (tokenless editor mode)', () => withServer({}, async (s) => {
  const wish = { at: [100, 100], test: { at: [100, 100], god: true, lvl: 40 } };
  for (const origin of ['http://evil.example', `http://127.0.0.1:${s.port}`, null]) {   // the second is not the origin of the Host the socket names
    const foreign = await join(s, wish, origin);
    const w = await foreign.take('w');
    assert.equal(w.test, undefined, String(origin));
    assert.ok(inStartDisc(w), `${origin}: joined at ${w.x}, ${w.z}`);
    assert.equal((await foreign.take('s')).me.level, 1);
    await foreign.close();
  }
  const own = await join(s, { test: { at: [100, 100], god: true, lvl: 40, cls: 'wizard', speed: 2 } });
  const w = await own.take('w');
  assert.deepEqual(w.test, { god: true, speed: 2 });
  assert.ok(Math.abs(w.x - 100) <= 1 && Math.abs(w.z - 100) <= 1, `joined at ${w.x}, ${w.z}`);
  const { me } = await own.take('s');
  assert.deepEqual([me.level, me.cls, me.weapon, me.xp, me.skills.bolt, me.skills.fireball, me.skills.spell_mastery], [40, 'wizard', 10, 0, 3, 2, 2]);

  // a rejoin position without a test session; and "constructor" is not a class, a level is clamped, a speed is 1 or 2
  const back = await join(s, { at: [100, 100] });
  const again = await back.take('w');
  assert.ok(Math.abs(again.x - 100) <= 1 && Math.abs(again.z - 100) <= 1 && again.test === undefined);
  const odd = await join(s, { test: { at: null, lvl: 1e9, cls: 'constructor', speed: 7 } });
  const o = await odd.take('w');
  assert.deepEqual(o.test, { god: false, speed: 1 });
  assert.ok(inStartDisc(o));
  const snap = await odd.take('s');
  assert.deepEqual([snap.me.level, snap.me.cls], [40, 'fighter']);
}));

check('without --editor join.at and join.test are ignored, whatever the Origin', () => withServer({ args: [] }, async (s) => {
  for (const origin of ['http://evil.example', local(s)]) {
    const c = await join(s, { at: [100, 100], test: { at: [100, 100], god: true, lvl: 40 } }, origin);
    const w = await c.take('w');
    assert.equal(w.test, undefined, origin);
    assert.ok(inStartDisc(w), `${origin}: joined at ${w.x}, ${w.z}`);
    assert.equal(w.rev, await revOf(s));
  }
}));

check('token mode: a join is trusted by its editorToken alone, and a token that is not a string does no harm', () => withServer({ env: { EDITOR_TOKEN: TOKEN } }, async (s) => {
  const rev = await revOf(s);
  const first = connect(s, local(s));
  await first.send(`{"t":"join","editorToken":123,"rev":"${rev}"}`);   // hashing a raw number would throw
  const w = await first.take('w');
  assert.equal(w.rev, rev);
  const wish = { at: [100, 100], test: { at: [100, 100], god: true, lvl: 40 } };
  for (const editorToken of [123, `${TOKEN}?`, '', undefined, [TOKEN], { toString: 1 }]) {
    const c = connect(s, local(s));
    await c.send({ t: 'join', rev, ...wish, editorToken });
    if (typeof editorToken === 'object') continue;   // such a join may be dropped; the server must only survive it
    const untrusted = await c.take('w');
    assert.equal(untrusted.test, undefined, String(editorToken));
    assert.ok(inStartDisc(untrusted));
  }
  const editor = connect(s, 'http://evil.example');   // the Origin does not matter here
  await editor.send({ t: 'join', rev, ...wish, editorToken: TOKEN });
  const trusted = await editor.take('w');
  assert.deepEqual(trusted.test, { god: true, speed: 1 });
  assert.ok(Math.abs(trusted.x - 100) <= 1 && Math.abs(trusted.z - 100) <= 1);
  assert.equal((await get(s, '/api/editor')).status, 200);
}));

check('no message takes the server down', () => withServer({}, async (s) => {
  const rev = await revOf(s);
  const c = await join(s, { token: '__proto__' });
  await c.take('w');
  for (const text of ['{"t":"__proto__"}', '{"t":"__defineGetter__"}', '{"t":"join","editorToken":123}', '{"t":"constructor"}', '{"t":"toString"}',
    'not json', 'null', '[]', '7', '{}', '{"t":{"toString":1}}', '{"t":["m"]}', '{"t":"m","x":"a","z":{}}', '{"t":"m","x":1e308,"z":1e308}',
    '{"t":"a","id":"__proto__"}', '{"t":"k","s":"__proto__"}', '{"t":"k","s":"constructor"}', '{"t":"sk","s":"constructor"}', '{"t":"sk","s":"hasOwnProperty","tid":{}}',
    '{"t":"sk","s":{"toString":1}}', '{"t":"learn","s":"toString"}', '{"t":"learn","s":"__proto__"}', '{"t":"prof","cls":"constructor"}',
    '{"t":"prof","cls":"__proto__"}', '{"t":"b"}', '{"t":"c","m":{"toString":1}}', '{"t":"c","m":"hello"}']) {
    await c.send(text);
  }
  await c.take('c', (m) => m.m === 'hello');   // everything before it was survived, and the socket still works
  // first messages that are not a proper join
  for (const text of ['{"t":"__proto__"}', `{"t":"join","rev":"${rev}","name":{"toString":1}}`, `{"t":"join","rev":"${rev}","token":{"toString":1}}`,
    `{"t":"join","rev":"${rev}","test":"yes","at":"here"}`, `{"t":"join","rev":"${rev}","test":{"at":["a",null],"lvl":"x","cls":["fighter"],"god":1},"cls":"constructor"}`,
    '{"t":"join","rev":{"toString":1}}', '{"t":"join"}']) {
    await connect(s, local(s)).send(text);
  }
  const last = await join(s);
  assert.equal((await last.take('w')).rev, rev);
  assert.equal((await get(s, '/api/editor')).status, 200);
  await c.take('s', (m) => m.n >= 2);
}));

check('the movement check: a grace lets a placed cat settle, once - it is not 40 more units for every message or every refused move', async () => {
  // a flat island without monsters or scenery, wide enough for the hops below; the game as players get it, no editor
  const flat = stringifyMap(serialize({ ...emptyMap({ radius: 300 }), name: 'Flat' }));
  await withServer({ args: [], map: flat }, async (s) => {
    const clock = () => performance.now() / 1000;
    let since = clock();   // before the message that places the cat: the server counts the time from there
    const c = await join(s, {}, null);
    const start = await c.take('w');
    const move = (dx) => c.send({ t: 'm', x: start.x + dx, y: 0, z: start.z, yaw: 0, s: 1, st: 0 });
    // resolves when the server has handled every message sent so far: it answers a ping in its turn
    const handled = () => new Promise((resolve) => { c.ws.once('pong', resolve); c.ws.ping(); });
    // How far east of where it joined the server has the cat. A move that has to be refused is answered with the position;
    // the snapshot taken before it has brought the answers to everything sent earlier.
    const where = async () => {
      await handled();
      c.inbox.length = 0;
      await c.take('s');
      await move(1e6);
      const snap = await c.take('s', (m) => m.e.some((e) => e.k === 'tp'));
      return snap.e.find((e) => e.k === 'tp').x - start.x;
    };
    // The most the check lets a cat travel after it was placed: 36 units a second (the server's clock moves in ticks, so
    // it may count a little more time than passed here), 3 more with every message, and the 40 of one grace.
    const most = (messages) => 36 * (clock() - since + 0.2) + 3 * messages + 40;

    // Just placed: a client that finds its cat inside scenery pushes it out, and that step is taken though it is far
    // too long for a walk. The next one is not: the grace is spent.
    await move(35);
    await move(70);
    await handled();
    const settled = most(2), pushed = await where();
    assert.ok(pushed >= 34.99, `a push of 35 units right after the join was refused: the cat is at ${pushed}`);
    assert.ok(pushed <= settled, `two pushes of 35 units took the cat ${pushed} units; the check allows ${settled}`);

    // Long after that grace. A refused move puts the cat back, which starts a new grace: the client may have to push it
    // out again. However many moves a scripted client sends then, it gets the 40 units out of it once.
    await sleep(3300);
    since = clock();
    const from = await where();   // the refused move
    for (let i = 1; i <= 20; i++) await move(from + 12 * i);
    await handled();
    const allowed = most(20), hopped = await where() - from;
    assert.ok(hopped >= 11.99, 'a refused move did not start a new grace');
    assert.ok(hopped <= allowed, `20 hops of 12 units took the cat ${hopped} units; the check allows ${allowed}`);
  });
});

check('a map without a sage: learning and choosing a profession do nothing, and nothing breaks', async () => {
  const sage = FILE.npcs.find((n) => n.kind === 'sage');
  // a level-40 fighter beside the sage (or where it stood) asks for everything a sage and a blacksmith sell
  const shop = async (s) => {
    const c = await join(s, { test: { at: [sage.x + 1, sage.z + 1], lvl: 40 } });
    await c.take('w');
    for (const msg of [{ t: 'learn', s: 'power_strike' }, { t: 'learn', s: 'bolt' }, { t: 'prof', cls: 'knight' }, { t: 'b' }, { t: 'c', m: 'done' }]) await c.send(msg);
    await c.take('c', (m) => m.m === 'done');
    c.inbox.length = 0;
    assert.equal((await get(s, '/api/editor')).status, 200);
    return (await c.take('s')).me;
  };
  const without = await withServer({ map: edited((f) => { f.npcs = f.npcs.filter((n) => n.kind !== 'sage' && n.kind !== 'blacksmith'); }) }, async (s) => {
    assert.equal((await shop(s)).cls, 'fighter');
  });
  assert.match(without.out, /^map warning: npcs: No Sage on the map/m);
  assert.match(without.out, /^map warning: npcs: No Blacksmith on the map/m);
  await withServer({}, async (s) => assert.equal((await shop(s)).cls, 'knight'));
});

check('a play-test character is never written to players.json; a real one is', async () => {
  const s = await withServer({}, async (s) => {
    const tester = await join(s, { token: 'designer-token', test: { at: null, lvl: 30, god: true } });
    assert.deepEqual((await tester.take('w')).test, { god: true, speed: 1 });
    await tester.take('s');
    await tester.close();
    await sleep(200);
  });
  assert.deepEqual(savedPlayers(s), {});

  const real = await withServer({}, async (s) => {
    const first = await join(s, { token: 'player-token', name: 'Mia' });
    await first.take('w');
    // The map is saved: every tab reloads and rejoins naming its position. Such a rejoin takes the saved character over
    // from the tab's own stale session (which joined under the OLD revision) instead of becoming a guest ...
    assert.equal((await save(s, renamed('After the save'))).status, 200);
    const second = await join(s, { token: 'player-token', name: 'Mia', at: [100, 100] });
    const w = await second.take('w');
    assert.ok(Math.abs(w.x - 100) <= 1 && Math.abs(w.z - 100) <= 1);
    await first.closed;   // closed by the server
    // ... but not from a session that already joined THIS revision: that is a second tab of the same browser, which
    // rejoins after the same save and must leave the first one playing. It is an unsaved guest, like any second tab.
    const twin = await join(s, { token: 'player-token', name: 'Twin', at: [100, 100] });
    await twin.take('w');
    const guest = await join(s, { token: 'player-token', name: 'Third' });   // and so is a tab that joins from the menu
    await guest.take('w');
    assert.equal(second.ws.readyState, WebSocket.OPEN);
    await second.take('s', (m) => m.n === 3);
  });
  assert.deepEqual(Object.keys(savedPlayers(real)), ['player-token']);
  assert.equal(savedPlayers(real)['player-token'].name, 'Mia');
});

check('start-up removes a temp file that a cut-short save left behind, and nothing else', () => withServer({
  setup: (s) => { for (const name of ['world.json.tmp', 'other.tmp', 'world.json.bak']) fs.writeFileSync(path.join(s.dir, name), 'left over'); },
}, async (s) => {
  assert.deepEqual(fs.readdirSync(s.dir).filter((f) => f !== 'data').sort(), ['other.tmp', 'world.json', 'world.json.bak']);
  assert.ok(fs.readFileSync(s.mapFile, 'utf8') === BAKED);
}));
