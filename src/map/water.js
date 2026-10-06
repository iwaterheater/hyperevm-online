import * as THREE from 'three';

// The water: one surface at the water level, for the sea around the island and for every hollow dug below it.
// Ported from the Wildbrush water shader. It knows how deep it is everywhere from the same field texture the grass
// reads (R = the height of the ground), and from that depth come the colour, the transparency at the shore, the foam
// that laps at the beach and how high the waves may rise. Sun and sky are taken from the lights of the scene that
// draws it, so it follows the mood of the place - and the editor's plain light.

const NEAR = 720;        // side of the finely divided middle that carries the waves; it follows the camera
const SEGMENTS = 144;    // quads per side of it: 5 units each
const FAR = 3000;        // the flat skirt reaches this far in every direction
const STEP = NEAR / SEGMENTS;

const COMMON = /* glsl */`
uniform float uTime;
uniform vec2 uWindDir;
uniform sampler2D uField;
uniform vec2 uFieldXf;
uniform float uWaterLevel;
uniform float uWaveHeight;
uniform vec2 uCentre;
varying vec3 vWPos;

float wbHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
// Value noise, returns 0..1
float wbNoise2(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(wbHash12(i), wbHash12(i + vec2(1.0, 0.0)), u.x),
             mix(wbHash12(i + vec2(0.0, 1.0)), wbHash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
// How far the ground lies under the water level; beyond the ground grid the sea is deep.
float wbwDepthAt(vec2 xz) {
  vec2 uv = xz * uFieldXf.x + uFieldXf.y;
  float h = texture2D(uField, clamp(uv, vec2(0.0), vec2(1.0))).r;
  float outside = length(max(abs(uv - 0.5) - 0.5, 0.0)) / uFieldXf.x;
  return mix(uWaterLevel - h, 30.0, smoothstep(0.0, 60.0, outside));
}
vec2 wbwRot(vec2 d, float a) { float c = cos(a), s = sin(a); return vec2(c * d.x - s * d.y, s * d.x + c * d.y); }
// Sum of wind-aligned sines. Returns (height, dh/dx, dh/dz).
vec3 wbwWaves(vec2 p, float t) {
  vec2 w = normalize(uWindDir + vec2(1e-4));
  vec3 acc = vec3(0.0);
  vec2 d; float k; float a; float ph;
  d = w;                   k = 0.16; a = 0.34; ph = dot(d, p) * k + t * 1.25;
  acc += vec3(sin(ph) * a, cos(ph) * a * k * d);
  d = wbwRot(w, 0.55);     k = 0.29; a = 0.2;  ph = dot(d, p) * k + t * 1.69 + 1.7;
  acc += vec3(sin(ph) * a, cos(ph) * a * k * d);
  d = wbwRot(w, -0.8);     k = 0.47; a = 0.11; ph = dot(d, p) * k + t * 2.15 + 4.1;
  acc += vec3(sin(ph) * a, cos(ph) * a * k * d);
  d = wbwRot(w, 1.9);      k = 0.83; a = 0.05; ph = dot(d, p) * k + t * 2.85 + 0.6;
  acc += vec3(sin(ph) * a, cos(ph) * a * k * d);
  return acc;
}
// Waves grow with the depth - a pond stays calm, the shore is only lapped at - and die away towards the flat skirt.
float wbwWaveAmp(vec2 xz, float depth) {
  float fadeFar = 1.0 - smoothstep(240.0, 340.0, length(xz - uCentre));
  return uWaveHeight * smoothstep(0.15, 4.5, depth) * fadeFar;
}
`;

const VERTEX = /* glsl */`
#include <common>
#include <fog_pars_vertex>
${COMMON}
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float depth = wbwDepthAt(wp.xz);
  wp.y += wbwWaves(wp.xz, uTime).x * wbwWaveAmp(wp.xz, depth);
  vWPos = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAGMENT = /* glsl */`
#include <common>
#include <fog_pars_fragment>
${COMMON}
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uFoam;
uniform vec3 uHorizon;

vec2 wbwNoiseGrad(vec2 p) {
  const float e = 0.12;
  float c = wbNoise2(p);
  return vec2(wbNoise2(p + vec2(e, 0.0)) - c, wbNoise2(p + vec2(0.0, e)) - c) / e;
}

void main() {
  vec3 toCam = cameraPosition - vWPos;
  float dist = length(toCam);
  vec3 V = toCam / max(dist, 1e-4);
  vec2 xz = vWPos.xz;
  float t = uTime;
  float terrainH = uWaterLevel - wbwDepthAt(xz);
  float depth = max(vWPos.y - terrainH, 0.0);

  // Normal: analytic waves + scrolling ripples, flattened with distance
  float amp = wbwWaveAmp(xz, depth);
  vec2 grad = wbwWaves(xz, t).yz * amp;
  float near = 1.0 - smoothstep(30.0, 280.0, dist);
  vec2 wdir = normalize(uWindDir + vec2(1e-4));
  if (dist < 900.0) {
    vec2 r = wbwNoiseGrad(xz * 0.32 + wdir * t * 0.32) * 0.16;
    if (near > 0.01) r += wbwNoiseGrad(xz * 0.95 - vec2(wdir.y, -wdir.x) * t * 0.45 + 3.0) * 0.075 * near;
    grad += r * mix(0.35, 1.0, near) * (1.0 - smoothstep(500.0, 900.0, dist));
  }
  grad *= 1.0 - smoothstep(200.0, 1400.0, dist) * 0.8;
  vec3 N = normalize(vec3(-grad.x, 1.0, -grad.y));
  if (!gl_FrontFacing) N = -N;

  // Body colour by optical depth
  float vy = max(abs(V.y), 0.06);
  float optical = depth * (1.0 + 1.8 * (1.0 - vy));
  float dShade = 1.0 - exp(-optical * 0.26);
  vec3 body = mix(uShallow, uDeep, smoothstep(0.0, 1.0, dShade));
  // Brighter turquoise band over sand shallows
  body = mix(body, uShallow * 1.25, (1.0 - smoothstep(0.3, 2.5, depth)) * 0.5);

  vec3 L = normalize(uSunDir);
  float sunUp = clamp(L.y * 2.5 + 0.1, 0.0, 1.0);
  vec3 ambient = uSkyColor * 0.62;
  vec3 light = ambient + uSunColor * (0.5 * sunUp);
  body *= light;
  // Light scattering through wave crests facing away from the sun
  float sss = pow(max(dot(V, -L + vec3(0.0, 0.3, 0.0)), 0.0), 4.0) * clamp(dot(grad, -L.xz) * 2.0 + 0.3, 0.0, 1.0);
  body += uShallow * uSunColor * sss * 0.35 * sunUp;

  // Fresnel sky reflection
  vec3 R = reflect(-V, N);
  R.y = abs(R.y);
  vec3 sky = mix(uHorizon, uSkyColor * 1.08, smoothstep(0.0, 0.5, R.y));
  float ndv = max(dot(N, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  fres = clamp(fres * 1.15, 0.0, 0.95);
  vec3 col = mix(body, sky, fres);

  // Sun glints
  vec3 Hs = normalize(L + V);
  float nh = max(dot(N, Hs), 0.0);
  float spec = pow(nh, 420.0) * 7.0 + pow(nh, 70.0) * 0.22;
  col += uSunColor * spec * sunUp;

  // Shoreline foam: a ragged white edge, and bands that travel in towards the beach
  float fn = 0.5;
  float fn2 = 0.5;
  if (depth < 3.0) {
    fn = wbNoise2(xz * 0.22 + t * 0.04);
    fn2 = wbNoise2(xz * 0.8 - t * 0.12);
  }
  float edgeW = 0.22 + 0.25 * fn;
  float foamEdge = 1.0 - smoothstep(edgeW * 0.35, edgeW, depth);
  foamEdge *= smoothstep(0.25, 0.55, fn2 + foamEdge * 0.35);
  float ph = depth * 1.25 - t * 0.42 + fn * 1.1;
  float f = fract(ph);
  float band = smoothstep(0.0, 0.06, f) * (1.0 - smoothstep(0.08, 0.26, f));
  float bandFade = 1.0 - smoothstep(0.2, 2.4, depth);
  band *= bandFade * smoothstep(0.32, 0.62, fn2 + 0.25 * bandFade);
  float foam = clamp(max(foamEdge, band * 0.85), 0.0, 1.0);
  foam *= 1.0 - smoothstep(120.0, 400.0, dist) * 0.7;
  col = mix(col, uFoam * (ambient + uSunColor * 0.8 * sunUp) * 0.92, foam);

  // Alpha: soft shore transparency, more opaque with optical depth and fresnel
  float alpha = smoothstep(0.0, 0.1, depth) * mix(0.28, 1.0, smoothstep(0.0, 3.2, optical));
  alpha = max(alpha, fres * smoothstep(0.0, 0.2, depth));
  alpha = max(alpha, foam * smoothstep(0.0, 0.03, depth) * 0.95);

  // Seen from below: dim teal with a bright window toward the sky
  if (!gl_FrontFacing) {
    float win = smoothstep(0.55, 0.95, V.y * -1.0);
    col = mix(uDeep * light * 1.3, uSkyColor * 0.9, win * 0.6);
    alpha = 0.92;
  }

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

// A grid of NEAR x NEAR units around the origin, and four flat quads from its rim out to FAR.
function waterGeometry() {
  const position = [], index = [], n = SEGMENTS, half = NEAR / 2;
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) position.push(-half + i * STEP, 0, -half + j * STEP);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      index.push(a, c, b, c, d, b);
    }
  }
  const o = position.length / 3, c0 = 0, c1 = n, c2 = (n + 1) * (n + 1) - 1, c3 = n * (n + 1);
  position.push(-FAR, 0, -FAR, FAR, 0, -FAR, FAR, 0, FAR, -FAR, 0, FAR);
  index.push(o, c0, o + 1, c0, c1, o + 1, o + 1, c1, o + 2, c1, c2, o + 2, o + 2, c2, o + 3, c2, c3, o + 3, o + 3, c3, o, c3, c0, o);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setIndex(index);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), FAR * 2);
  return geometry;
}

// field, fieldXf: the uniforms { value } of the grass field (shared, so a new ground reaches the water by itself).
export function createWater(level, field, fieldXf) {
  const uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    uTime: { value: 0 },
    uWindDir: { value: new THREE.Vector2(0.8, 0.6) },
    uField: field,
    uFieldXf: fieldXf,
    uWaterLevel: { value: level },
    uWaveHeight: { value: 0.55 },
    uCentre: { value: new THREE.Vector2() },
    uSunDir: { value: new THREE.Vector3(0.5, 1, 0.35) },
    uSunColor: { value: new THREE.Color(1, 0.96, 0.86) },
    uSkyColor: { value: new THREE.Color(0.8, 0.9, 1) },
    uShallow: { value: new THREE.Color('#3fc1c9') },
    uDeep: { value: new THREE.Color('#135a7a') },
    uFoam: { value: new THREE.Color('#ffffff') },
    uHorizon: { value: new THREE.Color('#dfe9ef') },
  };
  const material = new THREE.ShaderMaterial({
    name: 'water', uniforms, vertexShader: VERTEX, fragmentShader: FRAGMENT, transparent: true, depthWrite: true, fog: true, side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(waterGeometry(), material);
  mesh.name = 'water';
  mesh.position.y = level;
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;        // after the ground and what stands on it: the shallows are see-through
  mesh.raycast = () => {};
  const dir = new THREE.Vector3(), aim = new THREE.Vector3();
  // Per camera: the waves stay under what it looks at, and the water is lit by the lights of the scene that draws it.
  mesh.onBeforeRender = (renderer, scene, camera) => {
    camera.getWorldDirection(dir);
    const reach = dir.y < -0.05 ? Math.min(200, (camera.position.y - level) / -dir.y) : 200;
    // moved in whole grid steps: the vertices slide along the waves instead of dragging them
    mesh.position.x = Math.round((camera.position.x + dir.x * reach) / STEP) * STEP;
    mesh.position.z = Math.round((camera.position.z + dir.z * reach) / STEP) * STEP;
    mesh.updateMatrixWorld();
    uniforms.uCentre.value.set(mesh.position.x, mesh.position.z);
    let sun = null, hemi = null;
    for (const child of scene.children) {
      if (!child.visible) continue;
      if (child.isDirectionalLight) sun ??= child;
      else if (child.isHemisphereLight) hemi ??= child;
    }
    if (sun) {
      uniforms.uSunDir.value.copy(sun.position).sub(aim.setFromMatrixPosition(sun.target.matrixWorld)).normalize();
      uniforms.uSunColor.value.copy(sun.color).multiplyScalar(Math.min(1.3, sun.intensity * 0.6));
    }
    if (hemi) uniforms.uSkyColor.value.copy(hemi.color).multiplyScalar(Math.min(1.2, hemi.intensity));
    if (scene.background?.isColor) uniforms.uHorizon.value.copy(scene.background).lerp(WHITE, 0.35);
  };
  return {
    mesh,
    update(time) { uniforms.uTime.value = time; },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
      mesh.removeFromParent();
    },
  };
}

const WHITE = new THREE.Color(1, 1, 1);
