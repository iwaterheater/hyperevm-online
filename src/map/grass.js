import * as THREE from 'three';

// Blade grass, ported from the Wildbrush meadow shader. Nothing is stored per blade: every blade is an instance whose
// place, shape and colour the vertex shader works out from its number alone, so a meadow of a quarter of a million
// blades costs four draw calls and no memory. Four rings of blades lie around the point the camera looks at - fine and
// dense close by, coarse and wide far away.
// What grows where comes from the field: one texel per ground vertex, written by MapView from the ground types
// (R = the height of the ground, G = how densely grass grows, B = how dry it is). The view owns the group; lights,
// fog and shadows are the scene's.

// spacing: world units between blades; radius: how far the ring reaches; segs: quads per blade; faceCam: how much a
// blade turns its flat side to the camera (far blades must, or they vanish edge-on)
const RINGS = [
  { spacing: 0.125, radius: 12, segs: 4, width: 0.065, faceCam: 0.3 },
  { spacing: 0.25, radius: 25, segs: 3, width: 0.1, faceCam: 0.5 },
  { spacing: 0.52, radius: 50, segs: 3, width: 0.17, faceCam: 0.85 },
  { spacing: 1.1, radius: 95, segs: 2, width: 0.3, faceCam: 1 },
];
const LOOK_MAX = 60;      // the rings never sit further than this in front of the camera
const HIDE_ABOVE = 190;   // camera further than this from the rings' centre: blades are smaller than a pixel, draw none
const FAR_AWAY = new THREE.Vector3(0, -1e4, 0);

const PARS = /* glsl */`
uniform float uTime;
uniform vec2 uWindDir;
uniform float uWindStrength;
uniform vec3 uPlayerPos;
uniform sampler2D uField;
uniform vec2 uFieldXf;
uniform vec2 uGCentre;
uniform float uGSpacing;
uniform vec4 uGRect;
uniform float uGRadius;
uniform float uGRing;
uniform float uGWidth;
uniform float uGFaceCam;
uniform float uGHeight;
uniform vec3 uGRoot;
uniform vec3 uGMid;
uniform vec3 uGTip;
uniform vec3 uGDryRoot;
uniform vec3 uGDryTip;
varying vec3 vGCol;
varying float vVegTrans;
varying float vVegAO;
`;

const VERTEX_PARS = /* glsl */`
float wbHash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 wbHash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
// Value noise, returns 0..1
float wbNoise2(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(wbHash12(i), wbHash12(i + vec2(1.0, 0.0)), u.x),
             mix(wbHash12(i + vec2(0.0, 1.0)), wbHash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
// R ground height, G grass density, B dryness
vec4 vegField(vec2 xz) { return texture(uField, xz * uFieldXf.x + uFieldXf.y); }

uvec4 vegPcg4(uvec4 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  v ^= v >> 16u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  return v;
}
vec4 vegRand4(uvec4 v) { return vec4(vegPcg4(v)) * (1.0 / 4294967296.0); }

vec2 vegWindDir() {
  float l = length(uWindDir);
  return l > 1e-4 ? uWindDir / l : vec2(1.0, 0.0);
}
// Rolling gust waves travelling across the island with the wind (0..1).
float vegGust(vec2 xz) {
  vec2 wd = vegWindDir();
  vec2 pd = vec2(-wd.y, wd.x);
  float speed = 3.5 + uWindStrength * 6.0;
  float along = dot(xz, wd) - uTime * speed;
  float across = dot(xz, pd);
  // long fronts perpendicular to the wind + breakup
  float n1 = wbNoise2(vec2(along * 0.045, across * 0.018));
  float n2 = wbNoise2(vec2(along * 0.11, across * 0.06) + 13.7);
  float band = 0.5 + 0.5 * sin(along * 0.085 + n2 * 3.0);
  float g = n1 * 0.55 + band * band * 0.45 + (n2 - 0.5) * 0.25;
  return smoothstep(0.3, 0.85, g);
}
`;

// Runs where the normal is set up; leaves the blade vertex in vegPos and its world normal in objectNormal.
const VERTEX_BLADE = /* glsl */`
vec3 vegPos = vec3(0.0, -1000.0, 0.0);
vec3 vegN = vec3(0.0, 1.0, 0.0);
vGCol = vec3(0.0); vVegTrans = 0.0; vVegAO = 1.0;
{
  int gw = max(int(uGRect.z + 0.5), 1);
  int gid = gl_InstanceID;
  ivec2 ci = ivec2(int(floor(uGRect.x + 0.5)), int(floor(uGRect.y + 0.5))) + ivec2(gid % gw, gid / gw);
  uvec4 hs = uvec4(uvec2(ci + ivec2(65536)), uint(uGRing) * 7919u + 3u, 17u);
  vec4 r1 = vegRand4(hs);
  vec4 r2 = vegRand4(hs + uvec4(0u, 0u, 0u, 101u));
  vec2 rootXZ = (vec2(ci) + r1.xy) * uGSpacing;
  // a ring is a disc around the point the camera looks at; its rim is ragged so no circle shows on the ground
  float dist = distance(rootXZ, uGCentre);
  float fadeR = uGRadius * mix(0.45, 1.0, r1.z);
  float fade = 1.0 - smoothstep(fadeR - uGRadius * 0.18, fadeR, dist);
  vec4 fld = vegField(rootXZ);
  float dens = fld.y;
  float keep = smoothstep(r1.w, r1.w + 0.15, dens * 1.3);
  float sc = fade * keep;
  vec3 root = vec3(rootXZ.x, fld.x - 0.04, rootXZ.y);
  vec4 clipC = projectionMatrix * (viewMatrix * vec4(root + vec3(0.0, 0.4, 0.0), 1.0));
  bool culled = sc < 0.02 || clipC.w < -2.0
    || abs(clipC.x) > clipC.w * 1.04 + 1.6 || abs(clipC.y) > clipC.w * 1.04 + 2.2;
  if (!culled) {
    // Voronoi clumps: blades in a clump share height, tint and lean away from its centre
    const float CLUMP = 1.15;
    vec2 cp = rootXZ / CLUMP;
    vec2 ic = floor(cp);
    float best = 1e9;
    vec2 bestPt = ic;
    vec2 bestId = ic;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 cell = ic + vec2(float(x), float(y));
        vec2 pt = cell + wbHash22(cell);
        vec2 dd = cp - pt;
        float d2 = dot(dd, dd);
        if (d2 < best) { best = d2; bestPt = pt; bestId = cell; }
      }
    }
    vec2 clumpC = bestPt * CLUMP;
    vec2 ch = wbHash22(bestId + 71.3);
    float clumpD = clamp(sqrt(best), 0.0, 1.0);
    // sparse ground grows in tufts around clump centres instead of evenly scattered blades
    float tuft = smoothstep(r1.w, r1.w + 0.15, dens * mix(1.3, 0.3, clumpD * (1.0 - dens)));
    sc *= tuft / max(keep, 1e-3);

    float dry = fld.z;
    float big = wbNoise2(rootXZ * 0.045 + 3.1);
    float camD = distance(root, cameraPosition);
    float far = smoothstep(14.0, 70.0, camD);
    float h = mix(0.3, 0.62, r2.x) * mix(0.72, 1.3, ch.x) * mix(1.15, 0.78, clumpD);
    h *= mix(0.45, 1.0, smoothstep(0.0, 0.75, dens));
    h *= 0.72 + 0.56 * big;
    h *= 1.0 + dry * 0.4;
    // shorter grass inside wildflower patches so the flowers show
    float fpn = wbNoise2(rootXZ * 0.06 + 5.3) * 0.7 + wbNoise2(rootXZ * 0.19 + 17.0) * 0.3;
    h *= 1.0 - smoothstep(0.5, 0.74, fpn) * 0.3;
    h *= uGHeight * (1.0 - smoothstep(40.0, 110.0, camD) * 0.35);
    h *= mix(0.15, 1.0, sc) * step(0.02, sc);
    float w = uGWidth * mix(0.75, 1.3, r2.y) * mix(0.55, 1.0, sc) * (1.0 + dry * 0.1);

    // facing
    float ang = r2.z * 6.2831853;
    vec2 fdir = vec2(cos(ang), sin(ang));
    vec2 cdir = vec2(cos(ch.y * 6.2831853), sin(ch.y * 6.2831853));
    fdir = normalize(mix(fdir, cdir, 0.4) + vec2(1e-4, 0.0));
    vec2 toCam = cameraPosition.xz - rootXZ;
    toCam /= max(length(toCam), 1e-3);
    if (dot(fdir, toCam) < 0.0) fdir = -fdir;
    fdir = normalize(mix(fdir, toCam, uGFaceCam) + vec2(1e-4, 0.0));
    vec2 side2 = vec2(-fdir.y, fdir.x);

    // bend: clump lean + rolling gusts + flutter + player push
    vec2 away = rootXZ - clumpC;
    float al = length(away);
    vec2 lean = (al > 1e-4 ? away / al : fdir) * (0.1 + 0.32 * r2.w) * h;
    float gust = vegGust(rootXZ);
    vec2 wd = vegWindDir();
    float ws = uWindStrength;
    float windAmt = (0.03 + ws * (0.14 + gust * 0.95)) * h;
    float ph = r1.x * 6.2831853 + dot(rootXZ, vec2(0.61, 0.83));
    float flutter = (sin(uTime * (3.0 + r2.x * 2.5) + ph) * 0.6 + sin(uTime * 7.3 + ph * 1.7) * 0.4)
      * (0.025 + 0.06 * ws) * h;
    vec2 bend = lean + wd * windAmt + side2 * flutter * 0.7 + wd * flutter * 0.5;
    vec2 dp = rootXZ - uPlayerPos.xz;
    float pd = length(dp);
    float push = (1.0 - smoothstep(0.2, 1.4, pd)) * (1.0 - smoothstep(1.0, 2.5, abs(root.y - uPlayerPos.y)));
    bend = mix(bend, (pd > 1e-3 ? dp / pd : wd) * h * 0.95, push * 0.9);
    float bl = min(length(bend), h * 0.95);
    bend = normalize(bend + vec2(1e-5, 0.0)) * bl;
    float tipY = sqrt(max(h * h - bl * bl * 0.9, h * h * 0.03));
    tipY *= 1.0 - push * 0.3;

    // quadratic bezier blade
    float t = position.y;
    vec3 p1 = vec3(bend.x * 0.18, tipY * 0.7, bend.y * 0.18);
    vec3 p2 = vec3(bend.x, tipY, bend.y);
    float it = 1.0 - t;
    vec3 P = 2.0 * it * t * p1 + t * t * p2;
    vec3 T = normalize(2.0 * it * p1 + 2.0 * t * (p2 - p1) + vec3(0.0, 1e-4, 0.0));
    vec3 sideV = vec3(side2.x, 0.0, side2.y);
    float wProf = w * (1.0 - pow(t, 1.35)) * (1.0 + 0.35 * sin(t * 3.14159));
    vegPos = root + P + sideV * (position.x * wProf * 0.5);
    vec3 N = normalize(cross(sideV, T));
    if (dot(N, cameraPosition - vegPos) < 0.0) N = -N;
    N = normalize(N + sideV * position.x * 0.4);
    vegN = normalize(mix(N, vec3(0.0, 1.0, 0.0), mix(0.5, 0.85, far)));

    // colour
    vec3 rootC = mix(uGRoot, uGMid * 1.08, far);
    vec3 c = mix(rootC, uGMid, smoothstep(0.0, 0.5, t));
    c = mix(c, uGTip, smoothstep(0.35, 1.0, t) * (1.0 - far * 0.35));
    // broad luminous patches (sunlit yellow-green drifts vs cooler deep green)
    float patchN = wbNoise2(rootXZ * 0.018 + 41.0);
    c = mix(c, c * vec3(1.18, 1.12, 0.72), smoothstep(0.55, 0.85, patchN) * 0.7);
    c = mix(c, c * vec3(0.8, 0.92, 0.95), smoothstep(0.4, 0.15, patchN) * 0.5);
    float hv = (ch.x - 0.5) * 1.1 + (r2.y - 0.5) * 0.5 + (big - 0.5) * 0.9;
    c = mix(c, c * vec3(1.2, 1.08, 0.6), clamp(hv, 0.0, 1.0));
    c = mix(c, c * vec3(0.82, 0.98, 1.08), clamp(-hv, 0.0, 1.0));
    c *= 0.86 + 0.26 * r1.w;
    vec3 dcol = mix(mix(uGDryRoot, uGDryTip, far * 0.5), uGDryTip, smoothstep(0.0, 1.0, t)) * (0.88 + 0.24 * r2.y);
    c = mix(c, dcol, dry);
    c *= 1.0 + gust * (0.15 + ws * 0.45) * t;
    c *= 1.0 + far * 0.12;
    vGCol = c;
    vVegTrans = smoothstep(0.1, 1.0, t);
    vVegAO = mix(mix(0.4, 1.0, smoothstep(0.0, 0.8, t)), 1.0, far);
  }
}
objectNormal = vegN;
`;

// Wrapped sunlight and a little light shining through the blade towards the viewer, instead of plain Lambert.
const FRAGMENT_LIGHT = /* glsl */`
uniform vec3 uVegTransColor;
void RE_Direct_Veg( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
  float ndl = dot( geometryNormal, directLight.direction );
  float wrapD = saturate( ( ndl + 0.6 ) / 1.6 );
  reflectedLight.directDiffuse += wrapD * directLight.color * BRDF_Lambert( material.diffuseColor );
  float back = saturate( dot( -geometryViewDir, directLight.direction ) );
  float trans = ( pow( back, 3.0 ) * 0.85 + 0.15 * saturate( -ndl ) ) * vVegTrans * 1.4;
  reflectedLight.directDiffuse += directLight.color * material.diffuseColor * uVegTransColor * trans * RECIPROCAL_PI;
}
#undef RE_Direct
#define RE_Direct RE_Direct_Veg
`;

// One blade: a strip of `segs` quads that ends in a point. x = -1 | 1 (side), y = 0..1 (along the blade).
function bladeGeometry(segs, count) {
  const position = [], index = [];
  for (let i = 0; i < segs; i++) {
    const y = (i / segs) ** 0.9;
    position.push(-1, y, 0, 1, y, 0);
  }
  position.push(0, 1, 0);
  for (let i = 0; i < segs - 1; i++) {
    const a = i * 2;
    index.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
  const a = (segs - 1) * 2;
  index.push(a, a + 1, a + 2);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setIndex(index);
  geometry.instanceCount = count;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);   // the blades are placed in the shader: never cull, never measure
  return geometry;
}

export class Grass {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'grass';
    this.size = 0;
    this.data = null;        // RGBA half floats, one texel per ground vertex
    this.stale = false;
    this.shared = {
      uTime: { value: 0 },
      uWindDir: { value: new THREE.Vector2(0.8, 0.6) },
      uWindStrength: { value: 0.45 },
      uPlayerPos: { value: FAR_AWAY.clone() },
      uField: { value: null },
      uFieldXf: { value: new THREE.Vector2(1, 0) },
      uGCentre: { value: new THREE.Vector2() },
      uGHeight: { value: 1 },
      uGRoot: { value: new THREE.Color('#41692c') },
      uGMid: { value: new THREE.Color('#74a244') },
      uGTip: { value: new THREE.Color('#b9d66c') },
      uGDryRoot: { value: new THREE.Color('#ab7f2c') },
      uGDryTip: { value: new THREE.Color('#f4cf68') },
      uVegTransColor: { value: new THREE.Color('#f2f59a') },
    };
    const centre = new THREE.Vector2(), dir = new THREE.Vector3(), corner = new THREE.Vector3();
    this.rings = RINGS.map((ring, i) => {
      const maxN = Math.ceil(2 * ring.radius / ring.spacing) + 4, rect = new THREE.Vector4(0, 0, maxN, maxN);
      const uniforms = {
        ...this.shared,
        uGSpacing: { value: ring.spacing }, uGRect: { value: rect }, uGRadius: { value: ring.radius },
        uGRing: { value: i }, uGWidth: { value: ring.width }, uGFaceCam: { value: ring.faceCam },
      };
      const material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
      material.onBeforeCompile = (shader) => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
          .replace('void main() {', `${PARS}${VERTEX_PARS}\nvoid main() {`)
          .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${VERTEX_BLADE}`)
          .replace('#include <begin_vertex>', 'vec3 transformed = vegPos;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `${PARS}\n#include <common>`)   // before the lighting code that reads the varyings
          .replace('#include <lights_lambert_pars_fragment>', `#include <lights_lambert_pars_fragment>\n${FRAGMENT_LIGHT}`)
          .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = vGCol;')
          // the vertex shader already turned the normal to the viewer: the usual flip of back faces would undo it
          .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize( vNormal );')
          .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.indirectDiffuse *= vVegAO;');
      };
      material.customProgramCacheKey = () => 'map-grass';
      const geometry = bladeGeometry(ring.segs, maxN * maxN);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `grass-ring-${i}`;
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.raycast = () => {};   // never an answer to a pick
      mesh.renderOrder = -1 + i * 0.01;
      // Every camera that draws the grass gets the blades around what IT looks at (the game, the editor, a thumbnail).
      mesh.onBeforeRender = (renderer, scene, camera) => {
        geometry.instanceCount = this._frame(camera, ring, maxN, rect, centre, dir, corner);
      };
      this.group.add(mesh);
      return mesh;
    });
  }

  // Makes the field fit a ground of size x size vertices, `cell` world units apart. Everything is bare until written.
  resize(size, cell) {
    if (this.size !== size) {
      this.shared.uField.value?.dispose();
      this.size = size;
      this.data = new Uint16Array(size * size * 4);   // half floats: heights need more than a byte, and they filter everywhere
      const field = new THREE.DataTexture(this.data, size, size, THREE.RGBAFormat, THREE.HalfFloatType);
      field.magFilter = field.minFilter = THREE.LinearFilter;   // soft meadow borders between the vertices
      field.needsUpdate = true;
      this.shared.uField.value = field;
    } else this.data.fill(0);
    // texel (ix, iz) is the vertex at ((ix - mid) * cell, (iz - mid) * cell)
    this.shared.uFieldXf.value.set(1 / (cell * size), 0.5);
    this.stale = true;
  }

  // density and dryness (0..1) of the grass at one ground vertex, and the height of the ground there
  write(ix, iz, density, dry, height = 0) {
    const i = (iz * this.size + ix) * 4, half = THREE.DataUtils.toHalfFloat;
    this.data[i] = half(height);
    this.data[i + 1] = half(Math.min(1, Math.max(0, density)));
    this.data[i + 2] = half(Math.min(1, Math.max(0, dry)));
    this.stale = true;
  }

  // Once per frame. player { x, z } | null: the blades around it lie down. ground: the height it stands on.
  update(time, player = null, ground = 0) {
    this.shared.uTime.value = time;
    if (player) this.shared.uPlayerPos.value.set(player.x, ground, player.z);
    else this.shared.uPlayerPos.value.copy(FAR_AWAY);
    if (this.stale && this.shared.uField.value) {
      this.shared.uField.value.needsUpdate = true;
      this.stale = false;
    }
  }

  // Where the ring lies for this camera, as a rectangle of blade cells -> the number of instances to draw.
  _frame(camera, ring, maxN, rect, centre, dir, corner) {
    if (!this.data) return 0;
    const eye = camera.position, s = ring.spacing;
    camera.getWorldDirection(dir);
    // the point on the ground the camera looks at; a camera that looks along the ground gets one a little ahead
    const reach = dir.y < -0.05 ? Math.min(LOOK_MAX, eye.y / -dir.y) : LOOK_MAX;
    centre.set(eye.x + dir.x * reach, eye.z + dir.z * reach);
    if (Math.hypot(centre.x - eye.x, eye.y, centre.y - eye.z) > HIDE_ABOVE) return 0;
    this.shared.uGCentre.value.copy(centre);
    let x0 = centre.x - ring.radius, x1 = centre.x + ring.radius, z0 = centre.y - ring.radius, z1 = centre.y + ring.radius;
    // no further than the ground the camera can see: the four corners of the picture, cast onto the ground
    let fx0 = Infinity, fx1 = -Infinity, fz0 = Infinity, fz1 = -Infinity;
    for (let i = 0; i < 4; i++) {
      corner.set(i & 1 ? 1 : -1, i & 2 ? 1 : -1, 0.5).unproject(camera).sub(eye).normalize();
      const t = corner.y < -0.02 ? Math.min(eye.y / -corner.y, 4 * ring.radius + LOOK_MAX) : 4 * ring.radius + LOOK_MAX;
      const x = eye.x + corner.x * t, z = eye.z + corner.z * t;
      fx0 = Math.min(fx0, x); fx1 = Math.max(fx1, x); fz0 = Math.min(fz0, z); fz1 = Math.max(fz1, z);
    }
    x0 = Math.max(x0, fx0 - 2); x1 = Math.min(x1, fx1 + 2); z0 = Math.max(z0, fz0 - 2); z1 = Math.min(z1, fz1 + 2);
    if (!(x0 < x1 && z0 < z1)) return 0;
    const cx = Math.floor(x0 / s) - 1, cz = Math.floor(z0 / s) - 1;
    const w = Math.max(1, Math.min(maxN, Math.ceil(x1 / s) + 1 - cx)), h = Math.max(1, Math.min(maxN, Math.ceil(z1 / s) + 1 - cz));
    rect.set(cx, cz, w, h);
    return w * h;
  }

  dispose() {
    for (const mesh of this.rings) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.shared.uField.value?.dispose();
    this.group.removeFromParent();
  }
}
