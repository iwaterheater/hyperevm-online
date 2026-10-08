import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// The cat, its weapons and its armour are modelled in Blender (art/hypercat.blend) and exported as one file.
// The model is made of rigid parts hung on pivots - head, body, two arms, two legs, tail - and it is animated here,
// in code, by turning those pivots: running, jumping, three sword swings, casting, shooting, sitting, blinking.
// Weapons are separate objects with their origin at the grip, so any of them can be put into a paw; each piece of
// armour is a separate object too, shown or hidden on its own. The shield is the one piece built here, in code.

const MODEL_URL = './assets/cat/hypercat.glb';
const SCALE = 1.45;                 // model units -> game units: the cat stands about 2.5 units tall
const HOODIE = 0x35523f;
const OUTLINE = 0x0c1a17;
const PAW = 0.365;                  // from the shoulder down the arm to the middle of the paw, model units
// the bow, in model units: how far above and below the grip the string is tied, how far behind the grip it runs,
// how far a full draw pulls it back, and from the middle of the arrow to its nock
const BOW_TIP = 0.655, BOW_STRING = 0.16, BOW_PULL = 0.42, ARROW_NOCK = 0.38;
// The archer's stance, in the frame of the body (model units, the cat facing +Z, the bow in the paw on -X): how far
// the body turns away, where the bow arm points, where its paw then is, the way from there back to the body, the
// shoulder of the string paw, where that paw hangs and where it finds the quiver.
const STANCE = Math.PI / 2;
const DOWN = new THREE.Vector3(0, -1, 0), UP = new THREE.Vector3(0, 1, 0), TO_BODY = new THREE.Vector3(1, 0, 0);
const BOW_ARM = new THREE.Vector3(-Math.cos(0.12), Math.sin(0.12), 0);
const GRIP = new THREE.Vector3(-0.255, 0.72, 0).addScaledVector(BOW_ARM, PAW);
const SHOULDER = new THREE.Vector3(0.255, 0.72, 0), HANG = new THREE.Vector3(0.36, 0.38, 0), QUIVER = new THREE.Vector3(0.32, 1.04, -0.24);
const V1 = new THREE.Vector3(), V2 = new THREE.Vector3(), Q1 = new THREE.Quaternion();
// The shield on the off paw, in the frame of the body: where its middle is from the paw (out to the side, up, in
// front) and how it faces - forward, turned a little outwards and leaning back; and how far that paw is held up for it.
const SHIELD_AT = new THREE.Vector3(-0.05, 0.03, 0.085), SHIELD_FACING = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.14, -0.3, 0, 'YXZ'));
const SHIELD_ARM = -0.7;
// The staff, in the frame of the body. Standing, the cat holds it out to the side, planted on the ground: how far the
// paw is raised for that. Walking, it carries it level at its hip, the crystal ahead. For a spell the crystal is put
// forward at the target, and thrust out as the spell leaves. For a blow it is swung like a club: that one is told in
// the frame of the paw, as a blade is.
const STAFF_ARM = 1.2;
const AXIS_X = new THREE.Vector3(1, 0, 0), turnX = (a) => new THREE.Quaternion().setFromAxisAngle(AXIS_X, a);
const STAFF_LEVEL = turnX(Math.PI / 2 - 0.14), STAFF_CAST = turnX(0.95), STAFF_THRUST = turnX(1.3), STAFF_STRIKE = turnX(Math.PI / 2 - 0.5);
const Q2 = new THREE.Quaternion(), Q3 = new THREE.Quaternion();
const mix = (a, b, f) => a + (b - a) * f;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
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

// A heater shield, facing +Z with its middle at the origin: a dark rim, a domed face that takes the colour of the
// tier, and a boss. Three small geometries, built once and shared by every cat that carries one.
function makeShieldParts() {
  const outline = (k) => {
    const w = 0.215 * k, top = 0.225 * k, tip = -0.31 * k, s = new THREE.Shape();
    s.moveTo(-w, top);
    s.quadraticCurveTo(0, top + 0.045 * k, w, top);                    // the upper edge, arched a little
    s.lineTo(w, 0.02 * k);
    s.bezierCurveTo(w, -0.15 * k, 0.11 * k, -0.25 * k, 0, tip);        // the sides run down and in to the point
    s.bezierCurveTo(-0.11 * k, -0.25 * k, -w, -0.15 * k, -w, 0.02 * k);
    s.closePath();
    return s;
  };
  const plate = (k, depth, bevel) => new THREE.ExtrudeGeometry(outline(k), { depth, curveSegments: 6, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2 });
  const face = plate(0.8, 0.012, 0.022);
  face.translate(0, 0, 0.022);
  const boss = new THREE.SphereGeometry(0.058, 12, 8);
  boss.scale(1, 1, 0.6);
  boss.translate(0, 0.01, 0.062);
  return { rim: plate(1, 0.024, 0.008), face, boss };
}

// The file is loaded once; every cat is a clone of it that shares its geometry and all materials but those it colours
// for itself: its hoodie, the plates of its armour, its shield, and the blade and the glow of a weapon better than
// the basic one.
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
    toon, outline, mats: new Map(), shieldParts: null,
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

// The beats of a sword swing, as shares of its length: the wind-up ends at SWING_WINDUP, the blade has gone through
// by SWING_HIT, the rest is the recovery. swingTime() is how long a swing lasts for a given pause between attacks.
export const SWING_WINDUP = 0.34, SWING_HIT = 0.6;
export const swingTime = (atkCd) => Math.min(0.8, Math.max(0.34, atkCd * 0.92));

// -> a promise of the model file, for whoever wants to wait for it (the loading screen); it rejects when it is missing
export function loadCat() {
  return getShared().ready;
}

// -> { group, update(dt, state), setLook({ hoodie, weapon, armor, weaponTint, shield }), castPoint(out) }. The group is there at once,
// standing on its origin and facing +Z; the model appears in it when the file has arrived.
export function createCat({ hoodie = HOODIE, weapon = 'sword', armor = null, weaponTint = null, shield = null } = {}) {
  const S = getShared();
  const group = new THREE.Group();   // origin at the feet, facing +Z
  const inner = new THREE.Group();   // bob / lean
  group.add(inner);
  // Materials of this cat alone. Those of the armour and the weapon are made when first needed: most cats wear nothing.
  const own = { hoodie: S.toon(hoodie), trim: S.toon(new THREE.Color(hoodie).multiplyScalar(0.62)), plates: {}, blade: null, glow: null, shield: null, shieldRim: null };
  let look = { hoodie, weapon, armor, weaponTint, shield };
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
    // the staff from its foot to its top, along its own length
    weapons.Staff.updateMatrixWorld(true);
    const span = new THREE.Box3().setFromObject(weapons.Staff);
    // each piece of armour: the objects to show and hide, and those of their meshes that are plates
    const pieces = {};
    for (const [piece, names] of Object.entries(PIECES)) {
      const nodes = names.map(node).filter(Boolean), plates = [];
      for (const n of nodes) n.traverse((o) => { if (o.isMesh && o.userData.mat === 'a_steel') plates.push(o); });
      pieces[piece] = { nodes, plates };
    }
    rig = { model, arms, weapons, pieces, head: node('PHead'), legs: [node('PLegL'), node('PLegR')], tail: node('PTail'), eyes: [node('EyeL'), node('EyeR')], gear: [], staffSpan: [span.min.y, span.max.y] };
    inner.add(model);
    setLook(look);
  }, () => {});

  // ---- what the cat holds: the weapon in paw 1 (the bow and the second dagger in paw 0), a shield on paw 0.
  // Everything points forward along the paw's +Z.
  const GEAR = {
    sword() { blade(1, 1); },
    greatsword() { blade(1, 1.3, 1.5, 0.8); },   // the same sword, half as long again and broader, carried point up
    daggers() { blade(1, 0.55); blade(0, 0.55); },
    bow() {
      const g = hold(0), bow = rig.weapons.Bow.clone(true);
      bow.position.set(0, 0, 0.07);
      g.add(bow);
      // The modelled string is straight. It gives way to one that bends at the nock, and an arrow lies on the bow
      // while it is drawn (see update).
      const stringMat = S.mats.get('w_string');
      bow.traverse((o) => { if (o.isMesh && o.material === stringMat) o.visible = false; });
      const string = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, BOW_TIP, -BOW_STRING), new THREE.Vector3(0, 0, -BOW_STRING), new THREE.Vector3(0, -BOW_TIP, -BOW_STRING)]),
        new THREE.LineBasicMaterial({ color: 0xefe8d6 }));
      const arrow = rig.weapons.Arrow.clone(true);
      arrow.rotation.x = Math.PI / 2;      // modelled point up: laid along the shot
      arrow.visible = false;
      bow.add(string, arrow);
      // the same arrow in the other paw, on its way from the quiver to the bow
      const inPaw = rig.weapons.Arrow.clone(true);
      inPaw.rotation.x = Math.PI / 2;
      inPaw.position.set(0, 0, 0.2);
      inPaw.visible = false;
      hold(1).add(inPaw);
      // the quiver on the back, leaning towards the shoulder the paw reaches over
      const quiver = new THREE.Group(), leather = S.mats.get('w_leather'), feather = S.mats.get('w_glow'), gold = S.mats.get('w_gold');
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.06, 0.44, 12), leather);
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.082, 0.082, 0.04, 12), gold);
      rim.position.y = 0.21;
      quiver.add(tube, rim);
      for (const [x, z, h] of [[-0.03, 0.02, 0.3], [0.03, 0.025, 0.33], [0, -0.03, 0.28]]) {
        const fletch = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.11, 0.008), feather);
        fletch.position.set(x, h, z);
        fletch.rotation.y = x * 20;
        quiver.add(fletch);
      }
      quiver.position.set(0.1, 0.62, -0.29);
      quiver.rotation.set(-0.12, 0, -0.5);
      quiver.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      rig.model.getObjectByName('PBody').add(quiver);
      rig.gear.push(quiver);
      rig.bow = { bow, string, arrow, inPaw };
    },
    staff() {   // how it is held changes with what the cat does: see update
      const g = hold(1), staff = rig.weapons.Staff.clone(true), tip = new THREE.Object3D();
      tip.position.y = rig.staffSpan[1] - 0.2;   // the crystal in its cage
      staff.add(tip);
      g.add(staff);
      rig.staff = { g, staff, tip };
    },
  };
  function hold(i) { const g = new THREE.Group(); rig.arms[i].hand.add(g); rig.gear.push(g); return g; }
  // lift: how far the point is raised from straight ahead - a blade as long as the cat, held level, reads as a lance
  function blade(i, size, length = size, lift = 0) {
    const sword = rig.weapons.Sword.clone(true);
    sword.rotation.x = Math.PI / 2 - lift;   // modelled point up: turned to point forward out of the paw
    sword.scale.set(size, length, size);
    hold(i).add(sword);
  }
  // The shield on the off paw, its face in `tint`. It is kept upright by update(), whatever the paw does.
  function carryShield(tint) {
    const parts = (S.shieldParts ??= makeShieldParts()), g = hold(0);
    own.shield ??= S.toon(tint);
    own.shieldRim ??= S.toon(tint);
    own.shield.color.set(tint);
    own.shieldRim.color.set(tint).multiplyScalar(0.42);
    for (const [geo, mat] of [[parts.rim, own.shieldRim], [parts.face, own.shield], [parts.boss, S.mats.get('w_gold') ?? S.toon(0xf2c14e)]]) {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      g.add(mesh);
    }
    g.name = 'Shield';
    rig.shield = g;
  }

  // Recolours the hoodie and swaps what is held and worn, e.g. when the character changes class or its equipment.
  //   armor: { helmet, chest, gloves, boots } - for each piece the colour of its plates (a number), or nothing to hide it;
  //          `true` shows the piece in the steel it was modelled in
  //   weaponTint: the colour of the blade and of the glow of what is held; nothing leaves the weapon as modelled
  //   shield: the colour of the shield on the off paw (a number); nothing for no shield. The caller sees to it that a
  //          shield never comes with a weapon that needs that paw
  function setLook({ hoodie: color = HOODIE, weapon: held = 'sword', armor: worn = null, weaponTint: tint = null, shield: guard = null } = {}) {
    look = { hoodie: color, weapon: held, armor: worn, weaponTint: tint, shield: guard };
    own.hoodie.color.set(color);
    own.trim.color.set(color).multiplyScalar(0.62);
    if (!rig) return;
    for (const g of rig.gear) g.removeFromParent();
    rig.gear.length = 0;
    rig.bow?.string.geometry.dispose();
    rig.bow = rig.shield = rig.staff = null;
    (GEAR[held] || GEAR.sword)();
    if (typeof guard === 'number') carryShield(guard);
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

  let t = 0, runPhase = 0, blink = 2, move = 0, air = 0, shoot = 0, cast = 0, sit = 0, aim = 0, strike = 0;

  // hurt: 1 at the moment the cat is hit, falling to 0 over the next half second.
  // draw: how far the bow is drawn, 0..1; below 0 = not drawing. shooting: the moment after the arrow has left.
  function update(dt, { speed = 0, airborne = false, shooting = false, dashing = false, casting = false, sitting = false, hurt = 0, draw = -1, swing: slash = -1, swingKind: slashKind = 2 } = {}) {
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
    arms[0].rotation.y = 0;   // the archer's stance below turns this paw freely: start every frame from the plain pose
    arms[0].rotation.z = -0.35 - air * 0.9;
    // right arm points forward while firing
    arms[1].rotation.x = swing * 0.8 * (1 - shoot) - 1.5 * shoot;
    arms[1].rotation.z = (0.35 + air * 0.9) * (1 - shoot);
    // a shield is carried, not swung: the off paw holds it up in front and only rocks a little on the run
    if (rig.shield) {
      arms[0].rotation.x = SHIELD_ARM - swing * 0.2;
      arms[0].rotation.z = -0.22 - air * 0.5;
    }
    // A staff is carried, not swung. Standing, the paw is out to the side with the staff planted beside the cat; on
    // the move - and in the air - it hangs, and the staff lies level in it.
    const carry = rig.staff ? Math.max(smooth(0.06, 0.55, move), air) : 0;
    if (rig.staff) {
      arms[1].rotation.x = mix(-0.12, swing * 0.2 - 0.05, carry) * (1 - shoot) - 1.1 * shoot;
      arms[1].rotation.z = mix(STAFF_ARM, 0.34, carry) + air * 0.4;
    }
    // casting: both paws held out in front, cupping the charging bolt - or the one with the staff putting its crystal forward
    if (cast > 0.01) {
      const tremble = Math.sin(t * 40) * 0.04 * cast;
      for (const [i, s] of [[0, 1], [1, -1]]) {
        const withStaff = i === 1 && rig.staff;
        arms[i].rotation.x += ((withStaff ? -1.0 : -1.4) + tremble - arms[i].rotation.x) * cast;
        arms[i].rotation.z += ((withStaff ? 0.2 : s * 0.35) - arms[i].rotation.z) * cast;
      }
    }

    inner.position.y = Math.abs(Math.sin(runPhase)) * 0.09 * move * (1 - air) + Math.sin(t * 2.2) * 0.012;
    // sword swing (0..1). Kinds: 0 = left to right, 1 = right to left, 2 = overhead chop.
    arms[1].rotation.y = 0;
    inner.rotation.y = 0;
    if (slash >= 0) {
      // A swing has three beats: the blade is drawn back and slows at the top, so the wind-up can be read; it comes
      // down gathering speed; and the arm eases back. The wind-up takes the first SWING_WINDUP of it.
      const rise = (f) => 1 - (1 - f) * (1 - f), fall = (f) => f * f, settle = (f) => f * f * (3 - 2 * f);
      const W = SWING_WINDUP, H = SWING_HIT;
      if (slashKind === 2) {
        arms[1].rotation.x = slash < W ? mix(-1.0, -2.8, rise(slash / W))
          : slash < H ? mix(-2.8, -0.3, fall((slash - W) / (H - W)))
          : mix(-0.3, arms[1].rotation.x, settle((slash - H) / (1 - H)));
        arms[1].rotation.z = 0.12;
        inner.rotation.y = Math.sin(slash * Math.PI) * -0.25;
      } else {
        // wind up to one side, sweep the blade across to the other, then recover
        const dir = slashKind === 1 ? -1 : 1;
        const sweep = slash < W ? mix(0, -1, rise(slash / W)) : slash < H ? mix(-1, 1, fall((slash - W) / (H - W))) : mix(1, 0, settle((slash - H) / (1 - H)));
        const grip = slash < W ? rise(slash / W) : slash < H ? 1 : 1 - settle((slash - H) / (1 - H));
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

    // The bow. The cat stands side-on to its target, as an archer does: the paw with the bow straight out at it, the
    // head turned to look along the arrow. The other paw goes over the shoulder to the quiver, comes back with an
    // arrow, lays it on the bow and pulls the string to the cheek. `draw` runs through all of that, 0..1; for a
    // moment after the arrow has left (shoot) the stance is held.
    aim += ((draw >= 0 ? 1 : 0) - aim) * Math.min(1, dt * 14);
    head.rotation.y = 0;
    if (rig.bow) {
      const { bow, string, arrow, inPaw } = rig.bow;
      const p = draw >= 0 ? Math.min(1, draw) : 0, stance = Math.max(aim, shoot);
      const reach = smooth(0, 0.2, p), toBow = smooth(0.24, 0.45, p), pull = draw >= 0 ? smooth(0.5, 1, p) : 0;
      if (stance > 0.01) {
        inner.rotation.y += STANCE * stance;
        head.rotation.y = -STANCE * 0.9 * stance;
        arms[0].quaternion.slerp(Q1.setFromUnitVectors(DOWN, BOW_ARM), stance);
        // where the string paw wants to be: hanging -> at the quiver -> at the nock, which then moves back with the string
        const back = draw >= 0 ? pull : 1;                       // just loosed: still at the cheek
        V1.copy(GRIP).addScaledVector(TO_BODY, BOW_STRING + BOW_PULL * back);
        V2.copy(HANG).lerp(QUIVER, draw >= 0 ? reach : 0).lerp(V1, draw >= 0 ? toBow : 1).sub(SHOULDER).normalize();
        arms[1].quaternion.slerp(Q1.setFromUnitVectors(DOWN, V2), stance);
      }
      // upright whatever the paw does, and turned with the stance so that its belly faces the target
      bow.quaternion.copy(arms[0].quaternion).invert().multiply(Q1.setFromAxisAngle(UP, -STANCE * stance));
      const nock = -BOW_STRING - BOW_PULL * pull, at = string.geometry.attributes.position;
      if (at.getZ(1) !== nock) { at.setZ(1, nock); at.needsUpdate = true; }
      arrow.visible = draw >= 0 && toBow >= 1;                    // on the bow once it is nocked
      arrow.position.z = nock + ARROW_NOCK;
      inPaw.visible = draw >= 0 && reach > 0.8 && toBow < 1;      // in the paw on the way from the quiver
    }

    blink -= dt;
    if (blink < -0.12) blink = 1.5 + Math.random() * 3;
    eyes[0].scale.y = eyes[1].scale.y = blink < 0 ? 0.12 : 1;

    // A hit: the cat flinches - knocked back on its heels and squashed, paws thrown out, head jerked back, eyes
    // screwed shut - and springs back. It stays in sight the whole time.
    const h = Math.min(1, Math.max(0, hurt)), jolt = h * h * (3 - 2 * h);
    inner.scale.set(1 + 0.1 * jolt, 1 - 0.14 * jolt, 1 + 0.1 * jolt);
    inner.position.z = -0.22 * jolt;
    if (h > 0) {
      inner.rotation.x -= 0.42 * jolt;
      head.rotation.x -= 0.3 * jolt;
      head.rotation.z += Math.sin(t * 55) * 0.07 * h;            // a shiver that dies away
      arms[0].rotation.z -= 0.75 * jolt;
      arms[1].rotation.z += 0.75 * jolt;
      if (h > 0.3) eyes[0].scale.y = eyes[1].scale.y = 0.14;
    }

    // The staff, whatever its paw has just been told to do: upright on the ground, level on the move, crystal first
    // for a spell, and with the paw for a blow. It slides through the paw so that the right part of it is held: the
    // height of the paw above the ground when it is planted, its middle when it is carried.
    strike += ((slash >= 0 && rig.staff ? 1 : 0) - strike) * Math.min(1, dt * 18);
    if (rig.staff) {
      const { g, staff } = rig.staff, [foot, top] = rig.staffSpan, arm = arms[1], length = top - foot;
      const level = carry * (1 - sit), spell = Math.max(cast, shoot);
      Q2.identity().slerp(STAFF_LEVEL, level);
      Q2.slerp(Q3.copy(STAFF_CAST).slerp(STAFF_THRUST, shoot), spell);
      Q2.slerp(Q3.copy(arm.quaternion).multiply(STAFF_STRIKE), strike);
      g.quaternion.copy(arm.quaternion).invert().multiply(Q2);
      const pawUp = arm.position.y + V1.set(0, -PAW, 0).applyQuaternion(arm.quaternion).y + inner.position.y / SCALE;   // above the ground, model units
      let grip = Math.min(top - 0.3, Math.max(foot + 0.2, foot + pawUp));
      grip = mix(grip, (foot + top) / 2 - 0.1, level);
      grip = mix(grip, foot + length * 0.36, spell);
      grip = mix(grip, foot + length * 0.28, strike);
      const planted = (1 - level) * (1 - spell) * (1 - strike);   // then it stands a little outside the paw, clear of the head
      staff.position.set(0.1 * planted + 0.06 * level, -grip, 0.05 * planted);
    }

    // the shield stays upright and faces ahead whatever its paw has just been told to do
    if (rig.shield) {
      Q1.copy(arms[0].quaternion).invert();
      rig.shield.quaternion.copy(Q1).multiply(SHIELD_FACING);
      rig.shield.position.copy(SHIELD_AT).applyQuaternion(Q1);
    }
  }

  // Where a spell gathers and leaves from, in the frame of `group`: the crystal of the staff. -> false, and `out` as it
  // was, for a cat that holds none.
  function castPoint(out) {
    if (!rig?.staff) return false;
    rig.staff.tip.getWorldPosition(out);
    group.worldToLocal(out);
    return true;
  }

  return { group, update, setLook, castPoint };
}
