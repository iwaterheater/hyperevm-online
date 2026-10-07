import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// The cat, its weapons and its armour are modelled in Blender (art/hypercat.blend) and exported as one file.
// The model is made of rigid parts hung on pivots - head, body, two arms, two legs, tail - and it is animated here,
// in code, by turning those pivots: running, jumping, three sword swings, casting, shooting, sitting, blinking.
// Weapons are separate objects with their origin at the grip, so any of them can be put into a paw; each piece of
// armour is a separate object too, shown or hidden on its own.

const MODEL_URL = './assets/cat/hypercat.glb';
const SCALE = 1.45;                 // model units -> game units: the cat stands about 2.5 units tall
const HOODIE = 0x35523f;
const OUTLINE = 0x0c1a17;
const PAW = 0.365;                  // from the shoulder down the arm to the middle of the paw, model units
// what leaves the shoulder: the direction the arm was modelled in (x is mirrored for the left arm)
const ARM_DIR = new THREE.Vector3(0.52, -0.85, 0.06).normalize();
// the soft, closed shapes that get a dark contour
const OUTLINED = /^(Head|Body|Hem|Hood|Collar|Sleeve|Cuff|Paw|Leg|Foot|Ear[LR]|Tail)/;
// The pieces of armour, by the names of their objects in the model. Each is shown on its own; its plates (the material
// a_steel) take the colour of the item's tier, its trim and straps stay as modelled.
const PIECES = { helmet: ['ArmorHelmet'], chest: ['ArmorChest'], gloves: ['ArmorGloveL', 'ArmorGloveR'], boots: ['ArmorBootL', 'ArmorBootR'] };

function makeGradientMap() {
  const tex = new THREE.DataTexture(new Uint8Array([105, 185, 255]), 3, 1, THREE.RedFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

// The file is loaded once; every cat is a clone of it that shares its geometry and all materials but those it colours
// for itself: its hoodie, the plates of its armour, and the blade and the glow of a weapon better than the basic one.
let shared = null;
function getShared() {
  if (shared) return shared;
  const gradientMap = makeGradientMap();
  const toon = (color, extra = {}) => new THREE.MeshToonMaterial({ color, gradientMap, ...extra });
  const lit = (color, k = 1) => new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k) });
  const outline = new THREE.MeshBasicMaterial({ color: OUTLINE, side: THREE.BackSide });
  // the contour is the same mesh again, seen from inside and pushed out along its normals
  outline.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', 'vec3 transformed = position + normalize( normal ) * 0.014;');
  };
  // by the name of the material in the Blender file; anything else keeps its colour as a toon material
  const byName = (m) => ({
    cat_eye: () => lit(0x18203a),
    cat_line: () => lit(0x1a1d21),
    cat_teal: () => lit(0x7fe9c9, 1.15),
    w_glow: () => lit(0x7fe9c9, 1.9),          // bright enough to bloom
    w_string: () => lit(0xefe8d6),
    cat_head: () => toon(0xffffff, { map: m.map }),
  }[m.name]?.() ?? toon(m.color.getHex()));
  shared = {
    toon, outline, mats: new Map(),
    ready: new GLTFLoader().loadAsync(MODEL_URL).then((gltf) => {
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        for (const m of [o.material].flat()) if (!shared.mats.has(m.name)) shared.mats.set(m.name, byName(m));
      });
      return gltf.scene;
    }),
  };
  shared.ready.catch((e) => console.error('[cat] the model did not load', e));
  return shared;
}

// -> { group, update(dt, state), setLook({ hoodie, weapon, armor, weaponTint }) }. The group is there at once, standing
// on its origin and facing +Z; the model appears in it when the file has arrived.
export function createCat({ hoodie = HOODIE, weapon = 'sword', armor = null, weaponTint = null } = {}) {
  const S = getShared();
  const group = new THREE.Group();   // origin at the feet, facing +Z
  const inner = new THREE.Group();   // bob / lean
  group.add(inner);
  // Materials of this cat alone. Those of the armour and the weapon are made when first needed: most cats wear nothing.
  const own = { hoodie: S.toon(hoodie), trim: S.toon(new THREE.Color(hoodie).multiplyScalar(0.62)), plates: {}, blade: null, glow: null };
  let look = { hoodie, weapon, armor, weaponTint };
  let rig = null;                    // the pivots, once the model is in

  S.ready.then((scene) => {
    // the parent of the pivots (the file's scene carries the same name as the cat's root, so it is not looked up by name)
    const model = scene.getObjectByName('PHead').parent.clone(true);
    model.scale.setScalar(SCALE);
    const meshes = [];
    model.traverse((o) => { if (o.isMesh) meshes.push(o); });   // listed first: the contours added below are meshes too
    for (const o of meshes) {
      const swap = (m) => (m.name === 'cat_hoodie' ? own.hoodie : m.name === 'cat_hoodie_trim' ? own.trim : S.mats.get(m.name));
      o.userData.mat = o.material.name;   // the shared materials carry no names: this is how a part is found again
      o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
      o.castShadow = true;
      if (OUTLINED.test(o.name)) o.add(new THREE.Mesh(o.geometry, S.outline));
    }
    const node = (name) => model.getObjectByName(name);
    // An arm was modelled held a little away from the body. Its parts go into a group that turns it straight down, so
    // the animation below can speak of the arm as of something that hangs from the shoulder.
    const arms = [['PArmL', -1], ['PArmR', 1]].map(([name, s]) => {
      const arm = node(name), hang = new THREE.Group();
      hang.quaternion.setFromUnitVectors(new THREE.Vector3(ARM_DIR.x * s, ARM_DIR.y, ARM_DIR.z), new THREE.Vector3(0, -1, 0));
      for (const child of [...arm.children]) hang.add(child);
      arm.add(hang);
      const hand = new THREE.Group();   // what the paw holds; +Z is forward
      hand.position.set(0, -PAW, 0);
      arm.add(hand);
      return Object.assign(arm, { hand });
    });
    const weapons = {};
    for (const name of ['Sword', 'Bow', 'Arrow', 'Staff']) {
      const w = scene.getObjectByName(name).clone(true);
      w.position.set(0, 0, 0); w.rotation.set(0, 0, 0); w.scale.setScalar(1);
      w.traverse((o) => { if (o.isMesh) { o.userData.mat = o.material.name; o.material = S.mats.get(o.material.name); o.castShadow = true; } });
      weapons[name] = w;
    }
    // each piece of armour: the objects to show and hide, and those of their meshes that are plates
    const pieces = {};
    for (const [piece, names] of Object.entries(PIECES)) {
      const nodes = names.map(node).filter(Boolean), plates = [];
      for (const n of nodes) n.traverse((o) => { if (o.isMesh && o.userData.mat === 'a_steel') plates.push(o); });
      pieces[piece] = { nodes, plates };
    }
    rig = { model, arms, weapons, pieces, head: node('PHead'), legs: [node('PLegL'), node('PLegR')], tail: node('PTail'), eyes: [node('EyeL'), node('EyeR')], gear: [] };
    inner.add(model);
    setLook(look);
  }, () => {});

  // ---- what the cat holds depends on its class. Everything points forward along the paw's +Z.
  const GEAR = {
    sword() { blade(1, 1); },
    shield() {
      blade(1, 1);
      const g = hold(0), disc = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 0.04, 18), S.mats.get('a_steel') ?? S.toon(0x8e9bb0));
      disc.rotation.x = Math.PI / 2; disc.position.set(0, 0.08, 0.11);
      const boss = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 8), S.mats.get('w_gold') ?? S.toon(0xf2c14e));
      boss.position.set(0, 0.08, 0.14);
      g.add(disc, boss);
    },
    daggers() { blade(1, 0.55); blade(0, 0.55); },
    bow() {
      const g = hold(0), bow = rig.weapons.Bow.clone(true);
      bow.position.set(0, 0, 0.07);
      g.add(bow);
    },
    staff() {
      const g = hold(1), staff = rig.weapons.Staff.clone(true);
      staff.position.set(0, 0.2, 0.08);   // held a little below the middle, so its foot is near the ground
      g.add(staff);
    },
  };
  function hold(i) { const g = new THREE.Group(); rig.arms[i].hand.add(g); rig.gear.push(g); return g; }
  function blade(i, size) {
    const sword = rig.weapons.Sword.clone(true);
    sword.rotation.x = Math.PI / 2;      // modelled point up: turned to point forward out of the paw
    sword.scale.setScalar(size);
    hold(i).add(sword);
  }

  // Recolours the hoodie and swaps what is held and worn, e.g. when the character changes class or its equipment.
  //   armor: { helmet, chest, gloves, boots } - for each piece the colour of its plates (a number), or nothing to hide it;
  //          `true` shows the piece in the steel it was modelled in
  //   weaponTint: the colour of the blade and of the glow of what is held; nothing leaves the weapon as modelled
  function setLook({ hoodie: color = HOODIE, weapon: held = 'sword', armor: worn = null, weaponTint: tint = null } = {}) {
    look = { hoodie: color, weapon: held, armor: worn, weaponTint: tint };
    own.hoodie.color.set(color);
    own.trim.color.set(color).multiplyScalar(0.62);
    if (!rig) return;
    for (const g of rig.gear) g.removeFromParent();
    rig.gear.length = 0;
    (GEAR[held] || GEAR.sword)();
    if (typeof tint === 'number') {
      // this cat's own blade and glow: a shared material tinted here would recolour the weapon of every cat
      own.blade ??= S.toon(tint);
      own.glow ??= new THREE.MeshBasicMaterial();
      own.blade.color.set(tint);
      own.glow.color.set(tint).multiplyScalar(1.9);   // as bright as the modelled glow, so it blooms too
      const mine = { w_steel: own.blade, w_glow: own.glow };
      for (const g of rig.gear) g.traverse((o) => { if (o.isMesh && mine[o.userData.mat]) o.material = mine[o.userData.mat]; });
    }
    for (const [piece, { nodes, plates }] of Object.entries(rig.pieces)) {
      const value = worn?.[piece], on = !!value || value === 0;   // 0 is a colour too: black
      for (const o of nodes) o.visible = on;
      if (!on) continue;
      const plain = typeof value !== 'number';
      if (!plain) (own.plates[piece] ??= S.toon(value)).color.set(value);
      for (const o of plates) o.material = plain ? S.mats.get('a_steel') : own.plates[piece];
    }
  }

  let t = 0, runPhase = 0, blink = 2, move = 0, air = 0, shoot = 0, cast = 0, sit = 0;

  function update(dt, { speed = 0, airborne = false, shooting = false, dashing = false, casting = false, sitting = false, swing: slash = -1, swingKind: slashKind = 2 } = {}) {
    t += dt;
    const k = Math.min(1, dt * 12);
    move += (Math.min(1, speed / 9) - move) * k;
    air += ((airborne ? 1 : 0) - air) * k;
    shoot += ((shooting ? 1 : 0) - shoot) * Math.min(1, dt * 20);
    cast += ((casting ? 1 : 0) - cast) * Math.min(1, dt * 14);
    sit += ((sitting ? 1 : 0) - sit) * Math.min(1, dt * 7);
    runPhase += dt * (6 + speed * 1.1);
    if (!rig) return;
    const { arms, legs, head, tail, eyes } = rig;

    const swing = Math.sin(runPhase) * 0.95 * move * (1 - air);
    legs[0].rotation.x = swing + air * 0.5;
    legs[1].rotation.x = -swing - air * 0.35;
    arms[0].rotation.x = -swing * 0.8;
    arms[0].rotation.z = -0.35 - air * 0.9;
    // right arm points forward while firing
    arms[1].rotation.x = swing * 0.8 * (1 - shoot) - 1.5 * shoot;
    arms[1].rotation.z = (0.35 + air * 0.9) * (1 - shoot);
    // casting: both paws held out in front, cupping the charging bolt
    if (cast > 0.01) {
      const tremble = Math.sin(t * 40) * 0.04 * cast;
      for (const [i, s] of [[0, 1], [1, -1]]) {
        arms[i].rotation.x += (-1.4 + tremble - arms[i].rotation.x) * cast;
        arms[i].rotation.z += (s * 0.35 - arms[i].rotation.z) * cast;
      }
    }

    inner.position.y = Math.abs(Math.sin(runPhase)) * 0.09 * move * (1 - air) + Math.sin(t * 2.2) * 0.012;
    // sword swing (0..1). Kinds: 0 = left to right, 1 = right to left, 2 = overhead chop.
    arms[1].rotation.y = 0;
    inner.rotation.y = 0;
    if (slash >= 0) {
      const mix = (a, b, f) => a + (b - a) * f;
      if (slashKind === 2) {
        arms[1].rotation.x = slash < 0.3 ? mix(-1.0, -2.8, slash / 0.3)
          : slash < 0.6 ? mix(-2.8, -0.3, (slash - 0.3) / 0.3)
          : mix(-0.3, arms[1].rotation.x, (slash - 0.6) / 0.4);
        arms[1].rotation.z = 0.12;
        inner.rotation.y = Math.sin(slash * Math.PI) * -0.25;
      } else {
        // wind up to one side, sweep the blade across to the other, then recover
        const dir = slashKind === 1 ? -1 : 1;
        const sweep = slash < 0.2 ? mix(0, -1, slash / 0.2) : slash < 0.55 ? mix(-1, 1, (slash - 0.2) / 0.35) : mix(1, 0, (slash - 0.55) / 0.45);
        const grip = slash < 0.2 ? slash / 0.2 : slash < 0.55 ? 1 : 1 - (slash - 0.55) / 0.45;
        arms[1].rotation.x = mix(arms[1].rotation.x, -0.55, grip);
        arms[1].rotation.z = mix(arms[1].rotation.z, 0.1, grip);
        arms[1].rotation.y = sweep * dir * 1.1;
        inner.rotation.y = sweep * dir * 0.9;
      }
    }
    inner.rotation.x = move * 0.16 + (dashing ? 0.55 : 0) - cast * 0.1;
    // resting: drop to the ground with the legs stretched out in front and the paws on the knees
    if (sit > 0.01) {
      inner.position.y -= 0.3 * sit;
      inner.rotation.x -= 0.12 * sit;
      for (const leg of legs) leg.rotation.x += (-1.45 - leg.rotation.x) * sit;
      for (const arm of arms) arm.rotation.x += (-0.5 - arm.rotation.x) * sit;
    }
    head.rotation.z = Math.sin(t * 1.3) * 0.04;
    head.rotation.x = -move * 0.1 + Math.sin(t * 1.7) * 0.02;

    // the tail is one piece: it wags from its root, faster on the run, and bobs a little
    tail.rotation.y = Math.sin(t * (3 + move * 5)) * (0.16 + move * 0.12);
    tail.rotation.x = Math.sin(t * 2) * 0.05 - move * 0.12;

    blink -= dt;
    if (blink < -0.12) blink = 1.5 + Math.random() * 3;
    eyes[0].scale.y = eyes[1].scale.y = blink < 0 ? 0.12 : 1;
  }

  return { group, update, setLook };
}
