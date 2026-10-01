import * as THREE from 'three';
import { part, merge, box, cyl, cone, ball } from './geo.js';

// Procedural skeleton monsters. Every variant shares the same bones and differs in gear:
// chaser = swordsman, runner = hunched bone runner, shooter = mage, tank = brute, boss = Skeleton King.

export const BONE = 0xe9e3d2;
const DARK = 0x1e1a18, STEEL = 0x9aa3ad, WOOD = 0x6b4a2e, GOLD = 0xe7b93c, CLOTH = 0x4a2f6b, RED = 0x8f1f2b;
const HALF_PI = Math.PI / 2;
export const SKELETON_HEIGHT = 2.1;   // at scale 1
const BASE_R = 0.5;                   // collision radius that corresponds to scale 1
const MAX_SCALE = 3.6;

function buildGeometry(type) {
  const leg = merge([
    part(cyl(0.05, 0.042, 0.4), BONE, { pos: [0, -0.2, 0] }),
    part(ball(0.06), BONE, { pos: [0, -0.42, 0] }),
    part(cyl(0.042, 0.036, 0.38), BONE, { pos: [0, -0.62, 0] }),
    part(box(0.11, 0.06, 0.24), BONE, { pos: [0, -0.82, 0.06] }),
  ]);

  const torso = [
    part(box(0.36, 0.13, 0.18), BONE, { pos: [0, 0.02, 0] }),
    part(cyl(0.04, 0.04, 0.7), BONE, { pos: [0, 0.42, 0] }),
    part(cyl(0.04, 0.04, 0.6), BONE, { pos: [0, 0.74, 0], rot: [0, 0, HALF_PI] }),
  ];
  for (const [r, y] of [[0.16, 0.36], [0.2, 0.5], [0.19, 0.63]]) {
    torso.push(part(new THREE.TorusGeometry(r, 0.026, 6, 14), BONE, { pos: [0, y, 0.02], rot: [HALF_PI, 0, 0], scale: [1, 0.75, 1] }));
  }
  for (const s of [-1, 1]) torso.push(part(ball(0.07), type === 'boss' ? GOLD : BONE, { pos: [s * 0.3, 0.74, 0], scale: type === 'boss' ? 1.9 : 1 }));
  if (type === 'boss') torso.push(part(box(0.78, 1.05, 0.04), RED, { pos: [0, 0.28, -0.2], rot: [0.12, 0, 0] }));

  const head = [
    part(ball(0.2, 14, 10), BONE, { pos: [0, 0.2, 0], scale: [1, 1.05, 1.08] }),
    part(box(0.2, 0.08, 0.15), BONE, { pos: [0, 0.02, 0.05] }),
  ];
  for (const s of [-1, 1]) head.push(part(ball(0.058), DARK, { pos: [s * 0.078, 0.22, 0.165] }));
  if (type === 'shooter') {
    head.push(part(cone(0.3, 0.55, 10), CLOTH, { pos: [0, 0.64, 0] }), part(cyl(0.38, 0.38, 0.03, 14), CLOTH, { pos: [0, 0.37, 0] }));
  } else if (type === 'tank') {
    head.push(part(new THREE.SphereGeometry(0.225, 12, 6, 0, Math.PI * 2, 0, HALF_PI), STEEL, { pos: [0, 0.22, 0], scale: [1, 1.05, 1.08] }));
    for (const s of [-1, 1]) head.push(part(cone(0.05, 0.28, 6), BONE, { pos: [s * 0.25, 0.36, 0], rot: [0, 0, -s * 0.7] }));
  } else if (type === 'boss') {
    head.push(part(cyl(0.2, 0.17, 0.1, 12), GOLD, { pos: [0, 0.38, 0] }));
    for (let i = 0; i < 6; i++) {
      const a = i / 6 * Math.PI * 2;
      head.push(part(cone(0.04, 0.14, 4), GOLD, { pos: [Math.cos(a) * 0.17, 0.49, Math.sin(a) * 0.17] }));
    }
  }

  const arm = () => [
    part(cyl(0.04, 0.035, 0.34), BONE, { pos: [0, -0.17, 0] }),
    part(ball(0.05), BONE, { pos: [0, -0.35, 0] }),
    part(cyl(0.035, 0.03, 0.3), BONE, { pos: [0, -0.5, 0] }),
    part(ball(0.055), BONE, { pos: [0, -0.68, 0] }),
  ];
  // gear is modelled pointing along +Z from the hand; the raised arm turns that up and forward
  const armR = arm(), armL = arm();
  let armGlow = null;
  if (type === 'chaser') {
    armR.push(part(box(0.18, 0.04, 0.05), WOOD, { pos: [0, -0.68, 0.09] }), part(box(0.045, 0.02, 0.7), STEEL, { pos: [0, -0.68, 0.46] }));
  } else if (type === 'shooter') {
    armR.push(part(cyl(0.025, 0.025, 1.3), WOOD, { pos: [0, -0.68, 0.3], rot: [HALF_PI, 0, 0] }));
    armGlow = part(ball(0.09), 0xffffff, { pos: [0, -0.68, 1.0] });
  } else if (type === 'tank') {
    armR.push(part(cyl(0.09, 0.05, 0.8), WOOD, { pos: [0, -0.68, 0.4], rot: [HALF_PI, 0, 0] }), part(ball(0.17, 6, 5), STEEL, { pos: [0, -0.68, 0.85] }));
    armL.push(part(cyl(0.34, 0.34, 0.05, 12), WOOD, { pos: [0, -0.55, 0.1], rot: [HALF_PI, 0, 0] }), part(ball(0.09), STEEL, { pos: [0, -0.55, 0.14] }));
  } else if (type === 'boss') {
    armR.push(part(box(0.3, 0.05, 0.06), GOLD, { pos: [0, -0.68, 0.12] }), part(box(0.09, 0.03, 1.1), STEEL, { pos: [0, -0.68, 0.7] }));
  }

  const eyes = merge([-1, 1].map((s) => part(ball(0.032), 0xffffff, { pos: [s * 0.078, 0.22, 0.2] })));
  return { leg, torso: merge(torso), head: merge(head), armR: merge(armR), armL: merge(armL), eyes, armGlow };
}

const geoCache = new Map(), glowCache = new Map();
const boneMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });

export function createSkeleton(type, def) {
  if (!geoCache.has(type)) geoCache.set(type, buildGeometry(type));
  if (!glowCache.has(type)) glowCache.set(type, new THREE.MeshBasicMaterial({ color: new THREE.Color(def.color).multiplyScalar(2.6) }));
  const geo = geoCache.get(type), glow = glowCache.get(type);
  const mat = boneMat.clone();   // per-monster so it can flash when hit

  const group = new THREE.Group();   // origin at the feet, facing +Z
  group.scale.setScalar(Math.min(MAX_SCALE, def.r / BASE_R));
  const inner = new THREE.Group();
  group.add(inner);
  const add = (parent, g, x, y, m = mat) => {
    const mesh = new THREE.Mesh(g, m);
    mesh.position.set(x, y, 0);
    mesh.castShadow = m === mat;
    parent.add(mesh);
    return mesh;
  };

  const torso = add(inner, geo.torso, 0, 0.85);
  const head = add(torso, geo.head, 0, 0.8);
  add(head, geo.eyes, 0, 0, glow);
  const armL = add(torso, geo.armL, -0.3, 0.74);
  const armR = add(torso, geo.armR, 0.3, 0.74);
  if (geo.armGlow) add(armR, geo.armGlow, 0, 0, glow);
  const legL = add(inner, geo.leg, -0.14, 0.85);
  const legR = add(inner, geo.leg, 0.14, 0.85);

  const hunched = type === 'runner';
  const armed = type !== 'runner';
  const seed = Math.random() * 10;
  let phase = seed, move = 0;

  function update(dt, time, moving) {
    move += ((moving ? 1 : 0) - move) * Math.min(1, dt * 8);
    phase += dt * (hunched ? 16 : 9) * move;
    const swing = Math.sin(phase) * 0.75 * move;
    legL.rotation.x = swing;
    legR.rotation.x = -swing;
    armL.rotation.x = (hunched ? -1.0 : type === 'tank' ? -0.9 : 0) - swing * 0.6;
    armR.rotation.x = (armed ? -1.05 : -1.0) + swing * (armed ? 0.2 : 0.6) + Math.sin(time * 2 + seed) * 0.05;
    inner.position.y = Math.abs(Math.sin(phase)) * 0.05 * move;
    torso.rotation.x = (hunched ? 0.45 : 0.06) + move * 0.08;
    torso.rotation.z = Math.sin(time * 1.5 + seed) * 0.04;
    head.rotation.x = hunched ? -0.4 : 0;
    head.rotation.y = Math.sin(time * 1.1 + seed) * 0.3 * (1 - move);
  }

  return { group, mat, update, flash: (v) => mat.emissive.setScalar(v * 0.8) };
}
