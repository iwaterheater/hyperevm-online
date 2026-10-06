import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { part, merge, cyl, cone, ball } from '../geo.js';

// The built-in models: the pieces of the world that are code, not files of an asset pack - the town fountain and its
// lamp posts, the crystal, bushes, the spikes and red crystals of the cursed lands, the ring of the King's lair, and the
// tufts and flowers of the meadows. A map places them like any other model, as 'builtin/<name>' (the names: BUILTIN in catalog.js).
// Offsets and squash are baked into the geometry, so an object needs only x, z, ry and s. Model units, origin on the ground.

// one material for everything that is coloured per vertex
const flat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 });
// unlit and brighter than white: this is what blooms
const bright = (hex, k) => new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k) });
const gem = (color, emissive, emissiveIntensity) => new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity, flatShading: true });

// a bare shape, stretched and lifted; its material gives the colour
function shape(geo, stretch, y) {
  geo.deleteAttribute('uv');
  return geo.scale(1, stretch, 1).translate(0, y, 0);
}
const flower = (color) => () => ({ geometry: part(new THREE.IcosahedronGeometry(0.1, 0), color, { pos: [0, 0.28, 0] }), material: flat });

const BUILD = {
  fountain: () => ({
    geometry: merge([
      part(cyl(2.3, 2.5, 0.55, 20), 0x9c9a94, { pos: [0, 0.27, 0] }),
      part(cyl(1.95, 1.95, 0.1, 20), 0x4fb3d9, { pos: [0, 0.56, 0] }),
      part(cyl(0.4, 0.55, 1.5, 10), 0x8b8983, { pos: [0, 1.0, 0] }),
    ]),
    material: flat,
  }),
  // two groups: the post, and the bulb with a material of its own
  lamp_post: () => ({
    geometry: mergeGeometries([
      part(cyl(0.06, 0.09, 2.7, 6), 0x2f2b2a, { pos: [0, 1.35, 0] }),
      part(ball(0.2), 0xffffff, { pos: [0, 2.8, 0] }),
    ], true),
    material: [flat, bright(0xffd9a0, 2.2)],
  }),
  crystal: () => ({ geometry: shape(new THREE.OctahedronGeometry(0.7), 1.7, 2.7), material: gem(0x0b2a25, 0x7fe8d6, 1.6) }),
  bush: () => ({ geometry: part(new THREE.IcosahedronGeometry(0.6, 0), 0x3d7a36, { pos: [0, 0.3, 0], scale: [1, 0.75, 1] }), material: flat }),
  spike: () => ({
    geometry: merge([
      part(cone(0.55, 2.8, 5), 0x1f191e, { pos: [0, 1.4, 0] }),
      part(cone(0.3, 1.5, 5), 0x2a2028, { pos: [0.45, 0.7, 0.15], rot: [0, 0, -0.35] }),
    ]),
    material: flat,
  }),
  red_crystal: () => ({ geometry: shape(new THREE.OctahedronGeometry(0.5), 2.2, 0.5), material: gem(0x1a0508, 0xff3040, 1.5) }),
  // the red circle around the Skeleton King: radius 13 at scale 1
  lair_ring: () => {
    const geometry = new THREE.TorusGeometry(13, 0.1, 8, 64).rotateX(Math.PI / 2).translate(0, 0.08, 0);
    geometry.deleteAttribute('uv');
    return { geometry, material: bright(0xff2244, 1.8) };
  },
  grass_tuft: () => ({
    geometry: merge([0, 2.1, 4.2].map((a) => part(cone(0.07, 0.42, 3), 0x7cc65c, {
      pos: [Math.cos(a) * 0.09, 0.2, Math.sin(a) * 0.09], rot: [Math.cos(a) * 0.25, 0, Math.sin(a) * 0.25],
    }))),
    material: flat,
  }),
  flower_white: flower(0xffffff),
  flower_yellow: flower(0xffe066),
  flower_pink: flower(0xff8fb3),
  flower_violet: flower(0xb18cff),
};

const cache = new Map();

// -> { geometry, material: Material | Material[] } | null for a name that is not a built-in. Built once and shared:
// callers never change or dispose what they get.
export function builtinModel(name) {
  if (!Object.hasOwn(BUILD, name)) return null;
  if (!cache.has(name)) cache.set(name, BUILD[name]());
  return cache.get(name);
}
