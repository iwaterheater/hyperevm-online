import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  WORLD_R, TOWN_R, TICK, ATTACK_WINDUP, ZONES, BOSS, FORT_R, CHESTS, CHEST_REACH, BLACKSMITH, SAGE, near as nearNpc,
  MOB_TYPES, MOB_KEYS, CLASSES, CLASS_KEYS, START_CLASSES, PROFESSION_LEVEL, SKILLS, skillsFor, classLine, statsOf,
  xpNext, spFor, DEATH_XP_LOSS, dmgMult, upgradeCost,
} from './src/shared.js';

const PORT = process.env.PORT || 8765;
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SAVE_FILE = path.join(ROOT, 'data', 'players.json');
const VIEW_R = 65;

// ---------------------------------------------------------------- static files

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.png': 'image/png',
};
const PUBLIC = ['/src/', '/assets/'];

const server = http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { url = ''; }
  if (url === '/') url = '/index.html';
  const file = path.join(ROOT, url);
  if ((url !== '/index.html' && !PUBLIC.some((dir) => url.startsWith(dir))) || !file.startsWith(ROOT + path.sep)) {
    res.writeHead(404).end('Not found');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    // code is always re-fetched; models are large and never change, so browsers may keep them
    const cache = url.startsWith('/assets/') ? 'public, max-age=86400' : 'no-cache';
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache });
    res.end(data);
  });
});

// ---------------------------------------------------------------- persistence

let saved = {};
try { saved = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8')); } catch { /* first run */ }

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

let nextId = 1, now = 0;
const players = new Map();
const mobs = [];
const mobById = new Map();
let bullets = [], orbs = [], gems = [], blasts = [];
const chests = CHESTS.map((c, i) => ({ ...c, i, openUntil: 0 }));

const rand = (a, b) => a + Math.random() * (b - a);
const r2 = (v) => Math.round(v * 100) / 100;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const CLEAN = { kx: 0, kz: 0, target: 0, swing: null, stunUntil: 0, sleepUntil: 0, slowUntil: 0, slowMult: 1, dot: null };

function makeMob(type, lvl, sx, sz) {
  const def = MOB_TYPES[type];
  const maxHp = Math.ceil(def.hp * (1 + 0.45 * (lvl - 1)));
  const mob = {
    id: nextId++, type, ti: MOB_KEYS.indexOf(type), lvl, def, r: def.r, sx, sz, x: sx, z: sz,
    hp: maxHp, maxHp, dmg: Math.round(def.dmg * (1 + 0.15 * (lvl - 1))), xp: def.xp * lvl,
    fireT: rand(1, 3), hitAt: 0, wx: sx, wz: sz, wanderAt: 0,
    dead: false, respawnAt: 0, dmgBy: new Set(), dashHit: '', strafe: Math.random() < 0.5 ? 1 : -1, ...CLEAN,
  };
  mobs.push(mob);
  mobById.set(mob.id, mob);
}

function spawnRing(count, rMin, rMax, lMin, lMax, types) {
  for (let i = 0; i < count; i++) {
    const a = rand(0, Math.PI * 2), r = Math.sqrt(rand(rMin * rMin, rMax * rMax));
    const lvl = Math.round(lMin + (lMax - lMin) * (r - rMin) / (rMax - rMin));
    if (Math.hypot(Math.cos(a) * r - BOSS.x, Math.sin(a) * r - BOSS.z) < FORT_R + 4) continue;   // the fortress belongs to the King
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

// ---------------------------------------------------------------- characters

// Recomputes the stats that follow from class, level and passive skills.
function refresh(p) {
  p.st = statsOf(p.cls, p.level, p.skills);
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

const buff = (p, stat) => { const b = p.buffs[stat]; return b && now < b.until ? b.mult : 1; };
const scale = (p) => dmgMult(p.level, p.weapon) * buff(p, 'atk');
function physical(p, power) {
  const crit = Math.random() < p.st.crit;
  return { dmg: power * p.st.patk * buff(p, 'patk') * scale(p) * (crit ? 2 : 1), crit };
}
const magical = (p, power) => ({ dmg: power * p.st.matk * scale(p), crit: false });

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
  m.hp -= hit.dmg;
  m.sleepUntil = 0;   // any damage wakes a sleeping monster
  m.dmgBy.add(p.id);
  if (!m.target) m.target = p.id;
  m.kx += dx * knock / m.r; m.kz += dz * knock / m.r;
  const ev = { id: m.id, x: r2(m.x), z: r2(m.z), o: p.id, d: r2(hit.dmg), c: hit.crit ? 1 : 0 };
  if (m.hp > 0) { emit({ k: 'hit', ...ev }, m.x, m.z); return; }

  m.dead = true;
  m.respawnAt = now + (m.type === 'boss' ? 90 : 14);
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

function hurtPlayer(p, dmg) {
  if (p.dead || now < p.dashUntil || now < p.invulnUntil) return;
  p.hp -= dmg / (p.st.pdef * buff(p, 'pdef'));
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
  const a = rand(0, Math.PI * 2), r = rand(0, TOWN_R - 4);
  p.x = Math.cos(a) * r; p.z = Math.sin(a) * r; p.y = 0;
  p.hp = p.maxHp;
  p.mp = p.maxMp;
  p.dead = false;
  p.lastMoveAt = now;
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

  // a melee swing: the monster plants its feet, and the hit lands after the wind-up if the target is still close
  if (m.swing) {
    speed = 0;
    if (now >= m.swing.at) {
      const p = players.get(m.swing.pid);
      if (p && Math.hypot(p.x - m.x, p.z - m.z) < m.r + 1.5 && p.y < m.r * 2 + 0.2) hurtPlayer(p, m.dmg);
      m.swing = null;
    }
  }

  m.x += (mx * speed + m.kx) * dt;
  m.z += (mz * speed + m.kz) * dt;
  m.kx *= damp; m.kz *= damp;
  clampWorld(m, m.r);
  const d = Math.hypot(m.x, m.z), min = TOWN_R + m.r + 0.5;   // the town is a safe zone
  if (d < min) { m.x *= min / (d || 1); m.z *= min / (d || 1); }

  for (const p of players.values()) {
    if (p.dead) continue;
    const dx = p.x - m.x, dz = p.z - m.z, dist = Math.hypot(dx, dz) || 0.001;
    if (dist > m.r + 1.1 || p.y > m.r * 2 + 0.2) continue;
    if (now < p.dashUntil) {
      const key = `${p.id}:${p.dashSeq}`;
      if (m.dashHit !== key) {
        m.dashHit = key;
        damageMob(m, physical(p, 3), -dx / dist, -dz / dist, 14, p);
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
    // regeneration: fast in town, slow in the field, and much faster while sitting down to rest
    const inTown = Math.hypot(p.x, p.z) < TOWN_R, resting = p.sit && now - p.hurtAt > 2;
    if (inTown) p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.2 * dt);
    else if (resting) p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.05 * dt);
    else if (now - p.hurtAt > 6) p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.012 * dt);
    p.mp = Math.min(p.maxMp, p.mp + p.maxMp * (inTown ? 0.08 : resting ? 0.06 : 0.015) * dt);
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
      applyEffects(m, b, p);
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
        if (d < b.radius + m.r) damageMob(m, b.phys ? physical(p, b.power) : magical(p, b.power), dx / d, dz / d, 10, p);
      }
    }
    return false;
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
      c.openUntil = now + (c.big ? 300 : 150);
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
        buffs: Object.entries(p.buffs).filter(([, b]) => now < b.until).map(([stat, b]) => [stat, Math.ceil(b.until - now)]),
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

const wss = new WebSocketServer({ server, maxPayload: 2048 });

// What each kind of skill does once its cost and cooldown have been checked. Returns false to refuse the cast.
const SKILL_EFFECTS = {
  strike(p, s, R, m) {
    if (!m || m.dead) return false;
    const dx = m.x - p.x, dz = m.z - p.z, d = Math.hypot(dx, dz) || 0.001;
    if (d > CLASSES[p.cls].reach + m.r + 1.2) return false;
    damageMob(m, physical(p, s.power[R]), dx / d, dz / d, 7, p);
    applyEffects(m, { stun: s.stun?.[R], dot: s.dot && s.dot[R] * p.st.patk * scale(p), dotDur: s.dotDur }, p);
  },
  shot(p, s, R, m) { return SKILL_EFFECTS.bolt(p, s, R, m); },
  bolt(p, s, R, m) {
    if (!m || m.dead || Math.hypot(m.x - p.x, m.z - p.z) > s.range + 3) return false;   // a little slack for lag
    bullets.push({
      x: p.x, z: p.z, target: m.id, life: 2.5, owner: p.id, speed: s.kind === 'shot' ? 42 : 34,
      hit: s.kind === 'shot' ? physical(p, s.power[R]) : magical(p, s.power[R]),
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
      const amount = Math.round(s.power[R] * (0.5 + 0.5 * p.st.matk) * (1 + 0.06 * (p.level - 1)));
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
    if (Math.hypot(x - p.x, z - p.z) > 36 * elapsed + 3) {
      p.events.push({ k: 'tp', x: r2(p.x), z: r2(p.z) });
      p.lastMoveAt = now;
      return;
    }
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
    p.swingAt = now + c.atkCd * 0.85;
    const kind = [0, 1, 2].includes(msg.c) ? msg.c : 2;   // which of the three swing animations to show
    emit({ k: 'swing', o: p.id, dx: r2(dx / d), dz: r2(dz / d), c: kind }, p.x, p.z);
    if (c.ranged) {
      bullets.push({ x: p.x, z: p.z, target: m.id, life: 2.5, owner: p.id, speed: 42, hit: physical(p, c.hit) });
      emit({ k: 'shot', o: p.id, id: m.id, x: r2(p.x), z: r2(p.z), fx: 'arrow' }, p.x, p.z);
    } else {
      damageMob(m, physical(p, c.hit), dx / d, dz / d, 5, p);
    }
  },
  k(p, msg) {   // started casting: only tells nearby players to play the animation
    const s = SKILLS[msg.s];
    if (p.dead || now < p.castAt || !s || !p.skills[msg.s]) return;
    p.castAt = now + 0.3;
    emit({ k: 'cast', o: p.id, s: msg.s, d: s.cast || 0 }, p.x, p.z);
  },
  sk(p, msg) {   // use a skill
    const id = String(msg.s), s = SKILLS[id], rank = p.skills[id] | 0;
    if (p.dead || !s || !rank || s.kind === 'passive' || !classLine(p.cls).includes(s.cls)) return;
    if (now < (p.cds[id] || 0) || p.mp < s.mp) return;
    const m = mobById.get(msg.tid);
    if (SKILL_EFFECTS[s.kind](p, s, rank - 1, m, msg) === false) return;
    p.mp -= s.mp;
    p.sit = false;
    p.cds[id] = now + Math.max(s.cd, (s.cast || 0) * 0.85, 0.3) - 0.1;
    emit({ k: 'skill', o: p.id, s: id, tid: m ? m.id : 0, x: r2(num(msg.x)), z: r2(num(msg.z)) }, p.x, p.z);
  },
  learn(p, msg) {   // buy the next rank of a skill from the Sage
    const id = String(msg.s), s = SKILLS[id], rank = p.skills[id] | 0;
    if (p.dead || !s || !nearNpc(p, SAGE) || !classLine(p.cls).includes(s.cls)) return;
    if (p.level < s.lvl || rank >= s.sp.length || p.sp < s.sp[rank]) return;
    p.sp -= s.sp[rank];
    p.skills[id] = rank + 1;
    refresh(p);
    p.events.push({ k: 'learned', s: id, rank: rank + 1 });
  },
  prof(p, msg) {   // choose a profession at the Sage
    const target = String(msg.cls);
    if (p.dead || !CLASSES[target] || CLASSES[target].base !== p.cls || p.level < PROFESSION_LEVEL || !nearNpc(p, SAGE)) return;
    p.cls = target;
    grantFree(p);
    refresh(p);
    p.hp = p.maxHp;
    p.mp = p.maxMp;
    p.events.push({ k: 'prof', cls: target });
    emit({ k: 'lvlfx', x: r2(p.x), z: r2(p.z) }, p.x, p.z);
    broadcast({ t: 'c', sys: 1, m: `${p.name} is now a ${CLASSES[target].name}` });
  },
  b(p) {        // buy a weapon upgrade from the blacksmith
    const cost = upgradeCost(p.weapon);
    if (p.dead || !nearNpc(p, BLACKSMITH) || p.gold < cost) return;
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
      // the class picked in the menu only counts for characters that do not have one yet
      const cls = CLASSES[data.cls] ? data.cls : START_CLASSES.includes(msg.cls) ? msg.cls : START_CLASSES[0];
      const a = rand(0, Math.PI * 2), r = rand(0, TOWN_R - 5);
      p = {
        id: nextId++, ws, token, persist: !dup, name, cls,
        x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r, yaw: 0, speed: 0,
        level, xp: Math.min(data.xp || 0, xpNext(level) - 1), sp: data.sp || 0, skills: { ...(data.skills || {}) },
        gold: data.gold || 0, weapon: data.weapon || 1,
        hp: Infinity, mp: Infinity, buffs: {}, cds: {}, sit: false, dead: false, deadUntil: 0,
        castAt: 0, swingAt: 0, dashUntil: 0, dashSeq: 0, invulnUntil: 0, hurtAt: -99, chatAt: 0,
        lastMoveAt: now, events: [],
      };
      grantFree(p);
      refresh(p);   // also brings health and mana down to their maximum
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
