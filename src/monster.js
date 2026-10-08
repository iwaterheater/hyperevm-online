import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { ATTACK_WINDUP } from './shared.js';

// The monsters that are not skeletons: slimes, orcs, demons, ghosts, wolves and the rest, all by Quaternius (CC0): his
// packs "Ultimate Monsters" and "Cute Animated Monsters" and a few of his animals. tools/import-monsters.mjs brings
// each one into assets/monsters/ as <kind>.glb with up to five animations; every model has its own rig, and the sets -
// two-legged, blob and flying of the first pack, walkers and flyers of the second, the animals - name their
// animations differently.
//
// createMonster() answers like createSkeleton(): { group, height, update, attack, hit, die, flash, dispose }.

const DIR = './assets/monsters/';

// What each set calls the five animations (the same table as in the import script).
const CLIPS = {
  big:    { idle: 'Idle', walk: 'Walk', attack: 'Punch', hit: 'HitReact', death: 'Death' },
  blob:   { idle: 'Idle', walk: 'Walk', attack: 'Bite_Front', hit: 'HitRecieve', death: 'Death' },
  flying: { idle: 'Flying_Idle', walk: 'Fast_Flying', attack: 'Headbutt', hit: 'HitReact', death: 'Death' },
  cute:   { idle: 'Idle', walk: 'Walk', attack: 'Bite_Front', hit: 'HitRecieve', death: 'Death' },
  wing:   { idle: 'Flying', walk: 'Flying', attack: 'Bite_Front', hit: 'HitRecieve', death: 'Death' },
  hunter: { idle: 'Idle', walk: 'Gallop', attack: 'Attack', hit: 'Idle_HitReact_Left', death: 'Death' },
  grazer: { idle: 'Idle', walk: 'Walk', attack: 'Attack_Headbutt', hit: 'Idle_HitReact_Left', death: 'Death' },
  spider: { idle: 'Spider_Idle', walk: 'Spider_Walk', attack: 'Spider_Attack', hit: null, death: 'Spider_Death' },
  raptor: { idle: 'Velociraptor_Idle', walk: 'Velociraptor_Run', attack: 'Velociraptor_Attack', hit: null, death: 'Velociraptor_Death' },
};
// LOOKS[kind] = { set, height, hover?, stride? }
//   height  how tall the monster stands, in game units: the model is scaled to it
//   hover   how far a flying one hangs above the ground        stride  the ground one walk cycle covers, at scale 1
const LOOKS = {
  slime:      { set: 'blob', height: 1.1 },
  pinkslime:  { set: 'blob', height: 1.0 },
  mushnub:    { set: 'blob', height: 1.5 },
  spikeslime: { set: 'blob', height: 2.3 },
  frog:       { set: 'big', height: 1.8 },
  cactoro:    { set: 'big', height: 2.3 },
  orc:        { set: 'big', height: 2.1 },
  orcbrute:   { set: 'big', height: 3.2 },
  shaman:     { set: 'big', height: 2.4 },
  yeti:       { set: 'big', height: 3.3 },
  demon:      { set: 'big', height: 1.9 },
  bluedemon:  { set: 'big', height: 3.3 },
  alien:      { set: 'big', height: 2.2 },
  bee:        { set: 'flying', height: 1.0, hover: 1.1 },
  ghost:      { set: 'flying', height: 1.8, hover: 0.5 },
  wraith:     { set: 'flying', height: 2.0, hover: 0.5 },
  dragon:     { set: 'flying', height: 1.3, hover: 1.4 },
  birb:         { set: 'big', height: 2.1 },
  bunny:        { set: 'big', height: 2.0 },
  dino:         { set: 'big', height: 2.2 },
  fishman:      { set: 'big', height: 2.3 },
  monkroose:    { set: 'big', height: 2.0 },
  mushroomking: { set: 'big', height: 3.2 },
  ninja:        { set: 'big', height: 1.9 },
  alienblob:    { set: 'blob', height: 1.7 },
  puffbirb:     { set: 'blob', height: 1.5 },
  cactoblob:    { set: 'blob', height: 1.7 },
  tabby:        { set: 'blob', height: 1.1 },
  chicken:      { set: 'blob', height: 1.2 },
  pup:          { set: 'blob', height: 1.1 },
  snapper:      { set: 'blob', height: 1.5 },
  eldermushnub: { set: 'blob', height: 2.6 },
  ninjablob:    { set: 'blob', height: 1.5 },
  orcwhelp:     { set: 'blob', height: 1.3 },
  pigeon:       { set: 'blob', height: 1.0 },
  hexblob:      { set: 'blob', height: 1.5 },
  snowball:     { set: 'blob', height: 1.5 },
  alpaking:      { set: 'flying', height: 1.2, hover: 1.1 },
  alpakinglord:  { set: 'flying', height: 2.0, hover: 1.0 },
  queenbee:      { set: 'flying', height: 1.7, hover: 1.1 },
  drake:         { set: 'flying', height: 2.6, hover: 1.0 },
  glub:          { set: 'flying', height: 1.3, hover: 1.0 },
  glublord:      { set: 'flying', height: 2.2, hover: 0.8 },
  goleling:      { set: 'flying', height: 0.9, hover: 1.3 },
  golelingelder: { set: 'flying', height: 1.6, hover: 1.2 },
  hywirl:        { set: 'flying', height: 1.9, hover: 0.4 },
  skypigeon:     { set: 'flying', height: 0.8, hover: 1.4 },
  squidle:       { set: 'flying', height: 1.5, hover: 1.2 },
  tribalmask:    { set: 'flying', height: 2.4, hover: 0.5 },
  stalker:   { set: 'cute', height: 1.4 },
  lanky:     { set: 'cute', height: 1.5 },
  prickle:   { set: 'cute', height: 1.6 },
  hen:       { set: 'cute', height: 1.1 },
  crab:      { set: 'cute', height: 1.1 },
  cyclops:   { set: 'cute', height: 1.3 },
  deer:      { set: 'cute', height: 1.4 },
  fiend:     { set: 'cute', height: 1.3 },
  spook:     { set: 'cute', height: 1.2 },
  gremlin:   { set: 'cute', height: 1.3 },
  shroom:    { set: 'cute', height: 1.5 },
  panda:     { set: 'cute', height: 1.3 },
  penguin:   { set: 'cute', height: 1.2 },
  pig:       { set: 'cute', height: 1.2 },
  skull:     { set: 'cute', height: 1.1 },
  treant:    { set: 'cute', height: 2.4 },   // the one model without a death animation
  frostling: { set: 'cute', height: 1.4 },
  bat:       { set: 'wing', height: 1.0, hover: 1.2 },
  hornet:    { set: 'wing', height: 1.1, hover: 1.1 },
  cthulhu:   { set: 'wing', height: 1.3, hover: 1.0 },
  wyrmling:  { set: 'wing', height: 1.3, hover: 1.2 },
  wolf:   { set: 'hunter', height: 1.6 },
  fox:    { set: 'hunter', height: 1.1 },
  bull:   { set: 'grazer', height: 2.3 },
  stag:   { set: 'grazer', height: 2.7 },
  alpaca: { set: 'grazer', height: 2.2 },
  spider: { set: 'spider', height: 1.3 },
  raptor: { set: 'raptor', height: 2.0 },
};
export const MONSTER_KINDS = Object.keys(LOOKS);

const assets = {};        // kind -> { scene, clips, size, base }
const loading = new Map();

let gradientMap = null;
function steps() {
  if (!gradientMap) {
    gradientMap = new THREE.DataTexture(new Uint8Array([105, 185, 255]), 3, 1, THREE.RedFormat);
    gradientMap.minFilter = gradientMap.magFilter = THREE.NearestFilter;
    gradientMap.needsUpdate = true;
  }
  return gradientMap;
}

// Loads the models of the given kinds, each once; resolves when those monsters can be created. A map names the kinds it
// holds, so a world without dragons never asks for the dragon. `onFile(ok)` is called for each file that has settled.
export function loadMonsters(kinds, onFile = null) {
  const loader = new GLTFLoader();
  return Promise.all([...new Set(kinds)].filter((kind) => Object.hasOwn(LOOKS, kind)).map((kind) => {
    if (!loading.has(kind)) {
      loading.set(kind, loader.loadAsync(`${DIR}${kind}.glb`).then((gltf) => {
        const toon = new Map();   // the file's material -> the one the game draws with
        gltf.scene.traverse((o) => {
          if (!o.isMesh) return;
          o.castShadow = true;
          o.frustumCulled = false;
          if (!toon.has(o.material)) {
            // a small texture is a palette of 32 x 32 with a colour to a cell or two: smoothed, and above all shrunk
            // into mipmaps, the cells run into their neighbours and the colours go muddy a few steps away. A large
            // one is a painted skin and stays smooth.
            const map = o.material.map;
            if (map && map.image.width <= 64) { map.minFilter = map.magFilter = THREE.NearestFilter; map.generateMipmaps = false; map.needsUpdate = true; }
            // shaded in three flat steps, like the cat, not smoothly like the scenery
            toon.set(o.material, new THREE.MeshToonMaterial({ map, color: o.material.color, gradientMap: steps(), side: o.material.side }));
          }
          o.material = toon.get(o.material);
        });
        // how big the model is as it stands in the file: what the look's height is measured against
        const box = new THREE.Box3().setFromObject(gltf.scene);
        assets[kind] = { scene: gltf.scene, clips: gltf.animations, size: Math.max(0.01, box.max.y - box.min.y), base: box.min.y };
        onFile?.(true);
      }, (err) => { onFile?.(false); throw err; }));
    }
    return loading.get(kind);
  }));
}

export function createMonster(type, def) {
  const L = LOOKS[type], src = assets[type], names = CLIPS[L.set];
  const model = SkeletonUtils.clone(src.scene);
  const mats = new Map();   // this monster's own copies of its materials, so it can flash when hit
  model.traverse((o) => {
    if (!o.isMesh) return;
    if (!mats.has(o.material)) mats.set(o.material, o.material.clone());
    o.material = mats.get(o.material);
  });

  const scale = L.height / src.size;
  const group = new THREE.Group();   // origin on the ground, facing +Z
  group.scale.setScalar(scale);
  model.position.y = -src.base + (L.hover ?? 0) / scale;
  group.add(model);

  const mixer = new THREE.AnimationMixer(model);
  const action = (name, once, own) => {
    const clip = name && THREE.AnimationClip.findByName(src.clips, name);
    if (!clip) return null;
    const a = mixer.clipAction(own ? clip.clone() : clip);   // a mixer keeps one action a clip: a second needs a copy
    if (once) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
    return a;
  };
  // a flyer of the second pack hangs in the air and flies with one and the same animation
  const idle = action(names.idle), walk = action(names.walk, false, names.walk === names.idle);
  const attack = action(names.attack, true);
  const hit = action(names.hit, true);       // null for a model that does not flinch: the flash says it was hit
  const death = action(names.death, true);   // null for a model that has none: it is toppled over in update()
  // a walk cycle is about a second and a half of model time: faster kinds step faster, within reason
  walk.timeScale = Math.max(0.7, Math.min(2.2, def.speed / 2.6));
  // the blow of an attack clip falls about two fifths in: that moment is the end of the server's wind-up
  attack.timeScale = Math.max(0.6, attack.getClip().duration * 0.4 / ATTACK_WINDUP);
  idle.play();
  walk.play();
  mixer.update(Math.random() * 2);   // desynchronise the crowd

  let move = 0, shot = null, shotT = 0, dead = false, fallen = -1;

  function play(a) {
    if (dead) return;
    if (shot) shot.stop();
    shot = a;
    shotT = 0;
    a.reset().setEffectiveWeight(0).play();
  }

  function update(dt, time, moving) {
    move += ((moving ? 1 : 0) - move) * Math.min(1, dt * 8);
    let w = 0;   // how much the one-shot clip (attack / hit / death) overrides locomotion
    if (shot) {
      shotT += dt;
      const dur = shot.getClip().duration / shot.timeScale;
      w = dead ? Math.min(1, shotT / 0.08) : Math.max(0, Math.min(1, shotT / 0.08, (dur - shotT) / 0.18));
      shot.setEffectiveWeight(w);
      if (!dead && shotT >= dur) { shot.stop(); shot = null; w = 0; }
    }
    idle.setEffectiveWeight((1 - move) * (1 - w));
    walk.setEffectiveWeight(move * (1 - w));
    if (fallen >= 0) {   // no death animation: it stops where it stands and goes over on its back
      fallen = Math.min(1, fallen + dt / 0.45);
      model.rotation.x = -fallen * fallen * (3 - 2 * fallen) * Math.PI / 2;
      return;
    }
    mixer.update(dt);
  }

  return {
    group, update,
    height: L.height + (L.hover ?? 0),
    attack: () => play(attack),
    hit: () => { if (hit && shot !== attack) play(hit); },   // a flinch never cancels a blow
    die: () => { if (dead) return; if (death) play(death); else fallen = 0; dead = true; },
    flash: (k) => { for (const m of mats.values()) m.emissive?.setScalar(k * 0.5); },
    dispose: () => { mixer.stopAllAction(); mixer.uncacheRoot(model); for (const m of mats.values()) m.dispose(); },
  };
}
