import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { createCat } from './cat.js';

const ARENA_R = 30;
const TEAL = 0x7fe8d6;
const glow = (hex, k = 2.5) => new THREE.Color(hex).multiplyScalar(k);
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- renderer

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.prepend(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x040d0b);
const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.1, 200);
camera.position.set(0, 1.6, 5.4);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.7, 0.5, 1.0));
composer.addPass(new OutputPass());

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

scene.add(new THREE.HemisphereLight(0xd8fff6, 0x0a2a25, 0.95));
const sun = new THREE.DirectionalLight(0xffffff, 1.7);
sun.position.set(6, 14, 8);
scene.add(sun);

// ---------------------------------------------------------------- arena

const floorMat = new THREE.ShaderMaterial({
  uniforms: { uTime: { value: 0 }, uR: { value: ARENA_R } },
  vertexShader: /* glsl */`
    varying vec2 vP;
    void main() { vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform float uTime; uniform float uR; varying vec2 vP;
    void main() {
      float d = length(vP);
      float warp = sin(vP.x * 0.35 + uTime * 0.3) * 1.5 + cos(vP.y * 0.3 - uTime * 0.2) * 1.5;
      float w = sin(d * 1.5 - uTime * 1.1 + warp);
      float line = smoothstep(0.9, 1.0, w);
      vec3 col = mix(vec3(0.012, 0.045, 0.04), vec3(0.03, 0.13, 0.11), 0.5 + 0.5 * sin(d * 0.22 + warp * 0.3));
      col += vec3(0.25, 0.9, 0.75) * line * 0.3;
      col += vec3(0.3, 1.0, 0.85) * smoothstep(uR - 4.0, uR, d) * 0.3;
      gl_FragColor = vec4(col, 1.0);
    }`,
});
const floor = new THREE.Mesh(new THREE.CircleGeometry(ARENA_R, 96), floorMat);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

const rim = new THREE.Mesh(new THREE.TorusGeometry(ARENA_R, 0.14, 8, 128), new THREE.MeshBasicMaterial({ color: glow(TEAL, 1.5) }));
rim.rotation.x = Math.PI / 2;
scene.add(rim);

const crystals = [];
{
  const geo = new THREE.OctahedronGeometry(1);
  const mat = new THREE.MeshStandardMaterial({ color: 0x0b2a25, emissive: TEAL, emissiveIntensity: 0.9, flatShading: true });
  for (let i = 0; i < 14; i++) {
    const a = i / 14 * Math.PI * 2;
    const m = new THREE.Mesh(geo, mat);
    m.position.set(Math.cos(a) * (ARENA_R + 3), 2 + (i % 3), Math.sin(a) * (ARENA_R + 3));
    m.scale.set(1, 2.4 + (i % 2), 1);
    scene.add(m);
    crystals.push(m);
  }
  // floating dust
  const n = 500, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * 55;
    pos.set([Math.cos(a) * r, Math.random() * 22, Math.sin(a) * r], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: glow(TEAL, 1.5), size: 0.09, transparent: true, opacity: 0.7 })));
}

const shadowGeo = new THREE.CircleGeometry(1, 24);
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false });
function makeShadow(r) {
  const s = new THREE.Mesh(shadowGeo, shadowMat);
  s.rotation.x = -Math.PI / 2;
  s.position.y = 0.03;
  s.scale.setScalar(r);
  return s;
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
const bulletMat = new THREE.MeshBasicMaterial({ color: glow(TEAL, 3) });
const orbMat = new THREE.MeshBasicMaterial({ color: glow(0xff3b6b, 3) });
const gemMat = new THREE.MeshBasicMaterial({ color: glow(TEAL, 2) });
const gemGeo = new THREE.OctahedronGeometry(0.28);

const meshPool = (geo, mat, scale) => makePool(() => {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.setScalar(scale);
  scene.add(mesh);
  return { mesh };
});
const bulletPool = meshPool(sphereGeo, bulletMat, 0.2);
const orbPool = meshPool(sphereGeo, orbMat, 0.32);
const gemPool = meshPool(gemGeo, gemMat, 1);

const PMAX = 400;
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

// shockwave rings
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

// ---------------------------------------------------------------- player

const cat = createCat();
scene.add(cat.group);
const catShadow = makeShadow(0.6);
scene.add(catShadow);

const reticle = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.4, 32), new THREE.MeshBasicMaterial({ color: glow(TEAL, 2), transparent: true, opacity: 0.8 }));
reticle.rotation.x = -Math.PI / 2;
reticle.visible = false;
scene.add(reticle);

const player = {
  pos: new THREE.Vector3(), vy: 0, jumps: 0, speed: 0,
  hp: 100, energy: 0, invuln: 0, fireCd: 0, shootPose: 0,
  dashT: 0, dashCd: 0, dashId: 0, dashDir: new THREE.Vector2(0, 1),
  aim: new THREE.Vector2(0, 1), yaw: 0,
};

// ---------------------------------------------------------------- enemies

const ENEMY_TYPES = {
  chaser:  { r: 0.7,  hp: 3,  speed: 4.2, dmg: 10, score: 20,  color: 0xff3b8d, geo: new THREE.IcosahedronGeometry(1, 0) },
  runner:  { r: 0.45, hp: 1,  speed: 7.5, dmg: 6,  score: 15,  color: 0xff9a3b, geo: new THREE.OctahedronGeometry(1, 0) },
  shooter: { r: 0.6,  hp: 3,  speed: 3.2, dmg: 8,  score: 35,  color: 0xffe14d, geo: new THREE.TetrahedronGeometry(1.2, 0) },
  tank:    { r: 1.3,  hp: 14, speed: 2.4, dmg: 20, score: 100, color: 0xb04dff, geo: new THREE.DodecahedronGeometry(1, 0) },
};
const eyeMat = new THREE.MeshBasicMaterial({ color: glow(0xffffff, 2) });

let enemies = [], bullets = [], orbs = [], gems = [];

function spawnEnemy(type, hpScale) {
  const def = ENEMY_TYPES[type];
  const a = Math.random() * Math.PI * 2;
  const group = new THREE.Group();
  group.position.set(Math.cos(a) * (ARENA_R - 2), 0, Math.sin(a) * (ARENA_R - 2));
  const mat = new THREE.MeshStandardMaterial({ color: 0x1a0a18, emissive: def.color, emissiveIntensity: 0.7, flatShading: true, roughness: 0.5 });
  const body = new THREE.Mesh(def.geo, mat);
  body.scale.setScalar(def.r);
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(sphereGeo, eyeMat);
    eye.scale.set(0.16, 0.22, 0.1);
    eye.position.set(s * 0.33, 0.18, 0.78);
    body.add(eye);
  }
  group.add(body, makeShadow(def.r * 0.9));
  group.scale.setScalar(0.01);
  scene.add(group);
  enemies.push({
    type, def, group, body, mat, hp: Math.ceil(def.hp * hpScale), r: def.r,
    kx: 0, kz: 0, flash: 0, age: 0, phase: Math.random() * 6, fireT: 1 + Math.random() * 2, dashHit: -1,
    strafe: Math.random() < 0.5 ? 1 : -1,
  });
}

function damageEnemy(e, dmg, dx, dz, knock = 5) {
  e.hp -= dmg;
  e.flash = 1;
  e.kx += dx * knock; e.kz += dz * knock;
  const p = e.group.position;
  burst(p.x, e.r, p.z, e.def.color, 4, 5);
  if (e.hp <= 0) killEnemy(e); else sfx(520, 0.05, 'square', 0.03);
}

function killEnemy(e) {
  const i = enemies.indexOf(e);
  if (i < 0) return;
  enemies.splice(i, 1);
  const p = e.group.position;
  burst(p.x, e.r, p.z, e.def.color, 14 + e.r * 10, 8);
  scene.remove(e.group);
  e.mat.dispose();
  score += e.def.score;
  const n = e.type === 'tank' ? 4 : 1;
  for (let k = 0; k < n; k++) {
    const g = gemPool.get();
    g.mesh.position.set(p.x + (Math.random() - 0.5) * e.r * 2, 0.5, p.z + (Math.random() - 0.5) * e.r * 2);
    g.life = 12;
    gems.push(g);
  }
  sfx(180, 0.18, 'sawtooth', 0.06, -120);
}

// ---------------------------------------------------------------- game state

let state = 'menu';   // menu | playing | paused | over
let score = 0, wave = 0, spawnQueue = [], spawnT = 0, waveGap = 0, shake = 0, time = 0;
let best = 0;
try { best = +localStorage.getItem('hypercat-best') || 0; } catch { /* storage unavailable */ }

function buildWave(n) {
  const weights = { chaser: 1, runner: n >= 2 ? 0.6 : 0, shooter: n >= 3 ? 0.4 : 0, tank: n >= 4 ? 0.2 : 0 };
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const q = [];
  for (let i = 0; i < 4 + n * 3; i++) {
    let r = Math.random() * total;
    for (const [type, w] of Object.entries(weights)) { r -= w; if (r <= 0) { q.push(type); break; } }
  }
  if (n % 5 === 0) q.push('tank', 'tank');
  return q;
}

let bannerTimer = 0;
function banner(text) {
  $('banner').textContent = text;
  $('banner').classList.add('on');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => $('banner').classList.remove('on'), 1600);
}

function startWave(n) {
  wave = n;
  spawnQueue = buildWave(n);
  spawnT = 0.8;
  banner(`Волна ${n}`);
  sfx(440, 0.25, 'triangle', 0.08, 440);
}

function clearList(list, pool) {
  for (const o of list) pool.release(o);
  list.length = 0;
}

function startGame() {
  if (!actx) { try { actx = new AudioContext(); } catch { /* no audio */ } }
  for (const e of enemies) { scene.remove(e.group); e.mat.dispose(); }
  enemies = [];
  clearList(bullets, bulletPool); clearList(orbs, orbPool); clearList(gems, gemPool);
  Object.assign(player, { vy: 0, jumps: 0, hp: 100, energy: 0, invuln: 1, fireCd: 0, dashT: 0, dashCd: 0 });
  player.pos.set(0, 0, 0);
  score = 0; waveGap = 0;
  state = 'playing';
  $('menu').classList.add('hidden');
  $('over').classList.add('hidden');
  $('hud').classList.add('on');
  reticle.visible = true;
  startWave(1);
}

function gameOver() {
  state = 'over';
  reticle.visible = false;
  if (score > best) { best = score; try { localStorage.setItem('hypercat-best', best); } catch { /* ignore */ } }
  $('overStats').textContent = `Волна ${wave} · Очки: ${score}`;
  $('overBest').textContent = `Рекорд: ${best}`;
  $('over').classList.remove('hidden');
  $('hud').classList.remove('on');
  sfx(300, 0.7, 'sawtooth', 0.08, -250);
}

function hurtPlayer(dmg) {
  if (player.invuln > 0 || player.dashT > 0 || state !== 'playing') return;
  player.hp -= dmg;
  player.invuln = 0.7;
  shake = 0.6;
  $('flash').style.opacity = 1;
  setTimeout(() => { $('flash').style.opacity = 0; }, 120);
  burst(player.pos.x, player.pos.y + 1, player.pos.z, 0xff4d7a, 10, 6);
  sfx(140, 0.2, 'sawtooth', 0.09, -60);
  if (player.hp <= 0) { player.hp = 0; gameOver(); }
}

function hyperWave() {
  if (player.energy < 100 || state !== 'playing') return;
  player.energy = 0;
  shake = 0.8;
  const R = 13;
  spawnRing(player.pos.x, player.pos.z, R, TEAL);
  burst(player.pos.x, 1, player.pos.z, TEAL, 40, 14);
  for (const e of [...enemies]) {
    const dx = e.group.position.x - player.pos.x, dz = e.group.position.z - player.pos.z;
    const d = Math.hypot(dx, dz) || 1;
    if (d < R) damageEnemy(e, 8, dx / d, dz / d, 22);
  }
  clearList(orbs, orbPool);
  sfx(90, 0.6, 'sawtooth', 0.12, 700);
}

// ---------------------------------------------------------------- input

const keys = new Set();
const mouse = new THREE.Vector2(0, -0.3);
let firing = false;

addEventListener('keydown', (e) => {
  if (e.repeat) return;
  keys.add(e.code);
  if (e.code === 'Space') { e.preventDefault(); if (state === 'playing') jump(); else if (state !== 'paused') startGame(); }
  if (e.code === 'Enter' && (state === 'menu' || state === 'over')) startGame();
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') dash();
  if (e.code === 'KeyQ' || e.code === 'KeyE') hyperWave();
  if (e.code === 'KeyM') muted = !muted;
  if (e.code === 'Escape' || e.code === 'KeyP') togglePause();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => { keys.clear(); firing = false; });
addEventListener('mousemove', (e) => mouse.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1));
renderer.domElement.addEventListener('mousedown', (e) => { if (e.button === 0) firing = true; if (e.button === 2) hyperWave(); });
addEventListener('mouseup', (e) => { if (e.button === 0) firing = false; });
addEventListener('contextmenu', (e) => e.preventDefault());
$('playBtn').addEventListener('click', startGame);
$('againBtn').addEventListener('click', startGame);

function togglePause() {
  if (state === 'playing') state = 'paused'; else if (state === 'paused') state = 'playing'; else return;
  $('pause').classList.toggle('hidden', state !== 'paused');
}

function jump() {
  if (player.jumps >= 2) return;
  player.vy = player.jumps === 0 ? 11 : 9.5;
  player.jumps++;
  burst(player.pos.x, player.pos.y + 0.1, player.pos.z, 0xffffff, 5, 3);
  sfx(player.jumps === 1 ? 380 : 520, 0.12, 'triangle', 0.06, 250);
}

const moveDir = new THREE.Vector2();
function dash() {
  if (state !== 'playing' || player.dashCd > 0) return;
  player.dashDir.copy(moveDir.lengthSq() > 0 ? moveDir : player.aim).normalize();
  player.dashT = 0.18;
  player.dashCd = 1.2;
  player.dashId++;
  sfx(700, 0.15, 'sawtooth', 0.05, -500);
}

// ---------------------------------------------------------------- update

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const aimPoint = new THREE.Vector3();
const camTarget = new THREE.Vector3(0, 1.05, 0), camGoal = new THREE.Vector3(), lookGoal = new THREE.Vector3();

function clampToArena(p, margin) {
  const d = Math.hypot(p.x, p.z), max = ARENA_R - margin;
  if (d > max) { p.x *= max / d; p.z *= max / d; }
}

function updatePlayer(dt) {
  const p = player.pos;

  // aim at the mouse position on the ground
  raycaster.setFromCamera(mouse, camera);
  if (raycaster.ray.intersectPlane(groundPlane, aimPoint)) {
    const ax = aimPoint.x - p.x, az = aimPoint.z - p.z;
    if (ax * ax + az * az > 0.04) player.aim.set(ax, az).normalize();
    reticle.position.set(aimPoint.x, 0.06, aimPoint.z);
  }

  moveDir.set(
    (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0),
    (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0),
  );
  if (moveDir.lengthSq() > 0) moveDir.normalize();

  player.dashCd -= dt;
  player.invuln -= dt;
  if (player.dashT > 0) {
    player.dashT -= dt;
    p.x += player.dashDir.x * 32 * dt;
    p.z += player.dashDir.y * 32 * dt;
    player.speed = 9;
    burst(p.x, p.y + 0.8, p.z, TEAL, 2, 2);
  } else {
    p.x += moveDir.x * 9 * dt;
    p.z += moveDir.y * 9 * dt;
    player.speed = moveDir.lengthSq() > 0 ? 9 : 0;
  }
  clampToArena(p, 1);

  player.vy -= 30 * dt;
  p.y += player.vy * dt;
  if (p.y <= 0) { p.y = 0; player.vy = 0; player.jumps = 0; }

  // shooting
  player.fireCd -= dt;
  player.shootPose -= dt;
  if (firing && player.fireCd <= 0 && player.dashT <= 0) {
    player.fireCd = 0.13;
    player.shootPose = 0.25;
    const b = bulletPool.get();
    b.mesh.position.set(p.x + player.aim.x * 0.8, p.y + 1.0, p.z + player.aim.y * 0.8);
    b.vx = player.aim.x * 34; b.vz = player.aim.y * 34; b.life = 1.1;
    bullets.push(b);
    sfx(880, 0.06, 'square', 0.025, -300);
  }

  // face the aim direction
  const targetYaw = Math.atan2(player.aim.x, player.aim.y);
  let dy = targetYaw - player.yaw;
  dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  player.yaw += dy * Math.min(1, dt * 16);
}

function updateEnemies(dt) {
  const p = player.pos;
  for (const e of [...enemies]) {
    const g = e.group.position;
    e.age += dt;
    e.group.scale.setScalar(Math.min(1, e.age / 0.4));
    let dx = p.x - g.x, dz = p.z - g.z;
    const dist = Math.hypot(dx, dz) || 0.001;
    dx /= dist; dz /= dist;

    let mx = dx, mz = dz;
    if (e.type === 'shooter') {
      if (dist < 9) { mx = -dx; mz = -dz; }
      else if (dist < 14) { mx = -dz * e.strafe; mz = dx * e.strafe; }
      e.fireT -= dt;
      if (e.fireT <= 0 && dist < 22) {
        e.fireT = 2.2;
        const o = orbPool.get();
        o.mesh.position.set(g.x + dx, 1, g.z + dz);
        o.vx = dx * 10; o.vz = dz * 10; o.life = 4;
        orbs.push(o);
        sfx(260, 0.12, 'sine', 0.05, 200);
      }
    }
    g.x += (mx * e.def.speed + e.kx) * dt;
    g.z += (mz * e.def.speed + e.kz) * dt;
    const damp = Math.exp(-6 * dt);
    e.kx *= damp; e.kz *= damp;
    clampToArena(g, e.r);

    e.group.rotation.y = Math.atan2(dx, dz);
    e.body.position.y = e.r + 0.15 + Math.sin(time * 4 + e.phase) * 0.12;
    e.body.rotation.z = Math.sin(time * 3 + e.phase) * 0.15;
    e.flash = Math.max(0, e.flash - dt * 6);
    e.mat.emissiveIntensity = 0.7 + e.flash * 4;

    if (dist < e.r + 0.55 && p.y < e.r * 2 + 0.2) {
      if (player.dashT > 0) {
        if (e.dashHit !== player.dashId) { e.dashHit = player.dashId; damageEnemy(e, 3, -dx, -dz, 14); }
      } else {
        hurtPlayer(e.def.dmg);
        e.kx -= dx * 8; e.kz -= dz * 8;
      }
    }
  }

  // keep enemies from stacking
  for (let i = 0; i < enemies.length; i++) {
    for (let j = i + 1; j < enemies.length; j++) {
      const a = enemies[i], b = enemies[j];
      const dx = b.group.position.x - a.group.position.x, dz = b.group.position.z - a.group.position.z;
      const d = Math.hypot(dx, dz) || 0.001, min = a.r + b.r;
      if (d < min) {
        const push = (min - d) / 2 / d;
        a.group.position.x -= dx * push; a.group.position.z -= dz * push;
        b.group.position.x += dx * push; b.group.position.z += dz * push;
      }
    }
  }
}

function updateProjectiles(dt) {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i], m = b.mesh.position;
    m.x += b.vx * dt; m.z += b.vz * dt;
    b.life -= dt;
    let dead = b.life <= 0 || Math.hypot(m.x, m.z) > ARENA_R + 2;
    if (!dead) {
      for (const e of enemies) {
        const dx = e.group.position.x - m.x, dz = e.group.position.z - m.z, rr = e.r + 0.3;
        if (dx * dx + dz * dz < rr * rr && m.y < e.r * 2 + 0.6) {
          const s = Math.hypot(b.vx, b.vz);
          damageEnemy(e, 1, b.vx / s, b.vz / s, 4);
          dead = true;
          break;
        }
      }
    }
    if (dead) { bulletPool.release(b); bullets.splice(i, 1); }
  }

  const p = player.pos;
  for (let i = orbs.length - 1; i >= 0; i--) {
    const o = orbs[i], m = o.mesh.position;
    m.x += o.vx * dt; m.z += o.vz * dt;
    o.life -= dt;
    let dead = o.life <= 0 || Math.hypot(m.x, m.z) > ARENA_R + 2;
    if (!dead && Math.hypot(m.x - p.x, m.z - p.z) < 0.75 && p.y < 1.4 && player.dashT <= 0) {
      hurtPlayer(10);
      dead = true;
    }
    if (dead) { burst(m.x, m.y, m.z, 0xff3b6b, 4, 3); orbPool.release(o); orbs.splice(i, 1); }
  }

  for (let i = gems.length - 1; i >= 0; i--) {
    const g = gems[i], m = g.mesh.position;
    g.life -= dt;
    g.mesh.rotation.y += dt * 3;
    m.y = 0.55 + Math.sin(time * 4 + i) * 0.12;
    const dx = p.x - m.x, dz = p.z - m.z, d = Math.hypot(dx, dz) || 0.001;
    if (d < 5) { const pull = (5 - d) * 5 * dt / d; m.x += dx * pull; m.z += dz * pull; }
    g.mesh.visible = g.life > 3 || Math.sin(time * 20) > 0;
    if (d < 0.9) {
      player.energy = Math.min(100, player.energy + 8);
      score += 5;
      sfx(1200, 0.08, 'sine', 0.05, 600);
      g.life = 0;
    }
    if (g.life <= 0) { gemPool.release(g); gems.splice(i, 1); }
  }

  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    r.t += dt / 0.45;
    r.mesh.scale.setScalar(Math.max(0.01, r.t * r.maxR));
    r.mesh.material.opacity = 1 - r.t;
    if (r.t >= 1) { scene.remove(r.mesh); r.mesh.material.dispose(); rings.splice(i, 1); }
  }
}

function updateWaves(dt) {
  if (spawnQueue.length) {
    spawnT -= dt;
    if (spawnT <= 0) {
      spawnEnemy(spawnQueue.pop(), 1 + (wave - 1) * 0.08);
      spawnT = Math.max(0.25, 0.75 - wave * 0.04);
    }
  } else if (enemies.length === 0) {
    if (waveGap <= 0) {
      waveGap = 2.5;
      score += wave * 50;
      player.hp = Math.min(100, player.hp + 20);
      banner('Волна пройдена!');
    } else {
      waveGap -= dt;
      if (waveGap <= 0) startWave(wave + 1);
    }
  }
}

function updateHud() {
  $('hpFill').style.width = `${player.hp}%`;
  $('enFill').style.width = `${player.energy}%`;
  $('enFill').classList.toggle('full', player.energy >= 100);
  $('enHint').textContent = player.energy >= 100 ? '— жми Q!' : '';
  $('dashFill').style.width = `${Math.max(0, Math.min(1, 1 - player.dashCd / 1.2)) * 100}%`;
  $('score').textContent = score;
  $('wave').textContent = wave;
}

function updateCamera(dt) {
  if (state === 'menu') {
    camGoal.set(0, 1.2, 6.4);
    lookGoal.set(0, 0.45, 0);
  } else {
    lookGoal.set(player.pos.x, 1, player.pos.z);
    camGoal.set(player.pos.x, 13.5, player.pos.z + 10);
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
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  if (state !== 'paused') {
    time += dt;
    floorMat.uniforms.uTime.value = time;
    for (let i = 0; i < crystals.length; i++) crystals[i].rotation.y = time * 0.4 + i;

    if (state === 'playing') {
      updatePlayer(dt);
      updateEnemies(dt);
      updateProjectiles(dt);
      updateWaves(dt);
      updateHud();
    } else if (state === 'menu') {
      player.yaw = Math.sin(time * 0.6) * 0.7;
    }
    updateParticles(dt);

    const playing = state === 'playing';
    cat.update(dt, {
      speed: playing ? player.speed : 0,
      airborne: player.pos.y > 0.05,
      shooting: playing && player.shootPose > 0,
      dashing: playing && player.dashT > 0,
    });
    cat.group.position.copy(player.pos);
    cat.group.rotation.y = player.yaw;
    cat.group.visible = state === 'over' ? false : !(player.invuln > 0 && playing && Math.sin(time * 40) > 0.3);
    catShadow.position.set(player.pos.x, 0.03, player.pos.z);
    catShadow.scale.setScalar(0.6 / (1 + player.pos.y * 0.3));
    updateCamera(dt);
  }
  composer.render();
  requestAnimationFrame(frame);
}
frame();

// debugging hook
window.__game = { player, get state() { return state; }, get enemies() { return enemies; }, startGame };
