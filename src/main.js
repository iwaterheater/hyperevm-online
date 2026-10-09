import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createCat, loadCat, swingTime, SWING_WINDUP } from './cat.js';
import { createSkeleton, loadSkeletons, SKELETON_FILES, SKELETON_HEIGHT, BONE } from './skeleton.js';
import { createMonster, loadMonsters, MONSTER_KINDS } from './monster.js';
import { createWorld } from './world.js';
import { createNpcs, npcModels } from './npc.js';
import { loading } from './loading.js';
import { createComposer } from './postfx.js';
import { createFx } from './fx.js';
import { skillIcon, itemIcon, ATTACK_ICON, ICON_FILES } from './icons.js';
import { createWorldMap } from './worldmap.js';
import { SETTINGS_KEY, DEFAULT_SETTINGS, AUTO_STEPS, cleanSettings, lowered, pixelRatio, loudness } from './settings.js';
import { normalize, regionAt, regionLabel, regionColor, isSafe, nearNpc, npcsOf, hasBoss, rayGround } from './map/format.js';
import {
  TICK, ATTACK_WINDUP, MOB_RISE, MOB_TYPES, MOB_KEYS, CLASSES, CLASS_KEYS, START_CLASSES, PROFESSION_LEVEL,
  professionsOf, SKILLS, skillsFor, activeSkills, statsOf, castTime, isSpell, ATTR_NAMES, xpNext, upgradeCost,
  ITEMS, TIERS, EQUIP_SLOTS, SLOT_NAMES, BONUS_NAMES, BAG_SIZE, POTION_CD, SELL_RATE, SHOP, SHOP_TIER, sellPrice, stackMax, roomFor, lootTable,
  basicFamily, handsOf, heldFamily, fightStyle, equipError, comesOff, equipWith, wearError, lookCode, lookOf, BAR_SIZE,
  CAT_R, PVP_PEACE, PVP_COLORS, PVP_TITLES, BAR_ATTACK,
} from './shared.js';

// how long a swing lasts when the attack speed behind it is not known: another player's blow, a skill
const SWING_DEFAULT = 0.46;

const TEAL = 0x7fe8d6;
const FIRE = 0xffa040;
const glow = (hex, k = 2.5) => new THREE.Color(hex).multiplyScalar(k);
const css = (hex) => `#${hex.toString(16).padStart(6, '0')}`;
const r2 = (v) => Math.round(v * 100) / 100;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- map & session

// Browser storage may be full, switched off or hold old data: every access is guarded, and what is read gets checked.
// `area` is 'localStorage' or 'sessionStorage'; writing null removes the key.
function readStore(area, key) {
  try { return window[area].getItem(key); } catch { return null; }
}
function readJson(area, key) {
  try { return JSON.parse(readStore(area, key)); } catch { return null; }
}
function writeStore(area, key, value) {
  try {
    if (value === null) window[area].removeItem(key);
    else window[area].setItem(key, value);
    return true;
  } catch { return false; }
}

// What this player has set in the settings window; the window itself is further down, with the other windows.
const settings = cleanSettings(readJson('localStorage', SETTINGS_KEY));

// Play mode (/?play=1) is how the map editor tries a map out: no menu, and a made-up character that the server grants
// only to whoever may edit the map. The editor leaves its request in storage: { id, at: [x, z] | null, lvl, cls, god, speed }.
const playMode = new URLSearchParams(location.search).get('play') === '1';
function readPlay() {
  const p = readJson('localStorage', 'hypercat-editor-play');
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { id: 0, at: null, lvl: 1, cls: START_CLASSES[0], god: false, speed: 1 };
  const at = Array.isArray(p.at) && p.at.length === 2 && p.at.every(Number.isFinite) ? [p.at[0], p.at[1]] : null;
  return {
    id: p.id, at, lvl: Number.isFinite(p.lvl) ? p.lvl : 1, cls: typeof p.cls === 'string' ? p.cls : START_CLASSES[0],
    god: p.god === true, speed: p.speed === 2 ? 2 : 1,
  };
}
const play = playMode ? readPlay() : null;

// Before the page reloads itself for a saved map it leaves a note, { name, cls, x, z, at }, so that the cat comes back
// to where it stood. The note is read once and believed for 20 seconds.
function takeRejoin() {
  const f = readJson('sessionStorage', 'hypercat-rejoin');
  writeStore('sessionStorage', 'hypercat-rejoin', null);
  const fresh = f && typeof f === 'object' && typeof f.name === 'string' && Number.isFinite(f.x) && Number.isFinite(f.z)
    && Date.now() - f.at < 20000;
  return fresh ? f : null;
}
// In play mode the note counts only while no new Play request has come since this tab last joined - then the reload
// came from a save. A new request always lands where the editor asked, whichever of the two reaches the tab first.
const note = takeRejoin();
const rejoin = note && (!playMode || String(play.id) === readStore('sessionStorage', 'hypercat-play-id')) ? note : null;
// where a join without the menu asks the server to put the cat; null = the start point
const joinAt = rejoin ? [rejoin.x, rejoin.z] : play ? play.at : null;
const autoJoin = playMode || !!rejoin;
if (autoJoin) $('menu').classList.add('hidden');

// The loading screen (index.html, src/loading.js) has covered the page since its first paint. It counts real things,
// each announced before it is asked for: what does not depend on the map here, the map's own models once it has arrived.
loading.step('engine');   // three.js and the game's modules are in: this line runs
// the kinds of monster on a map that are drawn from a file of their own (src/monster.js)
const monstersOf = (m) => [...new Set(m.spawns.flatMap((s) => Object.keys(s.types)))].filter((kind) => MONSTER_KINDS.includes(kind));
// the pictures the HUD is made of (assets/ui/hud, cut from the painted sheets by tools/build-hud.py)
const HUD_PICTURES = ['frame', 'portrait-ring', 'portrait', 'shield', 'radar-ring', 'zoom-in', 'zoom-out', 'zoom-in-lit', 'zoom-out-lit', 'skull', 'chest', 'house'];
const hudPicture = {};   // name -> Image, for what is drawn on a canvas
loading.expect({ map: 1, cat: 1, effects: 1, monsters: SKELETON_FILES, treasure: 3, icons: ICON_FILES.length + HUD_PICTURES.length });
// the pictures of the action bar, the bag and the HUD: fetched now, so no slot is ever an empty square
const fetchPicture = (url) => new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = url; });
for (const file of ICON_FILES) loading.track('icons', fetchPicture(`./${file}`));
for (const name of HUD_PICTURES) loading.track('icons', fetchPicture(`./assets/ui/hud/${name}.png`).then((img) => { hudPicture[name] = img; }));

// The world is a data file: everything below is built from it.
let map, mapRev, editorInfo = { enabled: false, canSave: false, tokenRequired: false };
try {
  const res = await fetch('/api/map', { cache: 'no-store' });
  // the revision the server knows this map by; a proxy may weaken or drop the ETag, so the plain header comes first
  mapRev = res.headers.get('X-Map-Rev') || (res.headers.get('ETag') || '').replace(/^W\//, '').replace(/"/g, '');
  map = normalize(await res.json());
  editorInfo = await fetch('/api/editor', { cache: 'no-store' }).then((r) => r.json()).catch(() => editorInfo);
} catch (err) {   // the throw stops the module: there is no game without a map
  loading.fail('The map failed to load. Check that the server is running, then try again.');
  showLoadFailure();
  throw err;
}
loading.step('map');
loading.expect({ scenery: new Set(map.objects.map((o) => o.m)).size, townsfolk: npcModels(map.npcs).length, monsters: monstersOf(map).length });
loading.seal();   // the list is complete: the screen shows "N / M" from here on
// asked for after the map, not beside it: a browser opens six connections to a host, and the map must not wait in line
loading.track('cat', loadCat());
loadSkeletons((ok) => loading.step('monsters', ok)).catch(() => {});   // connect() waits for them again and reports
loadMonsters(monstersOf(map), (ok) => loading.step('monsters', ok)).catch(() => {});

// A map that did not load must not leave a menu that looks alive.
function showLoadFailure() {
  $('menu').classList.add('hidden');
  $('lostText').textContent = 'The map failed to load';
  $('lost').classList.remove('hidden');
  $('reloadBtn').addEventListener('click', () => location.reload());
}

// ---------------------------------------------------------------- renderer

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(pixelRatio(settings.resolution, devicePixelRatio));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.domElement.id = 'view';
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 700);

const composer = createComposer(renderer, scene, camera);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

const world = createWorld(scene, map, { onProgress: loading.counter('scenery') });
world.ready.catch(console.error);

// The graphics settings, put to work: at the start (before the loading screen compiles the shaders, so that it
// compiles the ones this player will see) and whenever the settings window changes one.
// With Auto on they are lowered by as many steps as the frame rate has asked for (see measure, further down).
const auto = { step: 0, floor: 0, fps: 0, frames: 0, span: 0, slow: 0, fast: 0, wait: 6 };
function applySettings() {
  const now = lowered(settings, settings.auto ? auto.step : 0), ratio = pixelRatio(now.resolution, devicePixelRatio);
  if (renderer.getPixelRatio() !== ratio) { renderer.setPixelRatio(ratio); composer.setPixelRatio(ratio); }
  composer.setGlow(now.glow);
  world.lighting.setShadows(now.shadows);
  world.view.setVisible('foliage', now.grass);
  $('fps').style.display = settings.fps ? 'block' : 'none';
}
applySettings();

// The world has hills, the server does not: positions on the wire are x and z. Whatever stands, flies or is aimed here
// keeps its own height ABOVE the ground and adds groundY() where it is drawn; on a flat map that is 0 everywhere.
const groundY = world.heightAt;

// Lays a flat marker (a ring made in the XY plane) on the ground around a point: `lift` above it and tilted like the
// slope within `reach` units, so that on a hillside one half neither floats nor is buried. Flat ground: straight up.
const FACING = new THREE.Vector3(0, 0, 1), slope = new THREE.Vector3();
function layOnGround(mesh, x, z, reach, lift) {
  const e = groundY(x + reach, z), w = groundY(x - reach, z), s = groundY(x, z + reach), n = groundY(x, z - reach);
  slope.set((w - e) / (2 * reach), 1, (n - s) / (2 * reach)).normalize();
  mesh.quaternion.setFromUnitVectors(FACING, slope);
  mesh.position.set(x, Math.max(groundY(x, z), (e + w + s + n) / 4) + lift, z);   // a hollow must not swallow the centre
}

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
createNpcs(scene, textSprite, map.npcs, groundY, (ok) => loading.step('townsfolk', ok)).then((n) => { npcs = n; }, (err) => console.error('Townsfolk failed to load', err));

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

let actx = null;
function sfx(freq, dur = 0.1, type = 'square', vol = 0.06, slide = 0) {
  vol *= loudness(settings);
  if (!actx || !vol) return;
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
const bulletMat = new THREE.MeshBasicMaterial({ color: glow(TEAL, 3) });
const fireMat = new THREE.MeshBasicMaterial({ color: glow(FIRE, 3) });
const frostMat = new THREE.MeshBasicMaterial({ color: glow(0xa9d8ff, 3) });
const arrowMat = new THREE.MeshBasicMaterial({ color: glow(0xffe9a6, 2) });
const healMat = new THREE.MeshBasicMaterial({ color: glow(0x8ee68e, 2.5) });
const FX = { arcane: bulletMat, frost: frostMat, fire: fireMat, arrow: arrowMat };
// what the charging orb between the paws looks like for a skill
const orbMat = (id) => {
  const k = SKILLS[id];
  return !k ? bulletMat : k.kind === 'heal' ? healMat : k.kind === 'ground' ? fireMat : FX[k.fx] || bulletMat;
};
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

const chestViews = [];   // index-aligned with map.chests; filled when the models arrive
{
  const loader = new GLTFLoader();
  Promise.all(['chest', 'chest_gold', 'coin'].map((n) => loading.track('treasure', loader.loadAsync(`./assets/dungeon/${n}.glb`)))).then(([chest, gold, coin]) => {
    map.chests.forEach((c, i) => {
      const model = (c.big ? gold : chest).scene.clone(true);
      model.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      const root = new THREE.Group();
      root.add(model);
      root.position.set(c.x, groundY(c.x, c.z), c.z);
      root.rotation.y = c.ry;
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

// `y` is the height above the ground at x, z.
function burst(x, y, z, hex, n, speed = 6) {
  tmpColor.set(hex).multiplyScalar(2.2);
  y += groundY(x, z);
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
      const floor = groundY(d.p.x, d.p.z) + 0.08;   // sparks bounce off the hillside they land on
      if (d.p.y < floor) { d.p.y = floor; d.v.y *= -0.4; }
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

// what skills look like: the Blender-made shapes and their animation
const fx = createFx(scene, { groundY, layOnGround, burst });
loading.track('effects', fx.ready);

// ---------------------------------------------------------------- avatars (cats)

// As a target a cat is what a monster is: it has a height, a radius, and marks over its head while it is stunned,
// asleep or slowed. `st` is how it stands with the other cats (PVP_PEACE, flagged, outlaw).
const CAT_TOP = 2.4, CAT_DEF = { r: CAT_R };
function makeAvatar(cls = 'fighter') {
  const cat = createCat(CLASSES[cls]);
  const root = new THREE.Group();   // never rotates, so labels and bars stay screen-aligned
  root.add(cat.group);
  root.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  const orb = new THREE.Mesh(sphereGeo, bulletMat);   // the bolt charging between the paws while casting
  orb.position.set(0, 1.0, 0.85);
  orb.visible = false;
  cat.group.add(orb);
  scene.add(root);
  return {
    root, cat, cls, look: 0, orb, swingT: -1, swingDur: SWING_DEFAULT, swingKind: 0, castT: -1, castDur: 1, castSkill: '', bar: makeBar(root, 2.75, 1.3, 0x6dffb0), label: null, labelKey: '',
    x: 0, y: 0, z: 0, yaw: 0, tx: 0, ty: 0, tz: 0, tyaw: 0,
    speed: 0, hp: 100, maxHp: 100, level: 1, dead: false, sitting: false, shootPose: 0, drawT: -1, drawDur: 1,
    name: 'Cat', top: CAT_TOP, def: CAT_DEF, st: PVP_PEACE, flags: 0, status: null,
  };
}

function setLabel(a, text, color) {
  const key = `${text}|${color}`;
  if (a.labelKey === key) return;
  if (a.label) disposeSprite(a.label);
  a.labelKey = key;
  a.label = textSprite(text, color);
  a.label.position.y = 3.15;
  a.root.add(a.label);
}

// What a cat wears and holds: its class gives the hoodie, the look code of its equipment (lookCode in shared.js) the
// armour pieces, their tiers, the shield on its off paw and the kind of weapon in the other - any class may hold any
// weapon; with nothing equipped it holds the one its class starts with (basicFamily). A piece, a shield and a weapon
// are tinted by their tier.
function setLook(a, cls, code = a.look) {
  if (!CLASSES[cls] || (a.cls === cls && a.look === code)) return;
  a.cls = cls;
  a.look = code;
  const worn = lookOf(code), tint = (tier) => (tier < 0 ? null : TIERS[tier].color);
  a.family = worn.family ?? basicFamily(cls, worn.offhand >= 0);
  a.cat.setLook({
    // the server never sends a shield beside a weapon that takes both paws; a code that says so anyway shows the weapon
    ...CLASSES[cls], weapon: a.family, weaponTint: tint(worn.weapon), shield: handsOf(a.family) === 2 ? null : tint(worn.offhand),
    armor: { helmet: tint(worn.head), chest: tint(worn.body), gloves: tint(worn.hands), boots: tint(worn.feet) },
  });
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
const MOB_ANGRY = '#ff7a8a', MOB_CALM = '#f4f1ea';   // the colour of a monster's name: it attacks on sight, or it does not

const corpses = [];
function removeMobView(v) {
  scene.remove(v.root);   // the status marks go with it; their materials are shared
  v.skeleton.dispose();
}

// who draws a kind of monster (MOB_TYPES says which in `draw`), and the kinds of this map that need a file of their own
const MOB_VIEW = { skeleton: createSkeleton, monster: createMonster };
const mapMonsters = monstersOf(map);

function makeMobView(ti, lvl) {
  const type = MOB_KEYS[ti], def = MOB_TYPES[type];
  const root = new THREE.Group();   // never rotates, so the label and bar stay screen-aligned
  // a monster of the pack or a skeleton: both answer to the same calls, so the view keeps it under one name
  const skeleton = MOB_VIEW[def.draw ?? 'skeleton'](type, def);
  root.add(skeleton.group);
  const top = def.draw ? skeleton.height : SKELETON_HEIGHT * skeleton.group.scale.y + (type === 'shooter' ? 0.4 : 0);

  // its name and level: red for a monster that attacks on sight, white for one that leaves a cat alone
  const text = `${def.name} · Lv ${lvl}`;
  if (!lvlLabels.has(text)) lvlLabels.set(text, textSprite(text, def.calm ? MOB_CALM : MOB_ANGRY, type === 'boss' ? 0.8 : 0.4));
  const proto = lvlLabels.get(text);
  const label = new THREE.Sprite(proto.material);   // material shared between mobs of the same kind and level
  label.scale.copy(proto.scale);
  label.position.y = top + 0.75;
  root.add(label);

  scene.add(root);
  return {
    root, skeleton, label, type, def, lvl, top, bar: makeBar(root, top + 0.3, Math.max(1.2, def.r * 1.6), 0xff5577),
    x: 0, z: 0, tx: 0, tz: 0, hp: 1, maxHp: 1, flags: 0, flash: 0, rise: 0, yaw: 0,
  };
}

// ---------------------------------------------------------------- game state

let state = 'menu';   // menu | connecting | playing | lost | reloading
let ws = null, myId = 0, time = 0, shake = 0, online = 1;
let joinName = '', testSpeed = 1;   // testSpeed: a play-test may run at double speed
const names = new Map();
const others = new Map(), mobViews = new Map(), gemViews = new Map(), orbViews = new Map();
let bullets = [];

const me = makeAvatar();
// Until the server places it the cat waits where it will appear: on the start point - the menu pose - or, when the page
// joins by itself, on the spot it asks for.
me.x = joinAt ? joinAt[0] : map.start.x;
me.z = joinAt ? joinAt[1] : map.start.z;
if (joinAt) world.snapMood(me.x, me.z);
camera.position.set(me.x, groundY(me.x, me.z) + 1.2, me.z + 0.4);   // the opening shot starts close to the cat and pulls back
// inv: the bag, a list of [item id, count]; eq: what is worn, by slot; bar: the action bar, a skill id, an item id or
// null per slot. The server sends the three only when they change.
const stats = {
  hp: 100, maxHp: 100, mp: 60, maxMp: 60, xp: 0, sp: 0, level: 1, gold: 0, weapon: 1, cls: 'fighter', skills: {}, buffs: [], dead: false,
  inv: [], eq: {}, bar: Array(BAR_SIZE).fill(null),
  pvp: 0, pk: 0, karma: 0, st: PVP_PEACE, cc: 0, slow: 1,   // PvP: fights won, murders, karma, standing; and what holds the cat
};
// every derived stat of this character (P.Atk, Atk.Spd, Speed...), recomputed whenever the server state changes
let sheet = statsOf('fighter', 1);
const local = {
  vy: 0, jumps: 0, invuln: 0, fireCd: 0, swordCd: 0, combo: 0, dashT: 0, sendT: 0, cds: {}, potionAt: 0,
  dashDir: new THREE.Vector2(0, 1), aim: new THREE.Vector2(0, 1), zone: '',
};

// ring on the ground under the selected monster or cat: yellow when selected, red while attacking it
const targetRing = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 40), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
targetRing.visible = false;
scene.add(targetRing);

// numbers that float up over a monster when this player damages it, or over the cat when it is healed;
// `y` is the height above the ground at x, z
const floaters = [];
function floatText(x, y, z, text, color, big) {
  const sprite = textSprite(text, color, big ? 0.9 : 0.62);
  sprite.position.set(x + (Math.random() - 0.5) * 0.8, groundY(x, z) + y, z);
  sprite.material.depthTest = false;
  sprite.renderOrder = 5;
  scene.add(sprite);
  floaters.push({ sprite, t: 0 });
}

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
  while (log.children.length > 40) log.firstChild.remove();   // more than both tabs can show
}

// What is written on the chat's line goes out; either way the keyboard is the game's again.
function sendChat() {
  const input = $('chatInput');
  if (input.value.trim()) send({ t: 'c', m: input.value });
  input.value = '';
  input.blur();
}
$('chatInput').addEventListener('focus', () => keys.clear());   // a key held while the line was clicked would stay down
$('chatSend').addEventListener('click', () => { if (state === 'playing') sendChat(); });
$('chatTabs').addEventListener('click', (e) => {
  const tab = e.target.closest('button');
  if (!tab) return;
  for (const b of $('chatTabs').children) b.classList.toggle('on', b === tab);
  $('chat').classList.toggle('sys', tab.dataset.tab === 'sys');
  tab.blur();
});

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

// The editor token (only a server in token mode has one): kept for this tab, asked for once when a play-test needs it,
// never put into a URL.
function editorToken(ask) {
  let token = readStore('sessionStorage', 'hypercat-editor-token') || '';
  if (!token && ask) {
    token = prompt('Editor token') || '';
    if (token) writeStore('sessionStorage', 'hypercat-editor-token', token);
  }
  return token;
}
// Whoever may save the map gets the dev bar. With a token every visitor "can save", so there it takes the token itself.
const mayEdit = () => !!(editorInfo.enabled && editorInfo.canSave
  && (!editorInfo.tokenRequired || readStore('sessionStorage', 'hypercat-editor-token')));

// The first message of a connection. `rev` names the map this page has drawn: the server lets nobody in with another one.
function joinMessage() {
  const msg = { t: 'join', name: joinName, cls: pickedClass, token: getToken(), rev: mapRev };
  // a place of the client's choosing and a play-test character are honoured only for whoever may edit the map
  if (playMode) msg.test = { at: joinAt, lvl: play.lvl, cls: play.cls, god: play.god, speed: play.speed };
  else if (joinAt) msg.at = joinAt;
  const token = editorInfo.tokenRequired ? editorToken(playMode) : '';
  if (token) msg.editorToken = token;
  return msg;
}

function showLost() {
  state = 'lost';
  $('lost').classList.remove('hidden');
  $('menu').classList.add('hidden');
  $('dead').classList.add('hidden');
  $('hud').classList.remove('on');
}

async function connect() {
  if (state !== 'menu') return;
  if (!actx) { try { actx = new AudioContext(); } catch { /* no audio */ } }
  state = 'connecting';
  joinName = $('nameInput').value.trim() || (playMode ? 'Tester' : 'Cat');
  if (!playMode) writeStore('localStorage', 'hypercat-name', joinName);
  $('playBtn').textContent = 'Loading models…';
  try {
    await Promise.all([loadSkeletons(), loadMonsters(mapMonsters)]);
  } catch (err) {
    console.error(err);
    state = 'menu';
    $('playBtn').textContent = 'Models failed to load — retry';
    $('menu').classList.remove('hidden');   // a join without the menu had hidden it
    return;
  }
  $('playBtn').textContent = 'Connecting…';
  const hello = joinMessage();
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => send(hello);
  ws.onmessage = (e) => onMessage(JSON.parse(e.data));
  ws.onclose = showLost;
}

// The server runs another map than the one this page has drawn - it was saved in the editor: load the page again and
// come back to the same spot. Only reloads that never reached a join are counted (the join clears the list), three a
// minute at most, so a page that keeps being handed the wrong map stops instead of reloading for ever.
function reloadForMap() {
  state = 'reloading';   // from here on every message is ignored
  ws.onclose = null;
  ws.close();
  const t = Date.now(), list = readJson('sessionStorage', 'hypercat-reloads');
  const recent = Array.isArray(list) ? list.filter((at) => t - at < 60000) : [];
  if (recent.length >= 3 || !writeStore('sessionStorage', 'hypercat-reloads', JSON.stringify([...recent, t]))) { showLost(); return; }
  writeStore('sessionStorage', 'hypercat-rejoin', JSON.stringify({ name: joinName, cls: pickedClass, x: r2(me.x), z: r2(me.z), at: t }));
  location.reload();
}

function onMessage(msg) {
  if (state === 'reloading') return;
  if (msg.t === 'map') {   // after a save, or instead of 'w' when this page joined with an old map
    if (msg.rev !== mapRev) reloadForMap();
  } else if (msg.t === 'w') {
    myId = msg.id;
    me.x = msg.x; me.z = msg.z;
    testSpeed = msg.test?.speed === 2 ? 2 : 1;
    world.snapMood(me.x, me.z);
    state = 'playing';
    writeStore('sessionStorage', 'hypercat-reloads', null);
    if (playMode) writeStore('sessionStorage', 'hypercat-play-id', String(play.id));
    $('devbar').classList.toggle('on', !!msg.test || mayEdit());
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

// Another cat or a monster is drawn walking in a straight line from where it was shown when a snapshot came to where
// that snapshot has it, in the time one snapshot takes: an even pace a twentieth of a second behind the server,
// instead of a rubber band that is always catching up. tween() notes the two ends; glide() says where it is now.
function tween(v, x, y, z) {
  // a little longer than a tick, so that a snapshot that is a frame late finds it still walking; after a real gap,
  // as long as the gap was
  const since = time - (v.seenAt ?? time - TICK), span = since > TICK * 1.6 ? Math.min(0.25, since) : TICK * 1.15;
  Object.assign(v, { fx: v.x, fy: v.y ?? 0, fz: v.z, tx: x, ty: y, tz: z, t0: time, seenAt: time, span });
}
function glide(v) {
  const u = Math.min(1, (time - v.t0) / v.span);
  v.x = v.fx + (v.tx - v.fx) * u; v.z = v.fz + (v.tz - v.fz) * u;
  return u;
}

function syncViews(views, list, create, update, remove) {
  const seen = new Set();
  for (const row of list) {
    const id = row[0];
    seen.add(id);
    let v = views.get(id);
    if (!v) { v = create(row); views.set(id, v); }
    update(v, row);
  }
  for (const [id, v] of views) if (!seen.has(id)) { remove(v); views.delete(id); }
}

function onSnapshot(s) {
  online = s.n;
  const wasDead = stats.dead;
  Object.assign(stats, s.me, { dead: !!s.me.dead });
  setLook(me, stats.cls, lookCode(stats.eq));
  sheet = statsOf(stats.cls, stats.level, stats.skills, stats.weapon, Object.fromEntries(stats.buffs.map(([stat, , mult]) => [stat, mult])), stats.eq);
  if (stats.dead !== wasDead) $('dead').classList.toggle('hidden', !stats.dead);

  syncViews(others, s.p,
    ([, x, y, z, yaw, , , , , , , cls]) => Object.assign(makeAvatar(CLASS_KEYS[cls]), { x, y, z, yaw }),
    (a, [id, x, y, z, yaw, speed, hp, maxHp, level, dead, sit, cls, look, st = 0, flags = 0]) => {
      tween(a, x, y, z);
      Object.assign(a, { tyaw: yaw, speed, hp, maxHp, level, dead: !!dead, sitting: !!sit, st, flags, name: names.get(id) || 'Cat' });
      setLook(a, CLASS_KEYS[cls], look);
      setLabel(a, `${a.name} · ${CLASSES[a.cls].name} ${level}`, PVP_COLORS[st]);   // purple while it is flagged, red for an outlaw
    },
    removeAvatar);

  // a killed monster stays behind for its death animation instead of vanishing with the snapshot
  for (const ev of s.e) if (ev.k === 'kill' && mobViews.has(ev.id)) mobViews.get(ev.id).killed = true;
  syncViews(mobViews, s.m,
    ([, ti, lvl, x, z]) => Object.assign(makeMobView(ti, lvl), { x, z }),
    (v, [, , , x, z, hp, maxHp, flags]) => { tween(v, x, 0, z); Object.assign(v, { hp, maxHp, flags }); },
    (v) => {
      if (!v.killed) { removeMobView(v); return; }
      v.skeleton.die();
      v.skeleton.flash(0);
      v.bar.set(0, false);
      v.label.visible = false;
      corpses.push({ v, t: 0 });
    });

  syncViews(gemViews, s.g,
    ([, x, z]) => { const g = gemPool.get(); g.ground = groundY(x, z); g.mesh.position.set(x, g.ground + 0.55, z); return g; },
    () => {},
    (g) => gemPool.release(g));

  // What the monsters have thrown. The server flies it - a fireball follows its cat - and says where it is; between
  // two snapshots it is carried on at the speed it last had.
  syncViews(orbViews, s.o || [],
    ([, x, z, kind]) => ({ mesh: fx.bolt('fire', kind ? 1.7 : 1.4, kind ? 0xff6a9a : 0xffffff), x, z, sx: x, sz: z, st: time, vx: 0, vz: 0, puff: 0, fresh: true }),
    (v, [, x, z]) => {
      const dt = time - v.st;
      if (!v.fresh && dt > 0.001) { v.vx = (x - v.sx) / dt; v.vz = (z - v.sz) / dt; }
      Object.assign(v, { sx: x, sz: z, st: time, fresh: false });
    },
    (v) => fx.drop(v.mesh));

  const open = new Set(s.c);
  chestViews.forEach((v, i) => { v.open = open.has(i); });

  for (const ev of s.e) onEvent(ev);
}

// Whatever an id names that can be aimed at: a monster, another cat, or this one (ids come from one counter).
const viewOf = (id) => mobViews.get(id) || others.get(id) || (id && id === myId ? me : undefined);

// A bolt that homes in on a monster or a cat; purely visual, the server decides the damage. A skill's bolt is larger than that
// of a plain attack and may carry the skill's colour.
const BOLT_LOOK = { power_shot: [1.7, 0xffd76a], pinning_shot: [1.4, 0xa9d8ff], fireball: [1.25] };
const boltFrom = new THREE.Vector3();
function spawnBolt(x, z, id, kind, skill, h = 1.1) {
  const b = { mesh: fx.bolt(kind, ...(BOLT_LOOK[skill] || [])), kind, id };
  b.h = h;   // its height above the ground it flies over
  b.mesh.position.set(x, groundY(x, z) + b.h, z);
  b.speed = kind === 'arrow' ? 42 : 34;
  bullets.push(b);
}

function onEvent(ev) {
  switch (ev.k) {
    case 'shot':   // an archer's arrow from an auto-attack
      spawnBolt(ev.x, ev.z, ev.id, ev.fx);
      if (others.has(ev.o)) others.get(ev.o).shootPose = 0.3;
      break;
    case 'cast':
      if (ev.o !== myId && others.has(ev.o)) Object.assign(others.get(ev.o), { castT: 0, castDur: ev.d, castSkill: ev.s });
      break;
    case 'swing':
      if (ev.o === myId || !others.has(ev.o)) break;
      Object.assign(others.get(ev.o), { swingT: 0, swingDur: SWING_DEFAULT, swingKind: ev.c });
      if (!fightStyle(others.get(ev.o).cls, others.get(ev.o).family).ranged) fx.swing(others.get(ev.o).x, others.get(ev.o).z, ev.dx, ev.dz, ev.c, SWING_DEFAULT * SWING_WINDUP);
      break;
    case 'skill': {   // the server accepted a skill: show what it does
      const k = SKILLS[ev.s], a = ev.o === myId ? me : others.get(ev.o), tv = viewOf(ev.tid);
      if (!k || !a) break;
      if (k.kind === 'strike') {
        if (ev.o !== myId) Object.assign(a, { swingT: 0, swingDur: SWING_DEFAULT, swingKind: 2 });
        sfx(240, 0.14, 'sawtooth', 0.05, 300);
      } else if (k.kind === 'shot' || k.kind === 'bolt') {
        // a spell leaves the crystal of the staff, when the cat holds one
        if (a.cat.castPoint(boltFrom)) {
          a.cat.group.localToWorld(boltFrom);
          spawnBolt(boltFrom.x, boltFrom.z, ev.tid, k.fx, ev.s, boltFrom.y - groundY(boltFrom.x, boltFrom.z));
        } else spawnBolt(a.x, a.z, ev.tid, k.fx, ev.s);
        a.shootPose = 0.25;
        sfx(660, 0.12, 'square', 0.04, -400);
      } else if (k.kind === 'ground') {
        sfx(900, k.delay, 'sawtooth', 0.04, -700);
      } else if (k.kind === 'heal' || k.kind === 'buff' || k.kind === 'taunt' || k.kind === 'revive') {
        sfx(k.kind === 'taunt' ? 150 : 520, 0.35, 'triangle', 0.07, 300);
      } else if (k.kind === 'dash' && ev.o !== myId) {
        burst(a.x, 1, a.z, TEAL, 14, 6);
      }
      fx.cast(ev.s, k, a, tv, ev);
      break;
    }
    case 'boom':
      fx.boom(ev.x, ev.z, ev.r);
      burst(ev.x, 0.5, ev.z, FIRE, 45, 12);
      if (Math.hypot(ev.x - me.x, ev.z - me.z) < 25) shake = Math.max(shake, 0.5);
      sfx(70, 0.5, 'sawtooth', 0.12, -40);
      break;
    case 'orb': {   // a monster lets its spell go; the snapshot that brought this has put the fireball into the world
      const v = orbViews.get(ev.id);
      if (v) { v.vx = ev.vx; v.vz = ev.vz; }
      burst(ev.x, 1.1, ev.z, FIRE, 6, 4);
      if (Math.hypot(ev.x - me.x, ev.z - me.z) < 30) sfx(300, 0.18, 'sawtooth', 0.03, -160);
      break;
    }
    case 'orbx':    // it burst on a cat, or burnt out
      fx.hit('fire', ev.x, 1, ev.z, ev.h ? 1 : 0.3);
      if (ev.h && Math.hypot(ev.x - me.x, ev.z - me.z) < 30) sfx(110, 0.25, 'sawtooth', 0.06, -50);
      break;
    case 'hit': {   // a blow that landed, on a monster or on a cat
      const v = viewOf(ev.id);
      if (v?.skeleton) { v.flash = 1; v.skeleton.hit(); burst(ev.x, v.top * 0.6, ev.z, v.def.draw ? v.def.color : BONE, 4, 5); }
      else if (v && v !== me) burst(ev.x, v.y + 1, ev.z, 0xff4d7a, 8, 5);   // this cat's own wounds are shown by 'hurt'
      if (ev.o === myId) floatText(ev.x, (v ? v.top : 2) + 0.5, ev.z, String(Math.max(1, Math.round(ev.d))), ev.c ? '#ffd76a' : '#ffffff', ev.c);
      sfx(520, 0.05, 'square', 0.025);
      break;
    }
    case 'miss': {   // this player's attack missed (Accuracy against the target's Evasion)
      const v = viewOf(ev.id);
      if (v && ev.o === myId) floatText(v.x, v.top + 0.5, v.z, 'Miss', '#aab4b8');
      break;
    }
    case 'dodge':
      floatText(me.x, 3.3, me.z, 'Dodge', '#a9d8ff');
      break;
    case 'rise': {   // a monster is back: it comes out of the ground at its home
      const v = mobViews.get(ev.id);
      if (!v) break;
      v.rise = MOB_RISE;
      fx.mobRise(ev.x, ev.z, v.def.r, MOB_RISE, v.def === MOB_TYPES.boss);
      if (Math.hypot(ev.x - me.x, ev.z - me.z) < 30) sfx(90, 0.6, 'sawtooth', 0.04, 60);
      break;
    }
    case 'atk': {   // a monster starts its blow, or (c) gathers a spell: both land when the wind-up is over
      const v = mobViews.get(ev.id);
      if (!v) break;
      v.skeleton.attack();
      if (ev.c) fx.mobCast(v, ATTACK_WINDUP, v.def === MOB_TYPES.boss);
      else fx.mobSwing(v, Math.sin(v.yaw), Math.cos(v.yaw), ATTACK_WINDUP - 0.1);
      break;
    }
    case 'kill': {
      const r = ev.ti >= 0 ? MOB_TYPES[MOB_KEYS[ev.ti]].r : 0.7;
      burst(ev.x, r * 1.5, ev.z, ev.ti < 0 ? 0xffffff : MOB_TYPES[MOB_KEYS[ev.ti]].draw ? MOB_TYPES[MOB_KEYS[ev.ti]].color : BONE, 16 + r * 14, 8);
      if (ev.o === myId && ev.d) floatText(ev.x, r * 3 + 1.2, ev.z, String(Math.max(1, Math.round(ev.d))), ev.c ? '#ffd76a' : '#ffffff', ev.c);
      sfx(180, 0.18, 'sawtooth', 0.05, -120);
      break;
    }
    case 'lvlfx':
      fx.levelUp(ev);
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
    case 'learned':
      banner(`${SKILLS[ev.s].name} · rank ${ev.rank}`);
      sfx(660, 0.3, 'triangle', 0.08, 400);
      break;
    case 'prof':
      banner(`You are now a ${CLASSES[ev.cls].name}!`);
      sfx(523, 0.6, 'triangle', 0.09, 520);
      break;
    case 'healed':
      floatText(me.x, 3.3, me.z, `+${ev.n}`, '#8ee68e');
      break;
    case 'died':
      // at the start point, wherever the map has it; a fight between cats costs no experience, unless an outlaw lost it
      $('deadText').textContent = `${ev.by ? `${ev.by} has struck you down. ` : ''}${ev.xp || !ev.by ? `You lost ${ev.xp} experience. ` : ''}Respawning…`;
      break;
    case 'pvp': {   // this cat has brought another one down: a fight won, or a murder
      const text = ev.pk ? `You murdered ${ev.n} · PK ${stats.pk} · karma ${stats.karma}` : `You defeated ${ev.n} · PvP ${stats.pvp}`;
      banner(ev.pk ? `You murdered ${ev.n}` : `You defeated ${ev.n}`);
      chatLine('', text, true);
      sfx(ev.pk ? 110 : 523, 0.5, ev.pk ? 'sawtooth' : 'triangle', 0.08, ev.pk ? -50 : 400);
      break;
    }
    case 'open': {
      const c = map.chests[ev.i];
      if (!c) break;
      burst(c.x, 1.2, c.z, 0xffd76a, c.big ? 60 : 24, 7);
      sfx(520, 0.25, 'triangle', 0.07, 520);
      break;
    }
    case 'chest':
      banner(`+${ev.gold} gold`);
      break;
    case 'loot': {   // an item went into the bag: from a monster, or from a chest
      const text = stackText(ev.id, ev.n);
      chatLine('', `Loot: ${text}`, true);
      floatText(ev.x, 2.4, ev.z, text, itemTint(ev.id));
      sfx(880, 0.18, 'triangle', 0.06, 440);
      break;
    }
    case 'gift':   // handed over by the game itself: the Knight's shield
      notice(`You received ${ITEMS[ev.id].name}`);
      chatLine('', `You received ${ITEMS[ev.id].name}`, true);
      break;
    case 'err':   // the server refused an item request, or the bag was too full for loot
      notice(ev.m);
      chatLine('', ev.m, true);
      break;
    case 'potion':
      local.potionAt = time + POTION_CD;
      floatText(me.x, 3.3, me.z, `+${Math.max(1, ev.n)}`, ITEMS[ev.id]?.hp ? '#8ee68e' : '#a9c8ff');
      sfx(620, 0.2, 'sine', 0.06, 300);
      break;
    case 'bought':
      chatLine('', `Bought ${stackText(ev.id, ev.n)} for ${ev.gold} gold`, true);
      sfx(990, 0.1, 'triangle', 0.05, 300);
      break;
    case 'sold':
      chatLine('', `Sold ${stackText(ev.id, ev.n)} for ${ev.gold} gold`, true);
      sfx(990, 0.1, 'triangle', 0.05, -300);
      break;
    case 'gem':
      sfx(1200, 0.08, 'sine', 0.05, 600);
      break;
    case 'hurt':
      if (!targetId) setTarget(others.has(ev.o) ? ev.o : nearbyMobs(6)[0] || 0, false);   // being hit selects the attacker
      me.sitting = false;
      local.invuln = 0.5;
      shake = 0.6;
      $('flash').style.opacity = 1;
      setTimeout(() => { $('flash').style.opacity = 0; }, 120);
      burst(me.x, me.y + 1, me.z, 0xff4d7a, 10, 6);
      fx.wound(me.x, me.y + 1.1, me.z);
      sfx(140, 0.2, 'sawtooth', 0.09, -60);
      break;
    case 'tp': {
      const far = Math.hypot(ev.x - me.x, ev.z - me.z) > 40;
      me.x = ev.x; me.z = ev.z; me.y = 0; local.vy = 0;
      if (far) world.snapMood(me.x, me.z);   // a respawn across the map: no slow fade of the sky
      break;
    }
  }
}

// ---------------------------------------------------------------- input

const keys = new Set();
const fresh = new Set();   // keys pressed since the last frame, so warnings show once per press
const taps = new Set();    // keys "pressed" by a click on a slot of the action bar: held for one frame
// the keys of the action bar, slot by slot: 1 - 9, then 0
const BAR_KEYS = '1234567890', BAR_CODES = [...BAR_KEYS].map((d) => `Digit${d}`);
const mouse = new THREE.Vector2(0, -0.3);
const typing = () => document.activeElement === $('chatInput') || document.activeElement === $('nameInput');

// orbit camera: drag with the right mouse button to turn it, wheel to zoom
const cam = { yaw: 0, pitch: 0.9, dist: 16.5, drag: null };
// combat: the selected monster or cat, and whether this cat is auto-attacking it. `forced` is the peaceful cat the
// player has decided to attack - that takes a deliberate act (Ctrl + click, or the Attack button of its frame), so
// nobody turns into a murderer by a slip of the mouse.
let targetId = 0, attacking = false, forced = 0;

let noticeTimer = 0;
function notice(text) {
  $('notice').textContent = text;
  $('notice').classList.add('on');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => $('notice').classList.remove('on'), 1300);
}

// the monster or the cat under the cursor, if any
const pickV = new THREE.Vector3();
function pickTarget(clientX, clientY) {
  let best = 0, bestD = Infinity;
  for (const [id, v] of [...mobViews, ...others]) {
    if (!v.root.visible || v.killed || v.dead) continue;
    pickV.set(v.x, groundY(v.x, v.z) + v.top * 0.5, v.z);
    const pixelsPerUnit = innerHeight / (0.89 * camera.position.distanceTo(pickV));   // 0.89 = 2 * tan(fov / 2)
    pickV.project(camera);
    if (pickV.z > 1) continue;
    const d = Math.hypot((pickV.x + 1) / 2 * innerWidth - clientX, (1 - pickV.y) / 2 * innerHeight - clientY);
    if (d < Math.max(26, v.top * 0.6 * pixelsPerUnit) && d < bestD) { bestD = d; best = id; }
  }
  return best;
}

// Whether the cat `a` may be attacked now; `say` tells the player why not. Nobody in a safe place, and a peaceful cat
// only once the player has forced the attack (a flagged one and an outlaw are fair game).
function catFoe(a, id, say) {
  let why = '';
  if (isSafe(map, me.x, me.z) || isSafe(map, a.x, a.z)) why = 'No fighting in a safe place';
  else if (a.st === PVP_PEACE && forced !== id) why = 'Ctrl + click to attack a peaceful cat';
  if (why && say) notice(why);
  return !why;
}
// a monster is always a foe
const isFoe = (id, say) => !others.has(id) || catFoe(others.get(id), id, say);

function setTarget(id, attack, force = false) {
  if (id !== targetId) forced = 0;
  targetId = id;
  if (force && others.has(id)) forced = id;
  attacking = !!id && attack && isFoe(id, true);
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

// Tab: the next monster, nearest first.
function nextTarget() {
  const list = nearbyMobs(40);
  if (list.length) setTarget(list[(list.indexOf(targetId) + 1) % list.length], false);
}

function attackKey() {
  if (!targetId) setTarget(nearbyMobs(26)[0] || 0, true);
  else if (attacking) attacking = false;
  else setTarget(targetId, true, keys.has('ControlLeft') || keys.has('ControlRight'));
  if (!targetId) notice('No monsters nearby');
  else if (attacking) me.sitting = false;
}

addEventListener('keydown', (e) => {
  if (e.code === 'Enter') {
    if (state === 'menu') { connect(); return; }
    if (state !== 'playing') return;
    if (document.activeElement === $('chatInput')) sendChat();
    else $('chatInput').focus();
    return;
  }
  if (typing()) {
    if (e.code === 'Escape') $('chatInput').blur();
    return;
  }
  if (state !== 'playing') return;
  if (e.code === 'Tab' || e.code === 'F1') e.preventDefault();   // F1 is the browser's own help
  if (e.repeat) return;
  keys.add(e.code);
  fresh.add(e.code);
  if (e.code === 'Space') { e.preventDefault(); jump(); }
  if (e.code === 'Tab') nextTarget();
  if (e.code === 'Escape') {
    if (settingsOpen) toggleSettings(false); else if (mapOpen) toggleMap(false); else if (helpOpen) toggleHelp(false); else if (storeOpen) toggleStore(false); else if (bagOpen) toggleBag(false);
    else if (bookOpen) toggleBook(false); else if (sheetOpen) toggleSheet(false);
    else setTarget(0, false);
  }
  if (e.code === 'KeyX' && !stats.dead && me.castT < 0) { me.sitting = !me.sitting; if (me.sitting) attacking = false; }
  if (e.code === 'KeyK') toggleBook();
  if (e.code === 'KeyC') toggleSheet();
  if (e.code === 'KeyB') send({ t: 'b' });
  if (e.code === 'KeyI') toggleBag();
  if (e.code === 'KeyT') tradeKey();
  if (e.code === 'KeyH' || e.code === 'F1') toggleHelp();
  if (e.code === 'KeyM') toggleMap();
  if (e.code === 'KeyO') toggleSettings();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); cam.drag = null; endDrag(); });
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
  // left click: select a monster or a cat; clicking the selected one again starts the attack. With Ctrl (or Alt) held
  // it attacks at once, and a peaceful cat too.
  const id = pickTarget(e.clientX, e.clientY), force = e.ctrlKey || e.altKey;
  if (id) setTarget(id, id === targetId || force, force);
});
addEventListener('mouseup', (e) => {
  if (e.button !== 2 || !cam.drag) return;
  // a right click without dragging attacks the monster or the cat under the cursor
  if (cam.drag.moved < 6 && state === 'playing') {
    const id = pickTarget(cam.drag.x, cam.drag.y);
    if (id) setTarget(id, true, e.ctrlKey || e.altKey);
  }
  cam.drag = null;
});
renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  cam.dist = Math.max(7, Math.min(30, cam.dist * Math.exp(e.deltaY * 0.0012)));
}, { passive: false });
addEventListener('contextmenu', (e) => e.preventDefault());
// the Attack button of a cat's target frame: the deliberate act it takes to attack a peaceful cat, without the keyboard
$('tgAttack').addEventListener('click', () => { setTarget(targetId, true, true); $('tgAttack').blur(); });
$('playBtn').addEventListener('click', connect);
$('reloadBtn').addEventListener('click', () => location.reload());
// the way back to the map editor: it opens, or moves its camera, at the spot where the cat stands
$('editBtn').addEventListener('click', () => {
  window.open(`/editor.html#at=${me.x.toFixed(1)},${me.z.toFixed(1)}`, 'hypercat-editor')?.focus();
  $('editBtn').blur();
});
try { $('nameInput').value = localStorage.getItem('hypercat-name') || ''; } catch { /* ignore */ }

// class picker in the menu; it only matters for characters that have no class yet
let pickedClass = START_CLASSES[0];
try { pickedClass = START_CLASSES.includes(localStorage.getItem('hypercat-class')) ? localStorage.getItem('hypercat-class') : pickedClass; } catch { /* ignore */ }
function pickClass(id) {
  pickedClass = id;
  try { localStorage.setItem('hypercat-class', id); } catch { /* ignore */ }
  for (const b of $('classes').children) b.classList.toggle('on', b.dataset.cls === id);
  if (state === 'menu') setLook(me, id);   // the cat in the menu shows off the class
}
for (const id of START_CLASSES) {
  const b = document.createElement('button');
  b.dataset.cls = id;
  b.append(Object.assign(document.createElement('b'), { textContent: CLASSES[id].name }), Object.assign(document.createElement('small'), { textContent: CLASSES[id].text }));
  b.addEventListener('click', () => { pickClass(id); b.blur(); });
  $('classes').append(b);
}
pickClass(pickedClass);
loadSkeletons().catch(() => {});   // start downloading models while the player is still in the menu
loadMonsters(mapMonsters).catch(() => {});

function jump() {
  if (local.jumps >= 2 || stats.dead) return;
  me.sitting = false;
  local.vy = local.jumps === 0 ? 11 : 9.5;
  local.jumps++;
  burst(me.x, me.y + 0.1, me.z, 0xffffff, 5, 3);
  sfx(local.jumps === 1 ? 380 : 520, 0.12, 'triangle', 0.06, 250);
}

const moveDir = new THREE.Vector2();
// the movement part of a dash skill; the server grants the invulnerability
function startDash() {
  // dash where the cat is going, or straight ahead when standing still
  if (moveDir.lengthSq() > 0) local.dashDir.copy(moveDir).normalize();
  else local.dashDir.set(Math.sin(me.yaw), Math.cos(me.yaw));
  local.dashT = 0.18;
  sfx(700, 0.15, 'sawtooth', 0.05, -500);
}

// ---------------------------------------------------------------- update

const raycaster = new THREE.Raycaster();
const aimPoint = new THREE.Vector3();
const camTarget = new THREE.Vector3(me.x, groundY(me.x, me.z) + 0.45, me.z - 6), camGoal = new THREE.Vector3(), lookGoal = new THREE.Vector3();
const prev = { x: 0, z: 0 };   // where the cat stood before it moved this frame

const NEEDS_TARGET = ['strike', 'shot', 'bolt', 'sleep'];
const DRAW_SHARE = 0.9;   // the part of the time between two shots in which the cat takes an arrow, nocks it and draws

// where an area skill lands: the cursor, pulled in to the skill's range
function groundPoint(range) {
  let x = aimPoint.x - me.x, z = aimPoint.z - me.z;
  const d = Math.hypot(x, z);
  if (d > range) { x *= range / d; z *= range / d; }
  return [me.x + x, me.z + z];
}

// Sends a skill to the server and plays the caster's own part of it; everything else follows from the server's reply.
function useSkill(id, tdx, tdz) {
  const k = SKILLS[id];
  local.cds[id] = time + Math.max(k.cd, 0.3);
  const msg = { t: 'sk', s: id, tid: targetId };
  if (k.kind === 'ground') [msg.x, msg.z] = groundPoint(k.range);
  if (k.kind === 'strike') Object.assign(me, { swingT: 0, swingDur: SWING_DEFAULT, swingKind: 2 });   // the blow itself is drawn when the server confirms it
  if (k.kind === 'dash') startDash();
  // An attack skill also starts the auto-attack - when that goes on from where the cat stands: a blow does, and a shot
  // from a bow. A spell or a shot by a cat with a blade or a staff in its paw does not: it would run up to its target
  // to hit it, and whoever casts means to stay where they are. One that was running up already stops.
  const ranged = fightStyle(stats.cls, heldFamily(stats.cls, stats.eq)).ranged;
  if (k.kind === 'strike' || ((k.kind === 'shot' || k.kind === 'bolt') && ranged)) attacking = true;
  else if (k.kind === 'shot' || k.kind === 'bolt' || k.kind === 'sleep' || k.kind === 'ground') attacking = false;
  me.sitting = false;
  send(msg);
}

// The end of a frame's input: what was pressed since the last frame has been seen, and a click on a slot is let go.
function clearPresses() {
  for (const code of taps) keys.delete(code);
  taps.clear();
  fresh.clear();
}

function updateLocal(dt) {
  local.swordCd -= dt;
  local.fireCd -= dt;
  local.invuln -= dt;
  fx.hideAim();
  me.shootPose -= dt;

  let tv = mobViews.get(targetId) || others.get(targetId);
  if (targetId && (!tv || tv.killed || tv.dead)) { setTarget(0, false); tv = null; }   // the target died or walked out of view
  if (stats.dead) { me.speed = 0; me.castT = -1; me.drawT = -1; me.sitting = false; attacking = false; clearPresses(); return; }
  // stunned or asleep: the cat stands where it is until that has passed (the server would not hear of anything else)
  if (stats.cc & 3) { me.speed = 0; me.castT = -1; me.drawT = -1; clearPresses(); return; }
  // a fight with a cat ends where it may not go on: one of the two has reached a safe place, or the flag has run out
  if (attacking && tv?.cat && !catFoe(tv, targetId, true)) attacking = false;
  const cls = CLASSES[stats.cls], style = fightStyle(stats.cls, heldFamily(stats.cls, stats.eq));   // a bow shoots, whoever holds it

  // where area skills will land: the terrain under the cursor (the last such point while the cursor is on the sky)
  raycaster.setFromCamera(mouse, camera);
  const aimed = rayGround(map, raycaster.ray.origin, raycaster.ray.direction, camera.far);
  if (aimed) aimPoint.set(aimed.x, aimed.y, aimed.z);

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
    inReach = tDist < style.reach + tv.def.r;
  }
  if (tDist > 50 && tv) { setTarget(0, false); tv = null; }   // too far away to stay locked on
  // auto-attack: with no keys held the cat runs up to its target by itself
  if (attacking && tv && !manual && !inReach && me.castT < 0) moveDir.set(tdx, tdz);
  const moving = moveDir.lengthSq() > 0;

  prev.x = me.x; prev.z = me.z;
  if (local.dashT > 0) {
    local.dashT -= dt;
    me.x += local.dashDir.x * 32 * dt;
    me.z += local.dashDir.y * 32 * dt;
    me.speed = 9;
    burst(me.x, me.y + 0.8, me.z, TEAL, 2, 2);
  } else if (me.castT >= 0 || me.sitting) {
    me.speed = 0;   // rooted while casting or resting
  } else {
    const move = sheet.move * testSpeed * (stats.slow || 1);   // slowed by another cat's frost
    me.x += moveDir.x * move * dt;
    me.z += moveDir.y * move * dt;
    me.speed = moving ? move : 0;
  }
  const d = Math.hypot(me.x, me.z), max = map.radius - 1;
  if (d > max) { me.x *= max / d; me.z *= max / d; }
  world.collide(me, 0.4, prev);

  // me.y is the height above the ground. On its feet the cat simply follows the ground; in the air it keeps its real
  // height while the ground rises or falls under it, so a jump at a slope lands sooner and one off a ledge later.
  if (me.y > 0 || local.vy > 0) me.y += groundY(prev.x, prev.z) - groundY(me.x, me.z);
  local.vy -= 30 * dt;
  me.y += local.vy * dt;
  if (me.y <= 0) { me.y = 0; local.vy = 0; local.jumps = 0; }

  // ... and hits whenever its weapon is ready and the target is within reach
  const ready = attacking && tv && inReach && me.castT < 0 && local.dashT <= 0;
  if (ready && local.swordCd <= 0 && me.drawT < 0) {
    local.swordCd = sheet.atkCd;   // Atk.Spd
    if (style.ranged) {
      // a bow is drawn first: the arrow leaves, and the server is told, when the draw is full
      me.drawT = 0;
      me.drawDur = Math.min(1.4, Math.max(0.3, sheet.atkCd * DRAW_SHARE));
      sfx(180, 0.1, 'triangle', 0.03, 320);
    } else {
      me.swingT = 0;
      me.swingDur = swingTime(sheet.atkCd);   // a slow weapon swings slowly: the swing fills the pause between blows
      me.swingKind = local.combo;          // combo: left-to-right, right-to-left, overhead chop
      local.combo = (local.combo + 1) % 3;
      fx.swing(me.x, me.z, tdx, tdz, me.swingKind, me.swingDur * SWING_WINDUP);   // the smear waits for the blade
      send({ t: 'a', id: targetId, c: me.swingKind });
      sfx(300, 0.12, 'sawtooth', 0.04, 500);
    }
  }
  if (me.drawT >= 0) {
    if (!ready || manual || !style.ranged) {
      // walked off, lost the target or put the bow away: the arrow is let down, and the next draw may start at once
      me.drawT = -1;
      local.swordCd = Math.min(local.swordCd, 0.15);
    } else if ((me.drawT += dt) >= me.drawDur) {
      me.drawT = -1;
      me.shootPose = 0.3;   // the arrow itself appears when the server confirms the shot
      send({ t: 'a', id: targetId, c: me.swingKind });
      sfx(500, 0.12, 'sawtooth', 0.04, 500);
    }
  }

  // The action bar, keys 1 - 9 and 0. An item is used once per press; a skill is tried for as long as its key is held,
  // so a held key casts again when the cooldown ends. Shift is a shortcut for a dash skill.
  const learned = activeSkills(stats.cls, stats.skills);
  BAR_CODES.forEach((code, i) => {
    if (!fresh.has(code)) return;
    if (stats.bar[i] === BAR_ATTACK) attackKey();
    else if (ITEMS[stats.bar[i]]) useBarItem(stats.bar[i]);
  });
  if (me.castT < 0 && local.fireCd <= 0 && local.dashT <= 0) {
    let pick = null, code = '';
    for (let i = 0; i < BAR_SIZE && !pick; i++) if (keys.has(BAR_CODES[i]) && SKILLS[stats.bar[i]]) { pick = stats.bar[i]; code = BAR_CODES[i]; }
    if (!pick && learned.includes('shadow_step')) {
      for (const c of ['ShiftLeft', 'ShiftRight']) if (keys.has(c)) { pick = 'shadow_step'; code = c; }
    }
    if (pick) {
      const s = SKILLS[pick], targeted = NEEDS_TARGET.includes(s.kind);
      const warn = (text) => { if (fresh.has(code)) notice(text); };
      if (!learned.includes(pick)) warn(`You have not learned ${s.name}`);
      else if ((local.cds[pick] || 0) > time) warn(`${s.name} is not ready yet`);
      else if (stats.mp < s.mp) warn('Not enough mana');
      else if (targeted && !tv) warn('Select a target first');
      else if (targeted && tv.cat && !catFoe(tv, targetId, fresh.has(code))) { /* told why */ }
      else if (s.kind === 'strike' && !inReach) attacking = true;   // run up to the target first; the skill fires on arrival
      else if (targeted && s.range && tDist > s.range) warn('The target is too far away');
      else if (s.cast) {
        const duration = castTime(s, sheet);   // spells are sped up by Casting Spd, blows by what speeds the attacks
        Object.assign(me, { castT: 0, castSkill: pick, castDur: duration, sitting: false });
        send({ t: 'k', s: pick });
        if (isSpell(s)) sfx(220, duration, 'sine', 0.04, 500);   // a spell hums as it gathers; a blow is only heard when it lands
        else sfx(130, Math.min(duration, 0.25), 'triangle', 0.03, 90);
      } else {
        useSkill(pick, tdx, tdz);
        local.fireCd = 0.3;
      }
    }
  } else if (me.castT >= 0) {
    const s = SKILLS[me.castSkill];
    me.castT += dt;
    if (s.kind === 'ground') {
      const [gx, gz] = groundPoint(s.range);
      fx.aim(me.castSkill, gx, gz, s.radius);
    } else if (NEEDS_TARGET.includes(s.kind) && !tv) {
      me.castT = -1;   // the target is gone: the spell fizzles
    }
    if (me.castT >= me.castDur) {
      me.castT = -1;
      local.fireCd = 0.08;
      me.shootPose = 0.25;
      useSkill(me.castSkill, tdx, tdz);
    }
  }
  clearPresses();

  // The cat faces its target while fighting it, the landing spot while casting an area skill, and otherwise where it is going.
  const casting = me.castT >= 0 ? SKILLS[me.castSkill].kind : '';
  let face = null;
  if (tv && (me.swingT >= 0 || me.shootPose > 0 || NEEDS_TARGET.includes(casting) || (attacking && inReach && !manual))) face = Math.atan2(tdx, tdz);
  else if (casting === 'ground') face = Math.atan2(aimPoint.x - me.x, aimPoint.z - me.z);
  else if (local.dashT > 0) face = Math.atan2(local.dashDir.x, local.dashDir.y);
  else if (moving) face = Math.atan2(moveDir.x, moveDir.y);
  if (face !== null) me.yaw = lerpAngle(me.yaw, face, Math.min(1, dt * 14));

  local.sendT -= dt;
  if (local.sendT <= 0) {
    local.sendT = 1 / 15;
    send({ t: 'm', x: r2(me.x), y: r2(me.y), z: r2(me.z), yaw: r2(me.yaw), s: me.speed ? 1 : 0, st: me.sitting ? 1 : 0 });
  }

  const zone = regionLabel(regionAt(map, me.x, me.z));
  if (zone !== local.zone) { local.zone = zone; banner(zone); }
}

function updateAvatar(a, dt, isMe) {
  if (!isMe) {
    a.y = a.fy + (a.ty - a.fy) * glide(a);
    a.yaw = lerpAngle(a.yaw, a.tyaw, 1 - Math.exp(-12 * dt));
    a.shootPose -= dt;
    if (a.castT >= 0 && (a.castT += dt) >= a.castDur) a.castT = -1;
    a.bar.set(a.hp / a.maxHp, !a.dead && a.hp < a.maxHp);
  }
  a.root.position.set(a.x, groundY(a.x, a.z), a.z);   // the label and the bar stand on the ground with it
  a.cat.group.position.y = a.y;                       // the jump: the height above that ground
  a.root.rotation.y = cam.yaw;   // keeps the health bar parallel to the screen
  a.cat.group.rotation.y = a.yaw - cam.yaw;
  if (a.swingT >= 0 && (a.swingT += dt / a.swingDur) >= 1) a.swingT = -1;
  // stunned, asleep or slowed by another cat: the marks a monster wears, made the first time a cat needs them
  const flags = isMe ? stats.cc : a.flags;
  if (flags && !a.status) a.status = fx.status(a.root, a.top, a.def.r);
  a.status?.update(flags, time);
  const charge = a.castT >= 0 ? a.castT / a.castDur : 0;
  // a spell gathers as an orb; a blow or a shout is wound up, and shows in how the cat stands
  const spell = a.castT >= 0 && isSpell(SKILLS[a.castSkill] ?? {});
  a.orb.visible = spell;
  if (a.orb.visible && !a.cat.castPoint(a.orb.position)) a.orb.position.set(0, 1.0, 0.85);   // at the crystal of a staff, else between the paws
  a.orb.material = orbMat(a.castSkill);
  a.orb.scale.setScalar(0.06 + charge * 0.26);
  a.cat.update(dt, { speed: a.speed, airborne: a.y > 0.05, shooting: a.shootPose > 0, dashing: isMe && local.dashT > 0, casting: spell, windup: a.castT >= 0 && !spell ? a.castT / a.castDur : -1, sitting: a.sitting, hurt: isMe ? Math.max(0, local.invuln) / 0.5 : 0, draw: a.drawT >= 0 ? a.drawT / a.drawDur : -1, swing: a.swingT, swingKind: a.swingKind });
}

function updateViews(dt) {
  for (const a of others.values()) {
    updateAvatar(a, dt, false);
    a.root.visible = !a.dead;
  }

  const k = 1 - Math.exp(-10 * dt);
  for (const v of mobViews.values()) {
    const dx = v.tx - v.fx, dz = v.tz - v.fz;   // the step of this snapshot: where it is heading, and whether it walks
    if (dx * dx + dz * dz > 0.0004) v.yaw = lerpAngle(v.yaw, Math.atan2(dx, dz), k);
    glide(v);
    // a monster that has just come back rises out of the ground, through the circle that opened for it
    v.rise = Math.max(0, v.rise - dt);
    const under = v.rise / MOB_RISE;
    v.root.position.set(v.x, groundY(v.x, v.z) - (v.top + 1.2) * under * under, v.z);
    v.root.rotation.y = cam.yaw;   // keeps the health bar parallel to the screen
    v.skeleton.group.rotation.y = v.yaw - cam.yaw;
    // monsters far outside the camera's view are neither drawn nor animated
    v.root.visible = (v.x - me.x) ** 2 + (v.z - me.z) ** 2 < 55 * 55;
    // a stunned or sleeping monster freezes mid-pose
    if (v.root.visible && !(v.flags & 3)) v.skeleton.update(dt, time, dx * dx + dz * dz > 0.002);
    v.flash = Math.max(0, v.flash - dt * 6);
    v.skeleton.flash(v.flash);
    v.bar.set(v.hp / v.maxHp, v.hp < v.maxHp);
    // stunned, asleep or slowed: the marks are made the first time a monster needs them
    if (v.flags && !v.status) v.status = fx.status(v.root, v.top, v.def.r);
    v.status?.update(v.flags, time);
  }

  // corpses play the death animation, then sink into the ground
  for (let j = corpses.length - 1; j >= 0; j--) {
    const c = corpses[j];
    c.t += dt;
    c.v.skeleton.update(dt, time, false);
    if (c.t > 1.8) c.v.root.position.y = groundY(c.v.x, c.v.z) - (c.t - 1.8) * 1.5 * c.v.skeleton.group.scale.y;
    if (c.t > 3) { removeMobView(c.v); corpses.splice(j, 1); }
  }

  for (const v of chestViews) {
    v.root.visible = (v.root.position.x - me.x) ** 2 + (v.root.position.z - me.z) ** 2 < 60 * 60;
    if (v.root.visible && v.lid) v.lid.rotation.x += ((v.open ? -1.9 : 0) - v.lid.rotation.x) * Math.min(1, dt * 8);
  }

  let i = 0;
  for (const g of gemViews.values()) {
    g.mesh.rotation.y += dt * 3;
    g.mesh.position.y = g.ground + 0.55 + Math.sin(time * 4 + i++) * 0.12;
  }

  // projectiles are simulated locally for looks; the server decides the damage
  bullets = bullets.filter((b) => {
    const v = viewOf(b.id), m = b.mesh.position;
    let done = !v;
    if (v) {
      const dx = v.x - m.x, dz = v.z - m.z, d = Math.hypot(dx, dz) || 0.001, step = b.speed * dt;
      // it follows the lie of the land, so a rise between the two is flown over, not through
      b.h += (v.top * 0.5 - b.h) * Math.min(1, dt * 8);
      if (d <= step + v.def.r * 0.6) { done = true; fx.hit(b.kind, v.x, v.top * 0.5, v.z, v.def.r); }
      else { m.x += dx / d * step; m.z += dz / d * step; }
      m.y = groundY(m.x, m.z) + b.h;
      fx.point(b.mesh, v.x, groundY(v.x, v.z) + v.top * 0.5, v.z, dt);
    }
    if (done) fx.drop(b.mesh);
    return !done;
  });

  const tv = mobViews.get(targetId) || others.get(targetId);
  targetRing.visible = !!tv;
  if (tv) {
    targetRing.scale.setScalar(!tv.skeleton ? 1.05 : tv.def.draw ? tv.def.r * 1.3 + 0.4 : tv.skeleton.group.scale.y * 0.75 + 0.35);
    layOnGround(targetRing, tv.x, tv.z, targetRing.scale.x / 2, 0.07);
    targetRing.material.color.setHex(attacking ? 0xff4d5e : 0xffd76a);
  }
  // The monsters' fireballs: each is carried on from where the server last had it, and leaves a wake of sparks. It
  // skims the ground - the server lets it hit whoever is not jumping.
  const pull = 1 - Math.exp(-18 * dt);
  for (const v of orbViews.values()) {
    const ahead = time - v.st;
    v.x += (v.sx + v.vx * ahead - v.x) * pull; v.z += (v.sz + v.vz * ahead - v.z) * pull;
    const y = groundY(v.x, v.z) + 1;
    v.mesh.position.set(v.x, y, v.z);
    fx.point(v.mesh, v.x + v.vx, y, v.z + v.vz, dt);
    if ((v.puff -= dt) <= 0) { v.puff = 0.045; burst(v.x, 1, v.z, FIRE, 1, 1.4); }
  }

  for (let j = floaters.length - 1; j >= 0; j--) {
    const f = floaters[j];
    f.t += dt;
    f.sprite.position.y += dt * 1.7;
    f.sprite.material.opacity = Math.min(1, (1 - f.t) * 2.5);
    if (f.t >= 1) { disposeSprite(f.sprite); floaters.splice(j, 1); }
  }
}

// ---------------------------------------------------------------- action bar & skill book

const TINT = { strike: '#ffb3b3', shot: '#ffe9a6', bolt: '#7fe8d6', ground: '#ffa040', heal: '#8ee68e', buff: '#ffd76a', taunt: '#ff6b6b', sleep: '#c9a6ff', dash: '#cfd8dc', revive: '#ffffff', passive: '#8fa8a2' };
const FX_TINT = { frost: '#a9d8ff', fire: '#ffa040', arrow: '#ffe9a6' };
const skillTint = (id) => FX_TINT[SKILLS[id].fx] || TINT[SKILLS[id].kind];
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
// A picture from the icon set (assets/icons), as an element that fills whatever holds it.
function picture(url) {
  const icon = el('i', 'icon pic');
  icon.style.backgroundImage = `url("${url}")`;
  return icon;
}
// what stands for a skill, on the bar and in the skill book: its icon - or, for a skill without one, a glowing orb
function skillOrb(id) {
  if (skillIcon(id)) return picture(skillIcon(id));
  const icon = el('i', 'icon');
  icon.style.setProperty('--tint', skillTint(id));
  return icon;
}

// What a slot of the bar looks like with this in it - the attack, a skill or an item: its icon, edged in the tier's
// colour for an item (the name is in the tooltip); nothing: an empty slot. The ghost of a drag is drawn by the same
// function.
function barFace(id) {
  const face = el('div', 'act');
  if (id === BAR_ATTACK) face.append(picture(ATTACK_ICON));
  else if (SKILLS[id]) face.append(skillOrb(id), ...(skillIcon(id) ? [] : [SKILLS[id].name]));
  else if (ITEMS[id]) {
    face.classList.add('item');
    face.style.setProperty('--tint', itemTint(id));
    face.append(itemGlyph(id));
  } else face.classList.add('empty');
  return face;
}

// The bar is rebuilt only when what is in its slots changes; cooldowns, counts and states are updated every frame.
let barKey = null, barSlots = [];
// The experience bar lies under the ten slots, from the left edge of the first to the right edge of the last. It is a child of the action bar, which is as wide as the row of its
// slots and nothing else, so the bar follows that width whatever the layout does. No text on it: hovering tells.
const xpBar = el('div'), xpFill = el('i');
xpBar.id = 'xpbar';
xpFill.id = 'xpFill';
const xpText = el('div');
xpText.id = 'xpText';
xpBar.append(el('div', 'track'), xpText);
xpBar.firstChild.append(xpFill);
const xpShare = () => stats.xp / xpNext(stats.level) * 100;
const xpLine = () => `Level ${stats.level} · ${stats.xp.toLocaleString('en-US')} / ${xpNext(stats.level).toLocaleString('en-US')} XP (${xpShare().toFixed(1)} %)`;
tipOn(xpBar, () => [el('b', 'name', 'Experience'), el('div', '', xpLine())]);
$('actionbar').append(xpBar);
function renderBar() {
  const key = JSON.stringify(stats.bar);
  if (key === barKey) return;
  barKey = key;
  if (tipAnchor && $('actionbar').contains(tipAnchor)) hideTip();   // the slot it described is about to be replaced
  barSlots = stats.bar.map((id, i) => {
    const k = SKILLS[id], it = ITEMS[id], node = barFace(id);
    // note: the mana a skill costs; how many of an item the bag holds
    const note = el('span', k ? 'mp' : 'n', k ? String(k.mp) : ''), cd = el('i', 'cd'), left = el('span', 'time');
    node.prepend(el('kbd', '', BAR_KEYS[i]));
    node.append(note, cd, left);
    node.addEventListener('click', () => tapSlot(i));
    // the attack is never taken off the bar
    node.addEventListener('contextmenu', () => { if (stats.bar[i] && stats.bar[i] !== BAR_ATTACK) setBar(stats.bar.map((entry, j) => (j === i ? null : entry))); });
    dragFrom(node, () => stats.bar[i] && { id: stats.bar[i], from: i });
    tipOn(node, () => slotTip(i));
    return { id, k, it, node, note, cd, left };
  });
  $('actionbar').replaceChildren(...barSlots.map((slot) => slot.node), xpBar);
}

// A click on a slot is a press of its key that lasts one frame.
function tapSlot(i) {
  if (state !== 'playing') return;
  for (const set of [keys, fresh, taps]) set.add(BAR_CODES[i]);
}
// A new arrangement of the bar: shown at once, and kept by the server with the character.
function setBar(bar) {
  stats.bar = bar;
  send({ t: 'bar', bar });
  sfx(480, 0.06, 'triangle', 0.04, 160);
}
// What a slot does with its item: a potion is drunk, a piece of gear is put on. A piece that is worn already stays
// on - a second press in the middle of a fight must not strip the cat; taking it off is done in the inventory.
function useBarItem(id) {
  const it = ITEMS[id], i = stats.inv.findIndex((stack) => stack[0] === id);
  if (it.slot && stats.eq[it.slot] === id) notice(`${it.name} is already worn`);
  else if (i < 0) notice(`No ${it.name} in the bag`);
  else useStack(i);
}
const bagCount = (id) => stats.inv.reduce((sum, [item, n]) => sum + (item === id ? n : 0), 0);

// What the tooltip says about a skill. `hints` are the lines about what can be done with it here.
function skillTip(id, hints = []) {
  const k = SKILLS[id], rank = stats.skills[id] | 0, known = activeSkills(stats.cls, stats.skills).includes(id), out = [];
  const line = (text, cls = '') => out.push(el('div', cls, text));
  const name = el('b', 'name', k.name);
  name.style.color = skillTint(id);
  out.push(name);
  line(known ? `Skill · rank ${rank}/${k.sp.length}` : 'Skill · not learned', known ? 'kind' : 'kind bad');
  line(k.text);
  const facts = [k.mp && `${k.mp} mana`, k.cast && `${castTime(k, sheet).toFixed(2)}s cast`, k.cd && `${k.cd}s cooldown`].filter(Boolean).join(' · ');
  if (facts) line(facts, 'dim');
  for (const hint of hints) line(hint, 'hint');
  return out;
}
function slotTip(i) {
  const id = stats.bar[i], key = BAR_KEYS[i], it = ITEMS[id];
  if (!id) return [el('div', 'kind', `Slot ${key} · empty`), el('div', 'hint', 'Drag a skill from the skill book (K) or an item from the inventory (I) here')];
  if (id === BAR_ATTACK) {
    return [el('b', 'name', 'Attack'), el('div', '', 'Runs up to the target and keeps hitting it with the weapon.'),
      el('div', 'hint', `Key ${key} or click`), el('div', 'hint', 'Drag onto another slot to move it')];
  }
  const arrange = 'Drag to move · drag off the bar or right-click to clear';
  if (SKILLS[id]) return skillTip(id, [`Key ${key} or click to use it`, arrange]);
  const worn = !!it.slot && stats.eq[it.slot] === id;
  const use = it.kind === 'potion' ? `Key ${key} or click to drink one · ${bagCount(id)} in the bag`
    : `Key ${key} or click to wear it; pressed again, it stays on`;
  return itemTip(id, [use, arrange], worn);
}

// ---- dragging onto the action bar
// Skills from the skill book, items from the inventory and the slots of the bar itself are dragged with the pointer: a
// ghost follows the cursor and the slot under it lights up. (The browser's own drag-and-drop is unreliable over a
// WebGL canvas.) A press that does not move stays a click.
let drag = null;        // { id, from, x, y, ghost }; from: the slot of the bar it came from, -1 for the book and the bag
let dragEnded = false;  // a drag was let go this very moment: the click that follows the release is not a click
// `what` returns { id, from? } for the thing under the pointer, or nothing when there is nothing to drag.
function dragFrom(node, what) {
  node.addEventListener('pointerdown', (e) => {
    const src = e.button === 0 && state === 'playing' && what();
    if (src) drag = { from: -1, ...src, x: e.clientX, y: e.clientY, ghost: null };
  });
}
const within = (node, x, y) => { const r = node.getBoundingClientRect(); return x >= r.left && x < r.right && y >= r.top && y < r.bottom; };
const slotAt = (x, y) => barSlots.findIndex(({ node }) => within(node, x, y));
addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.ghost) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;   // still a click
    drag.ghost = barFace(drag.id);
    drag.ghost.id = 'ghost';
    $('hud').append(drag.ghost);
    hideTip();
  }
  drag.ghost.style.left = `${e.clientX}px`;
  drag.ghost.style.top = `${e.clientY}px`;
  const over = slotAt(e.clientX, e.clientY);
  barSlots.forEach(({ node }, i) => node.classList.toggle('drop', i === over));
});
// The end of a drag. `e` is the release; without it (the window lost the pointer) nothing is dropped anywhere.
function endDrag(e) {
  const d = drag;
  drag = null;
  if (!d?.ghost) return;
  d.ghost.remove();
  for (const { node } of barSlots) node.classList.remove('drop');
  dragEnded = true;
  setTimeout(() => { dragEnded = false; }, 0);
  if (e?.type !== 'pointerup') return;
  const to = slotAt(e.clientX, e.clientY), bar = [...stats.bar];
  if (to >= 0) {
    if (to === d.from) return;
    // the attack stays on the bar: its slot swaps with another one, and nothing from the book or the bag replaces it
    if (d.from < 0 && bar[to] === BAR_ATTACK) { notice('The Attack slot can only be moved, not replaced'); return; }
    if (d.from >= 0) bar[d.from] = bar[to];   // slot onto slot: the two swap
    bar[to] = d.id;
  } else if (d.from >= 0 && d.id !== BAR_ATTACK && !within($('actionbar'), e.clientX, e.clientY)) bar[d.from] = null;   // off the bar: the slot is cleared
  else return;   // let go between two slots, or a skill or an item dropped beside the bar
  setBar(bar);
}
addEventListener('pointerup', endDrag);
addEventListener('pointercancel', endDrag);
addEventListener('click', (e) => { if (dragEnded) { e.stopPropagation(); e.preventDefault(); } }, true);

// ---- windows
// Windows that would lie on top of each other never stand open together. The skill book and the help fill the middle:
// opening one of them closes everything else. On a wide screen the inventory stands to the right of the middle and
// the status window or the Trader's list - one of the two - to the left of it; a narrower one has room for a single
// window between the chat and the radar, so there every window closes the others. (index.html has the same width.)
const PAIRS = matchMedia('(min-width: 1720px)');
PAIRS.addEventListener('change', () => { if (!PAIRS.matches && (storeOpen || sheetOpen)) toggleBag(false); });
let bookOpen = false, bookKey = null, helpOpen = false;
function toggleBook(open = !bookOpen) {
  if (open) { toggleHelp(false); toggleSheet(false); toggleStore(false); toggleBag(false); toggleMap(false); toggleSettings(false); }
  bookOpen = open;
  bookKey = null;
  $('book').classList.toggle('on', open);
  if (!open && tipAnchor && $('book').contains(tipAnchor)) hideTip();
}
function toggleHelp(open = !helpOpen) {
  if (open) { toggleBook(false); toggleSheet(false); toggleStore(false); toggleBag(false); toggleMap(false); toggleSettings(false); }
  helpOpen = open;
  $('help').classList.toggle('on', open);
}

// ---- the world map: the whole island, where the radar shows only what is around the cat. It is surveyed and painted
// when it is first opened, and drawn again ten times a second while it is open (src/worldmap.js).
// How dangerous a monster of a level is for this player: at least so many levels above it, the colour, the word.
const THREAT = [[5, '#ff5a6a', 'deadly'], [3, '#ffa24d', 'hard'], [-2, '#fff3b0', 'even'], [-5, '#8ee68e', 'easy'], [-Infinity, '#aab4b8', 'trivial']];
const threat = (lvl) => THREAT.find(([above]) => lvl - stats.level >= above)[1];
let mapOpen = false, worldMap = null, mapHover = null;
function toggleMap(open = !mapOpen) {
  if (open) { toggleBook(false); toggleHelp(false); toggleSheet(false); toggleStore(false); toggleBag(false); toggleSettings(false); }
  mapOpen = open;
  $('worldmap').classList.toggle('on', open);
  if (open) {
    worldMap ??= createWorldMap($('mapView'), map);
    drawWorldMap();
  } else mapHover = null;
}
const MAP_EVERY = 0.1;   // seconds between two drawings of the open map: nothing on an island moves faster than that shows
let mapDue = 0;
function drawWorldMap() {
  mapDue = MAP_EVERY;
  worldMap.draw({ me, others: others.values(), threat });
  tellMapHover();
}
// The line over the map: what is under the cursor, or where the cat is. It follows the cursor at once - the picture
// itself has not changed, so it is not drawn again for that.
function tellMapHover() {
  const hit = mapHover && worldMap.pick(mapHover.x, mapHover.y);
  const text = hit ? worldMap.describe(hit) : `You are in ${regionLabel(regionAt(map, me.x, me.z))}`;
  if ($('mapSub').textContent !== text) $('mapSub').textContent = text;
}
$('mapView').addEventListener('mousemove', (e) => { mapHover = { x: e.clientX, y: e.clientY }; tellMapHover(); });
$('mapView').addEventListener('mouseleave', () => { mapHover = null; tellMapHover(); });
$('minimap').addEventListener('click', () => { if (state === 'playing') toggleMap(); });   // the radar opens the map it is a part of
$('mapLegend').append('Camps', ...[...THREAT].reverse().map(([, color, word]) => {
  const item = el('span', '', word);
  item.style.setProperty('--tint', color);
  return item;
}));
// ---- settings: sound and graphics. A change is at work at once and is kept in the browser; the controls give the
// keyboard back as soon as they have been used, or the arrows that walk the cat would also move the volume.
let settingsOpen = false;
function toggleSettings(open = !settingsOpen) {
  if (open) { toggleBook(false); toggleHelp(false); toggleSheet(false); toggleStore(false); toggleBag(false); toggleMap(false); }
  settingsOpen = open;
  $('settings').classList.toggle('on', open);
  if (open) showSettings();
}
function showSettings() {
  for (const box of $('settings').querySelectorAll('input[type=checkbox]')) box.checked = settings[box.dataset.set];
  $('setVolume').value = settings.volume;
  $('setVolume').disabled = !settings.sound;
  $('setVolumeText').textContent = `${settings.volume}%`;
  for (const b of $('setResolution').children) b.classList.toggle('on', b.dataset.v === settings.resolution);
  showAuto();
}
// what Auto is doing right now, and the frame rate it goes by
function showAuto() {
  const now = lowered(settings, settings.auto ? auto.step : 0);
  const less = ['resolution', 'shadows', 'glow', 'grass'].filter((key) => now[key] !== settings[key]);
  $('setAutoNow').textContent = `${Math.round(auto.fps)} frames a second${less.length ? ` · Auto has lowered: ${less.join(', ')}` : ''}`;
}
function changeSettings(change) {
  Object.assign(settings, cleanSettings({ ...settings, ...change }));
  Object.assign(auto, { step: 0, floor: 0, slow: 0, fast: 0, wait: 5 });   // the player has spoken: Auto starts over from there
  writeStore('localStorage', SETTINGS_KEY, JSON.stringify(settings));
  applySettings();
  showSettings();
}
for (const box of $('settings').querySelectorAll('input[type=checkbox]')) {
  box.addEventListener('change', () => { changeSettings({ [box.dataset.set]: box.checked }); box.blur(); });
}
$('setVolume').addEventListener('input', () => changeSettings({ volume: Number($('setVolume').value) }));
$('setVolume').addEventListener('change', () => { $('setVolume').blur(); sfx(660, 0.12, 'triangle', 0.06, 200); });   // how loud that is
$('setResolution').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) { changeSettings({ resolution: b.dataset.v }); b.blur(); }
});
$('setReset').addEventListener('click', () => { changeSettings(DEFAULT_SETTINGS); $('setReset').blur(); });


// The skill book lists everything the class can learn. Buying is only possible next to a Sage - and a map need not have one.
const hasSage = npcsOf(map, 'sage').length > 0;
function renderBook(atSage) {
  const key = [stats.cls, stats.level, stats.sp, atSage, JSON.stringify(stats.skills)].join('|');
  if (key === bookKey) return;
  bookKey = key;
  const cls = CLASSES[stats.cls];
  $('bookTitle').textContent = `${cls.name} skills`;
  const where = atSage ? 'The Sage will teach you what you can afford.'
    : hasSage ? 'Find a Sage to learn skills.' : 'There is no Sage in this world to learn skills from.';
  $('bookSub').textContent = `Skill points: ${stats.sp} · ${where} Drag a learned skill onto the action bar.`;
  if (tipAnchor && $('book').contains(tipAnchor)) hideTip();   // the row it described is about to be replaced
  const list = $('bookList');
  list.replaceChildren();
  const button = (label, enabled, onClick) => {
    const b = el('button', '', label);
    b.disabled = !enabled;
    b.addEventListener('click', () => { onClick(); b.blur(); });
    return b;
  };

  if (!cls.base) {   // a starting class: show what it can become
    const box = el('div', 'prof');
    const ready = stats.level >= PROFESSION_LEVEL;
    box.append(el('b', '', ready ? 'Choose your profession' : `Professions open at level ${PROFESSION_LEVEL}`));
    for (const id of professionsOf(stats.cls)) {
      const row = el('div');
      row.append(el('b', '', CLASSES[id].name), el('span', '', CLASSES[id].text));
      if (ready) row.append(button('Become', atSage, () => send({ t: 'prof', cls: id })));
      box.append(row);
    }
    list.append(box);
  }

  for (const id of skillsFor(stats.cls)) {
    const k = SKILLS[id], rank = stats.skills[id] | 0, max = k.sp.length, tooLow = stats.level < k.lvl;
    const row = el('div', `sk${tooLow ? ' locked' : ''}`), info = el('div', 'info'), name = el('div', 'name', k.name), orb = skillOrb(id);
    name.append(el('small', '', `${k.kind === 'passive' ? 'passive · ' : ''}rank ${rank}/${max}${tooLow ? ` · level ${k.lvl}` : ''}`));
    const facts = [k.mp && `${k.mp} mana`, k.cast && `${castTime(k, sheet).toFixed(2)}s cast`, k.cd && `${k.cd}s cooldown`].filter(Boolean).join(' · ');
    info.append(name, el('div', 'text', facts ? `${k.text} ${facts}.` : k.text));
    row.dataset.skill = id;
    if (k.kind !== 'passive' && rank > 0) {   // a learned active skill is dragged by its orb or its text onto the action bar
      for (const part of [orb, info]) { part.classList.add('grab'); dragFrom(part, () => ({ id })); }
      tipOn(orb, () => skillTip(id, ['Drag onto the action bar']));
    }
    row.append(orb, info, rank >= max
      ? button('Mastered', false, () => {})
      : button(`${rank ? 'Upgrade' : 'Learn'} · ${k.sp[rank]} SP`, atSage && !tooLow && stats.sp >= k.sp[rank], () => send({ t: 'learn', s: id })));
    list.append(row);
  }
}

// ---------------------------------------------------------------- items: icons, tooltip, inventory, trader

// Icons are drawn, not loaded: a 24 x 24 glyph in the colour of the item's tier (potions: of what they restore).
const ICONS = {
  sword: '<path d="M20.5 2.5l1 1-1 4.5-9 9-2.5-2.5 9-9zM7.5 13l3.5 3.5-1.6 1.6-1-1-3.2 3.2-1.5-1.5 3.2-3.2-1-1z"/>',
  daggers: '<path d="M3 3l8 4.5-3.5 3.500zM10 10l1.8 1.8-1.3 1.3-1.8-1.800zM21 3l-8 4.5 3.5 3.500zM14 10l-1.8 1.8 1.3 1.3 1.8-1.800zM9 14.500l1.5 1.5-4.5 4.5-1.5-1.500zM15 14.500l-1.5 1.5 4.5 4.5 1.5-1.500z"/>',
  bow: '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M7 3c11 3 11 15 0 18M7 3v18"/><path d="M2 11h13v-2.500l5 3.5-5 3.500v-2.500h-13z"/>',
  staff: '<path d="M6 21.500l-1.5-1.5 9-9 1.5 1.500z"/><circle cx="17" cy="7" r="4"/><circle cx="17" cy="7" r="1.6" fill="#fff"/>',
  greatsword: '<path d="M21.6 1.4l1 1-.8 5.400-9.300 9.300-3.600-3.600 9.300-9.300zM5.800 9.200l9 9-1.700 1.700-9-9zM7.300 15.200l1.500 1.500-3.300 3.300-1.500-1.500z"/><circle cx="3.700" cy="20.300" r="1.700"/>',
  offhand: '<path fill-rule="evenodd" d="M12 1.800l8.700 2.900v6.300c0 5.300-3.600 9.200-8.700 11.200-5.100-2-8.700-5.900-8.700-11.200v-6.300zM12 4.500l-6.200 2.100v4.400c0 3.900 2.500 6.800 6.200 8.400 3.700-1.600 6.200-4.500 6.200-8.400v-4.400z"/><circle cx="12" cy="11" r="2.500"/>',
  head: '<path d="M4 14a8 8 0 0116 0v5h-5v-5h-2v5h-2v-5h-2v5h-5z"/><path d="M11 3h2v4h-2z"/>',
  body: '<path d="M8 3l4 2 4-2 5 4-3 3.5-1-1v11.500h-10v-11.500l-1 1-3-3.500z"/>',
  hands: '<path d="M7 21v-5l-3.5-4.5 1.8-1.5 2.7 2.500v-8a1.5 1.5 0 013 0v4.500h1v-6a1.5 1.5 0 013 0v6h1v-4.500a1.5 1.5 0 013 0v10.500l-1.5 6z"/>',
  feet: '<path d="M8 3h7v9.500l6 3a2 2 0 011 1.800v3.700h-14z"/>',
  potion: '<path d="M9 2h6v2h-1v4.500l4.5 7.500a3.5 3.5 0 01-3 5.500h-7a3.5 3.5 0 01-3-5.500l4.5-7.500v-4.500h-1z"/>',
};
const POTION_TINT = { hp: '#ff6b8e', mp: '#6fa4ff' };
const FAMILY_NAMES = { sword: 'Sword', daggers: 'Daggers', bow: 'Bow', staff: 'Staff', greatsword: 'Greatsword' };
// what kind of thing a piece of gear is, in a few words: a weapon says how many paws it takes
const gearKind = (it) => (it.kind === 'weapon' ? `${FAMILY_NAMES[it.family]} · ${it.hands === 2 ? 'Two-handed' : 'One-handed'}`
  : it.kind === 'shield' ? `Shield · ${SLOT_NAMES[it.slot]}` : `Armour · ${SLOT_NAMES[it.slot]}`);
const listOf = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]);
const itemTint = (id) => { const it = ITEMS[id]; return it.kind === 'potion' ? POTION_TINT[it.hp ? 'hp' : 'mp'] : css(TIERS[it.tier].color); };
const stackText = (id, n) => (n > 1 ? `${ITEMS[id].name} ×${n}` : ITEMS[id].name);

// A glyph as an element; it takes the colour of the text around it.
function glyph(paths) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.innerHTML = paths;
  return svg;
}
// an item's icon; the flat glyph only for an item the icon set does not know
const itemGlyph = (id) => (itemIcon(id) ? picture(itemIcon(id)) : glyph(ICONS[ITEMS[id].kind === 'potion' ? 'potion' : ITEMS[id].family || ITEMS[id].slot]));

// A square tile: an empty slot (with the faint outline of a `shape`, when one is named), or an item with its icon
// and, for a stack, its count.
function tile(id, n = 1, shape = '') {
  const t = el('div', 'slot');
  if (!id) {
    if (shape) { t.classList.add('hollow'); t.append(glyph(ICONS[shape])); }
    return t;
  }
  t.classList.add('full');
  t.style.setProperty('--tint', itemTint(id));
  t.append(itemGlyph(id));
  if (n > 1) t.append(el('span', 'n', String(n)));
  return t;
}

// The tooltip follows the cursor over whatever `tipOn` was called for; `build` returns its content when it is needed.
let tipAnchor = null;
function tipOn(node, build) {
  node.addEventListener('mouseenter', (e) => {
    if (drag?.ghost) return;   // what is being dragged covers the spot, and says what it is
    tipAnchor = node; $('tip').replaceChildren(...build()); $('tip').classList.add('on'); placeTip(e);
  });
  node.addEventListener('mousemove', (e) => { if (tipAnchor === node) placeTip(e); });
  node.addEventListener('mouseleave', () => { if (tipAnchor === node) hideTip(); });
}
function placeTip(e) {
  const tip = $('tip'), w = tip.offsetWidth, h = tip.offsetHeight;
  // to the right of the cursor and below it, or on the other side where the window ends. At the lower edge that is
  // above the cursor - and above the whole action bar for one of its slots, so that the tooltip does not lie on the bar
  const bar = tipAnchor?.closest('#actionbar'), floor = bar ? bar.getBoundingClientRect().top - 8 : e.clientY - 12;
  tip.style.left = `${e.clientX + 16 + w > innerWidth ? Math.max(4, e.clientX - 12 - w) : e.clientX + 16}px`;
  tip.style.top = `${Math.max(4, e.clientY + 14 + h > innerHeight - 4 ? floor - h : e.clientY + 14)}px`;
}
function hideTip() {
  tipAnchor = null;
  $('tip').classList.remove('on');
}

// This character's stats without what it wears, under the buffs active now.
const buffsNow = () => Object.fromEntries(stats.buffs.map(([stat, , mult]) => [stat, mult]));
const bareSheet = () => statsOf(stats.cls, stats.level, stats.skills, stats.weapon, buffsNow(), null);

// What the tooltip says about an item. `hint` is the line - or the lines - about what can be done with it here;
// `worn`: the item is the one in its slot.
function itemTip(id, hint, worn = false) {
  const it = ITEMS[id], out = [];
  const line = (text, cls = '') => out.push(el('div', cls, text));
  const name = el('b', 'name', it.name);
  name.style.color = itemTint(id);
  out.push(name);
  if (it.kind === 'potion') {
    line('Potion', 'kind');
    line(`Restores ${it.hp || it.mp} ${it.hp ? 'health' : 'mana'}`);
    line(`${POTION_CD} s before the next potion`, 'dim');
  } else {
    line(`${gearKind(it)} · ${TIERS[it.tier].name} tier`, 'kind');
    for (const [k, v] of Object.entries(it.bonus)) line(`+${v} ${BONUS_NAMES[k]}`);
    line(`Requires level ${it.lvl}`, stats.level < it.lvl ? 'bad' : 'dim');
    // What wearing it would change, in the numbers of the status window - with all that comes off for it: a weapon
    // for both paws takes the shield off too, and a shield such a weapon.
    if (!worn && !equipError(stats.cls, stats.level, id)) {
      const old = stats.eq[it.slot], off = comesOff(stats.eq, id), after = statsOf(stats.cls, stats.level, stats.skills, stats.weapon, buffsNow(), equipWith(stats.eq, id));
      const changes = SHEET_ROWS.flat().filter((r) => r && after[r[1]] !== sheet[r[1]]);
      if (changes.length || off.length) line(old === id ? 'The same as what you wear' : off.length ? `Instead of ${listOf(off.map((item) => ITEMS[item].name))}:` : 'If you wear it:', 'kind');
      for (const [label, k] of changes) line(`${label} ${sheet[k]} → ${after[k]} (${after[k] > sheet[k] ? '+' : ''}${after[k] - sheet[k]})`, after[k] > sheet[k] ? 'good' : 'bad');
    }
  }
  line(`Sells for ${sellPrice(id)} gold`, 'dim');
  for (const text of [hint].flat()) if (text) line(text, 'hint');
  return out;
}

// ---- inventory: the character's numbers, the paper doll and the bag, side by side

let bagOpen = false, bagKey = null, bagCds = [], bagTab = 'all', statsKey = null;
function toggleBag(open = !bagOpen) {
  if (open) { toggleBook(false); toggleHelp(false); toggleMap(false); toggleSettings(false); }
  if (open && !PAIRS.matches) { toggleSheet(false); toggleStore(false); }
  bagOpen = open;
  bagKey = statsKey = null;
  $('bag').classList.toggle('on', open);
  $('hud').classList.toggle('bagOpen', open);   // the status window moves aside for it
  if (!open) hideTip();
}
// the tabs above the bag show all of it, or only the gear, or only the potions
for (const b of $('bagTabs').children) {
  b.addEventListener('click', () => { bagTab = b.dataset.tab; bagKey = null; b.blur(); });
}

// A click on an item of the bag wears it or drinks it. The server decides; what it would refuse anyway is said at once.
function useStack(i) {
  const [id] = stats.inv[i] || [], it = ITEMS[id];
  if (!it || stats.dead) return;
  if (it.kind === 'potion') { drink(i); return; }
  const err = equipError(stats.cls, stats.level, id) || wearError(stats.inv, stats.eq, id);
  if (err) { notice(err); return; }
  send({ t: 'eq', i, id });
  sfx(330, 0.12, 'triangle', 0.06, 200);
}
function takeOff(slot) {
  const id = stats.eq[slot];
  if (!id || stats.dead) return;
  if (!roomFor(stats.inv, id, 1)) { notice('Your bag is full'); return; }
  send({ t: 'uneq', slot });
  sfx(300, 0.1, 'triangle', 0.05, -120);
}
function drink(i) {
  const [id] = stats.inv[i], it = ITEMS[id];
  if (local.potionAt > time) { notice('The potion is not ready yet'); return; }
  if (it.hp ? stats.hp >= stats.maxHp : stats.mp >= stats.maxMp) { notice(`Your ${it.hp ? 'health' : 'mana'} is full`); return; }
  local.potionAt = time + 0.5;   // until the server answers: one press must not drink twice
  send({ t: 'use', i, id });
}
// Destroying asks twice: the second right-click on the same stack within a moment does it.
let doomed = { key: '', until: 0 };
function destroyStack(i) {
  const [id, n] = stats.inv[i] || [];
  if (!id || stats.dead) return;
  const key = `${i}:${id}`;
  if (doomed.key === key && time < doomed.until) {
    doomed = { key: '', until: 0 };
    send({ t: 'drop', i, id, n });
    sfx(160, 0.15, 'sawtooth', 0.05, -80);
  } else {
    doomed = { key, until: time + 2.5 };
    notice(`Right-click again to destroy ${stackText(id, n)}`);
  }
}

const HANDS = ['weapon', 'offhand'];   // the two slots beside the paws of the paper doll
function renderBag() {
  const key = [bagTab, stats.cls, stats.level, stats.gold, JSON.stringify(stats.inv), JSON.stringify(stats.eq)].join('|');
  if (key === bagKey) return;
  bagKey = key;
  if (tipAnchor && $('bag').contains(tipAnchor)) hideTip();   // the tile it described is about to be replaced
  for (const b of $('bagTabs').children) b.classList.toggle('on', b.dataset.tab === bagTab);
  $('bagCount').textContent = `${stats.inv.length} / ${BAG_SIZE}`;
  $('bagGold').textContent = stats.gold;
  // The equipment slots stand around the cat: armour down its left, the weapon and the off hand by its paws. An empty
  // one shows the outline of what belongs in it - for the weapon, the kind the cat fights with meanwhile. While the
  // weapon takes both paws the off hand is not empty but taken: it shows that weapon, dimmed.
  const both = ITEMS[stats.eq.weapon]?.hands === 2 ? stats.eq.weapon : null;
  const worn = (slot) => {
    const id = ITEMS[stats.eq[slot]] ? stats.eq[slot] : null, taken = slot === 'offhand' && !id && both;
    const t = tile(id, 1, taken ? ITEMS[both].family : slot === 'weapon' ? basicFamily(stats.cls, !!stats.eq.offhand) : slot);
    t.dataset.slot = slot;
    if (taken) {
      t.classList.add('taken');
      t.style.setProperty('--tint', itemTint(both));
      tipOn(t, () => [el('b', 'name', SLOT_NAMES[slot]), el('div', 'kind bad', `Taken by ${ITEMS[both].name}`),
        el('div', 'dim', 'A two-handed weapon needs both paws. Wearing a shield puts it back into the bag')]);
      return t;
    }
    if (!id) {
      tipOn(t, () => [el('b', 'name', SLOT_NAMES[slot]), el('div', 'kind', 'Empty slot'),
        el('div', 'dim', slot === 'offhand' ? 'A shield goes here, beside a one-handed weapon' : 'Click a piece in the bag to wear it')]);
      return t;
    }
    t.addEventListener('click', () => takeOff(slot));
    dragFrom(t, () => ({ id }));
    tipOn(t, () => itemTip(id, 'Click to take it off · drag onto the action bar', true));
    return t;
  };
  $('dollLeft').replaceChildren(...EQUIP_SLOTS.filter((slot) => !HANDS.includes(slot)).map(worn));
  $('dollRight').replaceChildren(...HANDS.map(worn));
  // The grid shows the stacks the tab lets through, then empty cells; a stack keeps its place in the bag (i), which
  // is what the server is told.
  const shown = stats.inv.map(([id, n], i) => ({ id, n, i }))
    .filter(({ id }) => ITEMS[id] && (bagTab === 'all' || (bagTab === 'potion') === (ITEMS[id].kind === 'potion')));
  bagCds = [];
  $('bagGrid').replaceChildren(...Array.from({ length: BAG_SIZE }, (_, cell) => {
    if (!shown[cell]) return tile(null);
    const { id, n, i } = shown[cell], it = ITEMS[id], t = tile(id, n);
    t.dataset.item = id;
    if (it.kind === 'potion') {
      const cd = el('i', 'cd');
      t.append(cd);
      bagCds.push(cd);
    } else if (equipError(stats.cls, stats.level, id)) t.classList.add('bad');
    t.addEventListener('click', () => useStack(i));
    t.addEventListener('contextmenu', () => destroyStack(i));
    dragFrom(t, () => ({ id }));
    tipOn(t, () => itemTip(id, [`Click to ${it.kind === 'potion' ? 'drink' : 'wear'} it · drag onto the action bar`, 'Right-click twice to destroy']));
    return t;
  }));
}

// One number of the character: its label and its value. `raised`: a buff holds it up; `gear`: the part of the value
// that comes from the equipment, shown beside it.
function statCell(label, value, raised = false, gear = 0) {
  const c = el('div', 'cell'), b = el('b', raised ? 'up' : '', String(value));
  if (gear) b.prepend(el('small', 'eq', `${gear > 0 ? '+' : ''}${gear}`));
  c.append(el('span', '', label), b);
  return c;
}
function statGrid(cells, cls = 'grid') {
  const box = el('div', cls);
  box.append(...cells);
  return box;
}

// The PvP record in one line: fights won, murders, and the karma that is still to be worked off.
function reputation() {
  const line = el('div', 'rep', `PvP ${stats.pvp} · PK ${stats.pk}`);
  if (stats.karma) line.append(el('b', '', ` · Karma ${stats.karma}`));
  return line;
}

// The first part of the inventory: the numbers of the status window, a value a row. While the cursor is on a piece
// of gear in the bag that the character could wear, the combat rows show what wearing it would make of them.
function renderBagStats() {
  const hover = tipAnchor && $('bagGrid').contains(tipAnchor) ? tipAnchor.dataset.item : null;
  const tried = hover && ITEMS[hover].slot && !equipError(stats.cls, stats.level, hover) ? hover : null;
  const who = names.get(myId) || 'Cat';
  const key = [who, stats.cls, stats.level, stats.hp, stats.maxHp, stats.mp, stats.maxMp, stats.weapon, tried, stats.pvp, stats.pk, stats.karma,
    JSON.stringify(stats.skills), JSON.stringify(stats.buffs), JSON.stringify(stats.eq)].join('|');
  if (key === statsKey) return;
  statsKey = key;
  const base = statsOf(stats.cls, stats.level, stats.skills, stats.weapon, {}, stats.eq), bare = bareSheet();
  const after = tried ? statsOf(stats.cls, stats.level, stats.skills, stats.weapon, buffsNow(), equipWith(stats.eq, tried)) : sheet;   // with what it pushes off
  const combat = SHEET_ROWS.flat().filter(Boolean).map(([label, k]) => {
    if (after[k] === sheet[k]) return statCell(label, sheet[k], sheet[k] > base[k], sheet[k] - bare[k]);
    const c = statCell(label, after[k]), b = c.lastChild;   // "83 → 95", green for more and red for less
    b.className = after[k] > sheet[k] ? 'good' : 'bad';
    b.prepend(el('small', '', `${sheet[k]} →`));
    return c;
  });
  $('bagStats').replaceChildren(
    el('div', 'who', who), el('div', 'sub', `${CLASSES[stats.cls].name} · level ${stats.level}`),
    reputation(),
    statGrid([statCell('HP', `${stats.hp} / ${stats.maxHp}`), statCell('MP', `${stats.mp} / ${stats.maxMp}`)]),
    el('h3', '', 'Attributes'), statGrid(ATTR_NAMES.map((n) => statCell(n, sheet[n])), 'grid two'),
    el('h3', tried ? 'try' : '', tried ? `With ${ITEMS[tried].name}` : 'Combat'), statGrid(combat),
  );
}

// ---- the paper doll: the player's own cat as the world shows it, alive in a small canvas between its equipment
// slots. It has a little renderer of its own, made the first time the inventory opens and kept from then on, and it
// is drawn only while the window is open. Dragging turns the cat.
let doll = null;
function makeDoll() {
  const canvas = $('dollView');
  const d = {
    cat: createCat(CLASSES[stats.cls]), cls: '', look: 0, yaw: 0.5, frames: 0, w: 0, h: 0, view: null,
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(30, 1, 0.5, 30),
  };
  const sun = new THREE.DirectionalLight(0xfff4dc, 2.4);
  sun.position.set(2.5, 5, 6);
  d.scene.add(d.cat.group, new THREE.HemisphereLight(0xdff5ff, 0x4c6a55, 1.5), sun);
  d.camera.position.set(0, 1.9, 8);
  d.camera.lookAt(0, 1.25, 0);
  try {
    d.view = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    d.view.setPixelRatio(Math.min(devicePixelRatio, 2));
    d.view.toneMapping = THREE.ACESFilmicToneMapping;
  } catch (err) {   // no second WebGL context to be had: the slots work without the picture
    console.warn('The paper doll cannot be drawn', err);
  }
  let grab = null;   // where the pointer was when it last turned the cat
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    grab = e.clientX;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* the drag then ends at the edge of the picture */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (grab === null) return;
    d.yaw += (e.clientX - grab) * 0.012;
    grab = e.clientX;
  });
  for (const ev of ['pointerup', 'pointercancel']) canvas.addEventListener(ev, () => { grab = null; });
  return d;
}
function drawDoll(dt) {
  doll ??= makeDoll();
  setLook(doll, stats.cls, lookCode(stats.eq));   // the same look the world gives the cat
  doll.cat.group.rotation.y = doll.yaw;
  doll.cat.update(dt, {});                        // standing idle: it breathes, blinks and swings its tail
  if (!doll.view) return;
  const canvas = doll.view.domElement, w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (w !== doll.w || h !== doll.h) {   // the picture is as tall as the window's longest part makes it
    Object.assign(doll, { w, h });
    doll.view.setSize(w, h, false);
    doll.camera.aspect = w / h;
    doll.camera.updateProjectionMatrix();
  }
  doll.view.render(doll.scene, doll.camera);
  doll.frames++;
}

// ---- the Trader's shop

let storeOpen = false, storeTab = 'buy', storeKey = null;
const hasTrader = npcsOf(map, 'trader').length > 0;
function toggleStore(open = !storeOpen) {
  if (open) { toggleBook(false); toggleHelp(false); toggleSheet(false); toggleMap(false); toggleSettings(false); }
  storeOpen = open;
  storeKey = null;
  $('store').classList.toggle('on', open);
  // what is in the bag is half of every deal: it opens beside the list where there is room for both (the Sell tab
  // lists the bag anyway)
  if (open) toggleBag(PAIRS.matches);
  else hideTip();
}
function tradeKey() {
  if (storeOpen) toggleStore(false);
  else if (nearNpc(map, me, 'trader')) toggleStore(true);
  else notice(hasTrader ? 'The Trader is too far away' : 'There is no Trader in this world');
}
for (const b of $('storeTabs').children) {
  b.addEventListener('click', () => { storeTab = b.dataset.tab; storeKey = null; b.blur(); });
}

function renderStore() {
  const key = [storeTab, stats.cls, stats.level, stats.gold, JSON.stringify(stats.inv), JSON.stringify(stats.eq)].join('|');
  if (key === storeKey) return;
  storeKey = key;
  if (tipAnchor && $('store').contains(tipAnchor)) hideTip();
  for (const b of $('storeTabs').children) b.classList.toggle('on', b.dataset.tab === storeTab);
  $('storeSub').textContent = storeTab === 'buy' ? `Gold: ${stats.gold} · potions, and gear up to the ${TIERS[SHOP_TIER].name} tier`
    : `Gold: ${stats.gold} · the Trader pays ${Math.round(SELL_RATE * 100)}% of an item's price. Take a worn item off to sell it`;
  const button = (label, enabled, onClick) => {
    const b = el('button', '', label);
    b.disabled = !enabled;
    b.addEventListener('click', () => { onClick(); b.blur(); });
    return b;
  };
  // one row of the list: the item, a line about it, and what can be done with it
  const row = (id, n, text, locked, buttons, hint) => {
    const r = el('div', `sk${locked ? ' locked' : ''}`), info = el('div', 'info');
    r.dataset.item = id;
    info.append(el('div', 'name', stackText(id, n)), el('div', 'text', text));
    r.append(tile(id), info, ...buttons);
    tipOn(r, () => itemTip(id, hint));
    return r;
  };
  const facts = (it) => (it.kind === 'potion' ? `Restores ${it.hp || it.mp} ${it.hp ? 'health' : 'mana'}`
    : `${Object.entries(it.bonus).map(([k, v]) => `+${v} ${BONUS_NAMES[k]}`).join(' · ')} · ${it.hands === 2 ? 'two-handed · ' : ''}level ${it.lvl}`);
  const list = $('storeList');
  if (storeTab === 'buy') {
    // what the character cannot wear comes last, dimmed, with the reason
    const goods = SHOP.map((id) => ({ id, it: ITEMS[id], err: ITEMS[id].slot ? equipError(stats.cls, stats.level, id) : '' }));
    goods.sort((a, b) => !!a.err - !!b.err);
    list.replaceChildren(...goods.map(({ id, it, err }) => {
      const can = (n) => !err && stats.gold >= it.price * n && roomFor(stats.inv, id, n) >= n;
      const buttons = [button(`Buy · ${it.price} g`, can(1), () => send({ t: 'buy', id, n: 1 }))];
      if (stackMax(id) > 1) buttons.push(button(`×10 · ${it.price * 10} g`, can(10), () => send({ t: 'buy', id, n: 10 })));
      return row(id, 1, err || facts(it), !!err, buttons, '');
    }));
  } else if (!stats.inv.length) {
    list.replaceChildren(el('div', 'sub', 'Your bag is empty.'));
  } else {
    list.replaceChildren(...stats.inv.map(([id, n], i) => {
      const price = sellPrice(id), buttons = [button(`Sell · ${price} g`, true, () => send({ t: 'sell', i, id, n: 1 }))];
      if (n > 1) buttons.push(button(`All · ${price * n} g`, true, () => send({ t: 'sell', i, id, n })));
      return row(id, n, facts(ITEMS[id]), false, buttons, '');
    }));
  }
}

// ---------------------------------------------------------------- character status window

let sheetOpen = false, sheetKey = null;
function toggleSheet(open = !sheetOpen) {
  if (open) { toggleBook(false); toggleHelp(false); toggleStore(false); toggleMap(false); toggleSettings(false); }
  if (open && !PAIRS.matches) toggleBag(false);
  sheetOpen = open;
  sheetKey = null;
  $('sheet').classList.toggle('on', open);
}

// ---- the window buttons: a row under the radar and the place, each with its name under its sign, and a column of
// plain ones (`side`) under that. A click does what the key does, and a button is lit while its window is open. The Trader's button is
// there only while he is in reach, like his key.
const MENU = [
  { name: 'Shop', key: 'T', toggle: () => tradeKey(), isOpen: () => storeOpen, near: 'trader',
    icon: '<path d="M8 7v-1a4 4 0 018 0v1h3.200l1.300 13.500h-17l1.300-13.500zm2 0h4v-1a2 2 0 00-4 0zm-1.500 3.500a1.200 1.200 0 100 2.400 1.200 1.200 0 000-2.400zm7 0a1.200 1.200 0 100 2.400 1.200 1.200 0 000-2.400z" fill-rule="evenodd"/>' },
  { name: 'Character', key: 'C', toggle: () => toggleSheet(), isOpen: () => sheetOpen,
    icon: '<circle cx="12" cy="7.500" r="4.500"/><path d="M3.500 21.500a8.500 8.500 0 0117 0z"/>' },
  { name: 'Inventory', key: 'I', toggle: () => toggleBag(), isOpen: () => bagOpen,
    icon: '<path d="M9 2h6a2 2 0 012 2v2h-2v-2h-6v2h-2v-2a2 2 0 012-2z"/><path d="M5 7h14a2 2 0 012 2v10.500a2 2 0 01-2 2h-14a2 2 0 01-2-2v-10.500a2 2 0 012-2zM9.500 11v3.500h5v-3.500z" fill-rule="evenodd"/>' },
  { name: 'Skills', key: 'K', toggle: () => toggleBook(), isOpen: () => bookOpen,
    icon: '<path d="M2.500 4.500c3-1.200 6-1.200 8.500.500v15c-2.500-1.700-5.500-1.700-8.500-.500zM21.500 4.500c-3-1.200-6-1.200-8.500.500v15c2.500-1.700 5.500-1.700 8.500-.500z"/>' },
  { name: 'Map', key: 'M', toggle: () => toggleMap(), isOpen: () => mapOpen,
    icon: '<path d="M2.500 6l6-2.500v14.500l-6 2.500zM9.500 3.500l5 2.500v14.500l-5-2.500zM15.500 6l6-2.500v14.500l-6 2.500z"/>' },
  { name: 'Settings', key: 'O', side: true, toggle: () => toggleSettings(), isOpen: () => settingsOpen,
    icon: '<path d="M10.300 2h3.400l.500 2.600 1.700.700 2.200-1.500 2.400 2.400-1.500 2.200.700 1.700 2.600.500v3.400l-2.600.500-.700 1.700 1.500 2.200-2.400 2.400-2.200-1.500-1.700.700-.500 2.600h-3.400l-.500-2.600-1.700-.700-2.200 1.500-2.400-2.400 1.500-2.200-.700-1.700-2.600-.500v-3.400l2.600-.500.700-1.700-1.500-2.200 2.400-2.400 2.200 1.500 1.700-.700zM12 8.500a3.500 3.500 0 100 7 3.500 3.500 0 000-7z" fill-rule="evenodd"/>' },
  { name: 'Help', key: 'H', side: true, toggle: () => toggleHelp(), isOpen: () => helpOpen,
    icon: '<path d="M12 2.500a9.500 9.500 0 100 19 9.500 9.500 0 000-19zM12 6c2.300 0 4 1.500 4 3.500 0 1.500-.800 2.300-1.900 3-.900.600-1.100.900-1.100 1.800h-2.200c0-1.700.500-2.500 1.700-3.300.900-.600 1.200-.900 1.200-1.500 0-.800-.700-1.400-1.700-1.400s-1.700.600-1.800 1.600h-2.200c.100-2.200 1.700-3.700 4-3.700zM10.700 15.500h2.600v2.500h-2.600z" fill-rule="evenodd"/>' },
];
// How many skills the character could buy the next rank of right now, were it standing before the Sage: the Skills
// button wears that number, since the skill points themselves are shown only in the skill book.
const affordable = () => skillsFor(stats.cls).filter((id) => {
  const k = SKILLS[id], rank = stats.skills[id] | 0;
  return stats.level >= k.lvl && rank < k.sp.length && stats.sp >= k.sp[rank];
}).length;
for (const m of MENU) {
  m.node = el('div', 'mbtn');
  m.badge = el('span', 'badge');
  m.node.append(glyph(m.icon), ...(m.side ? [] : [el('span', '', m.name)]), m.badge);
  m.node.addEventListener('click', () => { if (state === 'playing') m.toggle(); });
  tipOn(m.node, () => [el('b', 'name', m.name), ...(m.badge.textContent ? [el('div', '', m.note)] : []), el('div', 'hint', m.key === 'H' ? 'Key H or F1' : `Key ${m.key}`)]);
  $(m.side ? 'sidebar' : 'menubar').append(m.node);
}
let badgeKey = null;

const BUFF_NAMES = { patk: 'Attack up', pdef: 'Defence up', atk: 'Might' };
const SHEET_ROWS = [
  [['P. Atk', 'pAtk'], ['M. Atk', 'mAtk']],
  [['P. Def', 'pDef'], ['M. Def', 'mDef']],
  [['Accuracy', 'acc'], ['Evasion', 'eva']],
  [['Critical', 'crit'], ['M. Critical', 'mCrit']],
  [['Atk. Spd', 'atkSpd'], ['Casting Spd', 'castSpd']],
  [['Speed', 'speed'], null],
];

function renderSheet() {
  const key = [stats.cls, stats.level, stats.xp, stats.sp, stats.hp, stats.mp, stats.gold, stats.weapon, JSON.stringify(stats.buffs), JSON.stringify(stats.eq), stats.pvp, stats.pk, stats.karma, stats.st].join('|');
  if (key === sheetKey) return;
  sheetKey = key;
  const base = statsOf(stats.cls, stats.level, stats.skills, stats.weapon, {}, stats.eq);   // without buffs, to highlight what they raise
  const bare = bareSheet();                                                                // without equipment, to show what it adds
  const cell = statCell, section = (title, cells) => [el('h3', '', title), statGrid(cells)];
  const need = xpNext(stats.level);
  $('sheetTitle').textContent = names.get(myId) || 'Cat';
  $('sheetSub').textContent = `${CLASSES[stats.cls].name} · level ${stats.level}`;
  $('sheetBody').replaceChildren(
    ...section('Status', [
      cell('HP', `${stats.hp} / ${stats.maxHp}`), cell('MP', `${stats.mp} / ${stats.maxMp}`),
      cell('Experience', `${(stats.xp / need * 100).toFixed(2)}%`), cell('SP', stats.sp),
      cell('Gold', stats.gold), cell('Weapon upgrade', `Lv ${stats.weapon}`),   // the Blacksmith's work (B)
    ]),
    ...section('PvP', [cell('PvP wins', stats.pvp), cell('PK', stats.pk), cell('Karma', stats.karma), cell('Standing', PVP_TITLES[stats.st])]),
    ...section('Attributes', ATTR_NAMES.map((n) => cell(n, sheet[n]))),
    ...section('Combat', SHEET_ROWS.flat().map((r) => (r ? cell(r[0], sheet[r[1]], sheet[r[1]] > base[r[1]], sheet[r[1]] - bare[r[1]]) : el('div')))),
  );
}

// The two bars that fill while the cat casts or draws its bow: every frame, or they would stutter. The rest of the
// HUD (updateHud) is brought up to date twenty times a second, which the eye does not tell from sixty.
function updateBars() {
  $('draw').style.display = me.drawT >= 0 ? 'block' : 'none';
  $('drawFill').style.width = `${Math.max(0, me.drawT) / me.drawDur * 100}%`;
  $('cast').style.display = me.castT >= 0 ? 'block' : 'none';
  $('castFill').style.width = `${Math.max(0, me.castT) / me.castDur * 100}%`;
}

let xpSeen = null;   // the level and the experience the bar showed last, to tell when more has come in
// What a monster leaves, as chips in its frame: the coins, the gear by tier, the potions - each with how often
// (lootTable in src/shared.js has the odds the server plays by). Built when the target or its level changes.
const percent = (chance) => { const p = chance * 100; return `${p >= 10 ? Math.round(p) : Number(p.toFixed(1))}%`; };
// the same in the little room of a chip: whole percents, where there is at least one (the tooltip has the exact number)
const roughly = (chance) => (chance >= 0.01 ? `${Math.round(chance * 100)}%` : percent(chance));
// "Iron gear" - or, where the armour and the weapons of a tier are named differently, "Leather armour or Bronze weapon"
function gearName(t) {
  const tier = TIERS[t], arms = tier.arms[0].toUpperCase() + tier.arms.slice(1);
  return arms === tier.name ? `${tier.name} gear` : `${tier.name} armour or ${arms} weapon`;
}
let dropsKey = '';
function renderDrops(tv) {
  const key = tv && !tv.cat ? `${tv.type}|${tv.lvl}` : '';
  if (key === dropsKey) return;
  dropsKey = key;
  if (tipAnchor && $('tgDrops').contains(tipAnchor)) hideTip();   // the chip it described is about to go
  if (!key) { $('tgDrops').replaceChildren(); return; }
  const { gold, items } = lootTable(tv.type, tv.lvl), boss = tv.type === 'boss';
  const whose = boss ? 'To every cat that wounded him' : 'To whoever strikes the last blow';
  const chip = (icon, text, tip) => {
    const node = el('span', 'loot');
    node.append(icon, text);
    tipOn(node, tip);
    return node;
  };
  $('tgDrops').replaceChildren(
    chip(el('i', 'coin'), `${gold[0]}–${gold[1]}`, () => [el('b', 'name', 'Gold'), el('div', 'kind', 'Every kill'),
      el('div', '', `Coins worth ${gold[0]} to ${gold[1]} gold in all, left on the ground for whoever picks them up`)]),
    ...items.map((it) => {
      const often = `${percent(it.chance)} of kills`;
      if (it.id) {
        return chip(picture(itemIcon(it.id)), roughly(it.chance), () => [el('b', 'name', stackText(it.id, it.n)), el('div', 'kind', often), el('div', 'dim', whose)]);
      }
      const tier = TIERS[it.gear];
      const node = chip(picture(itemIcon(`${tier.id}_body`)), roughly(it.chance), () => [el('b', 'name', gearName(it.gear)), el('div', 'kind', often),
        el('div', '', 'One piece: a helmet, a body armour, gloves, boots, a shield or a weapon'), el('div', 'dim', whose)]);
      node.classList.add('gear');
      node.style.setProperty('--tint', css(tier.color));
      return node;
    }));
}

function updateHud() {
  const say = (node, text) => { if (node.textContent !== text) node.textContent = text; };
  say($('who'), names.get(myId) || 'Cat');
  $('who').style.color = stats.st ? PVP_COLORS[stats.st] : '';   // the colour the others see over this cat
  say($('whoLevel'), `Lv. ${stats.level}`);
  say($('whoClass'), CLASSES[stats.cls].name);
  say($('levelBadge'), String(stats.level));
  $('hpFill').style.width = `${stats.hp / stats.maxHp * 100}%`;
  say($('hpText'), `${stats.hp} / ${stats.maxHp}`);
  $('mpFill').style.width = `${stats.mp / stats.maxMp * 100}%`;
  say($('mpText'), `${stats.mp} / ${stats.maxMp}`);
  say($('placeName'), regionAt(map, me.x, me.z).name);
  say($('placeAt'), `${me.x.toFixed(1)}, ${me.z.toFixed(1)}`);
  $('padAttack').classList.toggle('on', attacking);
  $('padDash').style.display = stats.skills.shadow_step > 0 ? '' : 'none';
  if (!xpSeen || xpSeen.level !== stats.level || xpSeen.xp !== stats.xp) {
    xpFill.style.width = `${xpShare()}%`;
    xpText.textContent = `EXP ${stats.xp.toLocaleString('en-US')} / ${xpNext(stats.level).toLocaleString('en-US')} (${Math.floor(xpShare())}%)`;
    if (xpSeen && (stats.level > xpSeen.level || (stats.level === xpSeen.level && stats.xp > xpSeen.xp))) {
      xpBar.classList.remove('gain');
      void xpBar.offsetWidth;   // lets the animation start over when the next kill follows at once
      xpBar.classList.add('gain');
    }
    xpSeen = { level: stats.level, xp: stats.xp };
    if (tipAnchor === xpBar) $('tip').lastChild.textContent = xpLine();   // the tooltip is open: it counts along
  }
  if (helpOpen) $('online').textContent = `${online} ${online === 1 ? 'cat' : 'cats'} in the world right now`;
  $('buffs').replaceChildren(
    ...['Stunned', 'Asleep', 'Slowed'].filter((_, i) => stats.cc & (1 << i)).map((text) => el('span', 'bad', text)),
    ...stats.buffs.map(([stat, left]) => el('span', '', `${BUFF_NAMES[stat] || stat} ${left}s`)));
  if (sheetOpen) renderSheet();

  renderBar();
  const learned = activeSkills(stats.cls, stats.skills);
  const potionWait = local.potionAt - time, potionCd = `${Math.max(0, Math.min(1, potionWait / POTION_CD)) * 100}%`;
  for (const { id, k, it, node, note, cd, left } of barSlots) {
    if (k) {
      const wait = (local.cds[id] || 0) - time, known = learned.includes(id);
      cd.style.height = `${Math.max(0, Math.min(1, wait / Math.max(k.cd, 0.3))) * 100}%`;
      say(left, wait > 0.5 ? String(Math.ceil(wait)) : '');
      node.classList.toggle('active', me.castT >= 0 && me.castSkill === id);
      node.classList.toggle('dim', known && stats.mp < k.mp);
      node.classList.toggle('off', !known);
    } else if (id === BAR_ATTACK) {
      node.classList.toggle('active', attacking);
    } else if (it) {
      // a potion: how many the bag holds, and the cooldown all potions share; gear: a mark while it is worn
      const n = bagCount(id), worn = !!it.slot && stats.eq[it.slot] === id, potion = it.kind === 'potion';
      say(note, potion ? String(n) : worn ? '✓' : '');
      cd.style.height = potion ? potionCd : '0';
      say(left, potion && potionWait > 0.5 ? String(Math.ceil(potionWait)) : '');
      node.classList.toggle('dim', !n && !worn);   // none left: the slot keeps its item and waits for more
    }
  }
  for (const cd of bagCds) cd.style.height = potionCd;
  for (const m of MENU) {
    m.node.classList.toggle('on', m.isOpen());
    if (m.near) m.node.style.display = m.isOpen() || nearNpc(map, me, m.near) ? '' : 'none';
  }
  const spent = [stats.cls, stats.level, stats.sp, JSON.stringify(stats.skills)].join('|');
  if (spent !== badgeKey) {
    badgeKey = spent;
    const skills = MENU.find((m) => m.key === 'K'), n = affordable();
    skills.badge.textContent = n ? String(n) : '';
    skills.note = `${stats.sp} skill points: the Sage has ${n} ${n === 1 ? 'skill' : 'skills'} you can afford`;
  }

  // The target's frame: the level on a badge, the name - both tinted by how dangerous a monster is for this player, or
  // by how a cat stands - what it is doing, and its health. How much health another has is shown by the bar alone,
  // never in numbers. A monster's frame also tells what it leaves (renderDrops).
  const tv = mobViews.get(targetId) || others.get(targetId);
  $('target').style.display = tv ? 'block' : 'none';
  $('tgAttack').style.display = tv?.cat && !attacking ? 'inline-block' : 'none';
  renderDrops(tv);
  if (tv) {
    const tint = tv.cat ? PVP_COLORS[tv.st] : threat(tv.lvl), ailing = tv.flags & 1 ? 'Stunned' : tv.flags & 2 ? 'Asleep' : tv.flags & 4 ? 'Slowed' : attacking ? 'Attacking' : '';
    say($('tgLevel'), String(tv.cat ? tv.level : tv.lvl));
    $('tgLevel').style.setProperty('--tint', tint);
    say($('tgName'), tv.cat ? `${tv.name} · ${CLASSES[tv.cls].name}` : tv.def.name);
    $('tgName').style.color = tint;
    $('tgFill').style.width = `${Math.max(0, tv.hp / tv.maxHp) * 100}%`;
    say($('tgState'), ailing || (tv.cat ? PVP_TITLES[tv.st] : tv.def.calm ? 'Calm' : 'Hostile'));
  }

  const atSage = nearNpc(map, me, 'sage'), atTrader = nearNpc(map, me, 'trader');
  if (bookOpen) renderBook(atSage);
  if (storeOpen && !atTrader) toggleStore(false);   // walking away ends the deal
  if (storeOpen) renderStore();
  if (bagOpen) { renderBag(); renderBagStats(); }
  const cost = upgradeCost(stats.weapon);
  // the Blacksmith and the Trader may stand close enough together for both to be in reach
  const tips = [];
  if (atSage) tips.push('K — learn skills from the Sage');
  else if (nearNpc(map, me, 'blacksmith')) {   // the Blacksmith has no window: his line says all there is to his trade
    tips.push(`${stats.gold >= cost ? 'B — upgrade weapon' : 'Weapon upgrade'} Lv ${stats.weapon} → ${stats.weapon + 1}: ${cost} gold (you have ${stats.gold})`);
  }
  if (atTrader && !storeOpen) tips.push('T — trade with the Trader');
  const tip = bookOpen || helpOpen || storeOpen || mapOpen ? '' : tips.join(' · ');   // those four reach down to where the line stands
  $('shop').style.display = tip ? 'block' : 'none';
  $('shop').textContent = tip;

  if ($('devbar').classList.contains('on')) $('devPos').textContent = `${me.x.toFixed(1)}, ${me.z.toFixed(1)} · ${regionAt(map, me.x, me.z).name}`;
}

// Radar: the surroundings of the player; far landmarks stick to the rim. The gold ring around it is a picture that
// lies over the canvas (index.html), so the canvas is drawn to its very edge. North is up, like the world map.
const mapCtx = $('minimap').getContext('2d');
const RADAR_RANGES = [45, 75, 120];   // how far the radar sees, in world units: its "+" and "−" step through these
let radarZoom = 1;
const SHORE = '#d9cb9a';   // the edge of the island: the sand of its beach
function zoomRadar(step) {
  radarZoom = Math.max(0, Math.min(RADAR_RANGES.length - 1, radarZoom + step));
  $('zoomIn').disabled = radarZoom === 0;
  $('zoomOut').disabled = radarZoom === RADAR_RANGES.length - 1;
  drawMinimap();
}
$('zoomIn').addEventListener('click', () => { zoomRadar(-1); $('zoomIn').blur(); });
$('zoomOut').addEventListener('click', () => { zoomRadar(1); $('zoomOut').blur(); });
function drawMinimap() {
  const g = mapCtx, SIZE = 420, C = SIZE / 2, RIM = C - 12, S = RIM / RADAR_RANGES[radarZoom];
  g.clearRect(0, 0, SIZE, SIZE);
  g.save();
  g.beginPath(); g.arc(C, C, C, 0, 7); g.clip();
  const ground = g.createRadialGradient(C, C, 0, C, C, C);
  ground.addColorStop(0, 'rgba(14, 44, 34, .94)');
  ground.addColorStop(1, 'rgba(5, 22, 17, .94)');
  g.fillStyle = ground;
  g.fillRect(0, 0, SIZE, SIZE);

  const ox = C - me.x * S, oz = C - me.z * S;   // world origin on the canvas
  // the outline of a region: a circle, or a polygon that closes itself
  const trace = (shape) => {
    g.beginPath();
    if (shape.type === 'circle') g.arc(ox + shape.x * S, oz + shape.z * S, shape.r * S, 0, 7);
    else {
      for (const [x, z] of shape.points) g.lineTo(ox + x * S, oz + z * S);
      g.closePath();
    }
  };
  g.fillStyle = 'rgba(96, 214, 232, .32)';   // safe ground
  for (const region of map.regions) if (region.safe) { trace(region.shape); g.fill('evenodd'); }
  g.lineWidth = 4;
  g.globalAlpha = 0.55;
  for (const region of map.regions) {
    g.strokeStyle = regionColor(map, region);
    trace(region.shape);
    g.stroke();
  }
  g.strokeStyle = SHORE;
  g.beginPath(); g.arc(ox, oz, map.radius * S, 0, 7); g.stroke();
  g.globalAlpha = 1;

  // where a world point is on the canvas; null beyond the rim, unless it is pinned to it
  const place = (x, z, pin) => {
    let px = (x - me.x) * S, pz = (z - me.z) * S;
    const d = Math.hypot(px, pz);
    if (d > RIM - 8) {
      if (!pin) return null;
      px *= (RIM - 8) / d; pz *= (RIM - 8) / d;
    }
    return [C + px, C + pz];
  };
  const dot = (x, z, r, color, pin) => {
    const at = place(x, z, pin);
    if (!at) return;
    g.fillStyle = color;
    g.beginPath(); g.arc(at[0], at[1], r, 0, 7); g.fill();
  };
  // a landmark: its picture, `h` canvas pixels high
  const mark = (name, x, z, h, pin) => {
    const at = place(x, z, pin), img = hudPicture[name];
    if (!at || !img) return;
    const w = h * img.width / img.height;
    g.drawImage(img, at[0] - w / 2, at[1] - h / 2, w, h);
  };
  for (const v of mobViews.values()) dot(v.x, v.z, v.def.r * 4 + 5, css(v.def.color));
  for (const gem of gemViews.values()) dot(gem.mesh.position.x, gem.mesh.position.z, 4.5, '#ffd76a');
  chestViews.forEach((v, i) => {
    const c = map.chests[i];
    if (c && !v.open) mark('chest', c.x, c.z, c.big ? 36 : 28);
  });
  for (const spawn of map.spawns) if (hasBoss(spawn)) mark('skull', spawn.x, spawn.z, 42, true);
  mark('house', map.start.x, map.start.z, 42, true);          // town
  g.lineWidth = 2;
  g.strokeStyle = 'rgba(4, 16, 14, .85)';
  for (const a of others.values()) {
    const at = place(a.x, a.z);
    if (!at) continue;
    g.fillStyle = a.st ? PVP_COLORS[a.st] : '#ffffff';
    g.beginPath(); g.arc(at[0], at[1], 8.5, 0, 7); g.fill(); g.stroke();
  }
  // the player: an arrow that points where the cat looks
  g.translate(C, C);
  g.rotate(Math.atan2(Math.sin(me.yaw), -Math.cos(me.yaw)));   // 0 = north, clockwise
  g.beginPath(); g.moveTo(0, -27); g.lineTo(20, 21); g.lineTo(0, 12); g.lineTo(-20, 21); g.closePath();
  g.fillStyle = '#ffffff'; g.fill();
  g.lineJoin = 'round';
  g.lineWidth = 3; g.strokeStyle = '#0a1412'; g.stroke();
  g.restore();
}

// ---- the pad in the corner: what the keys do, for the mouse
$('padAttack').addEventListener('click', () => { if (state === 'playing') attackKey(); $('padAttack').blur(); });
$('padJump').addEventListener('click', () => { if (state === 'playing') jump(); $('padJump').blur(); });
$('padTarget').addEventListener('click', () => { if (state === 'playing') nextTarget(); $('padTarget').blur(); });
// a dash is a skill cast by a held key: the click holds Shift for one frame, as a click on a slot holds its key
$('padDash').addEventListener('click', () => { if (state === 'playing') for (const set of [keys, fresh, taps]) set.add('ShiftLeft'); $('padDash').blur(); });

const CAM_CLEAR = 0.6;   // the camera stays at least this high above the ground under it
function updateCamera(dt) {
  const ground = groundY(me.x, me.z);   // the orbit follows the ground the cat stands on, not its jumps
  if (state === 'playing') {
    const flat = Math.cos(cam.pitch) * cam.dist;
    lookGoal.set(me.x, ground + 1.2, me.z);
    camGoal.set(me.x + Math.sin(cam.yaw) * flat, ground + 1.2 + Math.sin(cam.pitch) * cam.dist, me.z + Math.cos(cam.yaw) * flat);
  } else {
    camGoal.set(me.x, ground + 1.2, me.z + 6.4);
    lookGoal.set(me.x, ground + 0.45, me.z);
  }
  const k = 1 - Math.exp(-(state === 'playing' ? 12 : 5) * dt);
  camera.position.lerp(camGoal, k);
  camTarget.lerp(lookGoal, k);
  shake = Math.max(0, shake - dt * 2.5);
  camera.position.x += (Math.random() - 0.5) * shake * 0.5;
  camera.position.y += (Math.random() - 0.5) * shake * 0.5;
  // a hill behind the cat lifts the camera over itself instead of swallowing it
  camera.position.y = Math.max(camera.position.y, groundY(camera.position.x, camera.position.z) + CAM_CLEAR);
  camera.lookAt(camTarget);
}

const clock = new THREE.Clock();

// ---------------------------------------------------------------- the frame rate, and Auto
// Called with the real length of every frame: counts the frames of each half second and shows the rate where it is
// asked for. With Auto on in the settings it also judges: when the game cannot hold 40 frames a second for three
// seconds, the graphics go down a step (AUTO_STEPS in settings.js; a step that changes nothing for this player is
// passed over); when it has run at the screen's own rate for twenty, a step comes back - but never the one that
// proved too much. A tab nobody looks at gets no frames to speak of: it is not judged.
function measure(dt) {
  auto.frames++; auto.span += dt;
  if (auto.span < 0.5) return;
  auto.fps = auto.frames / auto.span;
  const span = auto.span;
  auto.frames = 0; auto.span = 0;
  if (settings.fps) $('fps').textContent = `${Math.round(auto.fps)} FPS`;
  if (settingsOpen) showAuto();
  if (!settings.auto || state !== 'playing' || document.visibilityState !== 'visible') { auto.slow = auto.fast = 0; return; }
  if ((auto.wait -= span) > 0) return;   // just joined, or just changed: the shaders are still settling
  auto.slow = auto.fps < 40 ? auto.slow + span : 0;
  auto.fast = auto.fps > 57 ? auto.fast + span : 0;
  const same = (a, b) => JSON.stringify(lowered(settings, a)) === JSON.stringify(lowered(settings, b));
  let to = auto.step;
  if (auto.slow >= 3) {
    do to++; while (to < AUTO_STEPS.length && same(to, auto.step));
    if (to > AUTO_STEPS.length || same(to, auto.step)) return;   // nothing left to take away
    auto.floor = to;   // where it was is too much for this machine
  } else if (auto.fast >= 20 && auto.step > auto.floor) {
    do to--; while (to > auto.floor && same(to, auto.step));
  } else return;
  Object.assign(auto, { step: to, slow: 0, fast: 0, wait: 5 });
  applySettings();
}
let mapT = 0, hudT = 0;
// One step of the client: simulation, HUD and rendering. Kept separate from the animation-frame loop so tests can drive it.
function tick(dt) {
  time += dt;
  world.update(time, dt, me.x, me.z);
  npcs?.update(dt, me);

  if (state === 'playing') {
    updateLocal(dt);
    updateViews(dt);
    updateBars();
    if ((hudT -= dt) <= 0) { hudT = 0.05; updateHud(); }
    if ((mapT -= dt) <= 0) { mapT = 0.15; drawMinimap(); }
    if (mapOpen && (mapDue -= dt) <= 0) drawWorldMap();
  } else {
    me.yaw = Math.sin(time * 0.6) * 0.7;
  }
  updateParticles(dt);
  fx.update(dt);
  updateAvatar(me, dt, true);
  me.bar.set(0, false);
  me.root.visible = !stats.dead;   // a hit shows as a flinch of the cat (cat.js), not as blinking in and out
  updateCamera(dt);
  if (bagOpen && state === 'playing') drawDoll(dt);

  composer.render();
}
function frame() {
  const real = clock.getDelta();
  measure(real);
  tick(Math.min(real, 0.05));
  requestAnimationFrame(frame);
}
frame();

// The loading screen goes when everything it was told about is in, the foliage has grown, the shaders of all that is
// in the scene - and of one monster of each kind, which only the server puts there - are compiled, and a few frames
// have been drawn behind it. It steps the game itself: a tab in the background gets no animation frames.
loading.finish({
  scene,
  grow: () => world.update(time, 1 / 60, me.x, me.z),
  compile: () => composer.compile(),
  frame: () => tick(1 / 60),
  extras: () => MOB_KEYS.filter((type) => MOB_TYPES[type].draw !== 'monster' || mapMonsters.includes(type))
    .map((type) => MOB_VIEW[MOB_TYPES[type].draw ?? 'skeleton'](type, MOB_TYPES[type]).group),
  programs: () => renderer.info.programs.length,
});

// debugging hook
window.__game = { me, stats, others, mobViews, send, world, map, rev: mapRev, cam, camera, tick, local, fx, toggleBag, toggleStore, toggleBook, toggleSheet, toggleHelp, toggleMap, toggleSettings, settings, setBar, get doll() { return doll; }, get sheet() { return sheet; }, get worldMap() { return worldMap; }, get target() { return targetId; }, get attacking() { return attacking; }, get state() { return state; } };

// A play-test, and a page that has reloaded itself for a saved map, go straight in.
if (autoJoin) {
  if (rejoin && !playMode) {
    $('nameInput').value = rejoin.name.slice(0, 16);
    if (START_CLASSES.includes(rejoin.cls)) pickClass(rejoin.cls);
  }
  // no click and no key came before this join, and until one does the browser keeps the sound off
  for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, () => actx?.resume(), { once: true });
  loading.ready.then(connect);   // not into a world that is still behind the loading screen
}
