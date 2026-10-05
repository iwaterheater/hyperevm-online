import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createCat } from './cat.js';
import { createSkeleton, loadSkeletons, SKELETON_HEIGHT, BONE } from './skeleton.js';
import { createWorld } from './world.js';
import { CAST_TIME, METEOR, SWORD, WORLD_R, TOWN_R, ZONES, BOSS, MOB_TYPES, MOB_KEYS, xpNext, upgradeCost, zoneAt } from './shared.js';

const TEAL = 0x7fe8d6;
const FIRE = 0xffa040;
const ZONE_COLORS = [TEAL, 0x6fbf55, 0xb59a6a, 0xff5a70];   // town, meadows, graveyard, cursed lands
const OTHER_HOODIES = [0x3b4a7a, 0x7a3b5a, 0x7a5a2b, 0x4a3b7a, 0x2b6a7a, 0x7a2b2b, 0x4d4d57];
const glow = (hex, k = 2.5) => new THREE.Color(hex).multiplyScalar(k);
const css = (hex) => `#${hex.toString(16).padStart(6, '0')}`;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- renderer

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.id = 'view';
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 700);
camera.position.set(0, 1.2, 6.4);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.4, 0.4, 1.0));
composer.addPass(new OutputPass());

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

const world = createWorld(scene);
world.ready.catch((err) => console.error('Scenery models failed to load', err));

// ---------------------------------------------------------------- labels & bars

function textSprite(text, color = '#d5f5ee', height = 0.5) {
  const font = '700 44px ui-rounded, system-ui, sans-serif';
  const c = document.createElement('canvas');
  let g = c.getContext('2d');
  g.font = font;
  c.width = Math.ceil(g.measureText(text).width) + 24;
  c.height = 64;
  g = c.getContext('2d');   // resizing the canvas resets its state
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 8;
  g.strokeStyle = '#04110f';
  g.strokeText(text, c.width / 2, 34);
  g.fillStyle = color;
  g.fillText(text, c.width / 2, 34);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sprite.scale.set(height * c.width / c.height, height, 1);
  return sprite;
}

function disposeSprite(s) {
  s.removeFromParent();
  s.material.map.dispose();
  s.material.dispose();
}

const barBgMat = new THREE.SpriteMaterial({ color: 0x000000, transparent: true, opacity: 0.6, depthTest: false });
const barMats = new Map();
function makeBar(parent, y, width, color) {
  if (!barMats.has(color)) barMats.set(color, new THREE.SpriteMaterial({ color, depthTest: false }));
  const bg = new THREE.Sprite(barBgMat), fill = new THREE.Sprite(barMats.get(color));
  bg.position.y = y;
  bg.scale.set(width + 0.08, 0.2, 1);
  bg.renderOrder = 1;
  fill.center.set(0, 0.5);
  fill.position.set(-width / 2, y, 0);
  fill.renderOrder = 2;
  parent.add(bg, fill);
  return {
    set(frac, visible) {
      bg.visible = fill.visible = visible;
      fill.scale.set(Math.max(0.001, width * Math.max(0, Math.min(1, frac))), 0.12, 1);
    },
  };
}

// ---------------------------------------------------------------- audio

let actx = null, muted = false;
function sfx(freq, dur = 0.1, type = 'square', vol = 0.06, slide = 0) {
  if (!actx || muted) return;
  const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(actx.destination);
  o.start(t); o.stop(t + dur);
}

// ---------------------------------------------------------------- pools & particles

function makePool(create) {
  const free = [];
  return {
    get() { const o = free.pop() || create(); o.mesh.visible = true; return o; },
    release(o) { o.mesh.visible = false; free.push(o); },
  };
}

const sphereGeo = new THREE.SphereGeometry(1, 12, 8);
const meshPool = (geo, mat, scale) => makePool(() => {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.setScalar(scale);
  scene.add(mesh);
  return { mesh };
});
const bulletMat = new THREE.MeshBasicMaterial({ color: glow(TEAL, 3) });
const fireMat = new THREE.MeshBasicMaterial({ color: glow(FIRE, 3) });
const bulletPool = meshPool(sphereGeo, bulletMat, 0.32);
const orbPool = meshPool(sphereGeo, new THREE.MeshBasicMaterial({ color: glow(0xff3b6b, 3) }), 0.32);
const gemPool = meshPool(new THREE.OctahedronGeometry(0.28), new THREE.MeshBasicMaterial({ color: glow(0xffd76a, 1.8) }), 1);

const PMAX = 500;
const pMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), new THREE.MeshBasicMaterial(), PMAX);
pMesh.frustumCulled = false;
scene.add(pMesh);
const pData = Array.from({ length: PMAX }, () => ({ life: 0, max: 1, p: new THREE.Vector3(), v: new THREE.Vector3() }));
const dummy = new THREE.Object3D(), tmpColor = new THREE.Color();
let pNext = 0;
for (let i = 0; i < PMAX; i++) pMesh.setColorAt(i, tmpColor.set(0xffffff));

function burst(x, y, z, hex, n, speed = 6) {
  tmpColor.set(hex).multiplyScalar(2.2);
  for (let i = 0; i < n; i++) {
    const d = pData[pNext];
    d.p.set(x, y, z);
    d.v.set(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.4 + Math.random()));
    d.life = d.max = 0.35 + Math.random() * 0.4;
    pMesh.setColorAt(pNext, tmpColor);
    pNext = (pNext + 1) % PMAX;
  }
  pMesh.instanceColor.needsUpdate = true;
}

function updateParticles(dt) {
  for (let i = 0; i < PMAX; i++) {
    const d = pData[i];
    if (d.life > 0) {
      d.life -= dt;
      d.v.y -= 18 * dt;
      d.p.addScaledVector(d.v, dt);
      if (d.p.y < 0.08) { d.p.y = 0.08; d.v.y *= -0.4; }
      dummy.position.copy(d.p);
      dummy.scale.setScalar(Math.max(0, d.life / d.max));
    } else {
      dummy.scale.setScalar(0);
    }
    dummy.updateMatrix();
    pMesh.setMatrixAt(i, dummy.matrix);
  }
  pMesh.instanceMatrix.needsUpdate = true;
}

const rings = [];
const ringGeo = new THREE.RingGeometry(0.9, 1, 64);
function spawnRing(x, z, maxR, hex) {
  const mesh = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
    color: glow(hex, 1.8), transparent: true, side: THREE.DoubleSide, depthWrite: false,
  }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(x, 0.1, z);
  scene.add(mesh);
  rings.push({ mesh, t: 0, maxR });
}

// ---------------------------------------------------------------- avatars (cats)

function makeAvatar(hoodie) {
  const cat = createCat({ hoodie });
  const root = new THREE.Group();   // never rotates, so labels and bars stay screen-aligned
  root.add(cat.group);
  root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  const orb = new THREE.Mesh(sphereGeo, bulletMat);   // the bolt charging between the paws while casting
  orb.position.set(0, 1.0, 0.85);
  orb.visible = false;
  cat.group.add(orb);
  scene.add(root);
  return {
    root, cat, orb, swingT: -1, swingKind: 0, castT: -1, castDur: CAST_TIME, castSkill: 1, bar: makeBar(root, 2.75, 1.3, 0x6dffb0), label: null, labelKey: '',
    x: 0, y: 0, z: 0, yaw: 0, tx: 0, ty: 0, tz: 0, tyaw: 0,
    speed: 0, hp: 100, maxHp: 100, level: 1, dead: false, shootPose: 0,
  };
}

function setLabel(a, text, color) {
  if (a.labelKey === text) return;
  if (a.label) disposeSprite(a.label);
  a.labelKey = text;
  a.label = textSprite(text, color);
  a.label.position.y = 3.15;
  a.root.add(a.label);
}

function removeAvatar(a) {
  if (a.label) disposeSprite(a.label);
  scene.remove(a.root);
}

function lerpAngle(a, b, k) {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * k;
}

// ---------------------------------------------------------------- mobs

const lvlLabels = new Map();

const corpses = [];
function removeMobView(v) {
  scene.remove(v.root);
  v.skeleton.dispose();
}

function makeMobView(ti, lvl) {
  const type = MOB_KEYS[ti], def = MOB_TYPES[type];
  const root = new THREE.Group();   // never rotates, so the label and bar stay screen-aligned
  const skeleton = createSkeleton(type, def);
  root.add(skeleton.group);
  const top = SKELETON_HEIGHT * skeleton.group.scale.y + (type === 'shooter' ? 0.4 : 0);

  const text = type === 'boss' ? `Skeleton King · Lv ${lvl}` : `Lv ${lvl}`;
  if (!lvlLabels.has(text)) lvlLabels.set(text, textSprite(text, type === 'boss' ? '#ff8095' : '#f0e6d8', type === 'boss' ? 0.8 : 0.4));
  const proto = lvlLabels.get(text);
  const label = new THREE.Sprite(proto.material);   // material shared between mobs of the same level
  label.scale.copy(proto.scale);
  label.position.y = top + 0.75;
  root.add(label);

  root.scale.setScalar(0.01);
  scene.add(root);
  return {
    root, skeleton, label, def, top, bar: makeBar(root, top + 0.3, Math.max(1.2, def.r * 1.6), 0xff5577),
    x: 0, z: 0, tx: 0, tz: 0, hp: 1, maxHp: 1, flash: 0, age: 0, yaw: 0,
  };
}

// ---------------------------------------------------------------- game state

let state = 'menu';   // menu | connecting | playing | lost
let ws = null, myId = 0, time = 0, shake = 0, online = 1;
const names = new Map();
const others = new Map(), mobViews = new Map(), gemViews = new Map();
let bullets = [], orbs = [], meteors = [];

const me = makeAvatar();
me.z = 6;   // menu pose: on the plaza, in front of the fountain
const stats = { hp: 100, maxHp: 100, xp: 0, level: 1, gold: 0, weapon: 1, energy: 0, dead: false };
const local = {
  vy: 0, jumps: 0, invuln: 0, fireCd: 0, meteorCd: 0, swordCd: 0, combo: 0, dashT: 0, dashCd: 0, sendT: 0,
  dashDir: new THREE.Vector2(0, 1), aim: new THREE.Vector2(0, 1), zone: '',
};

const reticle = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.4, 32), new THREE.MeshBasicMaterial({ color: glow(TEAL, 2), transparent: true, opacity: 0.8 }));
reticle.rotation.x = -Math.PI / 2;
reticle.visible = false;
scene.add(reticle);

// the arc a sword swing leaves in the air
const slashes = [];
const slashGeo = new THREE.RingGeometry(1.2, SWORD.range + 0.3, 24, 1, -1.1, 2.2);
const chopGeo = new THREE.PlaneGeometry(SWORD.range, 0.4).translate(SWORD.range / 2 + 0.6, 0, 0);
// kind 0 / 1: horizontal arc revealed in the direction of the sweep; kind 2: a straight streak ahead
function spawnSlash(x, z, dx, dz, kind) {
  const mesh = new THREE.Mesh(kind === 2 ? chopGeo : slashGeo, new THREE.MeshBasicMaterial({ color: glow(0xffffff, 1.6), transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
  mesh.rotation.set(-Math.PI / 2, 0, Math.atan2(-dz, dx));
  mesh.position.set(x, 1.0, z);
  scene.add(mesh);
  slashes.push({ mesh, t: 0, kind, yaw: mesh.rotation.z });
}

// preview of where Starfall will land while it is being cast
const aoeMarker = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: glow(FIRE, 1.6), transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }));
aoeMarker.rotation.x = -Math.PI / 2;
aoeMarker.scale.setScalar(METEOR.radius);
aoeMarker.visible = false;
scene.add(aoeMarker);

let bannerTimer = 0;
function banner(text) {
  $('banner').textContent = text;
  $('banner').classList.add('on');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => $('banner').classList.remove('on'), 2000);
}

function chatLine(name, text, sys) {
  const div = document.createElement('div');
  if (sys) div.className = 'sys';
  if (name) {
    const b = document.createElement('b');
    b.textContent = `${name}: `;
    div.append(b);
  }
  div.append(text);
  const log = $('chatLog');
  log.append(div);
  while (log.children.length > 9) log.firstChild.remove();
}

// ---------------------------------------------------------------- network

const send = (msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

function getToken() {
  try {
    let t = localStorage.getItem('hypercat-token');
    if (!t) {
      t = Array.from({ length: 4 }, () => Math.random().toString(36).slice(2)).join('');
      localStorage.setItem('hypercat-token', t);
    }
    return t;
  } catch { return ''; }
}

async function connect() {
  if (state !== 'menu') return;
  if (!actx) { try { actx = new AudioContext(); } catch { /* no audio */ } }
  state = 'connecting';
  const name = $('nameInput').value.trim() || 'Cat';
  try { localStorage.setItem('hypercat-name', name); } catch { /* ignore */ }
  $('playBtn').textContent = 'Loading models…';
  try {
    await loadSkeletons();
  } catch (err) {
    console.error(err);
    state = 'menu';
    $('playBtn').textContent = 'Models failed to load — retry';
    return;
  }
  $('playBtn').textContent = 'Connecting…';
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => send({ t: 'join', name, token: getToken() });
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = () => {
    state = 'lost';
    $('lost').classList.remove('hidden');
    $('menu').classList.add('hidden');
    $('dead').classList.add('hidden');
    $('hud').classList.remove('on');
  };
}

function onMessage(msg) {
  if (msg.t === 'w') {
    myId = msg.id;
    me.x = msg.x; me.z = msg.z;
    state = 'playing';
    $('menu').classList.add('hidden');
    $('hud').classList.add('on');
    reticle.visible = true;
    document.activeElement?.blur();
    sfx(440, 0.25, 'triangle', 0.08, 440);
  } else if (msg.t === 'r') {
    names.clear();
    for (const [id, name] of msg.l) names.set(id, name);
  } else if (msg.t === 'c') {
    chatLine(msg.n, msg.m, msg.sys);
  } else if (msg.t === 's') {
    onSnapshot(msg);
  }
}

function syncViews(map, list, create, update, remove) {
  const seen = new Set();
  for (const row of list) {
    const id = row[0];
    seen.add(id);
    let v = map.get(id);
    if (!v) { v = create(row); map.set(id, v); }
    update(v, row);
  }
  for (const [id, v] of map) if (!seen.has(id)) { remove(v); map.delete(id); }
}

function onSnapshot(s) {
  online = s.n;
  const wasDead = stats.dead;
  Object.assign(stats, s.me, { dead: !!s.me.dead });
  if (stats.dead !== wasDead) $('dead').classList.toggle('hidden', !stats.dead);

  syncViews(others, s.p,
    ([id, x, y, z, yaw]) => {
      const a = makeAvatar(OTHER_HOODIES[id % OTHER_HOODIES.length]);
      Object.assign(a, { x, y, z, yaw });
      return a;
    },
    (a, [id, x, y, z, yaw, speed, hp, maxHp, level, dead]) => {
      Object.assign(a, { tx: x, ty: y, tz: z, tyaw: yaw, speed, hp, maxHp, level, dead: !!dead });
      setLabel(a, `${names.get(id) || 'Cat'} · Lv ${level}`);
    },
    removeAvatar);

  // a killed monster stays behind for its death animation instead of vanishing with the snapshot
  for (const ev of s.e) if (ev.k === 'kill' && mobViews.has(ev.id)) mobViews.get(ev.id).killed = true;
  syncViews(mobViews, s.m,
    ([, ti, lvl, x, z]) => Object.assign(makeMobView(ti, lvl), { x, z }),
    (v, [, , , x, z, hp, maxHp]) => Object.assign(v, { tx: x, tz: z, hp, maxHp }),
    (v) => {
      if (!v.killed) { removeMobView(v); return; }
      v.skeleton.die();
      v.skeleton.flash(0);
      v.bar.set(0, false);
      v.label.visible = false;
      corpses.push({ v, t: 0 });
    });

  syncViews(gemViews, s.g,
    ([, x, z]) => { const g = gemPool.get(); g.mesh.position.set(x, 0.55, z); return g; },
    () => {},
    (g) => gemPool.release(g));

  for (const ev of s.e) onEvent(ev);
}

function spawnProjectile(list, pool, x, z, dx, dz, speed, life) {
  const b = pool.get();
  b.mesh.position.set(x, 1, z);
  b.vx = dx * speed; b.vz = dz * speed; b.life = life;
  list.push(b);
}

function onEvent(ev) {
  switch (ev.k) {
    case 'shot':
      if (ev.o === myId) break;
      spawnProjectile(bullets, bulletPool, ev.x, ev.z, ev.dx, ev.dz, 34, 1.1);
      if (others.has(ev.o)) others.get(ev.o).shootPose = 0.25;
      break;
    case 'cast':
      if (ev.o !== myId && others.has(ev.o)) Object.assign(others.get(ev.o), { castT: 0, castDur: ev.d, castSkill: ev.s });
      break;
    case 'swing':
      if (ev.o === myId || !others.has(ev.o)) break;
      Object.assign(others.get(ev.o), { swingT: 0, swingKind: ev.c });
      spawnSlash(others.get(ev.o).x, others.get(ev.o).z, ev.dx, ev.dz, ev.c);
      break;
    case 'meteor': {
      const marker = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: glow(FIRE, 1.6), transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
      marker.rotation.x = -Math.PI / 2;
      marker.position.set(ev.x, 0.08, ev.z);
      marker.scale.setScalar(METEOR.radius);
      const star = new THREE.Mesh(sphereGeo, fireMat);
      star.scale.setScalar(0.7);
      scene.add(marker, star);
      meteors.push({ marker, star, t: 0, d: ev.d, x: ev.x, z: ev.z });
      sfx(900, ev.d, 'sawtooth', 0.04, -700);
      break;
    }
    case 'boom':
      spawnRing(ev.x, ev.z, ev.r, FIRE);
      burst(ev.x, 0.5, ev.z, FIRE, 45, 12);
      if (Math.hypot(ev.x - me.x, ev.z - me.z) < 25) shake = Math.max(shake, 0.5);
      sfx(70, 0.5, 'sawtooth', 0.12, -40);
      break;
    case 'orb':
      spawnProjectile(orbs, orbPool, ev.x, ev.z, ev.dx, ev.dz, 10, 3.5);
      break;
    case 'hit': {
      const v = mobViews.get(ev.id);
      if (v) { v.flash = 1; v.skeleton.hit(); burst(ev.x, v.top * 0.6, ev.z, BONE, 4, 5); }
      sfx(520, 0.05, 'square', 0.025);
      break;
    }
    case 'atk':
      mobViews.get(ev.id)?.skeleton.attack();
      break;
    case 'kill': {
      const r = ev.ti >= 0 ? MOB_TYPES[MOB_KEYS[ev.ti]].r : 0.7;
      burst(ev.x, r * 1.5, ev.z, ev.ti >= 0 ? BONE : 0xffffff, 16 + r * 14, 8);
      sfx(180, 0.18, 'sawtooth', 0.05, -120);
      break;
    }
    case 'ring':
      spawnRing(ev.x, ev.z, ev.r, TEAL);
      burst(ev.x, 1, ev.z, TEAL, 40, 14);
      sfx(90, 0.6, 'sawtooth', 0.1, 700);
      break;
    case 'lvlfx':
      spawnRing(ev.x, ev.z, 4, 0xffd76a);
      burst(ev.x, 1.5, ev.z, 0xffd76a, 30, 9);
      break;
    case 'lvl':
      banner(`Level ${ev.level}!`);
      sfx(523, 0.5, 'triangle', 0.09, 520);
      break;
    case 'up':
      banner(`Weapon upgraded · Lv ${ev.weapon}`);
      sfx(660, 0.3, 'triangle', 0.08, 400);
      break;
    case 'gem':
      sfx(1200, 0.08, 'sine', 0.05, 600);
      break;
    case 'hurt':
      local.invuln = 0.5;
      shake = 0.6;
      $('flash').style.opacity = 1;
      setTimeout(() => { $('flash').style.opacity = 0; }, 120);
      burst(me.x, me.y + 1, me.z, 0xff4d7a, 10, 6);
      sfx(140, 0.2, 'sawtooth', 0.09, -60);
      break;
    case 'tp':
      me.x = ev.x; me.z = ev.z; me.y = 0; local.vy = 0;
      break;
  }
}

// ---------------------------------------------------------------- input

const keys = new Set();
const mouse = new THREE.Vector2(0, -0.3);
let firing = false;
const typing = () => document.activeElement === $('chatInput') || document.activeElement === $('nameInput');

addEventListener('keydown', (e) => {
  if (e.code === 'Enter') {
    if (state === 'menu') { connect(); return; }
    if (state !== 'playing') return;
    const input = $('chatInput');
    if (document.activeElement === input) {
      if (input.value.trim()) send({ t: 'c', m: input.value });
      input.value = '';
      input.style.display = 'none';
      input.blur();
    } else {
      input.style.display = 'block';
      input.focus();
      keys.clear();
      firing = false;
    }
    return;
  }
  if (typing()) {
    if (e.code === 'Escape') { $('chatInput').style.display = 'none'; $('chatInput').blur(); }
    return;
  }
  if (e.repeat || state !== 'playing') return;
  keys.add(e.code);
  if (e.code === 'Space') { e.preventDefault(); jump(); }
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') dash();
  if (e.code === 'KeyQ' || e.code === 'KeyE') send({ t: 'u' });
  if (e.code === 'KeyB') send({ t: 'b' });
  if (e.code === 'KeyM') muted = !muted;
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); firing = false; });
addEventListener('mousemove', (e) => mouse.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1));
renderer.domElement.addEventListener('mousedown', (e) => {
  if (e.button === 0) firing = true;
  if (e.button === 2) send({ t: 'u' });
});
addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; });
addEventListener('contextmenu', (e) => e.preventDefault());
$('playBtn').addEventListener('click', connect);
$('reloadBtn').addEventListener('click', () => location.reload());
try { $('nameInput').value = localStorage.getItem('hypercat-name') || ''; } catch { /* ignore */ }
loadSkeletons().catch(() => {});   // start downloading models while the player is still in the menu

function jump() {
  if (local.jumps >= 2 || stats.dead) return;
  local.vy = local.jumps === 0 ? 11 : 9.5;
  local.jumps++;
  burst(me.x, me.y + 0.1, me.z, 0xffffff, 5, 3);
  sfx(local.jumps === 1 ? 380 : 520, 0.12, 'triangle', 0.06, 250);
}

const moveDir = new THREE.Vector2();
function dash() {
  if (local.dashCd > 0 || stats.dead) return;
  local.dashDir.copy(moveDir.lengthSq() > 0 ? moveDir : local.aim).normalize();
  local.dashT = 0.18;
  me.castT = -1;   // dashing interrupts a cast
  local.dashCd = 1.2;
  send({ t: 'd' });
  sfx(700, 0.15, 'sawtooth', 0.05, -500);
}

// ---------------------------------------------------------------- update

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const aimPoint = new THREE.Vector3();
const camTarget = new THREE.Vector3(0, 0.45, 0), camGoal = new THREE.Vector3(), lookGoal = new THREE.Vector3();

function updateLocal(dt) {
  local.dashCd -= dt;
  local.meteorCd -= dt;
  local.invuln -= dt;
  aoeMarker.visible = false;
  me.shootPose -= dt;
  if (stats.dead) { me.speed = 0; me.castT = -1; return; }

  raycaster.setFromCamera(mouse, camera);
  if (raycaster.ray.intersectPlane(groundPlane, aimPoint)) {
    const ax = aimPoint.x - me.x, az = aimPoint.z - me.z;
    if (ax * ax + az * az > 0.04) local.aim.set(ax, az).normalize();
    reticle.position.set(aimPoint.x, 0.06, aimPoint.z);
  }

  const k = (a, b) => (keys.has(a) || keys.has(b) ? 1 : 0);
  moveDir.set(k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft'), k('KeyS', 'ArrowDown') - k('KeyW', 'ArrowUp'));
  if (moveDir.lengthSq() > 0) moveDir.normalize();

  if (local.dashT > 0) {
    local.dashT -= dt;
    me.x += local.dashDir.x * 32 * dt;
    me.z += local.dashDir.y * 32 * dt;
    me.speed = 9;
    burst(me.x, me.y + 0.8, me.z, TEAL, 2, 2);
  } else if (me.castT >= 0) {
    me.speed = 0;   // rooted while casting
  } else {
    me.x += moveDir.x * 9 * dt;
    me.z += moveDir.y * 9 * dt;
    me.speed = moveDir.lengthSq() > 0 ? 9 : 0;
  }
  const d = Math.hypot(me.x, me.z), max = WORLD_R - 1;
  if (d > max) { me.x *= max / d; me.z *= max / d; }
  world.collide(me);

  local.vy -= 30 * dt;
  me.y += local.vy * dt;
  if (me.y <= 0) { me.y = 0; local.vy = 0; local.jumps = 0; }

  local.fireCd -= dt;
  // basic attack: sword swing on the left mouse button; the cat can keep moving
  local.swordCd -= dt;
  if (firing && local.swordCd <= 0 && me.castT < 0 && local.dashT <= 0) {
    local.swordCd = SWORD.cd;
    me.swingT = 0;
    me.swingKind = local.combo;            // combo: left-to-right, right-to-left, overhead chop
    local.combo = (local.combo + 1) % 3;
    spawnSlash(me.x, me.z, local.aim.x, local.aim.y, me.swingKind);
    send({ t: 'a', dx: local.aim.x, dz: local.aim.y, c: me.swingKind });
    sfx(300, 0.12, 'sawtooth', 0.04, 500);
  }

  // skills: hold 1 for Bolt, 2 for Starfall; both root the cat while channelling
  if (me.castT < 0 && local.fireCd <= 0 && local.dashT <= 0) {
    const skill = keys.has('Digit2') && local.meteorCd <= 0 ? 2 : keys.has('Digit1') ? 1 : 0;
    if (skill) {
      Object.assign(me, { castT: 0, castSkill: skill, castDur: skill === 2 ? METEOR.cast : CAST_TIME });
      send({ t: 'k', s: skill });
      sfx(skill === 2 ? 160 : 220, me.castDur, 'sine', 0.04, 500);
    }
  } else if (me.castT >= 0) {
    me.castT += dt;
    // Starfall lands on the cursor, limited to its range
    let tx = aimPoint.x - me.x, tz = aimPoint.z - me.z;
    const td = Math.hypot(tx, tz);
    if (td > METEOR.range) { tx *= METEOR.range / td; tz *= METEOR.range / td; }
    if (me.castSkill === 2) {
      aoeMarker.visible = true;
      aoeMarker.position.set(me.x + tx, 0.08, me.z + tz);
    }
    if (me.castT >= me.castDur) {
      me.castT = -1;
      local.fireCd = 0.08;
      me.shootPose = 0.25;
      if (me.castSkill === 2) {
        local.meteorCd = METEOR.cd;
        send({ t: 'q', x: me.x + tx, z: me.z + tz });
      } else {
        spawnProjectile(bullets, bulletPool, me.x + local.aim.x * 0.8, me.z + local.aim.y * 0.8, local.aim.x, local.aim.y, 34, 1.1);
        send({ t: 'f', dx: local.aim.x, dz: local.aim.y });
        sfx(660, 0.12, 'square', 0.04, -400);
      }
    }
  }

  me.yaw = lerpAngle(me.yaw, Math.atan2(local.aim.x, local.aim.y), Math.min(1, dt * 16));

  local.sendT -= dt;
  if (local.sendT <= 0) {
    local.sendT = 1 / 15;
    const r = (v) => Math.round(v * 100) / 100;
    send({ t: 'm', x: r(me.x), y: r(me.y), z: r(me.z), yaw: r(me.yaw), s: me.speed ? 1 : 0 });
  }

  const zone = zoneAt(d).name;
  if (zone !== local.zone) { local.zone = zone; banner(zone); }
}

function updateAvatar(a, dt, isMe) {
  if (!isMe) {
    const k = 1 - Math.exp(-12 * dt);
    a.x += (a.tx - a.x) * k; a.y += (a.ty - a.y) * k; a.z += (a.tz - a.z) * k;
    a.yaw = lerpAngle(a.yaw, a.tyaw, k);
    a.shootPose -= dt;
    if (a.castT >= 0 && (a.castT += dt) >= a.castDur) a.castT = -1;
    a.bar.set(a.hp / a.maxHp, !a.dead && a.hp < a.maxHp);
  }
  a.root.position.set(a.x, 0, a.z);
  a.cat.group.position.y = a.y;
  a.cat.group.rotation.y = a.yaw;
  if (a.swingT >= 0 && (a.swingT += dt / 0.4) >= 1) a.swingT = -1;
  const charge = a.castT >= 0 ? a.castT / a.castDur : 0;
  a.orb.visible = a.castT >= 0;
  a.orb.material = a.castSkill === 2 ? fireMat : bulletMat;
  a.orb.scale.setScalar(0.06 + charge * 0.26);
  a.cat.update(dt, { speed: a.speed, airborne: a.y > 0.05, shooting: a.shootPose > 0, dashing: isMe && local.dashT > 0, casting: a.castT >= 0, swing: a.swingT, swingKind: a.swingKind });
}

function updateViews(dt) {
  for (const a of others.values()) {
    updateAvatar(a, dt, false);
    a.root.visible = !a.dead;
  }

  const k = 1 - Math.exp(-10 * dt);
  for (const v of mobViews.values()) {
    const dx = v.tx - v.x, dz = v.tz - v.z;
    if (dx * dx + dz * dz > 0.0004) v.yaw = lerpAngle(v.yaw, Math.atan2(dx, dz), k);
    v.x += dx * k; v.z += dz * k;
    v.age += dt;
    v.root.position.set(v.x, 0, v.z);
    v.root.scale.setScalar(Math.min(1, v.age / 0.4));
    v.skeleton.group.rotation.y = v.yaw;
    // monsters far outside the camera's view are neither drawn nor animated
    v.root.visible = (v.x - me.x) ** 2 + (v.z - me.z) ** 2 < 55 * 55;
    if (v.root.visible) v.skeleton.update(dt, time, dx * dx + dz * dz > 0.01);
    v.flash = Math.max(0, v.flash - dt * 6);
    v.skeleton.flash(v.flash);
    v.bar.set(v.hp / v.maxHp, v.hp < v.maxHp);
  }

  // corpses play the death animation, then sink into the ground
  for (let j = corpses.length - 1; j >= 0; j--) {
    const c = corpses[j];
    c.t += dt;
    c.v.skeleton.update(dt, time, false);
    if (c.t > 1.8) c.v.root.position.y = -(c.t - 1.8) * 1.5 * c.v.skeleton.group.scale.y;
    if (c.t > 3) { removeMobView(c.v); corpses.splice(j, 1); }
  }

  let i = 0;
  for (const g of gemViews.values()) {
    g.mesh.rotation.y += dt * 3;
    g.mesh.position.y = 0.55 + Math.sin(time * 4 + i++) * 0.12;
  }

  // projectiles are simulated locally for looks; the server decides the damage
  bullets = bullets.filter((b) => {
    const m = b.mesh.position;
    m.x += b.vx * dt; m.z += b.vz * dt;
    b.life -= dt;
    let dead = b.life <= 0;
    for (const v of mobViews.values()) {
      const rr = v.def.r + 0.3;
      if ((v.x - m.x) ** 2 + (v.z - m.z) ** 2 < rr * rr) { dead = true; break; }
    }
    if (dead) bulletPool.release(b);
    return !dead;
  });
  orbs = orbs.filter((o) => {
    const m = o.mesh.position;
    m.x += o.vx * dt; m.z += o.vz * dt;
    o.life -= dt;
    const dead = o.life <= 0 || Math.hypot(m.x, m.z) < TOWN_R || (Math.hypot(m.x - me.x, m.z - me.z) < 0.7 && me.y < 1.4);
    if (dead) { burst(m.x, 1, m.z, 0xff3b6b, 4, 3); orbPool.release(o); }
    return !dead;
  });

  for (let j = slashes.length - 1; j >= 0; j--) {
    const s = slashes[j];
    s.t += dt / 0.2;
    s.mesh.scale.setScalar(0.85 + s.t * 0.25);
    // horizontal arcs travel across the front in the direction of the sweep
    if (s.kind !== 2) s.mesh.rotation.z = s.yaw + (s.kind === 1 ? -1 : 1) * (s.t - 0.5) * 0.9;
    s.mesh.material.opacity = 0.8 * (1 - s.t);
    if (s.t >= 1) { scene.remove(s.mesh); s.mesh.material.dispose(); slashes.splice(j, 1); }
  }

  meteors = meteors.filter((m) => {
    m.t += dt;
    const k = Math.min(1, m.t / m.d);
    m.star.position.set(m.x + (1 - k) * 7, (1 - k) * 22 + 0.5, m.z - (1 - k) * 4);
    m.marker.material.opacity = 0.4 + 0.5 * Math.abs(Math.sin(m.t * 25));
    if (k < 1) return true;
    scene.remove(m.marker, m.star);
    m.marker.material.dispose();
    return false;
  });

  for (let j = rings.length - 1; j >= 0; j--) {
    const r = rings[j];
    r.t += dt / 0.45;
    r.mesh.scale.setScalar(Math.max(0.01, r.t * r.maxR));
    r.mesh.material.opacity = 1 - r.t;
    if (r.t >= 1) { scene.remove(r.mesh); r.mesh.material.dispose(); rings.splice(j, 1); }
  }
}

function updateHud() {
  const need = xpNext(stats.level);
  $('who').textContent = `${names.get(myId) || 'Cat'} · Lv ${stats.level}`;
  $('hpFill').style.width = `${stats.hp / stats.maxHp * 100}%`;
  $('hpText').textContent = `${stats.hp} / ${stats.maxHp}`;
  $('xpFill').style.width = `${stats.xp / need * 100}%`;
  $('xpText').textContent = `${stats.xp} / ${need}`;
  $('enFill').style.width = `${stats.energy}%`;
  $('enFill').classList.toggle('full', stats.energy >= 100);
  $('enHint').textContent = stats.energy >= 100 ? 'press Q!' : '';
  $('dashFill').style.width = `${Math.max(0, Math.min(1, 1 - local.dashCd / 1.2)) * 100}%`;
  $('cast').style.display = me.castT >= 0 ? 'block' : 'none';
  $('castFill').style.width = `${Math.max(0, me.castT) / me.castDur * 100}%`;
  $('sk1').classList.toggle('active', me.castT >= 0 && me.castSkill === 1);
  $('sk2').classList.toggle('active', me.castT >= 0 && me.castSkill === 2);
  $('sk2cd').style.height = `${Math.max(0, local.meteorCd) / METEOR.cd * 100}%`;
  $('sk2time').textContent = local.meteorCd > 0 ? Math.ceil(local.meteorCd) : '';
  $('gold').textContent = stats.gold;
  $('weapon').textContent = `Lv ${stats.weapon}`;
  $('online').textContent = online;

  const inTown = Math.hypot(me.x, me.z) < TOWN_R;
  const cost = upgradeCost(stats.weapon);
  $('shop').style.display = inTown ? 'block' : 'none';
  if (inTown) {
    $('shop').textContent = stats.gold >= cost
      ? `B — upgrade weapon for ${cost} gold`
      : `Weapon upgrade: ${cost} gold (you have ${stats.gold})`;
  }
}

// Radar: the surroundings of the player; far landmarks stick to the rim.
const mapCtx = $('minimap').getContext('2d');
const RADAR_R = 75;
function drawMinimap() {
  const g = mapCtx, C = 144, RIM = 136, S = RIM / RADAR_R;
  g.clearRect(0, 0, 288, 288);
  g.save();
  g.beginPath(); g.arc(C, C, 140, 0, 7); g.clip();
  g.fillStyle = 'rgba(4, 20, 17, .85)';
  g.fillRect(0, 0, 288, 288);

  const ox = C - me.x * S, oz = C - me.z * S;   // world origin on the canvas
  g.lineWidth = 3;
  for (let i = 1; i < ZONES.length; i++) {
    g.strokeStyle = css(ZONE_COLORS[Math.min(i + 1, ZONE_COLORS.length - 1)]);
    g.globalAlpha = 0.5;
    g.beginPath(); g.arc(ox, oz, ZONES[i].r * S, 0, 7); g.stroke();
  }
  g.globalAlpha = 1;

  const dot = (x, z, r, color, pin) => {
    let px = (x - me.x) * S, pz = (z - me.z) * S;
    const d = Math.hypot(px, pz);
    if (d > RIM - 6) {
      if (!pin) return;
      px *= (RIM - 6) / d; pz *= (RIM - 6) / d;
    }
    g.fillStyle = color;
    g.beginPath(); g.arc(C + px, C + pz, r, 0, 7); g.fill();
  };
  g.fillStyle = 'rgba(127, 232, 214, .35)';
  g.beginPath(); g.arc(ox, oz, TOWN_R * S, 0, 7); g.fill();
  for (const v of mobViews.values()) dot(v.x, v.z, v.def.r * 4 + 2, css(v.def.color));
  for (const gem of gemViews.values()) dot(gem.mesh.position.x, gem.mesh.position.z, 3, '#ffd76a');
  dot(BOSS.x, BOSS.z, 8, '#ff2244', true);
  dot(0, 0, 8, '#7fe8d6', true);          // town
  for (const a of others.values()) dot(a.x, a.z, 6, '#ffffff');
  g.fillStyle = '#ffffff';
  g.beginPath(); g.arc(C, C, 7, 0, 7); g.fill();
  g.fillStyle = '#35523f';
  g.beginPath(); g.arc(C, C, 4, 0, 7); g.fill();
  g.restore();
}

function updateCamera(dt) {
  if (state === 'playing') {
    lookGoal.set(me.x, 1, me.z);
    camGoal.set(me.x, 13.5, me.z + 10);
  } else {
    camGoal.set(me.x, 1.2, me.z + 6.4);
    lookGoal.set(me.x, 0.45, me.z);
  }
  const k = 1 - Math.exp(-5 * dt);
  camera.position.lerp(camGoal, k);
  camTarget.lerp(lookGoal, k);
  shake = Math.max(0, shake - dt * 2.5);
  camera.position.x += (Math.random() - 0.5) * shake * 0.5;
  camera.position.y += (Math.random() - 0.5) * shake * 0.5;
  camera.lookAt(camTarget);
}

const clock = new THREE.Clock();
let mapT = 0;
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  time += dt;
  world.update(time, me.x, me.z);

  if (state === 'playing') {
    updateLocal(dt);
    updateViews(dt);
    updateHud();
    if ((mapT -= dt) <= 0) { mapT = 0.15; drawMinimap(); }
  } else {
    me.yaw = Math.sin(time * 0.6) * 0.7;
  }
  updateParticles(dt);
  updateAvatar(me, dt, true);
  me.bar.set(0, false);
  me.root.visible = !stats.dead && !(local.invuln > 0 && Math.sin(time * 40) > 0.3);
  updateCamera(dt);

  composer.render();
  requestAnimationFrame(frame);
}
frame();

// debugging hook
window.__game = { me, stats, others, mobViews, send, world, get state() { return state; } };
