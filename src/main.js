import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createCat } from './cat.js';
import { createSkeleton, loadSkeletons, SKELETON_HEIGHT, BONE } from './skeleton.js';
import { createWorld } from './world.js';
import { createNpcs } from './npc.js';
import { CAST_TIME, BOLT_RANGE, BOLT_MP, METEOR, SWORD, WORLD_R, TOWN_R, ZONES, BOSS, BLACKSMITH, SHOP_RANGE, CHESTS, MOB_TYPES, MOB_KEYS, xpNext, upgradeCost, zoneAt } from './shared.js';

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

let npcs = null;
createNpcs(scene, textSprite, world.block).then((n) => { npcs = n; }, (err) => console.error('Townsfolk failed to load', err));

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
// dropped gold: a glowing placeholder until the coin model has loaded, then a spinning coin
let gemLook = { geo: new THREE.OctahedronGeometry(0.28), mat: new THREE.MeshBasicMaterial({ color: glow(0xffd76a, 1.8) }) };
const gemMeshes = [];
const gemPool = makePool(() => {
  const mesh = new THREE.Mesh(gemLook.geo, gemLook.mat);
  scene.add(mesh);
  gemMeshes.push(mesh);
  return { mesh };
});

// ---------------------------------------------------------------- chests & coins (KayKit Dungeon Remastered)

const chestViews = [];   // index-aligned with CHESTS; filled when the models arrive
{
  const loader = new GLTFLoader();
  Promise.all(['chest', 'chest_gold', 'coin'].map((n) => loader.loadAsync(`./assets/dungeon/${n}.glb`))).then(([chest, gold, coin]) => {
    CHESTS.forEach((c, i) => {
      const model = (c.big ? gold : chest).scene.clone(true);
      model.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      const root = new THREE.Group();
      root.add(model);
      root.position.set(c.x, 0, c.z);
      // roadside chests face the road, the King's hoard faces the fortress gate
      root.rotation.y = c.big ? 0 : Math.abs(c.x) < Math.abs(c.z) ? Math.atan2(-Math.sign(c.x), 0) : Math.atan2(0, -Math.sign(c.z));
      root.scale.setScalar(c.big ? 2 : 1.3);
      scene.add(root);
      chestViews[i] = { root, lid: model.getObjectByName(c.big ? 'chest_gold_lid' : 'chest_lid'), open: false };
    });
    let coinMesh = null;
    coin.scene.traverse((o) => { if (o.isMesh) coinMesh = o; });
    gemLook = { geo: coinMesh.geometry.clone().rotateX(Math.PI / 2).scale(2.2, 2.2, 2.2), mat: coinMesh.material };
    for (const m of gemMeshes) { m.geometry = gemLook.geo; m.material = gemLook.mat; }
  }, (err) => console.error('Chest models failed to load', err));
}

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
    speed: 0, hp: 100, maxHp: 100, level: 1, dead: false, sitting: false, shootPose: 0,
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
    root, skeleton, label, def, lvl, top, bar: makeBar(root, top + 0.3, Math.max(1.2, def.r * 1.6), 0xff5577),
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
const stats = { hp: 100, maxHp: 100, mp: 60, maxMp: 60, xp: 0, level: 1, gold: 0, weapon: 1, energy: 0, dead: false };
const local = {
  vy: 0, jumps: 0, invuln: 0, fireCd: 0, meteorCd: 0, swordCd: 0, combo: 0, dashT: 0, dashCd: 0, sendT: 0,
  dashDir: new THREE.Vector2(0, 1), aim: new THREE.Vector2(0, 1), zone: '',
};

// ring on the ground under the selected monster: yellow when selected, red while attacking it
const targetRing = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
targetRing.rotation.x = -Math.PI / 2;
targetRing.visible = false;
scene.add(targetRing);

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
    (a, [id, x, y, z, yaw, speed, hp, maxHp, level, dead, sit]) => {
      Object.assign(a, { tx: x, ty: y, tz: z, tyaw: yaw, speed, hp, maxHp, level, dead: !!dead, sitting: !!sit });
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

  const open = new Set(s.c);
  chestViews.forEach((v, i) => { v.open = open.has(i); });

  for (const ev of s.e) onEvent(ev);
}

// a bolt that homes in on a monster; purely visual, the server decides the damage
function spawnBolt(x, z, id) {
  const b = bulletPool.get();
  b.mesh.position.set(x, 1.1, z);
  b.id = id;
  bullets.push(b);
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
      spawnBolt(ev.x, ev.z, ev.id);
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
    case 'open': {
      const c = CHESTS[ev.i];
      burst(c.x, 1.2, c.z, 0xffd76a, c.big ? 60 : 24, 7);
      sfx(520, 0.25, 'triangle', 0.07, 520);
      break;
    }
    case 'chest':
      banner(`+${ev.gold} gold`);
      break;
    case 'gem':
      sfx(1200, 0.08, 'sine', 0.05, 600);
      break;
    case 'hurt':
      if (!targetId) setTarget(nearbyMobs(6)[0] || 0, false);   // being hit selects the attacker
      me.sitting = false;
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
const typing = () => document.activeElement === $('chatInput') || document.activeElement === $('nameInput');

// orbit camera: drag with the right mouse button to turn it, wheel to zoom
const cam = { yaw: 0, pitch: 0.9, dist: 16.5, drag: null };
// combat: the selected monster, and whether the cat is auto-attacking it
let targetId = 0, attacking = false;

let noticeTimer = 0;
function notice(text) {
  $('notice').textContent = text;
  $('notice').classList.add('on');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => $('notice').classList.remove('on'), 1300);
}

// the monster under the cursor, if any
const pickV = new THREE.Vector3();
function pickMob(clientX, clientY) {
  let best = 0, bestD = Infinity;
  for (const [id, v] of mobViews) {
    if (!v.root.visible || v.killed) continue;
    pickV.set(v.x, v.top * 0.5, v.z);
    const pixelsPerUnit = innerHeight / (0.89 * camera.position.distanceTo(pickV));   // 0.89 = 2 * tan(fov / 2)
    pickV.project(camera);
    if (pickV.z > 1) continue;
    const d = Math.hypot((pickV.x + 1) / 2 * innerWidth - clientX, (1 - pickV.y) / 2 * innerHeight - clientY);
    if (d < Math.max(26, v.top * 0.6 * pixelsPerUnit) && d < bestD) { bestD = d; best = id; }
  }
  return best;
}

function setTarget(id, attack) {
  targetId = id;
  attacking = !!id && attack;
  if (attacking) me.sitting = false;
}

// monsters within reach of Tab, nearest first
function nearbyMobs(range) {
  const list = [];
  for (const [id, v] of mobViews) {
    const d = Math.hypot(v.x - me.x, v.z - me.z);
    if (d < range && !v.killed) list.push([d, id]);
  }
  return list.sort((a, b) => a[0] - b[0]).map((e) => e[1]);
}

function attackKey() {
  if (!targetId) setTarget(nearbyMobs(26)[0] || 0, true);
  else attacking = !attacking;
  if (!targetId) notice('No monsters nearby');
  else if (attacking) me.sitting = false;
}

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
    }
    return;
  }
  if (typing()) {
    if (e.code === 'Escape') { $('chatInput').style.display = 'none'; $('chatInput').blur(); }
    return;
  }
  if (state !== 'playing') return;
  if (e.code === 'Tab') e.preventDefault();
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'Space') { e.preventDefault(); jump(); }
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') dash();
  if (e.code === 'Tab') {   // next monster, nearest first
    const list = nearbyMobs(40);
    if (list.length) setTarget(list[(list.indexOf(targetId) + 1) % list.length], false);
  }
  if (e.code === 'Escape') setTarget(0, false);
  if (e.code === 'KeyF') attackKey();
  if (e.code === 'KeyX' && !stats.dead && me.castT < 0) { me.sitting = !me.sitting; if (me.sitting) attacking = false; }
  if (e.code === 'KeyQ' || e.code === 'KeyE') send({ t: 'u' });
  if (e.code === 'KeyB') send({ t: 'b' });
  if (e.code === 'KeyM') muted = !muted;
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); cam.drag = null; });
addEventListener('mousemove', (e) => {
  mouse.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  if (!cam.drag) return;
  cam.yaw -= e.movementX * 0.006;
  cam.pitch = Math.max(0.3, Math.min(1.45, cam.pitch + e.movementY * 0.004));
  cam.drag.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
});
renderer.domElement.addEventListener('mousedown', (e) => {
  if (state !== 'playing') return;
  if (e.button === 2) { cam.drag = { moved: 0, x: e.clientX, y: e.clientY }; return; }
  if (e.button !== 0) return;
  // left click: select a monster; clicking the selected one again starts the attack
  const id = pickMob(e.clientX, e.clientY);
  if (id) setTarget(id, id === targetId);
});
addEventListener('mouseup', (e) => {
  if (e.button !== 2 || !cam.drag) return;
  // a right click without dragging attacks the monster under the cursor
  if (cam.drag.moved < 6 && state === 'playing') {
    const id = pickMob(cam.drag.x, cam.drag.y);
    if (id) setTarget(id, true);
  }
  cam.drag = null;
});
renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  cam.dist = Math.max(7, Math.min(30, cam.dist * Math.exp(e.deltaY * 0.0012)));
}, { passive: false });
addEventListener('contextmenu', (e) => e.preventDefault());
$('playBtn').addEventListener('click', connect);
$('reloadBtn').addEventListener('click', () => location.reload());
try { $('nameInput').value = localStorage.getItem('hypercat-name') || ''; } catch { /* ignore */ }
loadSkeletons().catch(() => {});   // start downloading models while the player is still in the menu

function jump() {
  if (local.jumps >= 2 || stats.dead) return;
  me.sitting = false;
  local.vy = local.jumps === 0 ? 11 : 9.5;
  local.jumps++;
  burst(me.x, me.y + 0.1, me.z, 0xffffff, 5, 3);
  sfx(local.jumps === 1 ? 380 : 520, 0.12, 'triangle', 0.06, 250);
}

const moveDir = new THREE.Vector2();
function dash() {
  if (local.dashCd > 0 || stats.dead) return;
  // dash where the cat is going, or straight ahead when standing still
  if (moveDir.lengthSq() > 0) local.dashDir.copy(moveDir).normalize();
  else local.dashDir.set(Math.sin(me.yaw), Math.cos(me.yaw));
  local.dashT = 0.18;
  me.castT = -1;   // dashing interrupts a cast
  me.sitting = false;
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
  local.swordCd -= dt;
  local.fireCd -= dt;
  local.invuln -= dt;
  aoeMarker.visible = false;
  me.shootPose -= dt;

  let tv = mobViews.get(targetId);
  if (targetId && (!tv || tv.killed)) { setTarget(0, false); tv = null; }   // the target died or walked out of view
  if (stats.dead) { me.speed = 0; me.castT = -1; me.sitting = false; attacking = false; return; }

  raycaster.setFromCamera(mouse, camera);
  raycaster.ray.intersectPlane(groundPlane, aimPoint);   // where Starfall will land

  // WASD moves relative to the camera
  const k = (a, b) => (keys.has(a) || keys.has(b) ? 1 : 0);
  const ix = k('KeyD', 'ArrowRight') - k('KeyA', 'ArrowLeft'), iz = k('KeyS', 'ArrowDown') - k('KeyW', 'ArrowUp');
  const sin = Math.sin(cam.yaw), cos = Math.cos(cam.yaw);
  moveDir.set(ix * cos + iz * sin, -ix * sin + iz * cos);
  const manual = moveDir.lengthSq() > 0;
  if (manual) { moveDir.normalize(); me.sitting = false; }

  // direction and distance to the target
  let tdx = 0, tdz = 0, tDist = Infinity, inReach = false;
  if (tv) {
    tdx = tv.x - me.x; tdz = tv.z - me.z;
    tDist = Math.hypot(tdx, tdz) || 0.001;
    tdx /= tDist; tdz /= tDist;
    inReach = tDist < SWORD.range + tv.def.r;
  }
  if (tDist > 50 && tv) { setTarget(0, false); tv = null; }   // too far away to stay locked on
  // auto-attack: with no keys held the cat runs up to its target by itself
  if (attacking && tv && !manual && !inReach && me.castT < 0) moveDir.set(tdx, tdz);
  const moving = moveDir.lengthSq() > 0;

  if (local.dashT > 0) {
    local.dashT -= dt;
    me.x += local.dashDir.x * 32 * dt;
    me.z += local.dashDir.y * 32 * dt;
    me.speed = 9;
    burst(me.x, me.y + 0.8, me.z, TEAL, 2, 2);
  } else if (me.castT >= 0 || me.sitting) {
    me.speed = 0;   // rooted while casting or resting
  } else {
    me.x += moveDir.x * 9 * dt;
    me.z += moveDir.y * 9 * dt;
    me.speed = moving ? 9 : 0;
  }
  const d = Math.hypot(me.x, me.z), max = WORLD_R - 1;
  if (d > max) { me.x *= max / d; me.z *= max / d; }
  world.collide(me);

  local.vy -= 30 * dt;
  me.y += local.vy * dt;
  if (me.y <= 0) { me.y = 0; local.vy = 0; local.jumps = 0; }

  // ... and swings whenever the sword is ready and the target is within reach
  if (attacking && tv && inReach && local.swordCd <= 0 && me.castT < 0 && local.dashT <= 0) {
    local.swordCd = SWORD.cd;
    me.swingT = 0;
    me.swingKind = local.combo;            // combo: left-to-right, right-to-left, overhead chop
    local.combo = (local.combo + 1) % 3;
    spawnSlash(me.x, me.z, tdx, tdz, me.swingKind);
    send({ t: 'a', id: targetId, c: me.swingKind });
    sfx(300, 0.12, 'sawtooth', 0.04, 500);
  }

  // skills: 1 = Bolt at the target, 2 = Starfall at the cursor; both cost mana and root the cat while channelling
  if (me.castT < 0 && local.fireCd <= 0 && local.dashT <= 0) {
    let skill = 0;
    if (keys.has('Digit2')) {
      if (local.meteorCd > 0) notice('Starfall is not ready yet');
      else if (stats.mp < METEOR.mp) notice('Not enough mana');
      else skill = 2;
    } else if (keys.has('Digit1')) {
      if (!tv) notice('Select a target first');
      else if (tDist > BOLT_RANGE) notice('The target is too far away');
      else if (stats.mp < BOLT_MP) notice('Not enough mana');
      else skill = 1;
    }
    if (skill) {
      Object.assign(me, { castT: 0, castSkill: skill, castDur: skill === 2 ? METEOR.cast : CAST_TIME, sitting: false });
      if (skill === 1) attacking = true;   // an attack skill also starts the auto-attack
      send({ t: 'k', s: skill });
      sfx(skill === 2 ? 160 : 220, me.castDur, 'sine', 0.04, 500);
    }
  } else if (me.castT >= 0) {
    me.castT += dt;
    // Starfall lands on the cursor, limited to its range
    let sx = aimPoint.x - me.x, sz = aimPoint.z - me.z;
    const sd = Math.hypot(sx, sz);
    if (sd > METEOR.range) { sx *= METEOR.range / sd; sz *= METEOR.range / sd; }
    if (me.castSkill === 2) {
      aoeMarker.visible = true;
      aoeMarker.position.set(me.x + sx, 0.08, me.z + sz);
    } else if (!tv) {
      me.castT = -1;   // the target is gone: the bolt fizzles
    }
    if (me.castT >= me.castDur) {
      me.castT = -1;
      local.fireCd = 0.08;
      me.shootPose = 0.25;
      if (me.castSkill === 2) {
        local.meteorCd = METEOR.cd;
        send({ t: 'q', x: me.x + sx, z: me.z + sz });
      } else {
        spawnBolt(me.x + tdx * 0.8, me.z + tdz * 0.8, targetId);
        send({ t: 'f', id: targetId });
        sfx(660, 0.12, 'square', 0.04, -400);
      }
    }
  }

  // The cat faces its target while fighting it, the landing spot while casting Starfall, and otherwise where it is going.
  let face = null;
  if (tv && (me.swingT >= 0 || me.shootPose > 0 || (me.castT >= 0 && me.castSkill === 1) || (attacking && inReach && !manual))) face = Math.atan2(tdx, tdz);
  else if (me.castT >= 0) face = Math.atan2(aimPoint.x - me.x, aimPoint.z - me.z);
  else if (local.dashT > 0) face = Math.atan2(local.dashDir.x, local.dashDir.y);
  else if (moving) face = Math.atan2(moveDir.x, moveDir.y);
  if (face !== null) me.yaw = lerpAngle(me.yaw, face, Math.min(1, dt * 14));

  local.sendT -= dt;
  if (local.sendT <= 0) {
    local.sendT = 1 / 15;
    const r = (v) => Math.round(v * 100) / 100;
    send({ t: 'm', x: r(me.x), y: r(me.y), z: r(me.z), yaw: r(me.yaw), s: me.speed ? 1 : 0, st: me.sitting ? 1 : 0 });
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
  a.root.rotation.y = cam.yaw;   // keeps the health bar parallel to the screen
  a.cat.group.rotation.y = a.yaw - cam.yaw;
  if (a.swingT >= 0 && (a.swingT += dt / 0.4) >= 1) a.swingT = -1;
  const charge = a.castT >= 0 ? a.castT / a.castDur : 0;
  a.orb.visible = a.castT >= 0;
  a.orb.material = a.castSkill === 2 ? fireMat : bulletMat;
  a.orb.scale.setScalar(0.06 + charge * 0.26);
  a.cat.update(dt, { speed: a.speed, airborne: a.y > 0.05, shooting: a.shootPose > 0, dashing: isMe && local.dashT > 0, casting: a.castT >= 0, sitting: a.sitting, swing: a.swingT, swingKind: a.swingKind });
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
    v.root.rotation.y = cam.yaw;   // keeps the health bar parallel to the screen
    v.skeleton.group.rotation.y = v.yaw - cam.yaw;
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

  for (const v of chestViews) {
    v.root.visible = (v.root.position.x - me.x) ** 2 + (v.root.position.z - me.z) ** 2 < 60 * 60;
    if (v.root.visible && v.lid) v.lid.rotation.x += ((v.open ? -1.9 : 0) - v.lid.rotation.x) * Math.min(1, dt * 8);
  }

  let i = 0;
  for (const g of gemViews.values()) {
    g.mesh.rotation.y += dt * 3;
    g.mesh.position.y = 0.55 + Math.sin(time * 4 + i++) * 0.12;
  }

  // projectiles are simulated locally for looks; the server decides the damage
  bullets = bullets.filter((b) => {
    const v = mobViews.get(b.id), m = b.mesh.position;
    let done = !v;
    if (v) {
      const dx = v.x - m.x, dz = v.z - m.z, d = Math.hypot(dx, dz) || 0.001, step = 34 * dt;
      m.y += (v.top * 0.5 - m.y) * Math.min(1, dt * 8);
      if (d <= step + v.def.r * 0.6) { done = true; burst(v.x, v.top * 0.5, v.z, TEAL, 6, 5); }
      else { m.x += dx / d * step; m.z += dz / d * step; }
    }
    if (done) bulletPool.release(b);
    return !done;
  });

  const tv = mobViews.get(targetId);
  targetRing.visible = !!tv;
  if (tv) {
    targetRing.position.set(tv.x, 0.07, tv.z);
    targetRing.scale.setScalar(tv.skeleton.group.scale.y * 0.75 + 0.35);
    targetRing.material.color.setHex(attacking ? 0xff4d5e : 0xffd76a);
  }
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
  $('mpFill').style.width = `${stats.mp / stats.maxMp * 100}%`;
  $('mpText').textContent = `${stats.mp} / ${stats.maxMp}`;
  $('xpFill').style.width = `${stats.xp / need * 100}%`;
  $('xpText').textContent = `${stats.xp} / ${need}`;
  $('enFill').style.width = `${stats.energy}%`;
  $('enFill').classList.toggle('full', stats.energy >= 100);
  $('enHint').textContent = stats.energy >= 100 ? 'press Q!' : '';
  $('dashFill').style.width = `${Math.max(0, Math.min(1, 1 - local.dashCd / 1.2)) * 100}%`;
  $('cast').style.display = me.castT >= 0 ? 'block' : 'none';
  $('castFill').style.width = `${Math.max(0, me.castT) / me.castDur * 100}%`;
  $('sk0').classList.toggle('active', attacking);
  $('sk1').classList.toggle('active', me.castT >= 0 && me.castSkill === 1);
  $('sk2').classList.toggle('active', me.castT >= 0 && me.castSkill === 2);
  $('sk2cd').style.height = `${Math.max(0, local.meteorCd) / METEOR.cd * 100}%`;
  $('sk2time').textContent = local.meteorCd > 0 ? Math.ceil(local.meteorCd) : '';
  $('gold').textContent = stats.gold;
  $('weapon').textContent = `Lv ${stats.weapon}`;
  $('online').textContent = online;

  // target frame: name and level tinted by how dangerous the monster is for this player
  const tv = mobViews.get(targetId);
  $('target').style.display = tv ? 'block' : 'none';
  if (tv) {
    const diff = tv.lvl - stats.level;
    $('tgName').textContent = `${tv.def.name} · Lv ${tv.lvl}`;
    $('tgName').style.color = diff >= 5 ? '#ff5a6a' : diff >= 3 ? '#ffa24d' : diff >= -2 ? '#fff3b0' : diff >= -5 ? '#8ee68e' : '#aab4b8';
    $('tgFill').style.width = `${Math.max(0, tv.hp / tv.maxHp) * 100}%`;
    $('tgHp').textContent = `${tv.hp} / ${tv.maxHp}`;
    $('tgState').textContent = attacking ? 'Attacking' : 'Selected';
  }

  const atSmith = Math.hypot(me.x - BLACKSMITH.x, me.z - BLACKSMITH.z) < SHOP_RANGE;
  const cost = upgradeCost(stats.weapon);
  $('shop').style.display = atSmith ? 'block' : 'none';
  if (atSmith) {
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
  chestViews.forEach((v, i) => { if (!v.open) dot(CHESTS[i].x, CHESTS[i].z, CHESTS[i].big ? 8 : 5, '#ffb020'); });
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
    const flat = Math.cos(cam.pitch) * cam.dist;
    lookGoal.set(me.x, 1.2, me.z);
    camGoal.set(me.x + Math.sin(cam.yaw) * flat, 1.2 + Math.sin(cam.pitch) * cam.dist, me.z + Math.cos(cam.yaw) * flat);
  } else {
    camGoal.set(me.x, 1.2, me.z + 6.4);
    lookGoal.set(me.x, 0.45, me.z);
  }
  const k = 1 - Math.exp(-(state === 'playing' ? 12 : 5) * dt);
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
  npcs?.update(dt, me);

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
window.__game = { me, stats, others, mobViews, send, world, cam, camera, get target() { return targetId; }, get attacking() { return attacking; }, get state() { return state; } };
