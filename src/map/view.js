import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GROUND_TYPES, MAX_SLOPE, NPC_RADIUS, WATER_LEVEL, groundHalf, groundX, cellHash, isBlocked, heightAt } from './format.js';
import { modelInfo, colliderOf, glowOf } from './catalog.js';
import { builtinModel } from './builtin.js';
import { Grass } from './grass.js';
import { createWater } from './water.js';

// MapView draws a map: the terrain and the sea, the scenery objects (one instanced batch per model), the grass and flowers
// that grow by themselves, the halos of lanterns and torches - and it knows what the objects block.
// The game shows the world with it. The editor also edits through it: objects are added, moved and removed one at a
// time, picked with a ray and tinted when selected. It never creates lights, fog or a background (see lighting.js).
// An object is addressed by reference: the very object inside map.objects.

const HALF_PI = Math.PI / 2;
const LIFTED = [];               // scratch: the objects whose ground moved
const MAX_LOADS = 8;            // model files in flight at once
const GRID = 8;                 // cell of the collision grid and of the origin index, world units
const BIG = 1024;               // a collider over more grid cells than this is kept in a list of its own
const PASSES = 8;               // collide(): how often a circle is pushed out of the colliders around it before it gives up
const REST = 1e-4;              // ... it has come to rest when a pass finds it no deeper than this in any of them
const INSIDE = 1e-3;            // deeper than this in a collider, a circle did not get there by walking
const TILE = 32;                // a foliage tile, ground vertices per side
const TILES_PER_FRAME = 4;      // foliage tiles regrown per update()
const REGROW_WAIT = 0.2;        // seconds without a collider change before the foliage around colliders regrows
const FOLIAGE_RANGE = 200;      // game: tiles further than this from the player are hidden (the fog ends at 150)
const FOLIAGE_EDGE = 4;         // nothing grows this close to the shore
const SHORE_TOP = WATER_LEVEL + 0.9, SHORE_BAND = 0.6;   // ground lower than the top is sand: fully so one band below it
const GRASS_FULL = 0.14;        // the tuft density of a ground type at which the blade grass is at its thickest
const GHOST_MAX = 500;
const HALO_R = 0.55;            // radius of the halo sphere; glowOf() gives the radius a halo should have
const CRYSTAL = 'builtin/crystal';
const TINT = [[1, 1, 1], [1.45, 1.45, 1.45], [2.0, 1.25, 0.45]];   // instance colour: none, hover, selected
const FLOWERS = [0xffffff, 0xffe066, 0xff8fb3, 0xb18cff].map((hex) => new THREE.Color(hex));
const RED = new THREE.Color().setRGB(1.6, 0.4, 0.4);              // a ghost that may not be placed here
// the two colours of every ground type as linear rgb: [ar, ag, ab, br, bg, bb]
const SHADES = GROUND_TYPES.map((t) => [...new THREE.Color(t.a).toArray(), ...new THREE.Color(t.b).toArray()]);
const SAND = SHADES[GROUND_TYPES.findIndex((t) => t.id === 'sand')];
const ROCK = [...new THREE.Color(0x6f6a64).toArray(), ...new THREE.Color(0x8c867d).toArray()];   // a slope too steep to walk shows as bare rock
const NONE = [];                // the colliders of an object that blocks nothing

const M = new THREE.Matrix4(), M2 = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler();
const V = new THREE.Vector3(), S = new THREE.Vector3(), W = new THREE.Vector4(), C = new THREE.Color();
const HITS = [], PROBE = new THREE.Mesh();   // PROBE stands for one instance at a time when a ray is cast

const hash = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
function noise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function grainTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#dcdcdc';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5000; i++) {
    g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.16)';
    g.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 2, 1 + Math.random() * 3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ---------------------------------------------------------------- instanced meshes

// An empty InstancedMesh with room for `capacity` instances. three r170 cannot resize a buffer attribute, so a full mesh
// is replaced, not grown: `old` hands its instances and flags to the new mesh, which takes its place in the scene.
// colors: an instanceColor from the start (adding one later compiles a new shader variant - a hitch on the first click).
function instanced(geometry, material, capacity, { dynamic = false, colors = false, old = null } = {}) {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.count = 0;
  mesh.receiveShadow = true;
  if (dynamic) mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  if (colors) {
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    if (dynamic) mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  }
  if (old) {
    mesh.instanceMatrix.array.set(old.instanceMatrix.array);
    if (colors && old.instanceColor) mesh.instanceColor.array.set(old.instanceColor.array);
    mesh.count = old.count;
    mesh.castShadow = old.castShadow;
    mesh.receiveShadow = old.receiveShadow;
    mesh.visible = old.visible;
    old.parent?.add(mesh);
    old.removeFromParent();
    old.dispose();
  }
  return mesh;
}

// After every change of an instance. In r170 frustum culling (and the stock InstancedMesh.raycast) stop at a bounding
// sphere that is computed once: without this, objects that moved out of the old sphere vanish.
function touch(mesh) {
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.boundingSphere = null;
  mesh.boundingBox = null;
}

// Takes instance i out: the last instance moves into its place. -> the index that moved (it is i now), or -1.
function swapRemove(mesh, i) {
  const last = --mesh.count;
  if (i !== last) {
    mesh.instanceMatrix.array.copyWithin(i * 16, last * 16, last * 16 + 16);
    mesh.instanceColor?.array.copyWithin(i * 3, last * 3, last * 3 + 3);
  }
  touch(mesh);
  return i !== last ? last : -1;
}

// ---------------------------------------------------------------- models

// Model = { id, info, geometry, material, bounds, size, radius, footprint, triangles, missing }
//   info       modelInfo(id) - null for an id no pack can serve
//   geometry   one merged geometry with the pack scale baked in; material: one Material, or an array with geometry.groups
//   bounds     Box3 in world units at s = 1; size: its extent; radius: the footprint radius (half the larger horizontal extent)
//   footprint  { minX, maxX, minZ, maxZ } in MODEL units - what colliderOf() measures from; null for a missing model
//   missing    true for the stand-in of a model that failed to load
// Models are shared and read-only: nobody but the view disposes them.

const infos = new Map();
function infoOf(id) {
  if (!infos.has(id)) infos.set(id, modelInfo(id));
  return infos.get(id);
}

function makeModel(id, info, geometry, material) {
  geometry.computeBoundingBox();
  const b = geometry.boundingBox, footprint = { minX: b.min.x, maxX: b.max.x, minZ: b.min.z, maxZ: b.max.z };
  if (info.scale !== 1) geometry.scale(info.scale, info.scale, info.scale);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const bounds = geometry.boundingBox.clone(), size = bounds.getSize(new THREE.Vector3());
  const triangles = (geometry.index ?? geometry.attributes.position).count / 3;
  return { id, info, geometry, material, bounds, size, radius: Math.max(size.x, size.z) / 2, footprint, triangles, missing: false };
}

// what stands in for a model that failed to load: a magenta box, 1 x 1 on the ground and 2 high
const BOX = new THREE.BoxGeometry(1, 2, 1).translate(0, 1, 0);
BOX.computeBoundingBox();
BOX.computeBoundingSphere();
const MAGENTA = new THREE.MeshBasicMaterial({ color: 0xff00ff });
const standIn = (id) => ({
  id, info: infoOf(id), geometry: BOX, material: MAGENTA,
  bounds: new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 2, 0.5)), size: new THREE.Vector3(1, 2, 1),
  radius: 0.5, footprint: null, triangles: 12, missing: true,
});
const STAND_IN = { geometry: BOX, material: MAGENTA };   // for a ghost whose model is still on its way

const free = (material) => { material.map?.dispose(); material.dispose(); };

// One mesh of a glTF scene as a geometry in the scene's frame, reduced to position / normal / uv as plain float
// attributes: parts with other attribute sets, interleaved or packed attributes cannot be merged.
function partOf(mesh) {
  const src = mesh.geometry, n = src.attributes.position.count, g = new THREE.BufferGeometry();
  for (const [name, size] of [['position', 3], ['normal', 3], ['uv', 2]]) {
    const a = src.attributes[name], array = new Float32Array(n * size);
    if (!a && name === 'normal') continue;
    if (a?.isBufferAttribute && !a.normalized && a.array instanceof Float32Array && a.itemSize === size) array.set(a.array.subarray(0, n * size));
    else if (a) for (let i = 0; i < n; i++) for (let c = 0; c < size; c++) array[i * size + c] = a.getComponent(i, c);
    g.setAttribute(name, new THREE.BufferAttribute(array, size));
  }
  if (src.index) g.setIndex(src.index.clone());
  if (!g.attributes.normal) g.computeVertexNormals();
  return g.applyMatrix4(mesh.matrixWorld);
}

// ---------------------------------------------------------------- colliders

// A collider record in world space. type 0: a circle of radius r. type 1: a box, half sizes hw x hd, turned by ry.
// ex / ez: half of its bounding rectangle. seen: the last collide() pass that tested it (a record sits in several grid cells).
const circle = (x, z, r) => ({ type: 0, x, z, r, hw: 0, hd: 0, ry: 0, cos: 1, sin: 0, ex: r, ez: r, seen: 0 });
function box({ x, z, hw, hd, ry }) {
  const cos = Math.cos(ry), sin = Math.sin(ry);
  return { type: 1, x, z, r: 0, hw, hd, ry, cos, sin, ex: Math.abs(hw * cos) + Math.abs(hd * sin), ez: Math.abs(hw * sin) + Math.abs(hd * cos), seen: 0 };
}
function records({ circles, boxes }) {
  if (!circles.length && !boxes.length) return NONE;
  return [...circles.map((c) => circle(c.x, c.z, c.r)), ...boxes.map(box)];
}

// one number per grid cell; the grid has no fixed extent, so the cells live in a Map
const cellKey = (i, j) => i * 2097152 + j;

// How deep the circle p (radius `radius`) stands in the record o: 0 when they do not touch. push: p is moved out of it.
function overlap(p, o, radius, push) {
  const dx = p.x - o.x, dz = p.z - o.z;
  if (o.type === 0) {
    const d = Math.hypot(dx, dz), min = o.r + radius;
    if (d >= min) return 0;
    if (!push) return min - d;
    if (d < 0.001) p.x += min;   // dead centre: any way out will do
    else { p.x = o.x + dx / d * min; p.z = o.z + dz / d * min; }
    return min - d;
  }
  let lx = dx * o.cos - dz * o.sin, lz = dx * o.sin + dz * o.cos;   // p in the frame of the box
  const px = o.hw + radius - Math.abs(lx), pz = o.hd + radius - Math.abs(lz);
  if (px <= 0 || pz <= 0) return 0;
  if (!push) return Math.min(px, pz);
  if (px < pz) lx = (lx < 0 ? -1 : 1) * (o.hw + radius);            // out through the nearer face
  else lz = (lz < 0 ? -1 : 1) * (o.hd + radius);
  p.x = o.x + lx * o.cos + lz * o.sin;
  p.z = o.z - lx * o.sin + lz * o.cos;
  return Math.min(px, pz);
}

// the largest squared scale in the instance matrix that starts at a[k]
const scale2 = (a, k) => Math.max(a[k] ** 2 + a[k + 1] ** 2 + a[k + 2] ** 2, a[k + 4] ** 2 + a[k + 5] ** 2 + a[k + 6] ** 2, a[k + 8] ** 2 + a[k + 9] ** 2 + a[k + 10] ** 2);

const covers = (o, x, z) => {
  const dx = x - o.x, dz = z - o.z;
  return o.type === 0 ? dx * dx + dz * dz <= o.r * o.r : Math.abs(dx * o.cos - dz * o.sin) <= o.hw && Math.abs(dx * o.sin + dz * o.cos) <= o.hd;
};

// The instance matrix of an object: T(x, y + lift, z) * Ry * Rx * Rz * S(s, s * sy, s). The pack scale is in the geometry.
// dy and dry are added to y and ry (the crystal floats and spins).
function compose(obj, dy, dry, target) {
  const info = infoOf(obj.m), lift = info ? info.lift * info.scale * obj.s * obj.sy : 0;
  V.set(obj.x, obj.y + lift + dy, obj.z);
  Q.setFromEuler(E.set(obj.rx, obj.ry + dry, obj.rz, 'YXZ'));   // tilt in the object's own frame, yaw about the world vertical
  return target.compose(V, Q, S.set(obj.s, obj.s * obj.sy, obj.s));
}

export class MapView {
  // editor: true - dynamic buffers with spare capacity, a tint channel on every batch, a magenta box for a model that
  // failed to load, no crystal animation, no distance culling of foliage. Terrain, sea and colliders are the same in both modes.
  constructor(scene, { editor = false } = {}) {
    this.scene = scene;
    this.editor = editor;
    this.map = null;
    this.ready = Promise.resolve({ missing: [] });   // the promise of the latest load()
    this.missing = new Set();                        // ids of the models that failed to load
    this.onChange = null;                            // called when the view changes the scene outside a caller's own call
    this.obstaclesVersion = 0;                       // goes up whenever a collider changes

    // ---- everything below is internal
    this.root = new THREE.Group();
    this.root.name = 'map';
    scene.add(this.root);
    this.generation = 0;           // load() counter: what an older load started is ignored
    this.disposed = false;
    this.layers = { objects: true, foliage: true, ground: true, halos: true };

    this.loader = new GLTFLoader();
    this.models = new Map();       // id -> Promise<Model>, kept across load()
    this.loaded = new Map();       // id -> Model, once it has settled
    this.materials = new Map();    // signature -> the one material kept for it
    this.queue = [];               // model files waiting for one of the MAX_LOADS places
    this.flying = 0;

    // batch = { id, model, mesh, objs /* objs[i] <-> instance i */, pending /* objects waiting for the model */, asked, dead }
    // slot  = { batch, i /* -1 while waiting */, halo /* index in the halo mesh or -1 */, state /* 0 none, 1 hover, 2 selected */,
    //           colliders, cell /* key in `origins` */ }
    this.batches = new Map();      // model id -> batch
    this.slots = new Map();        // obj -> slot
    this.waiting = 0;              // batches whose model is still in flight
    this.origins = new Map();      // grid cell -> the objects whose origin lies in it (queryCircle)
    this.crystal = null;           // game: the batch that floats and spins
    this.selected = new Set();
    this.hover = null;
    this.hidden = new Set();       // model ids switched off with setModelVisible

    this.halo = null;              // one InstancedMesh for every halo
    this.haloObjs = [];            // haloObjs[i] <-> halo instance i
    this.haloGeometry = new THREE.SphereGeometry(HALO_R, 12, 8);
    this.haloMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false });

    this.ghost = null;             // { objs, valid } while a ghost is shown
    this.ghosts = [];              // its meshes, reused
    this.ghostMaterials = new Map();   // material -> [the clone of a valid ghost, of an invalid one]
    this.ghostWait = new Set();    // model ids a ghost is waiting for

    this.npcs = [];                // the collision records of the NPCs
    this.grid = new Map();         // cellKey -> records
    this.big = [];                 // records too large for the grid
    this.gridDirty = false;
    this.stamp = 0;
    this.obs = { circles: new Float32Array(0), nCircles: 0, npcStart: 0, boxes: new Float32Array(0), nBoxes: 0 };
    this.obsVersion = -1;          // the obstaclesVersion `obs` was built for

    // full: the whole colour buffer waits for the GPU, so no update range may be added
    this.terrain = { mesh: null, sea: null, grain: null, size: 0, cell: 0, radius: -1, noise: null, base: null, color: null, full: true };
    this.tiles = [];               // foliage tiles: { tx, tz, x, z /* centre */, flowers, wait }
    this.grass = new Grass();      // the blades; a tile writes where they grow when it regrows
    this.root.add(this.grass.group);
    this.dirty = new Set();        // tiles to regrow; tile.wait: only once the colliders have been quiet
    this.stirred = false;          // a collider changed since the last update()
    this.quietAt = 0;              // since when the colliders are quiet (performance.now()), and for how much frame time
    this.quietFor = 0;
    this.focus = null;
  }

  // ---------------------------------------------------------------- loading and the frame

  // Shows `map`. -> Promise<{ missing: string[] }>: resolves when the terrain stands and every model the map uses has
  // settled; batches appear as their models arrive. A model that fails is listed and never fails the load.
  // Calling it again replaces the map: the model cache stays, selection, hover, ghost and per-model visibility are reset.
  // onProgress(done, total) per settled model.
  load(map, { onProgress = null } = {}) {
    const gen = ++this.generation;
    this._clear();
    this.map = map;
    this._terrain();
    this.setNpcObstacles(map.npcs);
    for (const obj of map.objects) if (!this.slots.has(obj)) this._add(obj);
    const ids = [...this.batches.keys()];
    for (const batch of this.batches.values()) this._request(batch);   // now, so a batch gets its exact size
    let done = 0;
    this.ready = Promise.all(ids.map((id) => this.loadModel(id).then(() => {
      if (gen === this.generation) onProgress?.(++done, ids.length);
    }))).then(() => ({ missing: ids.filter((id) => this.missing.has(id)) }));
    return this.ready;
  }

  // Once per frame. focus { x, z }: where the player is - the game hides foliage far from it.
  // -> true while work is queued (foliage tiles to regrow, models in flight for objects of this map): call again next frame.
  update(time, dt, focus = null) {
    if (!this.map) return false;
    if (this.crystal) this._float(time);
    if (this.stirred) {
      this.stirred = false;
      this.quietAt = performance.now();
      this.quietFor = 0;
    } else this.quietFor += dt > 0 ? dt : 0;
    // frame time or the clock, whichever says so first: a caller may step frames by hand, or hardly ever
    const quiet = this.quietFor >= REGROW_WAIT || performance.now() - this.quietAt >= REGROW_WAIT * 1000;
    let n = 0;
    for (const tile of this.dirty) {
      if (n === TILES_PER_FRAME) break;
      if (tile.wait && !quiet) continue;
      this.dirty.delete(tile);
      this._grow(tile);
      n++;
    }
    this.focus = focus;
    this.grass.update(time, this.editor || !focus ? null : focus, focus ? this.heightAt(focus.x, focus.z) : 0);
    this.water?.update(time);
    this._cull();
    return this.dirty.size > 0 || this.waiting > 0;
  }

  // Pushes a circle (an object with x and z) out of the scenery, the NPCs and blocked ground.
  // prev { x, z }: where it stood before the step. With it, a step that ends wedged between colliders or on blocked
  // ground is taken back; without it (or when it stood on blocked ground itself) the ground is not checked, so
  // whoever starts inside water can walk out.
  collide(p, radius = 0.4, prev = null) {
    if (!this.map) return;
    this._grid();
    // Pass after pass until one finds the circle at rest: the second next to one collider or in a corner between two
    // walls. A notch between two round colliders that barely overlap takes many - each pushes the circle back into the
    // other - and in the narrowest it never ends: step by step the circle would be squeezed through the wall.
    let deep = Infinity;
    for (let pass = 0; pass < PASSES && deep > REST; pass++) deep = this._pass(p, radius, true);
    // So a step that finds no rest is not taken - unless it began inside a collider, which has to be walked out of.
    if (deep > REST && prev && this._pass(prev, radius, false) <= INSIDE) { p.x = prev.x; p.z = prev.z; }
    if (prev && isBlocked(this.map, p.x, p.z) && !isBlocked(this.map, prev.x, prev.z)) {
      if (!isBlocked(this.map, p.x, prev.z)) p.z = prev.z;          // slide along the shore
      else if (!isBlocked(this.map, prev.x, p.z)) p.x = prev.x;
      else { p.x = prev.x; p.z = prev.z; }
    }
  }

  // Takes everything out of the scene and frees what the view made. The view is dead afterwards.
  dispose() {
    this.disposed = true;
    this.generation++;
    this._clear();
    this._dropTiles();
    this.grass.dispose();
    this.halo?.dispose();
    this.haloGeometry.dispose();
    this.haloMaterial.dispose();
    for (const pair of this.ghostMaterials.values()) for (const m of pair.flat()) m.dispose();
    const t = this.terrain;
    if (t.mesh) {
      t.mesh.geometry.dispose();
      t.mesh.material.dispose();
      t.grain.dispose();
      this.water.dispose();
    }
    for (const model of this.loaded.values()) if (!model.missing && model.info.pack !== 'builtin') model.geometry.dispose();
    for (const m of this.materials.values()) free(m);
    this.root.removeFromParent();
    this.root.clear();
    this.map = null;
    this.onChange = null;
  }

  // ---------------------------------------------------------------- objects

  // Synchronous, never throws. While the model is not loaded the object waits: it is known to the view - selection and
  // hover are remembered, queryCircle finds it, boundsOf gives a 1-unit box - and it is inserted, with its colliders and
  // halo, when the model arrives (then onChange is called). It is dropped if it was removed or load() ran in between.
  addObject(obj) {
    if (this.slots.has(obj)) return this.updateObject(obj);
    this._request(this._add(obj));
  }

  // After any field of the object changed: matrix, halo, colliders; a new obj.m moves it to the batch of that model.
  // Nothing happens for an object that still waits for its model: its transform is read when it is inserted.
  updateObject(obj) {
    const slot = this.slots.get(obj);
    if (!slot) return;
    if (slot.batch.id !== obj.m) {
      this.removeObject(obj);
      this._request(this._add(obj));
      return;
    }
    this._file(obj, slot);
    if (slot.i < 0) return;
    const mesh = slot.batch.mesh;
    compose(obj, this._gy(obj), 0, M).toArray(mesh.instanceMatrix.array, slot.i * 16);
    touch(mesh);
    this._collider(obj, slot);
    this._halo(obj, slot);
  }

  removeObject(obj) {
    const slot = this.slots.get(obj);
    if (!slot) return;
    this._forget(obj, slot);
    const batch = slot.batch;
    if (slot.i < 0) { batch.pending.delete(obj); return; }
    // swap-remove inside the batch; the order of map.objects is not the view's business
    const moved = swapRemove(batch.mesh, slot.i);
    if (moved >= 0) {
      batch.objs[slot.i] = batch.objs[moved];
      this.slots.get(batch.objs[slot.i]).i = slot.i;
    }
    batch.objs.length = batch.mesh.count;
    this._collider(obj, slot, true);
    this._halo(obj, slot, true);
  }

  // Replaces the collision circles of the NPCs (radius NPC_RADIUS each). load() calls it with map.npcs.
  setNpcObstacles(npcs) {
    for (const c of this.npcs) this._regrow(c);
    this.npcs = Array.from(npcs ?? [], (n) => circle(n.x, n.z, NPC_RADIUS));
    for (const c of this.npcs) this._regrow(c);
    this._collidersChanged();
  }

  // ---------------------------------------------------------------- terrain

  // After ground.cells or ground.heights changed inside the INCLUSIVE vertex rectangle: recolours it (and the rim that
  // blends with it), reshapes it, puts the objects that stand on it back on the ground and regrows the foliage of the
  // tiles it touches.
  repaintGround(ix0, iz0, ix1, iz1) {
    const t = this.terrain, g = this.map?.ground;
    if (!g || !t.mesh) return;
    if (g.size !== t.size || g.cell !== t.cell) return this.refresh();   // a new ground object: that is a refresh
    const last = t.size - 1;
    ix0 = Math.max(0, Math.ceil(ix0)); iz0 = Math.max(0, Math.ceil(iz0));
    ix1 = Math.min(last, Math.floor(ix1)); iz1 = Math.min(last, Math.floor(iz1));
    if (!(ix0 <= ix1 && iz0 <= iz1)) return;
    const gx0 = Math.max(0, ix0 - 1), gz0 = Math.max(0, iz0 - 1), gx1 = Math.min(last, ix1 + 1), gz1 = Math.min(last, iz1 + 1);
    this._paint(Math.max(0, ix0 - 1), Math.max(0, iz0 - 1), Math.min(last, ix1 + 1), Math.min(last, iz1 + 1));   // a height also turns its neighbours' slope
    this._shape(ix0, iz0, ix1, iz1);
    // an object stands on the surface under its origin: every cell that touches a moved vertex may have lifted one
    const x0 = groundX(g, gx0), x1 = groundX(g, gx1), z0 = groundX(g, gz0), z1 = groundX(g, gz1);
    for (const obj of this.queryCircle((x0 + x1) / 2, (z0 + z1) / 2, Math.hypot(x1 - x0, z1 - z0) / 2 + g.cell, LIFTED)) {
      if (obj.x >= x0 && obj.x <= x1 && obj.z >= z0 && obj.z <= z1) this._lift(obj);
    }
    if (t.color.updateRanges.length > 64) this._uploadAll();   // nothing is drawing the ground: stop collecting ranges
    // one span of rows over the grown rectangle: the recomputed rim must reach the GPU too
    const cx0 = Math.max(0, gx0 - 1), cz0 = Math.max(0, gz0 - 1), cx1 = Math.min(last, gx1 + 1), cz1 = Math.min(last, gz1 + 1);
    if (!t.full) t.color.addUpdateRange((cz0 * t.size + cx0) * 3, ((cz1 - cz0) * t.size + (cx1 - cx0) + 1) * 3);
    t.color.needsUpdate = true;
    this._dirtyTiles(ix0, iz0, ix1, iz1, false);
  }

  // After map.radius, map.foliage or the map.ground OBJECT changed: mesh size, heights, normals, colours, foliage.
  refresh() {
    if (this.map) this._terrain();
  }

  // ---------------------------------------------------------------- models

  // Warms the model cache; the editor passes the whole catalog in the background.
  preload(ids) {
    return Promise.all(Array.from(ids, (id) => this.loadModel(id))).then(() => {});
  }

  // -> Promise<Model>. Never rejects: a model that cannot be loaded resolves to the magenta stand-in (missing: true)
  // and its id goes into `missing`. One promise per id for the life of the view.
  loadModel(id) {
    if (!this.models.has(id) && !this._modelNow(id)) {
      this.models.set(id, this._fetch(id).then((model) => {
        this.loaded.set(id, model);
        return model;
      }));
    }
    return this.models.get(id);
  }

  // -> { minX, maxX, minZ, maxZ } in MODEL units, or null while the model is not loaded (and for one that failed).
  footprint(id) {
    return this._modelNow(id)?.footprint ?? null;
  }

  // ---------------------------------------------------------------- where an object is

  // -> target: the instance matrix of the object (the pack scale is not in it: it is baked into the geometry).
  matrixOf(obj, target = new THREE.Matrix4()) {
    return compose(obj, this._gy(obj), 0, target);
  }

  // The height of the ground under a world point (0 before a map is loaded). An object's own y is counted from it.
  heightAt(x, z) {
    return this.map ? heightAt(this.map, x, z) : 0;
  }

  // The geometry of the terrain mesh, or null before a map is loaded: vertex i is ground vertex i, with the heights
  // the terrain is drawn at. Read-only, and another object after the grid changed size - the editor lays its ground
  // overlays (grid, tints) over it as second meshes, which then lie on the ground exactly.
  get groundGeometry() {
    return this.terrain.mesh?.geometry ?? null;
  }

  _gy(obj) {
    return this.map ? heightAt(this.map, obj.x, obj.z) : 0;
  }

  // -> target: the world bounding box; a 1-unit box at the object's position while its model is not loaded.
  boundsOf(obj, target = new THREE.Box3()) {
    const model = this._modelNow(obj.m);
    if (!model) return target.setFromCenterAndSize(V.set(obj.x, obj.y + this._gy(obj), obj.z), S.set(1, 1, 1));
    return target.copy(model.bounds).applyMatrix4(compose(obj, this._gy(obj), 0, M));
  }

  // The object under a ray -> { obj, point: Vector3, distance } | null. Only the view's own batches are tested, never
  // the terrain or the foliage; a hidden layer or model is skipped; filter(obj) = false discards a hit.
  // slopPx > 0 (with viewportHeight in pixels and raycaster.camera set): when the ray hits nothing, the object whose
  // centre is nearest on screen is taken if it lies within slopPx + min(slopPx, its radius on screen) pixels - small
  // props keep a forgiving target, while bare ground inside the bounding circle of a tree stays empty ground.
  pickObject(raycaster, { slopPx = 0, viewportHeight = 0, filter = null } = {}) {
    if (!this.layers.objects) return null;
    let best = null;
    const nearer = (obj, h) => {
      if ((!best || h.distance < best.distance) && (!filter || filter(obj))) best = { obj, point: h.point, distance: h.distance };
    };
    for (const batch of this.batches.values()) if (this._pickable(batch)) this._cast(raycaster, batch, nearer);
    if (best || !(slopPx > 0 && viewportHeight > 0) || !raycaster.camera) return best;
    return this._pickNear(raycaster, slopPx, viewportHeight, filter);
  }

  // Every object the ray goes through -> [{ obj, point, distance }], nearest first, ONE entry per object (a ray crosses
  // several triangles of one tree). Precise hits only.
  pickObjects(raycaster, { filter = null } = {}) {
    const nearest = new Map();
    if (!this.layers.objects) return [];
    const collect = (obj, h) => {
      const known = nearest.get(obj);
      if ((!known || h.distance < known.distance) && (!filter || filter(obj))) nearest.set(obj, { obj, point: h.point, distance: h.distance });
    };
    for (const batch of this.batches.values()) if (this._pickable(batch)) this._cast(raycaster, batch, collect);
    return [...nearest.values()].sort((a, b) => a.distance - b.distance);
  }

  // The objects whose ORIGIN lies within r of (x, z), written into `out` (emptied first). Waiting objects count;
  // layer and model visibility do not matter.
  queryCircle(x, z, r, out = []) {
    out.length = 0;
    const r2 = r * r;
    const take = (cell) => { for (const obj of cell) if ((obj.x - x) ** 2 + (obj.z - z) ** 2 <= r2) out.push(obj); };
    const i0 = Math.floor((x - r) / GRID), i1 = Math.floor((x + r) / GRID), j0 = Math.floor((z - r) / GRID), j1 = Math.floor((z + r) / GRID);
    if (!((i1 - i0 + 1) * (j1 - j0 + 1) <= this.origins.size)) this.origins.forEach(take);   // a wide circle: every cell there is
    else {
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const cell = this.origins.get(cellKey(i, j));
          if (cell) take(cell);
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- visibility, selection, ghost

  // layer: 'objects' | 'foliage' | 'ground' (terrain and sea) | 'halos'. Halos also go when the objects go.
  // Hiding changes what is drawn and picked - never what blocks.
  setVisible(layer, on) {
    if (!Object.hasOwn(this.layers, layer)) return;
    this.layers[layer] = !!on;
    this._show();
  }

  // Hides the batch of one model and the halos of its objects; picking skips it. Every model is visible again after load().
  setModelVisible(id, on) {
    if (!on === this.hidden.has(id)) return;
    if (on) this.hidden.delete(id);
    else this.hidden.add(id);
    const batch = this.batches.get(id);
    if (!batch?.mesh) return;
    batch.mesh.visible = this.layers.objects && !!on;
    for (const obj of batch.objs) this._halo(obj, this.slots.get(obj));
  }

  // objs: Iterable<Obj>. Only what changed since the last call is touched. The tint needs the editor's colour channel.
  setSelected(objs) {
    const before = this.selected, next = this.selected = new Set(objs ?? []);
    for (const obj of before) if (!next.has(obj)) this._tint(obj);
    for (const obj of next) if (!before.has(obj)) this._tint(obj);
  }

  setHover(obj) {
    const before = this.hover;
    this.hover = obj ?? null;
    if (before === this.hover) return;
    if (before) this._tint(before);
    if (this.hover) this._tint(this.hover);
  }

  // A translucent preview of objects that are NOT in the map (Obj-shaped literals), or null to clear it. Never
  // pickable; red when `valid` is false. A model that is not loaded shows the stand-in box until it arrives.
  // At most GHOST_MAX objects are drawn.
  setGhost(objs, { valid = true } = {}) {
    this.ghost = objs && objs.length ? { objs, valid } : null;
    this._drawGhost();
  }

  // ---------------------------------------------------------------- what blocks

  // -> { circles: Float32Array /* x, z, r */, nCircles, npcStart, boxes: Float32Array /* x, z, hw, hd, ry */, nBoxes }.
  // The circles of objects come first, those of the NPCs last, from index npcStart (= nCircles when there are none).
  // The result and its arrays are reused between calls (and may be longer than what is filled).
  obstacles() {
    const o = this.obs;
    if (this.obsVersion === this.obstaclesVersion) return o;
    this.obsVersion = this.obstaclesVersion;
    let nc = this.npcs.length, nb = 0;
    for (const slot of this.slots.values()) for (const c of slot.colliders) c.type ? nb++ : nc++;
    if (o.circles.length < nc * 3) o.circles = new Float32Array(THREE.MathUtils.ceilPowerOfTwo(nc) * 3);
    if (o.boxes.length < nb * 5) o.boxes = new Float32Array(THREE.MathUtils.ceilPowerOfTwo(nb) * 5);
    const { circles, boxes } = o;
    let ci = 0, bi = 0;
    const put = (c) => {
      if (c.type) { boxes[bi++] = c.x; boxes[bi++] = c.z; boxes[bi++] = c.hw; boxes[bi++] = c.hd; boxes[bi++] = c.ry; }
      else { circles[ci++] = c.x; circles[ci++] = c.z; circles[ci++] = c.r; }
    };
    for (const slot of this.slots.values()) for (const c of slot.colliders) put(c);
    o.npcStart = ci / 3;
    for (const c of this.npcs) put(c);
    o.nCircles = ci / 3;
    o.nBoxes = bi / 5;
    return o;
  }

  // -> { objects: every object the view knows (also those waiting for a model), batches: the models that are drawn
  //      (one draw call per material each), triangles: the instanced triangles of those batches }
  stats() {
    let batches = 0, triangles = 0;
    for (const { mesh, model } of this.batches.values()) {
      if (!mesh?.count) continue;
      batches++;
      triangles += mesh.count * model.triangles;
    }
    return { objects: this.slots.size, batches, triangles };
  }

  // ================================================================ internals

  // ---------------------------------------------------------------- model loading

  // The model if it is there already. A built-in is made on the spot, so it never waits.
  _modelNow(id) {
    let model = this.loaded.get(id);
    if (model) return model;
    const info = infoOf(id), built = info?.pack === 'builtin' ? builtinModel(info.name) : null;
    if (!built) return null;
    model = makeModel(id, info, built.geometry, built.material);
    this.loaded.set(id, model);
    this.models.set(id, Promise.resolve(model));
    return model;
  }

  // Loads one file. Whatever goes wrong - an unknown id, a 404, a broken file, parts that cannot be merged - ends in
  // the stand-in and an entry in `missing`, never in a rejection: one bad model must not take the others down.
  async _fetch(id) {
    const info = infoOf(id);
    try {
      if (!info?.url) throw new Error('no asset pack serves this model');
      // the url is relative to the site root: the page is served from there or sets <base href="/">
      const gltf = await this._queued(id, () => (this.disposed ? Promise.reject(new Error('the view is disposed')) : this.loader.loadAsync(info.url)));
      return this._build(id, info, gltf);
    } catch (err) {
      if (!this.disposed) {
        this.missing.add(id);
        console.warn(`[map] model ${id} failed to load:`, err?.message ?? err);
      }
      return standIn(id);
    }
  }

  // At most MAX_LOADS files in flight; the rest wait in line.
  _queued(id, job) {
    return new Promise((resolve, reject) => {
      this.queue.push({ id, urgent: false, run: () => job().then(resolve, reject) });
      this._pump();
    });
  }
  _pump() {
    while (this.flying < MAX_LOADS && this.queue.length) {
      const i = Math.max(0, this.queue.findIndex((job) => job.urgent));
      this.flying++;
      this.queue.splice(i, 1)[0].run().finally(() => { this.flying--; this._pump(); });
    }
  }
  // Something on screen waits for this model: it goes before the files nobody waits for (a background preload may
  // have queued the whole catalog).
  _hurry(id) {
    const job = this.queue.find((j) => j.id === id);
    if (job) job.urgent = true;
  }

  // A loaded glTF scene -> Model: one geometry for the whole file.
  _build(id, info, gltf) {
    // gate models ship with their doors shut; swing both leaves open so the passage reads as passable
    gltf.scene.traverse((o) => {
      if (o.name.endsWith('_door_left')) o.rotation.y = 1.4;
      if (o.name.endsWith('_door_right')) o.rotation.y = -1.4;
    });
    gltf.scene.updateMatrixWorld(true);
    const byMaterial = new Map(), spare = new Set();   // kept material -> its parts; the copies this file brought
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const own = Array.isArray(o.material) ? o.material[0] : o.material, kept = this._material(info.pack, gltf, own);
      if (kept !== own) spare.add(own);
      if (!byMaterial.has(kept)) byMaterial.set(kept, []);
      byMaterial.get(kept).push(partOf(o));
    });
    // a copy is freed right away - unless it shares its picture with a material that stays
    const live = new Set([...this.materials.values()].map((m) => m.map?.source.data));
    for (const m of spare) {
      if (m.map && !live.has(m.map.source.data)) {
        m.map.source.data?.close?.();   // an ImageBitmap holds its pixels until it is closed
        m.map.dispose();
      }
      m.dispose();
    }
    if (this.disposed) {
      for (const m of byMaterial.keys()) free(m);
      throw new Error('the view is disposed');
    }

    let lists = [...byMaterial.values()];
    if (!lists.length) throw new Error('the file has no meshes');
    const all = lists.flat();
    if (all.some((g) => g.index) && all.some((g) => !g.index)) lists = lists.map((list) => list.map((g) => (g.index ? g.toNonIndexed() : g)));
    // first everything that shares a material, then the materials as groups: one draw call per material
    const merged = lists.map((list) => (list.length > 1 ? mergeGeometries(list) : list[0]));
    const geometry = merged.includes(null) ? null : merged.length > 1 ? mergeGeometries(merged, true) : merged[0];
    if (!geometry) throw new Error('its parts cannot be merged');   // never keep only the first part
    const materials = [...byMaterial.keys()];
    return makeModel(id, info, geometry, materials.length > 1 ? materials : materials[0]);
  }

  // The one material to use for `mat`. A pack shares one palette texture, but every file decodes its own copy of it
  // (and embeds it, in a .glb): materials with the same pack, image and name are the same material, and the first one stays.
  _material(pack, gltf, mat) {
    const json = gltf.parser.json, def = json.materials?.[gltf.parser.associations.get(mat)?.materials];
    const image = json.images?.[json.textures?.[def?.pbrMetallicRoughness?.baseColorTexture?.index]?.source];
    const picture = image ? image.uri ?? `${image.name}:${json.bufferViews?.[image.bufferView]?.byteLength}` : `#${JSON.stringify(def ?? null)}`;
    const key = `${pack}|${picture}|${mat.name}`;
    if (!this.materials.has(key)) this.materials.set(key, mat);
    return this.materials.get(key);
  }

  // ---------------------------------------------------------------- batches

  // Makes the object known and puts it into the batch of its model, or into the batch's waiting list. -> the batch
  _add(obj) {
    let batch = this.batches.get(obj.m);
    if (!batch) this.batches.set(obj.m, batch = { id: obj.m, model: null, mesh: null, objs: [], pending: new Set(), asked: false, dead: false });
    if (batch.dead) return batch;
    const slot = { batch, i: -1, halo: -1, state: this._state(obj), colliders: NONE, cell: null };
    this.slots.set(obj, slot);
    this._file(obj, slot);
    if (batch.mesh) this._insert(obj, slot);
    else batch.pending.add(obj);
    return batch;
  }

  // Gets the model of a batch: at once when it is there, otherwise when it arrives.
  _request(batch) {
    if (batch.asked) return;
    batch.asked = true;
    const model = this._modelNow(batch.id);
    if (model) return this._arrive(batch, model, true);
    this.waiting++;
    this.loadModel(batch.id).then((m) => this._arrive(batch, m, false));
    this._hurry(batch.id);
  }

  // The model of a batch is there: the batch gets its mesh and everything that waited for it goes in.
  // now: inside the caller's own call, so nobody has to be told.
  _arrive(batch, model, now) {
    if (this.batches.get(batch.id) !== batch) return;   // load() or dispose() came first
    if (!now) this.waiting--;
    batch.model = model;
    if (model.missing && !this.editor) {                // the game draws nothing for a model it could not load
      for (const obj of batch.pending) this._forget(obj, this.slots.get(obj));
      batch.pending.clear();
      batch.dead = true;
      return;
    }
    // game: the exact count, static; editor: room to grow, dynamic, and the tint channel
    const n = batch.pending.size, floats = !this.editor && batch.id === CRYSTAL;
    batch.mesh = instanced(model.geometry, model.material, this.editor ? Math.max(16, THREE.MathUtils.ceilPowerOfTwo(n)) : Math.max(1, n),
      { dynamic: this.editor || floats, colors: this.editor });
    batch.mesh.castShadow = !model.missing && model.info.cast;
    batch.mesh.visible = this.layers.objects && !this.hidden.has(batch.id);
    this.root.add(batch.mesh);
    if (floats) this.crystal = batch;
    for (const obj of batch.pending) this._insert(obj, this.slots.get(obj));
    batch.pending.clear();
    if (!now) this.onChange?.();
  }

  _insert(obj, slot) {
    const batch = slot.batch;
    if (batch.mesh.count === batch.mesh.instanceMatrix.count) {
      batch.mesh = instanced(batch.model.geometry, batch.model.material, batch.mesh.count * 2,
        { dynamic: batch.mesh.instanceMatrix.usage === THREE.DynamicDrawUsage, colors: !!batch.mesh.instanceColor, old: batch.mesh });
    }
    const mesh = batch.mesh, i = slot.i = mesh.count++;
    batch.objs[i] = obj;
    compose(obj, this._gy(obj), 0, M).toArray(mesh.instanceMatrix.array, i * 16);
    mesh.instanceColor?.array.set(TINT[slot.state], i * 3);
    touch(mesh);
    this._collider(obj, slot);
    this._halo(obj, slot);
  }

  // The object leaves the view's books (not yet its batch).
  _forget(obj, slot) {
    this.slots.delete(obj);
    this._unfile(obj, slot);
  }

  // Keeps the origin index in step with obj.x / obj.z.
  _file(obj, slot) {
    const key = cellKey(Math.floor(obj.x / GRID), Math.floor(obj.z / GRID));
    if (key === slot.cell) return;
    this._unfile(obj, slot);
    let cell = this.origins.get(key);
    if (!cell) this.origins.set(key, cell = []);
    cell.push(obj);
    slot.cell = key;
  }
  _unfile(obj, slot) {
    const cell = this.origins.get(slot.cell);
    if (!cell) return;
    cell[cell.indexOf(obj)] = cell[cell.length - 1];
    if (--cell.length === 0) this.origins.delete(slot.cell);
    slot.cell = null;
  }

  // Empties the scene of everything a map put there; the terrain, the tiles and the model cache stay for the next map.
  _clear() {
    for (const batch of this.batches.values()) {
      batch.mesh?.removeFromParent();
      batch.mesh?.dispose();
    }
    this.batches = new Map();
    this.slots = new Map();
    this.origins.clear();
    this.waiting = 0;
    this.crystal = null;
    if (this.halo) { this.halo.count = 0; touch(this.halo); }
    this.haloObjs.length = 0;
    this.selected = new Set();
    this.hover = null;
    this.hidden.clear();
    this.setGhost(null);
    this.npcs = [];
    this._collidersChanged();
  }

  _pickable(batch) {
    return batch.mesh !== null && batch.mesh.count > 0 && !this.hidden.has(batch.id);
  }

  // Casts the ray at every instance of a batch and calls hit(obj, intersection) for each triangle it crosses.
  // The same test as InstancedMesh.raycast - Mesh.raycast per instance - but an instance the ray passes by is thrown
  // out first by its bounding sphere, read straight from the instance buffer: a hover pick looks at every object of the
  // map, and the stock version builds two matrices for each one. Nothing here depends on bounds the mesh has cached.
  _cast(raycaster, batch, hit) {
    const { mesh, model, objs } = batch, a = mesh.instanceMatrix.array, { center: c, radius } = model.geometry.boundingSphere;
    const { origin: o, direction: d } = raycaster.ray;
    PROBE.geometry = model.geometry;
    PROBE.material = model.material;
    for (let i = 0, k = 0; i < mesh.count; i++, k += 16) {
      const x = a[k] * c.x + a[k + 4] * c.y + a[k + 8] * c.z + a[k + 12] - o.x;       // ray origin -> centre of the sphere
      const y = a[k + 1] * c.x + a[k + 5] * c.y + a[k + 9] * c.z + a[k + 13] - o.y;
      const z = a[k + 2] * c.x + a[k + 6] * c.y + a[k + 10] * c.z + a[k + 14] - o.z;
      const r2 = radius * radius * scale2(a, k) * 1.001, d2 = x * x + y * y + z * z, along = x * d.x + y * d.y + z * d.z;
      if (d2 - along * along > r2 || (along < 0 && d2 > r2)) continue;                 // the ray passes it by, or it lies behind
      PROBE.matrixWorld.fromArray(a, k);
      HITS.length = 0;
      PROBE.raycast(raycaster, HITS);   // the precise test, triangle by triangle
      for (const h of HITS) hit(objs[i], h);
    }
    HITS.length = 0;
  }

  // The second pass of pickObject: nothing was hit, so the nearest small object on screen may still be meant.
  _pickNear(raycaster, slopPx, viewportHeight, filter) {
    const camera = raycaster.camera, ray = raycaster.ray, proj = camera.projectionMatrix.elements;
    const half = viewportHeight / 2, aspect = proj[5] / proj[0];
    const e = M2.copy(camera.matrixWorld).invert().premultiply(camera.projectionMatrix).elements;   // world -> clip
    // where the cursor is: every point of the ray is drawn there
    W.set(ray.origin.x + ray.direction.x, ray.origin.y + ray.direction.y, ray.origin.z + ray.direction.z, 1).applyMatrix4(M2);
    const cx = W.x / W.w, cy = W.y / W.w;
    let best = null, bestD = Infinity;
    for (const batch of this.batches.values()) {
      if (!this._pickable(batch)) continue;
      const { model, mesh, objs } = batch, a = mesh.instanceMatrix.array, { x: bx, y: by, z: bz } = model.bounds.getCenter(V), r = model.size.length() / 2;
      for (let i = 0, k = 0; i < mesh.count; i++, k += 16) {
        // the centre of the instance's bounds: in the world, then on screen
        const x = a[k] * bx + a[k + 4] * by + a[k + 8] * bz + a[k + 12];
        const y = a[k + 1] * bx + a[k + 5] * by + a[k + 9] * bz + a[k + 13];
        const z = a[k + 2] * bx + a[k + 6] * by + a[k + 10] * bz + a[k + 14];
        const w = e[3] * x + e[7] * y + e[11] * z + e[15];
        if (!(w > 0) || Math.abs(e[2] * x + e[6] * y + e[10] * z + e[14]) > w) continue;   // behind the camera or beyond its range
        const d = Math.hypot(((e[0] * x + e[4] * y + e[8] * z + e[12]) / w - cx) * half * aspect, ((e[1] * x + e[5] * y + e[9] * z + e[13]) / w - cy) * half);
        if (d >= bestD || d > slopPx * 2) continue;
        // a small prop is taken up to slopPx beyond its radius; the reach stops at 2 x slopPx, so a large object needs a precise hit
        if (d > slopPx + Math.min(slopPx, r * Math.sqrt(scale2(a, k)) * proj[5] / w * half)) continue;
        if (filter && !filter(objs[i])) continue;
        best = { obj: objs[i], point: new THREE.Vector3(x, y, z), distance: 0 };
        bestD = d;
      }
    }
    if (best) best.distance = ray.origin.distanceTo(best.point);
    return best;
  }

  // ---------------------------------------------------------------- selection and visibility

  _state(obj) {
    return this.selected.has(obj) ? 2 : this.hover === obj ? 1 : 0;
  }
  // Recomputes the state of an object and writes its tint: instance colour multiplies albedo, so this costs nothing per frame.
  _tint(obj) {
    const slot = this.slots.get(obj), state = this._state(obj);
    if (!slot || slot.state === state) return;
    slot.state = state;
    const colors = slot.i < 0 ? null : slot.batch.mesh.instanceColor;
    if (!colors) return;
    colors.array.set(TINT[state], slot.i * 3);
    colors.needsUpdate = true;
  }

  _show() {
    const { objects, ground, halos } = this.layers;
    for (const batch of this.batches.values()) if (batch.mesh) batch.mesh.visible = objects && !this.hidden.has(batch.id);
    if (this.halo) this.halo.visible = objects && halos;
    if (this.terrain.mesh) this.terrain.mesh.visible = this.terrain.sea.visible = ground;
    this._cull();
  }

  // ---------------------------------------------------------------- halos

  // Lantern and torch models do not shine by themselves: a soft additive halo around each one sells the light.
  // Adds, moves or removes the halo of one object.
  _halo(obj, slot, gone = false) {
    const g = gone || this.hidden.has(slot.batch.id) ? null : glowOf(obj, slot.batch.model.info);
    if (!g) {
      if (slot.halo < 0) return;
      const moved = swapRemove(this.halo, slot.halo);
      if (moved >= 0) {
        this.haloObjs[slot.halo] = this.haloObjs[moved];
        this.slots.get(this.haloObjs[slot.halo]).halo = slot.halo;
      }
      this.haloObjs.length = this.halo.count;
      slot.halo = -1;
      return;
    }
    if (slot.halo < 0) {
      if (!this.halo || this.halo.count === this.halo.instanceMatrix.count) {
        const old = this.halo;
        this.halo = instanced(this.haloGeometry, this.haloMaterial, old ? old.count * 2 : 64, { dynamic: this.editor, colors: true, old });
        this.halo.receiveShadow = false;
        if (!old) {
          this.halo.visible = this.layers.objects && this.layers.halos;
          this.root.add(this.halo);
        }
      }
      slot.halo = this.halo.count++;
      this.haloObjs[slot.halo] = obj;
    }
    const k = g.r / HALO_R;
    M.makeScale(k, k, k).setPosition(g.x, g.y + this._gy(obj), g.z).toArray(this.halo.instanceMatrix.array, slot.halo * 16);
    C.set(g.color).multiplyScalar(1.6).toArray(this.halo.instanceColor.array, slot.halo * 3);
    touch(this.halo);
  }

  // ---------------------------------------------------------------- ghost

  _drawGhost() {
    const g = this.ghost, n = g ? Math.min(g.objs.length, GHOST_MAX) : 0;
    for (let i = 0; i < n; i++) {
      const obj = g.objs[i], model = this._modelNow(obj.m) ?? this._ghostLater(obj.m);
      let mesh = this.ghosts[i];
      if (!mesh) {
        mesh = this.ghosts[i] = new THREE.Mesh(model.geometry, MAGENTA);
        mesh.matrixAutoUpdate = false;
        this.root.add(mesh);
      }
      mesh.geometry = model.geometry;
      mesh.material = this._ghostMaterial(model.material, g.valid);
      compose(obj, this._gy(obj), 0, mesh.matrix);
      mesh.matrixWorldNeedsUpdate = true;
      mesh.visible = true;
    }
    for (let i = n; i < this.ghosts.length; i++) this.ghosts[i].visible = false;
  }

  // A ghost of a model that is not loaded: the stand-in box for now, the real shape when it arrives.
  _ghostLater(id) {
    if (!this.ghostWait.has(id)) {
      this.ghostWait.add(id);
      this.loadModel(id).then(() => {
        this.ghostWait.delete(id);
        if (!this.ghost || this.disposed) return;
        this._drawGhost();
        this.onChange?.();
      });
      this._hurry(id);
    }
    return STAND_IN;
  }

  // Translucent clones of a model's material(s), made once: [for a valid ghost, for an invalid one (red)].
  _ghostMaterial(material, valid) {
    let pair = this.ghostMaterials.get(material);
    if (!pair) {
      const clone = (m, ok) => {
        const c = m.clone();
        c.transparent = true;
        c.opacity = 0.55;
        c.depthWrite = false;
        if (!ok) { c.color?.multiply(RED); c.emissive?.multiply(RED); }
        return c;
      };
      pair = [true, false].map((ok) => (Array.isArray(material) ? material.map((m) => clone(m, ok)) : clone(material, ok)));
      this.ghostMaterials.set(material, pair);
    }
    return pair[valid ? 0 : 1];
  }

  // ---------------------------------------------------------------- collision

  // Recomputes what one object blocks. gone: it has left the view.
  _collider(obj, slot, gone = false) {
    const before = slot.colliders, model = slot.batch.model;
    const after = gone ? NONE : records(colliderOf(obj, model.info, model.footprint));
    if (!before.length && !after.length) return;   // most props block nothing: moving one disturbs neither grid nor grass
    slot.colliders = after;
    for (const c of before) this._regrow(c);
    for (const c of after) this._regrow(c);
    this._collidersChanged();
  }

  // The grid is rebuilt in full, but not before somebody asks: collide(), or the foliage that grows around colliders.
  _collidersChanged() {
    this.gridDirty = true;
    this.obstaclesVersion++;
    this.stirred = true;
  }

  // Uniform grid, cell GRID. A record goes into EVERY cell its bounding rectangle touches, so a lookup needs only the
  // cells under the asking circle, whatever the size of the collider.
  _grid() {
    if (!this.gridDirty) return;
    this.gridDirty = false;
    this.grid.clear();
    this.big.length = 0;
    const put = (c) => {
      const i0 = Math.floor((c.x - c.ex) / GRID), i1 = Math.floor((c.x + c.ex) / GRID);
      const j0 = Math.floor((c.z - c.ez) / GRID), j1 = Math.floor((c.z + c.ez) / GRID);
      // Beyond 2^53 a cell index no longer counts up (i + 1 === i): the loops below would never end. A collider that
      // far out - a file with x: 1e300 that the editor has open to be repaired - goes on the plain list instead.
      if (!((i1 - i0 + 1) * (j1 - j0 + 1) <= BIG) || !Number.isSafeInteger(i1) || !Number.isSafeInteger(j1) || !Number.isSafeInteger(i0) || !Number.isSafeInteger(j0)) { this.big.push(c); return; }
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const key = cellKey(i, j), cell = this.grid.get(key);
          if (cell) cell.push(c);
          else this.grid.set(key, [c]);
        }
      }
    };
    for (const slot of this.slots.values()) slot.colliders.forEach(put);
    this.npcs.forEach(put);
  }

  // One look at every collider under the circle p. -> how deep it stood in the deepest one; 0 when it touched none.
  // push: p is moved out of each in turn (so the last one always wins, and an earlier one may hold it again).
  _pass(p, radius, push) {
    const stamp = ++this.stamp;   // a record sits in several cells: it is looked at once
    const i0 = Math.floor((p.x - radius) / GRID), i1 = Math.floor((p.x + radius) / GRID);
    const j0 = Math.floor((p.z - radius) / GRID), j1 = Math.floor((p.z + radius) / GRID);
    let deep = 0;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const cell = this.grid.get(cellKey(i, j));
        if (!cell) continue;
        for (const o of cell) {
          if (o.seen === stamp) continue;
          o.seen = stamp;
          deep = Math.max(deep, overlap(p, o, radius, push));
        }
      }
    }
    for (const o of this.big) deep = Math.max(deep, overlap(p, o, radius, push));
    return deep;
  }

  // Is the point inside a collider? (No grass grows there.)
  _covered(x, z) {
    const cell = this.grid.get(cellKey(Math.floor(x / GRID), Math.floor(z / GRID)));
    if (cell) for (const o of cell) if (covers(o, x, z)) return true;
    for (const o of this.big) if (covers(o, x, z)) return true;
    return false;
  }

  // ---------------------------------------------------------------- terrain

  // Builds the terrain for the map's ground, or brings it up to date: a new mesh when the grid has another size,
  // otherwise the old one recoloured in place. Heights follow map.radius; all foliage regrows.
  _terrain() {
    const t = this.terrain, g = this.map.ground, { size, cell } = g, half = groundHalf(g);
    if (!t.mesh) {
      t.grain = grainTexture();
      t.mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, map: t.grain, roughness: 1 }));
      t.mesh.receiveShadow = true;
      t.mesh.frustumCulled = false;   // the hills move under the brush: no bounds to keep right
      this.water = createWater(WATER_LEVEL, this.grass.shared.uField, this.grass.shared.uFieldXf);
      t.sea = this.water.mesh;
      t.mesh.visible = t.sea.visible = this.layers.ground;
      this.root.add(t.mesh, t.sea);
    }
    if (t.size !== size || t.cell !== cell) {
      // vertex i of this plane is ground cell i: ix grows with +x, iz with +z
      const geometry = new THREE.PlaneGeometry(2 * half, 2 * half, size - 1, size - 1).rotateX(-HALF_PI);
      t.noise = new Float32Array(size * size);   // per vertex, computed once: it blends the two colours of a ground type
      for (let iz = 0, i = 0; iz < size; iz++) {
        for (let ix = 0; ix < size; ix++, i++) {
          const x = groundX(g, ix), z = groundX(g, iz);
          t.noise[i] = noise(x * 0.08, z * 0.08) * 0.6 + noise(x * 0.31, z * 0.31) * 0.4;
        }
      }
      t.base = new Float32Array(size * size * 3);   // the colour of each vertex's own type, before the borders are softened
      t.color = new THREE.BufferAttribute(new Float32Array(size * size * 3), 3);
      if (this.editor) t.color.setUsage(THREE.DynamicDrawUsage);
      t.color.onUpload(() => { t.full = false; });
      geometry.setAttribute('color', t.color);
      t.mesh.geometry.dispose();
      t.mesh.geometry = geometry;
      t.grain.repeat.set(half / 2, half / 2);
      t.size = size;
      t.cell = cell;
      t.radius = -1;
      this._dropTiles();
      this.grass.resize(size, cell);
      const per = Math.ceil(size / TILE), mid = (first) => (groundX(g, first) + groundX(g, Math.min(size - 1, first + TILE - 1))) / 2;
      for (let tz = 0; tz < per; tz++) {
        for (let tx = 0; tx < per; tx++) this.tiles.push({ tx, tz, x: mid(tx * TILE), z: mid(tz * TILE), flowers: null, wait: false });
      }
    }
    t.radius = this.map.radius;
    this._shape(0, 0, size - 1, size - 1);
    this._paint(0, 0, size - 1, size - 1);
    this._uploadAll();
    this._dirtyTiles(0, 0, size - 1, size - 1, false);
  }

  // Recomputes the base colour inside the inclusive vertex rectangle, then the drawn colour inside the rectangle grown
  // by one vertex. Soft borders: a drawn colour is the weighted average of the 3 x 3 base colours around the vertex
  // (centre 4, edges 2, corners 1, indices clamped at the edge of the grid) - the format stores no blend weights.
  _paint(ix0, iz0, ix1, iz1) {
    const t = this.terrain, { size, noise: grain, base } = t, { cells, heights } = this.map.ground, color = t.color.array, last = size - 1;
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const i = iz * size + ix, c = SHADES[cells[i]] ?? SHADES[0], k = grain[i];
        // a shore makes itself: ground near the waterline is sand whatever was painted there, and darker the deeper it lies
        const h = heights ? heights[i] : 0, wet = h < SHORE_TOP ? Math.min(1, (SHORE_TOP - h) / SHORE_BAND) : 0;
        const deep = h < WATER_LEVEL ? Math.max(0.45, 1 + (h - WATER_LEVEL) * 0.12) : 1;
        // ... and a cliff says so: where the ground is too steep to climb, the rock shows through
        const steep = heights ? Math.min(1, Math.max(0, (this._steep(ix, iz) - MAX_SLOPE * 0.75) / (MAX_SLOPE * 0.3))) : 0;
        for (let ch = 0; ch < 3; ch++) {
          const own = c[ch] + (c[ch + 3] - c[ch]) * k, sand = SAND[ch] + (SAND[ch + 3] - SAND[ch]) * k;
          const soft = own + (sand - own) * wet, rock = ROCK[ch] + (ROCK[ch + 3] - ROCK[ch]) * k;
          base[i * 3 + ch] = (soft + (rock - soft) * steep) * deep;
        }
      }
    }
    for (let iz = Math.max(0, iz0 - 1); iz <= Math.min(last, iz1 + 1); iz++) {
      const up = Math.max(0, iz - 1) * size * 3, mid = iz * size * 3, down = Math.min(last, iz + 1) * size * 3;
      for (let ix = Math.max(0, ix0 - 1); ix <= Math.min(last, ix1 + 1); ix++) {
        const l = Math.max(0, ix - 1) * 3, m = ix * 3, r = Math.min(last, ix + 1) * 3;
        for (let ch = 0; ch < 3; ch++) {
          color[mid + m + ch] = (base[up + l + ch] + base[up + r + ch] + base[down + l + ch] + base[down + r + ch]
            + 2 * (base[up + m + ch] + base[mid + l + ch] + base[mid + r + ch] + base[down + m + ch]) + 4 * base[mid + m + ch]) / 16;
        }
      }
    }
  }

  // How steep the ground is at a vertex, as rise over run: the steepest of the cells around it.
  _steep(ix, iz) {
    const { size, cell, heights: h } = this.map.ground, last = size - 1, i = iz * size + ix, c = h[i];
    const l = ix > 0 ? h[i - 1] : c, r = ix < last ? h[i + 1] : c, u = iz > 0 ? h[i - size] : c, d = iz < last ? h[i + size] : c;
    return Math.hypot(Math.max(Math.abs(c - l), Math.abs(r - c)), Math.max(Math.abs(c - u), Math.abs(d - c))) / cell;
  }

  // Sets the height of the vertices inside the inclusive rectangle - the map's relief, and beyond the radius the beach
  // that slopes into the sea - and the normals inside the rectangle grown by one vertex.
  _shape(ix0, iz0, ix1, iz1) {
    const t = this.terrain, { size, cell } = t, heights = this.map.ground.heights, radius = this.map.radius, last = size - 1;
    const { position, normal } = t.mesh.geometry.attributes, p = position.array, n = normal.array;
    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const i = iz * size + ix, r = Math.hypot(p[i * 3], p[i * 3 + 2]);
        p[i * 3 + 1] = (heights ? heights[i] : 0) - (r > radius ? Math.min(4, (r - radius) * 0.3) : 0);
      }
    }
    for (let iz = Math.max(0, iz0 - 1); iz <= Math.min(last, iz1 + 1); iz++) {
      for (let ix = Math.max(0, ix0 - 1); ix <= Math.min(last, ix1 + 1); ix++) {
        const i = iz * size + ix, l = Math.max(0, ix - 1), r = Math.min(last, ix + 1), u = Math.max(0, iz - 1), d = Math.min(last, iz + 1);
        const dx = (p[(iz * size + r) * 3 + 1] - p[(iz * size + l) * 3 + 1]) / ((r - l) * cell);
        const dz = (p[(d * size + ix) * 3 + 1] - p[(u * size + ix) * 3 + 1]) / ((d - u) * cell);
        const k = 1 / Math.hypot(dx, 1, dz);
        n[i * 3] = -dx * k; n[i * 3 + 1] = k; n[i * 3 + 2] = -dz * k;
      }
    }
    position.needsUpdate = normal.needsUpdate = true;
  }

  // The ground under an object moved: its instance and its halo follow. What it blocks does not change.
  _lift(obj) {
    const slot = this.slots.get(obj);
    if (!slot || slot.i < 0) return;
    const mesh = slot.batch.mesh;
    compose(obj, this._gy(obj), 0, M).toArray(mesh.instanceMatrix.array, slot.i * 16);
    touch(mesh);
    this._halo(obj, slot);
  }

  _uploadAll() {
    const t = this.terrain;
    t.color.clearUpdateRanges();
    t.full = true;
    t.color.needsUpdate = true;
  }

  // ---------------------------------------------------------------- foliage

  // Grass and flowers are not items: they grow from the ground cells, by type, in tiles of TILE x TILE vertices.
  // The flowers are instances per tile; the grass is drawn by grass.js from the field the tiles write.

  _dropTiles() {
    for (const tile of this.tiles) {
      tile.flowers?.removeFromParent();
      tile.flowers?.dispose();
    }
    this.tiles = [];
    this.dirty.clear();
  }

  // Marks the tiles under an inclusive vertex rectangle. wait: because a collider changed - they regrow once the
  // colliders have been quiet, so a drag does not rebuild the collision grid on every frame.
  _dirtyTiles(ix0, iz0, ix1, iz1, wait) {
    const per = Math.ceil(this.terrain.size / TILE);
    for (let tz = Math.floor(iz0 / TILE); tz <= Math.floor(iz1 / TILE); tz++) {
      for (let tx = Math.floor(ix0 / TILE); tx <= Math.floor(ix1 / TILE); tx++) {
        const tile = this.tiles[tz * per + tx];
        if (!wait) tile.wait = false;
        else if (!this.dirty.has(tile)) tile.wait = true;
        this.dirty.add(tile);
      }
    }
  }

  // The foliage under a collider record has to regrow.
  _regrow(c) {
    const { size, cell } = this.terrain, mid = (size - 1) / 2;
    if (!this.tiles.length) return;
    const ix0 = Math.max(0, Math.ceil((c.x - c.ex) / cell + mid)), ix1 = Math.min(size - 1, Math.floor((c.x + c.ex) / cell + mid));
    const iz0 = Math.max(0, Math.ceil((c.z - c.ez) / cell + mid)), iz1 = Math.min(size - 1, Math.floor((c.z + c.ez) / cell + mid));
    if (ix0 <= ix1 && iz0 <= iz1) this._dirtyTiles(ix0, iz0, ix1, iz1, true);
  }

  // Regrows one tile. Placement is a pure function of (ix, iz, type): every client and the editor show the same
  // meadow, and repainting one spot never reshuffles the foliage elsewhere. No hash salt is used twice.
  _grow(tile) {
    const map = this.map, { size, cell, cells } = map.ground, mid = (size - 1) / 2, area = cell * cell;
    const reach = Math.max(0, map.radius - FOLIAGE_EDGE), flowers = [], drawn = this.terrain.mesh.geometry.attributes.position.array;
    if (map.foliage) this._grid();
    const ixEnd = Math.min(size, (tile.tx + 1) * TILE), izEnd = Math.min(size, (tile.tz + 1) * TILE);
    for (let iz = tile.tz * TILE; iz < izEnd; iz++) {
      for (let ix = tile.tx * TILE; ix < ixEnd; ix++) {
        const type = GROUND_TYPES[cells[iz * size + ix]], f = type?.foliage, x = (ix - mid) * cell, z = (iz - mid) * cell;
        const dry = !map.ground.heights || map.ground.heights[iz * size + ix] > WATER_LEVEL + 0.1;   // nothing grows under the water
        const gentle = !map.ground.heights || this._steep(ix, iz) < MAX_SLOPE * 0.9;                 // ... nor on a cliff face
        const grows = !!f && map.foliage && dry && gentle && x * x + z * z < reach * reach && !this._covered(x, z);
        // the blades take their density from the type's tuft count; the meadow (0.14 per square unit) is full grass
        // the height as drawn - with the beach that slopes away beyond the radius: the water reads its depth from it
        this.grass.write(ix, iz, grows ? f.tuft / GRASS_FULL : 0, type?.id === 'dry_grass' ? 1 : 0, drawn[(iz * size + ix) * 3 + 1]);
        if (!grows) continue;
        const H = (salt) => cellHash(ix, iz, salt);
        // density is per square unit; the fraction of the expected count becomes a chance
        const p = f.flower * area, n = Math.floor(p) + (H(6) < p - Math.floor(p) ? 1 : 0);
        for (let j = 0, s = 0; j < n; j++, s += 10) {
          flowers.push(x + (H(s + 7) - 0.5) * cell, z + (H(s + 8) - 0.5) * cell, 0.8 + 0.5 * H(s + 10), Math.floor(H(s + 9) * 4));
        }
      }
    }
    tile.flowers = this._plant(tile.flowers, 'builtin/flower_white', flowers, true);
  }

  // Fills a tile mesh from [x, z, scale, turn | colour index] quadruples; the mesh is made when first needed and
  // replaced when it is too small.
  _plant(mesh, id, data, flowers) {
    const n = data.length / 4;
    if (!n) {
      if (mesh) { mesh.count = 0; mesh.visible = false; }
      return mesh;
    }
    if (!mesh || mesh.instanceMatrix.count < n) {
      mesh?.removeFromParent();
      mesh?.dispose();
      const model = this._modelNow(id);
      mesh = instanced(model.geometry, model.material, this.editor ? Math.max(16, THREE.MathUtils.ceilPowerOfTwo(n)) : n, { dynamic: this.editor, colors: flowers });
      this.root.add(mesh);
    }
    const matrix = mesh.instanceMatrix.array;
    for (let i = 0; i < n; i++) {
      const s = data[i * 4 + 2], turn = flowers ? 0 : data[i * 4 + 3], cos = Math.cos(turn) * s, sin = Math.sin(turn) * s;
      matrix.set([cos, 0, -sin, 0, 0, s, 0, 0, sin, 0, cos, 0, data[i * 4], heightAt(this.map, data[i * 4], data[i * 4 + 1]), data[i * 4 + 1], 1], i * 16);
      if (flowers) FLOWERS[data[i * 4 + 3]].toArray(mesh.instanceColor.array, i * 3);
    }
    mesh.count = n;
    touch(mesh);   // a true bounding sphere, so the tile is culled with the frustum
    return mesh;
  }

  // Shows the tiles that should be seen: the layer switch and, in the game, the distance to the player.
  _cull() {
    const f = this.editor ? null : this.focus;
    this.grass.group.visible = this.layers.foliage;
    for (const tile of this.tiles) {
      const on = this.layers.foliage && (!f || Math.hypot(tile.x - f.x, tile.z - f.z) < FOLIAGE_RANGE);
      if (tile.flowers) tile.flowers.visible = on && tile.flowers.count > 0;
    }
  }

  // ---------------------------------------------------------------- the crystal

  // Game only: the crystal floats and spins. Its matrices are rewritten every frame from the object's own transform.
  _float(time) {
    const { mesh, objs } = this.crystal, array = mesh.instanceMatrix.array;
    if (!mesh.count) return;
    if (!mesh.boundingSphere) {   // an edit dropped the bounds: measure them at rest, with room to bob
      objs.forEach((obj, i) => compose(obj, this._gy(obj), 0, M).toArray(array, i * 16));
      mesh.computeBoundingSphere();
      mesh.boundingSphere.radius += 0.2;
      mesh.computeBoundingBox();
      mesh.boundingBox.expandByScalar(0.2);
    }
    const dy = Math.sin(time * 1.5) * 0.2, dry = time * 0.7;
    objs.forEach((obj, i) => compose(obj, this._gy(obj) + dy, dry, M).toArray(array, i * 16));
    mesh.instanceMatrix.needsUpdate = true;
  }
}
