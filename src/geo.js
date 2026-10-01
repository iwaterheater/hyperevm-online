import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Helpers for building low-poly models as a single vertex-coloured geometry (one draw call per model part).

const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
const p = new THREE.Vector3(), s = new THREE.Vector3(), c = new THREE.Color();

// Returns a transformed, non-indexed copy of `geo` painted with a flat colour.
export function part(geo, color, { pos = [0, 0, 0], rot = [0, 0, 0], scale = 1 } = {}) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  if (typeof scale === 'number') s.setScalar(scale); else s.set(...scale);
  g.applyMatrix4(m4.compose(p.set(...pos), q.setFromEuler(e.set(...rot)), s));
  c.set(color);
  const n = g.attributes.position.count, colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.deleteAttribute('uv');
  return g;
}

export const merge = (parts) => mergeGeometries(parts);

export const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
export const cyl = (rTop, rBottom, h, seg = 8) => new THREE.CylinderGeometry(rTop, rBottom, h, seg);
export const cone = (r, h, seg = 8) => new THREE.ConeGeometry(r, h, seg);
export const ball = (r, w = 10, h = 8) => new THREE.SphereGeometry(r, w, h);
