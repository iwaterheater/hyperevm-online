import * as THREE from 'three';

// Procedural chibi cat built from the reference picture:
// white fur, grey stripes, big navy eyes, dark-green hoodie with a white bow, striped tail.

const COLORS = {
  fur: 0xffffff,
  stripe: 0x9aa4b0,
  pink: 0xf5a3b5,
  hoodie: 0x35523f,
  eye: 0x18203a,
  teal: 0x7fe8d6,
  outline: 0x0c1a17,
};

function makeGradientMap() {
  const tex = new THREE.DataTexture(new Uint8Array([105, 185, 255]), 3, 1, THREE.RedFormat);
  tex.minFilter = tex.magFilter = THREE.NearestFilter;
  tex.needsUpdate = true;
  return tex;
}

// Equirectangular head texture; the face (+Z) sits at u = 0.25.
function makeHeadTexture() {
  const W = 1024, H = 512, cx = W * 0.25;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  g.strokeStyle = '#9aa4b0';
  g.lineCap = 'round';

  const line = (x1, y1, x2, y2, w) => {
    g.lineWidth = w;
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
  };
  // forehead
  line(cx, 30, cx, 150, 20);
  line(cx - 52, 60, cx - 44, 140, 17);
  line(cx + 52, 60, cx + 44, 140, 17);
  // cheeks
  for (const s of [-1, 1]) {
    line(cx + s * 150, 268, cx + s * 196, 262, 12);
    line(cx + s * 146, 302, cx + s * 190, 304, 12);
  }
  // back of the head
  const bx = W * 0.75;
  line(bx - 70, 130, bx + 70, 130, 20);
  line(bx - 95, 190, bx + 95, 190, 20);
  line(bx - 80, 250, bx + 80, 250, 20);

  // "w" mouth
  g.strokeStyle = '#18203a';
  g.lineWidth = 4;
  for (const s of [-1, 1]) {
    g.beginPath(); g.arc(cx + s * 11, 300, 11, 0, Math.PI); g.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Textures, geometries and fur materials are shared by every cat in the scene.
let shared = null;
function getShared() {
  if (shared) return shared;
  const gradientMap = makeGradientMap();
  const toon = (color, extra = {}) => new THREE.MeshToonMaterial({ color, gradientMap, ...extra });
  shared = {
    toon,
    mats: {
      fur: toon(COLORS.fur),
      head: toon(COLORS.fur, { map: makeHeadTexture() }),
      stripe: toon(COLORS.stripe),
      pink: toon(COLORS.pink),
      eye: new THREE.MeshBasicMaterial({ color: COLORS.eye }),
      white: new THREE.MeshBasicMaterial({ color: 0xffffff }),
      teal: new THREE.MeshBasicMaterial({ color: COLORS.teal }),
      steel: toon(0xcfd8e0),
      gold: toon(0xe7b93c),
      outline: new THREE.MeshBasicMaterial({ color: COLORS.outline, side: THREE.BackSide }),
    },
    sphere: new THREE.SphereGeometry(1, 32, 24),
    sphereLo: new THREE.SphereGeometry(1, 16, 12),
    collar: new THREE.TorusGeometry(0.4, 0.1, 12, 28),
    string: new THREE.CylinderGeometry(0.015, 0.015, 0.22, 6),
    bow: new THREE.ConeGeometry(0.05, 0.085, 4),
    ear: new THREE.ConeGeometry(0.27, 0.5, 20),
    arm: new THREE.CapsuleGeometry(0.125, 0.26, 6, 14),
    leg: new THREE.CapsuleGeometry(0.15, 0.14, 6, 14),
    blade: new THREE.BoxGeometry(0.08, 0.03, 0.85),
    guard: new THREE.BoxGeometry(0.26, 0.06, 0.07),
    hilt: new THREE.CylinderGeometry(0.032, 0.032, 0.2, 8),
  };
  return shared;
}

export function createCat({ hoodie = COLORS.hoodie } = {}) {
  const S = getShared();
  const { sphere, sphereLo } = S;
  const mats = {
    ...S.mats,
    hoodie: S.toon(hoodie),
    hoodieDark: S.toon(new THREE.Color(hoodie).multiplyScalar(0.68)),
  };

  // Adds a mesh; `outline` > 0 adds an inverted-hull contour.
  function part(parent, geo, mat, pos, scale = 1, outline = 0) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(...pos);
    if (typeof scale === 'number') m.scale.setScalar(scale); else m.scale.set(...scale);
    if (outline) {
      const o = new THREE.Mesh(geo, mats.outline);
      o.scale.setScalar(outline);
      m.add(o);
    }
    parent.add(m);
    return m;
  }

  const group = new THREE.Group();   // origin at the feet, facing +Z
  const inner = new THREE.Group();   // bob / lean
  group.add(inner);

  // ---- body & hoodie ----
  part(inner, sphere, mats.hoodie, [0, 0.8, 0], [0.5, 0.525, 0.425], 1.05);
  part(inner, sphere, mats.hoodieDark, [0, 0.66, 0.3], [0.26, 0.15, 0.12]);          // pocket
  const collar = part(inner, S.collar, mats.hoodieDark, [0, 1.14, 0], [1, 0.92, 1]);
  collar.rotation.x = Math.PI / 2;
  part(inner, sphere, mats.hoodieDark, [0, 1.2, -0.4], [0.42, 0.28, 0.3], 1.06);     // hood
  const stringGeo = S.string;
  for (const s of [-1, 1]) {
    const str = part(inner, stringGeo, mats.white, [s * 0.08, 0.98, 0.41], 1);
    str.rotation.x = -0.25;
  }
  // bow emblem
  const bowGeo = S.bow;
  for (const s of [-1, 1]) {
    const b = part(inner, bowGeo, mats.white, [0.2 + s * 0.04, 0.95, 0.385], [1, 1, 0.3]);
    b.rotation.z = s * Math.PI / 2;
  }

  // ---- head ----
  const head = new THREE.Group();
  head.position.set(0, 1.62, 0);
  inner.add(head);
  part(head, sphere, mats.head, [0, 0, 0], [0.694, 0.589, 0.62], 1.04);

  const earGeo = S.ear;
  const ears = [];
  for (const s of [-1, 1]) {
    const ear = new THREE.Group();
    ear.position.set(s * 0.4, 0.52, 0);
    ear.rotation.z = -s * 0.35;
    head.add(ear);
    part(ear, earGeo, mats.fur, [0, 0, 0], [1, 1, 0.7], 1.1);
    part(ear, earGeo, mats.pink, [0, -0.03, 0.07], [0.62, 0.72, 0.4]);
    ears.push(ear);
  }

  const eyes = [];
  for (const s of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(s * 0.26, -0.02, 0.555);
    eye.rotation.y = s * 0.4;
    head.add(eye);
    part(eye, sphere, mats.eye, [0, 0, 0], [0.105, 0.135, 0.05]);
    part(eye, sphereLo, mats.white, [-0.035, 0.055, 0.045], 0.036);
    part(eye, sphereLo, mats.teal, [0.03, -0.06, 0.04], [0.045, 0.028, 0.02]);
    eyes.push(eye);
  }
  part(head, sphereLo, mats.pink, [0, -0.115, 0.605], [0.04, 0.03, 0.03]);           // nose

  // ---- arms ----
  const armGeo = S.arm;
  const arms = [];
  for (const s of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(s * 0.4, 1.06, 0.02);
    inner.add(arm);
    part(arm, armGeo, mats.hoodie, [0, -0.2, 0], 1, 1.1);
    part(arm, sphereLo, mats.fur, [0, -0.44, 0], 0.135, 1.1);
    arms.push(arm);
  }
  // sword in the right paw, pointing forward along the arm's +Z
  part(arms[1], S.hilt, mats.gold, [0, -0.44, 0.04]).rotation.x = Math.PI / 2;
  part(arms[1], S.guard, mats.gold, [0, -0.44, 0.16]);
  part(arms[1], S.blade, mats.steel, [0, -0.44, 0.62]);

  // ---- legs ----
  const legGeo = S.leg;
  const legs = [];
  for (const s of [-1, 1]) {
    const leg = new THREE.Group();
    leg.position.set(s * 0.2, 0.46, 0);
    inner.add(leg);
    part(leg, legGeo, mats.fur, [0, -0.17, 0], 1, 1.08);
    part(leg, sphereLo, mats.fur, [0, -0.33, 0.07], [0.19, 0.115, 0.26], 1.08);
    part(leg, sphereLo, mats.pink, [0, -0.435, 0.09], [0.09, 0.025, 0.12]);          // paw pad
    legs.push(leg);
  }

  // ---- tail: chain of joints curling up ----
  const tail = [];
  let joint = new THREE.Group();
  joint.position.set(0, 0.58, -0.36);
  inner.add(joint);
  for (let i = 0; i < 9; i++) {
    part(joint, sphereLo, i % 3 === 1 ? mats.stripe : mats.fur, [0, 0, 0], 0.115 + Math.sin(i / 8 * Math.PI) * 0.03, 1.12);
    tail.push(joint);
    const next = new THREE.Group();
    next.position.y = 0.135;
    joint.add(next);
    joint = next;
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
      const mix = (a, b, k) => a + (b - a) * k;
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
        const hold = slash < 0.2 ? slash / 0.2 : slash < 0.55 ? 1 : 1 - (slash - 0.55) / 0.45;
        arms[1].rotation.x = mix(arms[1].rotation.x, -0.55, hold);
        arms[1].rotation.z = mix(arms[1].rotation.z, 0.1, hold);
        arms[1].rotation.y = sweep * dir * 1.1;
        inner.rotation.y = sweep * dir * 0.9;
      }
    }
    inner.rotation.x = move * 0.16 + (dashing ? 0.55 : 0) - cast * 0.1;
    // resting: drop to the ground with the legs stretched out in front and the paws on the knees
    if (sit > 0.01) {
      inner.position.y -= 0.36 * sit;
      inner.rotation.x -= 0.12 * sit;
      for (const leg of legs) leg.rotation.x += (-1.45 - leg.rotation.x) * sit;
      for (const arm of arms) arm.rotation.x += (-0.5 - arm.rotation.x) * sit;
    }
    head.rotation.z = Math.sin(t * 1.3) * 0.04;
    head.rotation.x = -move * 0.1 + Math.sin(t * 1.7) * 0.02;

    for (let i = 0; i < tail.length; i++) {
      tail[i].rotation.x = (i === 0 ? -1.15 : 0.23) + Math.sin(t * 2 + i * 0.4) * 0.03;
      tail[i].rotation.z = Math.sin(t * (3 + move * 5) + i * 0.55) * (0.07 + move * 0.05);
    }
    ears[0].rotation.x = ears[1].rotation.x = Math.sin(t * 9) * 0.03 * move;

    blink -= dt;
    if (blink < -0.12) blink = 1.5 + Math.random() * 3;
    const open = blink < 0 ? 0.12 : 1;
    eyes[0].scale.y = eyes[1].scale.y = open;
  }

  return { group, update };
}
