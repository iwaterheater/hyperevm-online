import * as THREE from 'three';
import { MapView } from '../map/view.js';
import { createLighting } from '../map/lighting.js';
import { createComposer } from '../postfx.js';
import { GROUND_TYPES, LAYER_OF, LIMITS, MOODS, cellIndex, groundIx, groundX, moodAt, qPos, regionLabel, shapeBounds } from '../map/format.js';
import { reportOnce } from './actions.js';
import { createDrape, discGeometry, plateGeometry } from './drape.js';
import { rayRelief } from './relief.js';
import { chordLabel } from './keymap.js';
import { pivotOf, snapPoint } from './tools/common.js';

// The viewport: the scene and its orbit camera, the frame loop, and everything between the pointer and the tools.
//
// - It owns the WebGL canvas inside #viewport and renders ON DEMAND: a frame is drawn only after invalidate(), so an
//   idle editor draws nothing. tick(dt) always draws (tests, hidden tabs).
// - It owns the pointer: wheel, right-drag, middle-drag and Space + left-drag move the camera; everything else goes to
//   the active tool as pointerDown / pointerMove / pointerUp with a Hit - where the cursor is on the ground and, lazily,
//   what a click there would pick. A tool that got pointerDown always gets pointerUp.
// - It is the ONLY caller of the MapView mutators: store and ui events are turned into view calls here and nowhere else.
// - It draws what belongs to no tool: grid, map boundary, colliders, selection boxes, the pivot, the brush ring.
// - It knows the relief: the ground point of a Hit is where the cursor's ray meets the TERRAIN (Hit.y is its height),
//   the camera orbits a point ON the ground, and every ground overlay lies on the hills - the grid as a second mesh
//   over the terrain's own geometry, the collider shapes through the drape (drape.js), the brush ring vertex by vertex.
//
// Other modules reach it as ctx.viewport. What the contract does not name but the page needs is at the end of the
// returned object: pickPoint and setCursor (the renderers behind ui.pickPoint / ui.setCursor), modal / cancelModal
// (Escape), addPanel (the panels whose update() runs every frame), registerActions and input (the test hook).

const DEG = Math.PI / 180, TAU = Math.PI * 2;
const FOV = 48, FAR = 4000;
const PITCH_MIN = 15 * DEG, PITCH_MAX = 90 * DEG, DISTANCE_MIN = 3;
const HOME = { distance: 70, yaw: 0, pitch: 55 * DEG };
const BACKGROUND = 0x20262b;
const MISS = 2000;              // a ray that misses the ground (or meets it further away) ends this far along its ground projection
const CLICK_PX = 6;             // a right press that travels less is a click: it cancels instead of orbiting
const PIN_PX = 10;              // how close to a marker pin the cursor must be (§9.2)
const OBJECT_SLOP = 6;          // the forgiving ring around small scenery (§9.2)
const MAX_BOXES = 200;          // selection boxes; a larger selection gets one box around all of it
const TIP_DELAY = 350;          // ms the cursor rests on an item before the tip names it
const ANIM_TIME = 0.25;         // seconds a camera move takes
const BOOKMARKS_KEY = 'hypercat-editor-bookmarks';
// ground overlays are tested against the scene, never written, and pulled towards the eye so they do not fight the terrain
const GROUND_OVERLAY = { depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false };
const ON_TOP = { depthTest: false, depthWrite: false, transparent: true, toneMapped: false };
const BLOCK = GROUND_TYPES.map((t) => t.block === true);
// the 12 edges of a box as pairs of corners; corner i has max x / y / z where bit 0 / 1 / 2 of i is set
const EDGES = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7];
const RING_SEGMENTS = 128;
const FILL_SEGMENTS = 48, FILL_RINGS = 10;   // the faint disc inside the brush ring
const BRUSH_LIFT = 0.03;        // the brush lies this far over the ground it is draped on
const EYE_ROOM = 1;             // the camera never comes closer to the ground under it than this
const NO_PICK = Object.freeze({ item: null, kind: null, handle: null });
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const wrap = (a) => a - Math.round(a / TAU) * TAU;          // an angle in [-PI, PI]

// The grid and the map boundary are ONE plane with the lines computed per pixel: they stay one pixel wide at any zoom,
// fade where they would merge, and - being a polygon - follow the depth rule of every ground overlay (a GL line cannot).
const GRID_VERTEX = `
varying vec2 vPos;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vPos = world.xz;
  gl_Position = projectionMatrix * viewMatrix * world;
}`;
const GRID_FRAGMENT = `
uniform float uRadius;
uniform float uGrid;
uniform float uBoundary;
varying vec2 vPos;
// how much of the pixel a one-pixel line at every multiple of 'every' covers; 0 where such lines are closer than 3 pixels
float lines(float every) {
  vec2 c = vPos / every;
  vec2 w = max(fwidth(c), vec2(1e-6));
  vec2 d = abs(fract(c - 0.5) - 0.5) / w;
  return (1.0 - min(min(d.x, d.y), 1.0)) * (1.0 - smoothstep(0.12, 0.34, max(w.x, w.y)));
}
void main() {
  float r = length(vPos);
  float fine = lines(10.0) * 0.18;
  float bold = lines(50.0) * 0.42;
  float grid = max(fine, bold) * uGrid * step(r, uRadius);
  float rim = (1.0 - min(abs(r - uRadius) / max(fwidth(r) * 1.5, 1e-6), 1.0)) * 0.9 * uBoundary;
  float a = max(grid, rim);
  if (a < 0.004) discard;
  gl_FragColor = vec4(mix(vec3(1.0), vec3(1.0, 0.82, 0.38), step(grid, rim)), a);
}`;

function div(className) {
  const node = document.createElement('div');
  node.className = className;
  node.hidden = true;
  // these two hold whatever base.css says about looks; that they float over the canvas and never take a click is not a matter of style
  node.style.position = 'absolute';
  node.style.pointerEvents = 'none';
  return node;
}

// Two concentric bands (the outer brush ring and the inner one) as one indexed strip geometry, rewritten in place.
function ringGeometry() {
  const n = RING_SEGMENTS + 1, index = [];
  for (let ring = 0; ring < 2; ring++) {
    for (let i = 0, a = ring * n * 2; i < RING_SEGMENTS; i++, a += 2) index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setIndex(index);
  return g;
}
// One band r0 .. r1 around (x, z) in world coordinates, every vertex on the ground (`height`) under it.
function writeRing(array, o, x, z, r0, r1, height) {
  for (let i = 0; i <= RING_SEGMENTS; i++) {
    const a = i / RING_SEGMENTS * TAU, c = Math.cos(a), s = Math.sin(a);
    for (const r of [r0, r1]) {
      const px = x + c * r, pz = z + s * r;
      array[o++] = px; array[o++] = height(px, pz) + BRUSH_LIFT; array[o++] = pz;
    }
  }
  return o;
}

// A small cross in a diamond, drawn facing the camera at the pivot of the selection.
function pivotGeometry() {
  const r = 5, c = 9, p = [-c, 0, -2, 0, 2, 0, c, 0, 0, -c, 0, -2, 0, 2, 0, c, -r, 0, 0, r, 0, r, r, 0, r, 0, 0, -r, 0, -r, -r, 0];
  const pos = [];
  for (let i = 0; i < p.length; i += 2) pos.push(p[i], p[i + 1], 0);
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
}

export function createViewport(ctx, { el = document.querySelector('#viewport') } = {}) {
  if (!el) throw new Error('createViewport: the page has no #viewport element');
  const { store, ui } = ctx;

  // ---------------------------------------------------------------- state
  // (declared before anything runs: the functions below are hoisted, their variables are not)
  let needsFrame = true, frameId = 0, raf = 0, lastLoop = 0, lastRender = -1e9, fps = 0, disposed = false;
  let width = 1, height = 1, rectBox = null, rectFrame = -1;
  let mode = 'neutral', composer = null;
  let anim = null, overhead = null, cameraMoved = true, homed = false;
  let press = null, modal = null, spaceHeld = false;
  let hoverItem = null, hoverKind = null, hoverHandle = false, pendingHover = null;
  let toolCursor = null, cursorNow = null, forbidden = false;
  let tipTimer = 0, tipText = null, readoutText = null, progressText = null;
  let pickFrame = -1, pickResult = NO_PICK, pickX = 0, pickY = 0;
  let selDirty = true, pivot = null, groundVersion = 0;
  let orbitY = 0, lag = 0;   // the height of the point the camera orbits; how far it still is from the ground under it
  let colVersion = -1, colGround = -1;
  let brushDirty = false, actionsDone = false, loads = 0;
  let hiddenModels = new Set(ui.hiddenModels ?? []);
  let hiddenObjects = false;   // the view hides single objects right now (those of a hidden custom layer)
  const pointer = { sx: 0, sy: 0, inside: false, ev: null };
  const rig = { x: 0, z: 0, ...HOME };
  const stats = { triangles: 0, calls: 0 };
  const brushState = { on: false, x: 0, z: 0, radius: 1, inner: 0 };
  const panels = [], failed = new Set(), modelBoxes = new Map(), stash = [];
  const sharedHits = new WeakSet();   // hits whose pick was made for another pointer position of the same frame

  // ---------------------------------------------------------------- renderer, scene, camera
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // On for the whole life of the renderer: switching it on later leaves materials that were already drawn without
  // shadows. Whether a shadow is cast is decided by the light alone (lighting.setShadows).
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.info.autoReset = false;   // the game preview draws several passes per frame; render() resets the counters once per frame
  const dom = renderer.domElement;
  Object.assign(dom.style, { display: 'block', width: '100%', height: '100%', touchAction: 'none', outline: 'none' });

  const scene = new THREE.Scene();
  const background = new THREE.Color(BACKGROUND);
  const camera = new THREE.PerspectiveCamera(FOV, 1, 1, FAR);
  const PV = new THREE.Matrix4();    // world -> clip, kept in step with the camera
  // the neutral view has two lights of its own; the rig of lighting.js serves the game preview and the mood previews
  const neutralHemi = new THREE.HemisphereLight(0xffffff, 0x8c8c8c, 1.1);
  const neutralSun = new THREE.DirectionalLight(0xffffff, 1.6);
  neutralSun.position.set(0.5, 1, 0.35);
  scene.add(neutralHemi, neutralSun);
  const lighting = createLighting(scene, { fog: false, shadows: false });
  const view = new MapView(scene, { editor: true });
  view.onChange = () => invalidate();   // a queued model arrived: the view cannot ask for a frame itself
  ctx.view ??= view;
  const drape = createDrape();          // the relief for everything that lies on the ground (drape.js)
  const groundY = (x, z) => drape.height(x, z);

  const overlay = new THREE.Group();    // tool-owned temporary visuals
  overlay.name = 'tool-overlay';
  const core = new THREE.Group();       // what the viewport draws itself
  core.name = 'core-overlays';
  scene.add(overlay, core);

  const readoutEl = div('readout'), tipEl = div('tip');
  el.append(dom, readoutEl, tipEl);

  // ---------------------------------------------------------------- scratch objects
  const RAYCASTER = new THREE.Raycaster(), NDC = new THREE.Vector2();
  const GROUND = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const V = new THREE.Vector3(), V2 = new THREE.Vector3(), M = new THREE.Matrix4();
  const BOX = new THREE.Box3(), BOX2 = new THREE.Box3();
  const G1 = { x: 0, y: 0, z: 0, on: false }, S1 = { x: 0, y: 0, front: false };
  const FROM = { x: 0, y: 0, z: 0 };
  const CORNERS = Array.from({ length: 8 }, () => new THREE.Vector3());

  // ---------------------------------------------------------------- core overlays
  const gridMaterial = new THREE.ShaderMaterial({
    ...GROUND_OVERLAY, transparent: true,
    uniforms: { uRadius: { value: 260 }, uGrid: { value: 1 }, uBoundary: { value: 1 } },
    vertexShader: GRID_VERTEX, fragmentShader: GRID_FRAGMENT,
  });
  // The grid is drawn on the terrain's own triangles (view.groundGeometry, taken up in updateVisuals): the same
  // vertices, so it lies on every hill exactly and the depth rule of the ground overlays is all it needs.
  const gridBlank = new THREE.BufferGeometry();
  const gridMesh = new THREE.Mesh(gridBlank, gridMaterial);
  gridMesh.renderOrder = 1;
  gridMesh.frustumCulled = false;       // the view reshapes that geometry under the brush: no bounds to keep right
  gridMesh.visible = false;

  const colliderMaterial = drape.apply(new THREE.MeshBasicMaterial({ color: 0xff3355, transparent: true, opacity: 0.3, ...GROUND_OVERLAY }));
  const colliderGroup = new THREE.Group();
  colliderGroup.visible = false;
  const colliders = {   // three instanced sets: collider circles, collider boxes, blocked ground vertices - cut fine enough to bend over a slope
    circle: { mesh: null, geometry: discGeometry(24, 3) },
    box: { mesh: null, geometry: plateGeometry(8) },
    cell: { mesh: null, geometry: plateGeometry(2) },
  };

  // every selection box in ONE LineSegments, drawn over the scene
  const selPositions = new Float32Array(MAX_BOXES * 24 * 3);
  const selGeometry = new THREE.BufferGeometry();
  selGeometry.setAttribute('position', new THREE.BufferAttribute(selPositions, 3).setUsage(THREE.DynamicDrawUsage));
  selGeometry.setDrawRange(0, 0);
  const selLines = new THREE.LineSegments(selGeometry, new THREE.LineBasicMaterial({ color: 0xffc14d, ...ON_TOP }));
  selLines.renderOrder = 999;
  selLines.frustumCulled = false;   // rewritten all the time: bounds would be stale more often than right
  selLines.visible = false;
  const pivotMark = new THREE.LineSegments(pivotGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, ...ON_TOP }));
  pivotMark.renderOrder = 999;
  pivotMark.visible = false;

  const brushGroup = new THREE.Group();
  brushGroup.visible = false;
  const brushRing = new THREE.Mesh(ringGeometry(), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, ...GROUND_OVERLAY }));
  // both are rewritten in world coordinates for every position of the brush, vertex by vertex on the ground under it
  const brushDisc = discGeometry(FILL_SEGMENTS, FILL_RINGS), brushUnit = brushDisc.attributes.position.array.slice();
  brushDisc.attributes.position.setUsage(THREE.DynamicDrawUsage);
  const brushFill = new THREE.Mesh(brushDisc, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.07, ...GROUND_OVERLAY }));
  brushRing.frustumCulled = brushFill.frustumCulled = false;
  brushRing.renderOrder = 4;
  brushFill.renderOrder = 3;
  brushGroup.add(brushFill, brushRing);
  core.add(gridMesh, colliderGroup, brushGroup, selLines, pivotMark);

  // ---------------------------------------------------------------- fault isolation (§10.1 rule 6)

  // Every call into a tool, an overlay or a panel goes through here: a module that throws is reported once per method
  // and the frame goes on. The report is the page's one reporter (actions.js): the keymap and main.js call into the
  // same modules, and a failure they have seen is not written a second time here.
  // once: an update() that threw is not called again until reload.
  function guarded(owner, name, method, args, once) {
    const fn = owner?.[method];
    if (typeof fn !== 'function') return undefined;
    const key = `${name}.${method}`;
    if (once && failed.has(key)) return undefined;
    try {
      return fn.apply(owner, args);
    } catch (err) {
      failed.add(key);
      reportOnce(name, method, err);
      return undefined;
    }
  }
  const call = (owner, name, method, ...args) => guarded(owner, name, method, args, method === 'update');
  // markers and gizmo are core, but a frame must survive them too; they are tried again on the next frame
  const markers = (method, ...args) => guarded(ctx.markers, 'markers', method, args, false);
  const gizmo = (method, ...args) => guarded(ctx.gizmo, 'gizmo', method, args, false);
  const activeTool = () => ctx.tools?.[ui.tool] ?? null;
  const toolName = (tool) => `tool ${tool.id ?? ui.tool}`;
  function toolContext(tool) {
    try { return tool?.context ?? 'none'; } catch { return 'none'; }   // a getter of somebody else's module
  }
  // The size of the island as the camera takes it: the map's radius, kept within what a map can have at all - a file
  // under repair may say anything, and every camera limit is a multiple of this number.
  const radius = () => { const r = store.map?.radius; return Number.isFinite(r) ? clamp(r, 1, 2 * LIMITS.radius[1]) : 260; };
  const layerOpen = (layer) => { const l = ui.layers?.[layer]; return !l || (l.visible !== false && !l.locked); };

  // ---------------------------------------------------------------- camera rig

  function invalidate() {
    needsFrame = true;
  }

  // The rig -> the camera, at once: a pick right after a camera call must see the new matrices, frame or no frame.
  function applyRig() {
    // The rig is numbers that came from the map (frame an item, go to an issue): one item of a file under repair that
    // stands at 1e308 must not leave the camera at NaN, from where no Home and no animation would bring it back.
    for (const key of ['x', 'z', 'distance', 'yaw', 'pitch']) if (!Number.isFinite(rig[key])) rig[key] = HOME[key] ?? 0;
    const R = radius(), max = R + 40, d = Math.hypot(rig.x, rig.z);
    rig.pitch = clamp(rig.pitch, PITCH_MIN, PITCH_MAX);
    rig.distance = clamp(rig.distance, DISTANCE_MIN, 3 * R);
    rig.yaw = wrap(rig.yaw);
    if (d > max) { rig.x *= max / d; rig.z *= max / d; }
    const cp = Math.cos(rig.pitch);
    // The camera orbits a point ON the ground: over a hill it rides up with it instead of ending up inside.
    // `lag` is what an edit of the ground left between that point and the ground (see settle()).
    orbitY = groundY(rig.x, rig.z) + lag;
    camera.position.set(rig.x + rig.distance * cp * Math.sin(rig.yaw), orbitY + rig.distance * Math.sin(rig.pitch), rig.z + rig.distance * cp * Math.cos(rig.yaw));
    // ... and a hill between the camera and its target lifts the camera over it: a ray that starts under the ground
    // would find nothing but its own start
    camera.position.y = Math.max(camera.position.y, groundY(camera.position.x, camera.position.z) + EYE_ROOM);
    // built from the angles, not with lookAt: straight down (the overhead view) has no "up" to look along.
    // yaw 0 looks north (-Z) with east (+X) to the right, like the minimap
    camera.rotation.set(-rig.pitch, rig.yaw, 0, 'YXZ');
    // the game's 0.1 / 700 would z-fight the ground overlays from overview distance and clip the island
    const near = Math.max(0.1, rig.distance * 0.02);
    if (near !== camera.near) { camera.near = near; camera.updateProjectionMatrix(); }
    cameraChanged();
  }
  function cameraChanged() {
    camera.updateMatrixWorld();
    PV.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    cameraMoved = true;   // the next frame re-aims the pointer and resizes what is measured in pixels
    pickFrame = -1;
    invalidate();
  }

  // The ground under the orbit point moved (a sculpt stroke, an undo): the camera stays where it is - a view that
  // jumps while the brush is down is a brush nobody can aim - and `lag` remembers how far its orbit point now is from
  // the ground. settle() takes that up once the button is released, in a fraction of a second.
  function keepOrbit() {
    lag = orbitY - groundY(rig.x, rig.z);
    if (lag !== 0) invalidate();
  }
  function settle(dt) {
    if (lag === 0 || press?.kind === 'tool') return;
    lag *= Math.exp(-Math.max(dt, 1 / 240) * 8);
    if (Math.abs(lag) < 0.01) lag = 0;
    applyRig();
  }

  // A camera move in progress: { t, from, to } - `to` holds only the rig keys that move, each can be taken out alone.
  function animateTo(to, time = ANIM_TIME) {
    const goal = { ...anim?.to, ...to };
    for (const key of Object.keys(goal)) if (!Number.isFinite(goal[key])) delete goal[key];      // nowhere to go to
    if (!Object.keys(goal).length) return;
    if (goal.yaw !== undefined) goal.yaw = rig.yaw + wrap(goal.yaw - rig.yaw);   // the short way round
    anim = { t: 0, time, from: { ...rig }, to: goal };
    invalidate();
  }
  function stopAnim(...keys) {
    if (!anim) return;
    for (const key of keys) delete anim.to[key];
    if (!Object.keys(anim.to).length) anim = null;
  }
  function stepAnim(dt) {
    if (!anim) return;
    const a = anim;
    a.t = Math.min(1, a.t + dt / a.time);
    const k = 1 - (1 - a.t) ** 3;
    for (const key of Object.keys(a.to)) rig[key] = a.from[key] + (a.to[key] - a.from[key]) * k;
    if (a.t >= 1) anim = null;
    applyRig();
  }

  function setTarget(x, z, { animate = true } = {}) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    if (animate) animateTo({ x, z });
    else {
      stopAnim('x', 'z');
      rig.x = x; rig.z = z;
      applyRig();
    }
  }

  // the distance from which a sphere of radius r fills the smaller side of the view
  function fitDistance(r) {
    const half = FOV * DEG / 2;
    return r / Math.sin(Math.min(half, Math.atan(Math.tan(half) * camera.aspect))) * 1.1;
  }

  // what: a Box3, a point { x, z } or a list of items.
  function focus(what) {
    if (!what) return;
    let box = null;
    if (what.isBox3) box = what;
    else if (Array.isArray(what)) box = what.length ? boundsOfItems(what, BOX) : null;
    else if (Number.isFinite(what.x) && Number.isFinite(what.z)) {
      animateTo({ x: what.x, z: what.z, distance: Math.min(rig.distance, 60) });   // a point: go there, come closer if far away
      return;
    }
    if (!box || box.isEmpty()) return;
    const centre = box.getCenter(V), r = Math.max(2, box.getSize(V2).length() / 2);
    animateTo({ x: centre.x, z: centre.z, distance: clamp(fitDistance(r), DISTANCE_MIN, 3 * radius()) });
  }
  function frameSelection() {
    if (store.selection?.size) focus([...store.selection]);
    else animateTo({ x: 0, z: 0, distance: fitDistance(radius()) });   // nothing selected: the whole island
  }
  function home(animate = true) {
    const start = store.map?.start;
    if (!start) return;
    const to = { x: start.x, z: start.z, distance: Math.min(rig.distance, HOME.distance) };
    if (animate) animateTo(to);
    else {
      stopAnim('x', 'z', 'distance');
      Object.assign(rig, to);
      applyRig();
    }
  }

  // The overhead view is the same camera straight down, north up; leaving it restores the angles it was entered with.
  // Whoever orbits away from it has left it: the next toggle enters it again.
  const isOverhead = () => overhead !== null && rig.pitch >= PITCH_MAX - 1e-3;
  function setOverhead(on) {
    if (!!on === isOverhead()) {
      if (!on) overhead = null;
      return;
    }
    stopAnim('yaw', 'pitch');
    if (on) {
      overhead = { yaw: rig.yaw, pitch: rig.pitch };
      rig.yaw = 0;
      rig.pitch = PITCH_MAX;
    } else {
      rig.yaw = overhead.yaw;
      rig.pitch = overhead.pitch;
      overhead = null;
    }
    applyRig();
  }
  function turn(dyaw, dpitch) {
    const to = {};
    if (dyaw) to.yaw = (anim?.to.yaw ?? rig.yaw) + dyaw;
    if (dpitch) to.pitch = clamp((anim?.to.pitch ?? rig.pitch) + dpitch, PITCH_MIN, PITCH_MAX);
    animateTo(to, 0.15);
  }

  // Four bookmarks { x, z, distance, yaw, pitch } in localStorage; whatever is stored there is checked before use.
  function readBookmarks() {
    const slots = [null, null, null, null];
    try {
      const raw = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) ?? 'null');
      if (Array.isArray(raw)) {
        for (let i = 0; i < 4; i++) {
          const b = raw[i];
          if (b && ['x', 'z', 'distance', 'yaw', 'pitch'].every((key) => Number.isFinite(b[key]))) slots[i] = { x: b.x, z: b.z, distance: b.distance, yaw: b.yaw, pitch: b.pitch };
        }
      }
    } catch { /* disabled, or somebody else's data: no bookmarks */ }
    return slots;
  }
  const slotOf = (i) => (Number.isInteger(i) && i >= 1 && i <= 4 ? i - 1 : -1);
  function setBookmark(i) {
    const slot = slotOf(i);
    if (slot < 0) return false;
    const slots = readBookmarks(), round = (v) => Math.round(v * 1000) / 1000;
    slots[slot] = { x: round(rig.x), z: round(rig.z), distance: round(rig.distance), yaw: round(rig.yaw), pitch: round(rig.pitch) };
    try {
      localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(slots));
    } catch {
      ui.toast(`Bookmark ${i} could not be stored`, 'warn');
      return false;
    }
    ui.toast(`Bookmark ${i} stored`);
    return true;
  }
  function gotoBookmark(i) {
    const slot = slotOf(i), b = slot < 0 ? null : readBookmarks()[slot];
    if (!b) {
      if (slot >= 0) ui.toast(`Bookmark ${i} is empty (${chordLabel(`Alt+Shift+Digit${i}`)} stores the view)`);
      return false;
    }
    overhead = null;
    animateTo(b);
    return true;
  }
  const hasBookmark = (i) => slotOf(i) >= 0 && readBookmarks()[slotOf(i)] !== null;

  // ---------------------------------------------------------------- projection and the ground point

  // The canvas on the page; read once per animation frame at most (it forces a layout).
  function rect() {
    if (!rectBox || rectFrame !== frameId) {
      rectBox = dom.getBoundingClientRect();
      rectFrame = frameId;
    }
    return rectBox;
  }
  function setRay(sx, sy) {
    const r = rect();
    NDC.set((sx - r.left) / (r.width || 1) * 2 - 1, 1 - (sy - r.top) / (r.height || 1) * 2);
    RAYCASTER.setFromCamera(NDC, camera);   // also sets raycaster.camera, which view.pickObject measures pixels with
    return RAYCASTER.ray;
  }
  // Where a ray meets the ground: the relief of the map (rayRelief walks the triangles of the height grid; the terrain
  // MESH is never raycast), and on a map without a hill simply the plane y = 0, to the last digit what it always was.
  function groundOf(ray, out) {
    const o = ray.origin, d = ray.direction, map = store.map;
    if (map && drape.hilly) {
      // nothing is higher than the highest vertex: the air above it is skipped in one step
      const top = drape.top + 0.5, skip = o.y > top ? (d.y < 0 ? (o.y - top) / -d.y : Infinity) : 0;
      if (skip < MISS) {
        FROM.x = o.x + d.x * skip; FROM.y = o.y + d.y * skip; FROM.z = o.z + d.z * skip;
        const p = rayRelief(map, FROM, d, MISS - skip);
        if (p) {
          out.x = p.x; out.y = p.y; out.z = p.z; out.on = true;
          return out;
        }
      }
    } else {
      const p = ray.intersectPlane(GROUND, V);
      if (p && Math.hypot(p.x - o.x, p.y - o.y, p.z - o.z) <= MISS) {
        out.x = p.x; out.y = 0; out.z = p.z; out.on = true;
        return out;
      }
    }
    const l = Math.hypot(d.x, d.z);
    out.x = o.x + (l > 1e-9 ? d.x / l * MISS : 0);
    out.z = o.z + (l > 1e-9 ? d.z / l * MISS : 0);
    out.y = groundY(out.x, out.z);
    out.on = false;
    return out;
  }
  // world -> client pixels; front: the point lies before the camera
  function toScreen(x, y, z, out) {
    const e = PV.elements, r = rect(), w = e[3] * x + e[7] * y + e[11] * z + e[15];
    out.front = w > 1e-6;
    const k = out.front ? w : 1e-6;
    out.x = r.left + ((e[0] * x + e[4] * y + e[8] * z + e[12]) / k * 0.5 + 0.5) * r.width;
    out.y = r.top + (0.5 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / k * 0.5) * r.height;
    return out;
  }
  function project(x, y, z) {
    const p = toScreen(x, y, z, S1), r = rect();
    const depth = PV.elements[2] * x + PV.elements[6] * y + PV.elements[10] * z + PV.elements[14];
    const w = PV.elements[3] * x + PV.elements[7] * y + PV.elements[11] * z + PV.elements[15];
    return { x: p.x, y: p.y, visible: p.front && Math.abs(depth) <= w && p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom };
  }
  // world units one pixel covers at a point (0 behind the camera)
  function unitsPerPixel(x, y, z) {
    const e = PV.elements, depth = e[3] * x + e[7] * y + e[11] * z + e[15];
    return depth > 0 ? 2 * depth * Math.tan(FOV * DEG / 2) / height : 0;
  }

  // ---------------------------------------------------------------- picking (§9.2)

  // item, kind and handle are resolved when somebody reads them, and then once.
  // fresh: for exactly this pixel. Hits made for pointer moves share one pick per frame: a mouse may report many
  // positions in one frame, and a pick looks at every object of the map.
  function hitFor(sx, sy, fresh) {
    const g = groundOf(setRay(sx, sy), G1), ground = store.map?.ground;
    const inside = !!ground && cellIndex(ground, g.x, g.z) >= 0;
    let picked = null;
    const resolve = () => picked ?? (picked = pickAt(sx, sy, fresh, hit));
    const hit = {
      x: g.x, z: g.z, y: g.y, onGround: g.on,   // y: the height of the ground there
      ix: inside ? groundIx(ground, g.x) : -1, iz: inside ? groundIx(ground, g.z) : -1,
      sx, sy,
      get item() { return resolve().item; },
      get kind() { return resolve().kind; },
      get handle() { return resolve().handle; },
    };
    return hit;
  }
  function hitAt(clientX, clientY) {
    return hitFor(clientX, clientY, true);
  }
  // A hit for a known ground point: nothing is picked.
  function hitWorld(x, z) {
    const ground = store.map?.ground, inside = !!ground && cellIndex(ground, x, z) >= 0, y = groundY(x, z);
    const p = toScreen(x, y, z, S1);
    return { x, z, y, onGround: true, ix: inside ? groundIx(ground, x) : -1, iz: inside ? groundIx(ground, z) : -1, sx: p.x, sy: p.y, item: null, kind: null, handle: null };
  }

  function pickAt(sx, sy, fresh, hit) {
    const tool = activeTool(), picks = tool?.picks;
    if (!store.map || !Array.isArray(picks) || !picks.length) return NO_PICK;   // a tool that picks nothing never pays for a pick
    if (!fresh && pickFrame === frameId) {
      if (pickX !== sx || pickY !== sy) sharedHits.add(hit);   // flushHover() puts it right once the frame is over
      return pickResult;
    }
    pickResult = pick(tool, picks, sx, sy);
    pickFrame = frameId;
    pickX = sx;
    pickY = sy;
    return pickResult;
  }

  const pickable = (obj) => ui.isPickable('object', obj);
  // the game preview shows the world as players see it: its markers are neither drawn nor picked
  const markerKinds = (picks) => (mode === 'game' ? [] : picks.filter((kind) => kind !== 'object' && LAYER_OF[kind] && layerOpen(LAYER_OF[kind])));
  // Which discs and interiors are picks depends on the tool: Select takes every spawn disc, the Spawn and Region tools
  // only what is already selected (elsewhere a press creates), every other tool none.
  const interiorsOf = (tool) => tool.interiors ?? (tool.id === 'select' ? 'all' : tool.id === 'spawn' || tool.id === 'region' ? 'selected' : 'none');
  function handlesOf(tool, picks) {
    if (tool.id === 'region') return ['radius', 'vertex', 'edge'];
    return tool.id === 'select' || picks.some((kind) => kind === 'spawn' || kind === 'start' || kind === 'region') ? ['radius'] : [];
  }
  // Was this marker picked by its pin? markers.js says so itself (priority 3); otherwise the cursor is compared with
  // the marker's centre on screen. Scenery is picked AFTER pins and BEFORE outlines, labels and discs.
  function beforeScenery(m, sx, sy) {
    if (m.handle) return true;
    if (typeof m.priority === 'number') return m.priority <= 3;
    if (m.kind === 'region' || !Number.isFinite(m.item?.x)) return false;
    const p = toScreen(m.item.x, groundY(m.item.x, m.item.z), m.item.z, S1);
    return p.front && Math.hypot(p.x - sx, p.y - sy) <= PIN_PX + 0.5;
  }

  function pick(tool, picks, sx, sy) {
    // 1. a gizmo handle
    if (mode !== 'game' && tool.id === 'select' && store.selection.size > 0) {
      const index = gizmo('pick', sx, sy);
      if (index >= 0) return { item: null, kind: null, handle: { type: 'gizmo', index } };
    }
    // 2, 3, 5. markers answer for their handles, pins and areas in one call
    const g = groundOf(setRay(sx, sy), G1), kinds = markerKinds(picks);
    let m = null;
    if (kinds.length) {
      m = markers('pick', RAYCASTER, { x: g.x, z: g.z, onGround: g.on }, { kinds, interiors: interiorsOf(tool), handles: handlesOf(tool, picks) }) ?? null;
      if (m && !(m.item && ui.isPickable(m.kind, m.item))) m = null;
    }
    if (m && beforeScenery(m, sx, sy)) return { item: m.item, kind: m.kind, handle: m.handle ?? null };
    // 4. scenery - and the body of a chest, which stands among it: of the two, what the ray meets first
    if (picks.includes('object') && layerOpen('objects')) {
      const hit = view.pickObject(RAYCASTER, { slopPx: OBJECT_SLOP, viewportHeight: height, filter: pickable });
      if (hit && !(m && m.part === 'body' && m.distance <= hit.distance)) return { item: hit.obj, kind: 'object', handle: null };
    }
    return m ? { item: m.item, kind: m.kind, handle: null } : NO_PICK;
  }

  // Everything a click could mean at this pixel, in pick order: what the Select tool cycles through.
  function hitStack(clientX, clientY) {
    const tool = activeTool(), picks = Array.isArray(tool?.picks) ? tool.picks : [];
    if (!store.map || !picks.length) return [];
    const g = groundOf(setRay(clientX, clientY), G1), out = [], seen = new Set();
    const push = (item, kind) => {
      if (!item || seen.has(item) || !ui.isPickable(kind, item)) return;
      seen.add(item);
      out.push({ item, kind });
    };
    const kinds = markerKinds(picks);
    const list = kinds.length ? markers('stack', { x: g.x, z: g.z, onGround: g.on }, clientX, clientY, { kinds }) ?? [] : [];
    for (const m of list) if (beforeScenery(m, clientX, clientY)) push(m.item, m.kind);
    if (picks.includes('object') && layerOpen('objects')) {
      // first what a click picks (it may be a small prop next to the cursor), then every object the ray goes through
      const near = view.pickObject(RAYCASTER, { slopPx: OBJECT_SLOP, viewportHeight: height, filter: pickable });
      if (near) push(near.obj, 'object');
      for (const hit of view.pickObjects(RAYCASTER, { filter: pickable })) push(hit.obj, 'object');
    }
    for (const m of list) push(m.item, m.kind);
    return out;
  }

  // The local bounds of a model, once it is loaded (the view hands models out as promises only).
  function modelBox(id) {
    const known = modelBoxes.get(id);
    if (known !== undefined) return known;
    modelBoxes.set(id, null);
    view.loadModel(id).then((model) => {
      modelBoxes.set(id, model.bounds);
      selDirty = true;
      invalidate();
    });
    return null;
  }
  // the point that stands for an item in a box select: an object's middle, a marker's centre
  function anchorOf(item, kind, out) {
    if (kind === 'object') {
      const b = modelBox(item.m);   // (an object's y is counted from the ground it stands on)
      return out.set(item.x, groundY(item.x, item.z) + item.y + (b ? (b.max.y - b.min.y) * 0.5 * item.s * item.sy : 0.5), item.z);
    }
    const a = markers('anchorOf', item);
    if (a && Number.isFinite(a.x) && Number.isFinite(a.z)) return out.set(a.x, a.y ?? groundY(a.x, a.z), a.z);
    if (kind === 'region') {
      const b = shapeBounds(item.shape), x = (b.minX + b.maxX) / 2, z = (b.minZ + b.maxZ) / 2;
      return out.set(x, groundY(x, z), z);
    }
    return out.set(item.x, groundY(item.x, item.z), item.z);
  }
  function itemsInRect(x0, y0, x1, y1, kinds) {
    const map = store.map, out = [];
    if (!map || !Array.isArray(kinds)) return out;
    const left = Math.min(x0, x1), right = Math.max(x0, x1), top = Math.min(y0, y1), bottom = Math.max(y0, y1);
    for (const kind of kinds) {
      const layer = LAYER_OF[kind];
      if (!layer || !layerOpen(layer) || (kind !== 'object' && mode === 'game')) continue;
      for (const item of store.items(kind) ?? []) {
        if (!item || !ui.isPickable(kind, item)) continue;
        const a = anchorOf(item, kind, V), p = toScreen(a.x, a.y, a.z, S1);
        if (p.front && p.x >= left && p.x <= right && p.y >= top && p.y <= bottom) out.push(item);
      }
    }
    return out;
  }

  // The ground under the four corners of the view, going round: bottom left, bottom right, top right, top left.
  function viewQuad() {
    const r = rect(), out = [];
    for (const [fx, fy] of [[0, 1], [1, 1], [1, 0], [0, 0]]) {
      const g = groundOf(setRay(r.left + fx * r.width, r.top + fy * r.height), G1);
      out.push([g.x, g.z]);
    }
    return out;
  }

  // ---------------------------------------------------------------- bounds of items

  function itemBounds(item, kind, target) {
    if (kind === 'object') return view.boundsOf(item, target);
    const b = markers('boundsOf', item, target);
    if (b?.isBox3 && !b.isEmpty()) return b === target ? target : target.copy(b);
    if (kind === 'region') {
      const s = shapeBounds(item.shape), y = groundY((s.minX + s.maxX) / 2, (s.minZ + s.maxZ) / 2);
      return target.set(V.set(s.minX, y, s.minZ), V2.set(s.maxX, y + 0.1, s.maxZ));
    }
    const r = Math.max(item.r ?? 0, 0.6), y = groundY(item.x, item.z);
    return target.set(V.set(item.x - r, y, item.z - r), V2.set(item.x + r, y + 0.1, item.z + r));
  }
  function boundsOfItems(items, target) {
    target.makeEmpty();
    for (const item of items) {
      const kind = store.kindOf(item);
      if (kind) target.union(itemBounds(item, kind, BOX2));
    }
    return target;
  }

  // ---------------------------------------------------------------- readout, tip, cursor

  // Puts a floating text at (x, y) of the viewport; at the right and bottom edges it moves to the other side.
  function place(node, x, y) {
    const w = node.offsetWidth, h = node.offsetHeight;
    node.style.left = `${Math.max(0, x + w > width ? x - w - 24 : x)}px`;
    node.style.top = `${Math.max(0, y + h > height ? y - h - 12 : y)}px`;
  }
  // The readout shows what a tool says by the cursor; while none does, the boot progress in the corner.
  function showReadout() {
    const text = readoutText ?? progressText;
    readoutEl.hidden = text === null;
    if (text === null) return;
    if (readoutEl.textContent !== text) readoutEl.textContent = text;
    const r = rect();
    if (readoutText !== null) place(readoutEl, pointer.sx - r.left + 16, pointer.sy - r.top - 30);
    else place(readoutEl, 12, height - readoutEl.offsetHeight - 12);
  }
  function readout(text) {
    readoutText = text === null || text === undefined || text === '' ? null : String(text);
    showReadout();
  }
  function progress(text) {
    if (progressText !== null && ui.status === progressText) ui.setStatus(text ?? '');
    else if (text !== null) ui.setStatus(text);
    progressText = text;
    showReadout();
  }

  function placeTip() {
    if (tipEl.hidden) return;
    const r = rect();
    place(tipEl, pointer.sx - r.left + 14, pointer.sy - r.top + 18);
  }
  // The tip names the hovered item once the cursor has rested on it; null hides it at once.
  function showTip(text) {
    clearTimeout(tipTimer);
    tipEl.hidden = true;
    tipText = text;
    if (!text) return;
    tipTimer = setTimeout(() => {
      if (tipText !== text || press || modal || !pointer.inside) return;
      tipEl.textContent = text;   // names from the map are data: never markup
      tipEl.hidden = false;
      placeTip();
    }, TIP_DELAY);
  }
  function labelOf(item, kind) {
    if (kind === 'object') return item.g ? `${item.m} · ${item.g}` : item.m;
    const text = markers('labelOf', item);
    if (typeof text === 'string' && text) return text;
    if (kind === 'region') return regionLabel(item);
    return kind === 'start' ? 'Start point' : kind === 'npc' ? item.kind : kind;
  }

  // The hovered item is the one a click would pick: tinted in the view or in the markers, named by the tip.
  function setHover(item, kind) {
    if (item === hoverItem) return;
    if (hoverKind === 'object') view.setHover(null);
    else if (hoverItem) markers('setHover', null);
    hoverItem = item;
    hoverKind = item ? kind : null;
    if (hoverKind === 'object') view.setHover(item);
    else if (item) markers('setHover', item);
    showTip(item ? labelOf(item, kind) : null);
    invalidate();
  }
  // At most once per animation frame: the latest pointer position decides.
  function flushHover() {
    let hit = pendingHover;
    if (!hit) return;
    pendingHover = null;
    const idle = !press && !modal && pointer.inside;
    if (idle && sharedHits.has(hit)) {
      // What this hit reported was picked for an earlier pointer position of its frame. The pointer may have come to
      // rest here: the pick is made again for this very pixel, and the tool is told when it says something else.
      const exact = hitFor(hit.sx, hit.sy, true), a = exact.handle, b = hit.handle;
      if (exact.item !== hit.item || a?.type !== b?.type || a?.index !== b?.index) {
        const tool = activeTool();
        ui.set('cursor', exact);
        if (tool && pointer.ev) call(tool, toolName(tool), 'pointerMove', pointer.ev, exact);
      }
      hit = exact;
    }
    const item = idle ? hit.item : null, handle = idle ? hit.handle : null;
    setHover(item, item ? hit.kind : null);
    gizmo('setHover', handle?.type === 'gizmo' ? handle.index : -1);
    if (hoverHandle !== !!handle) {
      hoverHandle = !!handle;
      refreshCursor();
    }
  }

  function setCursor(css) {
    toolCursor = css || null;
    refreshCursor();
  }
  // not-allowed: the tool's layer is locked or hidden, or the cursor is off the island (for Terrain: off the ground grid)
  function forbiddenAt(hit) {
    const tool = activeTool(), map = store.map, layer = tool?.layer;
    if (!map || !layer || modal) return false;
    if (!layerOpen(layer)) return true;
    if (layer === 'ground') return hit.ix < 0;
    return !hit.onGround || Math.hypot(hit.x, hit.z) > map.radius;
  }
  function refreshCursor() {
    let css;
    if (press && (press.kind === 'pan' || (press.kind === 'orbit' && press.moved))) css = 'grabbing';
    else if (spaceHeld) css = 'grab';
    else if (modal) css = modal.type === 'grab' ? 'move' : 'crosshair';
    else if (forbidden) css = 'not-allowed';
    else if (toolCursor) css = toolCursor;
    else if (hoverHandle) css = 'pointer';
    else {
      const context = toolContext(activeTool());
      css = context === 'ghost' || context === 'brush' || context === 'path' ? 'crosshair' : 'default';
    }
    if (css !== cursorNow) dom.style.cursor = cursorNow = css;
  }

  // ---------------------------------------------------------------- modals: grab and pickPoint

  // While a modal is open no tool gets pointer events; the camera keeps working. One at a time: a second one cancels the first.
  function openModal(m) {
    if (modal) cancelModal();
    modal = m;
    ui.setStatus(m.label ?? '');
    setHover(null, null);
    refreshCursor();
    invalidate();
  }
  function closeModal(value) {
    const m = modal;
    if (!m) return;
    modal = null;
    if (ui.status === (m.label ?? '')) ui.setStatus('');
    readout(null);
    refreshCursor();
    invalidate();
    m.resolve(value);
  }
  // Escape, a right-click, a tool switch, a new map. -> true when a modal was open.
  function cancelModal() {
    const m = modal;
    if (!m) return false;
    if (m.type === 'grab') {
      if (store.grouping) store.cancel();   // the whole group of the caller: a cancelled duplicate leaves nothing behind
      closeModal(false);
    } else closeModal(null);
    return true;
  }

  // A modal move of `items` inside the store group the caller has ALREADY opened. -> Promise<boolean>
  function grab(items, label = 'Move') {
    return new Promise((resolve) => {
      const list = Array.from(items ?? []);
      if (!store.grouping) {
        console.warn('[editor] viewport.grab needs an open store group (store.begin)');
        resolve(false);
        return;
      }
      if (!list.length) {
        store.commit();
        resolve(true);
        return;
      }
      let from = null;
      if (pointer.inside) {
        const g = groundOf(setRay(pointer.sx, pointer.sy), G1);
        if (g.on) from = { x: g.x, z: g.z };
      }
      // `from` is where the cursor was when the grab began (or first shows up): the items keep their offset to it
      openModal({ type: 'grab', label, resolve, snap: ctx.cmd.snapshot(list), pivot: pivotOf(ctx, list), from });
    });
  }
  // The next left click on the ground. -> Promise<{ x, z } | null>
  function pickPoint(label = 'Click a point') {
    return new Promise((resolve) => openModal({ type: 'pick', label, resolve }));
  }
  function modalMove(hit, ev) {
    const m = modal;
    if (!m || m.type !== 'grab' || !hit.onGround) return;
    if (!store.grouping) {   // somebody closed the group under the grab: there is nothing left to move
      closeModal(false);
      return;
    }
    if (!m.from) m.from = { x: hit.x, z: hit.z };
    // snapping is absolute: the pivot lands on the grid, as in a drag
    const to = snapPoint(ctx, m.pivot.x + hit.x - m.from.x, m.pivot.z + hit.z - m.from.z, ev);
    // one offset on the map's grid for all items: what was aligned before the move is aligned after it
    const dx = qPos(to.x - m.pivot.x), dz = qPos(to.z - m.pivot.z);
    store.exec(ctx.cmd.transform(m.snap, { dx, dz, pivot: m.pivot }));
    readout(`${dx.toFixed(2)}, ${dz.toFixed(2)}`);
  }
  function modalClick(hit, ev) {
    const m = modal;
    if (!m) return;
    if (m.type === 'grab') {
      modalMove(hit, ev);
      if (modal !== m) return;
      if (store.grouping) store.commit();
      closeModal(true);
    } else if (hit.onGround) closeModal({ x: qPos(hit.x), z: qPos(hit.z) });
  }

  // ---------------------------------------------------------------- pointer

  function note(ev) {
    pointer.sx = ev.clientX;
    pointer.sy = ev.clientY;
    pointer.inside = true;
    pointer.ev = ev;
  }
  const spaceDown = () => ctx.keymap?.held?.has?.('Space') === true;

  function onPointerDown(ev) {
    note(ev);
    if (press) return;   // a second button during a press belongs to nobody
    // Ctrl + click is the secondary click on macOS
    const button = MAC && ev.button === 0 && ev.ctrlKey ? 2 : ev.button;
    if (button !== 0 && button !== 1 && button !== 2) return;
    if (button === 1) ev.preventDefault();   // no autoscroll
    // a click into the viewport ends typing: the field commits its value before a tool acts on the map
    const active = document.activeElement;
    if (active && active !== document.body && active !== dom) active.blur?.();
    try { dom.setPointerCapture(ev.pointerId); } catch { /* a synthetic event has no pointer to capture */ }
    showTip(null);
    const p = press = {
      id: ev.pointerId, mask: ev.button === 1 ? 4 : ev.button === 2 ? 2 : 1, kind: 'none',
      x0: ev.clientX, y0: ev.clientY, lx: ev.clientX, ly: ev.clientY, moved: false, tool: null, modal: null, grab: null, ev,
    };
    if (button === 2) p.kind = 'orbit';
    else if (button === 1 || spaceDown()) {
      p.kind = 'pan';
      const g = groundOf(setRay(ev.clientX, ev.clientY), G1);
      if (g.on) p.grab = { x: g.x, z: g.z };   // the ground point that stays under the cursor
    } else if (modal) {
      p.kind = 'modal';
      p.modal = modal;
    } else {
      const tool = activeTool();
      if (tool) {
        p.kind = 'tool';
        p.tool = tool;
        const hit = hitFor(ev.clientX, ev.clientY, true);
        ui.set('cursor', hit);
        call(tool, toolName(tool), 'pointerDown', ev, hit);
      }
    }
    refreshCursor();
  }

  // Ends the press. A tool that got pointerDown gets its pointerUp whatever ended it: the button, a lost capture, a
  // cancelled pointer, the window losing focus (then with the last event of the press: a pointercancel has no position).
  function release(ev, cancelled) {
    const p = press;
    if (!p) return;
    press = null;
    try { dom.releasePointerCapture(p.id); } catch { /* already gone */ }
    const e = ev ?? p.ev;
    if (p.kind === 'tool') call(p.tool, toolName(p.tool), 'pointerUp', e, hitFor(e.clientX, e.clientY, true));
    else if (p.kind === 'modal') {
      if (!cancelled && modal && modal === p.modal) modalClick(hitFor(e.clientX, e.clientY, true), e);
    } else if (p.kind === 'orbit' && !cancelled && !p.moved) rightClick(e);
    refreshCursor();
  }

  // A right-click without a drag cancels (§11.3): an open modal; else the tool's own work; else back to Select.
  // It never clears the selection.
  function rightClick(ev) {
    if (cancelModal()) return;
    const tool = activeTool();
    if (tool && call(tool, toolName(tool), 'key', 'cancel', ev) === true) return;
    if (ui.tool !== 'select' && ctx.tools?.select) ui.set('tool', 'select');
  }

  function orbitBy(dx, dy) {
    stopAnim('yaw', 'pitch');
    rig.yaw -= dx * 0.006;
    rig.pitch += dy * 0.006;
    applyRig();
  }
  // Panning grabs the ground: the point under the cursor at the press stays under the cursor.
  function panBy(p, sx, sy, dx, dy) {
    const g = groundOf(setRay(sx, sy), G1);
    if (p.grab && g.on) {
      let mx = p.grab.x - g.x, mz = p.grab.z - g.z;
      const l = Math.hypot(mx, mz), max = rig.distance * 2;   // near the horizon a pixel is a mile: one move must not fling the camera away
      if (l > max) { mx *= max / l; mz *= max / l; }
      rig.x += mx; rig.z += mz;
    } else {
      // the cursor is over the sky: move by what a pixel covers at the target
      const u = 2 * rig.distance * Math.tan(FOV * DEG / 2) / height, sin = Math.sin(rig.yaw), cos = Math.cos(rig.yaw);
      const r = -dx * u, f = dy * u / Math.max(0.3, Math.sin(rig.pitch));
      rig.x += cos * r - sin * f;
      rig.z += -sin * r - cos * f;
    }
    stopAnim('x', 'z');
    applyRig();
  }

  function onPointerMove(ev) {
    note(ev);
    // inside a chord (left down, right down, left up) the browser sends no pointerup: the buttons say it
    if (press && ev.pointerId === press.id && !(ev.buttons & press.mask)) release(ev, false);
    const p = press;
    if (p && ev.pointerId !== p.id) return;   // a second pointer while one is down
    if (p) {
      p.ev = ev;
      if (!p.moved && Math.hypot(ev.clientX - p.x0, ev.clientY - p.y0) >= CLICK_PX) {
        p.moved = true;
        p.lx = ev.clientX; p.ly = ev.clientY;   // an orbit starts here, not with a jump of the click threshold
        refreshCursor();
      }
    }
    if (readoutText !== null) showReadout();
    placeTip();
    if (p && (p.kind === 'orbit' || p.kind === 'pan')) {
      const dx = ev.clientX - p.lx, dy = ev.clientY - p.ly;
      if (p.kind === 'pan' || p.moved) {
        p.lx = ev.clientX; p.ly = ev.clientY;
        if (p.kind === 'orbit') orbitBy(dx, dy);
        else panBy(p, ev.clientX, ev.clientY, dx, dy);
      }
      ui.set('cursor', hitFor(ev.clientX, ev.clientY, false));
      return;
    }
    const hit = hitFor(ev.clientX, ev.clientY, false);
    ui.set('cursor', hit);
    const no = forbiddenAt(hit);
    if (no !== forbidden) {
      forbidden = no;
      refreshCursor();
    }
    if (modal) {
      modalMove(hit, ev);
      return;
    }
    if (p && p.kind !== 'tool') return;   // a press nobody owns (its tool or its modal went away under it)
    const tool = p ? p.tool : activeTool();
    if (tool) call(tool, toolName(tool), 'pointerMove', ev, hit);
    if (!p) pendingHover = hit;
  }

  function onPointerUp(ev) {
    note(ev);
    if (press && ev.pointerId === press.id) release(ev, false);
  }
  function onPointerCancel(ev) {
    if (press && ev.pointerId === press.id) release(null, true);
  }
  function onPointerLeave() {
    if (press) return;   // captured: the pointer is still ours
    pointer.inside = false;
    pendingHover = null;
    setHover(null, null);
    gizmo('setHover', -1);
    hoverHandle = false;
    forbidden = false;
    refreshCursor();
    ui.set('cursor', null);
  }
  function onBlur() {
    release(null, true);
    showTip(null);
  }

  function onDoubleClick(ev) {
    if (ev.button !== 0 || modal || spaceDown() || (MAC && ev.ctrlKey)) return;
    const tool = activeTool();
    if (typeof tool?.doubleClick !== 'function') return;
    call(tool, toolName(tool), 'doubleClick', ev, hitFor(ev.clientX, ev.clientY, true));
  }

  function zoomAt(sx, sy, factor) {
    const before = rig.distance, after = clamp(before * factor, DISTANCE_MIN, 3 * radius()), k = after / before;
    if (k === 1) return;
    const g = groundOf(setRay(sx, sy), G1);
    stopAnim('x', 'z', 'distance');
    // the whole rig shrinks towards the ground point under the cursor, so that point stays where it is on screen
    if (g.on) { rig.x = g.x + (rig.x - g.x) * k; rig.z = g.z + (rig.z - g.z) * k; }
    rig.distance = after;
    applyRig();
  }
  // The one wheel listener: always prevents the default, or a pinch would zoom the page and a wheel scroll it.
  function onWheel(ev) {
    ev.preventDefault();
    let d = ev.deltaY;
    if (ev.shiftKey && !d) d = ev.deltaX;   // macOS turns Shift + wheel into a horizontal scroll
    if (ev.deltaMode === 1) d *= 16;
    else if (ev.deltaMode === 2) d *= 100;
    if (!d) return;
    d = clamp(d, -240, 240);
    showTip(null);
    if (ev.shiftKey && !ev.ctrlKey) {
      stopAnim('yaw');
      rig.yaw += d * 0.0025;
      applyRig();
      return;
    }
    zoomAt(ev.clientX, ev.clientY, Math.exp(d * (ev.ctrlKey ? 0.01 : 0.0016)));   // a pinch arrives as small Ctrl + wheel steps
  }

  // W A S D and the arrows pan while held (Shift x 3). The keymap owns the keyboard; this only reads its held set.
  function keyPan(dt) {
    const held = ctx.keymap?.held;
    if (!held?.size || !store.map || !(dt > 0)) return;
    const right = (held.has('KeyD') || held.has('ArrowRight') ? 1 : 0) - (held.has('KeyA') || held.has('ArrowLeft') ? 1 : 0);
    const ahead = (held.has('KeyW') || held.has('ArrowUp') ? 1 : 0) - (held.has('KeyS') || held.has('ArrowDown') ? 1 : 0);
    if (!right && !ahead) return;
    const fast = held.has('ShiftLeft') || held.has('ShiftRight');
    const step = rig.distance * 1.1 * (fast ? 3 : 1) * dt / Math.hypot(right, ahead);
    const sin = Math.sin(rig.yaw), cos = Math.cos(rig.yaw);
    rig.x += (cos * right - sin * ahead) * step;
    rig.z += (-sin * right - cos * ahead) * step;
    stopAnim('x', 'z');
    applyRig();
  }

  // The camera moved under a resting cursor: what is under it has changed as if the pointer had moved.
  function reaim() {
    const p = press, ev = p ? p.ev : pointer.ev;
    if (!ev || !pointer.inside || (p && p.kind !== 'tool' && p.kind !== 'modal')) return;
    const hit = hitFor(pointer.sx, pointer.sy, false);
    ui.set('cursor', hit);
    if (modal) modalMove(hit, ev);
    else if (!p || p.kind === 'tool') {
      const tool = p ? p.tool : activeTool();
      if (tool) call(tool, toolName(tool), 'pointerMove', ev, hit);
      if (!p) pendingHover = hit;
    }
  }

  // The test hook's pointer: the same path as a real one. type: 'down' | 'move' | 'up' | 'dblclick';
  // mods: { mod, shift, alt } as in __editor.key.
  function input(type, clientX, clientY, mods = {}) {
    const held = type === 'down' || (type === 'move' && press?.id === -1);
    const ev = {
      type: type === 'dblclick' ? 'dblclick' : `pointer${type}`, synthetic: true, pointerId: -1, pointerType: 'mouse',
      clientX, clientY, button: 0, buttons: held ? 1 : 0, detail: type === 'dblclick' ? 2 : 1,
      shiftKey: !!mods.shift, altKey: !!mods.alt, ctrlKey: !MAC && !!mods.mod, metaKey: MAC && !!mods.mod,
      preventDefault() {}, stopPropagation() {},
    };
    if (type === 'down') onPointerDown(ev);
    else if (type === 'move') onPointerMove(ev);
    else if (type === 'up') onPointerUp(ev);
    else if (type === 'dblclick') onDoubleClick(ev);
    else throw new TypeError(`viewport.input: unknown type '${type}'`);
  }

  // ---------------------------------------------------------------- preview modes

  function applyPreview(next) {
    mode = next === 'game' || Object.hasOwn(MOODS, next) ? next : 'neutral';
    const neutral = mode === 'neutral';
    neutralHemi.visible = neutralSun.visible = neutral;
    if (neutral) {
      lighting.setEnabled(false);
      scene.background = background;
    } else {
      lighting.setEnabled(true);
      lighting.setFog(mode === 'game');
      lighting.setShadows(mode === 'game');
      if (mode !== 'game') lighting.set(mode);   // the game preview takes the mood at the camera target, frame by frame
    }
    pickFrame = -1;
    setHover(null, null);
    invalidate();
  }
  function setPreview(next) {
    if (ui.preview !== next) ui.set('preview', next);   // the listener below applies it
    else if (mode !== next) applyPreview(next);
  }

  // ---------------------------------------------------------------- core overlays, drawn

  function instances(set, n) {
    if (!set.mesh || set.mesh.instanceMatrix.count < n) {
      if (set.mesh) {
        set.mesh.removeFromParent();
        set.mesh.dispose();
      }
      set.mesh = new THREE.InstancedMesh(set.geometry, colliderMaterial, THREE.MathUtils.ceilPowerOfTwo(Math.max(16, n)));
      set.mesh.frustumCulled = false;   // spread over the whole map: there is always some of it in view
      set.mesh.renderOrder = 2;
      colliderGroup.add(set.mesh);
    }
    set.mesh.count = n;
    set.mesh.instanceMatrix.needsUpdate = true;
    return set.mesh.instanceMatrix.array;
  }
  // What blocks: the collider circles and boxes of the view, and every ground vertex of a blocking type. The shapes
  // are laid out on y = 0; their material lifts every vertex onto the ground (the drape).
  function rebuildColliders() {
    const map = store.map;
    colVersion = view.obstaclesVersion;
    colGround = groundVersion;
    if (!map) return;
    const o = view.obstacles();
    let a = instances(colliders.circle, o.nCircles);
    for (let i = 0, k = 0; i < o.nCircles; i++, k += 3) {
      M.makeScale(o.circles[k + 2], 1, o.circles[k + 2]).setPosition(o.circles[k], 0, o.circles[k + 1]).toArray(a, i * 16);
    }
    a = instances(colliders.box, o.nBoxes);
    for (let i = 0, k = 0; i < o.nBoxes; i++, k += 5) {
      M.makeRotationY(o.boxes[k + 4]).scale(V.set(o.boxes[k + 2], 1, o.boxes[k + 3])).setPosition(o.boxes[k], 0, o.boxes[k + 1]).toArray(a, i * 16);
    }
    const { cells, size, cell } = map.ground;
    let n = 0;
    for (let i = 0; i < cells.length; i++) if (BLOCK[cells[i]]) n++;
    a = instances(colliders.cell, n);
    M.makeScale(cell / 2, 1, cell / 2);
    for (let i = 0, j = 0; i < cells.length; i++) {
      if (!BLOCK[cells[i]]) continue;
      M.setPosition(groundX(map.ground, i % size), 0, groundX(map.ground, Math.floor(i / size))).toArray(a, j++ * 16);
    }
  }

  // Writes the 12 edges of a box (in the frame of `matrix`, or in the world) as box number n. -> the next n
  function writeBox(n, matrix, box) {
    if (box.isEmpty() || n >= MAX_BOXES) return n;
    for (let i = 0; i < 8; i++) {
      CORNERS[i].set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      if (matrix) CORNERS[i].applyMatrix4(matrix);
    }
    for (let e = 0, o = n * 72; e < 24; e++, o += 3) CORNERS[EDGES[e]].toArray(selPositions, o);
    return n + 1;
  }
  // One box per selected item - turned with the object it surrounds - or one around a large selection; and the pivot.
  function rebuildSelection() {
    selDirty = false;
    const items = store.map ? [...store.selection] : [];
    let n = 0;
    if (items.length > MAX_BOXES) n = writeBox(n, null, boundsOfItems(items, BOX));
    else {
      for (const item of items) {
        const kind = store.kindOf(item);
        if (!kind) continue;
        const local = kind === 'object' ? modelBox(item.m) : null;
        n = local ? writeBox(n, view.matrixOf(item, M), local) : writeBox(n, null, itemBounds(item, kind, BOX));
      }
    }
    selGeometry.setDrawRange(0, n * 24);
    selGeometry.attributes.position.needsUpdate = true;
    selLines.visible = n > 0;
    pivot = null;
    if (items.length) {
      try {
        const p = pivotOf(ctx, items);
        if (Number.isFinite(p?.x) && Number.isFinite(p?.z)) pivot = p;
      } catch (err) {
        reportOnce('viewport', 'pivotOf', err);
      }
    }
  }

  function brush(x, z, r, { inner = 0, color = null } = {}) {
    if (x === null || x === undefined || !Number.isFinite(x) || !Number.isFinite(z) || !(r > 0)) {
      if (brushState.on) {
        brushState.on = false;
        invalidate();
      }
      return;
    }
    Object.assign(brushState, { on: true, x, z, radius: r, inner });
    brushRing.material.color.set(color ?? 0xffffff);
    brushFill.material.color.set(color ?? 0xffffff);
    brushDirty = true;
    invalidate();
  }
  function drawBrush() {
    brushGroup.visible = brushState.on;
    if (!brushState.on || !brushDirty) return;
    brushDirty = false;
    const { x, z, radius: r, inner } = brushState, array = brushRing.geometry.attributes.position.array;
    // two pixels wide at any zoom, but never a ring so fat that it hides what a small brush points at
    const t = clamp(unitsPerPixel(x, groundY(x, z), z) * 2, 0.02, r * 0.3), second = inner > 0 && inner < r - t * 2;
    // the ring and the disc inside it lie ON the terrain: a ring through the middle of a hill would show where the
    // brush is on the map, not what it is about to touch
    const o = writeRing(array, 0, x, z, r - t, r, groundY);
    writeRing(array, o, x, z, second ? inner - t * 0.6 : 0, second ? inner : 0, groundY);
    brushRing.geometry.attributes.position.needsUpdate = true;
    const fill = brushDisc.attributes.position.array;
    for (let i = 0; i < fill.length; i += 3) {
      const px = x + brushUnit[i] * r, pz = z + brushUnit[i + 2] * r;
      fill[i] = px; fill[i + 1] = groundY(px, pz) + BRUSH_LIFT; fill[i + 2] = pz;
    }
    brushDisc.attributes.position.needsUpdate = true;
  }

  // Everything the viewport draws itself, brought up to date right before a frame is drawn.
  function updateVisuals() {
    const map = store.map, o = ui.overlays ?? {};
    if (mode === 'game' && map) {
      lighting.set(moodAt(map, rig.x, rig.z));
      lighting.follow(rig.x, rig.z, clamp(rig.distance * 0.6, 30, 300));   // the whole shadow rig scales with the view
    }
    const terrain = view.groundGeometry;   // another object after the grid changed size
    if (terrain && gridMesh.geometry !== terrain) gridMesh.geometry = terrain;
    gridMesh.visible = !!map && !!terrain && (!!o.grid || !!o.boundary);
    gridMaterial.uniforms.uGrid.value = o.grid ? 1 : 0;
    gridMaterial.uniforms.uBoundary.value = o.boundary ? 1 : 0;
    colliderGroup.visible = !!map && !!o.colliders;
    // only while they are shown, and at most once per frame however many objects moved
    if (colliderGroup.visible && (colVersion !== view.obstaclesVersion || colGround !== groundVersion)) rebuildColliders();
    if (selDirty) rebuildSelection();
    gizmo('update', camera);
    // the gizmo has a centre of its own: the mark shows the pivot wherever there is no gizmo
    const mark = !!pivot && !ctx.gizmo?.visible;
    pivotMark.visible = mark;
    if (mark) {
      const y = groundY(pivot.x, pivot.z);
      pivotMark.position.set(pivot.x, y, pivot.z);
      pivotMark.quaternion.copy(camera.quaternion);
      pivotMark.scale.setScalar(Math.max(unitsPerPixel(pivot.x, y, pivot.z), 1e-6));
    }
    drawBrush();
  }

  // ---------------------------------------------------------------- the frame

  function render() {
    const info = renderer.info;
    info.reset();
    if (mode === 'game') {
      // The game preview shows the world as players see it: only the map and the light rig. Hidden for this one draw,
      // so nobody else has to know about preview modes.
      const rigged = [view.root, lighting.hemi, lighting.sun, lighting.sun.target];
      stash.length = 0;
      for (const child of scene.children) {
        if (child.visible && !rigged.includes(child)) {
          child.visible = false;
          stash.push(child);
        }
      }
      composer ??= createComposer(renderer, scene, camera);
      try {
        composer.render();
      } finally {
        for (const child of stash) child.visible = true;
        stash.length = 0;
      }
    } else renderer.render(scene, camera);
    stats.calls = info.render.calls;
    stats.triangles = info.render.triangles;
  }
  function draw() {
    updateVisuals();
    render();
  }

  // One frame: camera -> the active tool -> the view -> markers -> overlays -> panels -> draw.
  function frame(dt, now, fromLoop) {
    needsFrame = false;
    if (!fromLoop) {   // the loop has counted this frame and read the keys already
      frameId++;
      keyPan(dt);
    }
    stepAnim(dt);
    settle(dt);
    if (cameraMoved) {
      cameraMoved = false;
      brushDirty = true;
      reaim();
    }
    flushHover();
    const tool = activeTool();
    if (tool) call(tool, toolName(tool), 'update', dt);
    if (view.update(now / 1000, dt)) needsFrame = true;   // foliage tiles or models still queued: come back next frame
    markers('update', dt, camera);
    const overlays = ctx.overlays;
    if (overlays) for (const id of Object.keys(overlays)) call(overlays[id], `overlay ${id}`, 'update', dt);
    for (const p of panels) call(p.panel, p.name, 'update', dt);
    draw();
    // frames per second from the time between two frames drawn in a row; a frame after a pause says nothing
    if (fromLoop) {
      const gap = now - lastRender;
      lastRender = now;
      if (gap > 0 && gap < 250) fps = fps ? fps + (1000 / gap - fps) * 0.2 : 1000 / gap;
    }
  }
  function tick(dt = 1 / 60) {
    resize();   // a hidden tab delivers no ResizeObserver callbacks: a frame stepped by hand measures the canvas itself
    frame(Number.isFinite(dt) && dt > 0 ? dt : 0, performance.now(), false);
  }
  // Runs on every animation frame and draws only when somebody asked: an idle editor renders nothing.
  function loop(now) {
    if (disposed) return;
    raf = requestAnimationFrame(loop);
    const dt = clamp((now - lastLoop) / 1000, 0, 0.1);
    lastLoop = now;
    frameId++;   // a new frame: hover may pick again, the canvas may have moved
    const space = spaceDown();
    if (space !== spaceHeld) {
      spaceHeld = space;
      refreshCursor();
    }
    keyPan(dt);
    flushHover();
    if (needsFrame || anim) frame(dt, now, true);
  }

  function resize() {
    const w = el.clientWidth, h = el.clientHeight, ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (!w || !h || (w === width && h === height && ratio === renderer.getPixelRatio())) return;
    width = w;
    height = h;
    renderer.setPixelRatio(ratio);
    renderer.setSize(w, h, false);   // the style stays 100 %: the canvas follows its container, never the other way round
    composer?.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    rectBox = null;
    cameraChanged();
    brushDirty = true;
    draw();   // now: a canvas that changed size is blank until it is drawn again
  }

  // ---------------------------------------------------------------- wiring: store and ui -> the view

  function applyLayers() {
    const layers = ui.layers ?? {};
    for (const layer of ['objects', 'foliage', 'ground']) view.setVisible(layer, layers[layer]?.visible !== false);   // halos follow objects
    for (const layer of ['spawns', 'chests', 'npcs', 'regions', 'start']) markers('setVisible', layer, layers[layer]?.visible !== false);
    pickFrame = -1;
    setHover(null, null);
    refreshCursor();
    invalidate();
  }
  function applyHiddenModels(next) {
    const now = new Set(next ?? []);
    for (const id of hiddenModels) if (!now.has(id)) view.setModelVisible(id, true);
    for (const id of now) if (!hiddenModels.has(id)) view.setModelVisible(id, false);
    hiddenModels = now;
    pickFrame = -1;
    invalidate();
  }
  // The map's own layers hide objects one by one: the scenery of "Town" is spread over many models, and every model
  // is used by other layers too. A full pass over the objects, made only while some layer is hidden (or was).
  function applyCustomLayers() {
    const map = store.map;
    let any = false;
    for (const state of ui.customLayers?.values() ?? []) if (!state.visible) { any = true; break; }
    if (map && (any || hiddenObjects)) {
      const off = any ? map.objects.filter((obj) => ui.layerHidden(obj)) : [];
      view.setObjectsHidden(off);
      hiddenObjects = off.length > 0;
    }
    pickFrame = -1;
    setHover(null, null);
    refreshCursor();
    selDirty = true;
    invalidate();
  }
  // One object came into the map, or changed - its layer among other things.
  function hideByLayer(obj) {
    if (store.kindOf(obj) !== 'object') return;
    const off = ui.layerHidden(obj);
    view.setObjectHidden(obj, off);
    if (off) hiddenObjects = true;
  }
  function syncSelection() {
    const selected = store.map ? [...store.selection] : [];
    view.setSelected(selected.filter((item) => store.kindOf(item) === 'object'));
    // the gizmo belongs to the Select tool: with any other tool it has nothing to hold
    gizmo('setItems', ui.tool === 'select' ? selected : []);
    selDirty = true;
    pickFrame = -1;
    invalidate();
  }
  function fitMap() {
    const R = radius();
    gridMaterial.uniforms.uRadius.value = R;
    applyRig();   // the limits of distance and target follow the radius
  }

  async function onLoad() {
    const map = store.map, id = ++loads;
    if (!map) return;
    cancelModal();
    pendingHover = null;
    hoverItem = hoverKind = null;   // the view and the markers forget their hover themselves
    showTip(null);
    groundVersion++;
    drape.sync(map);
    lag = 0;
    brushDirty = true;
    fitMap();
    if (!homed) {   // the first map: start at the start point. A revert or an import keeps the camera where it is
      homed = true;
      home(false);
    }
    registerActions();
    const loading = view.load(map, { onProgress: (done, total) => { if (id === loads) progress(`Models ${done} / ${total}`); } });
    // the view forgets its hidden models on every load
    hiddenModels = new Set();
    applyHiddenModels(ui.hiddenModels);
    hiddenObjects = false;   // ... and the objects it hid one by one
    applyCustomLayers();
    applyLayers();
    syncSelection();
    let result = null;
    try {
      result = await loading;
    } catch (err) {
      console.error('[editor] view.load failed', err);
    }
    if (id !== loads) return;   // a newer map came in the meantime
    progress(null);
    for (const obj of map.objects) modelBox(obj.m);   // every model has settled: the selection boxes are exact from the first click
    if (result?.missing?.length) ui.toast(`${result.missing.length} model${result.missing.length === 1 ? '' : 's'} failed to load (see Issues)`, 'warn');
    selDirty = true;
    invalidate();
  }

  function onChange(change) {
    const map = store.map;
    if (!map || !change) return;
    // A change may be the union of several commands (a batch): where an object ended up decides, not the list it is in.
    const place = (obj) => {
      if (store.kindOf(obj) === 'object') view.addObject(obj);   // (an object the view knows is updated instead)
      else view.removeObject(obj);
    };
    for (const obj of change.removed.objects) place(obj);
    for (const obj of change.added.objects) place(obj);
    for (const obj of change.updated.objects) view.updateObject(obj);
    if (hiddenObjects || ui.customLayers?.size) {   // an object that was put on a hidden layer, or taken off one
      for (const obj of change.added.objects) hideByLayer(obj);
      for (const obj of change.updated.objects) hideByLayer(obj);
    }
    if (change.added.npcs.length || change.updated.npcs.length || change.removed.npcs.length) view.setNpcObstacles(map.npcs);
    const props = change.props;
    if (props.includes('radius') || props.includes('foliage') || props.includes('ground')) {
      view.refresh();
      groundVersion++;
      if (props.includes('ground')) { drape.sync(map); keepOrbit(); }   // another ground object, with its own heights
      brushDirty = true;
      fitMap();
    } else if (change.ground) {
      view.repaintGround(change.ground.ix0, change.ground.iz0, change.ground.ix1, change.ground.iz1);
      groundVersion++;
      if (change.ground.relief) {
        // the shape of the ground moved: whatever lies on it follows, and what the cursor points at is another point
        drape.sync(map);
        keepOrbit();
        brushDirty = true;
      }
    }
    if (hoverItem && store.kindOf(hoverItem) === null) setHover(null, null);
    selDirty = true;   // a selected item may have moved; a few hundred boxes are cheaper than finding out
    pickFrame = -1;
    invalidate();
  }

  // ---------------------------------------------------------------- actions (§10.7)

  function registerActions(actions = ctx.actions) {
    if (actionsDone || typeof actions?.register !== 'function') return actionsDone;
    actionsDone = true;
    const table = {
      'view.frame': frameSelection,
      'view.home': () => home(true),
      'view.overhead': () => setOverhead(!isOverhead()),
      'view.rotateLeft': () => turn(-15 * DEG, 0),
      'view.rotateRight': () => turn(15 * DEG, 0),
      'view.tiltUp': () => turn(0, 10 * DEG),
      'view.tiltDown': () => turn(0, -10 * DEG),
    };
    for (let i = 1; i <= 4; i++) {
      table[`view.bookmark.${i}`] = () => gotoBookmark(i);
      table[`view.bookmark.store.${i}`] = () => setBookmark(i);
    }
    for (const [id, fn] of Object.entries(table)) {
      try {
        actions.register(id, fn);
      } catch (err) {
        console.warn(`[editor] action ${id} was not registered:`, err?.message ?? err);
      }
    }
    return true;
  }

  // ---------------------------------------------------------------- start

  const listeners = [
    [dom, 'pointerdown', onPointerDown], [dom, 'pointermove', onPointerMove], [dom, 'pointerup', onPointerUp],
    [dom, 'pointercancel', onPointerCancel], [dom, 'lostpointercapture', onPointerCancel], [dom, 'pointerleave', onPointerLeave],
    [dom, 'dblclick', onDoubleClick], [dom, 'wheel', onWheel, { passive: false }],
    [dom, 'contextmenu', (ev) => ev.preventDefault()],
    [dom, 'mousedown', (ev) => { if (ev.button === 1) ev.preventDefault(); }],   // the middle button pans; it must not start autoscroll
    [dom, 'webglcontextlost', (ev) => ev.preventDefault()], [dom, 'webglcontextrestored', invalidate],
    [window, 'blur', onBlur],
  ];
  for (const [target, type, fn, options] of listeners) target.addEventListener(type, fn, options);
  const observer = new ResizeObserver(resize);
  observer.observe(el);

  const off = [
    store.on('load', onLoad),
    store.on('change', onChange),
    store.on('selection', syncSelection),
    ui.on('layers', applyLayers),
    ui.on('hiddenModels', applyHiddenModels),
    ui.on('customLayers', applyCustomLayers),
    ui.on('overlays', invalidate),
    ui.on('axes', invalidate),
    ui.on('snap', invalidate),
    ui.on('itemflags', () => { pickFrame = -1; setHover(null, null); invalidate(); }),
    ui.on('preview', (next) => { if (next !== mode) applyPreview(next); }),
    ui.on('tool', () => {
      cancelModal();   // a modal belongs to the tool it was opened under
      // the tool that got pointerDown gets its pointerUp before the next one takes over; the rest of the press is nobody's
      if (press?.kind === 'tool') {
        const p = press;
        p.kind = 'none';
        call(p.tool, toolName(p.tool), 'pointerUp', p.ev, hitFor(p.ev.clientX, p.ev.clientY, true));
      }
      toolCursor = null;
      pendingHover = null;
      hoverHandle = false;
      setHover(null, null);
      syncSelection();
      refreshCursor();
    }),
  ];
  ui.attach?.({ pickPoint, setCursor });   // the two renderers of ui that need the canvas

  applyPreview(ui.preview ?? 'neutral');
  resize();
  applyRig();
  applyLayers();
  registerActions();
  if (store.map) onLoad();   // a map that was loaded before the viewport existed
  raf = requestAnimationFrame(loop);

  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelAnimationFrame(raf);
    clearTimeout(tipTimer);
    release(null, true);
    cancelModal();
    for (const [target, type, fn, options] of listeners) target.removeEventListener(type, fn, options);
    observer.disconnect();
    for (const un of off) un?.();
    view.dispose();
    lighting.dispose();
    for (const set of Object.values(colliders)) { set.mesh?.dispose(); set.geometry.dispose(); }
    gridMesh.geometry = gridBlank;   // the terrain's geometry is the view's, and gone with it
    for (const mesh of [gridMesh, selLines, pivotMark, brushRing, brushFill]) { mesh.geometry.dispose(); mesh.material.dispose(); }
    drape.dispose();
    colliderMaterial.dispose();
    renderer.dispose();
    dom.remove(); readoutEl.remove(); tipEl.remove();
  }

  const viewport = {
    renderer, scene, camera, dom, overlay, view,
    get target() { return { x: rig.x, z: rig.z }; },
    get distance() { return rig.distance; },
    set distance(v) { if (Number.isFinite(v)) { stopAnim('distance'); rig.distance = v; applyRig(); } },
    get yaw() { return rig.yaw; },
    set yaw(v) { if (Number.isFinite(v)) { stopAnim('yaw'); rig.yaw = v; applyRig(); } },
    get pitch() { return rig.pitch; },
    set pitch(v) { if (Number.isFinite(v)) { stopAnim('pitch'); rig.pitch = v; applyRig(); } },
    setTarget, focus, setOverhead, setBookmark, gotoBookmark,
    hitAt, hitWorld, hitStack, project, itemsInRect, viewQuad,
    setPreview, readout, brush, grab, invalidate,
    get fps() { return Math.round(fps); },
    get info() { return stats; },
    tick,
    // ---- beyond §10.8: what the page needs from the owner of the canvas
    drape,                                                 // the relief for ground overlays: drape.apply(material), drape.height(x, z)
    groundY,                                               // (x, z) -> the height of the ground there
    pickPoint, setCursor,                                  // the renderers behind ui.pickPoint / ui.setCursor (attached above)
    get modal() { return modal ? modal.type : null; },     // 'grab' | 'pick' | null - the keymap skips the tool while one is open
    cancelModal,                                           // Escape: -> true when a modal was open
    addPanel(panel, name = `panel ${panels.length + 1}`) { if (panel) panels.push({ panel, name }); },   // its update(dt) runs every frame
    registerActions,                                       // the view.* actions; done by itself once ctx.actions exists
    input,                                                 // a synthetic pointer for __editor.click / drag
    hasBookmark,
    get overhead() { return isOverhead(); },
    get preview() { return mode; },
    get pointerDown() { return press !== null; },          // thumbnails wait while a button is down in the viewport
    dispose,
  };
  ctx.viewport ??= viewport;
  return viewport;
}
