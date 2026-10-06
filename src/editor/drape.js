import * as THREE from 'three';
import { heightAt } from '../map/format.js';

// Draping: how the editor's flat ground overlays follow the hills.
//
// A spawn disc, a threat ring, a collider outline, a facing arrow - all of them are flat shapes laid on y = 0, most of
// them instanced by the hundred. On a hill a flat disc is buried on one side and floats on the other. Rebuilding every
// shape on the CPU for every edit would cost the instancing that keeps them cheap, so the heights go to the GPU
// instead: ONE float texture with a texel per ground vertex, and a few lines in the vertex shader of each overlay
// material that lift every vertex by the height of the ground under it - with the very triangles of the terrain mesh
// (heightAt of format.js, to the letter), so a vertex of an overlay lies ON the ground, not near it.
//
// What a material needs for that is a geometry fine enough to bend: a vertex is exact, the triangle between three of
// them is as flat as ever (see discGeometry / bandGeometry / plateGeometry below).
//
// Points, pins, labels and lines whose shape is made on the CPU ask heightAt directly (drape.height, drapePath).

const SHADER = `
uniform sampler2D uDrapeMap;
uniform vec2 uDrapeGrid;   // vertices along a side, world units per cell
float drapeAt(ivec2 p) { return texelFetch(uDrapeMap, p, 0).r; }
// heightAt() of format.js: two triangles per cell, split along the diagonal from (ix, iz + 1) to (ix + 1, iz)
float drapeHeight(vec2 xz) {
  float last = uDrapeGrid.x - 1.0;
  if (last < 1.0) return 0.0;
  vec2 g = clamp(xz / uDrapeGrid.y + last * 0.5, 0.0, last);
  vec2 i = min(floor(g), last - 1.0), f = g - i;
  ivec2 p = ivec2(i);
  float a = drapeAt(p), d = drapeAt(p + ivec2(1, 0)), b = drapeAt(p + ivec2(0, 1)), c = drapeAt(p + ivec2(1, 1));
  return f.x + f.y <= 1.0 ? a + f.x * (d - a) + f.y * (b - a) : c + (1.0 - f.x) * (b - c) + (1.0 - f.y) * (d - c);
}`;
// three's project_vertex with one line more: the vertex is lifted in WORLD space, after the instance and the model
// matrix have put it where it belongs on the map
const PROJECT = `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
  mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition = modelMatrix * mvPosition;
mvPosition.y += drapeHeight( mvPosition.xz );
mvPosition = viewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;`;

const FLAT = new Float32Array(4);   // a 2 x 2 texture of zeros: what the shader reads before there is a map

function texture(data, size) {
  const t = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.FloatType);
  t.magFilter = t.minFilter = THREE.NearestFilter;   // read texel by texel (texelFetch): no float filtering is asked of the GPU
  t.needsUpdate = true;
  return t;
}

export function createDrape() {
  const uniforms = { uDrapeMap: { value: texture(FLAT, 2) }, uDrapeGrid: { value: new THREE.Vector2(0, 1) } };
  let map = null, heights = null, hilly = false, top = 0, known = false;
  // one pass over the heights after they changed, and only when somebody asks
  const measure = () => {
    if (known) return;
    known = true;
    hilly = false;
    top = 0;
    if (!heights) return;
    for (let i = 0; i < heights.length; i++) {
      const h = heights[i];
      if (h !== 0) hilly = true;
      if (h > top) top = h;
    }
  };

  const drape = {
    // -> the height of the ground under a world point; 0 before a map is loaded
    height(x, z) {
      return map ? heightAt(map, x, z) : 0;
    },

    // Is any vertex of the map off y = 0? (Asked by code that can take a shortcut on flat ground.)
    get hilly() {
      measure();
      return hilly;
    },

    // The height of the highest vertex (never below 0): above it there is only air.
    get top() {
      measure();
      return top;
    },

    // The map, its ground object or heights inside it changed: the texture follows. The texture reads the map's own
    // heights array - nothing is copied - and is made anew only when the array is another one (a load, a resize).
    sync(next) {
      const g = next?.ground, data = g?.heights ?? null;
      map = next ?? null;
      known = false;
      if (data === heights) {
        if (heights) uniforms.uDrapeMap.value.needsUpdate = true;
        return;
      }
      heights = data;
      uniforms.uDrapeMap.value.dispose();
      uniforms.uDrapeMap.value = data ? texture(data, g.size) : texture(FLAT, 2);
      uniforms.uDrapeGrid.value.set(data ? g.size : 0, data ? g.cell : 1);
    },

    // Makes a mesh material follow the ground: every vertex is lifted by the height under it. -> the material.
    // (A material that already compiles a shader of its own keeps it: this one is applied after.)
    apply(material) {
      const before = material.onBeforeCompile, key = material.customProgramCacheKey;
      material.onBeforeCompile = function (shader, renderer) {
        before?.call(this, shader, renderer);
        shader.uniforms.uDrapeMap = uniforms.uDrapeMap;
        shader.uniforms.uDrapeGrid = uniforms.uDrapeGrid;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\n${SHADER}`)
          .replace('#include <project_vertex>', PROJECT);
      };
      material.customProgramCacheKey = function () { return `${key ? key.call(this) : ''}|drape`; };
      material.needsUpdate = true;
      return material;
    },

    dispose() {
      uniforms.uDrapeMap.value.dispose();
    },
  };
  return drape;
}

// ---------------------------------------------------------------- geometries that can bend

// A unit disc on the ground as `rings` concentric bands of `segments` quads (a fan would span the whole disc with
// each triangle and cut straight through a hill in its middle).
export function discGeometry(segments = 64, rings = 16) {
  const pos = [0, 0, 0], index = [];
  for (let r = 1; r <= rings; r++) {
    for (let s = 0; s < segments; s++) {
      const a = s / segments * Math.PI * 2;
      pos.push(Math.cos(a) * r / rings, 0, Math.sin(a) * r / rings);
    }
  }
  const at = (r, s) => 1 + (r - 1) * segments + (s % segments);
  for (let s = 0; s < segments; s++) index.push(0, at(1, s + 1), at(1, s));
  for (let r = 1; r < rings; r++) {
    for (let s = 0; s < segments; s++) index.push(at(r, s), at(r, s + 1), at(r + 1, s), at(r + 1, s), at(r, s + 1), at(r + 1, s + 1));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  return g;
}

// A flat rectangle of 2 x 2 units around the origin, cut into nx x nz quads.
export function plateGeometry(nx = 8, nz = nx) {
  return new THREE.PlaneGeometry(2, 2, nx, nz).rotateX(-Math.PI / 2);
}

// ---------------------------------------------------------------- lines made on the CPU

// The points of a ground polyline [[x, z], ...] as a flat list of x, y, z that follows the ground: every segment is
// cut into pieces no longer than `step` and every point stands `lift` over the ground under it.
//   height   (x, z) -> y           closed   also the segment from the last point back to the first
export function drapePath(points, height, { lift = 0, step = 2, closed = false, max = 4096 } = {}) {
  const out = [], n = points.length;
  if (!n) return out;
  const put = (x, z) => out.push(x, height(x, z) + lift, z);
  put(points[0][0], points[0][1]);
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = points[i], b = points[(i + 1) % n], len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const pieces = Math.max(1, Math.min(Math.ceil(len / step), Math.max(1, Math.floor((max - out.length / 3) / Math.max(1, last - i)))));
    for (let k = 1; k <= pieces; k++) put(a[0] + (b[0] - a[0]) * k / pieces, a[1] + (b[1] - a[1]) * k / pieces);
  }
  return out;
}
