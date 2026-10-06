import * as THREE from 'three';
import { MOODS } from './format.js';

// The light rig of the world - sky colour, fog, a hemisphere light and a sun that casts shadows - and the blending
// between the moods a region can pick. The game and the editor's preview share it, so both show the same light.

const COLORS = ['sky', 'sun', 'hemiSky', 'hemiGround'], LEVELS = ['sunI', 'hemiI'];
// the presets of format.js as colours
const PRESETS = Object.fromEntries(Object.entries(MOODS).map(([key, m]) => [key, {
  ...Object.fromEntries(COLORS.map((c) => [c, new THREE.Color(m[c])])),
  ...Object.fromEntries(LEVELS.map((l) => [l, m[l]])),
}]));

// `fog` and `shadows` are only where setFog() and setShadows() start. The renderer's shadow map is the page's business:
// it is enabled once, when the renderer is created (switching it on later leaves materials that were already drawn without shadows).
export function createLighting(scene, { fog = true, shadows = true } = {}) {
  // one current state; it starts as the meadow, never as white or black lights
  const now = {};
  for (const c of COLORS) now[c] = PRESETS.meadow[c].clone();
  for (const l of LEVELS) now[l] = PRESETS.meadow[l];

  const background = new THREE.Color(), mist = new THREE.Fog(0xffffff, 45, 150);
  const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.castShadow = shadows;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(hemi, sun, sun.target);
  let enabled = true, foggy = fog;

  // the state -> the lights; the fog keeps the colour of the sky also while it is detached
  function show() {
    background.copy(now.sky);
    mist.color.copy(now.sky);
    sun.color.copy(now.sun);
    sun.intensity = now.sunI;
    hemi.color.copy(now.hemiSky);
    hemi.groundColor.copy(now.hemiGround);
    hemi.intensity = now.hemiI;
  }
  // puts the background and the fog into the scene or takes them out; somebody else's are left alone
  function attach() {
    hemi.visible = sun.visible = enabled;
    if (enabled) scene.background = background;
    else if (scene.background === background) scene.background = null;
    if (enabled && foggy) scene.fog = mist;
    else if (scene.fog === mist) scene.fog = null;
  }

  // Jumps to a mood at once. An unknown mood changes nothing.
  function set(mood) {
    const to = Object.hasOwn(PRESETS, mood) ? PRESETS[mood] : null;
    if (!to) return;
    for (const c of COLORS) now[c].copy(to[c]);
    for (const l of LEVELS) now[l] = to[l];
    show();
  }
  // Moves every value towards a mood by the share k (0..1). No timers: crossing two borders or respawning mid-blend never pops.
  function approach(mood, k) {
    const to = Object.hasOwn(PRESETS, mood) ? PRESETS[mood] : null, t = Math.min(1, k);
    if (!to || !(t > 0)) return;
    for (const c of COLORS) now[c].lerp(to[c], t);
    for (const l of LEVELS) now[l] += (to[l] - now[l]) * t;
    show();
  }

  // Centres the sun and its shadow frustum on a point; `half` is half the side of the shadowed square.
  // The whole rig scales with it: with a fixed sun distance, a wide frustum would put the sun-side ground in front of the near plane.
  function follow(x, z, half = 30) {
    const k = half / 30, cam = sun.shadow.camera;
    sun.position.set(x + 14 * k, 26 * k, z + 9 * k);
    sun.target.position.set(x, 0, z);
    cam.left = cam.bottom = -half;
    cam.right = cam.top = half;
    cam.near = k;
    cam.far = 80 * k;
    cam.updateProjectionMatrix();
  }

  // false: no lights, no fog, no background - the editor lights its neutral view itself. true brings them back.
  function setEnabled(on) {
    enabled = !!on;
    attach();
  }
  function setFog(on) {
    foggy = !!on;
    attach();
  }
  function setShadows(on) {
    sun.castShadow = !!on;
  }

  function dispose() {
    enabled = false;
    attach();
    scene.remove(hemi, sun, sun.target);
    sun.dispose();   // the shadow map
    hemi.dispose();
  }

  show();
  attach();
  follow(0, 0);
  return { hemi, sun, set, approach, follow, setEnabled, setFog, setShadows, dispose };
}
