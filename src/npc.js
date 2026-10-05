import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { TOWN_R, BLACKSMITH, SAGE } from './shared.js';

// Townsfolk: models from the KayKit "Character Pack: Adventurers" (CC0, Kay Lousberg).
// They stand in place, play idle animations, turn to face a nearby player and say a line.
// Every model carries all of its gear at once; `gear` lists the pieces left visible.

const DIR = './assets/adventurers/';
const SCALE = 1.15;
const NOTICE_RANGE = 7;

const KINDS = {
  guard: { model: 'Knight', gear: ['1H_Sword', 'Badge_Shield'], clip: 'Idle', name: 'Town Guard', line: 'Stay close to the walls, traveller.' },
  blacksmith: { model: 'Barbarian', gear: ['1H_Axe'], clip: 'Idle', name: 'Blacksmith', line: 'Need a sharper blade? Press B.' },
  sage: { model: 'Mage', gear: ['2H_Staff'], clip: 'Idle', name: 'Sage', line: 'Press K — I teach skills and professions.' },
  trader: { model: 'Rogue_Hooded', gear: [], clip: 'Idle', name: 'Trader', line: 'Gold talks. Bring more of it.' },
};
const GEAR = /^(1H_|2H_|Knife|Throwable|Mug|Spellbook|.*_Shield)/;

// [kind, x, z, yaw]; guards stand in pairs just inside each gate, facing the plaza
const SPOTS = [
  ['blacksmith', BLACKSMITH.x, BLACKSMITH.z, Math.atan2(-BLACKSMITH.x, -BLACKSMITH.z)],
  ['trader', 4.8, 11.5, Math.atan2(-4.8, -11.5)],
  ['sage', SAGE.x, SAGE.z, Math.atan2(-SAGE.x, -SAGE.z)],
];
for (let i = 0; i < 4; i++) {
  const a = i * Math.PI / 2, r = TOWN_R - 1.8;
  for (const side of [-3.4, 3.4]) {
    const x = Math.cos(a) * r - Math.sin(a) * side, z = Math.sin(a) * r + Math.cos(a) * side;
    SPOTS.push(['guard', x, z, Math.atan2(-Math.cos(a), -Math.sin(a))]);
  }
}

// `label(text, color, height)` builds a text sprite; `block(x, z, r)` registers an obstacle.
export async function createNpcs(scene, label, block) {
  const loader = new GLTFLoader();
  const models = {};
  await Promise.all([...new Set(Object.values(KINDS).map((k) => k.model))].map(async (name) => {
    models[name] = await loader.loadAsync(`${DIR}${name}.glb`);
  }));

  const npcs = SPOTS.map(([kind, x, z, yaw]) => {
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
    body.rotation.y = yaw;
    body.add(model);
    root.add(body);
    root.position.set(x, 0, z);

    const title = label(def.name, '#ffe9a6', 0.42);
    title.position.y = 3.1;
    const line = label(def.line, '#ffffff', 0.36);
    line.position.y = 3.6;
    line.visible = false;
    root.add(title, line);
    scene.add(root);
    block(x, z, 0.55);

    const mixer = new THREE.AnimationMixer(model);
    mixer.clipAction(THREE.AnimationClip.findByName(src.animations, def.clip)).play();
    mixer.update(Math.random() * 2);
    return { root, body, line, mixer, x, z, yaw, home: yaw };
  });

  function update(dt, player) {
    for (const n of npcs) {
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
