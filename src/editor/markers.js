import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { MOB_TYPES, MOB_KEYS, AGGRO_R, BOSS_AGGRO_R, WANDER_R } from '../shared.js';
import { LAYER_OF, NPC_RADIUS, inShape, shapeBounds, shapeCentre, regionLabel, regionColor, hasBoss } from '../map/format.js';
import { mixText } from './spawnstats.js';

// Markers: everything of a map that is not scenery - monster spawns, chests, NPCs, regions and the start point - as
// the editor shows it, and the answer to "what is under the cursor" for those five kinds.
//
// Drawing never grows with the map: one InstancedMesh each for the spawn discs, their outlines, the threat rings, the
// pins, the facing arrows, the handles and the two chest models; one Line2 per region; one mesh for every region
// fill; ONE 2D canvas for all labels. Nothing here is a mesh per marker.
//
// Picking is analytic: the cursor is compared with projected points, segments and circles, in pixels. No ray is cast
// at a mesh, so a pick costs the same whether the markers are drawn, hidden behind a house or off screen.
//
// A pick result is { item, kind, handle, distance } as the contract says, plus two fields the viewport needs to slot
// scenery in between (the pick order is handles, pins, SCENERY, areas):
//   priority  2 = a handle of a selected marker, 3 = a pin, 5 = an outline, a label, a disc or an interior
//   part      'handle' | 'pin' | 'outline' | 'label' | 'disc' | 'interior'
// `distance` is measured from the ray origin in world units, like the distance of view.pickObject.

export const MARKER_KINDS = ['spawn', 'chest', 'npc', 'region', 'start'];
const MARKER_LAYERS = ['spawns', 'chests', 'npcs', 'regions', 'start'];
const TINT = [[1, 1, 1], [1.45, 1.45, 1.45], [2.0, 1.25, 0.45]];   // instance colour: none, hover, selected (as the view's batches)
const HANDLE_PX = 8, PIN_PX = 10, AREA_PX = 6;   // how close the cursor must come, in pixels
const PIN_HEIGHT = 30;          // a pin is this tall on screen (seen from the side), whatever the zoom
const PIN_WIDTH = 0.5;          // half width of a pin, as a share of half its height
const RING_PX = 2.5, DASH_PX = 2;   // width on screen of a disc outline and of a threat ring
const LINE_PX = [2, 3, 3.5], LINE_GAIN = [1, 1.45, 2];   // a region outline: none, hover, selected
const LABEL_FAR = 0.24;         // world units per pixel at the camera target beyond which labels are no longer stacked
const KNOB_PX = [5, 3.6, 4.6];  // radius on screen of a handle knob: region vertex, edge midpoint, radius
const MIN_DISC = 0.6;           // a spawn of radius 0 (the boss) still shows a disc one can find
const MAX_LABELS = 200;
const LABEL_H = 16, LABEL_PAD = 6, LABEL_DOT = 10, LABEL_GAP = 2, LABEL_SLOTS = 4;
const Y_FILL = 0.03, Y_DISC = 0.04, Y_RING = 0.05, Y_LINE = 0.06;   // ground overlays, stacked so that they never fight
const CHEST_MODELS = ['dungeon/chest', 'dungeon/chest_gold'];
const CHEST_SCALE = [1.3, 2];
const NPC_HEIGHT = 2;           // a townsman is about as tall as a cat
const START_COLOR = 0x4de0c0, CHEST_COLOR = 0xffc94d, GHOST_LIFT = 0.4;
const NPC_COLOR = { blacksmith: 0xff8a3d, sage: 0xa98bff, trader: 0x4dc3ff, guard: 0xc9d2da };
const KNOB_COLOR = [0xffffff, 0x8fd3ff, 0xffb84d], KNOB_RIM = 0x10151a;
// which tool, besides Select, shows and drags the handles of a kind (the viewport reports handles by the same rule)
const OWNER_TOOL = { spawn: 'spawn', start: 'start', region: 'region' };
const NONE = [];

const M = new THREE.Matrix4(), V = new THREE.Vector3(), V2 = new THREE.Vector3(), C = new THREE.Color(), WHITE = new THREE.Color(1, 1, 1);
const RAY_FROM = new THREE.Vector3(), RAY_DIR = new THREE.Vector3(), BODY = new THREE.Box3();   // the cursor ray of a pick
const noRaycast = () => {};     // markers are picked analytically: a stray scene raycast must not find their meshes

// ---------------------------------------------------------------- what a marker says (pure)

// The mob type a camp is drawn in: the highest weight, ties by MOB_KEYS order.
export function dominantType(types) {
  let best = null, weight = -Infinity;
  for (const key of MOB_KEYS) {
    if (Object.hasOwn(types, key) && types[key] > weight) { best = key; weight = types[key]; }
  }
  return best;
}

// How far from its centre a camp is dangerous: monsters stroll WANDER_R beyond the disc and notice a player from there.
export const threatRadius = (spawn) => spawn.r + WANDER_R + (hasBoss(spawn) ? BOSS_AGGRO_R : AGGRO_R);

// green -> red over levels 1..20 (the middle of the camp's range), as a hex colour
export function levelColor(lvl) {
  const t = Math.max(0, Math.min(1, ((lvl[0] + lvl[1]) / 2 - 1) / 19));
  return C.setHSL((1 - t) / 3, 0.75, 0.5, THREE.SRGBColorSpace).getHex(THREE.SRGBColorSpace);
}

export function spawnColor(spawn, byLevel = false) {
  if (byLevel) return levelColor(spawn.lvl);
  const type = dominantType(spawn.types);
  return type ? MOB_TYPES[type].color : 0xffffff;
}

const levels = (l) => (l[0] === l[1] ? `Lv ${l[0]}` : `Lv ${l[0]}–${l[1]}`);
const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

// The text next to a marker (and in the hover tip): "4x Skeleton Minion - Lv 1-2 - 14 s", "12 g - 150 s", "Blacksmith",
// "Hypercat Town", "Start" - with the real multiplication sign, middle dots and en dash.
export function markerLabel(kind, item) {
  // one type: its name; a mix: the short names with their weights ('Minion 3 : Mage 1') - the words of every panel
  if (kind === 'spawn') return `${item.count}× ${mixText(item.types)} · ${levels(item.lvl)} · ${item.respawn} s`;
  if (kind === 'chest') return `${item.gold} g · ${item.respawn} s`;
  if (kind === 'npc') return capital(item.kind);
  if (kind === 'region') return regionLabel(item);
  if (kind === 'start') return 'Start';
  if (kind === 'object') return item.m;
  return '';
}

// When the store does not know an item (a ghost, an item just removed), its fields still say what it is.
function sniff(item) {
  if (!item || typeof item !== 'object') return null;
  if ('shape' in item) return 'region';
  if ('types' in item) return 'spawn';
  if ('gold' in item) return 'chest';
  if ('kind' in item) return 'npc';
  if ('m' in item) return 'object';
  return 'r' in item ? 'start' : null;
}

function shapeArea(s) {
  if (s.type === 'circle') return Math.PI * s.r * s.r;
  let a = 0;
  for (let i = 0, p = s.points, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1];
  return Math.abs(a) / 2;
}

const rgbCache = new Map();
// a hex colour (number or '#rrggbb') as linear [r, g, b], which is what an instance colour holds
function rgb(color) {
  let v = rgbCache.get(color);
  if (!v) rgbCache.set(color, v = C.set(color).toArray());
  return v;
}
const css = (color) => (typeof color === 'string' ? color : `#${color.toString(16).padStart(6, '0')}`);

// ---------------------------------------------------------------- geometry

const flat = (g) => g.rotateX(-Math.PI / 2);   // a shape of the XY plane laid on the ground, facing up

// Marks the vertices of the inner rim of a flat ring (attribute `inner` = 1), for ringMaterial() below.
function markInner(g) {
  const p = g.attributes.position, inner = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) inner[i] = Math.hypot(p.getX(i), p.getZ(i)) < 0.999 ? 1 : 0;
  return g.setAttribute('inner', new THREE.BufferAttribute(inner, 1));
}

// The outline of a disc: the ring 0.96 .. 1, scaled per instance by the radius.
const ringGeometry = () => markInner(flat(new THREE.RingGeometry(0.96, 1, 48)));

// The threat ring: 48 segments, every other one left out - a dashed circle without a dashed material.
function dashGeometry() {
  const pos = [], inner = 0.978;
  for (let i = 0; i < 48; i += 2) {
    const a = i / 48 * Math.PI * 2, b = (i + 1) / 48 * Math.PI * 2;
    const ax = Math.cos(a), az = Math.sin(a), bx = Math.cos(b), bz = Math.sin(b);
    pos.push(ax * inner, 0, az * inner, ax, 0, az, bx, 0, bz, ax * inner, 0, az * inner, bx, 0, bz, bx * inner, 0, bz * inner);
  }
  return markInner(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)));
}

// The material of an instanced ring whose line keeps its width ON SCREEN. A ring that is only scaled by its radius is
// a hairline around a small camp seen from afar and a broad band around a large one seen from close; here the vertex
// shader pulls the inner rim to `width.x` pixels inside the outer one, whatever the radius and the zoom
// (width = Vector2(pixels, height of the canvas in pixels), shared with the caller, who keeps the height current).
// A ring too small for that becomes a filled dot. Should a later three.js lay its shader out differently, the
// replace finds nothing and the ring is simply the 0.96 .. 1 band of its geometry.
function ringMaterial(params, width) {
  const material = new THREE.MeshBasicMaterial(params);
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uRing = { value: width };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float inner;\nuniform vec2 uRing;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
  {
    vec2 ringDir = normalize(position.xz);
    float ringRadius = length(instanceMatrix[0].xyz);
    vec4 ringAt = modelViewMatrix * instanceMatrix * vec4(ringDir.x, position.y, ringDir.y, 1.0);
    float ringUnit = (isOrthographic ? 2.0 : -2.0 * ringAt.z) / (projectionMatrix[1][1] * uRing.y);   // world units per pixel there
    float ringIn = 1.0 - clamp(uRing.x * ringUnit / max(ringRadius, 1e-4), 0.0, 1.0);
    transformed.xz = ringDir * mix(1.0, ringIn, inner);
  }
#endif`);
  };
  material.customProgramCacheKey = () => 'marker-ring';
  return material;
}

// A pin: an octahedron standing on its tip, 2 units tall. Its faces are shaded in vertex colours, so it reads as a solid
// under any lighting - neutral, a mood preview - and needs no light at all.
function pinGeometry() {
  const g = new THREE.OctahedronGeometry(1, 0).scale(PIN_WIDTH, 1, PIN_WIDTH).translate(0, 1, 0);
  const p = g.attributes.position, colors = new Float32Array(p.count * 3), a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const light = new THREE.Vector3(0.35, 0.85, 0.4).normalize();
  for (let i = 0; i < p.count; i += 3) {
    a.fromBufferAttribute(p, i); b.fromBufferAttribute(p, i + 1); c.fromBufferAttribute(p, i + 2);
    const shade = 0.62 + 0.38 * (b.sub(a).cross(c.sub(a)).normalize().dot(light) * 0.5 + 0.5);
    colors.fill(shade, i * 3, i * 3 + 9);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return g;
}

// An arrow on the ground pointing along local +Z - the forward of an item at ry = 0 - starting clear of the pin.
function arrowGeometry() {
  const pos = [-0.11, 0, 0.95, 0.11, 0, 0.95, 0.11, 0, 1.6, -0.11, 0, 0.95, 0.11, 0, 1.6, -0.11, 0, 1.6, -0.36, 0, 1.6, 0.36, 0, 1.6, 0, 0, 2.25];
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
}

// ---------------------------------------------------------------- instanced batches

// One InstancedMesh that is rewritten as a whole: begin(n), n x put(), end(). It grows by replacement (three r170
// cannot resize a buffer attribute) and is never frustum culled - its instances move and r170 caches the bounding sphere.
class Batch {
  constructor(parent, geometry, material, order = 0) {
    this.parent = parent;
    this.geometry = geometry;
    this.material = material;
    this.order = order;
    this.mesh = null;
    this.i = 0;
    this._alloc(32);
  }

  _alloc(capacity) {
    const old = this.mesh, mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // the tint channel from the start: adding it later compiles another shader variant, a hitch on the first hover
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = this.order;
    mesh.visible = false;
    mesh.raycast = noRaycast;
    if (old) { old.removeFromParent(); old.dispose(); }
    this.parent.add(mesh);
    this.mesh = mesh;
  }

  begin(n) {
    if (n > this.mesh.instanceMatrix.count) this._alloc(THREE.MathUtils.ceilPowerOfTwo(n));
    this.mesh.count = n;
    this.i = 0;
  }

  put(matrix, r, g, b) {
    const mesh = this.mesh, i = this.i++;
    matrix.toArray(mesh.instanceMatrix.array, i * 16);
    const c = mesh.instanceColor.array;
    c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b;
  }

  end() {
    const mesh = this.mesh;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceColor.needsUpdate = true;
    mesh.visible = mesh.count > 0;   // an empty batch is not even a draw call
  }

  clear() {
    this.begin(0);
    this.end();
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.dispose();
  }
}

// ---------------------------------------------------------------- the screen

const distSeg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
  const t = len > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
};

// How far along the ray (from, dir - of length 1) it enters the box; 0 from inside; -1 when it misses.
function rayBox(from, dir, box) {
  let t0 = 0, t1 = Infinity;
  for (const axis of ['x', 'y', 'z']) {
    const o = from[axis], d = dir[axis], min = box.min[axis], max = box.max[axis];
    if (Math.abs(d) < 1e-12) {
      if (o < min || o > max) return -1;
      continue;
    }
    const a = (min - o) / d, b = (max - o) / d;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
    if (t0 > t1) return -1;
  }
  return t0;
}

// World -> pixels of the viewport canvas (origin at its top left corner), for one camera at one size.
class Screen {
  constructor() {
    this.m = new THREE.Matrix4();
    this.back = new THREE.Matrix4();      // pixels -> world, made when a ray is first asked for
    this.backFor = null;
    this.w = 1; this.h = 1; this.k = 1; this.ortho = false;
    this.x = 0; this.y = 0; this.d = 0;   // the last point: pixels and depth
  }

  set(camera, w, h) {
    this.m.copy(camera.matrixWorld).invert().premultiply(camera.projectionMatrix);
    this.backFor = null;
    this.w = w; this.h = h;
    this.k = camera.projectionMatrix.elements[5];
    this.ortho = !!camera.isOrthographicCamera;
    return this;
  }

  // -> false for a point behind the camera; otherwise x, y and d are set
  at(x, y, z) {
    const e = this.m.elements, w = e[3] * x + e[7] * y + e[11] * z + e[15];
    this.d = w;
    if (!(w > 1e-6)) return false;
    this.x = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w * 0.5 + 0.5) * this.w;
    this.y = (0.5 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / w * 0.5) * this.h;
    return true;
  }

  // world units that one pixel covers at depth d
  perPx(d) {
    return (this.ortho ? 2 : 2 * d) / (this.k * this.h);
  }

  // Pixels from (cx, cy) to the ground segment a-b; Infinity when it lies behind the camera. A segment that crosses the
  // camera plane is cut there first: a projected point behind the eye is mirrored and would pull the line across the screen.
  segPx(ax, az, bx, bz, cx, cy) {
    const e = this.m.elements, near = 0.01;
    const wa = e[3] * ax + e[11] * az + e[15], wb = e[3] * bx + e[11] * bz + e[15];
    if (wa < near && wb < near) return Infinity;
    if (wa < near) { const t = (near - wa) / (wb - wa); ax += (bx - ax) * t; az += (bz - az) * t; }
    else if (wb < near) { const t = (near - wb) / (wa - wb); bx += (ax - bx) * t; bz += (az - bz) * t; }
    if (!this.at(ax, 0, az)) return Infinity;
    const x0 = this.x, y0 = this.y;
    if (!this.at(bx, 0, bz)) return Infinity;
    return distSeg(cx, cy, x0, y0, this.x, this.y);
  }

  // Pixels from (cx, cy) to the ground circle. A circle is drawn as an ellipse (or worse, near the eye), so it is
  // walked: 24 chords find where it passes closest, then that stretch is walked again in 16 shorter chords - twice for
  // a camp, once more for a region hundreds of units wide, whose chords would still cut pixels off the curve.
  rimPx(x, z, r, cx, cy) {
    let from = 0, step = Math.PI * 2 / 24, n = 24, best = Infinity;
    for (let level = 0; ; level++) {
      let at = 0;
      best = Infinity;
      for (let i = 0; i < n; i++) {
        const a = from + i * step, b = a + step;
        const d = this.segPx(x + Math.cos(a) * r, z + Math.sin(a) * r, x + Math.cos(b) * r, z + Math.sin(b) * r, cx, cy);
        if (d < best) { best = d; at = i; }
      }
      // nowhere near: the chords are exact enough to say so. Otherwise look closer at the nearest chord and its neighbours
      if (best === Infinity || best > 200 || level === (r > 40 ? 2 : 1)) return best;
      from += (at - 1) * step;
      step = step * 3 / 16;
      n = 16;
    }
  }

  // How far over the ground - in world units, and generously - `px` pixels can reach around the ground point (x, z):
  // measured with the smaller of the two scales the projection has there. Infinity towards the horizon, where one
  // pixel spans any distance. It lets a pick skip every circle whose rim is nowhere near the cursor.
  reach(x, z, px) {
    if (!this.at(x, 0, z)) return Infinity;
    const x0 = this.x, y0 = this.y, h = Math.max(1e-3, 8 * this.perPx(this.d));   // a step of about 8 pixels
    if (!this.at(x + h, 0, z)) return Infinity;
    const a = (this.x - x0) / h, c = (this.y - y0) / h;
    if (!this.at(x, 0, z + h)) return Infinity;
    const b = (this.x - x0) / h, d = (this.y - y0) / h;
    // the smaller singular value of [[a, b], [c, d]]: pixels per world unit in the direction the view squeezes most
    const sum = a * a + b * b + c * c + d * d, det = a * d - b * c;
    const least = (sum - Math.sqrt(Math.max(0, sum * sum - 4 * det * det))) / 2;
    return least > 1e-6 ? 2 * px / Math.sqrt(least) : Infinity;
  }

  // The ray through the pixel (cx, cy): `from` on the near plane, `dir` of length 1. -> false when there is none.
  ray(cx, cy, from, dir) {
    if (this.backFor !== this.m) { this.back.copy(this.m).invert(); this.backFor = this.m; }
    const nx = cx / this.w * 2 - 1, ny = 1 - cy / this.h * 2;
    from.set(nx, ny, -1).applyMatrix4(this.back);
    dir.set(nx, ny, 1).applyMatrix4(this.back).sub(from);
    const len = dir.length();
    if (!(len > 0) || !Number.isFinite(len)) return false;
    dir.multiplyScalar(1 / len);
    return true;
  }

  // Pixels from (cx, cy) to the pin standing at (x, z): the segment from its tip on the ground to its top.
  pinPx(x, z, cx, cy) {
    if (!this.at(x, 0, z)) return Infinity;
    const bx = this.x, by = this.y, top = PIN_HEIGHT * this.perPx(this.d);
    if (!this.at(x, top, z)) return Math.hypot(cx - bx, cy - by);
    return distSeg(cx, cy, bx, by, this.x, this.y);
  }
}

// ---------------------------------------------------------------- Markers

export class Markers {
  // Subscribes to the store ('load', 'change', 'selection') and to ui ('layers', 'overlays', 'itemflags', and 'tool' /
  // 'preview', which decide which handles show and whether markers show at all). Everything is rebuilt lazily: an
  // event only marks what is stale, the next update() - or the next pick - brings it up to date.
  constructor(scene, ctx) {
    this.scene = scene;
    this.ctx = ctx;
    this.root = new THREE.Group();        // the viewport may hide this as a whole
    this.root.name = 'markers';
    this.group = this.root;
    this.body = new THREE.Group();        // ... and this one is ours: hidden in the game preview
    this.root.add(this.body);
    scene.add(this.root);

    this.on = { spawns: true, chests: true, npcs: true, regions: true, start: true };   // setVisible()
    this.muted = false;                   // the game preview shows the world as players see it: no markers
    this.hover = null;
    this.ghost = null;                    // { spawns, chests, npcs } of a paste preview
    this.disposed = false;

    this.dirty = true;                    // instances, tints, handles, region styles
    this.regionsDirty = true;             // the region outlines themselves
    this.placeDirty = true;               // what is sized by the camera: pins, arrows, knobs
    this.labelsDirty = true;
    this.ghostDirty = false;
    this.shown = true;                    // what _shown() said at the last update
    this.camKey = new Float64Array(21);   // the camera and canvas the screen-sized things were laid out for
    this.size = { w: 0, h: 0 };
    this.screen = new Screen();

    // ground overlays follow one depth rule: tested against the scene, never written, pulled towards the eye
    const ground = { transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false };
    const onTop = { transparent: true, depthTest: false, depthWrite: false, toneMapped: false };
    this.ringWidth = new THREE.Vector2(RING_PX, 800);   // pixels, canvas height: the uniforms of the two ring materials
    this.dashWidth = new THREE.Vector2(DASH_PX, 800);
    this.materials = {
      disc: new THREE.MeshBasicMaterial({ ...ground, opacity: 0.18 }),
      ring: ringMaterial({ ...ground, opacity: 0.95, side: THREE.DoubleSide }, this.ringWidth),
      dash: ringMaterial({ ...ground, opacity: 0.8, side: THREE.DoubleSide }, this.dashWidth),
      arrow: new THREE.MeshBasicMaterial({ ...ground, opacity: 0.95, side: THREE.DoubleSide }),
      fill: new THREE.MeshBasicMaterial({ ...ground, opacity: 0.16, vertexColors: true, side: THREE.DoubleSide }),
      // pins and knobs are drawn over the scene: a marker behind a house must still be found, and the pick is analytic anyway
      pin: new THREE.MeshBasicMaterial({ ...onTop, vertexColors: true }),
      knob: new THREE.MeshBasicMaterial({ ...onTop }),
      ghostPin: new THREE.MeshBasicMaterial({ ...onTop, vertexColors: true, opacity: 0.55 }),
      // region outlines: the colour of a region is in its vertices, so three materials - none, hover, selected - serve
      // every region and a state change is only a swap. A hovered or selected outline is wider and brighter in its OWN
      // colour: the orange of the instance tint would turn a blue lake outline into mud.
      lines: LINE_GAIN.map((gain, state) => new LineMaterial({
        color: new THREE.Color(gain, gain, gain), linewidth: LINE_PX[state], vertexColors: true, ...ground,
      })),
    };
    this.geometries = {
      disc: flat(new THREE.CircleGeometry(1, 48)),
      ring: ringGeometry(),
      dash: dashGeometry(),
      pin: pinGeometry(),
      arrow: arrowGeometry(),
      knob: new THREE.IcosahedronGeometry(1, 1),
    };
    const { materials: m, geometries: g } = this;
    this.discs = new Batch(this.body, g.disc, m.disc, 1);
    this.rings = new Batch(this.body, g.ring, m.ring, 2);
    this.threats = new Batch(this.body, g.dash, m.dash, 2);
    this.arrows = new Batch(this.body, g.arrow, m.arrow, 3);
    this.pins = new Batch(this.body, g.pin, m.pin, 20);
    this.knobs = new Batch(this.body, g.knob, m.knob, 22);
    this.chests = [null, null];           // batches of the two chest models, once the models are there
    this.chestModels = [null, null];
    this.chestAsked = false;
    this.ghosts = null;                   // the batches of a paste preview, made when the first one is shown

    this.lines = [];                      // [{ region, line, state }] - one Line2 per visible region
    this.fill = null;                     // one mesh for the translucent fill of every selected or hovered region
    this.fillKey = null;                  // which regions it covers, in which state; null = build it anew

    // what the camera-sized instances stand for; filled by _rebuild(), placed by _place()
    this.pinList = [];                    // [{ x, z, r, g, b }]
    this.arrowList = [];                  // [{ x, z, ry, r, g, b }]
    this.knobList = [];                   // [{ x, z, type }]

    this.canvas = null;                   // canvas.labels
    this.g2d = null;
    this.font = '';
    this.widths = new Map();              // label text -> its width in pixels
    this.labelRects = [];                 // [{ item, kind, x0, y0, x1, y1 }] of the labels on screen, for picking

    const { store, ui } = ctx;
    this.off = [
      store.on('load', () => { this.hover = null; this._stale(true); }),
      store.on('change', (change) => this._changed(change)),
      store.on('selection', () => this._stale()),
      ui.on('layers', () => this._layers()),
      ui.on('overlays', () => this._stale()),
      ui.on('itemflags', () => this._stale(true)),
      ui.on('tool', () => this._stale()),
      ui.on('preview', () => this._preview()),
    ];
    this._layers();
    this._preview();
    this._loadChests();
  }

  // ---------------------------------------------------------------- picking

  // What a click along the ray would pick among the markers - in the order: a handle of a selected marker (8 px), a pin
  // (10 px, nearest first), the body of a chest, an outline or a label (6 px), a disc or an interior under the ground
  // point - or null.
  // Scenery belongs between the pins and the outlines; `priority` in the result tells the caller on which side it is:
  // 2 a handle, 3 a pin, 4 the body of a chest (part 'body': it stands among the scenery, and of the two the one
  // nearer to the eye is the pick - `distance` says how far the ray went), 5 everything else.
  //   kinds      the kinds that may be picked
  //   interiors  'none' | 'selected' (the disc / interior of an already selected spawn / region, smallest first)
  //              | 'all' (every spawn disc, smallest first; a region interior is never a pick then)
  //   handles    the handle types to report: 'radius' | 'vertex' | 'edge'
  // Only what is drawn, on a visible unlocked layer and not flagged, is ever picked (ui.isPickable).
  pick(raycaster, ground, { kinds = MARKER_KINDS, interiors = 'none', handles = ['radius'] } = {}) {
    const camera = raycaster.camera ?? this.ctx.viewport?.camera;
    if (!camera || !this._sync(camera) || !this._measure()) return null;
    const { origin, direction } = raycaster.ray, sc = this.screen.set(camera, this.size.w, this.size.h);
    if (!sc.at(origin.x + direction.x, origin.y + direction.y, origin.z + direction.z)) return null;   // where the cursor is
    const found = this._scan(sc.x, sc.y, origin, ground, kinds, interiors, handles);
    return found.handle ?? found.pins[0] ?? found.bodies[0] ?? found.edges[0] ?? found.areas[0] ?? null;
  }

  // Every pickable marker under the cursor (client pixels), in pick order and each one once: pins, chests hit in the
  // body, then outlines and labels, then the spawn discs over the ground point, smallest first. Region interiors are left out: a region that
  // covers the island would sit in every stack.
  stack(ground, sx, sy, { kinds = MARKER_KINDS, interiors = 'all' } = {}) {
    const camera = this.ctx.viewport?.camera;
    if (!camera || !this._sync(camera) || !this._measure()) return [];
    camera.updateMatrixWorld();
    const rect = this._dom()?.getBoundingClientRect?.() ?? { left: 0, top: 0 };
    const e = camera.matrixWorld.elements, eye = { x: e[12], y: e[13], z: e[14] };
    this.screen.set(camera, this.size.w, this.size.h);
    const found = this._scan(sx - rect.left, sy - rect.top, eye, ground, kinds, interiors, NONE);
    const seen = new Set(), out = [];
    for (const f of [...found.pins, ...found.bodies, ...found.edges, ...found.areas]) {
      if (seen.has(f.item)) continue;
      seen.add(f.item);
      out.push({ item: f.item, kind: f.kind, priority: f.priority, part: f.part });
    }
    return out;
  }

  // The work behind pick() and stack(): every candidate of every stage, each stage in its own order.
  // (cx, cy) is the cursor in canvas pixels; this.screen is set for the camera.
  _scan(cx, cy, eye, ground, kinds, interiors, handles) {
    const out = { handle: null, pins: [], bodies: [], edges: [], areas: [] };
    const { store, ui } = this.ctx, map = store.map;
    if (!map || !this._shown()) return out;
    const sc = this.screen, sel = store.selection;
    const want = (kind) => kinds.includes(kind) && this.on[LAYER_OF[kind]];
    const ok = (kind, item) => (ui.isPickable ? ui.isPickable(kind, item) : true);
    const far = (x, z) => Math.hypot(eye.x - x, eye.y, eye.z - z);
    const hit = (item, kind, priority, part, px, distance, handle = null) => ({ item, kind, handle, distance, priority, part, px });
    const disc = (item) => Math.max(item.r, MIN_DISC);
    // A rim can only be under the cursor when the ground point is about one radius from the centre: that settles most
    // circles of a map with one subtraction, before any of them is walked.
    const grounded = !!ground && ground.onGround !== false;
    const reach = grounded ? sc.reach(ground.x, ground.z, HANDLE_PX + 2) : Infinity;
    const rim = (x, z, r) => (reach !== Infinity && Math.abs(Math.hypot(ground.x - x, ground.z - z) - r) > reach ? Infinity : sc.rimPx(x, z, r, cx, cy));

    // -- a handle of a selected marker
    if (handles.length && sel.size) {
      const radius = handles.includes('radius'), vertex = handles.includes('vertex'), mid = handles.includes('edge');
      let best = null;
      const offer = (item, kind, type, index, px, x, z) => {
        if (px <= HANDLE_PX && (!best || px < best.px)) best = hit(item, kind, 2, 'handle', px, far(x, z), { type, index });
      };
      for (const item of sel) {
        const kind = store.kindOf(item);
        if (!kind || kind === 'object' || kind === 'chest' || kind === 'npc' || !want(kind) || !ok(kind, item)) continue;
        if (kind === 'region') {
          const s = item.shape;
          if (s.type === 'circle') {
            if (radius) offer(item, kind, 'radius', 0, rim(s.x, s.z, s.r), s.x, s.z);
            continue;
          }
          const p = s.points;
          for (let i = 0; i < p.length; i++) {
            const [x, z] = p[i], [nx, nz] = p[(i + 1) % p.length];
            if (vertex && sc.at(x, 0, z)) offer(item, kind, 'vertex', i, Math.hypot(sc.x - cx, sc.y - cy), x, z);
            // a midpoint loses a tie against a vertex: on a short edge the two knobs touch
            if (mid && sc.at((x + nx) / 2, 0, (z + nz) / 2)) offer(item, kind, 'edge', i, Math.hypot(sc.x - cx, sc.y - cy) + 0.01, (x + nx) / 2, (z + nz) / 2);
          }
        } else if (radius) {
          // the pin of a small camp stands on its own rim: there the pin wins, or the camp could never be dragged
          if (sc.pinPx(item.x, item.z, cx, cy) <= PIN_PX) continue;
          offer(item, kind, 'radius', 0, rim(item.x, item.z, disc(item)), item.x, item.z);
        }
      }
      out.handle = best;
    }

    // -- pins: start, NPCs, chests, spawn centres; nearest first, in that order when two are equally near
    const pin = (item, kind) => {
      const px = sc.pinPx(item.x, item.z, cx, cy);
      if (px <= PIN_PX && ok(kind, item)) out.pins.push(hit(item, kind, 3, 'pin', px, far(item.x, item.z)));
    };
    if (want('start')) pin(map.start, 'start');
    if (want('npc')) for (const item of map.npcs) pin(item, 'npc');
    if (want('chest')) for (const item of map.chests) pin(item, 'chest');
    if (want('spawn')) for (const item of map.spawns) pin(item, 'spawn');
    out.pins.sort((a, b) => a.px - b.px);

    // -- the body of a chest. A chest is the one marker that is drawn as a model, and from close by that model is far
    // larger than the 10 px around its pin: a click on its lid is a click on the chest - not on the ground behind it,
    // where the Chest tool would put a second chest into the first.
    if (want('chest') && map.chests.length && sc.ray(cx, cy, RAY_FROM, RAY_DIR)) {
      for (const item of map.chests) {
        const t = rayBox(RAY_FROM, RAY_DIR, this.boundsOf(item, BODY));
        if (t >= 0 && ok('chest', item)) out.bodies.push(hit(item, 'chest', 4, 'body', 0, t + Math.hypot(RAY_FROM.x - eye.x, RAY_FROM.y - eye.y, RAY_FROM.z - eye.z)));
      }
      out.bodies.sort((a, b) => a.distance - b.distance);
    }

    // -- outlines and labels
    const there = ground ? far(ground.x, ground.z) : 0;
    const edge = (item, kind, part, px) => {
      if (px <= AREA_PX && ok(kind, item)) out.edges.push(hit(item, kind, 5, part, px, there));
    };
    if (want('spawn')) for (const item of map.spawns) edge(item, 'spawn', 'outline', rim(item.x, item.z, disc(item)));
    if (want('start')) edge(map.start, 'start', 'outline', rim(map.start.x, map.start.z, disc(map.start)));
    if (want('region')) {
      for (const item of map.regions) {
        const s = item.shape;
        if (s.type === 'circle') { edge(item, 'region', 'outline', rim(s.x, s.z, s.r)); continue; }
        let px = Infinity;
        for (let i = 0, p = s.points, j = p.length - 1; i < p.length; j = i++) px = Math.min(px, sc.segPx(p[j][0], p[j][1], p[i][0], p[i][1], cx, cy));
        edge(item, 'region', 'outline', px);
      }
    }
    for (const r of this.labelRects) {
      if (!want(r.kind) || store.kindOf(r.item) !== r.kind) continue;   // a label drawn for an item that has gone since
      edge(r.item, r.kind, 'label', Math.hypot(Math.max(r.x0 - cx, 0, cx - r.x1), Math.max(r.y0 - cy, 0, cy - r.y1)));
    }
    out.edges.sort((a, b) => a.px - b.px);

    // -- discs and interiors under the ground point, smallest first
    if (interiors !== 'none' && grounded) {
      const all = interiors === 'all', areas = [];
      if (want('spawn')) {
        for (const item of map.spawns) {
          if (!all && !sel.has(item)) continue;
          const r = disc(item), dx = ground.x - item.x, dz = ground.z - item.z;
          if (dx * dx + dz * dz <= r * r && ok('spawn', item)) areas.push([Math.PI * r * r, hit(item, 'spawn', 5, 'disc', 0, there)]);
        }
      }
      if (!all && want('region')) {
        for (const item of map.regions) {
          if (sel.has(item) && inShape(item.shape, ground.x, ground.z) && ok('region', item)) areas.push([shapeArea(item.shape), hit(item, 'region', 5, 'interior', 0, there)]);
        }
      }
      areas.sort((a, b) => a[0] - b[0]);
      out.areas = areas.map((a) => a[1]);
    }
    return out;
  }

  // ---------------------------------------------------------------- where a marker is

  kindOf(item) {
    return this.ctx.store.kindOf(item) ?? sniff(item);
  }

  // The text of a marker's label; the hover tip shows the same.
  labelOf(item) {
    return markerLabel(this.kindOf(item), item);
  }

  // -> { x, y, z }: the point that stands for the item in a box select and where its label hangs - the centre of a
  // marker, on the ground. (A scenery object is the view's business; given one, this answers with its origin.)
  anchorOf(item) {
    const kind = this.kindOf(item);
    if (kind === 'region') { const c = shapeCentre(item.shape); return { x: c.x, y: 0, z: c.z }; }
    return { x: item?.x ?? 0, y: kind === 'object' ? item.y ?? 0 : 0, z: item?.z ?? 0 };
  }

  // -> the world bounding box of what is drawn for the item (selection boxes, framing the camera).
  boundsOf(item, target = new THREE.Box3()) {
    const kind = this.kindOf(item);
    if (kind === 'region') {
      const b = shapeBounds(item.shape);
      return target.set(V.set(b.minX, 0, b.minZ), V2.set(b.maxX, 0.1, b.maxZ));
    }
    if (kind === 'spawn' || kind === 'start') {
      const r = Math.max(item.r, MIN_DISC);
      return target.set(V.set(item.x - r, 0, item.z - r), V2.set(item.x + r, 0.1, item.z + r));
    }
    if (kind === 'chest') {
      const i = item.big ? 1 : 0, model = this.chestModels[i];
      if (model) return target.copy(model.bounds).applyMatrix4(this._chestMatrix(item, i));
      return target.set(V.set(item.x - 0.7, 0, item.z - 0.7), V2.set(item.x + 0.7, 1.2, item.z + 0.7));
    }
    if (kind === 'npc') return target.set(V.set(item.x - NPC_RADIUS, 0, item.z - NPC_RADIUS), V2.set(item.x + NPC_RADIUS, NPC_HEIGHT, item.z + NPC_RADIUS));
    const x = item?.x ?? 0, y = item?.y ?? 0, z = item?.z ?? 0;
    return target.set(V.set(x - 0.5, y, z - 0.5), V2.set(x + 0.5, y + 1, z + 0.5));
  }

  // ---------------------------------------------------------------- what is shown

  // layer: 'spawns' | 'chests' | 'npcs' | 'regions' | 'start'. A hidden layer is neither drawn nor picked.
  setVisible(layer, on) {
    if (!Object.hasOwn(this.on, layer) || this.on[layer] === !!on) return;
    this.on[layer] = !!on;
    this._stale(layer === 'regions');
  }

  // The marker a click would pick, tinted like a hovered scenery object; anything else clears it.
  setHover(item) {
    const next = item && MARKER_KINDS.includes(this.ctx.store.kindOf(item)) ? item : null;
    if (next === this.hover) return;
    this.hover = next;
    this._stale();
  }

  // A translucent preview of markers that are NOT in the map: { spawns, chests, npcs } in runtime form, or null.
  // Never picked, never labelled. The paste tool calls this on every pointer move.
  setGhost(items) {
    const some = items && ((items.spawns?.length ?? 0) + (items.chests?.length ?? 0) + (items.npcs?.length ?? 0)) > 0;
    if (!some && !this.ghost) return;
    this.ghost = some ? items : null;
    this.ghostDirty = true;
    this._invalidate();
  }

  // Once per rendered frame: brings the instances up to date with the map, keeps pins, arrows and knobs at their size
  // on screen, and redraws the labels - the last two only when the camera, the canvas or the data changed.
  update(dt, camera = this.ctx.viewport?.camera) {
    if (camera) this._sync(camera);
    else if (!this.disposed) this._flush();
  }

  // Everything a frame AND a pick depend on, brought up to date for `camera`: the instances, what is sized by the
  // camera, and the label rectangles. A pick may come before the frame that follows a camera move (a click right after
  // a jump, a script, a tab whose frames are throttled): the labels of the frame before are then somewhere else on
  // screen, and a click on bare ground would pick whatever label used to be there. -> false when disposed.
  _sync(camera) {
    if (this.disposed) return false;
    this._flush();
    const shown = this._shown(), moved = this._moved(camera) || shown !== this.shown;
    this.shown = shown;
    if (moved || this.placeDirty) {
      this.placeDirty = false;
      this._place(camera);
    }
    if (moved || this.ghostDirty) {
      this.ghostDirty = false;
      this._placeGhost();
    }
    if (moved || this.labelsDirty) {
      this.labelsDirty = false;
      this._drawLabels();
    }
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.off) off?.();
    for (const batch of [this.discs, this.rings, this.threats, this.arrows, this.pins, this.knobs, ...this.chests]) batch?.dispose();
    this._dropGhosts();
    this._dropLines();
    if (this.fill) { this.fill.geometry.dispose(); this.fill.removeFromParent(); }
    for (const g of Object.values(this.geometries)) g.dispose();
    for (const m of Object.values(this.materials)) for (const one of [m].flat()) one.dispose();
    this.root.removeFromParent();
    if (this.g2d && this.canvas) this.g2d.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  // ================================================================ internals

  _invalidate() {
    this.ctx.viewport?.invalidate?.();
  }

  // Something changed: the instances are rebuilt before the next frame or pick. regions: the outlines too.
  _stale(regions = false) {
    this.dirty = true;
    if (regions) this.regionsDirty = true;
    this._invalidate();
  }

  // A store change: only what touches a marker makes work here (a scatter stroke or a terrain stroke does not).
  _changed(change) {
    const touched = (key) => !change || change.added?.[key]?.length || change.removed?.[key]?.length || change.updated?.[key]?.length;
    const regions = touched('regions') || !change || change.order?.includes('regions') || change.props?.includes('fallback');
    if (regions || touched('spawns') || touched('chests') || touched('npcs') || touched('start')) this._stale(!!regions);
  }

  _layers() {
    const layers = this.ctx.ui.layers ?? {};
    for (const layer of MARKER_LAYERS) this.setVisible(layer, layers[layer]?.visible !== false);
    this._stale();   // a lock changes which handles show
  }

  _preview() {
    this.muted = this.ctx.ui.preview === 'game';
    this.body.visible = !this.muted;
    this.labelsDirty = true;
    this._invalidate();
  }

  _shown() {
    return !this.muted && this.root.visible;
  }

  _dom() {
    const vp = this.ctx.viewport;
    return vp?.dom ?? vp?.renderer?.domElement ?? null;
  }

  // Reads the size of the viewport canvas in CSS pixels. -> false while it has none (a hidden tab, before layout).
  _measure() {
    const dom = this._dom();
    this.size.w = dom?.clientWidth ?? 0;
    this.size.h = dom?.clientHeight ?? 0;
    return this.size.w > 0 && this.size.h > 0;
  }

  // -> true when the camera or the canvas is not what the screen-sized things were laid out for.
  _moved(camera) {
    camera.updateMatrixWorld();
    this._measure();
    const key = this.camKey, e = camera.matrixWorld.elements, p = camera.projectionMatrix.elements;
    const dpr = globalThis.devicePixelRatio || 1;
    let same = key[16] === p[0] && key[17] === p[5] && key[18] === this.size.w && key[19] === this.size.h && key[20] === dpr;
    for (let i = 0; i < 16 && same; i++) same = key[i] === e[i];
    if (same) return false;
    key.set(e);
    key[16] = p[0]; key[17] = p[5]; key[18] = this.size.w; key[19] = this.size.h; key[20] = dpr;
    for (const m of this.materials.lines) m.resolution.set(this.size.w || 1, this.size.h || 1);
    this.ringWidth.y = this.dashWidth.y = this.size.h || 1;
    this.screen.set(camera, this.size.w || 1, this.size.h || 1);
    return true;
  }

  _flush() {
    if (this.disposed) return;
    if (this.regionsDirty) {
      this.regionsDirty = false;
      this.dirty = true;
      this._rebuildRegions();
    }
    if (this.dirty) {
      this.dirty = false;
      this._rebuild();
    }
  }

  // The chest models come from the view's cache: shared and read-only, so nothing of them is ever disposed here.
  _loadChests() {
    const view = this.ctx.view;
    if (this.chestAsked || typeof view?.loadModel !== 'function') return;
    this.chestAsked = true;
    CHEST_MODELS.forEach((id, i) => {
      view.loadModel(id).then((model) => {
        if (this.disposed || !model?.geometry) return;
        this.chestModels[i] = model;
        this.chests[i] = new Batch(this.body, model.geometry, model.material, 0);
        this.ghostDirty = !!this.ghost;
        this._stale();
      }, () => {});
    });
  }

  _chestMatrix(item, i, target = M) {
    const k = CHEST_SCALE[i];
    return target.makeRotationY(item.ry ?? 0).scale(V.set(k, k, k)).setPosition(item.x, 0, item.z);
  }

  _state(item) {
    return this.ctx.store.selection.has(item) ? 2 : item === this.hover ? 1 : 0;
  }

  // Which handles of a selected item are live with the active tool: 0 none, 1 the radius, 2 radius, vertices and edges.
  _handles(kind) {
    const tool = this.ctx.ui.tool;
    if (tool === OWNER_TOOL[kind]) return kind === 'region' ? 2 : 1;
    return tool === 'select' ? 1 : 0;
  }

  // Rewrites every instance from the map: discs, outlines, threat rings, chest models; and lists what _place() sizes
  // by the camera. A few hundred matrices at most - cheaper than tracking which marker moved.
  _rebuild() {
    this._loadChests();
    const { store, ui } = this.ctx, map = store.map, sel = store.selection;
    const pins = this.pinList, arrows = this.arrowList, knobs = this.knobList;
    pins.length = arrows.length = knobs.length = 0;
    this.placeDirty = this.labelsDirty = true;
    if (this.hover && store.kindOf(this.hover) === null) this.hover = null;   // it was deleted
    if (!map) {
      for (const batch of [this.discs, this.rings, this.threats, ...this.chests]) batch?.clear();
      this._styleRegions();
      return;
    }
    const byLevel = !!ui.overlays?.levelColors, everyThreat = !!ui.overlays?.threat;
    const editable = (kind, item) => (ui.isPickable ? ui.isPickable(kind, item) : true);
    const spawns = this.on.spawns ? map.spawns : NONE, chests = this.on.chests ? map.chests : NONE, npcs = this.on.npcs ? map.npcs : NONE;
    const start = this.on.start ? map.start : null;
    const tinted = (color, state, out) => {
      const c = rgb(color), t = TINT[state];
      out.r = c[0] * t[0]; out.g = c[1] * t[1]; out.b = c[2] * t[2];
      return out;
    };
    const col = { r: 1, g: 1, b: 1 };
    const rim = (item, kind) => {      // four knobs on the rim of a selected camp, start disc or circle region
      if (this._handles(kind) < 1 || !editable(kind, item)) return;
      const s = kind === 'region' ? item.shape : item, r = kind === 'region' ? s.r : Math.max(s.r, MIN_DISC);
      knobs.push({ x: s.x + r, z: s.z, type: 2 }, { x: s.x - r, z: s.z, type: 2 }, { x: s.x, z: s.z + r, type: 2 }, { x: s.x, z: s.z - r, type: 2 });
    };

    // discs and outlines: every camp, then the start disc
    const threats = [];
    this.discs.begin(spawns.length + (start ? 1 : 0));
    this.rings.begin(spawns.length + (start ? 1 : 0));
    const disc = (item, kind, color) => {
      const state = this._state(item), r = Math.max(item.r, MIN_DISC);
      tinted(color, state, col);
      this.discs.put(M.makeScale(r, 1, r).setPosition(item.x, Y_DISC, item.z), col.r, col.g, col.b);
      this.rings.put(M.setPosition(item.x, Y_RING, item.z), col.r, col.g, col.b);
      pins.push({ x: item.x, z: item.z, r: col.r, g: col.g, b: col.b });
      if (state === 2) rim(item, kind);
      return state;
    };
    for (const item of spawns) {
      const color = spawnColor(item, byLevel), state = disc(item, 'spawn', color);
      if (everyThreat || state === 2) threats.push(item, color);
    }
    if (start) disc(start, 'start', START_COLOR);
    this.discs.end();
    this.rings.end();

    this.threats.begin(threats.length / 2);
    for (let i = 0; i < threats.length; i += 2) {
      const item = threats[i], r = threatRadius(item), c = rgb(threats[i + 1]);
      this.threats.put(M.makeScale(r, 1, r).setPosition(item.x, Y_RING, item.z), c[0], c[1], c[2]);
    }
    this.threats.end();

    // chests: the real model facing ry, a pin over it, an arrow in front
    let plain = 0;
    for (const item of chests) if (!item.big) plain++;
    this.chests[0]?.begin(plain);
    this.chests[1]?.begin(chests.length - plain);
    for (const item of chests) {
      const state = this._state(item), i = item.big ? 1 : 0, t = TINT[state];
      this.chests[i]?.put(this._chestMatrix(item, i), t[0], t[1], t[2]);
      tinted(CHEST_COLOR, state, col);
      pins.push({ x: item.x, z: item.z, r: col.r, g: col.g, b: col.b });
      arrows.push({ x: item.x, z: item.z, ry: item.ry, r: col.r, g: col.g, b: col.b });
    }
    this.chests[0]?.end();
    this.chests[1]?.end();

    // NPCs are symbols: a pin in the colour of the trade and an arrow. Their skinned models stay in the game.
    for (const item of npcs) {
      tinted(NPC_COLOR[item.kind] ?? 0xffffff, this._state(item), col);
      pins.push({ x: item.x, z: item.z, r: col.r, g: col.g, b: col.b });
      arrows.push({ x: item.x, z: item.z, ry: item.ry, r: col.r, g: col.g, b: col.b });
    }

    // regions: the handles of the selected ones; outline width, colour state and fill
    for (const { region } of this.lines) {
      if (!sel.has(region)) continue;
      const s = region.shape;
      if (s.type === 'circle') { rim(region, 'region'); continue; }
      if (this._handles('region') < 2 || !editable('region', region)) continue;
      for (let i = 0, p = s.points; i < p.length; i++) {
        const n = p[(i + 1) % p.length];
        knobs.push({ x: (p[i][0] + n[0]) / 2, z: (p[i][1] + n[1]) / 2, type: 1 });
      }
      for (const p of s.points) knobs.push({ x: p[0], z: p[1], type: 0 });   // after the midpoints: drawn over them
    }
    this._styleRegions();
  }

  // Pins, arrows and knobs keep their size on screen: their scale follows the depth of each one. Every rendered frame
  // in which the camera moved.
  _place() {
    const sc = this.screen, unit = PIN_HEIGHT / 2, dark = rgb(KNOB_RIM);
    // A pin is two instances, a dark one a little larger under the coloured one: drawn without a depth test, the later
    // instance lands on top, and the dark rim keeps a pink pin readable on a pink disc.
    this.pins.begin(this.pinList.length * 2);
    for (const p of this.pinList) {
      const s = sc.at(p.x, 0, p.z) ? unit * sc.perPx(sc.d) : 0;
      this.pins.put(M.makeScale(s * 1.34, s * 1.17, s * 1.34).setPosition(p.x, -0.17 * s, p.z), dark[0], dark[1], dark[2]);
      this.pins.put(M.makeScale(s, s, s).setPosition(p.x, 0, p.z), p.r, p.g, p.b);
    }
    this.pins.end();

    this.arrows.begin(this.arrowList.length);
    for (const a of this.arrowList) {
      // never smaller than life: close up an arrow is a metre long, from afar it keeps up with its pin
      const s = sc.at(a.x, 0, a.z) ? Math.max(1, unit * sc.perPx(sc.d) * 0.9) : 0;
      this.arrows.put(M.makeRotationY(a.ry).scale(V.set(s, s, s)).setPosition(a.x, Y_RING, a.z), a.r, a.g, a.b);
    }
    this.arrows.end();

    // a knob has its dark rim the same way
    this.knobs.begin(this.knobList.length * 2);
    for (const k of this.knobList) {
      const s = sc.at(k.x, 0, k.z) ? KNOB_PX[k.type] * sc.perPx(sc.d) : 0, c = rgb(KNOB_COLOR[k.type]);
      this.knobs.put(M.makeScale(s * 1.4, s * 1.4, s * 1.4).setPosition(k.x, 0, k.z), dark[0], dark[1], dark[2]);
      this.knobs.put(M.makeScale(s, s, s).setPosition(k.x, 0, k.z), c[0], c[1], c[2]);
    }
    this.knobs.end();
  }

  // ---------------------------------------------------------------- regions

  _dropLines() {
    for (const { line } of this.lines) {
      line.removeFromParent();
      line.geometry.dispose();
    }
    this.lines.length = 0;
  }

  // One Line2 per region that is shown: a circle as a polyline fine enough for its size, a polygon closed.
  _rebuildRegions() {
    this._dropLines();
    this.fillKey = null;
    const { store, ui } = this.ctx, map = store.map;
    if (!map || !this.on.regions) return;
    for (const region of map.regions) {
      if (ui.itemFlag?.(region, 'hidden')) continue;
      const s = region.shape, pos = [];
      if (s.type === 'circle') {
        const n = Math.max(48, Math.min(256, Math.round(s.r * 1.5)));
        for (let i = 0; i <= n; i++) {
          const a = i / n * Math.PI * 2;
          pos.push(s.x + Math.cos(a) * s.r, Y_LINE, s.z + Math.sin(a) * s.r);
        }
      } else {
        for (const p of s.points) pos.push(p[0], Y_LINE, p[1]);
        pos.push(s.points[0][0], Y_LINE, s.points[0][1]);
      }
      // a locked region is drawn dimmer: it is there, but it will not answer a click
      const c = rgb(regionColor(map, region)), k = ui.itemFlag?.(region, 'locked') ? 0.5 : 1, colors = new Float32Array(pos.length);
      for (let i = 0; i < colors.length; i += 3) { colors[i] = c[0] * k; colors[i + 1] = c[1] * k; colors[i + 2] = c[2] * k; }
      const geometry = new LineGeometry();
      geometry.setPositions(pos);
      geometry.setColors(colors);
      const line = new Line2(geometry, this.materials.lines[0]);
      line.renderOrder = 4;
      line.raycast = noRaycast;
      this.body.add(line);
      this.lines.push({ region, line, state: 0 });
    }
  }

  // The outline of a selected or hovered region is wider and tinted; only those regions get a translucent fill.
  _styleRegions() {
    let key = '';
    for (const entry of this.lines) {
      entry.state = this._state(entry.region);
      entry.line.material = this.materials.lines[entry.state];
      entry.line.renderOrder = 4 + entry.state;
      if (entry.state) key += `${this.lines.indexOf(entry)}:${entry.state},`;
    }
    if (key === this.fillKey) return;
    this.fillKey = key;
    if (this.fill) {
      this.fill.geometry.dispose();
      this.fill.removeFromParent();
      this.fill = null;
    }
    if (!key) return;
    const map = this.ctx.store.map, pos = [], colors = [];
    const tri = (ax, az, bx, bz, cx, cz, c) => {
      pos.push(ax, Y_FILL, az, bx, Y_FILL, bz, cx, Y_FILL, cz);
      for (let i = 0; i < 3; i++) colors.push(c[0], c[1], c[2]);
    };
    for (const { region, state } of this.lines) {
      if (!state) continue;
      const s = region.shape, c = rgb(regionColor(map, region));
      if (s.type === 'circle') {
        for (let i = 0, n = 64; i < n; i++) {
          const a = i / n * Math.PI * 2, b = (i + 1) / n * Math.PI * 2;
          tri(s.x, s.z, s.x + Math.cos(a) * s.r, s.z + Math.sin(a) * s.r, s.x + Math.cos(b) * s.r, s.z + Math.sin(b) * s.r, c);
        }
      } else {
        const p = s.points, faces = THREE.ShapeUtils.triangulateShape(p.map((q) => new THREE.Vector2(q[0], q[1])), []);
        for (const [i, j, k] of faces) tri(p[i][0], p[i][1], p[j][0], p[j][1], p[k][0], p[k][1], c);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    this.fill = new THREE.Mesh(geometry, this.materials.fill);
    this.fill.renderOrder = 0;
    this.fill.frustumCulled = false;
    this.fill.raycast = noRaycast;
    this.body.add(this.fill);
  }

  // ---------------------------------------------------------------- ghost

  _dropGhosts() {
    if (!this.ghosts) return;
    const { discs, rings, pins, arrows, chests, materials } = this.ghosts;
    for (const batch of [discs, rings, pins, arrows, ...chests]) batch?.dispose();
    for (const m of materials) m.dispose();
    this.ghosts = null;
  }

  // The batches of the paste preview: the same shapes as the real markers, in meshes of their own so that a preview
  // that follows the pointer never rewrites the real ones.
  _ghostBatches() {
    if (!this.ghosts) {
      const { materials: m, geometries: g } = this;
      this.ghosts = {
        discs: new Batch(this.body, g.disc, m.disc, 1), rings: new Batch(this.body, g.ring, m.ring, 2),
        arrows: new Batch(this.body, g.arrow, m.arrow, 3), pins: new Batch(this.body, g.pin, m.ghostPin, 21),
        chests: [null, null], materials: [],
      };
    }
    const gh = this.ghosts;
    this.chestModels.forEach((model, i) => {
      if (!model || gh.chests[i]) return;
      const clone = (mat) => {   // translucent copies of the shared chest materials; these ARE ours to dispose
        const c = mat.clone();
        c.transparent = true; c.opacity = 0.55; c.depthWrite = false;
        gh.materials.push(c);
        return c;
      };
      gh.chests[i] = new Batch(this.body, model.geometry, Array.isArray(model.material) ? model.material.map(clone) : clone(model.material), 6);
    });
    return gh;
  }

  _placeGhost() {
    const ghost = this.ghost;
    if (!ghost) { this._dropGhosts(); return; }
    const gh = this._ghostBatches(), sc = this.screen, unit = PIN_HEIGHT / 2;
    const spawns = ghost.spawns ?? NONE, chests = ghost.chests ?? NONE, npcs = ghost.npcs ?? NONE;
    const byLevel = !!this.ctx.ui.overlays?.levelColors;
    const pale = (color) => C.set(color).lerp(WHITE, GHOST_LIFT);   // lighter than the real thing

    gh.discs.begin(spawns.length);
    gh.rings.begin(spawns.length);
    gh.pins.begin(spawns.length + chests.length + npcs.length);
    gh.arrows.begin(chests.length + npcs.length);
    const pin = (item, c) => {
      const s = sc.at(item.x, 0, item.z) ? unit * sc.perPx(sc.d) : 0;
      gh.pins.put(M.makeScale(s, s, s).setPosition(item.x, 0, item.z), c.r, c.g, c.b);
      return s;
    };
    const arrow = (item, s, c) => {
      const k = Math.max(1, s * 0.9);
      gh.arrows.put(M.makeRotationY(item.ry ?? 0).scale(V.set(k, k, k)).setPosition(item.x, Y_RING, item.z), c.r, c.g, c.b);
    };
    for (const item of spawns) {
      const c = pale(spawnColor(item, byLevel)), r = Math.max(item.r, MIN_DISC);
      gh.discs.put(M.makeScale(r, 1, r).setPosition(item.x, Y_DISC, item.z), c.r, c.g, c.b);
      gh.rings.put(M.setPosition(item.x, Y_RING, item.z), c.r, c.g, c.b);
      pin(item, c);
    }
    let plain = 0;
    for (const item of chests) if (!item.big) plain++;
    gh.chests[0]?.begin(plain);
    gh.chests[1]?.begin(chests.length - plain);
    for (const item of chests) {
      const i = item.big ? 1 : 0;
      gh.chests[i]?.put(this._chestMatrix(item, i), 1, 1, 1);
      const c = pale(CHEST_COLOR);
      arrow(item, pin(item, c), c);
    }
    for (const item of npcs) {
      const c = pale(NPC_COLOR[item.kind] ?? 0xffffff);
      arrow(item, pin(item, c), c);
    }
    for (const batch of [gh.discs, gh.rings, gh.pins, gh.arrows, ...gh.chests]) batch?.end();
  }

  // ---------------------------------------------------------------- labels

  // canvas.labels lies over the WebGL canvas. Whoever built the page may have put it there already; if not, it is made
  // here, right behind the WebGL canvas so that the readout and the tip stay on top of it.
  _canvas() {
    if (this.canvas || typeof document === 'undefined') return this.canvas;
    const dom = this._dom(), host = dom?.parentElement;
    if (!host) return null;
    let cv = host.querySelector('canvas.labels');
    if (!cv) {
      cv = document.createElement('canvas');
      cv.className = 'labels';
      dom.after(cv);
    }
    if (getComputedStyle(cv).position === 'static') cv.style.position = 'absolute';
    cv.style.pointerEvents = 'none';   // it only shows: every click belongs to the viewport under it
    this.canvas = cv;
    this.g2d = cv.getContext('2d');
    this.font = `600 11px ${getComputedStyle(cv).fontFamily || 'system-ui, sans-serif'}`;
    return cv;
  }

  // All labels in one pass over one canvas: the 200 markers nearest the camera target, selected ones first, each
  // label under its marker and moved down a line when the place is taken (dropped when four lines are).
  // No kind of label is cut off by zoom. From afar the markers crowd, and the crowd is thinned by that same rule:
  // the labels nearest the target keep their place, the ones that would cover them are left out - and there (LABEL_FAR)
  // the label of a pin is no longer moved down, because three lines below its marker it would sit on somebody else's.
  _drawLabels() {
    const cv = this._canvas(), rects = this.labelRects;
    rects.length = 0;
    if (!cv) return;
    const { w, h } = this.size, g = this.g2d, dom = this._dom();
    if (!w || !h) return;
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    cv.style.width = `${w}px`;
    cv.style.height = `${h}px`;
    cv.style.left = `${dom.offsetLeft ?? 0}px`;
    cv.style.top = `${dom.offsetTop ?? 0}px`;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const { store, ui, viewport } = this.ctx, map = store.map;
    if (!map || !this._shown() || ui.overlays?.labels === false) return;

    // who is on screen
    const sc = this.screen, target = viewport?.target ?? { x: 0, z: 0 }, list = [];
    const byLevel = !!ui.overlays?.levelColors;
    const offer = (item, kind, x, z, color) => {
      if (!sc.at(x, 0, z) || sc.x < -60 || sc.x > w + 60 || sc.y < -20 || sc.y > h + 20) return;
      const state = this._state(item);
      list.push({ item, kind, color, state, sx: sc.x, sy: sc.y, rank: state * 2 + (kind === 'region' ? 1 : 0), d: (x - target.x) ** 2 + (z - target.z) ** 2 });
    };
    if (this.on.spawns) for (const item of map.spawns) offer(item, 'spawn', item.x, item.z, spawnColor(item, byLevel));
    if (this.on.chests) for (const item of map.chests) offer(item, 'chest', item.x, item.z, CHEST_COLOR);
    if (this.on.npcs) for (const item of map.npcs) offer(item, 'npc', item.x, item.z, NPC_COLOR[item.kind] ?? 0xffffff);
    if (this.on.start) offer(map.start, 'start', map.start.x, map.start.z, START_COLOR);
    for (const { region } of this.lines) {
      const c = shapeCentre(region.shape);
      offer(region, 'region', c.x, c.z, regionColor(map, region));
    }
    list.sort((a, b) => b.rank - a.rank || a.d - b.d);
    if (list.length > MAX_LABELS) list.length = MAX_LABELS;
    const far = sc.at(target.x, 0, target.z) && sc.perPx(sc.d) > LABEL_FAR;

    // where each one goes
    g.font = this.font;
    g.textBaseline = 'middle';
    if (this.widths.size > 4000) this.widths.clear();
    const placed = [];
    for (const l of list) {
      l.text = markerLabel(l.kind, l.item);
      if (!l.text) continue;
      let tw = this.widths.get(l.text);
      if (tw === undefined) this.widths.set(l.text, tw = Math.ceil(g.measureText(l.text).width));
      const bw = tw + LABEL_PAD * 2 + LABEL_DOT, x0 = Math.round(l.sx - bw / 2);
      // a pin stands on its anchor and rises: its label hangs below. A region has no pin: its label sits on the centre.
      let y0 = Math.round(l.kind === 'region' ? l.sy - LABEL_H / 2 : l.sy + 7), free = false;
      // (regions are few, share their centres and are picked by their labels: they always get their lines)
      const slots = far && l.kind !== 'region' && l.state !== 2 ? 1 : LABEL_SLOTS;
      for (let slot = 0; slot < slots && !free; slot++) {
        free = true;
        for (const r of placed) {
          if (x0 < r.x1 && x0 + bw > r.x0 && y0 < r.y1 + LABEL_GAP && y0 + LABEL_H + LABEL_GAP > r.y0) { free = false; break; }
        }
        if (!free) y0 += LABEL_H + LABEL_GAP;
      }
      if (!free && l.state !== 2) continue;   // a crowd: the nearer labels have the room; a selected one is always shown
      l.x0 = x0; l.y0 = y0; l.x1 = x0 + bw; l.y1 = y0 + LABEL_H;
      placed.push(l);
      rects.push({ item: l.item, kind: l.kind, x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1 });
    }

    // draw, the important ones last so that they end up on top
    for (let i = placed.length - 1; i >= 0; i--) {
      const l = placed[i], cy = l.y0 + LABEL_H / 2, dot = l.x0 + LABEL_PAD + 3;
      g.beginPath();
      if (g.roundRect) g.roundRect(l.x0, l.y0, l.x1 - l.x0, LABEL_H, 4);
      else g.rect(l.x0, l.y0, l.x1 - l.x0, LABEL_H);
      g.fillStyle = 'rgba(16, 21, 26, 0.78)';
      g.fill();
      if (l.state) {
        g.lineWidth = 1;
        g.strokeStyle = l.state === 2 ? '#ffb84d' : 'rgba(255, 255, 255, 0.7)';
        g.stroke();
      }
      g.beginPath();
      g.arc(dot, cy, l.kind === 'chest' ? 4 : 3, 0, Math.PI * 2);
      g.fillStyle = css(l.color);
      g.fill();
      if (l.kind === 'chest') {   // the coin: a gold disc with a rim
        g.lineWidth = 1;
        g.strokeStyle = '#8a6412';
        g.stroke();
      }
      g.fillStyle = l.state === 2 ? '#ffd9a0' : '#e9eef3';
      g.fillText(l.text, l.x0 + LABEL_PAD + LABEL_DOT, cy + 0.5);
    }
  }
}
