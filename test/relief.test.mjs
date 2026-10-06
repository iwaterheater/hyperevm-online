// The arithmetic of the Sculpt tool (src/editor/relief.js): what a brush does to the heights, in plain numbers.
// Pure: no browser, no store. The command that writes the result to the map is tested in commands.test.mjs.
// Run: node --test test/relief.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, cellIndex, emptyMap, heightAt, rayGround } from '../src/map/format.js';
import { SCULPT_MODES, brushReach, dab, falloff, ramp, rayRelief, slopeAt } from '../src/editor/relief.js';
import { editorChecks, STEEP } from '../src/editor/checks.js';
import * as cmd from '../src/editor/commands.js';

const island = () => { const map = emptyMap({ radius: 60 }); return { map, g: map.ground, work: new Float32Array(map.ground.cells.length) }; };
const brush = (over = {}) => ({ x: 0, z: 0, radius: 8, mode: 'raise', strength: 0.5, soft: true, target: 0, slope: 0, ...over });
// holds the brush for `seconds`, in frames of `dt`
function hold(g, work, b, seconds, dt) {
  let touched = 0;
  for (let t = 0; t < seconds - 1e-9; t += dt) touched += dab(g, work, b, Math.min(dt, seconds - t)).n;
  return touched;
}
const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, `${what ?? ''} ${a} is not within ${eps} of ${b}`);

test('falloff: a bell for a soft brush, all of it for a hard one, nothing outside', () => {
  assert.equal(falloff(0, true), 1);
  near(falloff(0.5, true), 0.5, 1e-12);
  assert.equal(falloff(1, true), 0);
  assert.equal(falloff(0.99, false), 1);
  assert.equal(falloff(1, false), 1);
  assert.equal(falloff(1.2, false), 0);
  assert.deepEqual(SCULPT_MODES, ['raise', 'lower', 'smooth', 'flatten', 'set', 'ramp']);
});

test('raise: a held brush keeps raising, highest in the middle, nothing beyond its radius - and Lower is its mirror', () => {
  const { g, work } = island(), mid = cellIndex(g, 0, 0), rim = cellIndex(g, 8, 0), out = cellIndex(g, 10, 0);
  hold(g, work, brush(), 0.5, 1 / 60);
  const half = work[mid];
  near(half, 6, 0.01, 'half a second at 24 units a second and half strength:');
  hold(g, work, brush(), 0.5, 1 / 60);
  near(work[mid], 2 * half, 0.01, 'the pointer rests and the ground goes on rising:');
  assert.ok(work[cellIndex(g, 4, 0)] > 0 && work[cellIndex(g, 4, 0)] < work[mid], 'lower towards the rim');
  assert.equal(work[rim], 0, 'the rim of a soft brush does not move');
  assert.equal(work[out], 0);
  const up = work.slice();
  hold(g, work, brush({ mode: 'lower' }), 1, 1 / 60);
  for (let i = 0; i < work.length; i++) near(work[i], 0, 1e-3, `vertex ${i}`);
  assert.ok(up.some((v) => v > 0));
});

test('a stroke does the same at 30 and at 144 frames a second', () => {
  for (const b of [brush(), brush({ mode: 'flatten', target: 7, soft: false }), brush({ mode: 'set', target: -1, strength: 1 })]) {
    const slow = island(), fast = island();
    hold(slow.g, slow.work, b, 0.4, 1 / 30);
    hold(fast.g, fast.work, b, 0.4, 1 / 144);
    for (const [x, z] of [[0, 0], [2, 2], [4, 0], [6, -2]]) {
      const i = cellIndex(slow.g, x, z);
      near(slow.work[i], fast.work[i], 0.06, `${b.mode} at ${x}, ${z}:`);
    }
  }
});

test('flatten and set: the ground under the brush ends on the target, and stays there', () => {
  const { g, work } = island();
  hold(g, work, brush({ strength: 1 }), 1, 1 / 60);                       // a hill to level
  const peak = work[cellIndex(g, 0, 0)];
  assert.ok(peak > 20);
  hold(g, work, brush({ mode: 'flatten', target: 3, soft: false, strength: 1 }), 3, 1 / 60);
  for (const [x, z] of [[0, 0], [4, 0], [0, -6], [4, 4]]) assert.equal(work[cellIndex(g, x, z)], 3, `flattened at ${x}, ${z}`);
  assert.equal(dab(g, work, brush({ mode: 'flatten', target: 3, soft: false }), 1 / 60).n, 0, 'nothing left to do');
  hold(g, work, brush({ mode: 'set', target: 80, soft: false, strength: 1 }), 20, 1 / 30);
  assert.equal(work[cellIndex(g, 0, 0)], LIMITS.height[1], 'never above the highest ground a map can have');
  hold(g, work, brush({ mode: 'lower', soft: false, strength: 1 }), 20, 1 / 30);
  assert.equal(work[cellIndex(g, 0, 0)], LIMITS.height[0], 'and never below the lowest');
});

test('smooth: a spike spreads out and nothing rises above it; flat ground stays flat', () => {
  const { g, work } = island(), mid = cellIndex(g, 0, 0);
  assert.equal(hold(g, work, brush({ mode: 'smooth' }), 0.2, 1 / 60), 0, 'nothing to smooth');
  work[mid] = 9;
  hold(g, work, brush({ mode: 'smooth', strength: 1, soft: false }), 0.5, 1 / 60);
  assert.ok(work[mid] < 3, `the spike is worn down (${work[mid]})`);
  assert.ok(work[mid + 1] > 0 && work[mid + 1] <= work[mid], 'its neighbours took some of it');
  let top = 0;
  for (const v of work) top = Math.max(top, v);
  assert.equal(top, work[mid]);
});

test('max slope: a stroke never pushes a vertex further than the slope allows above its neighbours', () => {
  const steep = island(), tame = island();
  const b = brush({ mode: 'set', target: 40, soft: false, strength: 1, radius: 12 });
  hold(steep.g, steep.work, b, 4, 1 / 60);
  hold(tame.g, tame.work, { ...b, slope: 45 }, 4, 1 / 60);
  const worst = ({ g, work }) => {
    let d = 0;
    for (let iz = 1; iz < g.size; iz++) for (let ix = 1; ix < g.size; ix++) {
      const i = iz * g.size + ix;
      d = Math.max(d, Math.abs(work[i] - work[i - 1]), Math.abs(work[i] - work[i - g.size]));
    }
    return d;
  };
  assert.ok(worst(steep) > 30, 'without the limit: a wall');
  assert.ok(worst(tame) <= steep.g.cell + 1e-3, `at 45 degrees a cell of ${tame.g.cell} units rises by no more than that (${worst(tame)})`);
  assert.ok(tame.work[cellIndex(tame.g, 0, 0)] > 5, 'and the hill is still a hill');
  // a slope that is too steep already is left alone, not made worse - and may be taken down
  const cliff = island(), top = cellIndex(cliff.g, 0, 0);
  cliff.work[top] = 30;
  dab(cliff.g, cliff.work, brush({ mode: 'raise', slope: 45, soft: false, radius: 1 }), 0.1);
  assert.equal(cliff.work[top], 30);
  dab(cliff.g, cliff.work, brush({ mode: 'lower', slope: 45, soft: false, radius: 1 }), 0.1);
  assert.ok(cliff.work[top] < 30);
});

test('ramp: a straight slope between two heights, from the ground as it was, as often as it is asked for', () => {
  const { map, g } = island();
  const base = new Float32Array(g.cells.length);
  for (let iz = 0; iz < g.size; iz++) for (let ix = 0; ix < g.size; ix++) if ((ix - (g.size - 1) / 2) * g.cell >= 20) base[iz * g.size + ix] = 10;   // a terrace in the east
  const line = { x0: 0, z0: 0, h0: 0, x1: 20, z1: 0, h1: 10, radius: 4, soft: false };
  const first = ramp(g, base, line), n = first.n, got = new Map();
  for (let k = 0; k < n; k++) got.set(first.index[k], first.value[k]);   // read at once: the answer is shared scratch
  near(got.get(cellIndex(g, 10, 0)), 5, 1e-5, 'half way up:');
  near(got.get(cellIndex(g, 4, 2)), 2, 1e-5);
  assert.equal(got.get(cellIndex(g, 0, 0)), 0);
  assert.equal(got.get(cellIndex(g, 20, 0)), 10);
  assert.equal(got.has(cellIndex(g, 10, 6)), false, 'beyond the width');
  const again = ramp(g, base, line);
  assert.equal(again.n, n, 'the same line twice is the same ramp');
  // soft: the middle is the ramp, the edge blends into what was there
  const soft = ramp(g, base, { ...line, radius: 8, soft: true }), edge = new Map();
  for (let k = 0; k < soft.n; k++) edge.set(soft.index[k], soft.value[k]);
  near(edge.get(cellIndex(g, 10, 2)), 5, 1e-5, 'inside the core:');
  const blend = edge.get(cellIndex(g, 10, 6));
  assert.ok(blend > 0 && blend < 5, `between the ramp and the ground beside it (${blend})`);
  // through the command: the map holds the ramp on its 0.1 grid
  cmd.heights([...got.keys()], [...got.values()]).do(map);
  near(heightAt(map, 10, 0), 5, 0.051);
  near(slopeAt(map, 10, 0), Math.atan(0.5) * 180 / Math.PI, 0.01, 'a rise of 10 over 20 units:');
});

test('slopeAt and the steep-ground check: what stands on a wall is reported, what stands on a meadow is not', () => {
  const { map, g } = island();
  assert.equal(slopeAt(map, 3, 3), 0);
  assert.deepEqual(editorChecks(map).filter((i) => i.code === 'steep-ground'), []);
  // a step of 6 units over one cell of 2: about 72 degrees
  const idx = [];
  for (let iz = 0; iz < g.size; iz++) for (let ix = 0; ix < g.size; ix++) if ((ix - (g.size - 1) / 2) * g.cell >= 10) idx.push(iz * g.size + ix);
  cmd.heights(idx, 6).do(map);
  near(slopeAt(map, 9, 0.5), Math.atan(3) * 180 / Math.PI, 0.01);
  assert.equal(slopeAt(map, 20, 0), 0, 'the terrace itself is level');
  assert.ok(STEEP < 72);
  map.chests.push(cmd.make('chest', { x: 9, z: 0.5 }), cmd.make('chest', { x: 20, z: 0 }));
  map.npcs.push(cmd.make('npc', { x: 9, z: 4.5 }));
  const steep = editorChecks(map).filter((i) => i.code === 'steep-ground');
  assert.deepEqual(steep.map((i) => i.path), ['chests[0]', 'npcs[0]']);
  assert.equal(steep[0].level, 'warning');
  assert.match(steep[0].message, /72 degrees/);
  map.start.x = 9;
  assert.ok(editorChecks(map).some((i) => i.code === 'steep-ground' && i.path === 'start'));
  delete map.ground.heights;
  assert.deepEqual(editorChecks(map).filter((i) => i.code === 'steep-ground'), [], 'a ground without heights is flat');
  assert.equal(brushReach(g, 0.5) > 1, true, 'a brush never falls between the vertices');
});

test('rayRelief: the cursor ray meets the terrain where it is drawn - the tip of a peak and the crest of a ridge included', () => {
  const { map, g, work } = island();
  // flat ground with its heights array: the plane, wherever the ray comes from
  for (const [o, d] of [[{ x: 3, y: 50, z: 40 }, { x: 0.2, y: -1, z: -0.7 }], [{ x: -80, y: 8, z: 5 }, { x: 1, y: -0.05, z: 0.3 }], [{ x: 0, y: 200, z: 0 }, { x: 0, y: -3, z: 0 }]]) {
    const p = rayRelief(map, o, d), t = o.y / -d.y;
    near(p.x, o.x + d.x * t, 1e-9); near(p.z, o.z + d.z * t, 1e-9); assert.equal(p.y, 0);
  }
  assert.equal(rayRelief(map, { x: 0, y: 5, z: 0 }, { x: 1, y: 0.1, z: 0 }), null, 'up into the sky');
  assert.equal(rayRelief(map, { x: 0, y: 5, z: 0 }, { x: 0, y: 0, z: 0 }), null);
  assert.deepEqual(rayRelief(map, { x: 4, y: -0.5, z: 4 }, { x: 0, y: -1, z: 0 }), { x: 4, y: 0, z: 4 }, 'a ray from under the ground answers with its start');
  assert.equal(rayRelief(map, { x: 0, y: 50, z: 0 }, { x: 1, y: -0.001, z: 0 }, 100), null, 'not within reach');
  // a rolling ground: every hit lies ON the surface, and agrees with the coarse walk of format.js where that is right
  hold(g, work, brush({ radius: 20, strength: 1 }), 0.8, 1 / 60);
  hold(g, work, brush({ x: 14, z: 6, radius: 9, mode: 'lower', strength: 1 }), 0.4, 1 / 60);
  cmd.heights(Array.from(work.keys()), Array.from(work)).do(map);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 400; i++) {
    const o = { x: rnd() * 80 - 40, y: 25 + rnd() * 40, z: rnd() * 80 - 40 }, d = { x: rnd() * 2 - 1, y: -0.15 - rnd(), z: rnd() * 2 - 1 };
    const p = rayRelief(map, o, d), q = rayGround(map, o, d);
    assert.ok(p, 'a ray that looks down meets the ground');
    near(p.y, heightAt(map, p.x, p.z), 1e-9);
    const t = (p.x - o.x) / d.x;
    near(o.y + d.y * t, p.y, 1e-6, 'the point lies on the ray:');
    assert.ok(Math.hypot(p.x - q.x, p.z - q.z) < 2.1, 'the coarse walk is never further off than the crest it stepped over');
    // nothing of the ground sticks out between the eye and the hit
    for (let k = 1; k < 40; k++) { const s = t * k / 40; assert.ok(o.y + d.y * s - heightAt(map, o.x + d.x * s, o.z + d.z * s) > -1e-6); }
  }
  // a spike of one vertex, 9 high on a cell of 2: a ray that grazes its tip from the side is caught by the tip
  const spike = emptyMap({ radius: 60 });
  cmd.heights([cellIndex(spike.ground, 10, 10)], 9).do(spike);
  // (at z = 10.2 the spike is 8.1 high; the ray comes down to 8.0 there)
  const d = { x: 40, y: -20, z: 0 }, len = Math.hypot(40, 20);
  let missed = 0;
  for (let k = 0; k < 10; k++) {      // the same line from ten starting points: the answer must not depend on where the walk begins
    const back = k * 0.1 / len, o = { x: -30 - d.x * back, y: 28 - d.y * back, z: 10.2 };
    const tip = rayRelief(spike, o, d);
    assert.ok(Math.hypot(tip.x - 10, tip.z - 10) < 0.6 && tip.y > 7.5, `on the spike (${tip.x}, ${tip.y}, ${tip.z})`);
    near(tip.x, 9.8, 1e-6);
    if (rayGround(spike, o, d).y === 0) missed++;
  }
  assert.ok(missed > 0, 'the walk in half cells steps over that tip from some of them: that is why the editor has its own');
});
