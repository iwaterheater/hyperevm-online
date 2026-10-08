// What the world map knows before it draws (src/worldmap.js): the picture of one pixel per ground vertex, what is land,
// which zone a vertex belongs to, and where the names of the zones go. Pure: no canvas, no browser.
// Run: node --test test/worldmap.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { WATER_LEVEL, GROUND_INDEX, cellIndex, emptyMap, regionAt } from '../src/map/format.js';
import { campLabel, labelSpots, surveyMap } from '../src/worldmap.js';

const island = () => emptyMap({ radius: 60 });
const pixel = (s, i) => [...s.rgba.slice(i * 4, i * 4 + 4)];
const circle = (x, z, r) => ({ type: 'circle', x, z, r });

test('surveyMap: land inside the radius, sea where the ground sinks beyond it', () => {
  const map = island(), s = surveyMap(map), at = (x, z) => cellIndex(map.ground, x, z);
  assert.equal(s.size, map.ground.size);
  assert.equal(s.land[at(0, 0)], 1);
  assert.equal(s.land[at(58, 0)], 1);
  assert.equal(s.land[at(70, 0)], 0, 'ten units beyond the radius the ground is under the water');
  assert.equal(s.land[at(56, 56)], 0, 'a corner of the grid');
  const [r, g, b, a] = pixel(s, at(0, 0));
  assert.ok(g > r && g > b && a === 255, 'grass is green');
  const sea = pixel(s, at(70, 0));
  assert.ok(sea[2] > sea[0] && sea[2] > sea[1], 'the sea is blue');
  // the land ends a few units beyond the radius, where the sinking ground meets the waterline
  for (const edge of [s.box.maxX, s.box.maxZ, -s.box.minX, -s.box.minZ]) assert.ok(edge >= 60 && edge <= 66, `the land ends at ${edge}`);
});

test('surveyMap: a hollow under the waterline is a lake, and so is painted water', () => {
  const map = island(), g = map.ground;
  g.heights[cellIndex(g, 10, 10)] = WATER_LEVEL - 2;
  g.cells[cellIndex(g, -10, -10)] = GROUND_INDEX.water;
  const s = surveyMap(map);
  assert.equal(s.land[cellIndex(g, 10, 10)], 0);
  assert.equal(s.land[cellIndex(g, -10, -10)], 0);
  assert.equal(s.land[cellIndex(g, 10, 12)], 1, 'the shore of the lake is land');
  const lake = pixel(s, cellIndex(g, 10, 10));
  assert.ok(lake[2] > lake[1] && lake[1] > lake[0], 'the lake is as blue as the sea');
});

test('surveyMap: a slope is lit from the north-west', () => {
  const map = island(), g = map.ground;
  for (let iz = 0; iz < g.size; iz++) for (let ix = 0; ix < g.size; ix++) g.heights[iz * g.size + ix] = Math.max(0, 8 - Math.hypot(ix - 30, iz - 30));
  const s = surveyMap(map), lum = (ix, iz) => pixel(s, iz * g.size + ix).slice(0, 3).reduce((a, b) => a + b);
  assert.ok(lum(27, 27) > lum(33, 33), 'the north-west side of a hill is brighter than the south-east one');
});

test('surveyMap: every land vertex knows its zone, the later zone on top', () => {
  const map = island(), g = map.ground;
  map.regions = [{ name: 'Wilds', shape: circle(0, 0, 100) }, { name: 'Town', safe: true, shape: circle(0, 0, 12) }];
  const s = surveyMap(map);
  assert.equal(s.owner[cellIndex(g, 0, 0)], 1);
  assert.equal(s.owner[cellIndex(g, 30, 0)], 0);
  assert.equal(s.owner[cellIndex(g, 70, 0)], -1, 'the sea belongs to nobody');
  map.regions = [];
  assert.equal(surveyMap(map).owner[cellIndex(g, 0, 0)], -1, 'land outside every region is the fallback');
});

test('labelSpots: the name of a ring-shaped zone is not written over the town in its middle', () => {
  const map = island();
  map.regions = [{ name: 'Wilds', shape: circle(0, 0, 100) }, { name: 'Town', safe: true, shape: circle(0, 0, 12) }];
  const spots = labelSpots(map, surveyMap(map)), [wilds, town] = spots;
  assert.deepEqual(spots.map((p) => p.region.name), ['Wilds', 'Town']);
  for (const spot of spots) assert.equal(regionAt(map, spot.x, spot.z), spot.region, `${spot.region.name} is named on its own ground`);
  assert.ok(Math.hypot(town.x, town.z) <= 2, 'the town is named at its centre');
  const far = Math.hypot(wilds.x, wilds.z);
  assert.ok(far > 30 && far < 45, `the ring is named in the middle of its width, not at ${far}`);
  assert.ok(wilds.room > 18 && town.room > 8);
});

test('labelSpots: a zone without land has no name on the map, land outside every zone is the fallback', () => {
  const map = island();
  map.regions = [{ name: 'Reef', shape: circle(200, 200, 5) }];
  const spots = labelSpots(map, surveyMap(map));
  assert.deepEqual(spots.map((p) => p.region), [map.fallback]);
  const flooded = island();
  flooded.ground.heights.fill(WATER_LEVEL - 3);
  assert.equal(surveyMap(flooded).box, null);
  assert.deepEqual(labelSpots(flooded, surveyMap(flooded)), []);
});

test('campLabel: the monsters of a camp, the likeliest first, and their levels', () => {
  assert.equal(campLabel({ types: { pinkslime: 2, slime: 3 }, lvl: [2, 4] }), 'Green Slime, Pink Slime · Lv 2–4');
  assert.equal(campLabel({ types: { boss: 1 }, lvl: [18, 18] }), 'Skeleton King · Lv 18');
});
