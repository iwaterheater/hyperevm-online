// The world map (the window on M): the whole island on a 2D canvas - never a second 3D render. North (-Z) is up and
// east (+X) is right, like the radar and like the camera at yaw 0.
//
// Drawn from the map data, in two layers:
//   still   what stays as it is while the page is open - the relief, what stands on it, the borders and the names of the
//           zones, the boss lairs - painted once for a size of the canvas and kept
//   live    the monster camps, tinted by how dangerous they are for this player, the other cats and the player's arrow
import { GROUND_TYPES, MAX_SLOPE, WATER_LEVEL, groundHalf, hasBoss, regionAt, regionColor, regionLabel } from './map/format.js';
import { modelInfo } from './map/catalog.js';
import { MOB_TYPES } from './shared.js';

const rgbOf = (n) => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
// one colour per ground type: the middle of the two the terrain blends
const GROUND_RGB = GROUND_TYPES.map((t) => mix(rgbOf(t.a), rgbOf(t.b), 0.5));
const SAND = GROUND_RGB[GROUND_TYPES.findIndex((t) => t.id === 'sand')];
const ROCK = [125, 120, 112];                       // a slope too steep to walk (src/map/view.js)
const SHALLOW = [74, 168, 188], DEEP = [24, 84, 116];
const DEEP_AT = 5;                                  // this far under the waterline the sea is at its darkest
const SHORE_TOP = WATER_LEVEL + 0.9, SHORE_BAND = 0.6;   // the beach the terrain makes by itself (src/map/view.js)
const SHADE = 0.35;      // how strongly a slope is lit or shaded: a 45 degree slope by about a third
const MARGIN = 14;       // world units of sea kept around the land
const FONT = 'ui-rounded, "SF Pro Rounded", "Nunito", system-ui, sans-serif';
// what stands on the ground and is worth a mark, by catalog category: [colour, radius in world units, square]
const OBJECTS = {
  trees: ['rgba(18, 48, 26, .55)', 1.5, false],
  buildings: ['#ecd2ae', 2.2, true],
};

// The map as a picture of one pixel per ground vertex, and what the labels and the hover line need to know about every
// vertex. Pure: no canvas, so a test can look at it.
//   rgba    size * size pixels, row by row from the north
//   land    1 where the ground is above the water, 0 for the sea, a lake, lava
//   owner   the index of the region the vertex belongs to (regionAt), -1 for the fallback; only where land is 1
//   box     the land's bounding box in world units, or null for a map that is all water
export function surveyMap(map) {
  const g = map.ground, size = g.size, last = size - 1, mid = last / 2, n = size * size;
  const heights = g.heights && g.heights.length === n ? g.heights : null;
  const rgba = new Uint8ClampedArray(n * 4), land = new Uint8Array(n), owner = new Int16Array(n).fill(-1);
  // beyond the map's radius the ground sinks into the sea, as the terrain mesh does
  const level = new Float32Array(n);
  for (let iz = 0; iz < size; iz++) {
    for (let ix = 0; ix < size; ix++) {
      const i = iz * size + ix, r = Math.hypot((ix - mid) * g.cell, (iz - mid) * g.cell);
      level[i] = (heights ? heights[i] : 0) - (r > map.radius ? Math.min(4, (r - map.radius) * 0.3) : 0);
    }
  }
  const box = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  // the colour of the pixel in the making, and a step of it towards another colour (no array per pixel)
  const c = [0, 0, 0];
  const paint = (to, t) => { c[0] += (to[0] - c[0]) * t; c[1] += (to[1] - c[1]) * t; c[2] += (to[2] - c[2]) * t; };
  for (let iz = 0; iz < size; iz++) {
    const up = Math.max(0, iz - 1) * size, row = iz * size, down = Math.min(last, iz + 1) * size;
    for (let ix = 0; ix < size; ix++) {
      const i = row + ix, h = level[i], type = GROUND_TYPES[g.cells[i]] ?? GROUND_TYPES[0];
      const l = Math.max(0, ix - 1), r = Math.min(last, ix + 1);
      let shade = 1;
      paint(GROUND_RGB[g.cells[i]] ?? GROUND_RGB[0], 1);
      // painted water and lava keep their own colour; any other ground under the waterline is the sea
      if (!type.block && h < WATER_LEVEL) { paint(SHALLOW, 1); paint(DEEP, Math.min(1, (WATER_LEVEL - h) / DEEP_AT)); }
      else if (!type.block) {
        const x = (ix - mid) * g.cell, z = (iz - mid) * g.cell;
        land[i] = 1;
        owner[i] = map.regions.indexOf(regionAt(map, x, z));
        if (x < box.minX) box.minX = x;
        if (x > box.maxX) box.maxX = x;
        if (z < box.minZ) box.minZ = z;
        if (z > box.maxZ) box.maxZ = z;
        const dx = level[row + r] - level[row + l], dz = level[down + ix] - level[up + ix];
        // a shore is sand whatever was painted there, and a cliff is bare rock
        if (h < SHORE_TOP) paint(SAND, Math.min(1, (SHORE_TOP - h) / SHORE_BAND));
        const steep = Math.hypot(dx, dz) / (2 * g.cell);
        if (steep > MAX_SLOPE * 0.75) paint(ROCK, Math.min(1, (steep - MAX_SLOPE * 0.75) / (MAX_SLOPE * 0.3)));
        // lit from the north-west: a slope that faces the light is brighter, one that faces away darker
        shade = Math.max(0.62, Math.min(1.3, 1 + (dx + dz) / (2 * g.cell) * SHADE));
      }
      rgba[i * 4] = c[0] * shade; rgba[i * 4 + 1] = c[1] * shade; rgba[i * 4 + 2] = c[2] * shade; rgba[i * 4 + 3] = 255;
    }
  }
  return { size, rgba, land, owner, box: box.minX <= box.maxX ? box : null };
}

// Where the name of each zone goes: the land vertex of the zone that lies deepest inside it - the one farthest from its
// border and from the water - so the name of a ring-shaped zone is not written across the town in its middle.
// Returns [{ region, x, z, room }], `room` being that distance in world units; a zone that owns no land has no entry.
export function labelSpots(map, survey) {
  const { size, land, owner } = survey, g = map.ground, last = size - 1, mid = last / 2, n = size * size, FAR = 1e9;
  const key = (i) => (land[i] ? owner[i] : -2);
  // a chamfer distance (in cells) to the nearest vertex that belongs to something else
  const d = new Float32Array(n);
  for (let iz = 0; iz < size; iz++) {
    for (let ix = 0; ix < size; ix++) {
      const i = iz * size + ix, k = key(i);
      const edge = ix === 0 || iz === 0 || ix === last || iz === last
        || key(i - 1) !== k || key(i + 1) !== k || key(i - size) !== k || key(i + size) !== k;
      d[i] = edge ? 0 : FAR;
    }
  }
  const relax = (i, j, cost) => { if (d[j] + cost < d[i]) d[i] = d[j] + cost; };
  for (let iz = 1; iz < last; iz++) {
    for (let ix = 1; ix < last; ix++) {
      const i = iz * size + ix;
      relax(i, i - 1, 1); relax(i, i - size, 1); relax(i, i - size - 1, 1.414); relax(i, i - size + 1, 1.414);
    }
  }
  for (let iz = last - 1; iz > 0; iz--) {
    for (let ix = last - 1; ix > 0; ix--) {
      const i = iz * size + ix;
      relax(i, i + 1, 1); relax(i, i + size, 1); relax(i, i + size + 1, 1.414); relax(i, i + size - 1, 1.414);
    }
  }
  const best = new Map();   // region index -> vertex
  for (let i = 0; i < n; i++) {
    if (land[i] && !(d[best.get(owner[i])] >= d[i])) best.set(owner[i], i);
  }
  return [...best].sort((a, b) => a[0] - b[0]).map(([k, i]) => ({
    region: k < 0 ? map.fallback : map.regions[k],
    x: (i % size - mid) * g.cell, z: (Math.floor(i / size) - mid) * g.cell, room: d[i] * g.cell,
  }));
}

// The monsters of a camp, the likeliest first: "Green Slime, Pink Slime · Lv 2–4".
export function campLabel(spawn) {
  const names = Object.keys(spawn.types).sort((a, b) => spawn.types[b] - spawn.types[a]).map((t) => MOB_TYPES[t]?.name ?? t);
  const [a, b] = spawn.lvl;
  return `${names.join(', ')} · Lv ${a === b ? a : `${a}–${b}`}`;
}

// The map on `canvas`. draw() paints it at the size the page gives the canvas; pick() tells what lies under the cursor.
export function createWorldMap(canvas, map) {
  const g2d = canvas.getContext('2d');
  const survey = surveyMap(map), spots = labelSpots(map, survey), ground = map.ground;
  const extent = groundHalf(ground) + ground.cell / 2;   // a pixel is one cell, centred on its vertex
  const picture = document.createElement('canvas'), shore = document.createElement('canvas');
  picture.width = picture.height = shore.width = shore.height = survey.size;
  picture.getContext('2d').putImageData(new ImageData(survey.rgba, survey.size, survey.size), 0, 0);
  // the land alone: what a border may be drawn on
  const mask = new Uint8ClampedArray(survey.size * survey.size * 4);
  survey.land.forEach((on, i) => { mask[i * 4 + 3] = on ? 255 : 0; });
  shore.getContext('2d').putImageData(new ImageData(mask, survey.size, survey.size), 0, 0);

  // The square of the world that is shown: the land and a strip of sea around it.
  const box = survey.box ?? { minX: -map.radius, maxX: map.radius, minZ: -map.radius, maxZ: map.radius };
  const span = Math.min(2 * extent, Math.max(box.maxX - box.minX, box.maxZ - box.minZ) + 2 * MARGIN);
  const left = Math.max(-extent, Math.min(extent - span, (box.minX + box.maxX - span) / 2));
  const top = Math.max(-extent, Math.min(extent - span, (box.minZ + box.maxZ - span) / 2));
  const bosses = map.spawns.filter(hasBoss), camps = map.spawns.filter((s) => !hasBoss(s));

  const still = document.createElement('canvas'), lines = document.createElement('canvas');
  let px = 1, ratio = 1;   // canvas pixels per world unit, and per CSS pixel
  const X = (x) => (x - left) * px, Z = (z) => (z - top) * px;

  function trace(g, shape) {
    if (shape.type === 'circle') { g.moveTo(X(shape.x) + shape.r * px, Z(shape.z)); g.arc(X(shape.x), Z(shape.z), shape.r * px, 0, 7); }
    else {
      shape.points.forEach(([x, z], i) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z))));
      g.closePath();
    }
  }
  function label(g, text, x, y, size, color) {
    g.font = `800 ${size * ratio}px ${FONT}`;
    g.lineWidth = 3.5 * ratio;
    g.strokeStyle = 'rgba(4, 16, 14, .85)';
    g.strokeText(text, x, y);
    g.fillStyle = color;
    g.fillText(text, x, y);
  }

  function paintStill(side) {
    still.width = still.height = lines.width = lines.height = side;
    const g = still.getContext('2d'), k = side / span * ground.cell, o = (-extent - left) * px, p = (-extent - top) * px;
    g.imageSmoothingQuality = 'high';
    g.drawImage(picture, o, p, survey.size * k, survey.size * k);

    for (const obj of map.objects) {
      const style = OBJECTS[modelInfo(obj.m)?.cat];
      if (!style) continue;
      const r = Math.max(ratio * 0.8, style[1] * (obj.s ?? 1) * px);
      g.fillStyle = style[0];
      if (style[2]) g.fillRect(X(obj.x) - r, Z(obj.z) - r, 2 * r, 2 * r);
      else { g.beginPath(); g.arc(X(obj.x), Z(obj.z), r, 0, 7); g.fill(); }
    }

    // zone borders: each only where no later zone lies over it (that one wins), and only on land
    const b = lines.getContext('2d');
    b.lineWidth = 2 * ratio;
    b.setLineDash([7 * ratio, 5 * ratio]);
    map.regions.forEach((region, i) => {
      b.save();
      for (const over of map.regions.slice(i + 1)) {
        b.beginPath(); b.rect(0, 0, side, side); trace(b, over.shape); b.clip('evenodd');
      }
      b.beginPath(); trace(b, region.shape);
      if (region.safe) { b.fillStyle = 'rgba(127, 232, 214, .3)'; b.fill('evenodd'); }
      b.strokeStyle = regionColor(map, region);
      b.stroke();
      b.restore();
    });
    b.globalCompositeOperation = 'destination-in';
    b.drawImage(shore, o, p, survey.size * k, survey.size * k);
    b.globalCompositeOperation = 'source-over';
    g.globalAlpha = 0.85;
    g.drawImage(lines, 0, 0);
    g.globalAlpha = 1;

    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    for (const boss of bosses) {
      const x = X(boss.x), y = Z(boss.z), r = 7 * ratio, kind = Object.keys(boss.types)[0];
      g.beginPath(); g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath();
      g.fillStyle = '#ff2244'; g.fill();
      g.lineWidth = 1.5 * ratio; g.strokeStyle = '#fff'; g.stroke();
      label(g, `${MOB_TYPES[kind]?.name ?? 'Boss'} · Lv ${boss.lvl[1]}`, x, y - 16 * ratio, 11, '#ff8a9a');
    }
    for (const spot of spots) {
      if (!spot.region.name || (spot.region === map.fallback && spot.room < 24)) continue;   // a scrap of no-man's-land stays unnamed
      const x = X(spot.x), y = Z(spot.z), levels = spot.region.levels;
      label(g, spot.region.name, x, levels ? y - 7 * ratio : y, 13, '#fff');
      if (levels) label(g, `Lv ${levels[0] === levels[1] ? levels[0] : `${levels[0]}–${levels[1]}`}`, x, y + 8 * ratio, 11, regionColor(map, spot.region));
    }
  }

  return {
    // me: { x, z, yaw }; others: iterable of { x, z }; threat(level) -> the colour of a monster of that level for this player
    draw({ me, others, threat }) {
      const side = Math.round(canvas.clientWidth * Math.min(2, devicePixelRatio || 1));
      if (!side) return;   // the window is closed
      if (canvas.width !== side || canvas.height !== side) canvas.width = canvas.height = side;
      if (still.width !== side) {
        px = side / span;
        ratio = side / canvas.clientWidth;
        paintStill(side);
      }
      const g = g2d;
      g.drawImage(still, 0, 0);
      g.lineWidth = ratio;
      g.strokeStyle = 'rgba(4, 16, 14, .8)';
      for (const camp of camps) {
        g.fillStyle = threat(Math.round((camp.lvl[0] + camp.lvl[1]) / 2));
        g.beginPath(); g.arc(X(camp.x), Z(camp.z), 3.2 * ratio, 0, 7); g.fill(); g.stroke();
      }
      for (const a of others) {
        g.fillStyle = '#fff';
        g.beginPath(); g.arc(X(a.x), Z(a.z), 3.5 * ratio, 0, 7); g.fill(); g.stroke();
      }
      // the player: an arrow that points where the cat looks, with a ring that is easy to find
      const x = X(me.x), y = Z(me.z), r = 9 * ratio;
      g.strokeStyle = 'rgba(255, 255, 255, .55)';
      g.lineWidth = 1.5 * ratio;
      g.beginPath(); g.arc(x, y, r * 1.7, 0, 7); g.stroke();
      g.save();
      g.translate(x, y);
      g.rotate(Math.atan2(Math.sin(me.yaw), -Math.cos(me.yaw)));   // 0 = north, clockwise
      g.beginPath(); g.moveTo(0, -r); g.lineTo(r * 0.72, r * 0.8); g.lineTo(0, r * 0.4); g.lineTo(-r * 0.72, r * 0.8); g.closePath();
      g.fillStyle = '#fff'; g.fill();
      g.lineWidth = 2 * ratio; g.strokeStyle = '#04211c'; g.stroke();
      g.restore();
    },

    // What is under a point of the page: { x, z, land, region, camp } - `region` is null on the water, `camp` the monster
    // camp or boss lair the point is on, or null. null when the point is not on the map.
    pick(clientX, clientY) {
      const box = canvas.getBoundingClientRect();
      if (!box.width || clientX < box.left || clientX > box.right || clientY < box.top || clientY > box.bottom) return null;
      const unit = span / box.width, x = left + (clientX - box.left) * unit, z = top + (clientY - box.top) * unit;
      const ix = Math.round(x / ground.cell + (survey.size - 1) / 2), iz = Math.round(z / ground.cell + (survey.size - 1) / 2);
      const land = ix >= 0 && iz >= 0 && ix < survey.size && iz < survey.size && survey.land[iz * survey.size + ix] === 1;
      let camp = null, near = Math.max(8 * unit, 4) ** 2;   // within eight pixels of the dot
      for (const s of map.spawns) {
        const d = (s.x - x) ** 2 + (s.z - z) ** 2;
        if (d < near) { near = d; camp = s; }
      }
      return { x, z, land, region: land ? regionAt(map, x, z) : null, camp };
    },
    // the line under the title for what pick() found
    describe(hit) {
      if (!hit) return '';
      if (hit.camp) return campLabel(hit.camp);
      return hit.region ? regionLabel(hit.region) : 'Sea';
    },
  };
}
