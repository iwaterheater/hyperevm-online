import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// The cat, its weapons and its armour are modelled in Blender (art/hypercat.blend) and exported as one file.
// The model is made of rigid parts hung on pivots - head, ears, body, two arms with elbows, two legs with knees, a
// tail of four segments - and it is animated here, in code, by turning those pivots: running, jumping and landing,
// three sword swings, casting, shooting, sitting, stooping for something on the ground, falling and getting up, and
// what a cat does when it has nothing to do.
// Weapons are separate objects with their origin at the grip, so any of them can be put into a paw; each piece of
// armour is a separate object too, shown or hidden on its own. The shield is the one piece built here, in code.

const MODEL_URL = './assets/cat/hypercat.glb';
const SCALE = 1.45;                 // model units -> game units: the cat stands about 2.5 units tall
const HOODIE = 0x35523f;
const OUTLINE = 0x0c1a17;
const PAW = 0.365;                  // from the shoulder down the arm to the middle of the paw, model units
const ELBOW = 0.165, KNEE = 0.13;   // from the shoulder to the elbow, and from the hip to the knee
const LOWER = PAW - ELBOW;          // the forearm
const SHIN = 0.19;                  // from the knee to the sole
// the parts of an arm below its elbow and of a leg below its knee, by the names of their objects in the model
const FOREARM = /^(Fore|Cuff|Paw|ArmorGlove)/, BELOW_KNEE = /^(Shin|Foot|Bean|Pad|ArmorBoot[LR]$)/;
// the bow, in model units: how far above and below the grip the string is tied, how far behind the grip it runs,
// how far a full draw pulls it back, and from the middle of the arrow to its nock
const BOW_TIP = 0.655, BOW_STRING = 0.16, BOW_PULL = 0.42, ARROW_NOCK = 0.38;
// The archer's stance, in the frame of the body (model units). The cat turns side-on, so that its target is on -X.
// A cat's head is far too big to draw a string to its cheek: the arrow lies on a line in front of the chest instead
// (LINE_Y up, LINE_Z ahead), and the draw is a push and a pull - the paw with the bow comes in for the arrow to be laid
// on it (BOW_NEAR) and is pushed out at the target (BOW_FAR) while the other paw takes the string back. The quiver
// hangs at the hip, where a paw can get at it without going through the cat.
const STANCE = Math.PI / 2;
const DOWN = new THREE.Vector3(0, -1, 0), UP = new THREE.Vector3(0, 1, 0);
const LINE_Y = 0.764, LINE_Z = 0.3;
const BOW_NEAR = new THREE.Vector3(-0.108, LINE_Y, LINE_Z), BOW_FAR = new THREE.Vector3(-0.45, LINE_Y, LINE_Z);
const SHOULDERS = [new THREE.Vector3(-0.255, 0.72, 0), new THREE.Vector3(0.255, 0.72, 0)];
const HANG = new THREE.Vector3(0.36, 0.38, 0), QUIVER = new THREE.Vector3(0.37, 0.69, -0.25);
// which way an elbow goes: down and out for the paw with the bow, out and back for the one with the string
const POLE_BOW = new THREE.Vector3(-0.2, -1, 0.3), POLE_STRING = new THREE.Vector3(1, 0.1, -0.5);
const V1 = new THREE.Vector3(), V2 = new THREE.Vector3(), V3 = new THREE.Vector3(), Q1 = new THREE.Quaternion();
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

// A pose of the paw with the weapon, in the frame of the body: the forearm along `f`, the blade - which stands square
// to it, along the paw's +Z - along `d`, the elbow folded by `b`. -> how the upper arm is turned for it (q), and b.
function pawPose(f, d, b) {
  const y = new THREE.Vector3(...f).normalize().negate(), z = new THREE.Vector3(...d);
  z.addScaledVector(y, -z.dot(y)).normalize();
  const paw = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(y, z), y, z));
  return { q: paw.multiply(new THREE.Quaternion().setFromAxisAngle(AXIS_X, b)), b };
}
// The three swings of a blade, each as two poses: wound up, and through. The weapon is in the paw on +X; the cat
// faces +Z. 0 sweeps from that side across the front, 1 comes back the other way, 2 is the chop: the blade is raised
// beside the head - a cat's paw does not reach over it - and brought down in front.
const SWINGS = [
  { wound: pawPose([0.85, -0.3, -0.35], [0.45, 0.15, -0.88], 0.35), thru: pawPose([-0.15, -0.4, 0.9], [-0.85, 0.05, 0.5], 0.05), turn: -1 },
  { wound: pawPose([-0.3, -0.35, 0.88], [-0.8, 0.15, -0.2], 0.5), thru: pawPose([0.75, -0.3, 0.55], [0.8, 0.05, 0.6], 0.05), turn: 1 },
  { wound: pawPose([0.93, 0.3, -0.15], [-0.1, 0.9, -0.42], 0.25), thru: pawPose([0.2, -0.55, 0.8], [0, -0.45, 0.9], 0.05), turn: 0 },
];

// Sinking on its knees by `depth` (model units) with the feet staying where they are: -> how far the thigh comes
// forward at the hip and how far the knee folds.
const FOLD = [0, 0];
function fold(depth) {
  const want = Math.min(0.17, Math.max(0, depth));
  let lo = 0, hi = 1.45;
  for (let i = 0; i < 12; i++) {
    const a = (lo + hi) / 2, g = Math.asin(Math.min(1, KNEE * Math.sin(a) / SHIN));
    if (KNEE * (1 - Math.cos(a)) + SHIN * (1 - Math.cos(g)) < want) lo = a; else hi = a;
  }
  FOLD[0] = (lo + hi) / 2;
  FOLD[1] = FOLD[0] + Math.asin(Math.min(1, KNEE * Math.sin(FOLD[0]) / SHIN));
  return FOLD;
}

// Two bones and a target: how the upper arm must turn (q) and how far the elbow must fold (bend, 0 = straight) for the
// paw to be at `target`, with the elbow on the side of `pole`. All in the frame of the body; a target out of reach is
// pointed at with a straight arm.
const IK = { q: new THREE.Quaternion(), bend: 0 };
const IK_T = new THREE.Vector3(), IK_U = new THREE.Vector3(), IK_F = new THREE.Vector3(), IK_X = new THREE.Vector3(), IK_Y = new THREE.Vector3(), IK_Z = new THREE.Vector3();
const IK_M = new THREE.Matrix4();
function reach(shoulder, target, pole) {
  IK_T.copy(target).sub(shoulder);
  const d = Math.min(ELBOW + LOWER - 1e-4, Math.max(Math.abs(ELBOW - LOWER) + 1e-4, IK_T.length()));
  IK_T.normalize();
  const cosA = (ELBOW * ELBOW + d * d - LOWER * LOWER) / (2 * ELBOW * d), sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  IK_Z.copy(pole).addScaledVector(IK_T, -pole.dot(IK_T));   // the pole, squared off against the line to the target
  if (IK_Z.lengthSq() < 1e-8) IK_Z.set(0, 0, 1).addScaledVector(IK_T, -IK_T.z);
  IK_Z.normalize();
  IK_U.copy(IK_T).multiplyScalar(cosA).addScaledVector(IK_Z, sinA);              // the upper arm
  IK_F.copy(IK_T).multiplyScalar(d).addScaledVector(IK_U, -ELBOW).normalize();   // the forearm
  const cosB = Math.min(1, Math.max(-1, IK_U.dot(IK_F)));
  IK_Z.copy(IK_F).addScaledVector(IK_U, -cosB);             // the way the forearm folds
  if (IK_Z.lengthSq() < 1e-8) { IK.q.setFromUnitVectors(DOWN, IK_U); IK.bend = 0; return IK; }
  IK_Z.normalize();
  IK_Y.copy(IK_U).negate();
  IK_X.crossVectors(IK_Y, IK_Z);
  IK.q.setFromRotationMatrix(IK_M.makeBasis(IK_X, IK_Y, IK_Z));
  IK.bend = Math.acos(cosB);
  return IK;
}
// what leaves the shoulder: the direction the arm was modelled in (x is mirrored for the left arm)
const ARM_DIR = new THREE.Vector3(0.52, -0.85, 0.06).normalize();
// the soft, closed shapes that get a dark contour
const OUTLINED = /^(Head|Body|Hem|Hood|Collar|Sleeve|Fore|Elbow|Cuff|Paw|Leg|Shin|Knee|Foot|Ear[LR]|Tail)/;
// The pieces of armour, by the names of their objects in the model. Each is shown on its own; its plates (the material
// a_steel) take the colour of the item's tier, its trim and straps stay as modelled.
const PIECES = { helmet: ['ArmorHelmet'], chest: ['ArmorChest'], gloves: ['ArmorGloveL', 'ArmorGloveR'],
  boots: ['ArmorBootL', 'ArmorBootR', 'ArmorBootTopL', 'ArmorBootTopR', 'ArmorBootKneeL', 'ArmorBootKneeR'] };

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
    // An arm was modelled held a little away from the body. Its parts go into groups that turn it straight down, so
    // the animation below can speak of the arm as of something that hangs from the shoulder: what is above the elbow
    // into one, what is below it into another that turns about the elbow (fore, bent by turning it about -X).
    const arms = [['PArmL', -1], ['PArmR', 1]].map(([name, s]) => {
      const arm = node(name), hang = new THREE.Group(), fore = new THREE.Group(), foreHang = new THREE.Group();
      hang.quaternion.setFromUnitVectors(new THREE.Vector3(ARM_DIR.x * s, ARM_DIR.y, ARM_DIR.z), new THREE.Vector3(0, -1, 0));
      fore.position.set(0, -ELBOW, 0);
      foreHang.position.set(0, ELBOW, 0);
      foreHang.quaternion.copy(hang.quaternion);
      for (const child of [...arm.children]) (FOREARM.test(child.name) ? foreHang : hang).add(child);
      const hand = new THREE.Group();   // what the paw holds; +Z is forward
      hand.position.set(0, -LOWER, 0);
      fore.add(foreHang, hand);
      arm.add(hang, fore);
      return Object.assign(arm, { hand, fore });
    });
    // a leg hangs straight down already: what is below the knee turns about it (shin, bent by turning it about +X)
    const legs = ['PLegL', 'PLegR'].map((name) => {
      const leg = node(name), shin = new THREE.Group(), low = new THREE.Group();
      shin.position.set(0, -KNEE, 0);
      low.position.set(0, KNEE, 0);
      for (const child of [...leg.children]) if (BELOW_KNEE.test(child.name)) low.add(child);
      shin.add(low);
      leg.add(shin);
      return Object.assign(leg, { shin });
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
    rig = { model, arms, legs, weapons, pieces, head: node('PHead'), ears: [node('PEarL'), node('PEarR')], tail: ['PTail', 'PTail1', 'PTail2', 'PTail3'].map(node),
      eyes: [node('EyeL'), node('EyeR')], gear: [], staffSpan: [span.min.y, span.max.y] };
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
      // the quiver behind the hip, leaning out towards the paw that reaches for it
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
      quiver.position.set(0.21, 0.43, -0.27);   // at the hip, its mouth by the paw that hangs there
      quiver.rotation.set(-0.1, 0, -0.5);
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

  let t = 0, runPhase = 0, blink = 2, move = 0, air = 0, shoot = 0, cast = 0, sit = 0, aim = 0, strike = 0, wind = 0;
  let wasAir = false, land = 0, down = 0, still = 0, fidget = null, nextFidget = 4 + Math.random() * 5, nextFlick = 1 + Math.random() * 3;
  const flick = [0, 0];
  const pawQuat = (i, out) => out.copy(rig.arms[i].quaternion).multiply(rig.arms[i].fore.quaternion);
  const rise = (f) => 1 - (1 - f) * (1 - f), drop = (f) => f * f, settle = (f) => f * f * (3 - 2 * f);

  // windup: how far the wind-up of a physical skill has come, 0..1; below 0 = none (casting is the same for a spell).
  // hurt: 1 at the moment the cat is hit, falling to 0 over the next half second.
  // draw: how far the bow is drawn, 0..1; below 0 = not drawing. shooting: the moment after the arrow has left.
  // pick: how far the cat is through stooping for something on the ground, 0..1; below 0 = it is not.
  // dead: it falls on its back and lies there; when it lives again it gets up.
  function update(dt, { speed = 0, airborne = false, shooting = false, dashing = false, casting = false, windup = -1, sitting = false, hurt = 0, draw = -1, swing: slash = -1, swingKind: slashKind = 2, pick = -1, dead = false } = {}) {
    t += dt;
    down = dead ? Math.min(1, down + dt / 0.5) : Math.max(0, down - dt / 0.65);
    if (down > 0) {   // on the ground, or on the way there or back: nothing else is played
      speed = 0; hurt = 0;
      airborne = shooting = dashing = casting = sitting = false;
      windup = draw = slash = pick = -1;
    }
    const k = Math.min(1, dt * 12);
    move += (Math.min(1, speed / 9) - move) * k;
    air += ((airborne ? 1 : 0) - air) * k;
    shoot += ((shooting ? 1 : 0) - shoot) * Math.min(1, dt * 20);
    cast += ((casting ? 1 : 0) - cast) * Math.min(1, dt * 14);
    sit += ((sitting ? 1 : 0) - sit) * Math.min(1, dt * 7);
    runPhase += dt * (6 + speed * 1.1);
    if (wasAir && !airborne) land = 1;   // back on the ground: the knees give, the body is squashed for a moment
    wasAir = airborne;
    land = Math.max(0, land - dt / 0.28);
    if (!rig) return;
    const { arms, legs, head, ears, tail, eyes } = rig;

    // ---- on its feet: the legs swing from the hip and fold at the knee as they come forward; the arms swing against
    // them, bent at the elbow
    const stride = Math.sin(runPhase), lift = Math.cos(runPhase), run = move * (1 - air);
    const swing = stride * 0.95 * run;
    legs[0].rotation.set(swing + air * 0.5, 0, 0);
    legs[1].rotation.set(-swing - air * 0.35, 0, 0);
    let knee0 = Math.max(0, -lift) * 1.15 * run + air * 0.8, knee1 = Math.max(0, lift) * 1.15 * run + air * 0.55;
    arms[0].rotation.x = -swing * 0.8;
    arms[0].rotation.y = 0;   // the stances below turn the paws freely: every frame starts from the plain pose
    arms[0].rotation.z = -0.35 - air * 0.9;
    // right arm points forward while firing
    arms[1].rotation.x = swing * 0.8 * (1 - shoot) - 1.5 * shoot;
    arms[1].rotation.y = 0;
    arms[1].rotation.z = (0.35 + air * 0.9) * (1 - shoot);
    let bend0 = 0.16 + run * (0.6 + 0.45 * Math.max(0, stride)) + air * 0.35;
    let bend1 = (0.16 + run * (0.6 + 0.45 * Math.max(0, -stride)) + air * 0.35) * (1 - shoot);
    // a shield is carried, not swung: the off paw holds it up in front and only rocks a little on the run
    if (rig.shield) {
      arms[0].rotation.x = SHIELD_ARM - swing * 0.2;
      arms[0].rotation.z = -0.22 - air * 0.5;
      bend0 = 0.1;
    }
    // A staff is carried, not swung. Standing, the paw is out to the side with the staff planted beside the cat; on
    // the move - and in the air - it hangs, and the staff lies level in it.
    const carry = rig.staff ? Math.max(smooth(0.06, 0.55, move), air) : 0;
    if (rig.staff) {
      arms[1].rotation.x = mix(-0.12, swing * 0.2 - 0.05, carry) * (1 - shoot) - 1.1 * shoot;
      arms[1].rotation.z = mix(STAFF_ARM, 0.34, carry) + air * 0.4;
      bend1 = mix(0.05, 0.35, carry) * (1 - shoot);
    }
    // casting: both paws held out in front, cupping the charging bolt - or the one with the staff putting its crystal forward
    if (cast > 0.01) {
      const tremble = Math.sin(t * 40) * 0.04 * cast;
      for (const [i, s] of [[0, 1], [1, -1]]) {
        const withStaff = i === 1 && rig.staff;
        arms[i].rotation.x += ((withStaff ? -1.0 : -1.4) + tremble - arms[i].rotation.x) * cast;
        arms[i].rotation.z += ((withStaff ? 0.2 : s * 0.35) - arms[i].rotation.z) * cast;
      }
      bend0 = mix(bend0, rig.shield ? 0.1 : 0.55, cast);
      bend1 = mix(bend1, rig.staff ? 0.2 : 0.55, cast);
    }

    // what the body does besides: how far it bobs (game units), leans forward, turns, steps forward and sinks (model units)
    let bob = Math.abs(stride) * 0.09 * run + Math.sin(t * 2.2) * 0.012;
    let lean = move * 0.16 + (dashing ? 0.55 : 0) - cast * 0.1, twist = 0, roll = 0, lunge = 0, crouch = 0;

    // Winding up a blow or drawing breath for a shout: the weapon paw goes up and back, cocked at the elbow, as the
    // moment comes; the other one is braced in front and the cat sinks on its knees. What is let go then - the swing
    // below - takes over from where this has brought the paw.
    wind += ((windup >= 0 ? 1 : 0) - wind) * Math.min(1, dt * 12);
    if (wind > 0.01) {
      const drawn = smooth(0, 1, Math.max(0, windup));
      arms[1].rotation.x += (mix(-0.9, -2.8, drawn) - arms[1].rotation.x) * wind;
      arms[1].rotation.z += (0.12 - arms[1].rotation.z) * wind;
      bend1 = mix(bend1, mix(0.5, 1.4, drawn), wind);
      if (!rig.shield) { arms[0].rotation.x += (-0.7 - arms[0].rotation.x) * wind * 0.7; bend0 = mix(bend0, 0.8, wind * 0.7); }
      lean -= wind * (0.1 + 0.1 * drawn);
      twist -= wind * 0.25 * drawn;
      crouch += wind * 0.05 * drawn;
    }

    // ---- the sword swing (0..1). Kinds: 0 = left to right, 1 = right to left, 2 = overhead chop.
    // A swing has three beats: the blade is drawn back and slows at the top, so the wind-up can be read; it comes
    // through gathering speed; and the arm eases back. The wind-up takes the first SWING_WINDUP of it. The whole cat
    // is in it: the elbow is cocked and then thrown straight, the body winds up against the blow and goes with it,
    // one foot steps into it, the free paw and the tail swing the other way.
    let step = 0, brace = 0, counter = 0;
    if (slash >= 0) {
      const W = SWING_WINDUP, H = SWING_HIT;
      const up = slash < W ? rise(slash / W) : slash < H ? 1 - drop((slash - W) / (H - W)) : 0;                // drawn back: 0..1..0
      const thru = slash < W ? 0 : slash < H ? drop((slash - W) / (H - W)) : 1 - settle((slash - H) / (1 - H));   // through, then back: 0..1..0
      const grip = Math.max(up, thru);
      // the paw goes from where it was to the wound-up pose, through the blow, and back
      const { wound, thru: through, turn } = SWINGS[slashKind] ?? SWINGS[2], rest = Q3.copy(arms[1].quaternion);
      let cocked;
      if (slash < W) { const a = rise(slash / W); arms[1].quaternion.copy(rest).slerp(wound.q, a); cocked = mix(bend1, wound.b, a); }
      else if (slash < H) { const a = drop((slash - W) / (H - W)); arms[1].quaternion.copy(wound.q).slerp(through.q, a); cocked = mix(wound.b, through.b, a); }
      else { const a = settle((slash - H) / (1 - H)); arms[1].quaternion.copy(through.q).slerp(rest, a); cocked = mix(through.b, bend1, a); }
      if (slashKind === 2) {
        lean += -0.2 * up + 0.34 * thru;
        twist += 0.3 * up - 0.18 * thru;
        lunge += -0.05 * up + 0.2 * thru;
        crouch += 0.02 * up + 0.07 * thru;
        bob += 0.04 * up;
        counter = -0.8 * up + 0.6 * thru;
      } else {
        // wound up to one side, then across to the other
        const across = slash < W ? -up : slash < H ? mix(-1, 1, drop((slash - W) / (H - W))) : thru;   // -1 wound up, +1 through
        twist += across * turn * 0.85;
        roll = across * turn * 0.07;
        lean += 0.06 * up + 0.16 * thru;
        lunge += -0.03 * up + 0.16 * thru;
        crouch += 0.06 * grip;
        counter = (-0.5 * up + 0.5 * thru) * 0.8;
      }
      bend1 = cocked;
      step = thru;
      brace = grip;
    }
    if (!rig.shield && !rig.bow && Math.abs(counter) > 0.001) {
      arms[0].rotation.x += counter * (1 - run * 0.5);
      bend0 = mix(bend0, 0.7, Math.min(1, Math.abs(counter)));
    }
    // the step into the blow: the near foot goes forward, the other one stays behind (standing; a running cat keeps running)
    if (step > 0.001 || brace > 0.001) {
      const stand = 1 - run;
      legs[0].rotation.x += -0.5 * step * stand;
      legs[1].rotation.x += 0.42 * step * stand;
      legs[0].rotation.z = -0.12 * brace * stand;
      legs[1].rotation.z = 0.12 * brace * stand;
      knee0 += 0.55 * step * stand;
      knee1 += 0.15 * brace * stand;
    }

    // resting: drop to the ground with the legs stretched out in front and the paws on the knees
    if (sit > 0.01) {
      bob -= 0.3 * sit;
      lean -= 0.12 * sit;
      for (const leg of legs) leg.rotation.x += (-1.45 - leg.rotation.x) * sit;
      for (const arm of arms) arm.rotation.x += (-0.5 - arm.rotation.x) * sit;
      knee0 = mix(knee0, 0.12, sit); knee1 = mix(knee1, 0.12, sit);
      bend0 = mix(bend0, 0.45, sit); bend1 = mix(bend1, 0.12, sit);   // the paw with the weapon stays straight: its point clear of the face
    }
    let headX = -move * 0.1 + Math.sin(t * 1.7) * 0.02, headY = 0, headZ = Math.sin(t * 1.3) * 0.04, shut = false;

    // ---- stooping for something on the ground: the body goes down over bent knees, the free paw reaches for it
    const stoop = pick >= 0 ? smooth(0, 0.36, pick) * (1 - smooth(0.6, 1, pick)) : 0;
    if (stoop > 0.001) {
      const r = rig.shield || rig.bow ? 1 : 0, stand = 1 - run * 0.7;
      lean += 0.8 * stoop;
      crouch += 0.15 * stoop * stand;
      arms[r].rotation.x = mix(arms[r].rotation.x, -0.5, stoop);
      arms[r].rotation.z = mix(arms[r].rotation.z, r ? 0.12 : -0.12, stoop);
      if (r) bend1 = mix(bend1, 0.12, stoop); else bend0 = mix(bend0, 0.12, stoop);
      headX += 0.2 * stoop;
    }

    // ---- nothing to do: after a while the cat looks about, licks a paw or has a stretch
    const busy = move > 0.05 || air > 0.05 || casting || windup >= 0 || slash >= 0 || draw >= 0 || shooting || sitting || hurt > 0 || down > 0 || pick >= 0;
    still = busy ? 0 : still + dt;
    if (!fidget && still > nextFidget) {
      const kinds = ['look'];
      if (!rig.shield && !rig.bow && look.weapon !== 'daggers') kinds.push('lick');   // not with something in that paw
      if (!rig.shield && !rig.bow && !rig.staff) kinds.push('stretch');
      const kind = kinds[Math.floor(Math.random() * kinds.length)];
      fidget = { kind, t: 0, dur: { look: 2.6, lick: 3.4, stretch: 2.8 }[kind], k: 0 };
    }
    if (fidget) {
      fidget.t += dt;
      const f = fidget.t / fidget.dur, want = busy ? 0 : smooth(0, 0.18, f) * (1 - smooth(0.82, 1, f));
      fidget.k += (want - fidget.k) * Math.min(1, dt * (busy ? 14 : 9));
      const w = fidget.k;
      if (fidget.kind === 'look') {
        headY += Math.sin(f * Math.PI * 2) * 0.7 * w;
        headX -= 0.06 * w;
      } else if (fidget.kind === 'lick') {
        arms[0].rotation.x = mix(arms[0].rotation.x, -1.25, w);
        arms[0].rotation.z = mix(arms[0].rotation.z, 0.3, w);
        bend0 = mix(bend0, 1.95 + Math.sin(t * 9) * 0.08, w);
        headX += (0.28 + Math.sin(t * 9) * 0.05) * w;
        headZ += -0.2 * w;
        headY += -0.18 * w;
        shut = shut || w > 0.5;
      } else {
        const peak = smooth(0.2, 0.5, f) * (1 - smooth(0.7, 0.95, f));
        for (const [i, s] of [[0, -1], [1, 1]]) {
          arms[i].rotation.x = mix(arms[i].rotation.x, -2.85, w);
          arms[i].rotation.z = mix(arms[i].rotation.z, s * (0.35 + 0.3 * peak), w);
        }
        bend0 = mix(bend0, 0.55 - 0.4 * peak, w); bend1 = mix(bend1, 0.55 - 0.4 * peak, w);
        lean -= 0.2 * w * peak;
        headX -= 0.3 * w * peak;
        bob += 0.03 * w * peak;
        shut = shut || w * peak > 0.4;
      }
      if (f >= 1 || (busy && fidget.k < 0.02)) { fidget = null; still = 0; nextFidget = 5 + Math.random() * 7; }
    }

    // ---- landing from a jump
    const give = land * land;
    crouch += 0.11 * give;
    arms[0].rotation.z -= 0.35 * give; arms[1].rotation.z += 0.35 * give * (rig.staff ? 0 : 1);
    lean += 0.12 * give;

    // ---- a hit: the cat flinches - knocked back on its heels and squashed, paws thrown out, head jerked back, ears
    // flat, eyes screwed shut - and springs back. It stays in sight the whole time.
    const h = Math.min(1, Math.max(0, hurt)), jolt = h * h * (3 - 2 * h);
    if (h > 0) {
      lean -= 0.42 * jolt;
      headX -= 0.3 * jolt;
      headZ += Math.sin(t * 55) * 0.07 * h;            // a shiver that dies away
      arms[0].rotation.z -= 0.75 * jolt;
      arms[1].rotation.z += 0.75 * jolt;
      crouch += 0.04 * jolt;
      shut = shut || h > 0.3;
    }

    // sinking: the body goes down and the legs fold under it, so that the feet stay on the ground
    const sink = crouch * (1 - sit) * (1 - air);
    if (sink > 0.001) {
      const [hip, knee] = fold(sink);
      for (const leg of legs) leg.rotation.x -= hip;
      knee0 += knee; knee1 += knee;
    }
    inner.rotation.set(lean, twist, roll);
    inner.position.set(0, bob - sink * SCALE, lunge * SCALE - 0.22 * jolt);
    inner.scale.set(1 + 0.1 * jolt + 0.07 * give, (1 - 0.14 * jolt) * (1 - 0.12 * give), 1 + 0.1 * jolt + 0.07 * give);
    // the face stays on what the cat is fighting while the body turns under it
    headY -= twist * 0.75;
    arms[0].fore.rotation.x = -bend0;
    arms[1].fore.rotation.x = -bend1;
    legs[0].shin.rotation.x = knee0;
    legs[1].shin.rotation.x = knee1;

    // ---- the bow. The cat stands side-on to its target, as an archer does, and looks along the arrow. One paw goes
    // back to the quiver at the hip and comes forward with an arrow while the other brings the bow in; the arrow is
    // laid on it; then the bow is pushed out at the target and the string taken back. `draw` runs through all of
    // that, 0..1; for a moment after the arrow has left (shoot) the stance is held.
    aim += ((draw >= 0 ? 1 : 0) - aim) * Math.min(1, dt * 14);
    if (rig.bow) {
      const { bow, string, arrow, inPaw } = rig.bow;
      const drawing = draw >= 0, p = drawing ? Math.min(1, draw) : 0, stance = Math.max(aim, shoot);
      const toQuiver = smooth(0, 0.2, p), toBow = smooth(0.24, 0.46, p), pull = drawing ? smooth(0.5, 1, p) : 0;
      const out = drawing ? Math.max(pull, 1 - smooth(0.08, 0.46, p)) : 1;        // how far the bow is held out: 1 - in - 1
      if (stance > 0.01) {
        inner.rotation.y += STANCE * stance;
        headY += -STANCE * 0.9 * stance;
        const grip = V1.copy(BOW_NEAR).lerp(BOW_FAR, out);
        const a = reach(SHOULDERS[0], grip, POLE_BOW);
        arms[0].quaternion.slerp(a.q, stance);
        arms[0].fore.rotation.x = mix(arms[0].fore.rotation.x, -a.bend, stance);
        // the string's paw: hanging -> at the quiver -> where the arrow meets the string, which then comes back with it;
        // just loosed, it stays where it let go
        const nock = V2.copy(grip); nock.x += BOW_STRING + BOW_PULL * (drawing ? pull : 1);
        V3.copy(HANG).lerp(QUIVER, drawing ? toQuiver : 0).lerp(nock, drawing ? toBow : 1);
        const b = reach(SHOULDERS[1], V3, POLE_STRING);
        arms[1].quaternion.slerp(b.q, stance);
        arms[1].fore.rotation.x = mix(arms[1].fore.rotation.x, -b.bend, stance);
      }
      // upright whatever the paw does, and turned with the stance so that its belly faces the target
      bow.quaternion.copy(pawQuat(0, Q1)).invert().multiply(Q2.setFromAxisAngle(UP, -STANCE * stance));
      const back = -BOW_STRING - BOW_PULL * pull, at = string.geometry.attributes.position;
      if (at.getZ(1) !== back) { at.setZ(1, back); at.needsUpdate = true; }
      arrow.visible = drawing && toBow >= 1;                      // on the bow once it is nocked
      arrow.position.z = back + ARROW_NOCK;
      inPaw.visible = drawing && toQuiver > 0.8 && toBow < 1;     // in the paw on the way from the quiver
    }
    head.rotation.set(headX, headY, headZ);

    // ---- the tail: a wave runs down its four segments, faster on the run, where it also streams out behind
    for (let i = 0; i < 4; i++) {
      const s = tail[i];
      s.rotation.y = Math.sin(t * (3 + move * 5) - i * 0.85) * (0.14 + move * 0.1) * (i ? 0.75 : 0.6) - twist * 0.18;
      s.rotation.x = Math.sin(t * 2 - i * 0.6) * 0.05 - move * (i ? 0.06 : 0.12) - stoop * (i ? 0.08 : 0.3) - jolt * 0.12;
      s.rotation.z = 0;
    }

    // ---- the ears: swept back on the run, flat when hit, and now and then one of them twitches
    nextFlick -= dt;
    if (nextFlick < 0) { flick[Math.random() < 0.5 ? 0 : 1] = 1; nextFlick = 1.5 + Math.random() * 4; }
    for (let i = 0; i < 2; i++) {
      flick[i] = Math.max(0, flick[i] - dt / 0.2);
      const out = i ? -1 : 1;   // the left ear turns outwards about +Z, the right one about -Z
      ears[i].rotation.set(-0.3 * move - 0.35 * jolt, 0, out * (0.85 * jolt - 0.3 * Math.sin(flick[i] * Math.PI)));
    }

    blink -= dt;
    if (blink < -0.12) blink = 1.5 + Math.random() * 3;
    eyes[0].scale.y = eyes[1].scale.y = blink < 0 || shut ? 0.12 : 1;

    // ---- struck down: the cat goes over backwards and lies on its back, paws and legs thrown out, ears and tail limp;
    // getting up is the same the other way
    if (down > 0) {
      const K = settle(down), thud = dead ? Math.sin(Math.min(1, Math.max(0, (down - 0.72) / 0.28)) * Math.PI) * 0.06 : 0;
      inner.rotation.set(mix(inner.rotation.x, -Math.PI / 2, K), inner.rotation.y * (1 - K), 0);
      inner.position.set(0, mix(inner.position.y, 0.6, K) + thud, mix(inner.position.z, -0.45, K));
      for (const [i, s] of [[0, -1], [1, 1]]) {
        arms[i].rotation.set(mix(arms[i].rotation.x, -0.25, K), 0, mix(arms[i].rotation.z, s * 1.3, K));
        arms[i].fore.rotation.x = mix(arms[i].fore.rotation.x, -0.45, K);
        legs[i].rotation.set(mix(legs[i].rotation.x, -0.4, K), 0, s * 0.32 * K);
        legs[i].shin.rotation.x = mix(legs[i].shin.rotation.x, 0.4, K);
        ears[i].rotation.set(-0.2 * K, 0, -s * 0.55 * K);
      }
      head.rotation.set(mix(headX, 0.3, K), headY * (1 - K), mix(headZ, 0.12, K));
      for (let i = 0; i < 4; i++) { tail[i].rotation.y *= 1 - K; tail[i].rotation.x = mix(tail[i].rotation.x, i ? 0.12 : 0.5, K); }
      if (K > 0.35) eyes[0].scale.y = eyes[1].scale.y = 0.12;
    }

    // The staff, whatever its paw has just been told to do: upright on the ground, level on the move, crystal first
    // for a spell, and with the paw for a blow. It slides through the paw so that the right part of it is held: the
    // height of the paw above the ground when it is planted, its middle when it is carried.
    strike += (((slash >= 0 || windup >= 0) && rig.staff ? 1 : 0) - strike) * Math.min(1, dt * 18);
    if (rig.staff) {
      const { g, staff } = rig.staff, [foot, top] = rig.staffSpan, arm = arms[1], length = top - foot;
      const level = carry * (1 - sit), spell = Math.max(cast, shoot), paw = pawQuat(1, Q1);
      Q2.identity().slerp(STAFF_LEVEL, level);
      Q2.slerp(Q3.copy(STAFF_CAST).slerp(STAFF_THRUST, shoot), spell);
      Q2.slerp(Q3.copy(paw).multiply(STAFF_STRIKE), strike);
      g.quaternion.copy(paw).invert().multiply(Q2);
      // the paw above the ground, model units: down the upper arm to the elbow, then down the forearm
      V1.set(0, -LOWER, 0).applyQuaternion(arm.fore.quaternion).add(V2.set(0, -ELBOW, 0)).applyQuaternion(arm.quaternion);
      const pawUp = arm.position.y + V1.y + inner.position.y / SCALE;
      let grip = Math.min(top - 0.3, Math.max(foot + 0.2, foot + pawUp));
      grip = mix(grip, (foot + top) / 2 - 0.1, level);
      grip = mix(grip, foot + length * 0.36, spell);
      grip = mix(grip, foot + length * 0.28, strike);
      const planted = (1 - level) * (1 - spell) * (1 - strike);   // then it stands a little outside the paw, clear of the head
      staff.position.set(0.1 * planted + 0.06 * level, -grip, 0.05 * planted);
    }

    // the shield stays upright and faces ahead whatever its paw has just been told to do
    if (rig.shield) {
      pawQuat(0, Q1).invert();
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
