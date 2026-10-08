// One bot: a cat that plays the game through the same WebSocket a browser uses, by the same rules. It hunts monsters
// of its level, rests, drinks potions, goes back to town to sell, buy, learn skills and have its weapon upgraded -
// and, when its role says so, fights other cats (see ROLES). Nothing here is known to the server: a bot is a player.
//
// A bot thinks ten times a second (tick). It keeps its own position, as a browser does, walks at the speed of its
// character over the grid of bots/nav.mjs, and never walks through what blocks a player.
import {
  MOB_KEYS, MOB_TYPES, CLASSES, PROFESSION_LEVEL, SKILLS, skillsFor, activeSkills, statsOf, castTime, professionsOf,
  ITEMS, itemOf, SHOP, SHOP_RANGE, BAG_SIZE, POTION_CD, upgradeCost, equipError, heldFamily, fightStyle, handsOf,
  CAT_R, PVP_PEACE, PVP_OUTLAW,
} from '../src/shared.js';
import { isSafe } from '../src/map/format.js';

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

// How a bot stands towards other cats.
//   aggro  'pk'    attacks cats that have done nothing to it, and kills them: a murderer, soon an outlaw
//          'duel'  challenges cats of about its level and lets go of one that will not fight; hunts outlaws
//          'guard' attacks outlaws only
//   brave  fights back when another cat attacks it (the others run for the town)
//   reach  how many levels above its own a cat may be and still be attacked
export const ROLES = {
  farmer:   { aggro: null,    brave: false, reach: 0 },
  veteran:  { aggro: null,    brave: true,  reach: 0 },
  guard:    { aggro: 'guard', brave: true,  reach: 6 },
  duelist:  { aggro: 'duel',  brave: true,  reach: 3 },
  pk:       { aggro: 'pk',    brave: true,  reach: 2 },
};

// What a bot says, by the moment. A line is said rarely (see World.say in run.mjs), so the chat stays a chat.
export const LINES = {
  hello: ['hi all', 'o/', 'hey', 'hello', 'back again'],
  level: ['ding!', 'finally', 'level up :)', 'one more level'],
  bye: ['brb', 'gotta go, cya', 'afk a bit'],
  challenge: ['fight me', 'duel?', 'come on, 1v1', 'lets see what you got'],
  spare: ['not worth it', 'fight back next time', 'ok ok, go'],
  won: ['gg', 'good fight', 'ez', 'gg wp'],
  murder: ['wrong place, wrong time', 'nothing personal', 'boo', 'mine now'],
  lost: ['gg', 'ouch', 'ok that hurt', 'next time'],
  murdered: ['really?', 'why...', 'i was just farming', 'not cool'],
  justice: ['no outlaws here', 'red names get hunted'],
};

export class Bot {
  // world: what all bots share - { map, rev, nav, url, bots (the names of all of them), say(bot, kind), log(bot, text) }
  // spec:  { name, cls, lvl, cap?, role, family?, prof? } - one line of the roster
  constructor(world, spec) {
    this.world = world;
    this.spec = spec;
    this.role = ROLES[spec.role] ?? ROLES.farmer;
    this.ws = null;
    this.reset();
  }

  reset() {
    this.id = 0; this.t = 0; this.joined = false;
    this.pos = { x: 0, z: 0 }; this.yaw = 0; this.moving = false; this.sitting = false;
    this.me = null; this.inv = []; this.eq = {}; this.sheet = null; this.sheetKey = '';
    this.mobs = new Map(); this.cats = new Map(); this.names = new Map();
    this.foe = 0; this.foeUntil = 0; this.foeHitBack = false; this.duel = false;
    this.hurtBy = null; this.grudges = new Map(); this.avoid = new Map();
    this.pause = 0; this.swingAt = 0; this.skillAt = 0; this.potionAt = 0; this.cds = {}; this.cast = null; this.combo = 0;
    this.path = null; this.stuck = { x: 0, z: 0, at: 0 }; this.walkedAt = -9;
    this.camp = null; this.campUntil = 0; this.emptySince = 0; this.roam = null;
    this.errand = null; this.todo = []; this.todoAt = 0; this.checkAt = 0; this.resting = false; this.loiter = 0;
    this.sendAt = 0; this.bagChanged = false; this.lastTarget = 0;
  }

  // ---------------------------------------------------------------- the wire

  connect(WebSocket) {
    this.reset();
    const ws = this.ws = new WebSocket(this.world.url.replace(/^http/, 'ws'));
    ws.on('open', () => this.send({
      t: 'join', name: this.spec.name, cls: CLASSES[this.spec.cls].base ?? this.spec.cls, rev: this.world.rev,
      token: `bot-${this.spec.name.toLowerCase()}`, bot: { lvl: this.spec.lvl, cls: this.spec.cls, family: this.spec.family, cap: this.spec.cap },
    }));
    ws.on('message', (data) => { try { this.receive(JSON.parse(data)); } catch (err) { this.world.log(this, `message failed: ${err.stack}`); } });
    ws.on('close', () => { this.joined = false; this.world.left(this, ws); });
    ws.on('error', () => {});
  }
  disconnect() { this.ws?.close(); }
  send(msg) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg)); }

  receive(msg) {
    if (msg.t === 'w') {
      this.id = msg.id; this.pos = { x: msg.x, z: msg.z }; this.joined = true;
      this.pause = rand(1.5, 5);   // a moment to look around
      this.world.joined(this);
    } else if (msg.t === 'map') this.world.mapChanged(msg.rev);
    else if (msg.t === 'r') { this.names.clear(); for (const [id, name] of msg.l) this.names.set(id, name); }
    else if (msg.t === 'c') this.world.heard(this, msg);
    else if (msg.t === 's') this.snapshot(msg);
  }

  snapshot(s) {
    this.me = s.me;
    if (s.me.inv) { this.inv = s.me.inv; this.bagChanged = true; }
    if (s.me.eq) this.eq = s.me.eq;
    const key = [s.me.cls, s.me.level, s.me.weapon, JSON.stringify(s.me.skills), JSON.stringify(s.me.buffs), JSON.stringify(this.eq)].join('|');
    if (key !== this.sheetKey) {
      this.sheetKey = key;
      this.sheet = statsOf(s.me.cls, s.me.level, s.me.skills, s.me.weapon, Object.fromEntries(s.me.buffs.map(([stat, , mult]) => [stat, mult])), this.eq);
    }
    this.mobs.clear();
    for (const [id, ti, lvl, x, z, hp, maxHp, flags] of s.m) this.mobs.set(id, { id, type: MOB_KEYS[ti], lvl, x, z, hp, maxHp, flags, r: MOB_TYPES[MOB_KEYS[ti]].r });
    this.cats.clear();
    for (const [id, x, , z, , , hp, maxHp, level, dead, , , , st = 0, cc = 0] of s.p) {
      const name = this.names.get(id) || 'Cat';
      this.cats.set(id, { id, x, z, hp, maxHp, level, dead: !!dead, st, cc, name, bot: this.world.bots.has(name) });
    }
    for (const ev of s.e) this.event(ev);
  }

  event(ev) {
    if (ev.k === 'tp') { this.pos = { x: ev.x, z: ev.z }; this.path = null; }
    else if (ev.k === 'hurt') {
      this.sitting = false; this.resting = false;
      if (ev.o) {   // another cat did this
        this.hurtBy = { id: ev.o, at: this.t };
        if (ev.o === this.foe) { this.foeHitBack = true; this.foeUntil = this.t + 30; }   // the fight is on: it goes on
      }
    } else if (ev.k === 'lvl') {
      this.world.log(this, `reached level ${ev.level}`);
      this.world.say(this, 'level', 0.5);
    } else if (ev.k === 'pvp') {   // this bot has brought another cat down
      this.world.log(this, `${ev.pk ? 'murdered' : 'defeated'} ${ev.n}`);
      this.grudges.set(this.foe, this.t + rand(240, 420));   // that one is left alone for a while
      this.endFight();
      this.pause = this.t + rand(1, 3);
      this.world.say(this, ev.pk ? 'murder' : 'won', 0.7);
    } else if (ev.k === 'died') {
      this.world.log(this, ev.by ? `was brought down by ${ev.by}` : 'died');
      if (ev.by) this.world.say(this, this.foe ? 'lost' : 'murdered', 0.6);
      this.endFight(); this.errand = null; this.todo = []; this.cast = null; this.path = null; this.camp = null;
      this.pause = this.t + rand(7, 14);   // the respawn, and a moment to curse
    }
  }

  // ---------------------------------------------------------------- what it knows

  get map() { return this.world.map; }
  get nav() { return this.world.nav; }
  get hp() { return this.me.hp / this.me.maxHp; }
  get mp() { return this.me.mp / this.me.maxMp; }
  get style() { return fightStyle(this.me.cls, heldFamily(this.me.cls, this.eq)); }
  get family() { return this.spec.family ?? heldFamily(this.me.cls, this.eq); }
  count(kind) { return this.inv.reduce((n, [id, c]) => n + (ITEMS[id]?.[kind] ? c : 0), 0); }
  safe(p = this.pos) { return isSafe(this.map, p.x, p.z); }
  npc(kind) { return this.map.npcs.find((n) => n.kind === kind); }
  skills() { return activeSkills(this.me.cls, this.me.skills); }

  // whether wearing the item would be a step up from what is worn in its slot
  better(id) {
    const it = itemOf(id);
    if (!it?.slot || equipError(this.me.cls, this.me.level, id)) return false;
    if (it.slot === 'weapon' && it.family !== this.family) return false;
    if (it.slot === 'offhand' && (handsOf(this.family) !== 1 || this.family !== 'sword')) return false;
    const worn = itemOf(this.eq[it.slot]);
    return !worn || it.tier > worn.tier;
  }
  // the skills the Sage would teach it right now
  learnable() {
    return skillsFor(this.me.cls).filter((id) => {
      const s = SKILLS[id], rank = this.me.skills[id] | 0;
      return this.me.level >= s.lvl && rank < s.sp.length && this.me.sp >= s.sp[rank];
    });
  }
  // what the Trader has that it would wear and can pay for, the dearest first
  affordable() {
    const owned = (id) => this.inv.some(([have]) => have === id);   // bought a moment ago, not worn yet
    return SHOP.filter((id) => this.better(id) && !owned(id) && ITEMS[id].price <= this.me.gold - 30).sort((a, b) => ITEMS[b].price - ITEMS[a].price);
  }

  // ---------------------------------------------------------------- one thought

  tick(dt) {
    this.t += dt;
    const me = this.me;
    if (!this.joined || !me || !this.sheet) return;
    if (me.dead) { this.moving = false; this.sitting = false; return; }
    if (me.cc & 3) { this.moving = false; this.report(); return; }   // stunned or asleep
    if (this.cast) {   // standing still, gathering a spell
      if (this.t >= this.cast.at) {
        const { s, tid, x, z } = this.cast;
        this.send({ t: 'sk', s, tid, x, z });
        this.cast = null;
      }
      this.moving = false; this.report();
      return;
    }
    this.housekeeping();
    if (this.t < this.pause) { this.moving = false; this.report(); return; }
    const goal = this.choose();
    if (goal.fight) this.fight(goal.fight, dt);
    else if (goal.go) { if (!this.walk(goal.go, dt, goal.near ?? 0.6)) this.noWay(); }
    else { this.moving = false; this.sitting = !!goal.sit; }
    this.report();
  }

  // drinks a potion in time, and wears what is better than what it has on
  housekeeping() {
    if (this.t >= this.potionAt) {
      const want = this.hp < 0.38 ? 'hp' : this.mp < 0.15 && this.caster() ? 'mp' : null;
      const i = want ? this.inv.findIndex(([id]) => ITEMS[id]?.[want]) : -1;
      if (i >= 0) { this.send({ t: 'use', i, id: this.inv[i][0] }); this.potionAt = this.t + POTION_CD + rand(0.2, 0.8); }
    }
    if (this.bagChanged && !this.foe) {
      this.bagChanged = false;
      const i = this.inv.findIndex(([id]) => this.better(id));
      if (i >= 0) { this.send({ t: 'eq', i, id: this.inv[i][0] }); this.bagChanged = true; }
    }
  }
  caster() { return this.skills().some((id) => SKILLS[id].kind === 'bolt'); }

  // -> { fight: id } | { go: { x, z }, near } | { sit } | {} : what to do now
  choose() {
    const me = this.me, safe = this.safe();
    // 1. another cat has attacked
    const by = this.hurtBy && this.t - this.hurtBy.at < 12 ? this.cats.get(this.hurtBy.id) : null;
    if (by && !by.dead && !safe && this.foe !== by.id) {
      if ((this.role.brave || by.level <= me.level - 3) && this.hp > 0.3) this.startFight(by.id, false);
      else return this.flee();
    }
    // 2. the fight it is in
    if (this.foe) {
      const c = this.cats.get(this.foe);
      const over = !c || c.dead || this.t > this.foeUntil || safe || this.safe(c);
      // a duelist lets go of a cat that never raised a paw
      const spared = c && this.duel && !this.foeHitBack && c.st === PVP_PEACE && c.hp / c.maxHp < 0.4;
      if (spared) this.world.say(this, 'spare', 0.8);
      if (over || spared) { this.grudges.set(this.foe, this.t + rand(240, 420)); this.endFight(); }
      else if (this.hp < 0.2 && !this.count('hp')) return this.flee();
      else return { fight: this.foe };
    }
    // 3. too hurt to go on: back to safety
    if (this.hp < 0.22 && !this.count('hp') && !safe) return this.flee();
    // 4. a cat worth attacking
    if (this.role.aggro && !safe && this.hp > 0.6 && !this.errand) {
      const victim = this.victim();
      if (victim) { this.startFight(victim.id, true); return {}; }
    }
    // 5. a monster that is on it is dealt with before anything else
    const close = this.nearestMob((m) => dist(m, this.pos) < m.r + 3.2);
    if (close) return this.engage(close);
    // 6. things to do in town
    if (this.errand || this.needsTown()) return this.town();
    // 7. a rest
    if (this.resting ? this.hp < 0.9 || (this.caster() && this.mp < 0.6) : this.hp < 0.45 || (this.caster() && this.mp < 0.2)) {
      this.resting = true;
      return { sit: true };
    }
    this.resting = false;
    return this.hunt();
  }

  // ---------------------------------------------------------------- other cats

  // the cat this bot would attack now, by its role; none most of the time
  victim() {
    const me = this.me, aggro = this.role.aggro;
    let best = null, bestScore = Infinity;
    for (const c of this.cats.values()) {
      if (c.dead || this.safe(c) || dist(c, this.pos) > 24 || this.t < (this.grudges.get(c.id) ?? 0)) continue;
      if (c.level > me.level + this.role.reach) continue;
      let wanted = c.st === PVP_OUTLAW && aggro !== 'pk';   // every fighter hunts an outlaw; outlaws leave each other be
      // a murderer wants a cat that can at least try to fight back, not one far below it; a duelist one of its own
      // level that is on its feet - a duel with the half dead is no duel
      if (aggro === 'pk') wanted = c.st !== PVP_OUTLAW && c.level >= Math.max(2, me.level - 4);
      if (aggro === 'duel' && !wanted) wanted = Math.abs(c.level - me.level) <= 3 && c.level >= 3 && c.hp / c.maxHp > 0.7;
      if (!wanted) continue;
      // Among themselves the bots fight seldom - an outlaw aside - so that the world is not one long brawl: a bot that
      // is passed over is left alone for some minutes.
      if (c.bot && c.st !== PVP_OUTLAW && Math.random() > 0.25) { this.grudges.set(c.id, this.t + rand(180, 400)); continue; }
      const score = dist(c, this.pos) + (c.bot ? 12 : 0);
      if (score < bestScore) { bestScore = score; best = c; }
    }
    return best;
  }
  startFight(id, mine) {
    const c = this.cats.get(id);
    this.foe = id; this.foeUntil = this.t + 45; this.foeHitBack = !mine;
    this.duel = mine && this.role.aggro === 'duel' && c?.st === PVP_PEACE;
    this.resting = false; this.sitting = false; this.errand = null; this.todo = []; this.path = null;
    this.pause = this.t + rand(0.3, 0.9);   // nobody reacts at once
    if (mine) {
      this.world.log(this, `goes for ${c?.name}`);
      if (this.duel) this.world.say(this, 'challenge', 0.7);
      else if (c?.st === PVP_OUTLAW) this.world.say(this, 'justice', 0.4);
    }
  }
  endFight() { this.foe = 0; this.duel = false; this.foeHitBack = false; this.path = null; }
  flee() {
    this.endFight(); this.resting = false;
    if (this.safe()) return { sit: this.hp < 0.9 };
    return { go: this.map.start, near: 2 };
  }

  // ---------------------------------------------------------------- fighting

  nearestMob(ok) {
    let best = null, bestD = Infinity;
    for (const m of this.mobs.values()) {
      const d = dist(m, this.pos);
      if (d < bestD && m.type !== 'boss' && this.t >= (this.avoid.get(m.id) ?? 0) && ok(m)) { bestD = d; best = m; }
    }
    return best;
  }
  // turns on a monster: with a moment's delay when it is a new one, as a person needs to notice it
  engage(m) {
    if (m.id !== this.lastTarget) { this.lastTarget = m.id; this.pause = this.t + rand(0.25, 0.8); this.path = null; }
    this.resting = false; this.sitting = false;
    return { fight: m.id };
  }

  fight(id, dt) {
    const tv = this.mobs.get(id) || this.cats.get(id);
    if (!tv) { if (id === this.foe) this.endFight(); this.moving = false; return; }
    const me = this.me, isCat = this.cats.has(id), r = isCat ? CAT_R : tv.r, style = this.style, d = dist(tv, this.pos);
    this.sitting = false;
    // from how far it fights: a bow and a spell from a distance, a blade from arm's length
    const bolt = this.skills().find((s) => SKILLS[s].kind === 'bolt' && me.mp >= SKILLS[s].mp);
    const range = style.ranged ? style.reach * 0.8 : bolt ? SKILLS[bolt].range * 0.7 : style.reach + r - 0.5;
    if (d > range || !this.nav.clear(this.pos.x, this.pos.z, tv.x, tv.z) && d > style.reach + r) {
      if (!this.walk(tv, dt, range * 0.9) && !isCat) this.avoid.set(id, this.t + 25);   // it cannot be reached: another one, then
      return;
    }
    this.moving = false;
    this.yaw = Math.atan2(tv.x - this.pos.x, tv.z - this.pos.z);
    if (this.t >= this.skillAt && this.useSkill(tv, d, r, isCat)) return;
    if (this.t >= this.swingAt && (style.ranged || d <= style.reach + r + 0.3)) {
      this.send({ t: 'a', id, c: this.combo });
      this.combo = (this.combo + 1) % 3;
      this.swingAt = this.t + this.sheet.atkCd * rand(1.02, 1.2);
    } else if (!style.ranged && !bolt && d > style.reach + r) this.walk(tv, dt, style.reach + r - 0.5);
  }

  // Uses the best skill that is ready, if any: the later ones in the table - the stronger ones - first.
  useSkill(tv, d, r, isCat) {
    const me = this.me;
    for (const id of this.skills().reverse()) {
      const s = SKILLS[id];
      if (this.t < (this.cds[id] ?? 0) || me.mp < s.mp) continue;
      let ok = false, at = null;
      if (s.kind === 'strike') ok = d <= this.style.reach + r + 0.4;
      else if (s.kind === 'shot' || s.kind === 'bolt') ok = d <= s.range - 1;
      else if (s.kind === 'ground') { ok = !isCat && d <= s.range - 1; at = tv; }
      else if (s.kind === 'heal') ok = this.hp < 0.55;
      else if (s.kind === 'buff') ok = !me.buffs.some(([stat]) => stat === s.stat);
      if (!ok) continue;
      const time = castTime(s, this.sheet), msg = { s: id, tid: tv.id, x: at?.x, z: at?.z };
      this.cds[id] = this.t + time + Math.max(s.cd, 0.4);
      this.skillAt = this.t + time + rand(0.6, 1.6);   // a person does not press every key at once
      if (time > 0) { this.send({ t: 'k', s: id }); this.cast = { ...msg, at: this.t + time }; }
      else this.send({ t: 'sk', ...msg });
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- hunting

  hunt() {
    const me = this.me;
    if (!this.camp || this.t > this.campUntil) this.pickCamp();
    const c = this.camp;
    if (!c) return {};
    const m = this.nearestMob((mob) => mob.lvl <= me.level + 2 && (dist(mob, c) < c.r + 22 || dist(mob, this.pos) < 12));
    if (m) { this.emptySince = this.t; return this.engage(m); }
    if (dist(c, this.pos) > c.r * 0.5 + 4) return { go: c, near: c.r * 0.4 + 2 };
    if (this.t - this.emptySince > 30) { this.camp = null; return {}; }   // hunted out: somewhere else, then
    // waiting for the monsters to come back: a few steps now and then
    if (!this.roam || this.t > this.roam.until) {
      const a = rand(0, Math.PI * 2), far = rand(2, c.r * 0.7 + 3);
      this.roam = { ...(this.nav.nearestFree(c.x + Math.cos(a) * far, c.z + Math.sin(a) * far) ?? c), until: this.t + rand(4, 10) };
    }
    return dist(this.roam, this.pos) > 1.5 ? { go: this.roam } : {};
  }

  // A camp whose monsters are about its level: the nearest of those that fit, more or less - not always the same one.
  pickCamp() {
    const L = this.me.level, here = this.pos;
    const camps = this.map.spawns.filter((s) => !s.types.boss && s !== this.camp).map((s) => {
      const over = Math.max(0, s.lvl[1] - L - 1), under = Math.max(0, L - 2 - s.lvl[1]);   // too dangerous, or too easy to be worth it
      return { s, score: over * 40 + under * 12 + dist(s, here) * 0.15 + rand(0, 14) };
    }).sort((a, b) => a.score - b.score);
    this.camp = camps.find(({ s }) => this.nav.path(here.x, here.z, s.x, s.z))?.s ?? null;
    this.campUntil = this.t + rand(400, 900);
    this.emptySince = this.t;
    this.roam = null;
    if (this.camp) this.world.log(this, `heads for the camp at ${Math.round(this.camp.x)}, ${Math.round(this.camp.z)} (level ${this.camp.lvl.join(' - ')})`, true);
  }

  // ---------------------------------------------------------------- the town

  // looked at every few seconds: is there a reason to go back?
  needsTown() {
    if (this.t < this.checkAt) return false;
    this.checkAt = this.t + rand(4, 8);
    const me = this.me, visits = [];
    const gear = this.affordable().length > 0, potions = this.count('hp') < 2 && me.gold >= 40, full = this.inv.length >= BAG_SIZE - 5;
    if (gear || potions || full) visits.push('trader');
    if (this.learnable().length || (me.level >= PROFESSION_LEVEL && !CLASSES[me.cls].base)) visits.push('sage');
    // the Blacksmith: on the way when it is in town anyway, and a trip of its own once the purse is heavy
    const spare = me.gold - upgradeCost(me.weapon);
    if (me.weapon < 2 + Math.floor(me.level / 3) && (spare >= 250 || (spare >= 80 && visits.length))) visits.push('blacksmith');
    if (!visits.length) return false;
    this.errand = { visits: visits.filter((kind) => this.npc(kind)), at: null };
    this.world.log(this, `goes to town: ${this.errand.visits.join(', ')}`, true);
    return this.errand.visits.length > 0;
  }

  town() {
    const e = this.errand;
    if (this.todo.length) {   // at a counter: one thing at a time, as fast as a person clicks
      if (this.t >= this.todoAt) { this.todo.shift()(); this.todoAt = this.t + rand(0.5, 1.3); }
      return {};
    }
    if (!e.visits.length) {   // done: a breather in town, now and then, and off again
      if (!e.done) { e.done = true; this.loiter = this.t + (Math.random() < 0.4 ? rand(8, 40) : rand(1, 4)); }
      if (this.t < this.loiter) return { sit: this.loiter - this.t > 6 };
      this.errand = null;
      return {};
    }
    const kind = e.visits[0], npc = this.npc(kind);
    if (dist(npc, this.pos) > SHOP_RANGE - 1.5) {
      // a free spot beside the townsman; one that turns out to be too far from him is given up for another, a few times
      if (e.at && dist(e.at, this.pos) <= 1.2 && dist(npc, this.pos) > SHOP_RANGE - 0.3) { e.at = null; e.tries = (e.tries | 0) + 1; }
      if (e.tries > 5) { e.visits.shift(); e.tries = 0; return {}; }   // he cannot be reached today
      if (!e.at) {
        const spot = this.nav.nearestFree(npc.x + rand(-2.5, 2.5), npc.z + rand(-2.5, 2.5));
        if (spot && dist(spot, npc) < SHOP_RANGE - 0.5 && this.nav.path(this.pos.x, this.pos.z, spot.x, spot.z)) e.at = spot;
        else { e.tries = (e.tries | 0) + 1; return {}; }
      }
      if (dist(e.at, this.pos) > 1.2) return { go: e.at, near: 1 };
    }
    e.visits.shift(); e.at = null; e.tries = 0;
    this.todoAt = this.t + rand(0.8, 2);
    if (kind === 'trader') this.atTrader();
    else if (kind === 'sage') this.atSage();
    else this.todo.push(() => { if (this.me.gold >= upgradeCost(this.me.weapon)) this.send({ t: 'b' }); });
    return {};
  }

  // Sells what it will not wear, buys what it will, and stocks up on potions. Every step looks at the bag as it is
  // then: the step before it has changed it.
  atTrader() {
    const sell = () => {
      const i = this.inv.findIndex(([id]) => ITEMS[id].slot && !this.better(id));
      if (i < 0) return;
      this.send({ t: 'sell', i, id: this.inv[i][0], n: 1 });
      this.todo.unshift(sell);   // and the next one
    };
    const buy = () => {
      const id = this.affordable()[0];
      if (!id) return;
      this.send({ t: 'buy', id, n: 1 });
      this.todo.unshift(buy);
    };
    const stock = (kind, want) => () => {
      const id = `${kind}_${this.me.level >= 12 && this.me.gold > 400 ? 'large' : 'small'}`;
      const n = Math.min(want - this.count(kind), Math.floor((this.me.gold - 20) / ITEMS[id].price));
      if (n > 0) this.send({ t: 'buy', id, n });
    };
    this.todo.push(sell, buy, sell, stock('hp', 6));   // the second sale: what the new gear has replaced
    if (this.caster()) this.todo.push(stock('mp', 4));
  }
  atSage() {
    const learn = () => {
      const id = this.learnable().sort((a, b) => SKILLS[a].sp[this.me.skills[a] | 0] - SKILLS[b].sp[this.me.skills[b] | 0])[0];
      if (!id) return;
      this.send({ t: 'learn', s: id });
      this.todo.unshift(learn);
    };
    this.todo.push(() => {
      const options = professionsOf(this.me.cls);
      if (this.me.level >= PROFESSION_LEVEL && options.length) this.send({ t: 'prof', cls: options.includes(this.spec.prof) ? this.spec.prof : pick(options) });
    }, learn);
  }

  // ---------------------------------------------------------------- walking

  // There is no way to where it wanted to go, or it has not come a step nearer for seconds: it wants something else.
  // A townsman is tried from another side (a few times, see town); a camp or a spot to stroll to is given up.
  noWay() {
    this.path = null; this.roam = null;
    if (this.errand) { this.errand.at = null; this.errand.tries = (this.errand.tries | 0) + 1; }
    else this.camp = null;
  }

  // A step towards a point: straight when the way is clear, else along a path around what blocks it.
  // -> false when there is no way there.
  walk(to, dt, near = 0.6) {
    const p = this.pos;
    if (dist(to, p) <= near) { this.moving = false; return true; }
    let aim = to;
    if (!this.nav.clear(p.x, p.z, to.x, to.z)) {
      const stale = !this.path || dist(this.path.to, to) > 3 || this.t - this.path.at > 5;
      if (stale) this.path = { to: { x: to.x, z: to.z }, at: this.t, points: this.nav.path(p.x, p.z, to.x, to.z) };
      const points = this.path.points;
      if (!points) { this.moving = false; return false; }
      while (points.length > 1 && dist(points[0], p) < 0.8) points.shift();
      aim = points[0] ?? to;
    } else this.path = null;
    const d = dist(aim, p), step = Math.min(d, this.sheet.move * (this.me.slow || 1) * dt);
    const nx = p.x + (aim.x - p.x) / d * step, nz = p.z + (aim.z - p.z) / d * step;
    p.x = nx; p.z = nz;   // the line to `aim` was found clear, or is a leg of a path: the grid keeps its distance from what blocks
    this.yaw = Math.atan2(aim.x - p.x, aim.z - p.z);
    this.moving = true; this.sitting = false;
    // standing on one spot though it means to walk - for seconds on end, not after a halt: the place is given up
    if (dist(this.stuck, p) > 1 || this.t - this.walkedAt > 0.5) this.stuck = { x: p.x, z: p.z, at: this.t };
    this.walkedAt = this.t;
    if (this.t - this.stuck.at <= 6) return true;
    this.stuck.at = this.t;
    return false;
  }

  // tells the server where it is, as a browser does fifteen times a second
  report() {
    if (this.t < this.sendAt) return;
    this.sendAt = this.t + 1 / 12;
    const r2 = (v) => Math.round(v * 100) / 100;
    this.send({ t: 'm', x: r2(this.pos.x), y: 0, z: r2(this.pos.z), yaw: r2(this.yaw), s: this.moving ? 1 : 0, st: this.sitting && !this.moving ? 1 : 0 });
  }
}
