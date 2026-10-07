import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// Townsfolk: models from the KayKit "Character Pack: Adventurers" (CC0, Kay Lousberg).
// They stand where the map puts them, play idle animations, turn to face a nearby player and say a line.
// Every model carries all of its gear at once; `gear` lists the pieces left visible.

const DIR = './assets/adventurers/';
const SCALE = 1.15;
const NOTICE_RANGE = 7;

// What each kind of NPC looks like and says; the keys are the NPC kinds of the map format.
const KINDS = {
  guard: { model: 'Knight', gear: ['1H_Sword', 'Badge_Shield'], clip: 'Idle', name: 'Town Guard', line: 'Stay close to the walls, traveller.' },
  blacksmith: { model: 'Barbarian', gear: ['1H_Axe'], clip: 'Idle', name: 'Blacksmith', line: 'Need a sharper blade? Press B.' },
  sage: { model: 'Mage', gear: ['2H_Staff'], clip: 'Idle', name: 'Sage', line: 'Press K — I teach skills and professions.' },
  trader: { model: 'Rogue_Hooded', gear: [], clip: 'Idle', name: 'Trader', line: 'Gold talks. Press T to trade.' },
};
const GEAR = /^(1H_|2H_|Knife|Throwable|Mug|Spellbook|.*_Shield)/;

// The model files these townsfolk need, each once.
export const npcModels = (npcs) => [...new Set(npcs.map((n) => KINDS[n.kind].model))];

// `label(text, color, height)` builds a text sprite; `npcs` is the list of the map: { kind, x, z, ry }.
// The map view registers them as obstacles. `heightAt(x, z)` is the height of the ground they stand on.
// `onFile(ok)` is called per model file that has settled, loaded or not.
export async function createNpcs(scene, label, npcs, heightAt = () => 0, onFile = null) {
  const loader = new GLTFLoader();
  const models = {};
  await Promise.all(npcModels(npcs).map(async (name) => {
    try { models[name] = await loader.loadAsync(`${DIR}${name}.glb`); } finally { onFile?.(name in models); }
  }));

  const folk = npcs.map(({ kind, x, z, ry }) => {
    const def = KINDS[kind], src = models[def.model];
    const model = SkeletonUtils.clone(src.scene);
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      o.frustumCulled = false;
      if (GEAR.test(o.name) && !def.gear.includes(o.name)) o.visible = false;
    });
    const root = new THREE.Group();   // never rotates, so the labels stay screen-aligned
    const body = new THREE.Group();
    body.scale.setScalar(SCALE);
    body.rotation.y = ry;
    body.add(model);
    root.add(body);
    root.position.set(x, heightAt(x, z), z);

    const title = label(def.name, '#ffe9a6', 0.42);
    title.position.y = 3.1;
    const line = label(def.line, '#ffffff', 0.36);
    line.position.y = 3.6;
    line.visible = false;
    root.add(title, line);
    scene.add(root);

    const mixer = new THREE.AnimationMixer(model);
    mixer.clipAction(THREE.AnimationClip.findByName(src.animations, def.clip)).play();
    mixer.update(Math.random() * 2);
    return { root, body, line, mixer, x, z, yaw: ry, home: ry };
  });

  function update(dt, player) {
    for (const n of folk) {
      const dx = player.x - n.x, dz = player.z - n.z, d2 = dx * dx + dz * dz;
      n.root.visible = d2 < 60 * 60;
      if (!n.root.visible) continue;
      const near = d2 < NOTICE_RANGE * NOTICE_RANGE;
      n.line.visible = near;
      const want = near ? Math.atan2(dx, dz) : n.home;
      n.yaw += Math.atan2(Math.sin(want - n.yaw), Math.cos(want - n.yaw)) * Math.min(1, dt * 6);
      n.body.rotation.y = n.yaw;
      n.mixer.update(dt);
    }
  }

  return { update };
}
