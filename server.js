import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  WORLD_R, TOWN_R, TICK, ZONES, BOSS, MOB_TYPES, MOB_KEYS, xpNext, maxHpFor, dmgMult, upgradeCost,
} from './src/shared.js';

const PORT = process.env.PORT || 8765;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SAVE_FILE = path.join(ROOT, 'data', 'players.json');
const VIEW_R = 65;

// ---------------------------------------------------------------- static files

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { url = ''; }
  if (url === '/') url = '/index.html';
  const file = path.join(ROOT, url);
  if ((url !== '/index.html' && !url.startsWith('/src/')) || !file.startsWith(ROOT + path.sep)) {
    res.writeHead(404).end('Not found');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------------------------------------------------------------- persistence

let saved = {};
try { saved = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')); } catch { /* first run */ }

function persist(p) {
  if (!p.persist) return;
  saved[p.token] = { name: p.name, level: p.level, xp: p.xp, gold: p.gold, weapon: p.weapon };
}
function flush() {
  for (const p of players.values()) persist(p);
  fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
  fs.writeFileSync(SAVE_FILE, JSON.stringify(saved));
}

// ---------------------------------------------------------------- world state

let nextId = 1, now = 0;
const players = new Map();
const mobs = [];
let bullets = [], orbs = [], gems = [];

const rand = (a, b) => a + Math.random() * (b - a);
const r2 = (v) => Math.round(v * 100) / 100;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function makeMob(type, lvl, sx, sz) {
  const def = MOB_TYPES[type];
  const maxHp = Math.ceil(def.hp * (1 + 0.45 * (lvl - 1)));
  mobs.push({
    id: nextId++, type, ti: MOB_KEYS.indexOf(type), lvl, def, r: def.r, sx, sz, x: sx, z: sz,
    hp: maxHp, maxHp, dmg: Math.round(def.dmg * (1 + 0.15 * (lvl - 1))), xp: def.xp * lvl,
    kx: 0, kz: 0, target: 0, fireT: rand(1, 3), hitAt: 0, wx: sx, wz: sz, wanderAt: 0,
    dead: false, respawnAt: 0, dmgBy: new Set(), dashHit: '', strafe: Math.random() < 0.5 ? 1 : -1,
  });
}

function spawnRing(count, rMin, rMax, lMin, lMax, types) {
  for (let i = 0; i < count; i++) {
    const a = rand(0, Math.PI * 2), r = Math.sqrt(rand(rMin * rMin, rMax * rMax));
    const lvl = Math.round(lMin + (lMax - lMin) * (r - rMin) / (rMax - rMin));
    makeMob(types[Math.floor(Math.random() * types.length)], lvl, Math.cos(a) * r, Math.sin(a) * r);
  }
}
for (let i = 1; i < ZONES.length; i++) {
  const z = ZONES[i];
  spawnRing(z.mobs, ZONES[i - 1].r + 4, z.r - 4, z.lvl[0], z.lvl[1], z.types);
}
makeMob('boss', BOSS.lvl, BOSS.x, BOSS.z);

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
  const d = Math.hypot(o.x, o.z), max = WORLD_R - margin;
  if (d > max) { o.x *= max / d; o.z *= max / d; }
}

// squared distance from point p to segment a-b
function segDist2(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
  const cx = ax + dx * t - px, cz = az + dz * t - pz;
  return cx * cx + cz * cz;
}

// ---------------------------------------------------------------- combat

function addXp(p, xp) {
  p.xp += xp;
  while (p.xp >= xpNext(p.level)) {
    p.xp -= xpNext(p.level);
    p.level++;
    p.maxHp = maxHpFor(p.level);
    p.hp = p.maxHp;
    p.events.push({ k: 'lvl', level: p.level });
    emit({ k: 'lvlfx', x: r2(p.x), z: r2(p.z) }, p.x, p.z);
  }
}

function damageMob(m, dmg, dx, dz, knock, p) {
  m.hp -= dmg;
  m.dmgBy.add(p.id);
  if (!m.target) m.target = p.id;
  m.kx += dx * knock / m.r; m.kz += dz * knock / m.r;
  if (m.hp > 0) { emit({ k: 'hit', id: m.id, x: r2(m.x), z: r2(m.z) }, m.x, m.z); return; }

  m.dead = true;
  m.respawnAt = now + (m.type === 'boss' ? 90 : 14);
  emit({ k: 'kill', id: m.id, x: r2(m.x), z: r2(m.z), ti: m.ti }, m.x, m.z);
  const drops = m.type === 'boss' ? 12 : m.type === 'tank' ? 3 : 1;
  for (let i = 0; i < drops; i++) {
    gems.push({
      id: nextId++, x: m.x + rand(-1, 1) * m.r * 1.5, z: m.z + rand(-1, 1) * m.r * 1.5,
      until: now + 25, gold: Math.ceil(rand(1, 3) * m.lvl),
    });
  }
  for (const id of m.dmgBy) {
    const q = players.get(id);
    if (q && !q.dead) { addXp(q, m.xp); q.energy = Math.min(100, q.energy + 4); }
  }
  if (m.type === 'boss') broadcast({ t: 'c', sys: 1, m: `The Skeleton King has fallen! Final blow: ${p.name}` });
  m.dmgBy.clear();
  m.target = 0;
}

function hurtPlayer(p, dmg) {
  if (p.dead || now < p.dashUntil || now < p.invulnUntil) return;
  p.hp -= dmg;
  p.hurtAt = now;
  p.invulnUntil = now + 0.5;
  p.events.push({ k: 'hurt' });
  if (p.hp <= 0) {
    p.hp = 0;
    p.dead = true;
    p.deadUntil = now + 3.5;
    p.gold = Math.floor(p.gold * 0.9);
    emit({ k: 'kill', id: 0, x: r2(p.x), z: r2(p.z), ti: -1 }, p.x, p.z);
    broadcast({ t: 'c', sys: 1, m: `${p.name} was slain` });
  }
}

function respawnPlayer(p) {
  const a = rand(0, Math.PI * 2), r = rand(0, TOWN_R - 4);
  p.x = Math.cos(a) * r; p.z = Math.sin(a) * r; p.y = 0;
  p.hp = p.maxHp;
  p.dead = false;
  p.lastMoveAt = now;
  p.events.push({ k: 'tp', x: r2(p.x), z: r2(p.z) });
}

// ---------------------------------------------------------------- simulation

function updateMob(m, dt) {
  if (m.dead) {
    if (now >= m.respawnAt) Object.assign(m, { dead: false, x: m.sx, z: m.sz, hp: m.maxHp, kx: 0, kz: 0 });
    return;
  }

  let t = m.target ? players.get(m.target) : null;
  const leash = Math.hypot(m.x - m.sx, m.z - m.sz);
  if (t && (t.dead || Math.hypot(t.x, t.z) < TOWN_R || Math.hypot(t.x - m.x, t.z - m.z) > 26 || leash > 34)) t = null;
  if (!t) {
    m.target = 0;
    let bestD = m.type === 'boss' ? 20 : 13;
    for (const p of players.values()) {
      if (p.dead || Math.hypot(p.x, p.z) < TOWN_R) continue;
      const d = Math.hypot(p.x - m.x, p.z - m.z);
      if (d < bestD && leash < 30) { bestD = d; t = p; }
    }
    if (t) m.target = t.id;
  }

  let mx = 0, mz = 0, speed = m.def.speed;
  if (t) {
    let dx = t.x - m.x, dz = t.z - m.z;
    const dist = Math.hypot(dx, dz) || 0.001;
    dx /= dist; dz /= dist;
    mx = dx; mz = dz;
    if (m.type === 'shooter' || m.type === 'boss') {
      if (m.type === 'shooter') {
        if (dist < 9) { mx = -dx; mz = -dz; } else if (dist < 14) { mx = -dz * m.strafe; mz = dx * m.strafe; }
      }
      m.fireT -= dt;
      if (m.fireT <= 0 && dist < 22) {
        m.fireT = m.type === 'boss' ? 1.4 : 2.2;
        const shots = m.type === 'boss' ? 8 : 1;
        for (let i = 0; i < shots; i++) {
          const a = Math.atan2(dz, dx) + i * Math.PI * 2 / shots;
          const ox = Math.cos(a), oz = Math.sin(a);
          orbs.push({ x: m.x + ox * m.r, z: m.z + oz * m.r, vx: ox * 10, vz: oz * 10, life: 3.5, dmg: m.dmg });
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
      m.wx = m.sx + rand(-5, 5); m.wz = m.sz + rand(-5, 5);
    }
    const dx = m.wx - m.x, dz = m.wz - m.z, dist = Math.hypot(dx, dz);
    if (dist > 0.5) { mx = dx / dist; mz = dz / dist; speed *= leash > 12 ? 1.5 : 0.4; }
  }

  m.x += (mx * speed + m.kx) * dt;
  m.z += (mz * speed + m.kz) * dt;
  const damp = Math.exp(-6 * dt);
  m.kx *= damp; m.kz *= damp;
  clampWorld(m, m.r);
  const d = Math.hypot(m.x, m.z), min = TOWN_R + m.r + 0.5;   // the town is a safe zone
  if (d < min) { m.x *= min / (d || 1); m.z *= min / (d || 1); }

  for (const p of players.values()) {
    if (p.dead) continue;
    const dx = p.x - m.x, dz = p.z - m.z, dist = Math.hypot(dx, dz) || 0.001;
    if (dist > m.r + 0.55 || p.y > m.r * 2 + 0.2) continue;
    if (now < p.dashUntil) {
      const key = `${p.id}:${p.dashSeq}`;
      if (m.dashHit !== key) {
        m.dashHit = key;
        damageMob(m, 3 * dmgMult(p.level, p.weapon), -dx / dist, -dz / dist, 14, p);
        if (m.dead) return;
      }
    } else if (now >= m.hitAt) {
      m.hitAt = now + 0.8;
      hurtPlayer(p, m.dmg);
      m.kx -= dx / dist * 8; m.kz -= dz / dist * 8;
    }
  }
}

function separateMobs() {
  const active = mobs.filter((m) => !m.dead && m.target);
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i], b = active[j];
      const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz) || 0.001, min = a.r + b.r;
      if (d < min) {
        const push = (min - d) / 2 / d;
        a.x -= dx * push; a.z -= dz * push;
        b.x += dx * push; b.z += dz * push;
      }
    }
  }
}

function tick() {
  now = performance.now() / 1000;
  const dt = TICK;

  for (const p of players.values()) {
    if (p.dead) { if (now >= p.deadUntil) respawnPlayer(p); continue; }
    if (Math.hypot(p.x, p.z) < TOWN_R) p.hp = Math.min(p.maxHp, p.hp + 25 * dt);
    else if (now - p.hurtAt > 6) p.hp = Math.min(p.maxHp, p.hp + 2 * dt);
  }

  for (const m of mobs) updateMob(m, dt);
  separateMobs();

  bullets = bullets.filter((b) => {
    const ox = b.x, oz = b.z;
    b.x += b.vx * dt; b.z += b.vz * dt;
    b.life -= dt;
    if (b.life <= 0 || Math.hypot(b.x, b.z) > WORLD_R + 2) return false;
    const p = players.get(b.owner);
    if (!p) return false;
    for (const m of mobs) {
      const rr = m.r + 0.3;
      if (!m.dead && segDist2(m.x, m.z, ox, oz, b.x, b.z) < rr * rr) {
        damageMob(m, b.dmg, b.vx / 34, b.vz / 34, 4, p);
        return false;
      }
    }
    return true;
  });

  orbs = orbs.filter((o) => {
    const ox = o.x, oz = o.z;
    o.x += o.vx * dt; o.z += o.vz * dt;
    o.life -= dt;
    if (o.life <= 0 || Math.hypot(o.x, o.z) < TOWN_R) return false;
    for (const p of players.values()) {
      if (!p.dead && p.y < 1.4 && now >= p.dashUntil && segDist2(p.x, p.z, ox, oz, o.x, o.z) < 0.6) {
        hurtPlayer(p, o.dmg);
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
        p.energy = Math.min(100, p.energy + 8);
        p.events.push({ k: 'gem', gold: g.gold });
        return false;
      }
    }
    return true;
  });

  for (const p of players.values()) {
    const near = (o) => Math.abs(o.x - p.x) < VIEW_R && Math.abs(o.z - p.z) < VIEW_R;
    const snap = {
      t: 's',
      n: players.size,
      me: {
        hp: Math.ceil(p.hp), maxHp: p.maxHp, xp: p.xp, level: p.level, gold: p.gold,
        weapon: p.weapon, energy: p.energy, dead: p.dead ? 1 : 0,
      },
      p: [], m: [], g: [],
      e: p.events,
    };
    for (const q of players.values()) {
      if (q !== p && near(q)) {
        snap.p.push([q.id, r2(q.x), r2(q.y), r2(q.z), r2(q.yaw), q.speed, Math.ceil(q.hp), q.maxHp, q.level, q.dead ? 1 : 0]);
      }
    }
    for (const m of mobs) if (!m.dead && near(m)) snap.m.push([m.id, m.ti, m.lvl, r2(m.x), r2(m.z), Math.ceil(m.hp), m.maxHp]);
    for (const g of gems) if (near(g)) snap.g.push([g.id, r2(g.x), r2(g.z)]);
    send(p.ws, snap);
    p.events = [];
  }
}

// ---------------------------------------------------------------- networking

const wss = new WebSocketServer({ server, maxPayload: 2048 });

const handlers = {
  m(p, msg) {   // movement (client-side, sanity-checked here)
    if (p.dead) return;
    const x = num(msg.x), z = num(msg.z);
    const elapsed = Math.min(1, now - p.lastMoveAt);
    if (Math.hypot(x - p.x, z - p.z) > 36 * elapsed + 3) {
      p.events.push({ k: 'tp', x: r2(p.x), z: r2(p.z) });
      p.lastMoveAt = now;
      return;
    }
    p.x = x; p.z = z;
    p.y = Math.max(0, Math.min(8, num(msg.y)));
    p.yaw = num(msg.yaw);
    p.speed = msg.s ? 9 : 0;
    p.lastMoveAt = now;
    clampWorld(p, 1);
  },
  f(p, msg) {   // fire
    if (p.dead || now < p.fireAt) return;
    const dx = num(msg.dx), dz = num(msg.dz), l = Math.hypot(dx, dz);
    if (!l) return;
    p.fireAt = now + 0.12;
    const ux = dx / l, uz = dz / l, x = p.x + ux * 0.8, z = p.z + uz * 0.8;
    bullets.push({ x, z, vx: ux * 34, vz: uz * 34, life: 1.1, owner: p.id, dmg: dmgMult(p.level, p.weapon) });
    emit({ k: 'shot', o: p.id, x: r2(x), z: r2(z), dx: r2(ux), dz: r2(uz) }, p.x, p.z);
  },
  d(p) {        // dash
    if (p.dead || now < p.dashCdAt) return;
    p.dashCdAt = now + 1.1;
    p.dashUntil = now + 0.25;
    p.dashSeq++;
  },
  u(p) {        // hyper-wave
    if (p.dead || p.energy < 100) return;
    p.energy = 0;
    const R = 13;
    emit({ k: 'ring', x: r2(p.x), z: r2(p.z), r: R }, p.x, p.z);
    for (const m of mobs) {
      if (m.dead) continue;
      const dx = m.x - p.x, dz = m.z - p.z, d = Math.hypot(dx, dz) || 1;
      if (d < R + m.r) damageMob(m, 8 * dmgMult(p.level, p.weapon), dx / d, dz / d, 22, p);
    }
    orbs = orbs.filter((o) => Math.hypot(o.x - p.x, o.z - p.z) > R);
  },
  b(p) {        // buy a weapon upgrade (town only)
    const cost = upgradeCost(p.weapon);
    if (p.dead || Math.hypot(p.x, p.z) > TOWN_R || p.gold < cost) return;
    p.gold -= cost;
    p.weapon++;
    p.events.push({ k: 'up', weapon: p.weapon });
  },
  c(p, msg) {   // chat
    const text = String(msg.m || '').trim().slice(0, 140);
    if (!text || now < p.chatAt) return;
    p.chatAt = now + 0.5;
    broadcast({ t: 'c', n: p.name, m: text });
  },
};

wss.on('connection', (ws) => {
  let p = null;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (!p) {
      if (msg.t !== 'join') return;
      let token = String(msg.token || '').slice(0, 64);
      // a second tab with the same token plays as an unsaved guest
      const dup = !token || [...players.values()].some((q) => q.token === token);
      const data = (!dup && saved[token]) || {};
      const name = String(msg.name || '').replace(/\s+/g, ' ').trim().slice(0, 16) || 'Cat';
      const level = data.level || 1;
      const a = rand(0, Math.PI * 2), r = rand(0, TOWN_R - 5);
      p = {
        id: nextId++, ws, token, persist: !dup, name,
        x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r, yaw: 0, speed: 0,
        level, xp: data.xp || 0, gold: data.gold || 0, weapon: data.weapon || 1, energy: 0,
        hp: maxHpFor(level), maxHp: maxHpFor(level), dead: false, deadUntil: 0,
        fireAt: 0, dashUntil: 0, dashCdAt: 0, dashSeq: 0, invulnUntil: 0, hurtAt: -99, chatAt: 0,
        lastMoveAt: now, events: [],
      };
      players.set(p.id, p);
      send(ws, { t: 'w', id: p.id, x: r2(p.x), z: r2(p.z) });
      sendRoster();
      broadcast({ t: 'c', sys: 1, m: `${p.name} joined the world` });
      return;
    }
    handlers[msg.t]?.(p, msg);
  });
  ws.on('close', () => {
    if (!p) return;
    persist(p);
    players.delete(p.id);
    sendRoster();
    broadcast({ t: 'c', sys: 1, m: `${p.name} left` });
  });
  ws.on('error', () => ws.close());
});

setInterval(tick, 1000 * TICK);
setInterval(flush, 30000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush(); process.exit(0); });

server.listen(PORT, () => console.log(`HyperCat MMO: http://localhost:${PORT}`));
