import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { ATTACK_WINDUP } from './shared.js';

// Skeleton monsters built from the KayKit "Character Pack: Skeletons" models (CC0, Kay Lousberg).
// Every model ships the same rig and animation set; variants differ in model, size, gear and clips.

export const BONE = 0xe9e3d2;
export const SKELETON_HEIGHT = 2.2;   // at scale 1

const DIR = './assets/skeletons/';
const MODELS = ['Skeleton_Minion', 'Skeleton_Rogue', 'Skeleton_Mage', 'Skeleton_Warrior'];
const GEAR = ['Skeleton_Blade', 'Skeleton_Axe', 'Skeleton_Staff', 'Skeleton_Shield_Large_A'];

// `hitAt` is the moment inside the attack clip when the blow lands; it is synced to the server's wind-up.
const VARIANTS = {
  chaser:  { model: 'Skeleton_Minion',  scale: 1.25, right: 'Skeleton_Blade', walk: 'Walking_D_Skeletons', stride: 1.6, attack: '1H_Melee_Attack_Chop', hitAt: 0.5 },
  runner:  { model: 'Skeleton_Rogue',   scale: 1.0,  right: 'Skeleton_Blade', left: 'Skeleton_Blade', walk: 'Running_A', stride: 4.5, attack: 'Dualwield_Melee_Attack_Chop', hitAt: 0.55 },
  shooter: { model: 'Skeleton_Mage',    scale: 1.25, right: 'Skeleton_Staff', walk: 'Walking_A', stride: 1.8, attack: 'Spellcast_Shoot', hitAt: 0.25 },
  tank:    { model: 'Skeleton_Warrior', scale: 2.0,  right: 'Skeleton_Axe', left: 'Skeleton_Shield_Large_A', walk: 'Walking_D_Skeletons', stride: 1.6, attack: '1H_Melee_Attack_Chop', hitAt: 0.5 },
  boss:    { model: 'Skeleton_Warrior', scale: 3.4,  right: 'Skeleton_Blade', left: 'Skeleton_Shield_Large_A', walk: 'Walking_C', stride: 1.4, attack: '1H_Melee_Attack_Slice_Horizontal', hitAt: 0.5 },
};

const assets = {};
let ready = null;

// Loads every model once; resolves when skeletons can be created.
export function loadSkeletons() {
  if (!ready) {
    const loader = new GLTFLoader();
    const load = (name, ext) => loader.loadAsync(`${DIR}${name}.${ext}`).then((gltf) => {
      gltf.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
      assets[name] = gltf;
    });
    ready = Promise.all([...MODELS.map((n) => load(n, 'glb')), ...GEAR.map((n) => load(n, 'gltf'))]);
  }
  return ready;
}

const glowMats = new Map();
// GLTFLoader strips dots from node names ("handslot.r" becomes "handslotr")
const findSlot = (model, side) => model.getObjectByName(`handslot${side}`) || model.getObjectByName(`handslot.${side}`);

export function createSkeleton(type, def) {
  const v = VARIANTS[type], src = assets[v.model];
  const model = SkeletonUtils.clone(src.scene);

  if (!glowMats.has(type)) glowMats.set(type, new THREE.MeshBasicMaterial({ color: new THREE.Color(def.color).multiplyScalar(2.6) }));
  let mat = null;   // per-monster copy of the body material, so it can flash when hit
  model.traverse((o) => {
    if (!o.isMesh) return;
    if (o.material.name === 'Glow') { o.material = glowMats.get(type); return; }
    mat ||= o.material.clone();
    o.material = mat;
  });

  for (const [side, gear] of [['r', v.right], ['l', v.left]]) {
    const slot = gear && findSlot(model, side);
    if (slot) slot.add(assets[gear].scene.clone(true));
  }

  const group = new THREE.Group();   // origin at the feet, facing +Z
  group.scale.setScalar(v.scale);
  group.add(model);

  const mixer = new THREE.AnimationMixer(model);
  const action = (name, once) => {
    const a = mixer.clipAction(THREE.AnimationClip.findByName(src.animations, name));
    if (once) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
    return a;
  };
  const idle = action('Idle'), walk = action(v.walk);
  const attack = action(v.attack, true), hit = action('Hit_A', true), death = action('Death_A', true);
  walk.timeScale = Math.max(0.6, Math.min(1.7, def.speed / (v.scale * v.stride)));   // keep the feet from sliding
  attack.timeScale = v.hitAt / ATTACK_WINDUP;
  idle.play();
  walk.play();
  mixer.update(Math.random() * 2);   // desynchronise the crowd

  let move = 0, shot = null, shotT = 0, dead = false;

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
    mixer.update(dt);
  }

  return {
    group, mat, update,
    attack: () => play(attack),
    hit: () => { if (shot !== attack) play(hit); },   // a flinch never cancels a swing
    die: () => { play(death); dead = true; },
    flash: (k) => mat.emissive.setScalar(k * 0.5),
    dispose: () => { mixer.stopAllAction(); mixer.uncacheRoot(model); mat.dispose(); },
  };
}
