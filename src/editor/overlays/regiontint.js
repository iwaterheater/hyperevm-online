// The region tint: every ground vertex in the colour of the region that WINS there (regionAt), so nested and
// overlapping regions show who decides - the name on the banner, the levels, the mood. Where no region reaches, the
// vertex has the colour of the fallback region: a gap between two regions is as visible as an overlap.
//
// One canvas of size x size pixels, pixel (ix, iz) = regionColor(map, regionAt(vertex)) at alpha 0.35:
// - in the viewport it is ONE textured plane over the ground grid, a texel per vertex (NearestFilter: the tint shows
//   the grid the game decides on, not a smoothed guess);
// - the minimap draws the same canvas over its own picture (ctx.overlays.regiontint.canvas, with `version` to know
//   when it changed).
// It is recomputed 150 ms after a region change - while a region is dragged that is a few times a second, each time a
// pass over the regions, row by row - and at once when another map is loaded. While the tint is switched off nobody
// looks at it, so the pass waits: for the switch, or for whoever reads `canvas` or `version` after those 150 ms.
// The switch is ui.overlays.regiontint; the eye of the Regions layer hides the tint with everything else of the
// regions (the minimap follows the same two).
import * as THREE from 'three';
import { regionColor } from '../../map/format.js';
import { runs } from '../raster.js';

const ALPHA = 0.35;
const DELAY = 150;           // ms from a region change to the recompute
const Y = 0.02;              // just over the ground, under the markers' fills, discs and outlines
const HEX = /^#[0-9a-f]{6}$/i;
const UNKNOWN = [128, 128, 128];   // a colour that is no '#rrggbb' (a map that still has that error) is drawn grey

// '#rrggbb' -> [r, g, b]
export function rgbOf(color) {
  if (typeof color !== 'string' || !HEX.test(color)) return UNKNOWN;
  const v = parseInt(color.slice(1), 16);
  return [v >> 16 & 255, v >> 8 & 255, v & 255];
}

// Does this Change move a border or a colour of the tint? Region items, their order, the fallback (its mood colours
// everything outside the regions) - and a ground that was replaced, because the picture has the ground's size.
export function touchesTint(change) {
  return change.added.regions.length > 0 || change.removed.regions.length > 0 || change.updated.regions.length > 0
    || change.order.includes('regions') || change.props.includes('fallback') || change.props.includes('ground');
}

// Fills `data` (RGBA, size x size) for the map. -> the number of distinct regions that win somewhere (the fallback counts)
// The winner of a vertex is the LAST region of the file that contains it (regionAt): so the regions are laid over the
// fallback in file order, each one row by row (raster.js runs - what is inside is inShape's answer to the letter, at
// the cost of a region's edges per row, not per vertex: the pass runs a few times a second while a region is dragged).
export function paintTint(map, data) {
  const ground = map.ground, size = ground.size, a = Math.round(ALPHA * 255);
  const owner = new Int32Array(size * size).fill(-1);       // the index of the winning region; -1: the fallback
  map.regions.forEach((region, r) => {
    runs(ground, region.shape, (iz, ix0, ix1) => owner.fill(r, iz * size + ix0, iz * size + ix1 + 1));
  });
  const colors = new Map();
  for (let k = 0, o = 0; k < owner.length; k++, o += 4) {
    const r = owner[k];
    let c = colors.get(r);
    if (!c) colors.set(r, c = rgbOf(regionColor(map, r < 0 ? map.fallback : map.regions[r])));
    data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = a;
  }
  return colors.size;
}

export default function create(ctx) {
  const { store, ui, viewport } = ctx;

  const group = new THREE.Group();
  group.name = 'regiontint';
  group.visible = false;   // main.js shows it when ui.overlays.regiontint says so
  viewport.scene.add(group);

  // the same depth rule as every ground overlay: tested against the scene, never written, pulled towards the eye
  const material = new THREE.MeshBasicMaterial({
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false,
  });
  // A unit plane laid on the ground, scaled to the grid. Its texture row 0 is the north edge (iz = 0) and its column 0
  // the west edge (ix = 0): the vertex order of the ground itself.
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), material);
  mesh.position.y = Y;
  mesh.renderOrder = 0;
  mesh.visible = false;    // until there is a picture
  mesh.raycast = () => {};
  group.add(mesh);

  let canvas = null, g2d = null, image = null, texture = null;
  let version = 0, timer = 0, stale = false, due = 0;
  let wanted = false;      // what main.js said last: ui.overlays.regiontint

  function recompute() {
    clearTimeout(timer);
    timer = 0;
    stale = false;
    const map = store.map;
    if (!map) return;
    const { size, cell } = map.ground;
    if (!canvas || canvas.width !== size || canvas.height !== size) {
      // ONE canvas for the life of the page (the minimap may keep the reference); a map of another size resizes it
      canvas ??= document.createElement('canvas');
      canvas.width = canvas.height = size;
      g2d = canvas.getContext('2d');
      image = g2d.createImageData(size, size);
      // a texture cannot change its size on the GPU: the old one goes and the next frame uploads a new one
      texture?.dispose();
      texture = new THREE.CanvasTexture(canvas);
      texture.magFilter = texture.minFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      material.map = texture;
      material.needsUpdate = true;
    }
    paintTint(map, image.data);
    g2d.putImageData(image, 0, 0);
    texture.needsUpdate = true;
    // a texel covers the cell-sized square around its vertex, so the plane reaches half a cell beyond the outer vertices
    mesh.scale.set(size * cell, 1, size * cell);
    mesh.visible = true;
    version++;
    viewport.invalidate();
  }

  // The first change starts the clock; changes that follow within the 150 ms ride along. So a drag is followed a few
  // times a second instead of waiting for the pointer to rest. The timer runs only while the tint is shown.
  function schedule() {
    if (!stale) {
      stale = true;
      due = performance.now() + DELAY;
    }
    if (group.visible && !timer) timer = setTimeout(recompute, Math.max(0, due - performance.now()));
  }
  // Whoever asks for the picture after the 150 ms gets the current one, shown or not.
  const settle = () => { if (stale && performance.now() >= due) recompute(); };

  // Shown while the overlay is switched on and the Regions layer is not hidden.
  function show() {
    const on = wanted && ui.layers?.regions?.visible !== false;
    if (group.visible === on) return;
    group.visible = on;
    if (on && stale) schedule();   // what changed while nobody looked is caught up with now
    viewport.invalidate();
  }

  store.on('load', recompute);
  store.on('change', (change) => { if (touchesTint(change)) schedule(); });
  ui.on('layers', show);
  if (store.map) recompute();   // a map that was loaded before this overlay existed

  return {
    id: 'regiontint',
    // HTMLCanvasElement of size x size pixels; null until the first map is loaded
    get canvas() { settle(); return canvas; },
    // bumped on every recompute
    get version() { settle(); return version; },
    get visible() { return group.visible; },

    setVisible(on) {
      wanted = !!on;
      show();
    },

    // Every rendered frame. Timers of a background tab may come late: a frame that is drawn after the 150 ms brings
    // the tint up to date itself.
    update() {
      if (group.visible) settle();
    },
  };
}
